// Живая проверка очереди поста во флоте в коробке: node tools/fleet/live-queue.ts [флот] [устройство]
// Определение второго проекта коробки лежит в папке кусочка её репозитория (tools/box/queue.mjs): пост на две сессии, пост на одну, вход с адресом.
// 1. Очередь: три тикета посту на две сессии — два идут сразу, третий ждёт; первый вердикт освобождает сессию — третий берёт она.
// 2. Отсрочка: тикет, отложенный при создании, заметка возвращает в очередь сразу; сессия заводит вопрос, откладывает свой тикет и берёт
//    следующий; ответ на вопрос ложится заметкой в отложенный тикет и возвращает его той же сессии.
// 3. Заметки: событие входа ложится заметкой в тикет в работе; «сдал» сессии, которая заметки не видела, не закрывает тикет; ход кончился
//    без вердикта — сессии приходит напоминание; повторный «сдал» принят.
// Шаги сессий — сценарии хода (tools/fleet/turn.mjs). Проверка ждёт состояние тикета, а не время: что сессия занята, держит её же шаг без вердикта.
import { REPO } from "../box/github.mjs";
import { DESK, FOLDER, GATE, PAIR, PROJECT } from "../box/queue.mjs";
import { check } from "./harness.mjs";
import { say, tool, turn } from "./turn.mjs";

type Note = { verdict?: string; by: string; text: string };
type Ticket = { id: string; state: string; step: number; why?: string; to?: string; session?: string; parent?: string; start?: number; on?: string; text: string; since: number; notes?: Note[] };
type Reply = { ok: boolean; error?: string; result?: any };
type Go = (type: string, fields: unknown) => Promise<Reply>;

const SET = "mcp__fleet__ticket_set", NEW = "mcp__fleet__ticket_new";
/** Шаги сессии: сдать тикет — свой ({id} — его номер) или названный. */
const done = (note: string, ticket = "{id}") => turn(tool(SET, { ticket, verdict: "done", note }), say("шаг сдан"));
/** Шаги сессии: ответить и кончить ход — шаг остаётся у неё, сессия занята. */
const hold = (word: string) => turn(say(word));

await check(async (t) => {
  const { tag } = t;
  const one = async (id: string): Promise<Ticket> => (await t.must("ticket.list", { ticket: id })).tickets[0];
  const all = async (): Promise<Ticket[]> => (await t.must("ticket.list", { project: PROJECT })).tickets;
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

  let desk = "";
  await t.step("определение проекта применено из папки кусочка: пост на две сессии, потолка у проекта нет", async () => {
    const r = await t.must("factory.apply", { project: PROJECT, repo: `${REPO}/${FOLDER}` });
    const f = (await t.must("factory.get", { project: PROJECT })).factory;
    if (f.commit !== r.commit || r.posts !== 2 || f.def.posts[PAIR]?.size !== 2 || f.def.limit !== undefined || r.failed.length) throw new Error(`применено не то: ${JSON.stringify({ posts: r.posts, pair: f.def.posts[PAIR], limit: f.def.limit, failed: r.failed })}`);
    desk = DESK + f.def.posts[DESK].at;
    // прошлый прогон мог оставить фабрику на паузе
    await t.must("factory.pause", { project: PROJECT, on: false });
    return `коммит ${r.commit.slice(0, 7)}: постов ${r.posts}, «${PAIR}» на ${f.def.posts[PAIR].size} сессии; открыто сессий ${r.opened.length}`;
  });

  await t.step("очередь поста на две сессии: три тикета — два идут сразу, третий ждёт; первый вердикт — третий берёт освободившаяся сессия", async () => {
    const make = async (n: number, text: string) => mine((await t.must("ticket.new", { project: PROJECT, to: PAIR, title: `Очередь поста ${tag} · ${n}`, text })).id);
    const p1 = await make(1, hold("занята")), p2 = await make(2, hold("занята"));
    const [a, b] = await Promise.all([p1, p2].map((id) => reach(id, `тикет ${id} в работе`, (x) => x.state === "work" && !!x.session)));
    if (a!.session === b!.session || ![a!.session, b!.session].every((s) => s!.startsWith(PAIR))) throw new Error(`два тикета ведут не две сессии поста: ${a!.session}, ${b!.session}`);
    // обе сессии держат шаг — третьему тикету взяться некому
    const p3 = await make(3, done("третий сдан"));
    const queued = await one(p3);
    if (queued.state !== "ready") throw new Error(`третий тикет при двух занятых сессиях — ${queued.state}`);
    await t.must("ticket.set", { ticket: p1, verdict: "done", note: "сдан человеком" });
    const third = await reach(p3, "третий тикет сдан", (x) => x.state === "done");
    if (verdict(third)?.by !== a!.session) throw new Error(`третий тикет сдала ${verdict(third)?.by}, а освободилась ${a!.session}`);
    await t.must("ticket.set", { ticket: p2, verdict: "done", note: "сдан человеком" });
    return `в работе разом 2 из 3 (${a!.session}, ${b!.session}); третий взяла освободившаяся ${a!.session}`;
  });

  await t.step("отсрочка: заметка возвращает отложенный тикет; сессия откладывает свой тикет, берёт следующий; ответ на её вопрос возвращает первый", async () => {
    const a = mine((await t.must("ticket.new", { project: PROJECT, to: DESK, title: `Отсрочка ${tag}`, text: "Живая проверка: шаги придут заметками.", in: "1h" })).id);
    const parked = await one(a);
    if (parked.state !== "ready" || !(parked.start! > parked.since)) throw new Error(`отложенный при создании тикет: ${parked.state}, start ${parked.start}`);
    // первая заметка снимает отсрочку — тикет идёт сессии вместе с заметкой: в ней её шаги. Вопрос — тикету другого поста: он держит шаг, пока не ответит человек
    const ask = turn(tool(NEW, { to: PAIR, title: `Вопрос ${tag}`, text: hold("думаю") }), tool(SET, { ticket: a, in: "10m", note: "жду ответа" }), say("отложено"));
    await t.must("ticket.set", { ticket: a, note: ask });
    const c = mine((await t.must("ticket.new", { project: PROJECT, to: DESK, title: `Следующий ${tag}`, text: done("следующий сдан") })).id);
    await reach(a, "сессия отложила свой тикет", (x) => x.state === "ready" && !!x.start && (x.notes ?? []).some((n) => n.by === desk && n.text === "жду ответа"));
    const q = (await all()).find((x) => x.parent === a);
    if (!q) throw new Error(`тикета, заведённого с шага ${a}, нет`);
    mine(q.id);
    // место свободно: следующий тикет очереди сдан той же сессией, пока первый отложен
    const next = await reach(c, "следующий тикет сдан", (x) => x.state === "done");
    const still = await one(a);
    if (verdict(next)?.by !== desk || still.state !== "ready" || !still.start) throw new Error(`следующий сдала ${verdict(next)?.by}; отложенный — ${still.state}, start ${still.start}`);
    // ответ на вопрос: итог ложится заметкой в отложенный тикет и возвращает его той же сессии; её шаги — в заметке ответа
    await reach(q.id, "вопрос в работе", (x) => x.state === "work");
    await t.must("ticket.set", { ticket: q.id, verdict: "done", note: done("итог получен", a) });
    const back = await reach(a, "отложенный тикет сдан своей сессией", (x) => x.state === "done");
    const told = back.notes!.some((n) => n.by === ".factory" && n.text.startsWith(`${q.id} сдан:`));
    if (verdict(back)?.by !== desk || verdict(back)?.text !== "итог получен" || !told) throw new Error(`тикет вернулся не так: ${JSON.stringify(back.notes!.map((n) => [n.by, n.verdict, n.text.slice(0, 40)]))}`);
    return `${a}: заметка сняла отсрочку; ${desk} завела ${q.id}, отложила свой тикет и сдала ${c}; итог ${q.id} вернул ${a} ей же`;
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
      const lines: { msg: string; kind?: string; callsign?: string; why?: string }[] = (await t.must("machine.journal", { to: "@" + desk.slice(desk.indexOf("@") + 1), part: "host", limit: 200 })).lines;
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
});
