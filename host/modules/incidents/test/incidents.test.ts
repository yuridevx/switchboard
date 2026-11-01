// Эталоны incidents на стенде Host: настоящий HTTP на 127.0.0.1, настоящие manage, chat, questions, profiles, watch и push;
// профили — папки в клоне you/profiles (git профилей — поддельный, синхронизация на пути флоу не идёт); slots — модуль стенда:
// incidents слот не передаёт. Номер эталона — номер теста.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make, rule, wrap } from "../src/incidents.ts";
import { manage } from "../../manage/src/manage.ts";
import { make as makeChat } from "../../chat/src/chat.ts";
import { make as makeQuestions } from "../../questions/src/questions.ts";
import { make as makeProfiles } from "../../profiles/src/profiles.ts";
import { make as makeWatch } from "../../watch/src/watch.ts";
import { make as makePush } from "../../push/src/push.ts";

const { FakeHolders, module, standHost, until } = stand;
type Stand = stand.Stand;
const json = (rel: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", rel, "module.json"), "utf8")) as Manifest;

const stands: Stand[] = [];
const keepers: stand.FakeHolders[] = [];
const sockets: Server[] = [];
const saved = process.env.SWITCHBOARD_HOME;
/** клон репозитория профилей you/profiles: disk-full и ci */
let profiles = "";
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "switchboard-incidents-sb-"));
  process.env.SWITCHBOARD_HOME = home;
  profiles = join(home, "profiles", "you__profiles");
  mkdirSync(join(profiles, ".git"), { recursive: true });
  for (const [name, md, model] of [
    ["disk-full", "Плейбук disk-full: найди, что занимает место.", "haiku"],
    ["ci", "Плейбук ci: прочитай лог упавшей сборки.", "sonnet"],
  ]) {
    mkdirSync(join(profiles, name), { recursive: true });
    writeFileSync(join(profiles, name, "CLAUDE.md"), md);
    writeFileSync(join(profiles, name, "profile.yaml"), `model: ${model}\n`);
  }
});
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
  for (const k of keepers.splice(0)) await k.close();
  for (const s of sockets.splice(0)) s.close();
  if (saved === undefined) delete process.env.SWITCHBOARD_HOME;
  else process.env.SWITCHBOARD_HOME = saved;
});

const TO = "phone~you@example.com";
const PNG = { name: "screen.png", media_type: "image/png", data: "iVBORw0KGgo=" };

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

/** Host win: incidents с типами disk-full, build-red, nodir (папки нет), noprof (профиля нет). */
async function bench(o: { home?: string; holders?: stand.FakeHolders; port?: number } = {}) {
  const port = o.port ?? (await freePort());
  const work = mkdtempSync(join(tmpdir(), "switchboard-incidents-"));
  const st = await standHost({
    machine: "win",
    home: o.home,
    holders: o.holders,
    config: {
      modules: {
        "host-incidents": {
          port,
          to: TO,
          types: {
            "disk-full": { profile: "you/profiles/disk-full", dir: work },
            "build-red": { profile: "you/profiles/ci", dir: work },
            nodir: { dir: join(work, "нет") },
            noprof: { profile: "you/profiles/missing", dir: work },
          },
        },
      },
    },
    modules: [
      module("host-slots", { requests: { "session.slot": () => ({ restart: false }) } }),
      { manifest: json("profiles"), module: makeProfiles({ git: async () => ({ code: 0, out: "" }) }) },
      { manifest: json("watch"), module: makeWatch() },
      { manifest: json("push"), module: makePush() },
      { manifest: json("manage"), module: manage({ home: work }) },
      { manifest: json("chat"), module: makeChat() },
      { manifest: json("questions"), module: makeQuestions() },
      { manifest: manifest as Manifest, module: make() },
    ],
  });
  stands.push(st);
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/incident`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  /** системный промпт и settings сессии — что ушло в query() */
  const options = (cs: string) => st.query(cs).options as { cwd?: string; systemPrompt: { append?: string }; settings?: { model?: string } };
  return { st, port, work, post, options };
}

describe("эталоны incidents", () => {
  it("303 · POST нового типа и ключа — сессия disk-full-1 с профилем и папкой типа; во вводе <incident> и блок вложения от человека из to; 200 new: true", async () => {
    const { st, work, post, options } = await bench();
    const r = await post({ type: "disk-full", key: "C:", text: "Свободно 2%", attachments: [PNG] });
    expect(r).toEqual({ status: 200, body: { callsign: "disk-full-1@win", new: true } });
    expect(options("disk-full-1@win").cwd).toBe(work);
    expect(options("disk-full-1@win").systemPrompt.append).toContain("Плейбук disk-full: найди, что занимает место.");
    const p = st.proc("disk-full-1@win");
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0].message.content).toEqual([
      { type: "text", text: wrap("disk-full", "C:", "Свободно 2%") },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.data } },
    ]);
    expect(st.session("host-incidents", "disk-full-1@win")!.info.from).toBe(TO);
    await until(() => st.states("disk-full-1@win").at(-1)?.incident?.key === "C:");
    expect(st.states("disk-full-1@win").at(-1)!.incident).toEqual({ type: "disk-full", key: "C:" });
  });

  it("304 · POST того же ключа — та же сессия, new: false; обращение вторым вводом", async () => {
    const { st, post } = await bench();
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    expect(await post({ type: "disk-full", key: "C:", text: "Свободно 1%" })).toEqual({ status: 200, body: { callsign: "disk-full-1@win", new: false } });
    expect(await post({ type: "disk-full", key: "D:", text: "Свободно 4%" })).toEqual({ status: 200, body: { callsign: "disk-full-2@win", new: true } });
    const p = st.proc("disk-full-1@win");
    await until(() => p.inputs.length === 2);
    expect(p.inputs[1].message.content).toBe(wrap("disk-full", "C:", "Свободно 1%"));
  });

  it("305 · два POST одного ключа одновременно — одна сессия, оба обращения во вводе", async () => {
    const { st, post } = await bench();
    const both = await Promise.all([post({ type: "build-red", text: "main упал" }), post({ type: "build-red", text: "и ещё раз" })]);
    expect(both.map((r) => r.body.callsign)).toEqual(["build-red-1@win", "build-red-1@win"]);
    expect(both.map((r) => r.body.new).sort()).toEqual([false, true]);
    expect([...st.kernel.sessions.keys()].filter((c) => c.startsWith("build-red"))).toEqual(["build-red-1@win"]);
    await until(() => st.proc("build-red-1@win").inputs.length === 2);
  });

  it("306 · сессия закрыта, затем POST того же ключа — новая сессия, new: true", async () => {
    const { st, post } = await bench();
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    expect(await st.relay.request({ type: "session.remove", v: 1, callsign: "disk-full-1@win" })).toMatchObject({ ok: true });
    const r = await post({ type: "disk-full", key: "C:", text: "Свободно 3%" });
    expect(r).toEqual({ status: 200, body: { callsign: "disk-full-1@win", new: true } });
    const p = st.proc("disk-full-1@win");
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0].message.content).toBe(wrap("disk-full", "C:", "Свободно 3%"));
  });

  it("307 · неизвестный тип, не JSON, чужой Host — 400 unknown_type и bad_frame, сессии нет; вложение без блока — 400 bad_attachment, во ввод ничего", async () => {
    const { st, port, post } = await bench();
    expect(await post({ type: "printer", text: "Замятие" })).toEqual({ status: 400, body: { error: "unknown_type" } });
    expect(await post({ type: "disk-full", text: "x" }, { "content-type": "text/plain" })).toEqual({ status: 400, body: { error: "bad_frame" } });
    expect(await post("{не json")).toEqual({ status: 400, body: { error: "bad_frame" } });
    const foreign = await new Promise<{ status: number; body: string }>((ok) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/incident", method: "POST", headers: { host: `evil.example:${port}`, "content-type": "application/json" } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => ok({ status: res.statusCode!, body: b }));
      });
      req.end(JSON.stringify({ type: "disk-full", text: "x" }));
    });
    expect(foreign).toEqual({ status: 400, body: JSON.stringify({ error: "bad_frame" }) });
    expect(st.kernel.sessions.size).toBe(0);
    const zip = await post({ type: "disk-full", key: "C:", text: "дамп", attachments: [{ name: "dump.zip", media_type: "application/zip", data: "UEsDBA==" }] });
    expect(zip).toEqual({ status: 400, body: { error: "bad_attachment" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(st.proc("disk-full-1@win").inputs).toHaveLength(0);
  });

  it("308 · AskUserQuestion в сессии инцидента — вопрос человеку из to: кадр question; телефона нет на связи — пуш запросом push.send", async () => {
    const { st, post } = await bench();
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [], workers: [{ name: "push", contract: { "push.send": 1 } }] } as Frame);
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    const p = st.proc("disk-full-1@win");
    await until(() => p.inputs.length === 1);
    void p.ask("AskUserQuestion", { questions: [{ question: "Удалить старые логи?", options: [{ label: "Да" }, { label: "Нет" }] }] }, "toolu_01Df");
    const q = await until(() => st.relay.frames("question")[0]);
    expect(q).toMatchObject({ type: "question", from: "disk-full-1@win", to: [TO], question: "toolu_01Df" });
    const push = await until(() => st.relay.frames("push.send")[0]);
    expect(push).toMatchObject({ push: { to: TO, type: "question", from: "disk-full-1@win" } });
  });

  it("309 · плейбук типа: CLAUDE.md и модель профиля типа, правило модуля в системном промпте; правка profile.yaml — следующий инцидент с новой моделью", async () => {
    const { post, options } = await bench();
    await post({ type: "build-red", key: "main", text: "main упал на тесте auth" });
    const o = options("build-red-1@win");
    expect(o.systemPrompt.append).toContain("Плейбук ci: прочитай лог упавшей сборки.");
    expect(o.systemPrompt.append).toContain(rule("build-red", "main", TO));
    expect(o.settings?.model).toBe("sonnet");
    writeFileSync(join(profiles, "ci", "profile.yaml"), "model: opus\n");
    await post({ type: "build-red", key: "release", text: "release упал" });
    expect(options("build-red-2@win").settings?.model).toBe("opus");
  });

  it("310 · перезапуск Host при живой сессии инцидента — пока Host нет, соединение отклонено; вопрос до нового обращения — человеку из to; POST того же ключа — в неё же", async () => {
    const k = new FakeHolders();
    keepers.push(k);
    const a = await bench({ holders: k });
    await a.post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    await a.st.close();
    stands.splice(stands.indexOf(a.st), 1);
    await expect(fetch(`http://127.0.0.1:${a.port}/incident`, { method: "POST" })).rejects.toThrow();
    const b = await bench({ holders: k, home: a.st.home, port: a.port });
    await until(() => b.st.session("host-incidents", "disk-full-1@win")?.state === "idle");
    void k.procs.get("disk-full-1@win")!.ask("AskUserQuestion", { questions: [{ question: "Чистить?" }] }, "toolu_02Df");
    expect(await until(() => b.st.relay.frames("question")[0])).toMatchObject({ from: "disk-full-1@win", to: [TO] });
    expect(await b.post({ type: "disk-full", key: "C:", text: "Свободно 1%" })).toEqual({ status: 200, body: { callsign: "disk-full-1@win", new: false } });
  });
});

describe("эталоны incidents: ожидаемые ветки", () => {
  it("339 · сессия инцидента в failed — POST того же ключа: 400 stopped, новой сессии нет; в roster failed", async () => {
    // источник: принятый дизайн, ожидаемые ветки — «Сессия инцидента в failed — POST — stopped; roster показывает failed, дальше решает агент»
    const { st, post } = await bench();
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    st.holders.failInitNext = 1;
    st.proc("disk-full-1@win").exit(1, "первый");
    await until(() => st.sdk.of("disk-full-1@win").length === 2 && st.holders.procs.get("disk-full-1@win")?.initializes === 1);
    st.proc("disk-full-1@win").exit(1, "второй");
    await until(() => st.states("disk-full-1@win").at(-1)?.state === "failed");
    expect(await post({ type: "disk-full", key: "C:", text: "Свободно 1%" })).toEqual({ status: 400, body: { error: "stopped" } });
    expect([...st.kernel.sessions.keys()]).toEqual(["disk-full-1@win"]);
  });

  it("340 · папки типа нет — 400 bad_spec; профиля типа нет — 400 no_profile; сессий нет, причина в журнале", async () => {
    // источник: принятый дизайн, ожидаемые ветки — «Нет папки или профиля типа — POST — open_failed или no_profile, причина в журнале; сессии нет»;
    // слово для папки — bad_spec: чьё: код (manage, контракт incidents)
    const { st, post } = await bench();
    expect(await post({ type: "nodir", text: "x" })).toEqual({ status: 400, body: { error: "bad_spec" } });
    expect(await post({ type: "noprof", text: "x" })).toEqual({ status: 400, body: { error: "no_profile" } });
    expect(st.kernel.sessions.size).toBe(0);
    const why = st.journal().filter((l) => l.ev === "incident" && l.kind === "refuse");
    expect(why.map((l) => [l.word, String(l.why).split(":")[0]])).toEqual([
      ["bad_spec", "nodir"],
      ["no_profile", "noprof"],
    ]);
  });

  it("341 · порт занят — модуль выключен на машине, причина в журнале, failed в roster сессий; Host и сессии работают", async () => {
    // источник: устав — ошибку модуля ловит ядро: модуль выключается, roster показывает failed (закрытый список ожидаемых веток)
    const port = await freePort();
    const busy = createServer().listen(port, "127.0.0.1");
    sockets.push(busy);
    await new Promise((r) => busy.once("listening", r));
    const { st } = await bench({ port });
    expect(st.startError).toBeNull();
    expect(st.journal().find((l) => l.ev === "module_failed" && l.module === "host-incidents")!.why).toContain("EADDRINUSE");
    const s = await st.open("docs@win");
    expect(s.state).toBe("idle");
    await until(() => st.states("docs@win").at(-1)?.failed?.["host-incidents"]);
  });

  it("342 · штатная остановка с обращением в полёте: начатый POST доведён — 200 new: true; новый POST — соединение отклонено", async () => {
    // источник: принятый дизайн, ожидаемые ветки — «Host останавливается — Новые POST не принимаются, начатые доводятся, HTTP закрывается»;
    // устав — «По сигналу: не принимает новое → доводит или отдаёт текущее»
    const { st, post } = await bench();
    st.holders.failInitNext = 1;
    const started = post({ type: "disk-full", key: "C:", text: "Свободно 2%" }).catch((e: Error) => ({ status: 0, body: { error: e.message } }));
    // обращение в полёте: процесс сессии поднят, initialize ещё без ответа
    const p = await until(() => st.holders.procs.get("disk-full-1@win"));
    await until(() => p.initializes === 1);
    const down = st.close();
    stands.splice(stands.indexOf(st), 1);
    await new Promise((r) => setTimeout(r, 30));
    await expect(post({ type: "disk-full", key: "D:", text: "Свободно 4%" })).rejects.toThrow();
    // SDK отвечает на initialize
    const w = p as unknown as { failInit: boolean; write: (x: unknown) => void };
    w.failInit = false;
    w.write({ $: "initialized" });
    expect(await started).toEqual({ status: 200, body: { callsign: "disk-full-1@win", new: true } });
    await down;
    expect(st.exits).toEqual([0]);
  });
});
