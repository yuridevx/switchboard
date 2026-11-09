// Живые эталоны ключа флота: настоящий claude читает то, что собрал модуль, поддельный совместимый API пишет запросы. Без SWITCHBOARD_LIVE=1 пропускается.
// Флот не задет: своя папка, свой адрес на localhost, вход Claude не нужен.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../contract.ts";

const LIVE = process.env.SWITCHBOARD_LIVE === "1";
const { module, standHost } = stand;
type Req = { path: string; headers: Record<string, string | string[] | undefined>; body: any };

const require = createRequire(import.meta.url);
/** Файл claude из пакета SDK этой платформы. */
function claudeBin(): string {
  const sdk = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
  const name = `claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const p of [join(sdk, "..", name, process.platform === "win32" ? "claude.exe" : "claude"), join(sdk, "cli.js")]) if (existsSync(p)) return p;
  throw new Error("claude не найден в пакете SDK");
}

/** Поддельный API: пишет запросы; отвечает текстом, один раз зовёт Bash, отдаёт thinking с подписью, 401 и 429 по требованию. */
function fakeApi() {
  const reqs: Req[] = [];
  const o = { bash: null as string | null, think: false, status: 0, want: null as string | null };
  let sent = false;
  const server: Server = createServer((q, r) => {
    let b = "";
    q.on("data", (d) => (b += d));
    q.on("end", () => {
      const path = q.url ?? "";
      const body = b ? JSON.parse(b) : {};
      const json = (code: number, v: unknown) => (r.writeHead(code, { "content-type": "application/json" }), r.end(JSON.stringify(v)));
      if (!path.includes("/messages")) return json(path.includes("/models") ? 200 : 404, { data: [], has_more: false });
      if (path.includes("count_tokens")) return json(200, { input_tokens: 10 });
      reqs.push({ path, headers: q.headers, body });
      const token = String(q.headers["x-api-key"] ?? q.headers.authorization ?? "").replace(/^Bearer /, "");
      if (o.want && token !== o.want) return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      if (o.status) return json(o.status, { type: "error", error: { type: "rate_limit_error", message: "слишком много запросов" } });
      const id = `msg_${reqs.length}`;
      const content: unknown[] = [];
      if (!body.stream) return json(200, { id, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      r.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (t: string, d: object) => r.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
      ev("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content, stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      let i = 0;
      if (o.think) {
        ev("content_block_start", { index: i, content_block: { type: "thinking", thinking: "", signature: "" } });
        ev("content_block_delta", { index: i, delta: { type: "thinking_delta", thinking: "думаю" } });
        ev("content_block_delta", { index: i, delta: { type: "signature_delta", signature: `sig-${body.model}` } });
        ev("content_block_stop", { index: i++ });
      }
      const tools = (body.tools ?? []) as unknown[];
      if (o.bash && !sent && tools.length > 3) {
        sent = true;
        ev("content_block_start", { index: i, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } });
        ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: o.bash, description: "окружение" }) } });
        ev("content_block_stop", { index: i++ });
        ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } });
      } else {
        ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: i, delta: { type: "text_delta", text: "готово" } });
        ev("content_block_stop", { index: i++ });
        ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      }
      ev("message_stop", {});
      r.end();
    });
  });
  return { reqs, o, server, port: () => (server.address() as { port: number }).port, reset: () => ((reqs.length = 0), (sent = false), Object.assign(o, { bash: null, think: false, status: 0, want: null })) };
}

const api = fakeApi();
const main = () => reqsOf().at(-1)!;
const reqsOf = () => api.reqs.filter((r) => r.body.stream);
let st: stand.Stand | null = null;
let home = "";
const saved = { ...process.env };

const ENV = () => ({
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port()}`,
  ANTHROPIC_DEFAULT_OPUS_MODEL: "prov-opus",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "prov-sonnet",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "prov-haiku",
  ANTHROPIC_DEFAULT_FABLE_MODEL: "prov-fable",
  CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
});

/** Настоящая сборка модуля: стенд Host с поддельным SDK отдаёт env и settings, с которыми дальше идёт настоящий claude. */
async function bench(keys: Record<string, { env: Record<string, string>; settings: Record<string, unknown>; key: string }>) {
  mkdirSync(join(home, "store"), { recursive: true });
  writeFileSync(join(home, "store", "host-logins.json"), JSON.stringify({ machine: { accounts: {}, slots: {} }, sessions: {} }));
  st = await standHost({ home, start: false, modules: [{ manifest: manifest as Manifest, module: make() }, module("probe", {}, { uses: { "session.slot@host-logins": 2 } })] });
  const s = st;
  const recv = s.relay.receive.bind(s.relay);
  s.relay.receive = (ws, text) => {
    recv(ws, text);
    if (text === "ping") return;
    const f = JSON.parse(text) as Frame;
    if (f.type !== "fleetkeys.key") return;
    const k = keys[String(f.name)];
    queueMicrotask(() => s.relay.deliver({ type: "reply", id: f.id as string, from: "fleetkeys", ...(k ? { ok: true, result: k } : { ok: false, error: "no_key" }) } as Frame));
  };
  await s.start();
  return s;
}

const proc = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k) || k === "CLAUDE_CODE_GIT_BASH_PATH"));

/** То, с чем сессия пошла бы в настоящий claude. */
async function built(cs: string, slot: string) {
  await st!.kernel.open({ callsign: `${cs}@laptop`, cwd: join(home, "work", cs), mkdir: true, opening: { slot } });
  const o = st!.query(`${cs}@laptop`).options as { env: Record<string, string>; settings: Record<string, unknown> };
  return { env: { ...proc(), ...o.env, CLAUDE_CONFIG_DIR: join(home, "config") }, settings: o.settings, cwd: join(home, "work", cs) };
}

/** Один ход настоящего claude; id сессии и исход. */
async function run(b: Awaited<ReturnType<typeof built>>, extra: Record<string, unknown> = {}, prompt = "привет") {
  mkdirSync(b.env.CLAUDE_CONFIG_DIR, { recursive: true });
  let session = "";
  let result: { is_error?: boolean; result?: string; subtype?: string } = {};
  const texts: string[] = [];
  for await (const m of query({ prompt, options: { ...b, pathToClaudeCodeExecutable: claudeBin(), permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, ...extra } as never })) {
    const x = m as { type: string; session_id?: string; message?: { content?: Array<{ text?: string }> } };
    if (x.session_id) session = x.session_id;
    if (m.type === "result") result = m as never;
    if (m.type === "assistant") texts.push(...(x.message?.content ?? []).map((c) => c.text ?? ""));
  }
  return { session, result, texts };
}

/** Настоящая команда claude: вывод вместе, как у ядра. */
const cliOf = (args: string[], env: Record<string, string | undefined>) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(claudeBin(), args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });

const betas = (r: Req) => String(r.headers["anthropic-beta"] ?? "");
const tokenOf = (r: Req) => String(r.headers["x-api-key"] ?? r.headers.authorization ?? "").replace(/^Bearer /, "");

describe.skipIf(!LIVE)("живые эталоны ключа флота: настоящий claude и поддельный API", () => {
  beforeAll(() => new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r)));
  afterAll(() => new Promise((r) => api.server.close(r)));
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-keylive-"));
    process.env.SWITCHBOARD_HOME = home;
    api.reset();
  });
  afterEach(async () => {
    await st?.close();
    st = null;
    process.env = { ...saved };
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  });

  it("8010 · без модели и с каждым alias: модель за alias, окно без беты 1M, значение из файла; в Bash ключа нет", async () => {
    await bench({ orca: { env: ENV(), settings: {}, key: "sk-live-SECRET" } });
    const b = await built("job", "orca");
    api.o.bash = "env";
    const models: Record<string, string> = {};
    for (const alias of [undefined, "opus", "sonnet", "haiku", "fable"]) {
      await run(b, alias ? { model: alias } : {});
      models[alias ?? "без модели"] = main().body.model;
      expect(tokenOf(main())).toBe("sk-live-SECRET");
      expect(betas(main())).not.toContain("context-1m");
    }
    expect(models).toEqual({ "без модели": expect.stringMatching(/^prov-/), opus: "prov-opus", sonnet: "prov-sonnet", haiku: "prov-haiku", fable: "prov-fable" });
    const told = reqsOf().map((r) => JSON.stringify(r.body.messages)).find((s) => s.includes("tool_result"));
    expect(told).toBeTruthy();
    expect(told).not.toContain("sk-live-SECRET");
  }, 240_000);

  it("8012 · смена слота с одного провайдера на другого: продолжение разговора, чужих подписей 0", async () => {
    await bench({
      one: { env: { ...ENV(), ANTHROPIC_DEFAULT_OPUS_MODEL: "first" }, settings: {}, key: "sk-one" },
      two: { env: { ...ENV(), ANTHROPIC_DEFAULT_OPUS_MODEL: "second" }, settings: {}, key: "sk-two" },
    });
    api.o.think = true;
    const one = await built("job", "one");
    const a = await run(one, { model: "opus" });
    expect(JSON.stringify(reqsOf().at(-1)!.body.messages)).toContain("привет");
    const two = await built("job2", "two");
    await run({ ...two, env: { ...two.env, CLAUDE_CONFIG_DIR: one.env.CLAUDE_CONFIG_DIR }, cwd: one.cwd }, { model: "opus", resume: a.session }, "дальше");
    const req = main();
    expect(req.body.model).toBe("second");
    expect(tokenOf(req)).toBe("sk-two");
    const sent = JSON.stringify(req.body.messages);
    expect(sent).toContain("привет");
    expect(sent).toContain("дальше");
    expect(sent).not.toContain("sig-first");
  }, 180_000);

  it("8027 · API отвечает 429: ошибка в ленте словами", async () => {
    await bench({ orca: { env: ENV(), settings: {}, key: "sk-live" } });
    const b = await built("job", "orca");
    api.o.status = 429;
    // SDK бросает то, что claude написал в ленте результата
    const word = await run({ ...b, env: { ...b.env, CLAUDE_CODE_MAX_RETRIES: "0" } as typeof b.env }).then(() => "", (e: Error) => e.message);
    expect(word).toMatch(/429/);
    expect(word).toContain("слишком много запросов");
  }, 120_000);

  it("8036 · новое значение файла доходит до идущего claude следующим запросом без перезапуска", async () => {
    await bench({ orca: { env: ENV(), settings: {}, key: "sk-old" } });
    const b = await built("job", "orca");
    api.o.want = "sk-old";
    const keyFile = join(home, "fleetkeys", "orca", "token");
    let next: () => void = () => {};
    const input = (async function* () {
      yield { type: "user", message: { role: "user", content: "первый" }, parent_tool_use_id: null } as never;
      await new Promise<void>((r) => (next = r));
      yield { type: "user", message: { role: "user", content: "второй" }, parent_tool_use_id: null } as never;
    })();
    mkdirSync(b.env.CLAUDE_CONFIG_DIR, { recursive: true });
    let turns = 0;
    const seen: string[] = [];
    const q = query({ prompt: input, options: { ...b, pathToClaudeCodeExecutable: claudeBin(), permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } as never });
    for await (const m of q) {
      if (m.type !== "result") continue;
      seen.push(tokenOf(main()));
      if (++turns === 1) {
        writeFileSync(keyFile, "sk-new");
        api.o.want = "sk-new";
        next();
      } else break;
    }
    q.close();
    expect(seen).toEqual(["sk-old", "sk-new"]);
  }, 180_000);

  it("8032 · настоящий разовый запуск: рабочий ключ — модель и время; неверный — слово ответа", async () => {
    await bench({ orca: { env: ENV(), settings: {}, key: "sk-good" } });
    st!.sdk.cli = cliOf as never;
    api.o.want = "sk-good";
    const ask = async () => (await st!.relay.request({ v: 1, machine: "laptop", type: "machine.key_check", name: "orca" } as Frame)) as Frame & { result: { ok: boolean; word: string } };
    const good = await ask();
    expect(good.result).toMatchObject({ ok: true, word: expect.stringMatching(/^ключ принят, отвечает prov-.+, \d+ мс$/) });
    expect(tokenOf(main())).toBe("sk-good");
    api.o.want = "другое";
    const bad = await ask();
    expect(bad.result.ok).toBe(false);
    expect(bad.result.word).toMatch(/401|invalid|auth/i);
  }, 180_000);
});
