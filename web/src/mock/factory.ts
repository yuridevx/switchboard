// Мок флота — «Фабрика»: определение проекта «Инфра», его тикеты и движок шагов в памяти. Отвечает формами настоящего договора и держит состояние:
// вердикт двигает тикет, потолок конвейера держит очередь, пауза не запускает новых шагов. Посты — сессии, которые уже есть в моке флота.
import { FACTORY, Refusal, type FactoryDef, type FactoryState, type Ticket, type TicketAct, type TicketNote, type Verdict } from "@sb/protocol";
import type { MockCtx } from "./screens.ts";

type H = Record<string, (f: any) => unknown>;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const PROJECT = "infra", REPO = "example/sb-ops";
/** Тикет мока: заметки — всегда при нём. */
type Row = Omit<Ticket, "notes" | "acts"> & { notes: TicketNote[] };

export function factoryHandlers(c: MockCtx): H {
  const { now, T, ME } = c;

  /* ===== Определение: то, что применено из репозитория ролей ===== */
  const def: FactoryDef = {
    project: PROJECT, limit: 6, call: [ME],
    posts: {
      nightcheck: { title: "Оператор", at: "@server", cwd: "~/ops", key: "claude", model: "claude-sonnet-5-5", pieces: [`${REPO}/roles/operator`], for: "2h" },
      backup: { title: "Хранитель копий", at: "@base2", cwd: "~/ops", key: "claude", model: "claude-opus-5-5", pieces: [`${REPO}/roles/keeper`], for: "1d" },
    },
    lines: {
      intake: { title: "Приём заявок", limit: 1, for: "2h", at: ["@server"], cwd: "~/work/{id}", key: "claude", model: "claude-sonnet-5-5", steps: [{ name: "сбор", session: "new" }, { name: "триаж", session: "same" }, { name: "в тикеты", session: "same" }] },
      change: {
        title: "Изменение службы", limit: 2, for: "8h", at: ["@server"], cwd: "~/work/{id}", key: "claude", model: "claude-opus-5-5",
        steps: [
          { name: "план", post: "nightcheck" }, { name: "согласие", human: true }, { name: "правка", session: "same", check: { run: "sh checks/gate.sh", for: "20m" } },
          { name: "ревью", session: "new" }, { name: "слияние", wait: "pr.merged", for: "3d" },
        ],
      },
      postmortem: { title: "Разбор сбоя", limit: 2, for: "4h", at: ["@server", "@base2"], cwd: "~/work/{id}", key: "claude", model: "claude-opus-5-5", steps: [{ name: "разбор", session: "new" }, { name: "правило", session: "new" }] },
    },
    repos: { ops: { repo: REPO, upstream: "upstream/ops-tools" } },
    on: [
      { name: "disk", title: "Место на дисках", every: "10m", to: "nightcheck", key: "disk", check: { at: "@server", run: "node checks/disk.mjs", for: "60s" } },
      { name: "retro", title: "Недельная ретроспектива", cron: "0 9 * * 1", tz: "Europe/Kyiv", to: "backup" },
      { name: "alerts", title: "Тревоги мониторинга", hook: true, to: "postmortem" },
      { name: "upstream", title: "Апстрим сдвинулся", github: "upstream.moved", repo: "ops", every: "5m", to: "backup" },
      { name: "model", title: "Ответила не та модель", to: "nightcheck" },
    ],
  };
  const fac = { repo: REPO, commit: "a41c9e7d2f0b6c8e1a3d5f7092b4c6e8d0f1a2b3", at: T - 2 * HOUR, paused: false };
  const next: Record<string, number> = { disk: T + 4 * MIN, retro: T + 4 * DAY, upstream: T + 2 * MIN };

  /* ===== Тикеты ===== */
  let seq = 52;
  const tickets: Row[] = [];
  const add = (n: number, title: string, to: string | undefined, step: number, state: Row["state"], r: Partial<Row> = {}) => {
    const since = r.since ?? T - HOUR;
    tickets.push({ id: `${PROJECT}-${n}`, project: PROJECT, title, text: title + ".", ...(to ? { to } : {}), step, state, by: ME, returns: 0, since, moved: since, notes: [], ...r });
  };
  const note = (minAgo: number, by: string, text: string, verdict?: Verdict): TicketNote => ({ at: T - minAgo * MIN, by, text, ...(verdict ? { verdict } : {}) });
  const fresh = (n: number, step: number, at = "@server") => `${PROJECT}-${n}-s${step + 1}${at}`;

  add(46, "Заявки за 18 ноября", "intake", 1, "work", { session: fresh(46, 0), since: T - 50 * MIN, text: "Собрать заявки из разговоров с командой и журнала находок за 18 ноября, сгруппировать, группы — в тикеты конвейера «Изменение службы».", notes: [note(42, fresh(46, 0), "Собрана 31 заявка из 4 источников.", "done")] });
  add(47, "Заявки за 19 ноября", "intake", 0, "ready", { since: T - 20 * MIN });
  add(43, "Предел запросов на входе", "change", 0, "work", { session: "nightcheck@server", by: fresh(46, 0), since: T - 35 * MIN, text: "Группа из 4 заявок: вход отдаёт 502 под нагрузкой. Готово: план с числами нагрузки и порогом, подтверждённым журналом." });
  add(45, "Ротация журналов входа", "change", 0, "ready", { by: fresh(46, 0), since: T - 30 * MIN });
  add(41, "Перенос журналов в архив", "change", 1, "wait", {
    by: "audit@server", since: T - 25 * MIN,
    text: "Журналы служб занимают 61 ГБ на /var. Нужен план переноса в архив: что переносить, как не потерять поиск, как откатить.\n\nГотово: план с проверкой на копии за неделю.",
    notes: [note(190, "audit@server", "Заявка команды: «журналы не должны занимать больше трети диска»."), note(25, "nightcheck@server", "План готов: docs/plans/logs-archive.md, 3 проверки на копии, 2 правки.", "done")],
  });
  add(39, "Обновление сертификатов стенда", "change", 2, "stop", { session: "nightcheck@server", by: "audit@server", why: "срок вышел", since: T - 70 * MIN, notes: [note(300, ME, "План принят.", "done"), note(70, FACTORY, "срок вышел", "stop")] });
  add(38, "Права доступа служб выгрузки", "change", 3, "work", { session: fresh(38, 3), by: "audit@server", since: T - 15 * MIN, returns: 1, notes: [note(95, fresh(38, 3), "Право на запись выдано дважды: службе и её группе. Свести к группе.", "back"), note(15, "nightcheck@server", "Сведено к группе; проверки 41 из 41.", "done")] });
  add(36, "Сжатие резервных копий", "change", 4, "wait", { by: "audit@server", pr: `${REPO}#212`, since: T - 3 * HOUR, notes: [note(180, fresh(36, 3), "Замечаний нет.", "done")] });
  add(44, "Ночная выгрузка упала 3 раза из 10", "postmortem", 0, "work", { session: fresh(44, 0), by: ".hooks", on: "alerts", key: "ingest", since: T - 95 * MIN, text: "Тревога мониторинга: ночная выгрузка, 10 запусков, сбоев 3, все на шаге сверки.\n\nНайти общий признак по журналу и предложить правило запуска." });
  add(48, "Недельная ретроспектива", "backup", 0, "work", { session: "backup@base2", by: FACTORY, on: "retro", key: "retro", since: T - 3 * HOUR, text: "" });
  add(49, "Место на дисках", "nightcheck", 0, "ready", { by: FACTORY, on: "disk", key: "disk", since: T - 6 * MIN, text: "проверка «node checks/disk.mjs» не прошла: код 1\n/var занят на 91 %", notes: [note(1, FACTORY, "проверка «node checks/disk.mjs» не прошла: код 1\n/var занят на 92 %")] });
  add(50, "Таблица владельцев служб", undefined, 0, "ready", { by: "audit@server", since: T - 26 * HOUR });
  add(51, "Ускорить сборку проверок: 9 минут на правку", undefined, 0, "ready", { since: T - 5 * HOUR, text: "Сессии ждут проверок по 9 минут на правку. Нужен замер шагов сборки и предложение." });
  add(52, "Проверить выкладку статики", "deploy@server", 0, "ready", { by: "deploy@server", since: T - 10 * MIN, start: T + 20 * MIN, text: "Через 20 минут после выкладки сверить ответы стенда." });
  add(35, "Смена ключа доступа к архиву", "change", 4, "done", { by: "audit@server", pr: `${REPO}#207`, since: T - 2 * DAY, moved: T - DAY, notes: [note(24 * 60, ".github", `PR ${REPO}#207 слит`, "done")] });
  add(33, "Обход журналов по расписанию ОС", "change", 0, "done", { dropped: true, since: T - 3 * DAY, moved: T - 3 * DAY, notes: [note(3 * 24 * 60, ME, "Заменён правилом входа «Место на дисках».")] });

  /* ===== Движок: кто берёт шаг и хватает ли места ===== */
  const lineOf = (t: Row) => (t.to ? def.lines[t.to] : undefined);
  const postOf = (t: Row) => (t.to ? def.posts[t.to] : undefined);
  const working = (to: string) => tickets.filter((t) => t.to === to && t.state === "work").length;
  /** Поставить тикет на его шаг: человек и событие — ждать; сессия — в работу, если есть место и нет паузы, иначе в очередь. */
  function start(t: Row): void {
    t.moved = now();
    delete t.why;
    const line = lineOf(t), post = postOf(t);
    if (!t.to) return void ((t.state = "ready"), delete t.session);
    if (post) {
      // пост берёт тикеты по одному: занят и шагом конвейера, который ведёт его сессия
      const call = `${t.to}${post.at}`;
      if (fac.paused || tickets.some((x) => x.state === "work" && x.session === call)) return void (t.state = "ready");
      return void ((t.state = "work"), (t.session = call));
    }
    // тикет сессии по позывному: у сессии один тикет в работе
    if (!line) return void (fac.paused || tickets.some((x) => x.state === "work" && x.session === t.to) ? (t.state = "ready") : ((t.state = "work"), (t.session = t.to)));
    const step = line.steps[t.step]!;
    if (step.human || step.wait) return void (t.state = "wait");
    if (fac.paused || working(t.to) >= line.limit) return void (t.state = "ready");
    t.session = step.post ? `${step.post}${def.posts[step.post]?.at ?? ""}` : step.session === "same" && t.session ? t.session : `${t.id}-s${t.step + 1}${line.at[0]}`;
    t.state = "work";
  }
  /** Место освободилось или пауза снята — очередь идёт: старые первыми; отложенный ждёт своего момента. */
  function drain(): void {
    for (const t of [...tickets].sort((a, b) => a.since - b.since)) if (t.state === "ready" && t.to && !(t.start && t.start > now())) start(t);
  }
  const find = (id: string) => c.need(tickets.find((t) => t.id === id), `тикета ${id} нет`);
  const own = (project: unknown) => {
    if (project !== PROJECT) throw new Refusal("no_factory", `у проекта ${String(project)} определения нет: его применяет factory_apply`);
  };
  /** Что человек может сделать с тикетом — как ответили бы службы. */
  const actsOf = (t: Row): TicketAct[] => [
    ...(t.state === "work" || t.state === "wait" ? (["verdict"] as const) : []), ...(t.state === "stop" ? (["resume"] as const) : []),
    ...(t.state !== "done" ? (["drop"] as const) : []), ...(t.state !== "work" && t.state !== "done" ? (["assign"] as const) : []),
  ];
  const known = (to: string) => !!def.lines[to] || !!def.posts[to] || /^[^@\s]+@[^@\s]+$/.test(to);
  const state = (): FactoryState => {
    const lines = Object.fromEntries(Object.keys(def.lines).map((name) => [name, { work: working(name), ready: tickets.filter((t) => t.to === name && t.state === "ready").length }]));
    return { project: PROJECT, ...fac, def, load: { work: Object.values(lines).reduce((n, l) => n + l.work, 0), lines }, next };
  };

  return {
    "factory.get": (f) => (f.project === undefined ? { projects: [{ project: PROJECT, ...fac }] } : (own(f.project), { factory: state() })),
    "factory.pause": (f) => {
      own(f.project ?? PROJECT);
      fac.paused = !!f.on;
      if (!fac.paused) drain();
      return { paused: fac.paused };
    },
    "ticket.list": (f) => {
      if (f.ticket) {
        const t = find(f.ticket);
        return { tickets: [{ ...t, acts: actsOf(t) }] };
      }
      own(f.project ?? PROJECT);
      const rows = tickets.filter((t) => (!f.state || t.state === f.state) && (!f.to || t.to === f.to) && (!f.session || t.session === f.session));
      return { tickets: rows.map(({ notes: _notes, ...t }) => t).sort((a, b) => Number(b.id.split("-")[1]) - Number(a.id.split("-")[1])) };
    },
    "ticket.new": (f) => {
      own(f.project ?? PROJECT);
      if (!String(f.title ?? "").trim()) throw new Refusal("bad_input", "тикету нужно название: title");
      if (f.to && !known(f.to)) throw new Refusal("no_dest", `исполнителя ${f.to} нет: ни конвейера, ни поста проекта ${PROJECT}`);
      const t: Row = { id: `${PROJECT}-${++seq}`, project: PROJECT, title: String(f.title).trim(), text: String(f.text ?? ""), ...(f.to ? { to: f.to } : {}), step: 0, state: "ready", by: c.MY_ADDR, returns: 0, since: now(), moved: now(), notes: [] };
      tickets.push(t);
      start(t);
      return { id: t.id };
    },
    "ticket.set": (f) => {
      const t = find(f.ticket);
      const can = actsOf(t);
      const no = (act: TicketAct, why: string) => {
        if (!can.includes(act)) throw new Refusal("bad_state", `тикет ${t.id} — ${t.state}: ${why}`);
      };
      const say = (text: string, verdict?: Verdict) => (verdict || text) && t.notes.push({ at: now(), by: c.MY_ADDR, text, ...(verdict ? { verdict } : {}) });
      const line = lineOf(t);
      if (f.verdict) {
        no("verdict", "вердикт дают шагу в работе или ожидании");
        say(f.note ?? "", f.verdict);
        if (f.verdict === "done") {
          t.returns = 0;
          if (f.pr) t.pr = f.pr;
          if (!line || t.step + 1 >= line.steps.length) (t.state = "done"), (t.moved = now());
          else (t.step += 1), start(t);
        } else if (f.verdict === "stop") (t.state = "stop"), (t.why = String(f.note || "нужен человек")), (t.moved = now());
        else {
          t.returns += 1;
          // второй возврат на том же шаге — стоп: дальше решает человек
          if (t.returns >= 2) (t.state = "stop"), (t.why = "второй возврат"), (t.moved = now());
          else (t.step = Math.max(0, t.step - 1)), start(t);
        }
      } else if (f.resume) {
        no("resume", "в очередь возвращают вставший");
        say(f.note || "возвращён в очередь");
        t.returns = 0;
        start(t);
      } else if (f.drop) {
        no("drop", "тикет уже закрыт");
        say(f.note || "снят");
        (t.state = "done"), (t.dropped = true), (t.moved = now());
      } else if (f.to !== undefined) {
        no("assign", "исполнителя меняют у тикета в очереди, ждущего или вставшего");
        if (!known(f.to)) throw new Refusal("no_dest", `исполнителя ${f.to} нет: ни конвейера, ни поста проекта ${PROJECT}`);
        say(f.note ?? "");
        (t.to = f.to), (t.step = 0), delete t.session;
        // вставший тикет исполнителя меняет, но в очередь не идёт: его возвращает resume
        if (t.state !== "stop") start(t);
      } else if (f.note) say(f.note);
      else throw new Refusal("bad_input", "нечего менять: назовите verdict, resume, drop, to, for, pr или note");
      drain();
      return { id: t.id, state: t.state, step: t.step };
    },
  };
}
