// Журнал шагов живого списка: одна строка журнала общей формы (protocol/src/log.ts) на каждый шаг проверки.
// Список (live.mjs) пишет строки в файл SB2_STEPS, работа CI сохраняет его при прогоне;
// по этим файлам разбор истории (tools/test/history.mjs) считает красные работы и плавающие шаги.
import fs from "node:fs";

/** Название шага — до первого « · »; у шага с шириной экрана («1440 · …») ширина входит в название. */
export function labelOf(body) {
  const first = body.indexOf(" · ");
  if (first < 0) return body.trim();
  const cut = /^\d{3,4} · /.test(body) ? body.indexOf(" · ", first + 3) : first;
  return (cut < 0 ? body : body.slice(0, cut)).trim();
}

/** Строки журнала одной проверки по её выводу: строка на шаг ✓ или ✗.
 *  status — код выхода процесса проверки (null — снята по пределу); tail — последние слова её ошибки.
 *  ctx: t — время записи, мс; place — где шла («коробка linux», «флот test»); commit и run — коммит и прогон CI;
 *  bare — журнал прогона открыт всем (прод): причина отказа в строку не идёт. */
export function stepLines(title, stdout, status, tail, ctx) {
  const base = { t: ctx.t, part: "check", module: title, place: ctx.place, ...(ctx.commit ? { commit: ctx.commit } : {}), ...(ctx.run ? { run: ctx.run } : {}) };
  const lines = [];
  for (const raw of stdout.split("\n")) {
    const l = raw.trimEnd();
    // те же строки, что считает итог списка: отметка — первый знак строки
    if (l[0] !== "✓" && l[0] !== "✗") continue;
    const ok = l[0] === "✓";
    const body = l.slice(1).trimStart();
    const msg = labelOf(body);
    const ms = / · (\d+) мс$/.exec(body);
    const why = body.slice(msg.length).replace(/^[\s·:]+/, "").slice(0, 300);
    lines.push({ ...base, level: ok ? "info" : "error", msg, ok, ...(ms ? { ms: Number(ms[1]) } : {}), ...(!ok && why && !ctx.bare ? { why } : {}) });
  }
  // проверка упала мимо шагов — ошибка до первого шага, ошибка страницы, предел: красная строка о ней самой
  if (status !== 0 && lines.every((l) => l.ok)) {
    const why = status === null ? "предел проверки вышел" : (tail ?? "").slice(0, 300);
    lines.push({ ...base, level: "error", msg: "проверка дошла до конца", ok: false, ...(why && !ctx.bare ? { why } : {}) });
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
