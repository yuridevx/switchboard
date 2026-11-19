// Живая проверка «Память флота»: node tools/fleet/live-memory.mjs [флот] [устройство] [машина]
// Память проекта — папка memory кусочка профиля. Сессия на модели вне списка пишущих получает отказ записи и файла не оставляет, читает как все;
// сессия на модели из списка пишет; смена модели закрывает запись со следующего вызова; дочерняя берёт кусочки родителя;
// чтение, запись и отказ видны строками следа в журнале машины и в истории флота.
// Модели — аккаунты Claude: SB2_WEAK и SB2_STRONG (по умолчанию claude-haiku-5-5 и claude-opus-5-5). Свои сессии и файлы проверка убирает сама.
import { fleetCall, lacks, machineTmp, newTag } from "./harness.mjs";
import { say, tool, turn as script } from "./turn.mjs";

const [fleet = "test", device = "cli", machine = "devbox"] = process.argv.slice(2);
const { must } = fleetCall(fleet, device);
const tag = newTag();
const cwd = process.env.SB2_CWD ?? `${machineTmp(fleet, device, machine)}/sb2-live-memory`;
const WEAK = process.env.SB2_WEAK ?? "claude-haiku-5-5", STRONG = process.env.SB2_STRONG ?? "claude-opus-5-5";
const t0 = Date.now();

let bad = 0;
const made = [];
async function step(label, fn) {
  const at = Date.now();
  try {
    console.log(`✓ ${label} · ${await fn()} · ${Date.now() - at} мс`);
  } catch (e) {
    bad++;
    console.log(`✗ ${label} · ${String(e.message ?? e).split("\n")[0]}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rowOf = (cs) => must("fleet.list", { machine, full: true }).sessions.find((s) => s.callsign === cs);
async function until(what, fn, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался: ${what}`);
    await sleep(2000);
  }
}
const open = async (name, doc) => {
  const cs = must("session.open", { to: "@" + machine, spec: { name, cwd, key: "claude", ...doc }, mkdir: true }).callsign;
  made.push(cs);
  await until(`${cs} свободна`, () => rowOf(cs)?.state === "idle", 120_000);
  return cs;
};
let turns = 0;
/** Ход по сценарию: последним шагом сессия отвечает меткой хода — по ней видно, что ход взят и кончен; состояние «занята» короткий ход проскакивает. */
async function turn(cs, ...steps) {
  const mark = `ход ${++turns} ${tag}`;
  must("message", { to: cs, text: script(...steps, say(mark)) });
  await until(`${cs} ответила «${mark}»`, () => JSON.stringify(must("session.history", { to: cs, limit: 30 }).events.filter((e) => e.type === "assistant")).includes(mark), 300_000);
  await until(`${cs} свободна`, () => rowOf(cs)?.state === "idle", 60_000);
}
/** Скрипт на машине: что напечатал. */
const onMachine = (code) => String(must("shell.run", { to: "@" + machine, shell: "node", wait: 30, script: `import fs from "node:fs";${code}` }).out).trim();
const exists = (file) => onMachine(`process.stdout.write(String(fs.existsSync(${JSON.stringify(file)})))`) === "true";
/** Строки следа о сессии из журнала машины. */
const trail = (cs) => must("machine.journal", { to: "@" + machine, session: cs, since: t0, limit: 200 }).lines.filter((l) => l.msg === "memory");
const traced = (cs, op) => until(`строка следа «${op}» о ${cs}`, () => trail(cs).find((l) => l.op === op), 30_000);

// кусочек с памятью и его папка на машине: клон называет машина
const listed = must("profile.list", { to: "@" + machine });
const piece = listed.pieces.find((p) => p.ok && (p.has?.memory ?? 0) > 0 && listed.repos?.some((r) => r.repo === p.repo && r.state === "ok" && r.dir));
if (!piece) {
  console.log(`… память флота · ждёт выкладки: на машине ${machine} нет сведённого кусочка с памятью`);
  process.exit(0);
}
const clone = listed.repos.find((r) => r.repo === piece.repo).dir;
const sep = clone.includes("\\") ? "\\" : "/";
const memory = [clone, piece.id.split("/").pop(), "memory"].join(sep);
const record = onMachine(`process.stdout.write(fs.readdirSync(${JSON.stringify(memory)}).find((f) => f.endsWith(".md") && f !== "MEMORY.md") ?? "")`);
const fresh = `${memory}${sep}live-${tag}.md`, second = `${memory}${sep}live-${tag}-2.md`;
const write = (file) => tool("Write", { file_path: file, content: `проверка памяти ${tag}\n` });
let weak = "", strong = "", kid = "";

try {
  await step("модель вне списка пишущих: запись в память кусочка — отказ с причиной, файла нет, строка следа «отказ»", async () => {
    weak = await open("mem-weak-" + tag, { model: WEAK, pieces: [piece.id] });
    await turn(weak, write(fresh));
    if (exists(fresh)) throw new Error(`файл записан: ${fresh}`);
    const line = await traced(weak, "refused");
    if (line.model !== WEAK || line.piece !== piece.id || line.record !== `live-${tag}` || line.level !== "info") throw new Error(`строка следа: ${JSON.stringify(line)}`);
    // причина дошла до модели ответом инструмента
    const told = JSON.stringify(must("session.history", { to: weak, limit: 50 }).events).includes("Память только для чтения");
    if (!told) throw new Error("причины отказа нет в разговоре сессии");
    return `${weak} · ${WEAK} · файлов 0 · причина в разговоре`;
  });

  await step("модель вне списка читает запись памяти — строка следа «чтение»", async () => {
    if (!weak) throw new Error("сессии нет");
    if (!record) throw new Error(`в памяти ${piece.id} нет записей, кроме индекса`);
    await turn(weak, tool("Read", { file_path: `${memory}${sep}${record}` }));
    const line = await traced(weak, "read");
    if (line.record !== record.replace(/\.md$/, "")) throw new Error(`строка следа: ${JSON.stringify(line)}`);
    return `${piece.id} · ${line.record}`;
  });

  await step("модель из списка пишущих пишет запись: файл появился, строка следа «запись»", async () => {
    strong = await open("mem-strong-" + tag, { model: STRONG, pieces: [piece.id] });
    await turn(strong, write(fresh));
    if (!exists(fresh)) throw new Error(`файла нет: ${fresh}`);
    const line = await traced(strong, "write");
    if (line.model !== STRONG || line.record !== `live-${tag}`) throw new Error(`строка следа: ${JSON.stringify(line)}`);
    return `${strong} · ${STRONG} · файлов 1`;
  });

  await step("сессия открывает дочернюю без названных кусочков — у дочерней кусочки родителя", async () => {
    if (!strong) throw new Error("сессии нет");
    const name = "mem-kid-" + tag;
    kid = `${name}@${machine}`;
    made.push(kid);
    await turn(strong, tool("mcp__fleet__session_open", { to: "@" + machine, spec: { name, cwd, key: "claude", model: WEAK } }));
    const row = await until("дочерняя в картине флота", () => rowOf(kid), 60_000);
    if (JSON.stringify(row.spec.pieces) !== JSON.stringify([piece.id]) || row.spec.parent !== strong) throw new Error(`документ дочерней: ${JSON.stringify(row.spec)}`);
    return `${kid} · кусочки ${row.spec.pieces.join(", ")}`;
  });

  await step("смена модели на модель вне списка закрывает запись со следующего вызова", async () => {
    if (!strong) throw new Error("сессии нет");
    const changed = must("session.update", { to: strong, patch: { key: "claude", model: WEAK } });
    await until(`${strong} свободна`, () => rowOf(strong)?.state === "idle", 120_000);
    await turn(strong, write(second));
    if (exists(second)) throw new Error(`файл записан после смены модели: ${second}`);
    const line = await until("строка следа «отказ» после смены", () => trail(strong).find((l) => l.op === "refused" && l.model === WEAK), 30_000);
    return `${STRONG} → ${WEAK} · запись ${line.record}: отказ · с новым процессом: ${changed.later.join(", ") || "ничего"}`;
  });

  // история флота: строки журнала машин в ClickHouse
  if (!lacks("clickhouse")) await step("чтение, запись и отказ — три строки следа в истории флота", async () => {
    const ops = await until("строки memory в истории флота", () => {
      const lines = [weak, strong].filter(Boolean).flatMap((cs) => must("log.query", { msg: "memory", session: cs, since: t0, limit: 50 }).lines);
      const found = new Set(lines.map((l) => (typeof l.data === "string" ? JSON.parse(l.data || "{}") : l.data ?? {}).op));
      return ["read", "write", "refused"].every((op) => found.has(op)) ? found : undefined;
    }, 120_000);
    return `строк ${ops.size} из 3: ${[...ops].join(", ")}`;
  });
} finally {
  // своё убирает сама: файлы проверки из памяти кусочка (сведение унесёт удаление в git) и пробные сессии
  try {
    onMachine(`for (const f of ${JSON.stringify([fresh, second])}) fs.rmSync(f, { force: true })`);
    must("profile.sync", { to: "@" + machine });
  } catch (e) {
    console.log(`уборка файлов: ${String(e.message ?? e).split("\n")[0]}`);
  }
  for (const cs of made.reverse()) {
    try { must("session.remove", { to: cs }); } catch {}
  }
}
process.exit(bad ? 1 : 0);
