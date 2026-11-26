// Живая проверка очереди поста во флоте в коробке: node tools/fleet/live-queue.ts [флот] [устройство]
// Определение второго проекта коробки лежит в папке кусочка её репозитория (tools/box/queue.mjs): пост на две сессии, пост на одну, вход с адресом.
// 1. Очередь: три тикета посту на две сессии — два идут сразу, третий ждёт; первый вердикт освобождает сессию — третий берёт она.
// 2. Отсрочка: тикет, отложенный при создании, заметка не будит — будит resume; сессия заводит вопрос, усыпляет свой тикет и берёт
//    следующий; итог вопроса ложится заметкой в спящий тикет, не будя его; resume возвращает его той же сессии.
// 3. Заметки: событие входа ложится заметкой в тикет в работе; «сдал» сессии, которая заметки не видела, не закрывает тикет; ход кончился
//    без вердикта — сессии приходит напоминание; повторный «сдал» принят.
// 4. Ожидание тикета: сессия усыпляет свой тикет до итога тикета другого поста и берёт следующий; итог будит спящий — он идёт той же сессии.
// 5. Срочный впереди: у занятого поста срочный тикет идёт раньше старших.
// 6. Уборка сессии: определение без второй сессии поста останавливает её; её тикет в работе возвращается в очередь и уходит первой.
// Шаги сессий — сценарии хода (tools/fleet/turn.mjs). Проверка ждёт состояние тикета, а не время: что сессия занята, держит её же шаг без вердикта.
import { REPO } from "../box/github.mjs";
import { DESK, FOLDER, GATE, PAIR, PAIR_SIZE, PROJECT } from "../box/queue.mjs";
import { check } from "./harness.mjs";
import { say, tool, turn } from "./turn.mjs";

type Note = { at: number; verdict?: string; by: string; text: string };
type Ticket = { id: string; state: string; why?: string; to?: string; session?: string; parent?: string; after?: string[]; first?: boolean; start?: number; on?: string; text?: string; since: number; notes?: Note[] };
type Reply = { ok: boolean; error?: string; result?: any };
type Go = (type: string, fields: unknown) => Promise<Reply>;

const SET = "mcp__fleet__ticket_set", NEW = "mcp__fleet__ticket_new";
/** Шаги сессии: сдать тикет — свой ({id} — его номер) или названный. */
const done = (note: string, ticket = "{id}") => turn(tool(SET, { ticket, verdict: "done", note }), say("шаг сдан"));
/** Шаги сессии: ответить и кончить ход — шаг остаётся у неё, сессия занята. */
const hold = (word: string) => turn(say(word));
/** Текст тикета без сценария: шаги придут заметкой — текст повторяется при каждой выдаче, заметка — нет. */
const LATER = "Живая проверка: шаги придут заметками.";

await check(async (t) => {
  const { tag } = t;
  const one = async (id: string): Promise<Ticket> => (await t.must("ticket.list", { ticket: id })).tickets[0];
  const all = async (): Promise<Ticket[]> => (await t.must("ticket.list", { project: PROJECT })).tickets;
  const factory = async () => (await t.must("factory.get", { project: PROJECT })).factory;
  const verdict = (x: Ticket) => x.notes!.find((n) => n.verdict === "done");
  /** Тикет проверки: при любом её исходе снимается; закрытый снимать нечего. Ответ — его номер. */
  const tickets: string[] = [];
  const mine = (id: string) => {
    if (tickets.includes(id)) return id;
    tickets.push(id);
    t.defer(`тикет ${id}`, async (go: Go) => {
      const r = await go("ticket.set", { ticket: id, drop: true, note: "живая проверка кончена" });
      return r.error === "bad_state" ? undefined : r;
    });
    return id;
  };
  const make = async (to: string, title: string, fields: Record<string, unknown>) => mine((await t.must("ticket.new", { project: PROJECT, to, title: `${title} ${tag}`, ...fields })).id);
  const human = (ticket: string, note = "сдан человеком") => t.must("ticket.set", { ticket, verdict: "done", note });
  /** Сессии постов открывает фабрика, а не запрос open: они свои — уборка обвязки. Картина называет их по позывному. */
  const owned = new Set<string>();
  const adopt = () => {
    for (const [cs, row] of Object.entries(t.picture.sessions) as [string, { cwd: string }][])
      if (!owned.has(cs) && [PAIR + "@", PAIR + "-2@", DESK + "@"].some((p) => cs.startsWith(p))) (owned.add(cs), t.own(cs, row.cwd));
  };
  /** Тикет дошёл до нужного состояния; встал — отказ сразу, ждать нечего. */
  const reach = (id: string, what: string, ok: (x: Ticket) => boolean): Promise<Ticket> => {
    let last: Ticket | undefined;
    return t.wait(what, async () => {
      adopt();
      const x = (last = await one(id));
      if (x.state === "stop") throw new Error(`${what}: тикет ${id} встал${x.why ? `: ${x.why}` : ""}`);
      return ok(x) && x;
    }, () => (last ? `тикет ${last.state}${last.session ? ` у ${last.session}` : ""}` : "тикета нет"));
  };
  const busy = (id: string) => reach(id, `тикет ${id} в работе`, (x) => x.state === "work" && !!x.session);

  let desk = "", machine = "";
  await t.step("определение проекта применено из папки кусочка: пост на две сессии и пост на одну", async () => {
    const r = await t.must("factory.apply", { project: PROJECT, repo: `${REPO}/${FOLDER}` });
    const f = await factory();
    if (f.commit !== r.commit || r.posts !== 2 || f.def.posts[PAIR]?.size !== PAIR_SIZE || r.failed.length || r.closed.length) throw new Error(`применено не то: ${JSON.stringify({ posts: r.posts, pair: f.def.posts[PAIR], failed: r.failed, closed: r.closed })}`);
    machine = f.def.posts[DESK].at.slice(1);
    desk = `${DESK}@${machine}`;
    // прошлый прогон мог оставить фабрику на паузе
    await t.must("factory.pause", { project: PROJECT, on: false });
    return `коммит ${r.commit.slice(0, 7)}: постов ${r.posts}, «${PAIR}» на ${f.def.posts[PAIR].size} сессии; открыто сессий ${r.opened.length}`;
  });

  await t.step("очередь поста на две сессии: три тикета — два идут сразу, третий ждёт; первый вердикт — третий берёт освободившаяся сессия", async () => {
    const p1 = await make(PAIR, "Очередь поста · 1", { text: hold("занята") }), p2 = await make(PAIR, "Очередь поста · 2", { text: hold("занята") });
    const [a, b] = await Promise.all([p1, p2].map(busy));
    if (a!.session === b!.session || ![a!.session, b!.session].every((s) => s!.startsWith(PAIR))) throw new Error(`два тикета ведут не две сессии поста: ${a!.session}, ${b!.session}`);
    // обе сессии держат шаг — третьему тикету взяться некому
    const p3 = await make(PAIR, "Очередь поста · 3", { text: done("третий сдан") });
    const queued = await one(p3);
    if (queued.state !== "ready") throw new Error(`третий тикет при двух занятых сессиях — ${queued.state}`);
    await human(p1);
    const third = await reach(p3, "третий тикет сдан", (x) => x.state === "done");
    if (verdict(third)?.by !== a!.session) throw new Error(`третий тикет сдала ${verdict(third)?.by}, а освободилась ${a!.session}`);
    await human(p2);
    return `в работе разом 2 из 3 (${a!.session}, ${b!.session}); третий взяла освободившаяся ${a!.session}`;
  });

  await t.step("отсрочка: заметка не будит, будит resume; сессия усыпляет свой тикет и берёт следующий; итог её вопроса — заметкой в спящий", async () => {
    const a = await make(DESK, "Отсрочка", { text: LATER, in: "1h" });
    const parked = await one(a);
    if (parked.state !== "wait" || !(parked.start! > parked.since)) throw new Error(`отложенный при создании тикет: ${parked.state}, start ${parked.start}`);
    // шаги сессии — заметкой: вопрос тикету другого поста (он держит шаг, пока не ответит человек) и сон своего тикета
    const ask = turn(tool(NEW, { to: PAIR, title: `Вопрос ${tag}`, text: hold("думаю") }), tool(SET, { ticket: a, in: "10m", note: "жду ответа" }), say("отложено"));
    await t.must("ticket.set", { ticket: a, note: ask });
    if ((await one(a)).state !== "wait") throw new Error("заметка разбудила спящий тикет");
    await t.must("ticket.set", { ticket: a, resume: true });
    const c = await make(DESK, "Следующий", { text: done("следующий сдан") });
    await reach(a, "сессия усыпила свой тикет", (x) => x.state === "wait" && !!x.start && (x.notes ?? []).some((n) => n.by === desk && n.text === "жду ответа"));
    const q = (await all()).find((x) => x.parent === a);
    if (!q) throw new Error(`тикета, заведённого с шага ${a}, нет`);
    mine(q.id);
    // место свободно: следующий тикет очереди сдан той же сессией, пока первый спит
    const next = await reach(c, "следующий тикет сдан", (x) => x.state === "done");
    if (verdict(next)?.by !== desk) throw new Error(`следующий сдала ${verdict(next)?.by}`);
    // ответ на вопрос: итог ложится заметкой в спящий тикет и его не будит; шаги сессии — в заметке ответа
    await reach(q.id, "вопрос в работе", (x) => x.state === "work");
    await human(q.id, done("итог получен", a));
    const told = (x: Ticket) => (x.notes ?? []).some((n) => n.by === ".factory" && n.text.startsWith(`${q.id} сдан:`));
    await reach(a, "итог вопроса — заметкой в спящий тикет", (x) => x.state === "wait" && told(x));
    await t.must("ticket.set", { ticket: a, resume: true });
    const back = await reach(a, "разбуженный тикет сдан своей сессией", (x) => x.state === "done");
    if (verdict(back)?.by !== desk || verdict(back)?.text !== "итог получен") throw new Error(`тикет вернулся не так: ${JSON.stringify(back.notes!.map((n) => [n.by, n.verdict, n.text.slice(0, 40)]))}`);
    return `${a}: заметка не разбудила, resume — да; ${desk} завела ${q.id}, усыпила свой тикет и сдала ${c}; итог ${q.id} лёг в спящий, resume вернул его ей же`;
  });

  await t.step("заметки: «сдал» с непрочитанной заметкой не закрывает тикет; ход кончился без вердикта — напоминание; повторный «сдал» принят", async () => {
    const { url } = await t.must("hook.url", { project: PROJECT, name: GATE });
    const key = "queue-" + tag;
    // второе событие с тем же ключом сессия шлёт сама, посреди своего хода: оно ложится заметкой в её тикет в работе — от имени входа, не её
    const again = `node -e "fetch(process.argv[1],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:process.argv[2],text:'second'})}).then(r=>process.exit(r.status===202?0:1))" ${url} ${key}`;
    const steps = turn(tool("Bash", { command: again }), tool(SET, { ticket: "{id}", verdict: "done", note: "первый" }), say("кончила"));
    const res = await t.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, text: steps }) });
    const got = (await res.json()) as { id?: string; error?: string; why?: string };
    if (res.status !== 202 || !got.id) throw new Error(`событие не принято: ${res.status} ${got.error ?? ""} ${got.why ?? ""}`);
    const e = mine(got.id);
    // ход, взявший шаг, кончился, а шаг всё ещё у сессии: машина напомнила — строка журнала машины
    let seen = "строки напоминания нет";
    await t.wait("напоминание сессии о несданном шаге", async () => {
      adopt();
      const lines: { msg: string; kind?: string; callsign?: string; why?: string }[] = (await t.must("machine.journal", { to: "@" + machine, part: "host", limit: 200 })).lines;
      const mineLines = lines.filter((l) => l.msg === "work" && l.callsign === desk);
      seen = `строк «work» сессии ${mineLines.length}: ${mineLines.slice(0, 4).map((l) => l.kind).join(", ")}`;
      return mineLines.some((l) => l.kind === "reminded" && String(l.why).includes(e));
    }, () => seen);
    const held = await one(e);
    const notes = held.notes ?? [];
    if (held.state !== "work" || notes.some((n) => n.verdict) || !notes.some((n) => n.by === ".hooks" && n.text === "second")) throw new Error(`после отказа тикет ${held.state}: ${JSON.stringify(notes.map((n) => [n.by, n.verdict, n.text.slice(0, 30)]))}`);
    // заметка сессии показана отказом — повторный «сдал» проходит
    await t.must("message", { to: desk, text: done("второй", e) });
    const closed = await reach(e, "повторный «сдал» принят", (x) => x.state === "done");
    if (verdict(closed)?.by !== desk || verdict(closed)?.text !== "второй") throw new Error(`вердикт не тот: ${JSON.stringify(verdict(closed))}`);
    return `${e}: первый «сдал» отклонён заметкой входа, сессии пришло напоминание, второй «сдал» принят`;
  });

  await t.step("ожидание тикета: сессия усыпляет свой тикет до итога чужого и берёт следующий; итог будит спящий — он идёт той же сессии", async () => {
    // B ведёт «Стол», не сдавая; одна сессия «Двоих» занята — тикеты поста берёт только вторая
    const b = await make(DESK, "Ожидаемый", { text: hold("занята") });
    await reach(b, `тикет ${b} у стола`, (x) => x.state === "work" && x.session === desk);
    const f = await make(PAIR, "Занятая", { text: hold("занята") });
    const filler = await busy(f);
    const a = await make(PAIR, "Ждёт", { text: LATER, in: "1h" });
    await t.must("ticket.set", { ticket: a, resume: true, note: turn(tool(SET, { ticket: a, after: [b], note: "жду " + b }), say("уснул")) });
    const slept = await reach(a, `тикет ${a} спит до итога ${b}`, (x) => x.state === "wait" && !x.session && !!x.after?.includes(b) && (x.notes ?? []).some((n) => n.text === "жду " + b));
    const y = slept.notes!.find((n) => n.text === "жду " + b)!.by;
    if (y === filler.session || !y.startsWith(PAIR)) throw new Error(`усыпила ${y}, а свободна была не занятая ${filler.session}`);
    // место свободно: следующий тикет поста берёт та же сессия
    const c = await make(PAIR, "После сна", { text: done("следующий сдан") });
    const next = await reach(c, "следующий тикет сдан", (x) => x.state === "done");
    if (verdict(next)?.by !== y) throw new Error(`следующий сдала ${verdict(next)?.by}, а свободна ${y}`);
    // «Стол» сдаёт B: итог B ложится заметкой в спящий тикет и будит его; шаги сессии — в итоге B, другого пути к ним у неё нет
    await t.must("message", { to: desk, text: done(done("A сдан", a), b) });
    const woke = await reach(a, "проснувшийся тикет сдан", (x) => x.state === "done");
    const told = woke.notes!.some((n) => n.by === ".factory" && n.text.startsWith(`${b} сдан:`));
    if (verdict(woke)?.by !== y || verdict(woke)?.text !== "A сдан" || !told) throw new Error(`проснулся не так: ${JSON.stringify(woke.notes!.map((n) => [n.by, n.verdict, n.text.slice(0, 40)]))}`);
    await human(f);
    return `${y} усыпила ${a} до итога ${b} и сдала ${c}; «${DESK}» сдал ${b} — ${a} вернулся ${y} с итогом и сдан`;
  });

  await t.step("срочный впереди: у занятого поста срочный тикет идёт раньше двух старших", async () => {
    const d0 = await make(DESK, "Занят стол", { text: hold("занята") });
    await busy(d0);
    const n1 = await make(DESK, "Обычный · 1", { text: done("обычный 1") }), n2 = await make(DESK, "Обычный · 2", { text: done("обычный 2") });
    const u = await make(DESK, "Срочный", { text: done("срочный"), first: true });
    const row = (await all()).find((x) => x.id === u);
    const load = (await factory()).load[DESK];
    if (!row?.first || row.state !== "ready" || load.work !== 1 || load.ready !== 3 || load.first !== 1 || !(load.oldest >= 0)) throw new Error(`очередь стола: ${JSON.stringify({ row, load })}`);
    await human(d0);
    const got = await Promise.all([u, n1, n2].map((id) => reach(id, `тикет ${id} сдан`, (x) => x.state === "done")));
    const at = got.map((x) => verdict(x)!);
    if (at.some((v) => v.by !== desk) || !(at[0]!.at < at[1]!.at && at[1]!.at < at[2]!.at)) throw new Error(`порядок сдачи: ${JSON.stringify(got.map((x, i) => [x.id, at[i]!.by, at[i]!.at]))}`);
    return `очередь стола: в работе 1, ждут 3, срочных 1; сдано по порядку ${u} (срочный), ${n1}, ${n2}`;
  });

  await t.step("уборка сессии: определение без второй сессии поста — она остановлена, её тикет в очереди поста и уходит первой", async () => {
    const first = `${PAIR}@${machine}`, second = `${PAIR}-2@${machine}`;
    /** Пост «Двоих» на size сессий: правка определения в репозитории ролей — клон на машине, коммит, push; ответ — коммит. */
    const dir = `${await t.tmp(machine)}/pieces`;
    const resize = async (size: number) => (await t.node(machine, `import { execFileSync } from "node:child_process";
const dir = ${JSON.stringify(dir)};
// отказ git — одной строкой его слов: красный шаг печатает первую строку
const git = (...a) => {
  try {
    return execFileSync("git", a, { cwd: fs.existsSync(dir) ? dir : undefined, stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    process.stderr.write(\`git \${a[0]}: \${String(e.stderr || e.message).replace(/\\s+/g, " ").slice(0, 160)}\`);
    process.exit(1);
  }
};
if (fs.existsSync(dir)) git("pull", "-q", "--rebase"); else git("clone", "-q", "https://github.com/${REPO}.git", dir);
const file = dir + "/${FOLDER}/factory.json";
const def = JSON.parse(fs.readFileSync(file, "utf8"));
def.posts.${PAIR}.size = ${size};
fs.writeFileSync(file, JSON.stringify(def, null, 2));
git("-c", "user.name=box", "-c", "user.email=box@switchboard", "commit", "-qam", "${PAIR}: size ${size}");
git("push", "-q", "origin", "HEAD:main");
process.stdout.write(git("rev-parse", "HEAD").trim());`)).trim();
    const g1 = await make(PAIR, "Уборка · 1", { text: hold("занята") }), g2 = await make(PAIR, "Уборка · 2", { text: hold("занята") });
    const held = await Promise.all([g1, g2].map(busy));
    const gone = held.find((x) => x.session === second), stays = held.find((x) => x.session === first);
    if (!gone || !stays) throw new Error(`тикеты ведут не обе сессии поста: ${held.map((x) => x.session).join(", ")}`);
    const commit = await resize(1);
    const r = await t.must("factory.apply", { project: PROJECT, repo: `${REPO}/${FOLDER}` });
    if (r.commit !== commit || r.closed.length !== 1 || r.closed[0] !== second || r.failed.length) throw new Error(`применено не то: ${JSON.stringify({ commit: r.commit, want: commit, closed: r.closed, failed: r.failed })}`);
    // первая сессия занята — тикет ушедшей ждёт в очереди поста
    const queued = await one(gone.id);
    if (queued.state !== "ready" || queued.session) throw new Error(`тикет ушедшей сессии — ${queued.state}${queued.session ? ` у ${queued.session}` : ""}`);
    await human(stays.id);
    await reach(gone.id, `тикет ${gone.id} взяла ${first}`, (x) => x.state === "work" && x.session === first);
    await human(gone.id);
    // определение — как было: повторный прогон начинается с поста на две сессии
    const was = await resize(PAIR_SIZE);
    const r2 = await t.must("factory.apply", { project: PROJECT, repo: `${REPO}/${FOLDER}` });
    if (r2.commit !== was || r2.closed.length || r2.failed.length || (await factory()).def.posts[PAIR].size !== PAIR_SIZE) throw new Error(`определение не вернулось: ${JSON.stringify(r2)}`);
    return `коммит ${commit.slice(0, 7)}: закрыта ${second}, её ${gone.id} — в очереди, взяла ${first}; коммит ${was.slice(0, 7)} — снова ${PAIR_SIZE} сессии`;
  });
});
