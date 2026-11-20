// Живая проверка «Память флота»: node tools/fleet/live-memory.mjs [флот] [устройство] [машина]
// Память проекта — папка memory кусочка профиля. Сессия на модели вне списка пишущих получает отказ записи и файла не оставляет, читает как все;
// сессия на модели из списка пишет; смена модели закрывает запись со следующего вызова; дочерняя берёт кусочки родителя;
// чтение, запись и отказ видны строками следа в журнале машины и в истории флота.
// Модели — аккаунты Claude: SB2_WEAK и SB2_STRONG (по умолчанию claude-haiku-5-5 и claude-opus-5-5). Свои сессии и файлы памяти убирает обвязка.
import { check } from "./harness.mjs";
import { say, tool, turn as script } from "./turn.mjs";

const WEAK = process.env.SB2_WEAK ?? "claude-haiku-5-5", STRONG = process.env.SB2_STRONG ?? "claude-opus-5-5";

await check(async (t) => {
  const machine = "@" + t.machine;
  // кусочек с памятью и его папка на машине: клон называет машина
  const listed = await t.must("profile.list", { to: machine });
  const piece = listed.pieces.find((p) => p.ok && (p.has?.memory ?? 0) > 0 && listed.repos?.some((r) => r.repo === p.repo && r.state === "ok" && r.dir));
  if (!piece) throw new Error(`на машине ${t.machine} нет сведённого кусочка с памятью`);
  const clone = listed.repos.find((r) => r.repo === piece.repo).dir;
  const sep = clone.includes("\\") ? "\\" : "/";
  const memory = [clone, piece.id.split("/").pop(), "memory"].join(sep);
  const record = await t.node(t.machine, `process.stdout.write(fs.readdirSync(${JSON.stringify(memory)}).find((f) => f.endsWith(".md") && f !== "MEMORY.md") ?? "")`);
  const fresh = `${memory}${sep}live-${t.tag}.md`, second = `${memory}${sep}live-${t.tag}-2.md`;
  // файлы проверки — в общей памяти кусочка: убрать при любом исходе, сведение унесёт удаление в git
  t.defer("файлы проверки в памяти кусочка", async (go) => {
    const r = await go("shell.run", { to: machine, shell: "node", wait: 30, script: `import fs from "node:fs";for (const f of ${JSON.stringify([fresh, second])}) fs.rmSync(f, { force: true })` });
    return r.ok ? go("profile.sync", { to: machine }) : r;
  });
  const write = (file) => tool("Write", { file_path: file, content: `проверка памяти ${t.tag}\n` });
  const exists = async (file) => (await t.node(t.machine, `process.stdout.write(String(fs.existsSync(${JSON.stringify(file)})))`)) === "true";
  /** Строка следа о своей сессии в журнале машины: машина пишет её при вызове инструмента — до итога хода. */
  const traced = (s, op, model) => t.wait(`строка следа «${op}» о ${s.callsign}`, async () =>
    (await t.must("machine.journal", { to: machine, session: s.callsign, limit: 200 })).lines.find((l) => l.msg === "memory" && l.op === op && (!model || l.model === model)));
  const open = (name, model) => t.session({ name, key: "claude", model, pieces: [piece.id] });
  let weak, strong;

  await t.step("модель вне списка пишущих: запись в память кусочка — отказ с причиной, файла нет, строка следа «отказ»", async () => {
    weak = await open("mem-weak", WEAK);
    const reply = await weak.turn(script(write(fresh), say("готово")));
    if (await exists(fresh)) throw new Error(`файл записан: ${fresh}`);
    const line = await traced(weak, "refused");
    if (line.model !== WEAK || line.piece !== piece.id || line.record !== `live-${t.tag}` || line.level !== "info") throw new Error(`строка следа: ${JSON.stringify(line)}`);
    // причина дошла до модели ответом инструмента
    if (!JSON.stringify(reply.events).includes("Память только для чтения")) throw new Error("причины отказа нет в разговоре сессии");
    return `${weak.callsign} · ${WEAK} · файлов 0 · причина в разговоре`;
  });

  await t.step("модель вне списка читает запись памяти — строка следа «чтение»", async () => {
    if (!record) throw new Error(`в памяти ${piece.id} нет записей, кроме индекса`);
    await weak.turn(script(tool("Read", { file_path: `${memory}${sep}${record}` }), say("готово")));
    const line = await traced(weak, "read");
    if (line.record !== record.replace(/\.md$/, "")) throw new Error(`строка следа: ${JSON.stringify(line)}`);
    return `${piece.id} · ${line.record}`;
  });

  await t.step("модель из списка пишущих пишет запись: файл появился, строка следа «запись»", async () => {
    strong = await open("mem-strong", STRONG);
    await strong.turn(script(write(fresh), say("готово")));
    if (!(await exists(fresh))) throw new Error(`файла нет: ${fresh}`);
    const line = await traced(strong, "write");
    if (line.model !== STRONG || line.record !== `live-${t.tag}`) throw new Error(`строка следа: ${JSON.stringify(line)}`);
    return `${strong.callsign} · ${STRONG} · файлов 1`;
  });

  await t.step("сессия открывает дочернюю без названных кусочков — у дочерней кусочки родителя", async () => {
    const name = `mem-kid-${t.tag}`;
    // дочь открывает своя сессия, а не проверка: своя — с уборкой обвязки
    const kid = t.own(`${name}@${t.machine}`, strong.cwd);
    await strong.turn(script(tool("mcp__fleet__session_open", { to: machine, spec: { name, cwd: strong.cwd, key: "claude", model: WEAK } }), say("готово")));
    const row = await t.wait("дочерняя в картине флота", () => kid.row());
    if (JSON.stringify(row.spec.pieces) !== JSON.stringify([piece.id]) || row.spec.parent !== strong.callsign) throw new Error(`документ дочерней: ${JSON.stringify(row.spec)}`);
    return `${kid.callsign} · кусочки ${row.spec.pieces.join(", ")}`;
  });

  await t.step("смена модели на модель вне списка закрывает запись со следующего вызова", async () => {
    const changed = await t.must("session.update", { to: strong.callsign, patch: { key: "claude", model: WEAK } });
    // картина флота догоняет ответ запроса не сразу: ход — когда в документе сессии встала новая модель
    await t.wait(`модель ${WEAK} в документе ${strong.callsign}`, async () => (await strong.row())?.spec.model === WEAK);
    await strong.turn(script(write(second), say("готово")));
    if (await exists(second)) throw new Error(`файл записан после смены модели: ${second}`);
    const line = await traced(strong, "refused", WEAK);
    return `${STRONG} → ${WEAK} · запись ${line.record}: отказ · с новым процессом: ${changed.later.join(", ") || "ничего"}`;
  });

  // история флота: строки журнала машин в ClickHouse
  if (!t.lacks("clickhouse")) await t.step("чтение, запись и отказ — три строки следа в истории флота", async () => {
    let found = new Set();
    await t.wait("строки memory в истории флота", async () => {
      const lines = [];
      for (const s of [weak, strong]) lines.push(...(await t.must("log.query", { msg: "memory", session: s.callsign, limit: 50 })).lines);
      found = new Set(lines.map((l) => (typeof l.data === "string" ? JSON.parse(l.data || "{}") : l.data ?? {}).op));
      return ["read", "write", "refused"].every((op) => found.has(op));
    }, () => `есть: ${[...found].join(", ") || "ничего"}`);
    return `строк ${found.size} из 3: ${[...found].join(", ")}`;
  });
});
