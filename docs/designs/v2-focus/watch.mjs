// Ждёт пачку комментариев к прототипу: node docs/designs/v2-focus/watch.mjs [часов=6] — печатает новые пачки и выходит.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = path.join(os.homedir(), ".switchboard-dev", "v2-focus-comments.jsonl");
const mark = file + ".at";
const after = fs.existsSync(mark) ? Number(fs.readFileSync(mark, "utf8")) : 0;
const until = Date.now() + Number(process.argv[2] ?? 6) * 3_600_000;
while (Date.now() < until) {
  const fresh = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.at > after) : [];
  if (fresh.length) {
    for (const e of fresh) {
      console.log(`\n=== пачка ${new Date(e.at).toISOString()} ===`);
      (e.data?.comments ?? []).forEach((n, i) => console.log(`\n${i + 1}. ${n.text}\n   экран: ${n.where.hash || "#"} · ${n.where.w}×${n.where.h} · ${n.where.theme}\n   элемент: ${String(n.where.element).slice(0, 160)}\n   селектор: ${n.where.selector}`));
    }
    fs.writeFileSync(mark, String(fresh.at(-1).at));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log("комментариев не было");
