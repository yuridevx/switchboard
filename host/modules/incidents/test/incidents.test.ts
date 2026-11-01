// Эталоны incidents на стенде Host: настоящий HTTP на 127.0.0.1, настоящие manage, chat, questions, profiles, watch и push;
// профили — папки в клоне you/profiles (git профилей — поддельный, синхронизация на пути флоу не идёт); slots — модуль стенда:
// incidents слот не передаёт. Номер эталона — номер теста.
// Источник свойств доставки — слово пользователя 1 нояб.: «запрос пост не должен ничего ждать / инцидент должен быть доставлен хотя бы 1 раз».
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

const { FakeHolders, module, standHost, turn, until } = stand;
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

/** Ход взял обращение i из ввода процесса: его uuid — в user_message_uuids кадров хода. */
const take = (p: stand.FakeProc, i = 0) => turn(p, "принято", { user_message_uuids: [p.inputs[i].uuid] });
/** Текст ввода i процесса: строка или первый блок. */
const said = (p: stand.FakeProc, i = 0) => {
  const c = p.inputs[i].message.content;
  return typeof c === "string" ? c : (c as Array<{ text?: string }>)[0].text;
};

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
  /** обращения на диске Host */
  const disk = () => st.host("host-incidents").store<Array<{ id: string; callsign?: string }>>().get() ?? [];
  return { st, port, work, post, options, disk };
}

describe("эталоны incidents", () => {
  it("303 · POST нового типа и ключа — 202 с id сразу; сессия disk-full-1 с профилем и папкой типа; во вводе <incident> с id и блок вложения от человека из to", async () => {
    const { st, work, post, options } = await bench();
    const r = await post({ type: "disk-full", key: "C:", text: "Свободно 2%", attachments: [PNG] });
    expect(r.status).toBe(202);
    const id = r.body.id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const p = await until(() => st.holders.procs.get("disk-full-1@win"));
    await until(() => p.inputs.length === 1);
    expect(options("disk-full-1@win").cwd).toBe(work);
    expect(options("disk-full-1@win").systemPrompt.append).toContain("Плейбук disk-full: найди, что занимает место.");
    expect(p.inputs[0].uuid).toBe(id);
    expect(p.inputs[0].message.content).toEqual([
      { type: "text", text: wrap("disk-full", "C:", "Свободно 2%", id) },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.data } },
    ]);
    expect(st.session("host-incidents", "disk-full-1@win")!.info.from).toBe(TO);
    await until(() => st.states("disk-full-1@win").at(-1)?.incident?.key === "C:");
    expect(st.states("disk-full-1@win").at(-1)!.incident).toEqual({ type: "disk-full", key: "C:" });
  });

  it("304 · POST того же ключа — вторым вводом той же сессии; другой ключ — disk-full-2", async () => {
    const { st, post } = await bench();
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    const second = await post({ type: "disk-full", key: "C:", text: "Свободно 1%" });
    await post({ type: "disk-full", key: "D:", text: "Свободно 4%" });
    const p = await until(() => st.holders.procs.get("disk-full-1@win"));
    await until(() => p.inputs.length === 2);
    expect(p.inputs[1].message.content).toBe(wrap("disk-full", "C:", "Свободно 1%", second.body.id as string));
    const d = await until(() => st.holders.procs.get("disk-full-2@win"));
    await until(() => d.inputs.length === 1);
    expect(said(d)).toContain("Свободно 4%");
  });

  it("305 · два POST одного ключа одновременно — оба 202, одна сессия, оба обращения во вводе", async () => {
    const { st, post } = await bench();
    const both = await Promise.all([post({ type: "build-red", text: "main упал" }), post({ type: "build-red", text: "и ещё раз" })]);
    expect(both.map((r) => r.status)).toEqual([202, 202]);
    await until(() => st.holders.procs.get("build-red-1@win")?.inputs.length === 2);
    expect([...st.kernel.sessions.keys()].filter((c) => c.startsWith("build-red"))).toEqual(["build-red-1@win"]);
  });

  it("306 · ход взял обращение, сессия закрыта, затем POST того же ключа — новая сессия disk-full-1", async () => {
    const { st, post, disk } = await bench();
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    const p = await until(() => st.holders.procs.get("disk-full-1@win"));
    await until(() => p.inputs.length === 1);
    take(p);
    await until(() => disk().length === 0);
    expect(await st.relay.request({ type: "session.remove", v: 1, callsign: "disk-full-1@win" })).toMatchObject({ ok: true });
    await post({ type: "disk-full", key: "C:", text: "Свободно 3%" });
    const q = await until(() => st.holders.procs.get("disk-full-1@win"));
    await until(() => q.inputs.length === 1);
    expect(said(q)).toContain("Свободно 3%");
    expect([...st.kernel.sessions.keys()]).toEqual(["disk-full-1@win"]);
  });

  it("307 · неизвестный тип, не JSON, чужой Host, вложение без блока — 400 unknown_type, bad_frame, bad_attachment; сессий и обращений на диске нет", async () => {
    const { st, port, post, disk } = await bench();
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
    const zip = await post({ type: "disk-full", key: "C:", text: "дамп", attachments: [{ name: "dump.zip", media_type: "application/zip", data: "UEsDBA==" }] });
    expect(zip).toEqual({ status: 400, body: { error: "bad_attachment" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(st.kernel.sessions.size).toBe(0);
    expect(disk()).toEqual([]);
  });

  it("308 · AskUserQuestion в сессии инцидента — вопрос человеку из to: кадр question; телефона нет на связи — пуш запросом push.send", async () => {
    const { st, post } = await bench();
    st.relay.deliver({ type: "roster", machines: [], sessions: [], clients: [], workers: [{ name: "push", contract: { "push.send": 1 } }] } as Frame);
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    const p = await until(() => st.holders.procs.get("disk-full-1@win"));
    await until(() => p.inputs.length === 1);
    void p.ask("AskUserQuestion", { questions: [{ question: "Удалить старые логи?", options: [{ label: "Да" }, { label: "Нет" }] }] }, "toolu_01Df");
    const q = await until(() => st.relay.frames("question")[0]);
    expect(q).toMatchObject({ type: "question", from: "disk-full-1@win", to: [TO], question: "toolu_01Df" });
    const push = await until(() => st.relay.frames("push.send")[0]);
    expect(push).toMatchObject({ push: { to: TO, type: "question", from: "disk-full-1@win" } });
  });

  it("309 · плейбук типа: CLAUDE.md и модель профиля типа, правило модуля в системном промпте; правка profile.yaml — следующий инцидент с новой моделью", async () => {
    const { st, post, options } = await bench();
    await post({ type: "build-red", key: "main", text: "main упал на тесте auth" });
    await until(() => st.holders.procs.get("build-red-1@win")?.inputs.length === 1);
    const o = options("build-red-1@win");
    expect(o.systemPrompt.append).toContain("Плейбук ci: прочитай лог упавшей сборки.");
    expect(o.systemPrompt.append).toContain(rule("build-red", "main", TO));
    expect(o.settings?.model).toBe("sonnet");
    writeFileSync(join(profiles, "ci", "profile.yaml"), "model: opus\n");
    await post({ type: "build-red", key: "release", text: "release упал" });
    await until(() => st.holders.procs.get("build-red-2@win")?.inputs.length === 1);
    expect(options("build-red-2@win").settings?.model).toBe("opus");
  });

  it("310 · перезапуск Host при живой сессии инцидента — пока Host нет, соединение отклонено; вопрос до нового обращения — человеку из to; POST того же ключа — в неё же", async () => {
    const k = new FakeHolders();
    keepers.push(k);
    const a = await bench({ holders: k });
    await a.post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    const p = await until(() => k.procs.get("disk-full-1@win"));
    await until(() => p.inputs.length === 1);
    take(p);
    await until(() => a.disk().length === 0);
    await a.st.close();
    stands.splice(stands.indexOf(a.st), 1);
    await expect(fetch(`http://127.0.0.1:${a.port}/incident`, { method: "POST" })).rejects.toThrow();
    const b = await bench({ holders: k, home: a.st.home, port: a.port });
    await until(() => b.st.session("host-incidents", "disk-full-1@win")?.state === "idle");
    void p.ask("AskUserQuestion", { questions: [{ question: "Чистить?" }] }, "toolu_02Df");
    expect(await until(() => b.st.relay.frames("question")[0])).toMatchObject({ from: "disk-full-1@win", to: [TO] });
    expect((await b.post({ type: "disk-full", key: "C:", text: "Свободно 1%" })).status).toBe(202);
    await until(() => p.inputs.length === 2);
    expect(said(p, 1)).toContain("Свободно 1%");
    expect([...b.st.kernel.sessions.keys()]).toEqual(["disk-full-1@win"]);
  });
});

describe("эталоны incidents: ожидаемые ветки", () => {
  it("339 · сессия инцидента в failed — POST того же ключа: 202, отказ stopped в журнале, новой сессии нет; агент поднял сессию — обращение во вводе", async () => {
    // источник: принятый дизайн — «Сессия инцидента в failed — stopped; roster показывает failed, дальше решает агент»; доставка — слово пользователя 1 нояб.
    const { st, post, disk } = await bench();
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    const p = await until(() => st.holders.procs.get("disk-full-1@win"));
    await until(() => p.inputs.length === 1);
    take(p);
    await until(() => disk().length === 0);
    st.holders.failInitNext = 1;
    p.exit(1, "первый");
    await until(() => st.sdk.of("disk-full-1@win").length === 2 && st.holders.procs.get("disk-full-1@win")?.initializes === 1);
    st.proc("disk-full-1@win").exit(1, "второй");
    await until(() => st.states("disk-full-1@win").at(-1)?.state === "failed");
    const r = await post({ type: "disk-full", key: "C:", text: "Свободно 1%" });
    expect(r.status).toBe(202);
    const why = await until(() => st.journal().find((l) => l.ev === "incident" && l.kind === "refuse" && l.id === r.body.id));
    expect(why.word).toBe("stopped");
    expect([...st.kernel.sessions.keys()]).toEqual(["disk-full-1@win"]);
    expect(disk().map((a) => a.id)).toEqual([r.body.id]);
    expect(await st.relay.request({ type: "session.start", v: 1, callsign: "disk-full-1@win" })).toMatchObject({ ok: true });
    const q = await until(() => st.holders.procs.get("disk-full-1@win"));
    await until(() => q.inputs.length === 1);
    expect(q.inputs[0].uuid).toBe(r.body.id);
  });

  it("340 · папки типа нет — отказ bad_spec; профиля типа нет — no_profile; POST оба 202, сессий нет, причина в журнале, обращения ждут на диске", async () => {
    // источник: принятый дизайн — «Нет папки или профиля типа — причина в журнале; сессии нет»; слово для папки — bad_spec: чьё: код (manage)
    const { st, post, disk } = await bench();
    const refusal = (id: unknown) => until(() => st.journal().find((l) => l.ev === "incident" && l.kind === "refuse" && l.id === id));
    const nodir = await post({ type: "nodir", text: "x" });
    expect(nodir.status).toBe(202);
    expect(await refusal(nodir.body.id)).toMatchObject({ word: "bad_spec" });
    const noprof = await post({ type: "noprof", text: "x" });
    expect(noprof.status).toBe(202);
    expect(await refusal(noprof.body.id)).toMatchObject({ word: "no_profile" });
    expect(String((await refusal(noprof.body.id)).why).split(":")[0]).toBe("noprof");
    expect(st.kernel.sessions.size).toBe(0);
    expect(disk()).toHaveLength(2);
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

  it("342 · штатная остановка с обращением в полёте: POST — 202 до initialize новой сессии; доставку отказал shutting_down, новый POST — соединение отклонено; после перезапуска — во вводе той же сессии без нового POST", async () => {
    // источник: слово пользователя 1 нояб.; устав — «По сигналу: не принимает новое → доводит или отдаёт текущее → сохраняет своё в хранилище»
    const k = new FakeHolders();
    keepers.push(k);
    const { st, post, port, disk } = await bench({ holders: k });
    k.failInitNext = 1;
    const r = await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    expect(r.status).toBe(202);
    // ответ ушёл, а процесс сессии ещё ждёт initialize
    const p = await until(() => k.procs.get("disk-full-1@win"));
    await until(() => p.initializes === 1);
    const down = st.close();
    stands.splice(stands.indexOf(st), 1);
    await new Promise((r) => setTimeout(r, 30));
    await expect(post({ type: "disk-full", key: "D:", text: "Свободно 4%" })).rejects.toThrow();
    // SDK отвечает на initialize
    const w = p as unknown as { failInit: boolean; write: (x: unknown) => void };
    w.failInit = false;
    w.write({ $: "initialized" });
    await down;
    expect(st.exits).toEqual([0]);
    expect(st.journal().find((l) => l.ev === "incident" && l.id === r.body.id)).toMatchObject({ kind: "refuse", word: "shutting_down" });
    expect(disk().map((a) => a.id)).toEqual([r.body.id]);
    expect(p.inputs).toHaveLength(0);
    const again = await bench({ holders: k, home: st.home, port });
    await until(() => p.inputs.length === 1);
    expect(p.inputs[0].uuid).toBe(r.body.id);
    expect([...again.st.kernel.sessions.keys()]).toEqual(["disk-full-1@win"]);
  });

  it("344 · процесс сессии умер, обращение ещё в его вводе — после resume то же обращение во вводе нового процесса, один раз", async () => {
    // источник: слово пользователя 1 нояб.; устав — процесс claude умер — один resume
    const { st, post, disk } = await bench();
    const r = await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    const p = await until(() => st.holders.procs.get("disk-full-1@win"));
    await until(() => p.inputs.length === 1);
    p.exit(1, "упал");
    const q = await until(() => st.holders.procs.get("disk-full-1@win") !== p && st.holders.procs.get("disk-full-1@win"));
    await until(() => q.inputs.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(q.inputs.map((i) => i.uuid)).toEqual([r.body.id]);
    take(q);
    await until(() => disk().length === 0);
  });

  it("345 · ход взял обращение — снято с диска; процесс потом умер — после resume повтора нет", async () => {
    // источник: слово пользователя 1 нояб. — «хотя бы 1 раз»: взятое ходом доставлено
    const { st, post, disk } = await bench();
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    const p = await until(() => st.holders.procs.get("disk-full-1@win"));
    await until(() => p.inputs.length === 1);
    take(p);
    await until(() => disk().length === 0);
    p.exit(1, "упал");
    const q = await until(() => st.holders.procs.get("disk-full-1@win") !== p && st.holders.procs.get("disk-full-1@win"));
    await until(() => st.states("disk-full-1@win").at(-1)?.state === "idle");
    await new Promise((r) => setTimeout(r, 30));
    expect(q.inputs).toHaveLength(0);
  });

  it("346 · сессия удалена, обращение ход ещё не взял — обращение уходит в новую сессию того же типа и ключа", async () => {
    // источник: слово пользователя 1 нояб.; принятый дизайн — «Решено — сессия закрывает себя, следующее обращение откроет новую»
    const { st, post, disk } = await bench();
    await post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    const p = await until(() => st.holders.procs.get("disk-full-1@win"));
    await until(() => p.inputs.length === 1);
    take(p);
    const late = await post({ type: "disk-full", key: "C:", text: "Свободно 1%" });
    await until(() => p.inputs.length === 2);
    expect(await st.relay.request({ type: "session.remove", v: 1, callsign: "disk-full-1@win" })).toMatchObject({ ok: true });
    const fresh = await until(() => [...st.kernel.sessions.keys()].find((c) => c !== "disk-full-1@win" || st.holders.procs.get(c) !== p));
    const q = await until(() => st.holders.procs.get(fresh));
    await until(() => q.inputs.length === 1);
    expect(q.inputs[0].uuid).toBe(late.body.id);
    expect(st.states(fresh).at(-1)?.incident ?? (await until(() => st.states(fresh).at(-1)?.incident))).toEqual({ type: "disk-full", key: "C:" });
    take(q);
    await until(() => disk().length === 0);
  });

  it("347 · перезапуск Host, процесс жив у держателя: ход взял обращение, пока Host не было, — после подключения снято с диска, повтора нет", async () => {
    // источник: слово пользователя 1 нояб.; факт — держатель копит вывод процесса, пока Host нет, и отдаёт его новому Host
    const k = new FakeHolders();
    keepers.push(k);
    const a = await bench({ holders: k });
    await a.post({ type: "disk-full", key: "C:", text: "Свободно 2%" });
    const p = await until(() => k.procs.get("disk-full-1@win"));
    await until(() => p.inputs.length === 1);
    await a.st.close();
    stands.splice(stands.indexOf(a.st), 1);
    expect(a.disk()).toHaveLength(1);
    // держатель заметил, что Host ушёл: вывод процесса копится у него
    await until(() => !p.sock);
    take(p);
    const b = await bench({ holders: k, home: a.st.home, port: a.port });
    await until(() => b.disk().length === 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(p.inputs).toHaveLength(1);
  });
});
