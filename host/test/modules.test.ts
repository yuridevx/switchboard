import { gunzipSync, gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { make as accounts } from "../src/modules/accounts/accounts.ts";
import { make as machine } from "../src/modules/machine/machine.ts";
import { make as points, projectDir, toBlocks } from "../src/modules/points/points.ts";
import { make as profiles } from "../src/modules/profiles/profiles.ts";
import { make as proxy } from "../src/modules/proxy/proxy.ts";
import { make as shell } from "../src/modules/shell/shell.ts";
import { modules } from "../src/modules/index.ts";
import { stand, type Stand } from "../stand/index.ts";

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

describe("proxy", () => {
  it("правила не прочитаны — запрос к провайдеру не уходит; прочитаны — тело после правил, ключ флота вместо слова fleet", async () => {
    const provider = await server(() => ({ body: JSON.stringify({ id: "msg_1", type: "message" }) }));
    st = await stand({ modules: [accounts(), proxy()] });
    st.services.handlers["keys.value"] = () => ({ value: "sk-real", protocol: "anthropic", base: provider.url });
    st.services.handlers["keys.models"] = () => ({ models: [{ id: "m" }] });
    let rulesOk = false;
    st.services.handlers["prefs.get"] = () => {
      if (!rulesOk) throw { word: "offline", message: "службы молчат" };
      return { values: { "proxy.rules": [{ name: "тайна", scopes: ["user"], kind: "literal", unit: "match", action: "replace", pattern: "internal.example", replacement: "example" }] } };
    };
    const { s, q } = await st.open("site", { key: "team-key", model: "m" });
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
      // чьё: факт прода 15 нояб. — у точек прежней системы проект записан именем, а не номером; проект точки мог быть и убран
      session: { sid: "sid-old", machine: "server", callsign: "docs@server", cwd: st!.dir, points: 1, last: 1, project: "p1-phoenix" },
      point: { point: "p1", at: 1 },
      files: [{ path: "sid-old.jsonl", size: text.length, blocks: [{ hash, url: `${blocksServer.url}/b/${hash}` }] }],
    });
    st.services.handlers["people.list"] = () => ({ people: [], projects: [{ id: "pmwhtprlq", name: "p1-phoenix", members: [] }] });
    // чьё: факт переноса 15 нояб. — в документе точки прежней системы нет провайдера и точной модели: их называют при подъёме
    const raised = await st.request("points.raise", { to: "@laptop", sid: "sid-old", name: "docs-copy", model: "glm-5.3" });
    expect(raised).toMatchObject({ ok: true, result: { callsign: "docs-copy@laptop" } });
    expect(st.kernel.sessions.get("docs-copy@laptop")!.rec.spec).toMatchObject({ model: "glm-5.3" });
    // проекта точки во флоте нет: сессия поднята без проекта, потеря названа в журнале
    expect(st.kernel.sessions.get("docs-copy@laptop")!.rec.spec.project).toBeUndefined();
    expect(st.journal().find((l) => l.msg === "raise_project")).toMatchObject({ level: "warn", word: "no_project" });
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
