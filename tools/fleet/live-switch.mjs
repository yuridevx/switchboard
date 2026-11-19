// Живая проверка «Свободной смены модели»: одна сессия, один процесс — смена модели на лету обычным запросом session.update, как со страницы.
// node tools/fleet/live-switch.mjs <флот> <устройство> <машина> <key/model> <key/model> [<key/model> …]
// Первая пара — с чем открыть; каждая следующая — смена и ход. Ход печатает число и называет число прошлого хода: так видно, что разговор переехал.
// В конце — смена посреди хода: ход стоит на шаге сценария, пока проверка его не отпустит. Последней строкой — что о сменах записал журнал машины.
// SB2_ENV=prod — прод; KEEP=1 — сессию не убирать.
import { check } from "./harness.mjs";
import { say, tool, turn as script } from "./turn.mjs";

const pairs = process.argv.slice(5);
const doc = (s) => ({ key: s.slice(0, s.indexOf("/")), model: s.slice(s.indexOf("/") + 1) });
const short = (v, n = 90) => String(typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").slice(0, n);
const task = (n) => script(tool("Bash", { command: `echo ${n * 11}` }), say("число: {итог 1}, прошлое число: {прошлый итог}"));

await check(async (t) => {
  if (pairs.length < 2) throw new Error("нужно: <флот> <устройство> <машина> <key/model> <key/model> …");
  let s;
  /** Строка сессии, догнавшая ход: в ней начало его ответа. Кто ответил не той моделью — отказ. */
  const settled = async (want) => {
    const r = await t.wait(`строка сессии с итогом хода «${want}»`, async () => {
      const x = await s.row();
      return String(x?.result ?? "").includes(want) && x;
    });
    if (r.answers) throw new Error(`ответила не та модель: ${r.answers}`);
    return r;
  };

  await t.step(`открыта на ${pairs[0]}`, async () => {
    s = await t.session({ name: "switch", ...doc(pairs[0]), prompt: task(1) });
    if (!s.first.text.includes("11")) throw new Error(`ответ без числа хода: ${short(s.first.text)}`);
    return short(s.first.text);
  });

  for (let i = 1, n = 2; i < pairs.length; i++, n++) await t.step(`${pairs[i - 1]} → ${pairs[i]}`, async () => {
    const u = await t.must("session.update", { to: s.callsign, patch: doc(pairs[i]) });
    const reply = await s.turn(task(n));
    // ход называет своё число и число прошлого хода: разговор переехал на новую модель целиком
    for (const want of [String(n * 11), String((n - 1) * 11)]) if (!reply.text.includes(want)) throw new Error(`в ответе нет числа ${want}: ${short(reply.text)}`);
    const r = await settled(String(n * 11));
    // окно, которое считает живой процесс: должно совпасть с окном каталога
    const w = await t.call("session.call", { to: s.callsign, method: "contextUsage" });
    const cache = r.cache ? ` · кэш ${r.cache.until ? "до " + new Date(r.cache.until).toISOString().slice(11, 16) : "—"}${r.cache.size ? `, ${Math.round((100 * (r.cache.read ?? 0)) / r.cache.size)} % из кэша` : ""}` : "";
    return `${(u.later ?? []).length ? "после хода перезапуск · " : ""}${short(reply.text)}${cache}${w.ok ? ` · окно процесса ${w.result?.maxTokens ?? w.result?.result?.maxTokens ?? "?"}` : ""}`;
  });

  const target = pairs.find((p) => p !== pairs.at(-1));
  await t.step(`посреди хода ${pairs.at(-1)} → ${target}`, async () => {
    // ход стоит на команде, пока проверка его не отпустит: смена приходит именно посреди хода
    const hold = await s.hold(say("итог команды: {итог 1}"));
    await t.must("session.update", { to: s.callsign, patch: doc(target) });
    const reply = await hold.release();
    if (!reply.text.includes("отпущено")) throw new Error(`ход не донёс итог команды: ${short(reply.text)}`);
    await settled("отпущено");
    return `смена принята · ${short(reply.text)}`;
  });

  // что о сменах записал журнал машины — строкой для чтения, не шагом
  const lines = (await t.must("machine.journal", { to: "@" + t.machine, session: s.callsign, limit: 400 })).lines;
  const switches = lines.filter((l) => l.msg === "model_switch");
  const refused = lines.filter((l) => l.msg === "call" && (l.status ?? 200) >= 400);
  console.log(`журнал машины: строк model_switch ${switches.length} (на лету ${switches.filter((l) => l.how === "hot").length}, перезапуском ${switches.filter((l) => l.how === "restart").length}) · перезапусков процесса ${lines.filter((l) => l.msg === "restart").length} · отклонённых вызовов ${refused.length}`);
  for (const l of refused.slice(0, 6)) console.log(`  отказ вызова: ${l.status} ${short(l.why ?? l.text ?? "", 200)}`);
}, { second: "" });
