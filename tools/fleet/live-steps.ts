// Живые сценарии флота поверх своих тестовых сессий: node tools/fleet/live-steps.ts <флот> <устройство> <машина> [вторая машина]
// Скрипт на машине, вопрос сессии и ответ (режим ask), остановка и старт, показ отката, пара, правило прокси, точка в архив и поиск по переписке,
// числа Host в наблюдении, кусочки с другой машины. Сессии открываются на ключе флота (SB2_KEY) и убираются обвязкой.
// Части (SB2_PART): one — шаги на своей машине; far — шаги, которым нужна вторая машина (идут в одной очереди с перезапуском её Host).
import { PROXY_RULES } from "@sb/protocol";
import { check, lacks } from "./harness.mjs";
import { say, tool, turn as script } from "./turn.mjs";

type Ev = { type: string; uuid?: string; message?: { content?: unknown } };

await check(async (t: any) => {
  const stepOne = t.only("one"), stepFar = t.only("far");
  const machine: string = t.machine, second: string = t.second, tag: string = t.tag;

  /* Скрипт на машине */
  for (const m of [machine, second].filter(Boolean)) {
    await t.step(`скрипт на машине ${m}`, async () => {
      const info = await t.must("shell.info", { to: "@" + m });
      // оболочка — та, что у машины по умолчанию; запуск дольше ответа обвязка дожидается: исход не зависит от скорости машины
      const r = await t.shell(m, { script: "echo sb2-" + tag });
      if (r.state !== "done" || !(r.out ?? r.stdout ?? "").includes("sb2-" + tag)) throw new Error(`состояние ${r.state}, вывод: ${(r.out ?? "").slice(0, 80)}`);
      return `${info.os}, вывод получен`;
    });
  }

  /* Вопрос сессии и ответ: режим ask — запись файла ждёт разрешения человека */
  let asker: any, askTo: string | undefined;
  await stepOne("вопрос сессии: разрешение в строке, ответ человека, ход продолжается", async () => {
    asker = await t.session({ name: "ask", mode: "ask" });
    const u = await asker.send(script(tool("Write", { file_path: `${asker.cwd}/ask-${tag}.txt`, content: "ok" }), say("записан")));
    const row = await t.wait("вопрос в строке сессии", async () => {
      const r = await asker.row();
      return r?.ask ? r : undefined;
    });
    const ask = row.ask;
    askTo = ask.to;
    await t.must("answer", { to: asker.callsign, ask: ask.id, answer: "allow" });
    // модель может спросить ещё раз (вторая команда того же хода): каждому новому вопросу — тот же ответ
    let asked = 1, last = ask.id;
    await t.wait("вопрос снят и ход закончен", async () => {
      const r = await asker.row();
      if (r?.ask && r.ask.id !== last) {
        last = r.ask.id;
        asked++;
        await t.must("answer", { to: asker.callsign, ask: last, answer: "allow" });
      }
      return r && !r.ask && r.state === "idle";
    });
    await asker.ended(u);
    return `вид ${ask.kind}, инструмент ${ask.tool ?? "—"}${ask.to ? ", адресат " + ask.to : ""}, вопросов ${asked}`;
  });
  await stepOne("вопрос назван по адресату: в строке — кому он задан", async () => {
    if (!askTo) throw new Error("в вопросе сессии нет адресата (ask.to)");
    return `адресат ${askTo}`;
  });

  /* Остановка и старт */
  await stepOne("остановка и старт: разговор возобновляется", async () => {
    await t.must("session.stop", { to: asker.callsign });
    // картина увидела остановку — значит, «свободна» после запуска уже новая, а не прежняя
    await t.wait("сессия остановлена", async () => (await asker.row())?.state === "stopped");
    await t.must("session.start", { to: asker.callsign });
    await asker.idle();
    const events = await asker.history();
    if (!events.length) throw new Error("после старта история пуста");
    return `событий в истории ${events.length}`;
  });

  /* Откат файлов */
  await stepOne("откат к сообщению: показ без отката — сколько записей и файлов уйдёт", async () => {
    const first = ((await asker.history()) as Ev[]).find((e) => e.type === "user" && typeof e.message?.content === "string" && e.uuid);
    if (!first?.uuid) throw new Error("нет сообщения человека с uuid");
    const r = await t.must("session.rewind", { to: asker.callsign, upto: first.uuid, files: true, dry: true });
    return `уйдёт записей ${r.cut}, файлов ${r.files?.length ?? 0}`;
  });

  /* Пара */
  await stepOne("пара: ведомый открыт вместе с ведущим, в строке ведомого — ведущий; снятие пары", async () => {
    const lead = await t.session({ name: "lead" });
    const r = await t.must("session.update", { to: lead.callsign, patch: {}, pair: true });
    if (!r.wing) throw new Error("ведомый не назван в ответе");
    const wing = t.own(r.wing, lead.cwd);
    // ведущий встаёт в строку ведомого не тем же кадром, что сама строка: ждём строку с ведущим, а не первую попавшуюся
    let seen = "строки ведомого нет";
    await t.wait("строка ведомого с ведущим", async () => {
      const row = await wing.row();
      seen = row ? `у ведомого ведущий ${row.lead}` : "строки ведомого нет";
      return row?.lead === lead.callsign;
    }, () => seen);
    await t.must("session.update", { to: lead.callsign, patch: { wing: null } });
    await t.wait("ведомый убран", async () => !(await wing.row()));
    return `${lead.callsign} ▸ ${wing.callsign}`;
  });

  /* Правило прокси: текст запроса к модели правится по правилу флота */
  await stepOne("правило прокси: слово в запросе к модели заменено по правилу флота", async () => {
    const rules = ((await t.must("prefs.get", { scope: "fleet", prefix: PROXY_RULES })).values[PROXY_RULES] ?? []) as unknown[];
    const mark = "SB2MARK" + tag.toUpperCase(), word = "заменено-" + tag;
    // правила флота — общее: прежний список возвращает уборка, чем бы шаг ни кончился
    t.defer(`правило прокси live-${tag}`, (go: any) => go("prefs.set", { scope: "fleet", name: PROXY_RULES, value: rules }));
    await t.must("prefs.set", { scope: "fleet", name: PROXY_RULES, value: [...rules, { name: "live-" + tag, scopes: ["user"], kind: "literal", unit: "match", action: "replace", pattern: mark, replacement: word }] });
    await t.wait("машина прочла правило", async () => (await t.must("rules.test", { to: "@" + machine, text: mark })).after === word);
    // сессии сказано повторить метку; модель видит запрос после правила — и повторяет уже замену
    const s = await t.session({ name: "rule", prompt: script(say("слово: " + mark)) });
    const said: string = s.first.text;
    if (!said.includes(word) || said.includes(mark)) throw new Error("ответ модели: " + said.slice(0, 120));
    return `${mark} → ${said.slice(0, 40)}`;
  });

  /* Точка после остановки и поиск по переписке */
  let archived: { sid: string; word: string } | undefined;
  // точка и поиск: блоки разговора идут в хранилище по подписанным ссылкам
  if (!lacks("r2")) await stepOne("точка после остановки: остановленная сессия сохранена в архив, сбоя точки в строке нет", async () => {
    const word = "маяк" + tag;
    const s = await t.session({ name: "point", backup: true, prompt: script(say(word)) });
    await t.must("session.stop", { to: s.callsign });
    await t.wait("сессия остановлена", async () => (await s.row())?.state === "stopped");
    const saved = await t.wait("сессия в архиве", async () => (await t.must("points.list", { machine })).sessions.find((x: { callsign: string; points: number }) => x.callsign === s.callsign && x.points > 0));
    // точки сессии в архиве — своё: убираются вместе с остальным
    t.defer(`точки сессии ${s.callsign}`, (go: any) => go("points.delete", { sid: saved.sid }));
    const row = await s.row();
    if (row?.archiveError) throw new Error("точка не сохранилась: " + row.archiveError);
    archived = { sid: saved.sid, word };
    return `точек ${saved.points}`;
  });
  if (!lacks("r2")) await stepOne("поиск по слову называет запись разговора и точку, с которой она в архиве", async () => {
    const { sid, word } = archived!;
    const r = await t.wait("сессия найдена поиском", async () => (await t.must("points.list", { q: word })).sessions.find((x: { sid: string }) => x.sid === sid));
    if (!r.hitUuid) throw new Error("поиск не назвал запись разговора (hitUuid)");
    if (!r.hitPoint) throw new Error("запись названа, точка — нет");
    if (!r.hit?.includes(word)) throw new Error("строка вокруг слова без самого слова: " + r.hit);
    return `запись ${r.hitUuid.slice(0, 8)}, точка ${r.hitPoint}, строка «${r.hit}»`;
  });

  /* Числа Host в наблюдении */
  await stepOne("числа Host: машина отвечает на запрос, служба наблюдения несёт её последнее окно", async () => {
    const now = await t.must("machine.metrics", { to: "@" + machine });
    // первое окно машина шлёт службе наблюдения через период после своего старта: ждём само окно, а не время
    const mine = await t.wait("окно машины в сводке наблюдения", async () => (await t.must("obs.health", {})).hosts?.find((x: { machine: string }) => x.machine === machine));
    return `сессий ${(Object.values(now.sessions) as number[]).reduce((a, b) => a + b, 0)}, очередь ${now.queue}; в сводке — окно от ${new Date(mine.at).toISOString().slice(11, 19)}`;
  });

  /* Кусочки: правка пришла с другой машины — работающая сессия перечитывает скилы */
  // репозиторий кусочков машины берут с GitHub
  if (second && !lacks("github")) {
    await stepFar("кусочки обновились на другой машине — работающая сессия видит новый скил", async () => {
      const far = (await t.must("profile.list", { to: "@" + second })).repos?.find((r: { state: string; dir?: string }) => r.state === "ok" && r.dir);
      const piece = (await t.must("profile.list", { to: "@" + machine })).pieces.find((p: { ok: boolean; repo: string; has?: { skill?: number } }) => p.ok && far && p.repo === far.repo && (p.has?.skill ?? 0) > 0);
      if (!far || !piece) throw new Error("на машинах нет общего сведённого репозитория кусочков со скилами");
      const folder = piece.id.split("/").pop();
      const s = await t.session({ name: "skills", pieces: [piece.id] });
      const skill = "live-" + tag;
      const names = async () => JSON.stringify(await t.must("session.call", { to: s.callsign, method: "commands" }));
      if ((await names()).includes(skill)) throw new Error("скил уже есть до правки");
      const dir = JSON.stringify(far.dir + "/" + folder + "/skills/" + skill);
      // репозиторий кусочков — общее: скил убирает уборка, чем бы шаг ни кончился, и обе машины сводятся заново
      t.defer(`скил ${skill} в репозитории кусочков`, async (go: any) => {
        await go("shell.run", { to: "@" + second, shell: "node", wait: 30, script: `import fs from "node:fs";fs.rmSync(${dir},{recursive:true,force:true})` });
        await go("profile.sync", { to: "@" + second });
        return go("profile.sync", { to: "@" + machine });
      });
      await t.node(second, `const d=${dir};fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+"/SKILL.md","---\\nname: ${skill}\\ndescription: живая проверка перечитывания\\n---\\nтекст\\n")`);
      await t.must("profile.sync", { to: "@" + second });
      await t.must("profile.sync", { to: "@" + machine });
      await t.wait("скил виден сессии", async () => (await names()).includes(skill));
      return `${piece.id}: скил ${skill} появился`;
    });
  }
});
