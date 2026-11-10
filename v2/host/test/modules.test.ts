import { gunzipSync, gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { make as accounts } from "../src/modules/accounts/accounts.ts";
import { folders } from "../src/modules/accounts/links.ts";
import { make as chat } from "../src/modules/chat/chat.ts";
import { make as incidents } from "../src/modules/incidents/incidents.ts";
import { make as machine } from "../src/modules/machine/machine.ts";
import { make as points, projectDir, toBlocks } from "../src/modules/points/points.ts";
import { make as profiles } from "../src/modules/profiles/profiles.ts";
import { make as proxy } from "../src/modules/proxy/proxy.ts";
import { make as remote } from "../src/modules/remote/remote.ts";
import { make as shell } from "../src/modules/shell/shell.ts";
import { modules } from "../src/modules/index.ts";
import { stand, tick, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await st?.stop();
  st = undefined;
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

type Seen = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Buffer };
/** Локальный сервер: хранилище блоков или провайдер модели. */
async function server(answer: (r: Seen) => { status?: number; body?: Buffer | string } = () => ({})): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const r = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(r);
      const a = answer(r);
      res.writeHead(a.status ?? 200, { "content-type": "application/json" }).end(a.body ?? "{}");
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen };
}

/** Папка данных с вошедшими аккаунтами и очередью auto. */
function homeWithAccounts(names: string[], limits: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
  mkdirSync(join(home, "store"), { recursive: true });
  const book = { accounts: Object.fromEntries(names.map((n) => [n, { login: "ok", plan: "max", limits: limits[n] ?? {} }])), order: names };
  writeFileSync(join(home, "store", "host-accounts.json"), JSON.stringify({ machine: book }));
  const dirs = folders(home);
  for (const n of names) mkdirSync(dirs.accDir(n), { recursive: true });
  return home;
}

describe("набор модулей", () => {
  it("настоящий набор Host проходит гейт: у имён по одному хозяину, запросы есть в договоре", async () => {
    st = await stand({ modules: modules(), start: false });
    expect(st.kernel.check()).toEqual([]);
  });
});

describe("machine", () => {
  it("журнал машины: новые первыми, фильтр по сквозному номеру запроса и уровню", async () => {
    st = await stand({ modules: [machine()] });
    const bad = await st.request("session.stop", { to: "ghost@laptop" });
    await st.request("machine.dirs", { to: "@laptop", path: st.dir });
    const one = await st.request("machine.journal", { to: "@laptop", of: bad.trace });
    const lines = (one.result as any).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: "request", type: "session.stop", word: "not_found", trace: bad.trace });
    const warn = await st.request("machine.journal", { to: "@laptop", level: "warn", part: "host" });
    expect((warn.result as any).lines.every((l: any) => l.level !== "info")).toBe(true);
  });

  it("папки машины: список, недавние — папки сессий; пути нет — not_found", async () => {
    st = await stand({ modules: [machine()] });
    mkdirSync(join(st.dir, "alpha"));
    mkdirSync(join(st.dir, ".hidden"));
    await st.open("site");
    const r = await st.request("machine.dirs", { to: "@laptop", path: st.dir });
    expect(r.result).toMatchObject({ dirs: ["alpha"], recent: [expect.any(String)], git: false });
    expect(await st.request("machine.dirs", { to: "@laptop", path: join(st.dir, "nope") })).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("shell", () => {
  it("скрипт node: дождались конца — done с выводом; ненулевой код — failed", async () => {
    st = await stand({ modules: [shell({ root: join(mkdtempSync(join(tmpdir(), "sb2-shell-"))) })] });
    const ok = await st.request("shell.run", { to: "@laptop", shell: "node", script: 'console.log("привет из " + process.cwd().length)', cwd: st.dir, wait: 20 });
    expect(ok.result).toMatchObject({ state: "done", code: 0, out: expect.stringContaining("привет из") });
    const bad = await st.request("shell.run", { to: "@laptop", shell: "node", script: "process.exit(3)", wait: 20 });
    expect(bad.result).toMatchObject({ state: "failed", code: 3 });
    expect(await st.request("shell.wait", { to: "@laptop", run: "нет" })).toMatchObject({ ok: false, error: "no_run" });
  });

  it("без ожидания возвращается номер запуска; shell.kill снимает его", async () => {
    st = await stand({ modules: [shell({ root: join(mkdtempSync(join(tmpdir(), "sb2-shell-"))) })] });
    const started = await st.request("shell.run", { to: "@laptop", shell: "node", script: "setTimeout(() => {}, 60000)" });
    expect(started.result).toMatchObject({ state: "running" });
    const killed = await st.request("shell.kill", { to: "@laptop", run: (started.result as any).run });
    expect(killed.result).toMatchObject({ state: "killed" });
  }, 40_000);
});

describe("incidents", () => {
  it("обращение открывает сессию своего вида; тот же ключ идёт в ту же сессию; чужой вид — отказ", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    st = await stand({ home, modules: [chat(), incidents()], config: { "host-incidents": { kinds: { disk: { cwd: work } } } } });
    const first = await st.request("incident.raise", { to: "@laptop", kind: "disk", key: "c:", text: "место кончается" }, "@laptop");
    expect(first).toMatchObject({ ok: true, result: { callsign: "disk-1@laptop" } });
    const proc = await until(() => st!.proc("disk-1@laptop"), 5000, "процесс инцидента");
    await until(() => proc.inputs.length === 1, 5000, "обращение во вводе");
    expect(proc.inputs[0]!.message.content).toContain('<incident kind="disk" key="c:"');
    expect((st.sdk.last("disk-1@laptop")!.options as any).systemPrompt.append).toContain("инцидент disk");
    const second = await st.request("incident.raise", { to: "@laptop", kind: "disk", key: "c:", text: "стало хуже" }, "@laptop");
    expect(second).toMatchObject({ ok: true, result: { callsign: "disk-1@laptop" } });
    expect(await st.request("incident.raise", { to: "@laptop", kind: "nope", key: "", text: "x" }, "@laptop")).toMatchObject({ ok: false, error: "unknown_kind" });
    const list = await st.request("incident.list", { to: "@laptop" });
    expect((list.result as any).incidents).toHaveLength(2);
    // ход взял обращение и кончился — оно закрыто
    proc.send({ type: "system", subtype: "status", user_message_uuids: [(first.result as any).id] });
    proc.send({ type: "result", subtype: "success", result: "ok" });
    await until(() => ((st!.kernel.disk.section<any[]>("host-incidents").get() ?? []).find((a) => a.id === (first.result as any).id)?.state === "done"), 5000, "обращение закрыто");
  });
});

describe("accounts", () => {
  it("очередь auto: вход берётся по ссылке очереди; неизвестный аккаунт отказан хозяином ключа", async () => {
    const home = homeWithAccounts(["a@example.com", "b@example.com"]);
    await folders(home).place("auto", "a@example.com");
    st = await stand({ home, modules: [accounts()] });
    const { q } = await st.open("site");
    expect((q.options as any).env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(folders(home).slotDir("auto"));
    expect(st.link.rows("site@laptop").at(-1)!.row).toMatchObject({ account: "a@example.com" });
    const fixed = await st.open("fixed", { account: "b@example.com" });
    expect((fixed.q.options as any).env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(folders(home).accDir("b@example.com"));
    st.services.handlers["keys.value"] = () => {
      throw { word: "not_found", message: "нет" };
    };
    expect(await st.request("session.open", { to: "@laptop", spec: { name: "x", cwd: st.dir, account: "c@example.com" } })).toMatchObject({ ok: false, error: "no_account" });
    expect(await st.request("session.open", { to: "@laptop", spec: { name: "y", cwd: st.dir, account: "ghostkey" } })).toMatchObject({ ok: false, error: "no_account" });
  });

  it("машина без входа: сессия на очереди не открывается — not_logged_in", async () => {
    st = await stand({ modules: [accounts()] });
    expect(await st.request("session.open", { to: "@laptop", spec: { name: "x", cwd: st.dir } })).toMatchObject({ ok: false, error: "open_failed", why: expect.stringContaining("not_logged_in") });
    expect(await st.request("session.open", { to: "@laptop", spec: { name: "y", cwd: st.dir, account: "auto" } })).toMatchObject({ ok: false, error: "not_logged_in" });
  });

  it("отказ лимита у аккаунта очереди: очередь переходит на следующего, оборванная сессия продолжает", async () => {
    const fresh = { five_hour: { utilization: 0.1, resetsAt: 0, at: Math.floor(Date.now() / 1000) } };
    const home = homeWithAccounts(["a@example.com", "b@example.com"], { "b@example.com": fresh });
    await folders(home).place("auto", "a@example.com");
    st = await stand({ home, modules: [accounts()] });
    const { proc } = await st.open("site");
    proc.send({ type: "system", subtype: "session_state_changed", state: "running" });
    proc.send({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    proc.send({ type: "system", subtype: "session_state_changed", state: "idle" });
    await until(() => folders(home).inSlot("auto") === "b@example.com", 5000, "подмена");
    await until(() => proc.inputs.some((i) => i.message.content === "Продолжай"), 5000, "продолжение");
    expect(st.link.rows("site@laptop").at(-1)!.row).toMatchObject({ account: "b@example.com" });
    expect(st.services.of("ledger.add").some((f) => f.what === "account.swapped")).toBe(true);
  });

  it("ключ флота: значение только в памяти, сессии — слово fleet; кадр «изменилось» — значение забыто и берётся заново", async () => {
    st = await stand({ modules: [accounts()] });
    let value = "sk-one";
    st.services.handlers["keys.value"] = () => ({ value, provider: "anthropic", base: "https://api.example.com" });
    const { s, q } = await st.open("site", { account: "team-key" });
    const env = (q.options as any).env;
    expect(env.ANTHROPIC_API_KEY).toBe("fleet");
    expect(JSON.stringify(env)).not.toContain("sk-one");
    expect(readFileSync(join(st.home, "store", "host-accounts.json"), "utf8")).not.toContain("sk-one");
    const api = (st.kernel.mods.find((m) => m.name === "host-accounts")!.api as any);
    expect(await api.route(s.rec.sessionId)).toEqual({ to: "https://api.example.com", key: "sk-one", provider: "anthropic" });
    value = "sk-two";
    st.link.deliver({ type: "changed", what: "keys" });
    expect((await api.route(s.rec.sessionId)).key).toBe("sk-two");
    await expect(api.route("нет")).rejects.toMatchObject({ word: "unknown_session" });
  });

  it("список аккаунтов: входы с лимитами и местом в очереди, ключи флота из службы", async () => {
    const at = Math.floor(Date.now() / 1000);
    const home = homeWithAccounts(["a@example.com"], { "a@example.com": { five_hour: { utilization: 0.5, resetsAt: at + 600, at } } });
    await folders(home).place("auto", "a@example.com");
    st = await stand({ home, modules: [accounts()] });
    st.services.handlers["keys.list"] = () => ({ keys: [{ name: "team-key", provider: "anthropic", at: 1, tail: "…abcd" }] });
    const r = await st.request("account.list", { to: "@laptop" });
    expect((r.result as any).accounts).toEqual([
      { id: "a@example.com", kind: "claude", email: "a@example.com", plan: "max", limits: [{ name: "five_hour", used: 0.5, resets: (at + 600) * 1000 }], slot: 0, ok: true, sessions: 0, current: true },
      { id: "team-key", kind: "key", ok: true, sessions: 0, provider: "anthropic" },
    ]);
  });
});

describe("proxy", () => {
  it("правила не прочитаны — запрос к провайдеру не уходит; прочитаны — тело после правил, ключ флота вместо слова fleet", async () => {
    const provider = await server(() => ({ body: JSON.stringify({ id: "msg_1", type: "message" }) }));
    st = await stand({ modules: [accounts(), proxy()] });
    st.services.handlers["keys.value"] = () => ({ value: "sk-real", provider: "anthropic", base: provider.url });
    let rulesOk = false;
    st.services.handlers["prefs.get"] = () => {
      if (!rulesOk) throw { word: "offline", message: "службы молчат" };
      return { values: { "proxy.rules": [{ name: "тайна", scopes: ["user"], kind: "literal", unit: "match", action: "replace", pattern: "internal.example", replacement: "example" }] } };
    };
    const { s, q } = await st.open("site", { account: "team-key" });
    const base = (q.options as any).env.ANTHROPIC_BASE_URL as string;
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const call = (sid: string) =>
      fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "fleet", "x-claude-code-session-id": sid }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "зайди на internal.example" }] }) });
    const blocked = await call(s.rec.sessionId);
    expect(blocked.status).toBe(529);
    expect(await blocked.text()).toContain("rules_unavailable");
    expect(provider.seen).toHaveLength(0);
    const stranger = await call("stranger");
    expect(stranger.status).toBe(403);
    expect(await stranger.text()).toContain("unknown_session");
    rulesOk = true;
    const passed = await call(s.rec.sessionId);
    expect(passed.status).toBe(200);
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]!.headers["x-api-key"]).toBe("sk-real");
    expect(JSON.parse(provider.seen[0]!.body.toString("utf8")).messages[0].content).toBe("зайди на example");
  });
});

describe("points", () => {
  it("разговор режется на блоки по переводу строки; недописанный хвост в точку не идёт", () => {
    const blocks = new Map<string, Buffer>();
    const line = (n: number) => JSON.stringify({ n, pad: "x".repeat(700_000) }) + "\n";
    const buf = Buffer.from(line(1) + line(2) + line(3) + '{"недопис');
    const f = toBlocks("s.jsonl", buf, blocks);
    expect(f.size).toBe(Buffer.byteLength(line(1) + line(2) + line(3)));
    expect(f.blocks).toHaveLength(3);
    for (const b of blocks.values()) expect(b.toString("utf8").endsWith("\n")).toBe(true);
  });

  it("точка: блоки названы, недостающие загружены по ссылкам, вторым шагом точка записана; подъём кладёт файлы и открывает сессию", async () => {
    const store = await server();
    st = await stand({ modules: [points()] });
    const { s } = await st.open("site", { backup: true });
    const dir = projectDir(s.rec.cwd);
    mkdirSync(dir, { recursive: true });
    const text = JSON.stringify({ type: "user", uuid: "u1", message: { content: "привет" } }) + "\n";
    writeFileSync(join(dir, `${s.rec.sessionId}.jsonl`), text);
    const puts: any[] = [];
    st.services.handlers["points.put"] = (f) => {
      puts.push(f);
      return f.commit ? { upload: {}, done: true } : { upload: Object.fromEntries((f.files as any[]).flatMap((x) => x.blocks).map((h: string) => [h, `${store.url}/b/${h}`])), done: false };
    };
    const r = await st.request("points.save", { to: "site@laptop", label: "перед выкладкой" });
    expect(r).toMatchObject({ ok: true, result: { point: expect.stringMatching(/^p/) } });
    expect(puts).toHaveLength(2);
    expect(puts[0]).toMatchObject({ sid: s.rec.sessionId, callsign: "site@laptop", label: "перед выкладкой", files: [{ path: `${s.rec.sessionId}.jsonl`, size: Buffer.byteLength(text) }] });
    expect(puts[1].commit).toBe(true);
    expect(store.seen).toHaveLength(1);
    expect(store.seen[0]).toMatchObject({ method: "PUT", url: `/b/${puts[0].files[0].blocks[0]}` });
    // блок уходит в хранилище сжатым и распаковывается в то же содержимое
    expect(store.seen[0]!.body.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(gunzipSync(store.seen[0]!.body).toString("utf8")).toBe(text);

    // подъём копией: файлы точки — по ссылкам, сессия открыта от разговора точки
    const hash = puts[0].files[0].blocks[0] as string;
    const blocksServer = await server(() => ({ body: gzipSync(Buffer.from(text)) }));
    st.services.handlers["points.get"] = () => ({
      session: { sid: "sid-old", machine: "server", callsign: "docs@server", cwd: st!.dir, points: 1, last: 1 },
      point: { point: "p1", at: 1 },
      files: [{ path: "sid-old.jsonl", size: text.length, blocks: [{ hash, url: `${blocksServer.url}/b/${hash}` }] }],
    });
    const raised = await st.request("points.raise", { to: "@laptop", sid: "sid-old", name: "docs-copy" });
    expect(raised).toMatchObject({ ok: true, result: { callsign: "docs-copy@laptop" } });
    expect(readFileSync(join(projectDir(st.dir), "sid-old.jsonl"), "utf8")).toBe(text);
    expect(st.sdk.last("docs-copy@laptop")!.options).toMatchObject({ resume: "sid-old", forkSession: true });
    expect(st.kernel.sessions.get("docs-copy@laptop")!.rec.spec.backup).toBe(true);
  });

  it("блок пришёл не тот — bad_point, файлы на диске не тронуты", async () => {
    const wrong = await server(() => ({ body: "не то" }));
    st = await stand({ modules: [points()] });
    st.services.handlers["points.get"] = () => ({
      session: { sid: "sid-x", machine: "server", callsign: "docs@server", cwd: st!.dir, points: 1, last: 1 },
      point: { point: "p1", at: 1 },
      files: [{ path: "sid-x.jsonl", size: 5, blocks: [{ hash: "0".repeat(64), url: `${wrong.url}/b` }] }],
    });
    expect(await st.request("points.raise", { to: "@laptop", sid: "sid-x" })).toMatchObject({ ok: false, error: "bad_point" });
    expect(st.kernel.sessions.size).toBe(0);
  });
});

describe("profiles", () => {
  it("кусочек из клона идёт плагином; набора нет на машине — отказ хозяина ключа pieces", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
    const piece = join(home, "profiles", "team__kit", "base");
    mkdirSync(join(piece, "skills", "deploy"), { recursive: true });
    writeFileSync(join(piece, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: выкладка\n---\nтекст");
    writeFileSync(join(piece, "settings.json"), JSON.stringify({ env: { TEAM: "kit" }, outputStyle: "kit:short" }));
    st = await stand({ home, modules: [profiles({ git: async () => ({ code: 0, out: "" }) })] });
    st.services.handlers["prefs.get"] = () => ({ values: { "profiles.repos": ["team/kit"] } });
    const { q } = await st.open("site", { pieces: ["team/kit/base"] });
    const opts = q.options as any;
    expect(opts.plugins).toEqual([{ type: "local", path: piece }]);
    expect(opts.env.TEAM).toBe("kit");
    expect(opts.settings).toMatchObject({ outputStyle: "kit:short" });
    expect(await st.request("session.update", { to: "site@laptop", patch: { pieces: ["team/kit/nope"] } })).toMatchObject({ ok: false, error: "no_profile" });
    const view = await st.request("profile.view", { to: "@laptop", pieces: ["team/kit/base"] });
    expect((view.result as any).items).toContainEqual(expect.objectContaining({ kind: "skill", name: "base:deploy", piece: "team/kit/base" }));
    const file = await st.request("profile.file", { to: "@laptop", piece: "team/kit/base", path: "skills/deploy/SKILL.md" });
    expect((file.result as any).text).toContain("выкладка");
    expect(await st.request("profile.file", { to: "@laptop", piece: "team/kit/base", path: "../../../store/core.json" })).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("remote", () => {
  it("ключ remote включает Remote Control у готовой сессии", async () => {
    st = await stand({ modules: [remote()] });
    await st.open("site", { remote: true });
    await tick(10);
    expect(st.sdk.last("site@laptop")!.calls.some((c) => c.name === "enableRemoteControl" && c.args[0] === true)).toBe(true);
  });
});
