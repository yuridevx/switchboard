// Живая проверка отката разговора: node tools/fleet/live-rewind.ts [флот] [устройство] [машина]
// Одна сессия на ключе флота: три хода правят файл; откат «разговор и файлы» дважды подряд, затем «только разговор», показ, очистка;
// пара: ведущая читает историю ведомого, сжимает и откатывает его инструментами и получает вести; разговоры папки.
// Части (SB2_PART): rewind — откат и очистка одной сессии; pair — ведущая и ведомый.
import { check } from "./harness.mjs";
import { say, tool, turn as script } from "./turn.mjs";

type Ev = { type: string; subtype?: string; uuid?: string; text?: string; message?: { content?: unknown }; peer?: { from: string; kind: string; text: string } };

await check(async (t: any) => {
  const stepRewind = t.only("rewind"), stepPair = t.only("pair");
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  /** Сообщения человека в разговоре: без входящих от флота. */
  const humans = async (s: any) => ((await s.history()) as Ev[]).filter((e) => e.type === "user" && typeof e.message?.content === "string" && !String(e.message.content).startsWith("<"));
  /** Разговор очищен: в истории след сброса и ни одного ответа модели. Очистка идёт вводом сессии — ответ на запрос приходит раньше неё. */
  const cleared = (s: any) => t.wait(`разговор ${s.callsign} очищен`, async () => {
    const ev = (await s.history()) as Ev[];
    return ev.some((e) => e.type === "conversation_reset") && !ev.some((e) => e.type === "assistant");
  });

  /* Откат и очистка одной сессии */
  let s: any, u1 = "", u2 = "", u3 = "";
  /** Ход с записью файла; ответ — номер своего сообщения: к нему потом идёт откат. */
  const write = async (content: string, word: string): Promise<string> => {
    const u = await s.send(script(tool("Write", { file_path: `${s.cwd}/note.txt`, content }), say("записано: " + word)));
    await s.ended(u);
    return u;
  };

  await stepRewind("сессия на ключе флота: три хода правят один файл", async () => {
    s = await t.session({ name: "rw" });
    u1 = await write("один\n", "одна строка");
    u2 = await write("один\nдва\n", "две строки");
    u3 = await write("один\nдва\nтри\n", "три строки");
    const text = await s.file("note.txt");
    if (!/три/.test(text)) throw new Error("файл после трёх ходов: " + JSON.stringify(text));
    return `людских сообщений ${(await humans(s)).length}, файл: ${flat(text)}`;
  });

  await stepRewind("показ: записи и файлы до отката, ничего не тронуто", async () => {
    const before = (await s.history()).length;
    const r = await t.must("session.rewind", { to: s.callsign, upto: u3, files: true, dry: true });
    if (r.nofiles) throw new Error("снимка файлов нет: " + r.nofiles);
    if (!r.cut || !r.files?.length || r.text === undefined) throw new Error("показ: " + JSON.stringify(r));
    if ((await s.history()).length !== before || !/три/.test(await s.file("note.txt"))) throw new Error("показ тронул разговор или файл");
    return `уйдёт записей ${r.cut}, файлов ${r.files.length}, текст «${r.text.slice(0, 30)}…»`;
  });

  // откат отвечает после дела: файлы возвращены, сессия поднята на обрезанном разговоре, след отката в истории
  await stepRewind("откат «разговор и файлы» к третьему сообщению: файл вернулся, лента обрезана, сессия та же", async () => {
    const before = (await humans(s)).length;
    const r = await t.must("session.rewind", { to: s.callsign, upto: u3, files: true });
    const text = await s.file("note.txt");
    if (/три/.test(text) || !/два/.test(text)) throw new Error("файл не вернулся: " + JSON.stringify(text));
    const after = await humans(s);
    if (after.length !== before - 1 || after.some((e) => e.uuid === u3)) throw new Error(`в разговоре людских сообщений ${after.length}, было ${before}`);
    if (!((await s.history()) as Ev[]).some((e) => e.type === "conversation_reset" && /Откат к/.test(e.text ?? ""))) throw new Error("следа отката в истории нет");
    await t.wait("сессия с тем же позывным свободна", async () => (await s.row())?.state === "idle");
    return `ушло ${r.cut}, файл: ${flat(text)}, людских сообщений ${before} → ${after.length}`;
  });

  await stepRewind("второй откат подряд с файлами — к более раннему сообщению: файл вернулся 2 раза из 2", async () => {
    const r = await t.must("session.rewind", { to: s.callsign, upto: u2, files: true });
    const text = await s.file("note.txt");
    if (/два|три/.test(text) || !/один/.test(text)) throw new Error("файл не вернулся: " + JSON.stringify(text));
    const after = await humans(s);
    if (after.length !== 1) throw new Error(`людских сообщений ${after.length}, ждали 1`);
    return `ушло ${r.cut}, файл: ${flat(text)}`;
  });

  await stepRewind("обрезка переживает остановку и запуск сессии до первого нового хода", async () => {
    await t.must("session.stop", { to: s.callsign });
    // картина увидела остановку — значит, «свободна» после запуска уже новая, а не прежняя
    await t.wait("сессия остановлена", async () => (await s.row())?.state === "stopped");
    await t.must("session.start", { to: s.callsign });
    await s.idle();
    const n = (await humans(s)).length;
    if (n !== 1) throw new Error(`после перезапуска людских сообщений ${n}, ждали 1`);
    return "людских сообщений 1";
  });

  await stepRewind("сессия после отката помнит оставшееся и не помнит ушедшее", async () => {
    // в разговоре после отката остался один вызов Write из трёх: модель считает их по тому разговору, который получила
    const reply = await s.turn(script(say("вызовов Write в разговоре: {вызовов Write}")));
    if (!/разговоре: 1(?!\d)/.test(reply.text.toLowerCase())) throw new Error("ответ: " + reply.text.slice(0, 160));
    return "вызовов Write в разговоре: 1";
  });

  await stepRewind("откат «только разговор»: файл на диске прежний", async () => {
    const u = await write("четыре\n", "четыре");
    if (!/четыре/.test(await s.file("note.txt"))) throw new Error("ход не записал файл");
    const r = await t.must("session.rewind", { to: s.callsign, upto: u });
    if (!/четыре/.test(await s.file("note.txt"))) throw new Error("файл изменился при откате без файлов");
    if ((await humans(s)).some((e) => e.uuid === u)) throw new Error("сообщение осталось в разговоре");
    return `ушло ${r.cut}, файл прежний`;
  });

  await stepRewind("сообщения с таким номером нет — отказ not_found, сессия работает", async () => {
    const r = await t.call("session.rewind", { to: s.callsign, upto: "00000000-0000-4000-8000-000000000000" });
    if (r.ok || r.error !== "not_found") throw new Error("ответ: " + (r.ok ? "ok" : r.error));
    await s.idle();
    return "idle";
  });

  await stepRewind("разговоры папки: разговор сессии в списке и помечен её позывным", async () => {
    const r = await t.must("machine.conversations", { to: "@" + s.machine, cwd: s.cwd });
    const mine = r.conversations.find((c: { live?: string }) => c.live === s.callsign);
    if (!mine) throw new Error("разговора сессии нет в списке: " + JSON.stringify(r.conversations.map((c: { title: string; live?: string }) => [c.title.slice(0, 20), c.live])));
    return `разговоров ${r.conversations.length}, первая реплика «${mine.title.slice(0, 40)}»`;
  });

  await stepRewind("очистка: история пуста, сессия та же", async () => {
    await t.must("session.rewind", { to: s.callsign });
    await cleared(s);
    if ((await humans(s)).length) throw new Error("в очищенном разговоре остались сообщения человека");
    await s.idle();
    return `записей ${(await s.history()).length}`;
  });

  /* Пара */
  let lead: any, wing: any;
  /** Входящие ведущей от ведомого: вид и текст, по порядку прихода. */
  const fromWing = async () => ((await lead.history()) as Ev[]).filter((e) => e.peer?.from === wing.callsign).map((e) => e.peer!);
  /** Вести ведущей о ведомом. */
  const news = async () => (await fromWing()).filter((p) => p.kind === "news").map((p) => p.text);
  /** Ведущая даёт ведомому задачу ответить словом; итог хода ведомого приходит ей входящим вида result — и она на него ответила. */
  const exchange = async (word: string, ...then: unknown[]) => {
    await lead.turn(script(tool("mcp__fleet__message", { to: wing.callsign, text: script(say(word)) }), say("жду итога"), ...then));
    await t.wait(`ведущая приняла итог ведомого «${word}»`, async () => {
      const ev = (await lead.history()) as Ev[];
      const at = ev.findIndex((e) => e.peer?.from === wing.callsign && e.peer.kind === "result" && e.peer.text.includes(word));
      return at >= 0 && ev.slice(at + 1).some((e) => e.type === "result");
    });
  };

  await stepPair("пара: ведущая сжимает и откатывает ведомого инструментами и получает вести", async () => {
    lead = await t.session({ name: "rwlead", pair: true });
    wing = lead.wing;
    await exchange("готов", say("принято", "придёт итог ведомого"));
    await lead.turn(script(tool("mcp__fleet__session_history", { to: wing.callsign }), tool("mcp__fleet__session_call", { to: wing.callsign, method: "compact" }), tool("mcp__fleet__session_rewind", { to: wing.callsign }), say("ведомый прочитан, сжат и очищен")));
    await cleared(wing);
    // барьер вместо паузы: следующий итог ведомого идёт ведущей той же дорогой, что и вести, — весть об очистке, будь она, пришла бы раньше него
    const mark = "барьер-" + t.tag;
    await exchange(mark);
    const got = await fromWing();
    // ведущая сама сжала и очистила ведомого: ответ инструмента она уже получила, вестей об этом нет
    if (got.some((p) => p.kind === "news")) throw new Error("ведущей пришла весть о том, что она сделала сама: " + got.find((p) => p.kind === "news")!.text.slice(0, 80));
    return `от ведомого у ведущей: ${got.map((p) => p.kind).join(", ")}`;
  });

  await stepPair("пара: ведомого очистил человек — ведущей пришла весть; сжатие ведомого вести не даёт", async () => {
    // почти пустой разговор Claude не сжимает: сначала ведомый набирает разговор
    for (let i = 1; i <= 2; i++) await wing.turn(script(say(`часть ${i}: ` + "велосипед едет, пока крутятся колёса, цепь тянет звезду, а руль держит путь; ".repeat(25))));
    const before = (await news()).length;
    await t.must("session.call", { to: wing.callsign, method: "compact" });
    // сжатие идёт вводом сессии: его конец — граница сжатия в разговоре ведомого
    await t.wait("граница сжатия в разговоре ведомого", async () => ((await wing.history()) as Ev[]).some((e) => e.subtype === "compact_boundary"));
    await wing.idle();
    // очистка человеком весть даёт — она же барьер: весть о сжатии, будь она, пришла бы ведущей раньше вести об очистке
    await t.must("session.rewind", { to: wing.callsign });
    const got: string[] = await t.wait("весть «очищен» у ведущей", async () => {
      const n = await news();
      return n.slice(before).some((x) => x.includes("очищен")) ? n : undefined;
    });
    const extra = got.slice(before).filter((x) => !x.includes("очищен"));
    if (extra.length) throw new Error("сжатие ведомого дало ведущей весть: " + extra[0]!.slice(0, 80));
    await cleared(wing);
    return `вестей ${got.length - before}: ${got.at(-1)!.slice(0, 60)}`;
  });

  await stepPair("пара: ведомый ждёт разрешения человека — ведущей пришла весть «ждёт ответа человека»", async () => {
    await t.must("session.update", { to: wing.callsign, patch: { mode: "ask" } });
    await t.wait("режим «спрашивать» в строке ведомого", async () => (await wing.row())?.spec?.mode === "ask");
    const asks = async () => (await news()).filter((x) => x.includes("Ждёт ответа человека")).length;
    const before = await asks();
    // задачу даёт человек: вопрос идёт человеку, а не ведущей
    const u = await wing.send(script(tool("Write", { file_path: `${wing.cwd}/ask-${t.tag}.txt`, content: "ok" }), say("записан")));
    const row = await t.wait("вопрос у ведомого", async () => {
      const r = await wing.row();
      return r?.ask ? r : undefined;
    });
    await t.wait("весть «ждёт ответа человека» у ведущей", async () => (await asks()) > before);
    await t.must("answer", { to: wing.callsign, ask: row.ask.id, answer: { action: "allow" } });
    await wing.ended(u);
    await t.must("session.update", { to: wing.callsign, patch: { mode: "all" } });
    return "весть пришла, вопрос отвечен";
  });

  await stepPair("метод вне закрытого списка от сессии — отказ; от человека — проходит", async () => {
    const r = await t.call("session.call", { to: wing.callsign, method: "permissionRules" });
    if (!r.ok) throw new Error("человеку отказано: " + r.error);
    return "человеку — ok (отказ сессии закреплён тестом Host)";
  });
});
