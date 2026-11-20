// Журнал шагов живого списка: одна строка журнала общей формы (protocol/src/log.ts) на каждый шаг проверки.
// Проверка (вход check, harness.mjs) пишет свои строки в файл, который ей называет список (live.mjs); список ставит на них место и прогон
// и дописывает в файл SB2_STEPS прогона, работа CI сохраняет его при прогоне;
// по этим файлам разбор истории (tools/test/history.mjs) считает красные работы и плавающие шаги.
import fs from "node:fs";

/** Строки шагов одной проверки — в журнал прогона: к каждой место, коммит и прогон.
 *  status — код выхода процесса проверки (null — снята по пределу); tail — последние слова её ошибки.
 *  ctx: t — время записи, мс; place — где шла («коробка linux», «флот test»); commit и run — коммит и прогон CI;
 *  bare — журнал прогона открыт всем (прод): причина отказа в строку не идёт. */
export function stamp(title, steps, status, tail, ctx) {
  const where = { place: ctx.place, ...(ctx.commit ? { commit: ctx.commit } : {}), ...(ctx.run ? { run: ctx.run } : {}) };
  const lines = steps.map(({ why, ...l }) => ({ ...l, ...where, ...(why && !ctx.bare ? { why } : {}) }));
  // проверка упала мимо шагов — ошибка до первого шага, ошибка страницы, предел: красная строка о ней самой
  if (status !== 0 && lines.every((l) => l.ok)) {
    const why = status === null ? "предел проверки вышел" : (tail ?? "").slice(0, 300);
    lines.push({ t: ctx.t, part: "check", module: title, ...where, level: "error", msg: "проверка дошла до конца", ok: false, ...(why && !ctx.bare ? { why } : {}) });
  }
  return lines;
}

/** Дописать строки в файл журнала шагов. */
export function appendSteps(file, lines) {
  if (lines.length) fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** Строки из файла журнала шагов; чужая строка (не JSON) пропускается. */
export function readSteps(text) {
  const out = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // не строка журнала
    }
  }
  return out;
}
