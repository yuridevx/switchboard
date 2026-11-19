// Живая проверка часов флота: node tools/fleet/live-clock.mjs <флот> <устройство>
// Сверка картины (машина без связи, сессия со сбоем) стоит правилом часов obs.watch: его заводит первое число любой машины.
// Проверка читает срок правила, молчит до его прихода и читает снова: срок ушёл вперёд — будильник сработал сам, без запросов.
import { setTimeout as sleep } from "node:timers/promises";
import { fleetCall } from "./harness.mjs";

const [fleet = "test", device = "cli"] = process.argv.slice(2);
const { call } = fleetCall(fleet, device);
const watch = () => {
  const r = call("clock.list", { prefix: "obs." });
  if (!r.ok) throw new Error(`clock.list: ${r.error} ${r.why ?? ""}`);
  return r.result.timers.find((t) => t.id === "obs.watch");
};

const steps = [];
const say = (ok, label, note = "") => steps.push(`${ok ? "✓" : "✗"} ${label}${note ? ` · ${note}` : ""}`);
try {
  // машины шлют числа раз в минуту: правило появляется не позже чем через минуту после выкладки
  let was = watch();
  for (let i = 0; i < 14 && !was; i++) {
    await sleep(5000);
    was = watch();
  }
  say(!!was, "правило сверки картины стоит на часах флота", was ? `каждые ${was.every / 1000} с` : "правила obs.watch нет: ни одна машина не прислала чисел");
  if (was) {
    // до срока и ещё пять секунд — ни одного запроса этой проверки
    await sleep(Math.max(0, was.at - Date.now()) + 5000);
    const now = watch();
    say(!!now && now.at > was.at, "срок пришёл без запроса: правило сработало и встало на следующий срок", now ? `срок ушёл вперёд на ${Math.round((now.at - was.at) / 1000)} с` : "правило пропало");
  }
} catch (e) {
  say(false, "проверка оборвалась", String(e.message).split("\n")[0]);
}
for (const s of steps) console.log(s);
process.exit(steps.some((s) => s.startsWith("✗")) ? 1 : 0);
