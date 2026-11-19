// Живая проверка часов флота: node tools/fleet/live-clock.mjs <флот> <устройство>
// Сверка картины (машина без связи, сессия со сбоем) стоит правилом часов флота: его заводит первое число любой машины.
// Когда сверка шла последний раз, говорит сводка здоровья. Проверка читает этот момент, молчит дольше срока правила и читает снова:
// момент ушёл вперёд — будильник сработал сам, без запросов.
import { setTimeout as sleep } from "node:timers/promises";
import { fleetCall } from "./harness.mjs";

const [fleet = "test", device = "cli"] = process.argv.slice(2);
const { call } = fleetCall(fleet, device);
/** Срок правила сверки картины: раз в минуту. */
const EVERY_MS = 60_000;
const watched = () => {
  const r = call("obs.health", {});
  if (!r.ok) throw new Error(`obs.health: ${r.error} ${r.why ?? ""}`);
  return r.result.watched;
};

const steps = [];
const say = (ok, label, note = "") => steps.push(`${ok ? "✓" : "✗"} ${label}${note ? ` · ${note}` : ""}`);
try {
  // машины шлют числа раз в минуту: правило появляется не позже чем через минуту после выкладки, первая сверка — ещё через минуту
  let was = watched();
  for (let i = 0; i < 26 && !was; i++) {
    await sleep(5000);
    was = watched();
  }
  say(!!was, "сверка картины идёт по часам флота", was ? `последняя — ${Math.round((Date.now() - was) / 1000)} с назад` : "сверки не было: ни одна машина не прислала чисел");
  if (was) {
    // до следующего срока и ещё пять секунд — ни одного запроса этой проверки
    await sleep(Math.max(0, was + EVERY_MS - Date.now()) + 5000);
    const now = watched();
    say(now > was, "срок пришёл без запроса: сверка прошла снова", `момент сверки ушёл вперёд на ${Math.round((now - was) / 1000)} с`);
  }
} catch (e) {
  say(false, "проверка оборвалась", String(e.message).split("\n")[0]);
}
for (const s of steps) console.log(s);
process.exit(steps.some((s) => s.startsWith("✗")) ? 1 : 0);
