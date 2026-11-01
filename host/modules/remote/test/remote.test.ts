// Эталоны remote на стенде Host: поддельные SDK, relay, keeper и часы. Поддельный query отвечает на enableRemoteControl,
// поддельный slots — на machine.slots; файл разговора — во временной папке Claude. Номер эталона — номер теста.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Manifest, Module } from "@switchboard/host";
import { lastBridge, remote } from "../src/remote.ts";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "module.json"), "utf8")) as Manifest;
const proto = stand.FakeQuery.prototype as unknown as Record<string, unknown>;
const original = proto.enableRemoteControl;
const stands: stand.Stand[] = [];
const keepers: stand.FakeHolders[] = [];

/** Ответ поддельного query на enableRemoteControl: n — номер вызова. */
let rc: (n: number) => unknown;
let rcCalls = 0;
beforeEach(() => {
  rcCalls = 0;
  rc = (n) => ({ session_url: `https://claude.ai/code/session_0${n}Jai`, bridge_session_id: `session_0${n}Jai` });
  proto.enableRemoteControl = async function (this: stand.FakeQuery, ...args: unknown[]) {
    this.calls.push({ name: "enableRemoteControl", args });
    return rc(++rcCalls);
  };
});
afterEach(async () => {
  proto.enableRemoteControl = original;
  for (const st of stands.splice(0)) await st.close();
  for (const k of keepers.splice(0)) await k.close();
});

type World = { who: Record<string, string>; asked: number; claudeDir: string };
/** Поддельный slots: в слоте main — who.main; сессии — все, что спрашивали. */
function slots(w: World): ReturnType<typeof stand.module> {
  return stand.module("host-slots", {
    requests: {
      "machine.slots": (_f, { host }) => {
        w.asked++;
        return { slots: { main: { account: w.who.main, order: ["infirex", "y0902"], wait: null, sessions: host.sessions().map((s) => s.callsign) } } };
      },
    },
  });
}

async function make(o: { machine?: string; holders?: stand.FakeHolders; home?: string; world?: World; extra?: Module } = {}) {
  const w = o.world ?? { who: { main: "infirex" }, asked: 0, claudeDir: mkdtempSync(join(tmpdir(), "switchboard-claude-")) };
  const mods = [slots(w), { manifest, module: remote({ claudeDir: w.claudeDir }) }];
  if (o.extra) mods.push(stand.module("host-printer", o.extra));
  const st = await stand.standHost({ machine: o.machine, holders: o.holders, home: o.home, modules: mods });
  stands.push(st);
  return { st, w };
}

/** Файл разговора, как его ведёт claude: строки разговора и привязка к сессии claude.ai. */
function transcript(w: World, sid: string, bridge: string): string {
  const d = join(w.claudeDir, "projects", "D--Projects-site");
  mkdirSync(d, { recursive: true });
  const f = join(d, `${sid}.jsonl`);
  writeFileSync(
    f,
    [
      { type: "user", message: { role: "user", content: "привет" }, sessionId: sid },
      { type: "bridge-session", sessionId: sid, bridgeSessionId: bridge, lastSequenceNum: 4, ownerAccountUuid: "acc-infirex" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "APPLE" }] }, sessionId: sid },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  return f;
}

const rcOf = (st: stand.Stand, cs: string) => st.query(cs).calls.filter((c) => c.name === "enableRemoteControl");
const rec = (st: stand.Stand, cs: string) => st.session("host-remote", cs)!.store<Record<string, unknown>>().get();
const field = (st: stand.Stand, cs: string) => st.kernel.sessions.get(cs)!.record().remote;
const unbinds = (st: stand.Stand) => st.journal().filter((l) => l.ev === "unbind");

/** Конец хода: slots спрошен заново. */
async function turnAndAsk(st: stand.Stand, cs: string, w: World) {
  const before = w.asked;
  stand.turn(st.proc(cs));
  await stand.until(() => w.asked > before);
}

describe("эталоны remote", () => {
  it("230 · новая сессия: один enableRemoteControl(true) без имени; в roster url; в разделе bridge и infirex; файл не тронут", async () => {
    const { st } = await make();
    await st.open("site@laptop");
    await stand.until(() => rec(st, "site@laptop"));
    expect(rcOf(st, "site@laptop")).toEqual([{ name: "enableRemoteControl", args: [true] }]);
    expect(field(st, "site@laptop")).toEqual({ url: "https://claude.ai/code/session_01Jai" });
    expect(rec(st, "site@laptop")).toEqual({ url: "https://claude.ai/code/session_01Jai", bridge: "session_01Jai", account: "infirex" });
    expect(unbinds(st)).toEqual([]);
  });

  it("231 · процесс упал, resume, в слоте тот же infirex: файл байт в байт прежний, после initialize — включение", async () => {
    const { st, w } = await make();
    const s = await st.open("site@laptop");
    await stand.until(() => rec(st, "site@laptop"));
    const f = transcript(w, s.info.session_id, "session_01Jai");
    const before = readFileSync(f);
    st.proc("site@laptop").exit(1, "упал");
    await stand.until(() => st.sdk.of("site@laptop").length === 2 && rcOf(st, "site@laptop").length === 1);
    expect(readFileSync(f)).toEqual(before);
    expect(rcOf(st, "site@laptop")).toEqual([{ name: "enableRemoteControl", args: [true] }]);
  });

  it("232 · закрыт ради resume, в слоте теперь y0902: до query() — снятие привязки, затем включение; account y0902; строка журнала", async () => {
    const { st, w } = await make();
    const s = await st.open("site@laptop");
    await stand.until(() => rec(st, "site@laptop"));
    const f = transcript(w, s.info.session_id, "session_01Jai");
    w.who.main = "y0902";
    await turnAndAsk(st, "site@laptop", w);
    await s.restart();
    const lines = readFileSync(f, "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toEqual({ type: "bridge-session", sessionId: s.info.session_id, bridgeSessionId: "", lastSequenceNum: 0 });
    expect(lines).toHaveLength(4);
    await stand.until(() => rcOf(st, "site@laptop").length === 1 && rec(st, "site@laptop")?.account === "y0902");
    expect(unbinds(st).map((l) => l.why)).toEqual(["привязка снята: infirex → y0902 · session_01Jai"]);
  });

  it("233 · подмена при живом процессе, Host перезапущен — attach: файл не тронут, включение, url прежний, account infirex", async () => {
    const k = new stand.FakeHolders();
    keepers.push(k);
    const { st, w } = await make({ holders: k });
    const s = await st.open("site@laptop");
    await stand.until(() => rec(st, "site@laptop"));
    const f = transcript(w, s.info.session_id, "session_01Jai");
    const before = readFileSync(f);
    w.who.main = "y0902";
    st.crash();
    rc = () => ({ session_url: "https://claude.ai/code/session_01Jai", bridge_session_id: "session_01Jai" });
    const { st: st2 } = await make({ holders: k, home: st.home, world: w });
    await stand.until(() => rcOf(st2, "site@laptop").length === 1 && st2.journal().some((l) => l.ev === "remote" && l.callsign === "site@laptop"));
    expect(st2.session("host-remote", "site@laptop")!.info.start).toBe("attach");
    expect(readFileSync(f)).toEqual(before);
    expect(rec(st2, "site@laptop")).toEqual({ url: "https://claude.ai/code/session_01Jai", bridge: "session_01Jai", account: "infirex" });
  });

  it("234 · на pc раздела нет, файл пришёл с laptop с привязкой; старт из точки: снятие, включение, новый bridge и infirex", async () => {
    const { st, w } = await make({ machine: "pc" });
    const s = await st.open("site@pc");
    await stand.until(() => rec(st, "site@pc"));
    await s.stop();
    st.session("host-remote", "site@pc")!.store().set(undefined);
    const f = transcript(w, s.info.session_id, "session_01Jai");
    await s.start({ point: 318 });
    expect(lastBridge(f)).toEqual({ type: "bridge-session", sessionId: s.info.session_id, bridgeSessionId: "", lastSequenceNum: 0 });
    await stand.until(() => rec(st, "site@pc")?.bridge === "session_02Jai");
    expect(rec(st, "site@pc")).toMatchObject({ account: "infirex" });
  });

  it("235 · claude отказал во включении: по одному вызову на старт, remote { error }, строка stop; повторов нет", async () => {
    rc = () => {
      throw new Error("Remote Control requires a claude.ai subscription");
    };
    const { st } = await make();
    const s = await st.open("site@laptop");
    await stand.until(() => st.journal().some((l) => l.ev === "remote" && l.kind === "stop"));
    expect(field(st, "site@laptop")).toEqual({ error: "Remote Control requires a claude.ai subscription" });
    await s.restart();
    await stand.until(() => st.journal().filter((l) => l.ev === "remote" && l.kind === "stop").length === 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(rcCalls).toBe(2);
    expect(rcOf(st, "site@laptop")).toHaveLength(1);
    expect(st.journal().filter((l) => l.kind === "stop" && l.ev === "remote").map((l) => l.why)).toEqual([
      "Remote Control requires a claude.ai subscription",
      "Remote Control requires a claude.ai subscription",
    ]);
  });

  it("236 · файл только на чтение, снять нужно: ошибка модуля — failed в roster, включения нет, остальные модули работают", async () => {
    const seen: string[] = [];
    const { st, w } = await make({ extra: { on: { event: (_s, m) => void seen.push(m.type) } } });
    const s = await st.open("site@laptop");
    await stand.until(() => rec(st, "site@laptop"));
    const f = transcript(w, s.info.session_id, "session_01Jai");
    w.who.main = "y0902";
    await turnAndAsk(st, "site@laptop", w);
    chmodSync(f, 0o444);
    try {
      st.proc("site@laptop").exit(1, "упал");
      await stand.until(() => st.sdk.of("site@laptop").length === 2 && st.kernel.sessions.get("site@laptop")!.state === "idle");
      expect(Object.keys(st.kernel.sessions.get("site@laptop")!.record().failed as object)).toEqual(["host-remote"]);
      expect(rcOf(st, "site@laptop")).toEqual([]);
      seen.length = 0;
      stand.turn(st.proc("site@laptop"));
      await stand.until(() => seen.includes("result"));
    } finally {
      chmodSync(f, 0o644);
    }
  });

  it("239 · откат: файл из точки, start — point: снятие «старт из точки», новый bridge; второй прогон тем же аккаунтом по resume — файл прежний", async () => {
    const { st, w } = await make();
    const s = await st.open("site@laptop");
    await stand.until(() => rec(st, "site@laptop"));
    await s.stop();
    const f = transcript(w, s.info.session_id, "session_01Jai");
    await s.start({ point: 300 });
    expect(lastBridge(f)?.bridgeSessionId).toBe("");
    expect(unbinds(st).map((l) => l.why)).toEqual(["привязка снята: старт из точки · session_01Jai"]);
    await stand.until(() => rec(st, "site@laptop")?.bridge === "session_02Jai");
    expect(rec(st, "site@laptop")).toMatchObject({ account: "infirex" });
    // claude завёл новую сессию claude.ai и записал привязку
    appendFileSync(f, JSON.stringify({ type: "bridge-session", sessionId: s.info.session_id, bridgeSessionId: "session_02Jai", lastSequenceNum: 0 }) + "\n");
    const before = readFileSync(f);
    st.proc("site@laptop").exit(1, "упал");
    await stand.until(() => st.sdk.of("site@laptop").length === 3 && rec(st, "site@laptop")?.bridge === "session_03Jai");
    expect(st.session("host-remote", "site@laptop")!.info.start).toBe("resume");
    expect(readFileSync(f)).toEqual(before);
  });
});

describe("remote", () => {
  it("resume без привязки в файле и без файла — снимать нечего; записи нет, а привязка есть — снять", async () => {
    const { st, w } = await make();
    const s = await st.open("site@laptop");
    await stand.until(() => rec(st, "site@laptop"));
    st.proc("site@laptop").exit(1);
    await stand.until(() => st.sdk.of("site@laptop").length === 2 && rcOf(st, "site@laptop").length === 1);
    expect(unbinds(st)).toEqual([]);
    st.session("host-remote", "site@laptop")!.store().set(undefined);
    const f = transcript(w, s.info.session_id, "session_02Jai");
    st.proc("site@laptop").exit(1);
    await stand.until(() => st.sdk.of("site@laptop").length === 3);
    expect(lastBridge(f)?.bridgeSessionId).toBe("");
    expect(unbinds(st).at(-1)?.why).toBe("привязка снята: записи нет · session_02Jai");
  });

  it("slots не ответил на старте Host — модуль выключен на машине, причина в журнале", async () => {
    const st = await stand.standHost({ modules: [stand.module("host-slots", { requests: { "machine.slots": () => { throw new Error("сломался"); } } }), { manifest, module: remote({ claudeDir: tmpdir() }) }] });
    stands.push(st);
    expect(st.journal().some((l) => l.ev === "module_failed" && l.module === "host-remote")).toBe(true);
  });
});
