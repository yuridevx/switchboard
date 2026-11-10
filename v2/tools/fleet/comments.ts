// Сторож комментариев к странице: node tools/fleet/comments.ts <флот> <устройство> [часов ожидания, по умолчанию 6]
// Ждёт в журнале флота пачку (событие comments — кнопка «Передать Claude» на странице), печатает её и выходит.
// Что уже прочитано, помнит в ~/.switchboard-dev/v2-<флот>-comments.at: следующий запуск ждёт только новое.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { httpTransport, newId } from "@sb/protocol";

const dir = path.join(os.homedir(), ".switchboard-dev");
const env = Object.fromEntries(fs.readFileSync(path.join(dir, "v2-fleet.env"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const [fleet, device, hours = "6"] = process.argv.slice(2);
if (!fleet || !device) throw new Error("нужно: <флот> <устройство> [часов]");
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const wire = httpTransport({ base: env.SB2_BASE!, key });
const mark = path.join(dir, `v2-${fleet}-comments.at`);
const after = fs.existsSync(mark) ? Number(fs.readFileSync(mark, "utf8")) : 0;
const until = Date.now() + Number(hours) * 3_600_000;

type Note = { text: string; where: { hash: string; selector: string; element: string; w: number; h: number; theme: string; agent: string } };
type Event = { at: number; who: string; data?: { comments?: Note[] } };

while (Date.now() < until) {
  const reply = await wire.call({ type: "ledger.read", id: newId("r"), trace: newId("t"), what: "comments", after, limit: 50 });
  // сеть моргнула — этот такт пропущен, следующий через 5 с; любой другой отказ — выход с причиной
  if (!reply.ok && reply.error === "offline") {
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  if (!reply.ok) throw new Error(`ledger.read: ${reply.error} ${reply.why ?? ""}`);
  const events = (reply.result as { events: Event[] }).events;
  if (events.length) {
    for (const e of events) {
      console.log(`\n=== пачка ${new Date(e.at).toISOString()} от ${e.who} ===`);
      (e.data?.comments ?? []).forEach((n, i) => {
        console.log(`\n${i + 1}. ${n.text}\n   экран: ${n.where.hash || "#"} · ${n.where.w}×${n.where.h} · ${n.where.theme}\n   элемент: ${n.where.element.slice(0, 160)}\n   селектор: ${n.where.selector}\n   браузер: ${n.where.agent}`);
      });
    }
    fs.writeFileSync(mark, String(events.at(-1)!.at));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.log("комментариев не было");
