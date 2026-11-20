// Эталоны дизайна «Связь сессий и знание о флоте»: открытая задача, проект сессии, разрешения сессии, открытой сессией.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { make as chat } from "../src/modules/chat/chat.ts";
import { make as shell } from "../src/modules/shell/shell.ts";
import { FakeHolders, stand, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
afterEach(async () => {
  await st?.stop();
  st = undefined;
});

const PULT = "pult~yuri@example.com";
const BOSS = "boss@laptop", KID = "kid@laptop", GRAND = "grand@laptop";
const got = (s: Stand, cs: string) => s.proc(cs).inputs.map((i) => String(i.message.content));
const results = (s: Stand, cs: string, from: string) => got(s, cs).filter((t) => t.startsWith(`<fleet from="${from}" kind="result">`)).map((t) => t.split("\n")[1]);
const BG = { type: "system", subtype: "task_started", task_id: "b1", description: "проверка", is_backgrounded: true };
const BG_DONE = { type: "system", subtype: "task_notification", task_id: "b1", status: "completed" };

/** Родитель boss и его дочь kid с задачей во вводе. */
async function family(o: Parameters<typeof stand>[0] = {}): Promise<Stand> {
  const s = await stand({ modules: [chat()], ...o });
  await s.open("boss");
  await s.request("session.open", { to: "@laptop", spec: { name: "kid", cwd: s.dir }, prompt: "проверь трафик" }, BOSS);
  await until(() => s.proc(KID).inputs.length === 1, "задача у дочери");
  return s;
}

describe("итог хода: открытая задача", () => {
  // чьё: факт описи — последний написавший отменял отчёт родителю
  it("посреди хода дочери ей написал человек — итог хода ушёл родителю", async () => {
    st = await family();
    await st.request("message", { to: KID, text: "и логи посмотри" }, PULT);
    await st.turn(KID, [], "трафик чист, логи тоже");
    await until(() => results(st!, BOSS, KID).length === 1, "итог у родителя");
    expect(results(st, BOSS, KID)).toEqual(["трафик чист, логи тоже"]);
  });

  // чьё: слово пользователя 15 нояб. — «тот ответил в чат, а менеджер всё ждёт»; факт прода — итог 20:33 остался в чате дочери
  it("дочь взяла задачу, запустила фон и ответила; человек написал ей «ну»; фон кончился, дочь ответила — оба итога у родителя, после второго задача сдана", async () => {
    st = await family();
    await st.turn(KID, [BG], "запустила проверку в фоне, жду");
    await until(() => results(st!, BOSS, KID).length === 1, "первый итог");
    await st.request("message", { to: KID, text: "ну" }, PULT);
    await st.turn(KID, [BG_DONE], "Итог проверки: спуф в 3 из 88 пакетов");
    await until(() => results(st!, BOSS, KID).length === 2, "второй итог");
    expect(results(st, BOSS, KID)).toEqual(["запустила проверку в фоне, жду", "Итог проверки: спуф в 3 из 88 пакетов"]);
    // чьё: факт прода — 62 таких хода в выборке; гейт — обмен, без которого поток работает
    await st.request("message", { to: KID, text: "спасибо, а что по логам?" }, PULT);
    await st.turn(KID, [], "в логах пусто");
    // итог родителю решается в конце хода и встаёт в его ввод в том же шаге: метка ввода пришла — итога нет
    await st.settle(BOSS);
    expect(results(st, BOSS, KID)).toHaveLength(2);
  });

  // чьё: факт прода — 44 таких хода в выборке, родителю дочь написала сама 1 раз; факт описи — вести сбивали отчёт
  it("дочь открыла свою дочь и ответила «жду»; пришёл итог её дочери, она ответила — оба итога у родителя", async () => {
    st = await family();
    await st.request("session.open", { to: "@laptop", spec: { name: "grand", cwd: st.dir }, prompt: "собери срез" }, KID);
    await until(() => st!.proc(GRAND).inputs.length === 1, "задача у внучки");
    await st.turn(KID, [], "открыла внучку, жду");
    await until(() => results(st!, BOSS, KID).length === 1, "первый итог");
    await st.turn(GRAND, [], "срез собран");
    await until(() => results(st!, KID, GRAND).length === 1, "итог внучки у дочери");
    await st.turn(KID, [], "срез собран, трафик чист");
    await until(() => results(st!, BOSS, KID).length === 2, "второй итог");
    expect(results(st, BOSS, KID)).toEqual(["открыла внучку, жду", "срез собран, трафик чист"]);
  });

  // чьё: устав — после перезапуска модуль поднимает своё из хранилища; код — процесс сессии переживает подмену вместе с вводом
  it("машину подменили, пока задача ждала у процесса, — итог хода ушёл родителю; сообщение второй раз не пришло", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
    const holders = new FakeHolders();
    const first = await family({ home, holders });
    const kid = first.proc(KID);
    await first.kernel.shutdown("подмена");
    st = await stand({ home, holders, modules: [chat()] });
    await until(() => st!.kernel.sessions.get(KID)?.state === "idle" && st!.kernel.sessions.get(BOSS)?.state === "idle", "attach");
    expect(st.proc(KID)).toBe(kid);
    await st.turn(KID, [], "трафик чист");
    await until(() => results(st!, BOSS, KID).length === 1, "итог у родителя");
    expect(kid.inputs).toHaveLength(1);
  });

  // чьё: факт живой проверки 16 нояб. — ход кончился, пока Host останавливался, итог отвергнут словом shutting_down; устав — штатная остановка сохраняет своё в хранилище
  it("ход дочери кончился, пока Host останавливался, — итог сохранён и уходит родителю после запуска нового Host", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb2-host-"));
    const holders = new FakeHolders();
    let release = () => {};
    // остановка Host длится, пока модуль не отпустит: окно, в котором кончается ход
    const slow = { name: "slow-stop", stop: () => new Promise<void>((r) => (release = r)) };
    const first = await family({ home, holders, modules: [chat(), slow] });
    const kid = first.proc(KID);
    kid.send({ type: "system", subtype: "session_state_changed", state: "running", session_id: "s" });
    await until(() => first.kernel.sessions.get(KID)!.state === "busy", "дочь занята");
    const down = first.kernel.shutdown("подмена");
    kid.send({ type: "result", subtype: "success", result: "трафик чист", session_id: "s", user_message_uuids: [kid.inputs[0]!.uuid] });
    kid.send({ type: "system", subtype: "session_state_changed", state: "idle", session_id: "s" });
    await until(() => first.journal().find((l) => l.msg === "report_kept"), "итог сохранён");
    expect(results(first, BOSS, KID)).toEqual([]);
    release();
    await down;
    st = await stand({ home, holders, modules: [chat()] });
    await until(() => results(st!, BOSS, KID).length === 1, "итог у родителя после запуска");
    expect(results(st, BOSS, KID)).toEqual(["трафик чист"]);
    await st.settle(BOSS);
    expect(results(st, BOSS, KID)).toHaveLength(1);
  });

  // чьё: код — так отвечает любое сообщение остановленной сессии; факт прода — 26 таких отказов за два часа
  it("дочь закончила, родитель остановлен — отказ stopped и строка журнала с причиной; итог остался в строке дочери", async () => {
    st = await family();
    await st.request("session.stop", { to: BOSS }, PULT);
    await st.turn(KID, [], "трафик чист");
    const line = await until(() => st!.journal().find((l) => l.msg === "report" && l.level === "warn"), "строка журнала");
    expect(line).toMatchObject({ callsign: KID, to: BOSS, word: "stopped" });
    expect(st.link.rows(KID).at(-1)!.row).toMatchObject({ result: "трафик чист" });
  });

  // чьё: решение дизайна — конец запуска, которого сессия не дождалась, приходит вестью: событие со своей работой
  it("запуск на машине кончился без ожидания — хозяйке приходит весть видом news, и ход по ней сдаёт итог родителю", async () => {
    st = await family({ modules: [chat(), shell()] });
    await st.turn(KID, [], "запустила скрипт, жду");
    await until(() => results(st!, BOSS, KID).length === 1, "первый итог");
    const run = await st.request("shell.run", { to: "@laptop", script: "console.log(1)", shell: "node" }, KID);
    expect(run.ok).toBe(true);
    const news = await until(() => got(st!, KID).find((t) => t.startsWith('<fleet from="@laptop" kind="news">')), "весть о конце запуска");
    expect(news).toContain("кончился");
    await st.turn(KID, [], "скрипт вернул 1");
    await until(() => results(st!, BOSS, KID).length === 2, "второй итог");
  });
});

describe("проект сессии", () => {
  const PROJECTS = { people: [], projects: [{ id: "pmwhtprlq", name: "p1-phoenix", members: [] }, { id: "q7k2", name: "site", members: [] }] };

  // чьё: слово пользователя 15 нояб. — «ллм просто фантазировали проект»
  it("session.open с проектом, которого у флота нет, — отказ no_project со списком «номер — имя»; сессия не открыта; с номером — открыта", async () => {
    st = await stand({ modules: [chat()] });
    st.services.handlers["people.list"] = () => PROJECTS;
    const bad = await st.request("session.open", { to: "@laptop", spec: { name: "a", cwd: st.dir, project: "phoenix" } }, PULT);
    expect(bad).toMatchObject({ ok: false, error: "no_project" });
    expect(bad.why).toContain("pmwhtprlq — p1-phoenix");
    expect(st.kernel.sessions.has("a@laptop")).toBe(false);
    // имя проекта — не номер: у одного понятия одно имя
    expect(await st.request("session.open", { to: "@laptop", spec: { name: "a", cwd: st.dir, project: "p1-phoenix" } }, PULT)).toMatchObject({ ok: false, error: "no_project" });
    expect((await st.request("session.open", { to: "@laptop", spec: { name: "a", cwd: st.dir, project: "pmwhtprlq" } }, PULT)).ok).toBe(true);
    expect((await st.request("session.update", { to: "a@laptop", patch: { project: "нет" } }, PULT))).toMatchObject({ ok: false, error: "no_project" });
  });

  // чьё: код — так же отказывает сверка модели с каталогом; устав — запрос не прошёл: отказ словом
  it("флот на список проектов не ответил — отказ словом; сессия не открыта", async () => {
    st = await stand({ modules: [chat()] });
    st.services.handlers["people.list"] = () => { throw Object.assign(new Error("нет связи"), { word: "offline", why: "службы не ответили" }); };
    expect(await st.request("session.open", { to: "@laptop", spec: { name: "a", cwd: st.dir, project: "pmwhtprlq" } }, PULT)).toMatchObject({ ok: false, error: "offline" });
    expect(st.kernel.sessions.has("a@laptop")).toBe(false);
  });

  // чьё: слово пользователя 16 нояб. — «да» на проект родителя; повод — выдуманные проекты
  it("сессия открывает дочь и проект не называет — дочь в проекте родителя; человек без проекта открывает без проекта", async () => {
    st = await stand({ modules: [chat()] });
    st.services.handlers["people.list"] = () => PROJECTS;
    await st.open("boss", { project: "pmwhtprlq" });
    await st.request("session.open", { to: "@laptop", spec: { name: "kid", cwd: st.dir } }, BOSS);
    expect(st.kernel.sessions.get(KID)!.rec.spec.project).toBe("pmwhtprlq");
    await st.request("session.open", { to: "@laptop", spec: { name: "solo", cwd: st.dir } }, PULT);
    expect(st.kernel.sessions.get("solo@laptop")!.rec.spec.project).toBeUndefined();
    // родитель на другой машине — проект из его документа: полная строка картины флота
    st.services.handlers["fleet.list"] = (f) => ({ machines: [], people: [], sessions: (f as { machine?: string }).machine === "server" ? [{ callsign: "lead@server", state: "idle", spec: { name: "lead", cwd: "~", project: "q7k2" }, by: PULT, since: 1 }] : [] });
    await st.request("session.open", { to: "@laptop", spec: { name: "far", cwd: st.dir } }, "lead@server");
    expect(st.kernel.sessions.get("far@laptop")!.rec.spec).toMatchObject({ project: "q7k2", parent: "lead@server" });
  });
});

describe("разрешение сессии, открытой сессией", () => {
  // чьё: устав — вопросы человеку наружу; факт описи — такой вопрос не уходил никому
  it("дочь в режиме «спрашивать» просит разрешение — вопрос у владельца машины, родителю — весть «ждёт человека»", async () => {
    st = await stand({ modules: [chat()] });
    st.services.handlers["fleet.list"] = () => ({ machines: [{ name: "laptop", owner: "~yuri@example.com", online: true, since: 1 }], sessions: [], people: [] });
    await st.open("boss");
    await st.request("session.open", { to: "@laptop", spec: { name: "kid", cwd: st.dir, mode: "ask" }, prompt: "выложи" }, BOSS);
    await until(() => st!.kernel.sessions.get(KID)?.state === "idle", "дочь готова");
    void st.proc(KID).ask("Bash", { command: "git push origin main" }, "toolu_p1");
    const sent = await until(() => st!.services.of("reach.send")[0], "зов человека");
    expect(sent).toMatchObject({ to: "~yuri@example.com", kind: "ask", ask: "toolu_p1", callsign: KID });
    const news = await until(() => got(st!, BOSS).find((t) => t.startsWith(`<fleet from="${KID}" kind="news">`)), "весть родителю");
    expect(news).toContain("Ждёт ответа человека: разрешение");
    expect(st.link.rows(KID).at(-1)!.row).toMatchObject({ ask: { id: "toolu_p1", to: "~yuri@example.com" } });
    // сессия такое решить не может — только человек
    expect(await st.request("answer", { to: KID, ask: "toolu_p1", answer: "allow" }, BOSS)).toMatchObject({ ok: false, error: "not_client" });
  });
});
