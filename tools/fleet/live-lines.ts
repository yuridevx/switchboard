// Живая проверка конвейера во флоте в коробке: node tools/fleet/live-lines.ts [флот] [устройство]
// Определение проекта коробки лежит в её репозитории кусочков (tools/box/factory.mjs): конвейер из трёх шагов с потолком два.
// Проверка применяет определение, кладёт на конвейер пять тикетов и ждёт, пока все пройдут три шага: свежая сессия → та же → свежая.
// Одновременно в работе — не больше потолка: это видно по загрузке конвейера во время прогона и по истории флота после него.
// В том же определении — пост-сторож и два правила входа раз в 10 секунд. Проверка первого возвращает 0: шесть сроков — ни тикета, ни работы
// сессиям, в истории шесть строк «тихо». Проверка второго возвращает 1: первая находка — тикет сторожу, следующие — заметки в тот же тикет.
// Третье правило — с адресом: POST на адрес с секретом заводит тикет сторожу, сторож его сдаёт; чужой секрет — 404. Четвёртое — без входа:
// им машина сообщает «ответила не та модель»; три таких события с одним ключом ложатся в один тикет. В конце фабрика проекта ставится
// на паузу: правила больше не срабатывают. Второй конвейер кончается шагом-ожиданием: сессия называет PR, двойник GitHub коробки шлёт событие
// слияния с подписью — шаг сдан; событие с чужой подписью получает 401. Пятое правило опрашивает чужой апстрим: двойник двигает голову его
// ветки — следующий срок правила заводит тикет сторожу.
// Время здесь — вход проверки: срок правил задан определением, проверка ждёт факт срабатывания, а не спит срок с запасом.
import { DOOR, DOOR_NOTE, FOUND, FOUND_OUT, LINE, MERGE, MERGE_PR, MODEL, MOVED, POST, PROJECT, QUIET } from "../box/factory.mjs";
import { REPO } from "../box/github.mjs";
import { check } from "./harness.mjs";

const TICKETS = 5, LIMIT = 2, STEPS = 3, QUIET_RUNS = 6, NOTES = 3;
type Note = { verdict?: string; by: string; text: string };
type Ticket = { id: string; state: string; step: number; why?: string; to?: string; on?: string; key?: string; pr?: string; text: string; since: number; notes?: Note[] };
type Reply = { ok: boolean; error?: string; result?: any };
type Go = (type: string, fields: unknown) => Promise<Reply>;

await check(async (t) => {
  const hub = process.env.SB2_GITHUB;
  if (!hub) throw new Error("нужен SB2_GITHUB — адрес двойника GitHub: его ставит флот в коробке");
  const { tag } = t;

  /** Фабрика проекта; вопросы о ней, заданные разом, делят один запрос. */
  let asking: Promise<any> | undefined;
  const factory = () => (asking ??= t.must("factory.get", { project: PROJECT }).then((r: { factory: any }) => r.factory).finally(() => (asking = undefined)));
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
      const x = (last = await one(id));
      if (x.state === "stop") throw new Error(`${what}: тикет ${id} встал${x.why ? `: ${x.why}` : ""}, шаг ${x.step + 1}`);
      return ok(x) && x;
    }, () => (last ? `тикет ${last.state}, шаг ${last.step + 1}` : "тикета нет"));
  };

  let ids: string[] = [];
  await t.step("определение проекта применено из репозитория ролей", async () => {
    const r = await t.must("factory.apply", { project: PROJECT, repo: REPO });
    // правила пошли по часам: при любом исходе проверки фабрика проекта остаётся на паузе, а сессии её шагов и пост-сторож убраны
    t.defer("фабрика проекта — на паузу", (go: Go) => go("factory.pause", { project: PROJECT, on: true }));
    t.defer("сессии шагов и пост-сторож", async (go: Go) => {
      const list = await go("fleet.list", {});
      if (!list.ok) return list;
      const gone = (list.result.sessions as { callsign: string }[]).map((x) => x.callsign).filter((c) => c.startsWith(POST + "@") || tickets.some((id) => c.startsWith(id + "-s")));
      return (await Promise.all(gone.map((to) => go("session.remove", { to })))).find((x) => !x.ok && x.error !== "not_found");
    });
    const f = await factory();
    started = f.at;
    const line = f.def.lines[LINE];
    if (f.commit !== r.commit || line?.limit !== LIMIT || line.steps.length !== STEPS) throw new Error(`применено не то: ${JSON.stringify({ commit: f.commit, line })}`);
    if (r.rules !== 5 || !f.next[QUIET] || !f.next[FOUND] || !f.next[MOVED] || f.next[DOOR] || f.next[MODEL]) throw new Error(`правила входа не встали на часы: ${JSON.stringify({ rules: r.rules, next: f.next })}`);
    // прошлый прогон оставил фабрику на паузе
    await t.must("factory.pause", { project: PROJECT, on: false });
    return `коммит ${r.commit.slice(0, 7)}, конвейер «${line.title}»: шагов ${line.steps.length}, потолок ${line.limit}; правил входа ${r.rules}`;
  });
  // сроки правила считаются по его ближайшему сроку: каждое срабатывание ставит следующий. Идёт рядом с конвейером — правила времени работу не ждут
  const quiet = fired(QUIET, QUIET_RUNS);
  quiet.catch(() => {});

  await t.step(`конвейер из ${STEPS} шагов при потолке ${LIMIT} проводит ${TICKETS} тикетов: одновременно в работе не больше ${LIMIT}`, async () => {
    for (let i = 1; i <= TICKETS; i++) ids.push(mine((await t.must("ticket.new", { project: PROJECT, to: LINE, title: `Живая проверка конвейера ${tag} · ${i}` })).id));
    let peak = 0, closed = 0;
    await t.wait(`закрыты ${TICKETS} тикетов конвейера`, async () => {
      // загрузка конвейера — проходящее число: её ловит каждое чтение, пока тикеты идут; точный счёт одновременной работы — по истории флота, следующим шагом
      peak = Math.max(peak, (await factory()).load.lines[LINE].work);
      const now = (await all()).filter((x) => ids.includes(x.id));
      const stopped = now.find((x) => x.state === "stop");
      if (stopped) throw new Error(`тикет ${stopped.id} встал на шаге ${stopped.step + 1}: ${stopped.why}`);
      closed = now.filter((x) => x.state === "done").length;
      return closed === TICKETS;
    }, () => `закрыто ${closed} из ${TICKETS}`);
    const done = await Promise.all(ids.map(one));
    const verdicts = done.map((x) => x.notes!.filter((n) => n.verdict === "done").length);
    if (verdicts.some((n) => n !== STEPS)) throw new Error(`вердиктов «сдал» у тикетов: ${verdicts.join(", ")}, ждали по ${STEPS}`);
    // шаг «довести» вела та же сессия, что «сделать»; «принять» — другая
    const sessions = done.map((x) => x.notes!.filter((n) => n.verdict === "done").map((n) => n.by));
    if (sessions.some((s) => s[0] !== s[1] || s[2] === s[0])) throw new Error(`сессии шагов не те: ${JSON.stringify(sessions[0])}`);
    if (peak > LIMIT || peak < 1) throw new Error(`в работе одновременно было ${peak}, потолок ${LIMIT}`);
    return `закрыто ${TICKETS} из ${TICKETS}, шагов сдано ${TICKETS * STEPS}, в работе одновременно до ${peak}`;
  });

  if (!t.lacks("clickhouse"))
    await t.step("история флота: по строкам «ticket» одновременно в работе не больше потолка", async () => {
      const own = new Set(ids);
      let given = 0, done = 0;
      // строки доходят не сразу: ждём все «дан» и «сдан» своих тикетов
      const lines: { at: number; kind?: string }[] = await t.wait("строки «дан» и «сдан» своих тикетов в истории", async () => {
        const got = (await t.must("log.query", { msg: "ticket", limit: 1000 })).lines.filter((l: { data?: { ticket?: string } }) => own.has(String(l.data?.ticket)));
        given = got.filter((l: { kind?: string }) => l.kind === "given").length;
        done = got.filter((l: { kind?: string }) => l.kind === "done").length;
        return given >= TICKETS * STEPS && done >= TICKETS * STEPS && got;
      }, () => `строк «дан» ${given}, «сдан» ${done}, ждали по ${TICKETS * STEPS}`);
      if (given !== TICKETS * STEPS || done !== TICKETS * STEPS) throw new Error(`строк «дан» ${given}, «сдан» ${done}, ждали по ${TICKETS * STEPS}`);
      // в один момент сначала считается «сдан», потом «дан»: место освобождается раньше, чем его берут
      let now = 0, peak = 0;
      for (const l of lines.filter((x) => x.kind === "given" || x.kind === "done").sort((a, b) => a.at - b.at || (a.kind === "done" ? -1 : 1))) {
        now += l.kind === "given" ? 1 : -1;
        peak = Math.max(peak, now);
      }
      if (peak > LIMIT) throw new Error(`по истории в работе одновременно было ${peak}, потолок ${LIMIT}`);
      // отбор истории по времени: since отсекает старое, before — новое
      const mid = lines.map((l) => l.at).sort((a, b) => a - b)[Math.floor(lines.length / 2)]!;
      const late: { at: number }[] = (await t.must("log.query", { msg: "ticket", since: mid, limit: 1000 })).lines, early: { at: number }[] = (await t.must("log.query", { msg: "ticket", before: mid, limit: 1000 })).lines;
      if (!late.length || !early.length || late.some((l) => l.at < mid) || early.some((l) => l.at >= mid)) throw new Error(`отбор по времени: после середины ${late.length} (старше её ${late.filter((l) => l.at < mid).length}), до середины ${early.length} (новее её ${early.filter((l) => l.at >= mid).length})`);
      return `строк «дан» ${given}, «сдан» ${done}; одновременно в работе до ${peak}; отбор по времени: после середины ${late.length}, до неё ${early.length}`;
    });

  await t.step(`тихая проверка не будит: правило сработало ${QUIET_RUNS} раз — тикетов 0`, async () => {
    const runs = await quiet;
    const made = await byRule(QUIET);
    if (made.length) throw new Error(`тихое правило завело тикеты: ${made.map((x) => x.id).join(", ")}`);
    return `срабатываний ${runs}, тикетов 0`;
  });

  let found = "";
  await t.step(`находка правила — тикет посту; следующие ${NOTES} находки — заметки в тот же тикет`, async () => {
    let seen = "тикета правила нет";
    const x: Ticket = await t.wait("тикет правила с находкой: сторож позвал человека, заметки идут в него", async () => {
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
    if (x.to !== POST || !x.text.includes(FOUND_OUT)) throw new Error(`тикет не тот: ${JSON.stringify({ to: x.to, text: x.text.slice(-80) })}`);
    return `тикет ${x.id} посту «${POST}»: сторож поднят и позвал человека; заметок с находкой ${(x.notes ?? []).filter((n) => !n.verdict && n.text.includes(FOUND_OUT)).length}, тикетов правила 1`;
  });

  await t.step("слияние PR сдаёт шаг-ожидание: событие GitHub с чужой подписью — 401, тикет ждёт; с подписью приложения — тикет закрыт", async () => {
    const id = mine((await t.must("ticket.new", { project: PROJECT, to: MERGE, title: `Живая проверка слияния ${tag}` })).id);
    // первый шаг сдан сессией с PR — тикет ждёт события
    await reach(id, "шаг-ожидание начат", (x) => x.state === "wait" && x.pr === MERGE_PR);
    const url = `${t.base}/github/${t.fleet}`;
    const [repo, number] = MERGE_PR.split("#");
    const payload = { action: "closed", repository: { full_name: repo }, sender: { login: "box" }, pull_request: { number: Number(number), merged: true } };
    const forged = await t.fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": "sha256=" + "0".repeat(64) }, body: JSON.stringify(payload) });
    // отказ — ответ на сам запрос: событие с чужой подписью до тикета не дошло, он ждёт как ждал
    const still = (await one(id)).state;
    if (forged.status !== 401 || still !== "wait") throw new Error(`чужая подпись: ответ ${forged.status}, тикет ${still}`);
    const sent = (await (await t.fetch(hub + "/box/deliver", { method: "POST", body: JSON.stringify({ url, event: "pull_request", payload }) })).json()) as { status: number; body: string };
    if (sent.status !== 200 || !sent.body.includes(id)) throw new Error(`событие слияния: ответ ${sent.status} ${sent.body.slice(0, 120)}`);
    const done = await reach(id, "шаг-ожидание сдан", (x) => x.state === "done");
    const verdict = done.notes!.at(-1)!;
    if (verdict.by !== ".github" || verdict.verdict !== "done") throw new Error(`последний вердикт не от события: ${JSON.stringify(verdict)}`);
    return `тикет ${id}: PR ${MERGE_PR} слит — шаг сдан событием; чужая подпись — 401`;
  });

  let moved = "";
  await t.step("апстрим сдвинулся — тикет посту: голову чужой ветки флот спрашивает по сроку правила", async () => {
    // два срока с начала шага: работа первого кончена — прежняя голова точно запомнена, и тикета по ней нет
    await fired(MOVED, 2);
    if ((await byRule(MOVED)).length) throw new Error("тикет заведён без сдвига апстрима");
    const { sha } = (await (await t.fetch(hub + "/box/upstream", { method: "POST" })).json()) as { sha: string };
    let seen = "тикета правила нет";
    const made: Ticket = await t.wait("тикет правила о сдвиге апстрима", async () => {
      const got = await byRule(MOVED);
      if (got.length > 1) throw new Error(`после сдвига тикетов правила ${got.length}: ${got[0]!.text.slice(-60)}`);
      if (got[0]) moved = mine(got[0].id);
      seen = got[0] ? `тикет ${got[0].id}: ${got[0].text.slice(-60)}` : "тикета правила нет";
      return got[0]?.text.includes(sha.slice(0, 7)) && got[0];
    }, () => seen);
    // ещё два срока на прежней голове: работа первого кончена — тикет один
    await fired(MOVED, 2);
    if ((await byRule(MOVED)).length !== 1) throw new Error("прежняя голова завела второй тикет");
    return `тикет ${made.id} посту «${POST}»: голова ${sha.slice(0, 7)}; на прежнюю голову тикетов не прибавилось`;
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
    if (new Set(got).size !== 1 || made.length !== 1 || notes !== 2 || x.key !== key || x.to !== POST || !x.text.includes(text)) throw new Error(`события ушли не туда: ${got.join(", ")}; тикетов правила ${made.length}, заметок ${notes}`);
    return `три события — тикет ${drift} посту «${POST}», заметок 2, тикетов правила 1`;
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

  await t.step("тикеты событий сняты, пост-сторож убран", async () => {
    for (const id of [found, drift, moved]) if (id) await t.must("ticket.set", { ticket: id, drop: true, note: "живая проверка кончена" });
    const post = ((await t.must("fleet.list", {})).sessions as { callsign: string }[]).map((x) => x.callsign).find((c) => c.startsWith(POST + "@"));
    if (post) await t.must("session.remove", { to: post });
    return post ? `сессия ${post} убрана` : "сессии поста нет";
  });

  await t.step("тикеты закрыты — свежие сессии шагов убраны", async () => {
    const fresh = (n: string) => ids.some((id) => n.startsWith(id + "-s"));
    let left: string[] = [];
    // сессии шагов уходят вслед за закрытием тикета: картина флота приходит кадрами — ждём, пока в ней не останется ни одной
    await t.wait("сессии шагов убраны", () => ((left = Object.keys(t.picture.sessions).filter(fresh)), !left.length), () => `остались сессии шагов: ${left.join(", ")}`);
    return `сессий шагов осталось 0 из ${TICKETS * 2}`;
  });
});
