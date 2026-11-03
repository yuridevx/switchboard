// Эталоны и стыки модуля points на стенде Host: поддельные SDK, relay, keeper и часы;
// Worker points, manage соседней машины и R2 — подделки. Файл разговора — заданные байты. Номер эталона — номер теста.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Session } from "@switchboard/host";
import { BLOCK, projectDir } from "../src/blocks.ts";
import { GAP_MS, lastOf, LONG_MS } from "../src/points.ts";
import { bench, FakeRegistry, tmpHome } from "./bench.ts";
import type { Bench } from "./bench.ts";

const { msg, turn, until } = stand;

let b: Bench | null = null;
let home = "";
const saved = { ...process.env };
beforeEach(() => {
  home = tmpHome();
  process.env.SWITCHBOARD_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
});
afterEach(async () => {
  await b?.st.close();
  b = null;
  vi.useRealTimers();
  process.env = { ...saved };
});

const SID = "42bc5ad4-0000-4000-8000-000000000001";
const line = (i: number, pad = 60) => JSON.stringify({ type: "user", i, t: "x".repeat(pad) }) + "\n";
const conv = (n: number, pad = 60) => Buffer.from(Array.from({ length: n }, (_, i) => line(i, pad)).join(""));
const fileOf = (cwd: string, sid: string) => join(projectDir(cwd), `${sid}.jsonl`);
function write(cwd: string, sid: string, buf: Buffer) {
  mkdirSync(projectDir(cwd), { recursive: true });
  writeFileSync(fileOf(cwd, sid), buf);
}
const ask = async (f: Record<string, unknown>) => (await b!.st.relay.request({ v: 1, ...f } as Frame)) as Frame & { ok: boolean; result: any; error?: string };
/** points.put по поводу; «missing» — тот же put до блоков, его не считаем. */
const puts = (why?: string) => b!.reg.puts.filter((p) => (!why || p.why === why) && p.result !== "missing");
const last = (cs: string) => b!.st.states(cs).at(-1)!;
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();

/** Открыть помеченную сессию с файлом разговора. */
async function marked(cs = "site@laptop", buf = conv(20)): Promise<Session> {
  const s = await b!.st.open(cs, { module: "host-points" });
  write(s.info.cwd, s.info.session_id, buf);
  const r = await ask({ type: "session.r2", callsign: cs, on: true });
  expect(r.ok).toBe(true);
  return s;
}

/** Часы модуля: сдвиг Date и таймеров. */
function at(ms: number, base: number) {
  const target = base + ms;
  vi.advanceTimersByTime(target - Date.now());
}

describe("эталоны points", () => {
  it("5548 · чтение разговора бросило при снятии точки: точка снята без msgs и last, причина в журнале, points не выключен", async () => {
    // чьё: код — points.ts snapOnce: msgs необязательны
    b = await bench({ home });
    await marked();
    b.st.sdk.functions = {
      getSessionInfo: async () => ({}),
      importSessionToStore: async () => {},
      getSessionMessages: async () => {
        throw new Error("файл разговора не читается");
      },
    } as never;
    const r = await ask({ type: "points.save", callsign: "site@laptop" });
    expect(r.ok).toBe(true);
    expect(r.result.point).toBeTypeOf("number");
    const put = puts().at(-1)!;
    expect(put.msgs).toBeUndefined();
    expect(put.last).toBeUndefined();
    expect(b.st.journal()).toContainEqual(expect.objectContaining({ kind: "note", ev: "messages", why: "файл разговора не читается" }));
    expect((await ask({ type: "points.save", callsign: "site@laptop" })).ok).toBe(true);
  });

  it("210 · конец хода — точка не чаще раза в 2 мин: точки в 3:00 и 6:00, в 4:12 нет", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.UTC(2026, 9, 31, 14, 0) });
    const T0 = Date.now();
    b = await bench({ home });
    const s = await marked();
    const p = b.st.proc("site@laptop");
    const step = async (ms: number, st: "running" | "idle") => {
      at(ms, T0);
      appendFileSync(fileOf(s.info.cwd, s.info.session_id), line(ms));
      p.send(msg.state(st));
      await until(() => s.state === (st === "running" ? "busy" : "idle"));
    };
    await step(60_000, "running");
    await step(180_000, "idle");
    await until(() => puts("rule").length === 1);
    await step(210_000, "running");
    await step(252_000, "idle");
    await step(299_999, "running");
    at(300_000, T0);
    await new Promise((r) => setImmediate(r));
    expect(puts("rule")).toHaveLength(1);
    await step(360_000, "idle");
    await until(() => puts("rule").length === 2);
    expect(puts("rule")).toHaveLength(2);
    expect(puts().every((x) => x.callsign === "site@laptop")).toBe(true);
  });

  it("211 · ход 10 мин без точки — точка посреди хода, файл по последнему переводу строки; затем конец хода", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.UTC(2026, 9, 31, 14, 0) });
    const T0 = Date.now();
    b = await bench({ home });
    at(360_000, T0);
    const s = await marked();
    at(480_000, T0);
    b.st.proc("site@laptop").send(msg.state("running"));
    await until(() => s.state === "busy");
    // ход дописывает файл: последняя строка ещё не дописана
    appendFileSync(fileOf(s.info.cwd, s.info.session_id), line(99) + '{"type":"assistant","half');
    const full = readFileSync(fileOf(s.info.cwd, s.info.session_id));
    at(480_000 + LONG_MS, T0);
    await until(() => puts("rule").length === 1);
    expect(Date.now() - T0).toBe(1_080_000); // 18:00
    const f = (puts("rule")[0].files as Array<{ p: string; size: number }>)[0];
    expect(f.size).toBe(full.lastIndexOf(0x0a) + 1);
    appendFileSync(fileOf(s.info.cwd, s.info.session_id), '"}\n');
    at(1_320_000, T0);
    b.st.proc("site@laptop").send(msg.state("idle"));
    await until(() => puts("rule").length === 2);
  });

  it("212 · дописано — в R2 уходит один блок; файл переписан со сдвигом — все блоки", async () => {
    b = await bench({ home });
    const big = conv(Math.ceil((5.3 * BLOCK) / 80), 60).subarray(0, Math.floor(5.3 * BLOCK));
    const head = big.subarray(0, big.lastIndexOf(0x0a) + 1);
    const s = await marked("site@laptop", head);
    expect(b.reg.r2puts).toHaveLength(6);
    const n0 = b.reg.r2puts.length;
    appendFileSync(fileOf(s.info.cwd, s.info.session_id), conv(Math.floor((0.3 * BLOCK) / 80), 60).subarray(0, Math.floor(0.25 * BLOCK)));
    appendFileSync(fileOf(s.info.cwd, s.info.session_id), "\n");
    const r = await ask({ type: "points.save", callsign: "site@laptop" });
    expect(r.ok).toBe(true);
    expect(b.reg.r2puts.length - n0).toBe(1);
    // переписан: 100 байт в начале — сдвинулись все блоки
    const now = readFileSync(fileOf(s.info.cwd, s.info.session_id));
    writeFileSync(fileOf(s.info.cwd, s.info.session_id), Buffer.concat([Buffer.alloc(100, 0x20), now]));
    const n1 = b.reg.r2puts.length;
    await ask({ type: "points.save", callsign: "site@laptop" });
    const blocks = Math.ceil((now.length + 100) / BLOCK);
    expect(b.reg.r2puts.length - n1).toBe(blocks);
  });

  it("213 · подъём на pc: файл байт в байт в папке проекта, старая копия в стороне, open с resume и point, пометка, точка подъёма, remove на laptop", async () => {
    b = await bench({ home, machine: "pc" });
    const content = conv(50);
    const sub = Buffer.from('{"agent":1}\n');
    b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: content, [`${SID}/subagents/agent-a1.jsonl`]: sub });
    const old = join(home, "claude", "projects", "-old-place");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, `${SID}.jsonl`), "старая копия\n");
    const dir = join(home, "Projects", "site");
    const r = await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir, files: "point" });
    expect(r.ok).toBe(true);
    expect(readFileSync(fileOf(dir, SID))).toEqual(content);
    expect(readFileSync(join(projectDir(dir), SID, "subagents", "agent-a1.jsonl"))).toEqual(sub);
    expect(existsSync(join(old, `${SID}.jsonl`))).toBe(false);
    expect(readdirSync(old).some((f) => f.startsWith(`${SID}.jsonl.aside-`))).toBe(true);
    expect(b.manage).toEqual([expect.objectContaining({ type: "session.open", resume: SID, point: 318, dir, name: "site" })]);
    expect(b.st.query("site@pc").options.resume).toBe(SID);
    expect(b.st.session("host-points", "site@pc")!.info.start).toBe("point");
    const raise = puts("raise");
    expect(raise).toHaveLength(1);
    expect(raise[0]).toMatchObject({ sid: SID, base: 318, expect: "laptop", result: "ok" });
    expect(b.reg.r2puts).toEqual([]); // блоки те же — missing пуст
    expect(b.reg.sessions.get(SID)!.owner).toBe("pc");
    expect(b.remote).toEqual([expect.objectContaining({ type: "session.remove", callsign: "site@laptop" })]);
    expect(r.result).toMatchObject({ callsign: "site@pc", point: b.reg.sessions.get(SID)!.head, folder: "nogit" });
    b.st.proc("site@pc").send(msg.state("idle"));
    await until(() => last("site@pc").r2 !== undefined);
    expect(last("site@pc").r2).toEqual({});
  });

  it("214 · manage на pc ответил open_failed — точки подъёма нет, на laptop session.start, ответ open_failed", async () => {
    b = await bench({ home, machine: "pc", failOpen: "open_failed" });
    b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: conv(5) });
    const r = await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir: join(home, "Projects", "site") });
    expect(r).toMatchObject({ ok: false, error: "open_failed" });
    expect(puts("raise")).toHaveLength(0);
    expect(b.reg.sessions.get(SID)!.owner).toBe("laptop");
    expect(b.remote).toEqual([expect.objectContaining({ type: "session.start", callsign: "site@laptop" })]);
  });

  it("215 · копия: open с fork и point; исходный файл в папке копии удалён; точка под новым sid с base 318 — на первом конце хода", async () => {
    b = await bench({ home, machine: "pc" });
    b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: conv(8) });
    const dir = join(home, "Projects", "site-copy");
    const r = await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, copy: true, dir });
    expect(r.ok).toBe(true);
    // файла копии ещё нет — точки подъёма в ответе нет, она снимется на первом конце хода
    expect(r.result.point).toBeNull();
    expect(puts("raise")).toHaveLength(0);
    expect(b.manage[0]).toMatchObject({ type: "session.open", resume: SID, fork: true, point: 318, name: "site-copy" });
    const s = b.st.session("host-points", "site-copy@pc")!;
    expect(s.info.session_id).not.toBe(SID);
    expect(existsSync(fileOf(dir, SID))).toBe(false);
    // первый ход: claude пишет файл нового разговора, ход кончается
    writeFileSync(fileOf(dir, s.info.session_id), conv(9));
    b.st.proc("site-copy@pc").send(msg.state("running"));
    await until(() => s.state === "busy");
    b.st.proc("site-copy@pc").send(msg.state("idle"));
    await until(() => puts("raise").length === 1);
    const raise = puts("raise");
    expect(raise).toHaveLength(1);
    expect(raise[0]).toMatchObject({ sid: s.info.session_id, base: 318 });
    expect(raise[0].expect).toBeUndefined();
    expect(b.reg.sessions.get(SID)).toEqual({ owner: "laptop", head: 318 });
    expect(b.remote).toEqual([]);
  });

  it("216 · откат на той же машине: save со стопом, файл = точка 300, session.start с point, base 300 и expect laptop, папка не тронута", async () => {
    b = await bench({ home });
    const s = await marked("site@laptop", conv(30));
    const sid = s.info.session_id;
    const p300 = conv(12);
    b.reg.seed(300, sid, "laptop", { [`${sid}.jsonl`]: p300 });
    b.reg.sessions.set(sid, { owner: "laptop", head: b.reg.seq });
    const keep = join(s.info.cwd, "file.txt");
    mkdirSync(s.info.cwd, { recursive: true });
    writeFileSync(keep, "своё");
    const sv = await ask({ type: "points.save", callsign: "site@laptop", stop: true });
    expect(sv.ok).toBe(true);
    expect(s.state).toBe("stopped");
    const r = await ask({ type: "points.raise", machine: "laptop", sid, point: 300, files: "keep", dir: s.info.cwd });
    expect(r.ok).toBe(true);
    expect(readFileSync(fileOf(s.info.cwd, sid))).toEqual(p300);
    expect(b.manage.map((m) => m.type)).toEqual(["session.stop", "session.start"]);
    expect(b.manage[1]).toMatchObject({ callsign: "site@laptop", point: 300 });
    expect(s.info.start).toBe("point");
    expect(puts("raise")[0]).toMatchObject({ base: 300, expect: "laptop", result: "ok" });
    expect(readFileSync(keep, "utf8")).toBe("своё");
    expect(r.result.folder).toBe("keep");
  });

  it("217 · старт Host: дописано без связи, реестр not_owner { owner: pc } — точка yield и session.remove у себя", async () => {
    const keeper = new stand.FakeHolders();
    const cwd = join(home, "work", "site");
    write(cwd, SID, conv(9));
    mkdirSync(join(home, "store"), { recursive: true });
    writeFileSync(join(home, "store", "host-points.json"), JSON.stringify({ sessions: { "site@laptop": { r2: true } } }));
    const reg = new FakeRegistry();
    reg.seed(317, SID, "laptop", { [`${SID}.jsonl`]: conv(5) });
    reg.sessions.set(SID, { owner: "pc", head: 318 });
    b = await bench({ home, holders: keeper, reg, sessions: [{ callsign: "site@laptop", session_id: SID, cwd }] });
    await until(() => puts("yield").length === 1, 3000).catch((e) => {
      console.log(JSON.stringify(b!.reg.puts.map((x) => [x.why, x.result])), JSON.stringify(b!.st.journal().slice(-15)));
      throw e;
    });
    await until(() => b!.manage.some((m) => m.type === "session.remove"));
    expect(puts("start")[0].result).toBe("not_owner");
    expect(b.manage.find((m) => m.type === "session.remove")).toMatchObject({ callsign: "site@laptop" });
    await until(() => b!.st.relay.frames("session.state").some((f) => f.callsign === "site@laptop" && f.state === null));
    expect(b.st.kernel.sessions.has("site@laptop")).toBe(false);
    await b.st.close();
    await keeper.close();
    b = null;
  });

  it("217 · связь с relay приходит позже подъёма сессий: точка старта ждёт первого roster, затем not_owner — yield (живой прогон 31 окт.)", async () => {
    const keeper = new stand.FakeHolders();
    const cwd = join(home, "work", "site");
    write(cwd, SID, conv(9));
    mkdirSync(join(home, "store"), { recursive: true });
    writeFileSync(join(home, "store", "host-points.json"), JSON.stringify({ sessions: { "site@laptop": { r2: true } } }));
    const reg = new FakeRegistry();
    reg.seed(317, SID, "laptop", { [`${SID}.jsonl`]: conv(5) });
    reg.sessions.set(SID, { owner: "pc", head: 318 });
    b = await bench({ home, holders: keeper, reg, holdRoster: true, sessions: [{ callsign: "site@laptop", session_id: SID, cwd }] });
    await new Promise((r) => setTimeout(r, 300));
    // связи нет — точки старта нет
    expect(puts("start")).toHaveLength(0);
    b.st.relay.releaseRoster();
    await until(() => puts("yield").length === 1, 3000);
    expect(puts("start")[0].result).toBe("not_owner");
    await until(() => b!.manage.some((m) => m.type === "session.remove"));
    await new Promise((r) => setTimeout(r, 300));
    // отданная сессия при закрытии точки не снимает: второго yield и запросов про убранную сессию нет
    expect(puts("yield")).toHaveLength(1);
    expect(b.st.journal().some((l) => l.word === "module_error")).toBe(false);
    await b.st.close();
    await keeper.close();
    b = null;
  });

  it("218 · сессия без пометки: ходы, закрытие, перезапуск — ни одного put; points.save — not_r2; поля r2 нет", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.UTC(2026, 9, 31, 14, 0) });
    b = await bench({ home });
    const s = await b.st.open("board@laptop", { module: "host-points" });
    write(s.info.cwd, s.info.session_id, conv(3));
    for (let i = 0; i < 3; i++) {
      b.st.proc("board@laptop").send(msg.state("running"));
      vi.advanceTimersByTime(12 * 60_000);
      turn(b.st.proc("board@laptop"));
      await until(() => s.state === "idle");
    }
    await s.restart();
    await s.stop();
    const r = await ask({ type: "points.save", callsign: "board@laptop" });
    expect(r).toMatchObject({ ok: false, error: "not_r2" });
    expect(b.reg.puts).toEqual([]);
    expect(b.reg.r2puts).toEqual([]);
    expect(b.st.states("board@laptop").every((f) => !("r2" in f))).toBe(true);
  });

  it("219 · dryRun в папку того же репозитория с 4 своими правками — dirty, files 4; ничего не изменилось", async () => {
    const dir = join(home, "Projects", "site");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://github.com/me/site.git");
    for (const f of ["a", "b", "c", "d"]) writeFileSync(join(dir, f), "1");
    git(dir, "add", "a", "b", "c", "d");
    git(dir, "commit", "-qm", "init");
    const commit = git(dir, "rev-parse", "HEAD");
    for (const f of ["a", "b", "c", "d"]) writeFileSync(join(dir, f), "2");
    const before = git(dir, "status", "--porcelain");
    b = await bench({ home, machine: "pc" });
    b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: conv(5) }, { git: { state: "clean", files: 0, unpushed: 0, url: "https://github.com/me/site.git", branch: "main", commit } });
    const r = await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir, files: "point", dryRun: true });
    expect(r.result).toMatchObject({ folder: "dirty", files: 4, sessions: [] });
    expect(git(dir, "status", "--porcelain")).toBe(before);
    expect(git(dir, "rev-parse", "HEAD")).toBe(commit);
    expect(existsSync(fileOf(dir, SID))).toBe(false);
    expect(b.reg.puts).toEqual([]);
    expect(b.manage).toEqual([]);
  });

  it("250 · пометка: поставили — точка сразу и по правилу; сняли — точки удалены из R2, правило молчит", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.UTC(2026, 9, 31, 14, 0) });
    b = await bench({ home });
    const s = await b.st.open("site@laptop", { module: "host-points" });
    write(s.info.cwd, s.info.session_id, conv(4));
    const r = await ask({ type: "session.r2", callsign: "site@laptop", on: true });
    expect(r.result).toEqual({ point: b.reg.sessions.get(s.info.session_id)!.head });
    expect(b.reg.puts.map((x) => x.result)).toEqual(["missing", "ok"]); // missing → блоки → точка
    expect(JSON.parse(readFileSync(join(home, "store", "host-points.json"), "utf8")).sessions["site@laptop"]).toEqual({ r2: true });
    vi.advanceTimersByTime(GAP_MS + 1000);
    b.st.proc("site@laptop").send(msg.state("running"));
    appendFileSync(fileOf(s.info.cwd, s.info.session_id), line(77));
    turn(b.st.proc("site@laptop"));
    await until(() => puts("rule").length >= 1);
    await until(() => last("site@laptop").r2 !== undefined);
    expect(last("site@laptop").r2).toEqual({});
    const off = await ask({ type: "session.r2", callsign: "site@laptop", on: false });
    expect(off.result.deleted).toBeGreaterThan(0);
    expect(b.reg.deletes[0]).toMatchObject({ sid: s.info.session_id, to: ".points", by: "panel-desk~owner@example.com" });
    expect(JSON.parse(readFileSync(join(home, "store", "host-points.json"), "utf8")).sessions?.["site@laptop"]).toBeUndefined();
    const n = b.reg.puts.length;
    vi.advanceTimersByTime(GAP_MS + 1000);
    b.st.proc("site@laptop").send(msg.state("running"));
    turn(b.st.proc("site@laptop"));
    await until(() => last("site@laptop").state === "idle" && !("r2" in last("site@laptop")));
    expect(b.reg.puts.length).toBe(n);
  });

  it("251 · смена папки: save со стопом, копия в site2 на той же машине, точка под новым sid, затем «Забыть» прежнюю", async () => {
    b = await bench({ home });
    const s = await marked("site@laptop", conv(10));
    const sid = s.info.session_id;
    const sv = await ask({ type: "points.save", callsign: "site@laptop", stop: true });
    const point = sv.result.point;
    const dir = join(home, "Projects", "site2");
    const r = await ask({ type: "points.raise", machine: "laptop", sid, point, copy: true, dir, files: "keep" });
    expect(r.ok).toBe(true);
    expect(b.manage.find((m) => m.type === "session.open")).toMatchObject({ resume: sid, fork: true, point, dir, name: "site2" });
    const c = b.st.session("host-points", "site2@laptop")!;
    expect(c.info.cwd).toBe(dir);
    // точка подъёма копии — на первом конце хода, когда claude записал файл нового разговора
    expect(JSON.parse(readFileSync(join(home, "store", "host-points.json"), "utf8")).sessions["site2@laptop"]).toEqual({ r2: true, base: point });
    writeFileSync(fileOf(dir, c.info.session_id), conv(11));
    b.st.proc("site2@laptop").send(msg.state("running"));
    await until(() => c.state === "busy");
    b.st.proc("site2@laptop").send(msg.state("idle"));
    await until(() => puts("raise").length === 1);
    expect(puts("raise")[0]).toMatchObject({ sid: c.info.session_id, base: point });
    await until(() => JSON.parse(readFileSync(join(home, "store", "host-points.json"), "utf8")).sessions["site2@laptop"].base === undefined);
    await ask({ type: "session.remove", callsign: "site@laptop" });
    expect(b.st.kernel.sessions.has("site@laptop")).toBe(false);
    expect(b.st.kernel.sessions.has("site2@laptop")).toBe(true);
    expect([...b.reg.rows.values()].some((x) => x.sid === sid)).toBe(true);
  });
});

describe("points: ветки и стыки", () => {
  it("points.save со стопом: ждёт ответа человека без interrupt — waiting; занята — ждёт конца хода", async () => {
    b = await bench({ home });
    const s = await marked();
    const p = b.st.proc("site@laptop");
    p.send(msg.state("requires_action"));
    await until(() => s.state === "waiting");
    expect(await ask({ type: "points.save", callsign: "site@laptop", stop: true })).toMatchObject({ ok: false, error: "waiting" });
    p.send(msg.state("running"));
    await until(() => s.state === "busy");
    const pending = ask({ type: "points.save", callsign: "site@laptop", stop: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(b.manage).toEqual([]);
    turn(p);
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(b.manage.map((m) => m.type)).toEqual(["session.stop"]);
    expect(s.state).toBe("stopped");
  });

  it("подъём сессии, которая здесь же идёт, — running; блок не тот — bad_point, файлы не тронуты", async () => {
    b = await bench({ home });
    const s = await marked();
    const sid = s.info.session_id;
    const row = b.reg.seed(5, sid, "laptop", { [`${sid}.jsonl`]: conv(3) });
    expect(await ask({ type: "points.raise", machine: "laptop", sid, point: 5, dir: s.info.cwd })).toMatchObject({ ok: false, error: "running" });
    await s.stop();
    const before = readFileSync(fileOf(s.info.cwd, sid));
    b.reg.r2.set(`f/${row.files[0].b[0]}`, Buffer.from("не zstd"));
    expect(await ask({ type: "points.raise", machine: "laptop", sid, point: 5, dir: s.info.cwd, files: "keep" })).toMatchObject({ ok: false, error: "bad_point" });
    expect(readFileSync(fileOf(s.info.cwd, sid))).toEqual(before);
  });

  it("точка не удалась — r2 { error, at } в roster; следующая удалась — {}", async () => {
    b = await bench({ home });
    const s = await marked();
    b.reg.refuseNext = { error: "r2_failed" };
    expect(await ask({ type: "points.save", callsign: "site@laptop" })).toMatchObject({ ok: false, error: "r2_failed" });
    b.st.proc("site@laptop").send(msg.state("idle"));
    await until(() => (last("site@laptop").r2 as { error?: string })?.error === "r2_failed");
    appendFileSync(fileOf(s.info.cwd, s.info.session_id), line(5));
    expect((await ask({ type: "points.save", callsign: "site@laptop" })).ok).toBe(true);
    b.st.proc("site@laptop").send(msg.assistant("x"));
    await until(() => JSON.stringify(last("site@laptop").r2) === "{}");
  });

  it("снимок git: свои правки — пакет из временного индекса, индекс папки не тронут; подъём в пустую папку — клон и ветка points-…", async () => {
    const origin = join(home, "origin.git");
    mkdirSync(origin);
    git(origin, "init", "-q", "--bare");
    const work = join(home, "work", "site");
    mkdirSync(work, { recursive: true });
    git(work, "init", "-q");
    git(work, "remote", "add", "origin", origin);
    writeFileSync(join(work, "a.txt"), "1");
    git(work, "add", "a.txt");
    git(work, "commit", "-qm", "init");
    git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
    writeFileSync(join(work, "a.txt"), "правка");
    writeFileSync(join(work, "new.txt"), "новый");
    const idx = git(work, "status", "--porcelain");
    b = await bench({ home });
    const s = await b.st.open("site@laptop", { module: "host-points", cwd: work });
    write(work, s.info.session_id, conv(3));
    await ask({ type: "session.r2", callsign: "site@laptop", on: true });
    expect(git(work, "status", "--porcelain")).toBe(idx);
    expect(git(work, "for-each-ref", "refs/points")).toBe("");
    const pt = puts("save").at(-1)!;
    expect(pt.git).toMatchObject({ state: "dirty", files: 2, unpushed: 0, url: origin });
    expect((pt.files as Array<{ p: string }>).map((x) => x.p)).toContain("git.bundle");
    // подъём копии в пустую папку: клон, ветка points-… с правками точки
    const dir = join(home, "Projects", "site-copy");
    const r = await ask({ type: "points.raise", machine: "laptop", sid: s.info.session_id, point: pt.result === "ok" ? b.reg.sessions.get(s.info.session_id)!.head : 0, copy: true, dir, files: "point" });
    expect(r.ok).toBe(true);
    expect(r.result.folder).toBe("empty");
    expect(r.result.branch).toMatch(/^points-\d{4}-\d\d-\d\d-\d{4}$/);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("правка");
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("новый");
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(r.result.branch);
  });

  it("«первые слова»: 10 последних обменов по 160 знаков", () => {
    const m = Array.from({ length: 12 }, (_, i) => [
      { type: "user", message: { content: `вопрос ${i}` } },
      { type: "assistant", message: { content: [{ type: "text", text: "о".repeat(200) }] } },
    ]).flat();
    const l = lastOf(m);
    expect(l).toHaveLength(10);
    expect(l[0][0]).toBe("вопрос 2");
    expect(l[9][1]).toHaveLength(160);
  });

});

describe("points: покрытие плана host-modules", () => {
  it("3082 · пометка без файла разговора — отказ no_file, поле r2 { error, at }", async () => {
    // источник: чьё: код (points.ts:115, :176-178, :303)
    b = await bench({ home });
    await b.st.open("site@laptop", { module: "host-points" });
    expect(await ask({ type: "session.r2", callsign: "site@laptop", on: true })).toMatchObject({ ok: false, error: "no_file" });
    b.st.proc("site@laptop").send(msg.state("idle"));
    await until(() => (last("site@laptop").r2 as { error?: string })?.error === "no_file");
    expect(b.st.journal().some((l) => l.ev === "point" && l.kind === "refuse" && l.word === "no_file")).toBe(true);
  });

  it("3083 · отказ словом: сессии нет — offline; points.delete отказал — пометка стоит", async () => {
    // источник: чьё: код (points.ts:299, :307, :317)
    b = await bench({ home });
    expect(await ask({ type: "session.r2", callsign: "nope@laptop", on: true })).toMatchObject({ ok: false, error: "offline" });
    expect(await ask({ type: "points.save", callsign: "nope@laptop" })).toMatchObject({ ok: false, error: "offline" });
    await marked();
    const orig = b.reg.handle.bind(b.reg);
    b.reg.handle = (f, m) => (f.type === "points.delete" ? { ok: false, error: "not_owner" } : orig(f, m));
    expect(await ask({ type: "session.r2", callsign: "site@laptop", on: false })).toMatchObject({ ok: false, error: "not_owner" });
    expect(JSON.parse(readFileSync(join(home, "store", "host-points.json"), "utf8")).sessions["site@laptop"]).toMatchObject({ r2: true });
  });

  it("3084 · points.save без изменений — same: true", async () => {
    // источник: чьё: код (points/contract.ts:2; points.ts:159-160)
    b = await bench({ home });
    await marked();
    const a = await ask({ type: "points.save", callsign: "site@laptop" });
    const c = await ask({ type: "points.save", callsign: "site@laptop" });
    expect(c.result).toEqual({ point: a.result.point, same: true });
  });

  it("3085 · R2 не принял блок — r2_failed, поле r2 { error }", async () => {
    // источник: чьё: код (points.ts:100-104)
    b = await bench({ home });
    const s = await b.st.open("site@laptop", { module: "host-points" });
    write(s.info.cwd, s.info.session_id, conv(4));
    b.reg.r2 = new (class extends Map<string, Buffer> {
      set(): this {
        throw new Error("R2 недоступен");
      }
    })();
    expect(await ask({ type: "session.r2", callsign: "site@laptop", on: true })).toMatchObject({ ok: false, error: "r2_failed" });
    expect(b.st.journal().some((l) => l.ev === "r2" && l.word === "r2_failed")).toBe(true);
    b.st.proc("site@laptop").send(msg.state("idle"));
    await until(() => (last("site@laptop").r2 as { error?: string })?.error === "r2_failed");
  });

  it("3109 · R2 не отдал блок при подъёме — отказ r2_failed, модуль точек остаётся включён", async () => {
    // источник: факт цикла тестов 2 нояб. — один сбой R2: при save слово r2_failed, при raise модуль выключался на машине
    b = await bench({ home, machine: "pc" });
    const row = b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: conv(5) });
    b.reg.r2.delete(`f/${row.files[0].b[0]}`);
    const dir = join(home, "Projects", "site");
    expect(await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir, files: "point" })).toMatchObject({ ok: false, error: "r2_failed" });
    expect(existsSync(fileOf(dir, SID))).toBe(false);
    expect(b.st.journal().some((l) => l.ev === "module_failed")).toBe(false);
    // модуль жив: следующий запрос обслуживается им, а не отказом module_error
    expect(await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir, dryRun: true })).toMatchObject({ ok: true });
  });

  it("3111 · папка подъёма не от ~ и не полная — bad_dir, а не путь от папки выпуска Host", async () => {
    // источник: факт 2 нояб. — подъём точки считал «x» от папки выпуска Host (resolve), открытие сессии такой путь отклоняло
    b = await bench({ home, machine: "pc" });
    b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: conv(5) });
    expect(await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir: "sb-copy", files: "point" })).toMatchObject({ ok: false, error: "bad_dir" });
  });

  it("3110 · подъём с пульта — точка подъёма несёт by: отправителя запроса", async () => {
    // источник: чьё: код (снятие пометки «в R2» пишет by = ctx.from; журнал флота: «по чьей команде»)
    b = await bench({ home, machine: "pc" });
    b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: conv(5) });
    const dir = join(home, "Projects", "site");
    expect(await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir, files: "point", from: "pult~owner@example.com" })).toMatchObject({ ok: true });
    expect(b.reg.puts.filter((f) => f.why === "raise").at(-1)).toMatchObject({ by: "pult~owner@example.com" });
  });

  it("3114 · сеть до R2 оборвалась посреди подъёма — r2_failed, как у сохранения; модуль включён", async () => {
    // источник: итерация 4 ревью «один сбой R2 — один исход r2_failed»; факт слепого расширения 2 нояб. — обрыв сети давал bad_point
    b = await bench({ home, machine: "pc" });
    b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: conv(5) });
    b.reg.netDown = true;
    const dir = join(home, "Projects", "site");
    expect(await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir, files: "point" })).toMatchObject({ ok: false, error: "r2_failed" });
    expect(b.st.journal().some((l) => l.ev === "module_failed")).toBe(false);
  });

  it("3115 · сеть до R2 оборвалась при сохранении — r2_failed, поле r2 { error }", async () => {
    // источник: чьё: код (сбой PUT по ссылке — r2_failed); итерация 4 ревью — один исход сбоя R2
    b = await bench({ home });
    const s = await b.st.open("site@laptop", { module: "host-points" });
    write(s.info.cwd, s.info.session_id, conv(4));
    b.reg.netDown = true;
    expect(await ask({ type: "session.r2", callsign: "site@laptop", on: true })).toMatchObject({ ok: false, error: "r2_failed" });
  });

  it("3116 · реестр отказал точке своим словом — тот же отказ, поле r2 { error } с этим словом", async () => {
    // источник: чьё: код (отказ реестра идёт как есть; поле r2 несёт слово)
    b = await bench({ home });
    await marked();
    b.reg.refuseNext = { error: "disconnected" };
    expect(await ask({ type: "points.save", callsign: "site@laptop" })).toMatchObject({ ok: false, error: "disconnected" });
    b.st.proc("site@laptop").send(msg.state("idle"));
    await until(() => (last("site@laptop").r2 as { error?: string })?.error === "disconnected");
  });

  it("3117 · подъём с папкой «~/…» — принят (от домашней папки машины), а не bad_dir", async () => {
    // источник: живой прогон 31 окт. — «~/папка» с пульта считалась от папки выпуска Host; итерация 6 — одно правило clientPath (747)
    // dryRun только читает папку: тест не пишет в домашнюю папку машины
    b = await bench({ home, machine: "pc" });
    b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: conv(5) });
    const r = await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir: "~/sb-3117-нет-такой", files: "point", dryRun: true });
    expect(r).toMatchObject({ ok: true });
  });

  it("3112 · сохранение: недостающие блоки уходят PUT по ссылкам реестра, тело — сжатый блок, своей подписи нет; повторный points.put — ok", async () => {
    // источник: чьё: код (ветка missing); ссылки — дизайн итерации 7
    b = await bench({ home });
    await marked();
    const r = await ask({ type: "points.save", callsign: "site@laptop" });
    expect(r).toMatchObject({ ok: true });
    const missing = b.reg.puts.find((x) => x.result === "missing")!;
    const hashes = [...new Set((missing.files as Array<{ b: string[] }>).flatMap((x) => x.b))];
    expect(b.reg.r2calls.filter((c) => c.method === "PUT").map((c) => c.key).sort()).toEqual(hashes.map((h) => `f/${h}`).sort());
    expect(b.reg.r2calls.every((c) => !c.signed)).toBe(true);
    expect(b.reg.puts.at(-1)!.result).not.toBe("missing");
  });

  it("3113 · подъём: блоки берутся GET по ссылкам из points.get, файлы собраны байт в байт", async () => {
    // источник: чьё: код (подъём точки); ссылки — дизайн итерации 7
    b = await bench({ home, machine: "pc" });
    const content = conv(30);
    const row = b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: content });
    const dir = join(home, "Projects", "site");
    expect(await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir, files: "point" })).toMatchObject({ ok: true });
    expect(readFileSync(fileOf(dir, SID))).toEqual(content);
    expect(b.reg.r2calls.filter((c) => c.method === "GET").map((c) => c.key)).toEqual(row.files[0].b.map((h) => `f/${h}`));
    expect(b.reg.r2calls.every((c) => !c.signed)).toBe(true);
  });

  it("3086 · points.save со стопом и interrupt — ход прерван, точка после остановки", async () => {
    // источник: чьё: код (points.ts:322-331)
    b = await bench({ home });
    const s = await marked();
    const p = b.st.proc("site@laptop");
    p.send(msg.state("running"));
    await until(() => s.state === "busy");
    const r = await ask({ type: "points.save", callsign: "site@laptop", stop: true, interrupt: true });
    expect(r.ok).toBe(true);
    expect(p.interrupts).toBe(1);
    expect(s.state).toBe("stopped");
    expect(puts("save").length).toBeGreaterThanOrEqual(2);
  });

  it("3087 · session.stop отказал — отказ его словом, точки нет", async () => {
    // источник: чьё: код (points.ts:325-329)
    b = await bench({ home, failStop: "shutting_down" });
    await marked();
    const n = puts().length;
    expect(await ask({ type: "points.save", callsign: "site@laptop", stop: true })).toMatchObject({ ok: false, error: "shutting_down" });
    expect(puts().length).toBe(n);
  });

  it("3088 · подъём: нет номера или точка чужой сессии — bad_point; files point в другой репозиторий — bad_dir; ничего не изменилось", async () => {
    // источник: чьё: код (points.ts:340, :348, :359)
    b = await bench({ home, machine: "pc" });
    b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: conv(5) }, { git: { state: "clean", files: 0, unpushed: 0, url: "https://github.com/me/site.git", branch: "main", commit: "abc" } });
    const dir = join(home, "Projects", "other");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://github.com/me/other.git");
    expect(await ask({ type: "points.raise", machine: "pc", sid: SID, dir })).toMatchObject({ ok: false, error: "bad_point" });
    expect(await ask({ type: "points.raise", machine: "pc", sid: "другой", point: 318, dir })).toMatchObject({ ok: false, error: "bad_point" });
    expect(await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir, files: "point" })).toMatchObject({ ok: false, error: "bad_dir" });
    expect(existsSync(fileOf(dir, SID))).toBe(false);
    expect(b.manage).toEqual([]);
  });

  it("3089 · точка подъёма: сессию уже подняли в другом месте — not_owner, поднятая убрана", async () => {
    // источник: чьё: код (points.ts:418-423)
    b = await bench({ home, machine: "pc" });
    b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: conv(5) });
    b.reg.refuseNext = { error: "not_owner", owner: "wsl" };
    const r = await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir: join(home, "Projects", "site") });
    expect(r).toMatchObject({ ok: false, error: "not_owner" });
    expect(b.manage.map((m) => m.type)).toEqual(["session.open", "session.remove"]);
    expect(b.st.kernel.sessions.has("site@pc")).toBe(false);
  });

  it("3090 · реестр не отдал точку — его слово, ничего не изменилось", async () => {
    // источник: чьё: код (points.ts:344-345)
    b = await bench({ home, machine: "pc" });
    const dir = join(home, "Projects", "site");
    expect(await ask({ type: "points.raise", machine: "pc", sid: SID, point: 999, dir })).toMatchObject({ ok: false, error: "no_point" });
    expect(b.manage).toEqual([]);
    expect(existsSync(fileOf(dir, SID))).toBe(false);
  });

  it("3091 · прежний хозяин недоступен — подъём удался, отказ remove в журнале", async () => {
    // источник: чьё: код (points.ts:425-428)
    b = await bench({ home, machine: "pc", remoteReply: (f) => (f.type === "session.remove" ? { ok: false, error: "offline" } : undefined) });
    b.reg.seed(318, SID, "laptop", { [`${SID}.jsonl`]: conv(5) });
    const r = await ask({ type: "points.raise", machine: "pc", sid: SID, point: 318, dir: join(home, "Projects", "site") });
    expect(r.ok).toBe(true);
    expect(b.st.journal().some((l) => l.ev === "session.remove" && l.word === "offline" && l.callsign === "site@laptop")).toBe(true);
  });

  it("3093 · точка старта — одна на сессию; новой сессии точка старта не нужна", async () => {
    // источник: чьё: код (points.ts:441-450)
    const keeper = new stand.FakeHolders();
    const cwd = join(home, "work", "site");
    write(cwd, SID, conv(9));
    mkdirSync(join(home, "store"), { recursive: true });
    writeFileSync(join(home, "store", "host-points.json"), JSON.stringify({ sessions: { "site@laptop": { r2: true } } }));
    b = await bench({ home, holders: keeper, sessions: [{ callsign: "site@laptop", session_id: SID, cwd }] });
    await until(() => puts("start").length === 1);
    const s = b.st.session("host-points", "site@laptop")!;
    await s.stop();
    await s.start();
    const fresh = await b.st.open("new@laptop", { module: "host-points" });
    write(fresh.info.cwd, fresh.info.session_id, conv(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(puts("start")).toHaveLength(1);
    await b.st.close();
    await keeper.close();
    b = null;
  });

  it("3094 · закрытие помеченной — точка", async () => {
    // источник: чьё: код (points.ts:461-468)
    b = await bench({ home });
    const s = await marked();
    const n = puts("rule").length;
    await s.stop();
    await until(() => puts("rule").length === n + 1);
  });

  it("3095 · процесс claude умер — точка дописанного на закрытии, после resume точки старта нет", async () => {
    // источник: слово пользователя (устав: «процесс claude умер — один resume»); чьё: код (points.ts:444, :461-468)
    b = await bench({ home });
    const s = await marked();
    const n = puts("rule").length;
    appendFileSync(fileOf(s.info.cwd, s.info.session_id), line(99));
    b.st.proc("site@laptop").exit(1, "упал");
    await until(() => b!.st.sdk.of("site@laptop").length === 2 && s.state === "idle");
    await until(() => puts("rule").length === n + 1);
    expect(puts("start")).toHaveLength(0);
  });

  it("3096 · штатная остановка доводит начатую точку, новых нет", async () => {
    // источник: слово пользователя (устав, graceful shutdown: «не принимает новое → доводит текущее»)
    b = await bench({ home });
    const s = await marked();
    // следующий points.put придержан
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = b.st.relay.receive.bind(b.st.relay);
    let held = false;
    b.st.relay.receive = (ws, text) => {
      if (!held && text !== "ping" && (JSON.parse(text) as Frame).type === "points.put") {
        held = true;
        void gate.then(() => orig(ws, text));
        return;
      }
      orig(ws, text);
    };
    appendFileSync(fileOf(s.info.cwd, s.info.session_id), line(42));
    const save = ask({ type: "points.save", callsign: "site@laptop" });
    await until(() => held);
    const st = b.st;
    const b0 = b;
    const before = b.reg.puts.length;
    let closed = false;
    const c = st.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(closed).toBe(false);
    release();
    await c;
    b = null;
    expect(st.exits).toEqual([0]);
    expect((await save).ok).toBe(true);
    // после начала остановки — только начатая точка (её повтор после missing — та же точка), новых поводов нет
    expect(b0.reg.puts.slice(before).every((p) => p.why === "save")).toBe(true);
    expect(b0.reg.puts.slice(before).some((p) => p.result === "ok")).toBe(true);
  });
});
