// Живая проверка правил входа и поста во флоте в коробке: node tools/fleet/live-rules.ts [флот] [устройство]
// Определение проекта коробки лежит в её репозитории кусочков (tools/box/factory.mjs): пост-сторож, пост с проверкой «сдал» и четыре правила входа.
// Два правила — раз в 10 секунд. Проверка первого возвращает 0: шесть сроков — ни тикета, ни работы сессиям, в истории шесть строк «тихо».
// Проверка второго возвращает 1: первая находка — тикет сторожу, следующие — заметки в тот же тикет. Третье правило — с адресом: POST на адрес
// с секретом заводит тикет сторожу, сторож его сдаёт; чужой секрет — 404. Четвёртое — без входа: им машина сообщает «ответила не та модель»;
// три таких события с одним ключом ложатся в один тикет. У второго поста — проверка «сдал»: первый «сдал» она не пропускает, тикет остаётся
// у той же сессии с возвратом; второй проходит. В конце фабрика проекта ставится на паузу: правила больше не срабатывают.
// Время здесь — вход проверки: срок правил задан определением, проверка ждёт факт срабатывания, а не спит срок с запасом.
import { DOOR, DOOR_NOTE, FOUND, FOUND_OUT, MODEL, POST, PROJECT, QUIET, STRICT, STRICT_OUT } from "../box/factory.mjs";
import { REPO } from "../box/github.mjs";
import { check } from "./harness.mjs";
import { say, tool, turn } from "./turn.mjs";

const QUIET_RUNS = 6, NOTES = 3, POSTS = 2, RULES = 4;
const SET = "mcp__fleet__ticket_set";
type Note = { verdict?: string; by: string; text: string };
type Ticket = { id: string; state: string; why?: string; to?: string; session?: string; on?: string; key?: string; returns: number; text?: string; since: number; notes?: Note[] };
type Reply = { ok: boolean; error?: string; result?: any };
type Go = (type: string, fields: unknown) => Promise<Reply>;

await check(async (t) => {
  const { tag } = t;

  const factory = async () => (await t.must("factory.get", { project: PROJECT })).factory;
  const one = async (id: string): Promise<Ticket> => (await t.must("ticket.list", { ticket: id })).tickets[0];
  const all = async (): Promise<Ticket[]> => (await t.must("ticket.list", { project: PROJECT })).tickets;
  /** Момент, когда этот прогон применил определение, — по часам флота: с него считаются тикеты правил и строки истории. */
  let started = 0;
  /** Тикеты, которые завело правило входа с начала этого прогона. */
  const byRule = async (rule: string) => (await all()).filter((x) => x.on === rule && x.since >= started);
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
  /** Сессии постов — свои: их открывает фабрика, а не запрос open; уборка — обвязки. Картина называет их по позывному — каждое ожидание проверки берёт новые. */
  const owned = new Set<string>();
  const adopt = () => {
    for (const [cs, row] of Object.entries(t.picture.sessions) as [string, { cwd: string }][])
      if (!owned.has(cs) && [POST, STRICT].some((p) => cs.startsWith(p + "@"))) (owned.add(cs), t.own(cs, row.cwd));
  };
  /** Правило по времени сработало times раз, считая отсюда: срабатывание первым делом ставит свой следующий срок — он и виден.
   *  Часы флота ведут срабатывания по одному: началось новое — работа прежних кончена. Поэтому два срабатывания — барьер:
   *  что первое из них должно было сделать, уже сделано. Ответ — сколько срабатываний увидено. */
  const fired = async (rule: string, times: number) => {
    const seen = new Set<number>();
    return t.wait(`правило «${rule}» сработало ${times} раз`, async () => (seen.add((await factory()).next[rule]), seen.size > times && seen.size - 1), () => `срабатываний ${seen.size - 1}`);
  };
  /** Тикет дошёл до нужного состояния; встал — отказ сразу, ждать нечего. */
  const reach = (id: string, what: string, ok: (x: Ticket) => boolean) => {
    let last: Ticket | undefined;
    return t.wait(what, async () => {
      adopt();
      const x = (last = await one(id));
      if (x.state === "stop") throw new Error(`${what}: тикет ${id} встал${x.why ? `: ${x.why}` : ""}`);
      return ok(x) && x;
    }, () => (last ? `тикет ${last.state}, возвратов ${last.returns}` : "тикета нет"));
  };

  await t.step("определение проекта применено из репозитория ролей: посты и правила входа", async () => {
    const r = await t.must("factory.apply", { project: PROJECT, repo: REPO });
    // правила пошли по часам: при любом исходе проверки фабрика проекта остаётся на паузе
    t.defer("фабрика проекта — на паузу", (go: Go) => go("factory.pause", { project: PROJECT, on: true }));
    const f = await factory();
    started = f.at;
    if (f.commit !== r.commit || r.posts !== POSTS || !f.def.posts[STRICT]?.check || r.failed.length) throw new Error(`применено не то: ${JSON.stringify({ commit: f.commit, posts: r.posts, failed: r.failed })}`);
    if (r.rules !== RULES || !f.next[QUIET] || !f.next[FOUND] || f.next[DOOR] || f.next[MODEL]) throw new Error(`правила входа не встали на часы: ${JSON.stringify({ rules: r.rules, next: f.next })}`);
    // прошлый прогон оставил фабрику на паузе
    await t.must("factory.pause", { project: PROJECT, on: false });
    return `коммит ${r.commit.slice(0, 7)}: постов ${r.posts}, правил входа ${r.rules}; открыто сессий ${r.opened.length}`;
  });
  // сроки правила считаются по его ближайшему сроку: каждое срабатывание ставит следующий. Идёт рядом с остальными шагами — правила времени работу не ждут
  const quiet = fired(QUIET, QUIET_RUNS);
  quiet.catch(() => {});

  let found = "";
  await t.step(`находка правила — тикет посту; следующие ${NOTES} находки — заметки в тот же тикет`, async () => {
    let seen = "тикета правила нет";
    const x: Ticket = await t.wait("тикет правила с находкой: сторож позвал человека, заметки идут в него", async () => {
      adopt();
      const made = await byRule(FOUND);
      if (made.length > 1) throw new Error(`правило завело ${made.length} тикета: ${made.map((m) => m.id).join(", ")}`);
      if (!made[0]) return false;
      found = mine(made[0].id);
      const tk = await one(found);
      const notes = (tk.notes ?? []).filter((n) => !n.verdict && n.text.includes(FOUND_OUT));
      seen = `тикет ${tk.id} — ${tk.state}${tk.why ? ` (${tk.why})` : ""}, заметок ${notes.length}`;
      // сторож позвал человека: тикет встал и открыт — находки идут в него
      return tk.state === "stop" && tk.why === "нужен человек" && notes.length >= NOTES && tk;
    }, () => seen);
    if (x.to !== POST || !x.text?.includes(FOUND_OUT)) throw new Error(`тикет не тот: ${JSON.stringify({ to: x.to, text: x.text?.slice(-80) })}`);
    return `тикет ${x.id} посту «${POST}»: сторож поднят и позвал человека; заметок с находкой ${(x.notes ?? []).filter((n) => !n.verdict && n.text.includes(FOUND_OUT)).length}, тикетов правила 1`;
  });

  await t.step("проверка поста не прошла — «сдал» не принят, тикет вернулся той же сессии; после прошедшей проверки «сдал» закрыл его", async () => {
    // сессия сдаёт дважды за ход: первый «сдал» проверка поста не пропускает, второй проходит — тикет выдан один раз, сценарий в его тексте не повторится
    const text = turn(tool(SET, { ticket: "{id}", verdict: "done", note: "первый" }), tool(SET, { ticket: "{id}", verdict: "done", note: "второй" }), say("сдано"));
    const id = mine((await t.must("ticket.new", { project: PROJECT, to: STRICT, title: `Проверка поста ${tag}`, text })).id);
    const x = await reach(id, "тикет поста с проверкой сдан", (y) => y.state === "done");
    const back = x.notes!.filter((n) => n.verdict === "back");
    const done = x.notes!.filter((n) => n.verdict === "done");
    // возврат записала машина сессии; сдала та же сессия, вторым «сдал»
    if (back.length !== 1 || !back[0]!.by.startsWith("@") || !back[0]!.text.includes(STRICT_OUT) || x.returns !== 1) throw new Error(`возврат не тот: ${JSON.stringify({ returns: x.returns, back })}`);
    if (done.length !== 1 || done[0]!.text !== "второй" || !done[0]!.by.startsWith(STRICT + "@")) throw new Error(`«сдал» не тот: ${JSON.stringify(done)}`);
    return `${id}: «первый» — возврат от ${back[0]!.by} («${STRICT_OUT}»), «второй» принят от ${done[0]!.by}; возвратов ${x.returns}`;
  });

  let secret = "";
  await t.step("событие на адрес с секретом — тикет посту, пост его сдаёт; чужой секрет — 404", async () => {
    const { url } = await t.must("hook.url", { project: PROJECT, name: DOOR });
    secret = url.split("/").pop()!;
    const wrong = await t.fetch(url.slice(0, -secret.length) + "A".repeat(secret.length), { method: "POST", body: "чужой" });
    if (wrong.status !== 404) throw new Error(`чужой секрет: ответ ${wrong.status}, ждали 404`);
    const res = await t.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "live-" + tag, text: `Событие живой проверки ${tag}` }) });
    const got = (await res.json()) as { id?: string; error?: string; why?: string };
    if (res.status !== 202 || !got.id) throw new Error(`событие не принято: ${res.status} ${got.error ?? ""} ${got.why ?? ""}`);
    const x = await reach(mine(got.id), `тикет ${got.id} сдан постом`, (y) => y.state === "done");
    const verdict = x.notes!.find((n) => n.verdict === "done");
    if (x.on !== DOOR || x.key !== "live-" + tag || x.to !== POST || verdict?.text !== DOOR_NOTE || !verdict.by.startsWith(POST + "@")) throw new Error(`тикет не тот: ${JSON.stringify({ on: x.on, key: x.key, to: x.to, verdict })}`);
    return `тикет ${x.id} по правилу «${DOOR}», сдал ${verdict.by}; чужой секрет — 404`;
  });

  let drift = "";
  await t.step("событие «ответила не та модель» по имени правила: три события с одним ключом — один тикет", async () => {
    // то же событие шлёт сама машина: правило model, ключ — позывной сессии
    const key = `live-${tag}@${POST}`, text = `${key}: в документе модель box-1, ответила box-2`;
    const got: string[] = [];
    for (let i = 1; i <= 3; i++) got.push((await t.must("ticket.new", { project: PROJECT, on: MODEL, key, text })).id);
    drift = mine(got[0]!);
    const made = await byRule(MODEL);
    const x = await one(drift);
    const notes = x.notes!.filter((n) => !n.verdict && n.text === text).length;
    if (new Set(got).size !== 1 || made.length !== 1 || notes !== 2 || x.key !== key || x.to !== POST || !x.text?.includes(text)) throw new Error(`события ушли не туда: ${got.join(", ")}; тикетов правила ${made.length}, заметок ${notes}`);
    // строка списка — без текста и заметок: их несёт тикет, названный по номеру
    if (made[0]!.text !== undefined || made[0]!.notes !== undefined) throw new Error(`строка списка несёт текст или заметки: ${JSON.stringify(made[0])}`);
    return `три события — тикет ${drift} посту «${POST}», заметок 2, тикетов правила 1; строка списка без текста`;
  });

  await t.step(`тихая проверка не будит: правило сработало ${QUIET_RUNS} раз — тикетов 0`, async () => {
    const runs = await quiet;
    const made = await byRule(QUIET);
    if (made.length) throw new Error(`тихое правило завело тикеты: ${made.map((x) => x.id).join(", ")}`);
    return `срабатываний ${runs}, тикетов 0`;
  });

  await t.step("пауза: правила входа не срабатывают — срок тихого правила идёт, тикетов и заметок не прибавилось", async () => {
    await t.must("factory.pause", { project: PROJECT, on: true });
    const notes = async () => (found ? (await one(found)).notes!.length : 0);
    const due = (await factory()).next[QUIET];
    // срабатывание, которое уже шло в момент паузы, дописывает свою заметку: началось следующее — оно кончено
    await fired(FOUND, 1);
    const was = await notes();
    // это следующее шло уже на паузе; началось ещё одно — кончено и оно: заметок и тикетов от него нет
    await fired(FOUND, 1);
    const now = await notes();
    await t.wait("срок тихого правила ушёл вперёд", async () => (await factory()).next[QUIET] > due, () => "срок тихого правила прежний");
    const made = (await byRule(FOUND)).length + (await byRule(QUIET)).length;
    if (now !== was || made !== (found ? 1 : 0)) throw new Error(`на паузе: заметок ${was} → ${now}, тикетов правил ${made}`);
    return `заметок ${was} → ${now}, тикетов правил ${made}`;
  });

  if (!t.lacks("clickhouse"))
    await t.step(`история флота: строк «rule» тихого правила — не меньше ${QUIET_RUNS}, все «тихо» до паузы; у правила с находкой — один «тикет» и заметки`, async () => {
      type Line = { at: number; kind?: string; data?: { rule?: string; project?: string; code?: number; path?: string; status?: number } };
      const of = (lines: Line[], rule: string) => lines.filter((l) => l.at >= started && l.data?.rule === rule && l.data.project === PROJECT);
      const count = (ls: Line[], kind: string) => ls.filter((l) => l.kind === kind).length;
      let said = "строк правила нет";
      // строки доходят не сразу: ждём шесть «тихо» и «паузу» тихого правила
      const lines: Line[] = await t.wait("строки «rule» тихого правила в истории", async () => {
        const got: Line[] = (await t.must("log.query", { msg: "rule", limit: 1000 })).lines;
        const q = of(got, QUIET);
        said = `«тихо» ${count(q, "quiet")}, «пауза» ${count(q, "paused")}`;
        return count(q, "quiet") >= QUIET_RUNS && count(q, "paused") > 0 && got;
      }, () => said);
      const q = of(lines, QUIET), f = of(lines, FOUND);
      const odd = q.filter((l) => l.kind !== "quiet" && l.kind !== "paused");
      if (odd.length) throw new Error(`тихое правило: «тихо» ${count(q, "quiet")}, «пауза» ${count(q, "paused")}, прочих ${odd.length} (${odd.map((l) => l.kind).join(", ")})`);
      if (q.some((l) => l.kind === "quiet" && l.data?.code !== 0)) throw new Error("у строки «тихо» код проверки не 0");
      if (count(f, "ticket") !== 1 || count(f, "note") < NOTES) throw new Error(`правило с находкой: «тикет» ${count(f, "ticket")}, «заметка» ${count(f, "note")}`);
      // вход по адресу: строка «hook» с ответом 202 и путём без секрета
      const hooks: Line[] = (await t.must("log.query", { msg: "hook", limit: 200 })).lines.filter((l: Line) => l.at >= started && l.data?.rule === DOOR);
      const paths = hooks.map((l) => String(l.data?.path));
      if (!hooks.some((l) => l.data?.status === 202) || (secret && paths.some((p) => p.includes(secret)))) throw new Error(`строки входа: ${JSON.stringify(hooks.map((l) => l.data))}`);
      return `тихое правило: «тихо» ${count(q, "quiet")}, «пауза» ${count(q, "paused")}; находка: «тикет» 1, «заметка» ${count(f, "note")}; вход по адресу: строк ${hooks.length}, путь без секрета`;
    });

  await t.step("тикеты событий сняты, сессии постов убраны", async () => {
    for (const id of [found, drift]) if (id) await t.must("ticket.set", { ticket: id, drop: true, note: "живая проверка кончена" });
    const posts = ((await t.must("fleet.list", {})).sessions as { callsign: string }[]).map((x) => x.callsign).filter((c) => [POST, STRICT].some((p) => c.startsWith(p + "@")));
    for (const cs of posts) await t.must("session.remove", { to: cs });
    return `убраны ${posts.join(", ") || "—"}`;
  });
});
