// Ждёт новый комментарий дизайна — к блоку страницы или к элементу прототипа: печатает каждый новый одной строкой JSON и выходит.
// Нового нет за предел — код 2.
//   node scripts/design/watch.mjs <папка дизайна> [минут, по умолчанию 360]
import fs from "node:fs";
import path from "node:path";

const [dir, minutes = "360"] = process.argv.slice(2);
if (!dir) {
  console.error("нужно: node scripts/design/watch.mjs <папка дизайна> [минут]");
  process.exit(1);
}
const file = path.join(path.resolve(dir), "notes.json");
const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).comments : []);
const seen = new Set(read().map((c) => c.id));
const until = Date.now() + Number(minutes) * 60_000;
const timer = setInterval(() => {
  const fresh = read().filter((c) => !seen.has(c.id));
  if (fresh.length) {
    for (const c of fresh) console.log(JSON.stringify(c));
    process.exit(0);
  }
  if (Date.now() > until) {
    console.error(`нового комментария нет за ${minutes} мин`);
    clearInterval(timer);
    process.exit(2);
  }
}, 1000);
