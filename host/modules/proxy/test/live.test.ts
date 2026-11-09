// Живые эталоны прокси модели: настоящий claude идёт через настоящий прокси (logins и proxy на стенде Host), поддельный API пишет запросы.
// Без SWITCHBOARD_LIVE=1 пропускается. Флот не задет: своя папка, свой адрес на localhost, вход Claude не нужен (у слота-аккаунта — поддельный).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { refuse, stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import logins from "../../logins/module.json" with { type: "json" };
import { make as makeLogins } from "../../logins/contract.ts";
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
  const o = { bash: null as string | null, think: false, status: 0, want: null as string | null, cut: 0 };
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
      // обрыв посреди ответа: первые слова ушли, поток оборван
      const cut = body.stream && o.cut > 0 ? o.cut-- : 0;
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
        if (cut) return void setTimeout(() => r.destroy(), 50);
        ev("content_block_stop", { index: i++ });
        ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      }
      ev("message_stop", {});
      r.end();
    });
  });
  return { reqs, o, server, port: () => (server.address() as { port: number }).port, reset: () => ((reqs.length = 0), (sent = false), Object.assign(o, { bash: null, think: false, status: 0, want: null, cut: 0 })) };
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

/** Подделка route: любой id — слот-аккаунт с поддельным Anthropic. */
const anyRoute = () => module("host-logins", { requests: { route: () => ({ to: `http://127.0.0.1:${api.port()}` }) } });

/**
 * Настоящая сборка модулей: стенд Host с поддельным SDK отдаёт env и settings, с которыми дальше идёт настоящий claude; прокси — настоящий.
 * keys — ключи флота у настоящего logins; route — подделка вместо logins.
 */
async function bench(keys: Record<string, { env: Record<string, string>; settings: Record<string, unknown>; key: string }>, route?: ReturnType<typeof anyRoute>) {
  mkdirSync(join(home, "store"), { recursive: true });
  if (!route) writeFileSync(join(home, "store", "host-logins.json"), JSON.stringify({ machine: { accounts: {}, slots: {} }, sessions: {} }));
  const mods = route ? [route] : [{ manifest: logins as Manifest, module: makeLogins() }, module("probe", {}, { uses: { "session.slot@host-logins": 2 } })];
  st = await standHost({ home, start: false, modules: [...mods, { manifest: manifest as Manifest, module: make() }] });
  const s = st;
  const recv = s.relay.receive.bind(s.relay);
  s.relay.receive = (ws, text) => {
    recv(ws, text);
    if (text === "ping") return;
    const f = JSON.parse(text) as Frame;
    if (f.type === "prefs.get") return queueMicrotask(() => s.relay.deliver({ type: "reply", id: f.id as string, from: "prefs", ok: true, result: { values: {} } } as Frame));
    if (f.type !== "fleetkeys.key") return;
    const k = keys[String(f.name)];
    queueMicrotask(() => s.relay.deliver({ type: "reply", id: f.id as string, from: "fleetkeys", ...(k ? { ok: true, result: k } : { ok: false, error: "no_key" }) } as Frame));
  };
  await s.start();
  return s;
}

const proc = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k) || k === "CLAUDE_CODE_GIT_BASH_PATH"));

/** То, с чем сессия пошла бы в настоящий claude: id сессии тот же — по нему прокси находит маршрут. */
async function built(cs: string, slot?: string) {
  await st!.kernel.open({ callsign: `${cs}@laptop`, cwd: join(home, "work", cs), mkdir: true, opening: slot ? { slot } : {} });
  const o = st!.query(`${cs}@laptop`).options as { env: Record<string, string>; settings: Record<string, unknown>; sessionId: string };
  const env: Record<string, string> = { ...proc(), ...o.env, CLAUDE_CONFIG_DIR: join(home, "config") };
  return { env, settings: o.settings, cwd: join(home, "work", cs), sessionId: o.sessionId };
}

/** Разговоры, которые уже есть: их продолжают по resume, новый начинается с sessionId сессии. */
const started = new Set<string>();

/** Один ход настоящего claude; id сессии и исход. */
async function run(b: Awaited<ReturnType<typeof built>>, extra: Record<string, unknown> = {}, prompt = "привет") {
  mkdirSync(b.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const { sessionId, ...rest } = b;
  const id = started.has(sessionId) ? { resume: sessionId } : { sessionId };
  started.add(sessionId);
  b = { ...rest, ...id } as never;
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

describe.skipIf(!LIVE)("живые эталоны прокси модели: настоящий claude, настоящий прокси и поддельный API", () => {
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

  it("8010 · без модели и с каждым alias: модель за alias, окно без беты 1M, ключ из памяти logins через прокси; в Bash ключа нет", async () => {
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

  it("8012 · смена слота с одного провайдера на другого: продолжение разговора тем же id, чужих подписей 0", async () => {
    await bench({
      one: { env: { ...ENV(), ANTHROPIC_DEFAULT_OPUS_MODEL: "first" }, settings: {}, key: "sk-one" },
      two: { env: { ...ENV(), ANTHROPIC_DEFAULT_OPUS_MODEL: "second" }, settings: {}, key: "sk-two" },
    });
    api.o.think = true;
    const one = await built("job", "one");
    await run(one, { model: "opus" });
    expect(JSON.stringify(reqsOf().at(-1)!.body.messages)).toContain("привет");
    expect(await st!.relay.request({ v: 2, type: "session.slot", callsign: "job@laptop", slot: "two" } as Frame)).toMatchObject({ ok: true });
    await stand.until(() => st!.holders.spawns.filter((x) => x.id === "job@laptop").length === 2 && st!.holders.procs.get("job@laptop")?.initializes === 1);
    const o = st!.query("job@laptop").options as { env: Record<string, string>; settings: Record<string, unknown> };
    await run({ ...one, env: { ...one.env, ...o.env, CLAUDE_CONFIG_DIR: one.env.CLAUDE_CONFIG_DIR }, settings: o.settings }, { model: "opus" }, "дальше");
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

  it("8036 · новое значение ключа доходит до идущего claude следующим запросом без перезапуска: fleetkeys.changed → память logins", async () => {
    const keys = { orca: { env: ENV(), settings: {}, key: "sk-old" } };
    await bench(keys);
    const b = await built("job", "orca");
    api.o.want = "sk-old";
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
        keys.orca = { ...keys.orca, key: "sk-new" };
        api.o.want = "sk-new";
        const asked = st!.relay.frames("fleetkeys.key").length;
        st!.relay.deliver({ type: "fleetkeys.changed", v: 1, to: "@laptop", from: ".fleetkeys", name: "orca" } as Frame);
        await stand.until(() => st!.relay.frames("fleetkeys.key").length > asked);
        await new Promise((r) => setTimeout(r, 50));
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

  it("22 · слот-аккаунт через прокси: Authorization входа claude дошёл без изменений, ключа в запросе нет", async () => {
    await bench({}, anyRoute());
    const b = await built("site");
    // вход claude — поддельный токен OAuth: файлом входа claude сверяет профиль у настоящего Anthropic, токеном окружения — нет; заголовок тот же Bearer
    const { result } = await run({ ...b, env: { ...b.env, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-stand" } });
    expect(result.is_error).toBeFalsy();
    expect(main().headers.authorization).toBe("Bearer sk-ant-oat01-stand");
    expect(main().headers["x-api-key"]).toBeUndefined();
    expect(main().headers["x-claude-code-session-id"]).toBe(b.sessionId);
  }, 120_000);

  it("9 · прокси недоступен 6 с посреди хода (перезапуск Host): claude повторяет запрос, ход дошёл", async () => {
    await bench({}, anyRoute());
    const b = await built("site");
    await st!.close();
    st = null;
    const t0 = Date.now();
    const back = new Promise<void>((r) => setTimeout(r, 6_000)).then(() => bench({}, anyRoute()));
    const { result } = await run({ ...b, env: { ...b.env, ANTHROPIC_API_KEY: "stand" } });
    await back;
    expect(result.is_error).toBeFalsy();
    expect(Date.now() - t0).toBeGreaterThan(6_000);
    expect(reqsOf().length).toBeGreaterThan(0);
  }, 120_000);

  it("16 · провайдер оборвал поток посреди ответа: claude сам повторил тот же запрос и закончил ход", async () => {
    await bench({}, anyRoute());
    const b = await built("site");
    api.o.cut = 1;
    const { result, texts } = await run({ ...b, env: { ...b.env, ANTHROPIC_API_KEY: "stand" } });
    expect(result.is_error).toBeFalsy();
    expect(texts.join("")).toContain("готово");
    const main2 = reqsOf().filter((r) => JSON.stringify(r.body.messages).includes("привет"));
    expect(main2.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(main2[0].body.messages)).toBe(JSON.stringify(main2[1].body.messages));
  }, 120_000);
});
