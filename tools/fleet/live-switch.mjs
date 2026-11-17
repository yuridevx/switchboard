// Живая проверка «Свободной смены модели»: одна сессия, один процесс — смена модели на лету обычным запросом session.update, как со страницы.
// node tools/fleet/live-switch.mjs <флот> <устройство> <машина> <key/model> <key/model> [<key/model> …]
// Первая пара — с чем открыть; каждая следующая — смена и ход. Ход печатает число и называет число прошлого хода: так видно, что разговор переехал.
// В конце — смена посреди хода и итог: переходов без отказа, перезапусков процесса, строк журнала о смене.
// SB2_ENV=prod — прод; KEEP=1 — сессию не убирать.
import { fleetCall, machineTmp } from "./harness.mjs";

const [fleet = "test", device = "cli", machine = "devbox", ...pairs] = process.argv.slice(2);
if (pairs.length < 2) throw new Error("нужно: <флот> <устройство> <машина> <key/model> <key/model> …");
const { call, must } = fleetCall(fleet, device);
const tag = Date.now().toString(36).slice(-4);
const cs = `switch-${tag}@${machine}`;
const cwd = process.env.SB2_CWD ?? `${machineTmp(fleet, device, machine)}/sb2-switch-${tag}`;
const doc = (s) => { const i = s.indexOf("/"); return { key: s.slice(0, i), model: s.slice(i + 1) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const row = () => must("fleet.list", { machine, full: true }).sessions.find((s) => s.callsign === cs);
const short = (v, n = 160) => String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, n);
const task = (n) => `Выполни в Bash команду \`echo ${n * 11}\` и ответь одной строкой: «число: M, прошлое число: K» (K — число из прошлого хода; не было — «нет»).`;
const journal = (since) => must("machine.journal", { to: "@" + machine, session: cs, since, limit: 400 }).lines;
let bad = 0, total = 0;
const step = (ok, label, said) => { total++; if (!ok) bad++; console.log(`${ok ? "✓" : "✗"} ${label} · ${said}`); };

/** Ждём конец хода: сессия свободна и итог новый. want — слово, которое должен нести итог этого хода: строка сессии догоняет ход не сразу. */
async function turn(since, want, ms = 300_000) {
  const end = Date.now() + ms;
  for (;;) {
    await sleep(2500);
    const r = row();
    if (!r) return { result: "", error: "сессии нет" };
    if (r.state === "failed" || r.state === "stopped") return r;
    if (r.state === "idle" && (r.last ?? 0) > since && (r.result || r.error) && (!want || String(r.result).includes(want) || Date.now() > end - ms + 90_000)) return r;
    if (Date.now() > end) return { ...r, result: "", error: `не дождался: ${r.state}` };
  }
}

const t0 = Date.now();
const opened = call("session.open", { to: "@" + machine, spec: { name: `switch-${tag}`, cwd, ...doc(pairs[0]) }, mkdir: true, prompt: task(1) });
if (!opened.ok) throw new Error(`session.open: ${opened.error} ${opened.why ?? ""}`);
let n = 1, missed = false;
{
  const r = await turn(t0);
  step(!r.error && String(r.result).includes("11"), `открыта на ${pairs[0]}`, short(r.result || r.error));
}
for (let i = 1; i < pairs.length; i++) {
  const t = Date.now();
  const u = call("session.update", { to: cs, patch: doc(pairs[i]) });
  const ms = Date.now() - t;
  if (!u.ok) { step(false, `${pairs[i - 1]} → ${pairs[i]}`, `смена ОТКАЗ ${u.error} ${short(u.why ?? "")}`); missed = true; continue; }
  n++;
  call("message", { to: cs, text: task(n) });
  const r = await turn(t, String(n * 11));
  // после неудавшегося шага прошлое число у модели старее — тогда сверяется только нынешнее
  const ok = !r.error && String(r.result).includes(String(n * 11)) && (missed || String(r.result).includes(String((n - 1) * 11)));
  missed = !ok;
  step(ok, `${pairs[i - 1]} → ${pairs[i]}`, `смена ${ms} мс${(u.result.later ?? []).length ? " · после хода перезапуск" : ""} · ${short(r.result || r.error, 90)}${r.answers ? " · ОТВЕТИЛА НЕ ТА: " + r.answers : ""}${r.cache ? ` · кэш ${r.cache.until ? "до " + new Date(r.cache.until).toTimeString().slice(0, 5) : r.cache.size ? Math.round(((r.cache.read ?? 0) / r.cache.size) * 100) + " % из кэша" : "?"}` : " · кэша в строке нет"}`);
  // окно, которое считает живой процесс: должно совпасть с окном каталога
  const w = call("session.call", { to: cs, method: "contextUsage" });
  if (w.ok) console.log(`    окно процесса ${w.result?.maxTokens ?? w.result?.result?.maxTokens ?? "?"}`);
}
// смена посреди хода: команда ждёт 30 с, через 8 с — смена на другую пару из названных
{
  const target = pairs.find((p) => p !== pairs.at(-1));
  const t = Date.now();
  call("message", { to: cs, text: "Выполни в Bash ровно эту команду: `node -e \"setTimeout(()=>console.log(4242),30000)\"`. Потом ответь одной строкой: «число: …»." });
  await sleep(8000);
  const u = call("session.update", { to: cs, patch: doc(target) });
  const r = await turn(t, "4242");
  step(u.ok && !r.error && String(r.result).includes("4242") && !r.answers, `посреди хода ${pairs.at(-1)} → ${target}`, `${u.ok ? "смена принята" : "смена ОТКАЗ " + u.error + " " + short(u.why ?? "")} · ${short(r.result || r.error, 90)}${r.answers ? " · ОТВЕТИЛА НЕ ТА: " + r.answers : ""}`);
}
const lines = journal(t0);
const switches = lines.filter((l) => l.msg === "model_switch");
const restarts = lines.filter((l) => l.msg === "restart").length;
const refused = lines.filter((l) => l.msg === "call" && (l.status ?? 200) >= 400);
console.log(`\nИТОГ: ${total - bad} из ${total} шагов · строк model_switch ${switches.length} (на лету ${switches.filter((l) => l.how === "hot").length}, перезапуском ${switches.filter((l) => l.how === "restart").length}) · перезапусков процесса ${restarts} · отклонённых вызовов модели ${refused.length}`);
for (const l of refused.slice(0, 6)) console.log(`  отказ вызова: ${l.status} ${short(l.why ?? l.text ?? "", 200)}`);
if (!process.env.KEEP) call("session.remove", { to: cs });
else console.log("сессия оставлена:", cs);
process.exit(bad ? 1 : 0);
