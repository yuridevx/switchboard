// Ждёт новый комментарий прототипа: печатает его одной строкой JSON и выходит. Нового нет за предел — код 2.
//   node scripts/proto/watch.mjs <папка дизайна> [минут, по умолчанию 30]
import fs from "node:fs";
import path from "node:path";

const [dir, minutes = "30"] = process.argv.slice(2);
if (!dir) {
  console.error("нужно: <папка дизайна> [минут]");
  process.exit(1);
}
const file = path.join(path.resolve(dir), "comments.json");
const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; } };
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
