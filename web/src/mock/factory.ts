// Мок флота — «Фабрика»: определения двух проектов, их тикеты и раздача в памяти. Отвечает формами настоящего договора и держит состояние,
// как службы: работа идёт постам и сессиям по позывному; свободная сессия поста берёт срочный, потом старший; тикет, который сессия уже вела
// (возврат, проснувшийся), ждёт её. Спящий тикет будят итог каждого названного тикета, срок и resume — заметка не будит. Итог тикета ложится
// заметкой от .factory в тикет-родитель и в ждущие. Пауза не выдаёт тикетов. Посты — сессии, которые уже есть в моке флота.
// «Инфра» — плотная фабрика: тикеты во всех состояниях. «Исследования» — редкая: посты с длинными названиями, два тикета и пауза.
import { FACTORY, postSessions, Refusal, termMs, type FactoryDef, type FactoryState, type Ticket, type TicketAct, type TicketNote, type Verdict } from "@sb/protocol";
import type { MockCtx } from "./screens.ts";

type H = Record<string, (f: any) => unknown>;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const REPO = "example/sb-ops", LAB = "example/sb-lab";
/** Проект по умолчанию — как у сессии, которая проект не называет. */
const HOME = "infra";
/** Позывной сессии: имя@машина. */
const CALLSIGN = /^[^@\s~.]+@[^@\s]+$/;
/** Тикет мока: заметки — всегда при нём; target — кого ждёт в очереди: пост (любая его сессия) или позывной; term — срок работы, мс;
 *  ran — сессия, которая вела его последней: возврат ждёт её. */
type Row = Omit<Ticket, "notes" | "acts" | "check"> & { notes: TicketNote[]; target?: string; term: number; ran?: string };
type Add = (n: number, title: string, to: string | undefined, state: Row["state"], r?: Partial<Row>) => void;
type Seed = { project: string; repo: string; commit: string; paused: boolean; def: FactoryDef; next: Record<string, number>; seq: number; fill: (add: Add) => void };
const num = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1));

export function factoryHandlers(c: MockCtx): H {
  const { now, T, ME } = c;
  const note = (minAgo: number, by: string, text: string, verdict?: Verdict): TicketNote => ({ at: T - minAgo * MIN, by, text, ...(verdict ? { verdict } : {}) });

  /* ===== Одна фабрика: применённое определение, тикеты и раздача ===== */
  function floor(seed: Seed) {
    const { project, def, next } = seed;
    const fac = { repo: seed.repo, commit: seed.commit, at: T - 2 * HOUR, paused: seed.paused };
    let seq = seed.seq;
    const tickets: Row[] = [];
    const termOf = (to: string | undefined) => (to && def.posts[to] ? termMs(def.posts[to]!.for) : HOUR);
    seed.fill((n, title, to, state, r = {}) => {
      const since = r.since ?? T - HOUR;
      const target = state === "ready" || state === "wait" ? to : undefined;
      tickets.push({ id: `${project}-${n}`, project, title, text: "", ...(to ? { to } : {}), ...(target ? { target } : {}), state, by: ME, returns: 0, since, moved: since, notes: [], term: termOf(to), ...(r.session ? { ran: r.session } : {}), ...r });
    });
    const byId = (id: string) => tickets.find((t) => t.id === id);

    /** Куда встаёт тикет: в очередь к посту (тикет, который сессия поста уже вела, — к ней) или к сессии; без исполнителя — бэклог. */
    function plan(to: string | undefined, ran: string | undefined, term: number | undefined): { target?: string; term: number } {
      if (!to) return { term: term ?? HOUR };
      const post = def.posts[to];
      if (post) return { target: ran ?? to, term: termMs(post.for) };
      if (!CALLSIGN.test(to)) throw new Refusal("no_dest", `исполнителя ${to} нет: ни поста, ни сессии`);
      if (!term) throw new Refusal("no_term", "тикету сессии нужен срок работы: for");
      return { target: to, term };
    }
    const queue = (t: Row, p: { target?: string; term: number }) => ((t.state = "ready"), (t.term = p.term), p.target ? (t.target = p.target) : delete t.target, delete t.session, delete t.until, delete t.why);
    const busy = (call: string) => tickets.some((x) => x.state === "work" && x.session === call);
    const rank = (a: Row, b: Row) => (a.first ? -1 : 0) - (b.first ? -1 : 0) || num(a.id) - num(b.id);
    const give = (t: Row, session: string) => ((t.state = "work"), (t.session = session), (t.ran = session), (t.moved = now()), (t.until = now() + t.term));
    /** Спящий просыпается к своей цели. */
    function wake(t: Row): boolean {
      if (t.state !== "wait") return false;
      (t.state = "ready"), (t.moved = now()), delete t.start, delete t.after;
      return true;
    }
    /** Раздать готовое: сначала сессия получает своё, потом свободные сессии поста — срочный, потом старший. Срок спящего вышел — он просыпается. */
    function drain(): void {
      for (const t of tickets) if (t.state === "wait" && t.start && t.start <= now()) wake(t);
      if (fac.paused) return;
      for (const t of tickets.filter((x) => x.state === "ready" && x.target && CALLSIGN.test(x.target)).sort(rank)) if (!busy(t.target!)) give(t, t.target!);
      for (const [name, post] of Object.entries(def.posts))
        for (const session of postSessions(name, post)) {
          if (busy(session)) continue;
          const t = tickets.filter((x) => x.state === "ready" && x.target === name).sort(rank)[0];
          if (t) give(t, session);
        }
    }
    /** Итог тикета — тикету-родителю и ждущим, одной заметкой каждому; ждущий, у которого итог есть у всех названных, просыпается. */
    function report(t: Row, text: string): void {
      const waiting = tickets.filter((x) => x.after?.includes(t.id));
      const to = new Set([...(t.parent ? [t.parent] : []), ...waiting.map((x) => x.id)]);
      for (const id of to) byId(id)?.notes.push({ at: now(), by: FACTORY, text });
      for (const x of waiting) {
        x.after = x.after!.filter((id) => id !== t.id);
        if (!x.after.length) (delete x.after, wake(x));
      }
    }
    /** После движения тикета: спящий больше не спит — ожидания сняты; встал или закрыт — итог тем, кому он нужен; затем раздача. */
    function settle(was: Row["state"] | null, t: Row, said: string): void {
      if (was === "wait" && t.state !== "wait") delete t.after, delete t.start;
      if (t.state === "stop" && was !== "stop") report(t, `${t.id} встал: ${t.why ?? ""}`);
      if (t.state === "done" && was !== "done") report(t, `${t.id} ${t.dropped ? "снят" : "сдан"}${said ? `: ${said}` : ""}`);
      drain();
    }
    /** Тикеты, которых собираются ждать: каждый есть в проекте и не он сам. Ответ — те, у кого итога ещё нет. */
    function blockers(self: string | null, after: string[]): string[] {
      for (const id of after) {
        if (!id.startsWith(`${project}-`)) throw new Refusal("bad_input", `тикет ${id} — другого проекта: ждут тикеты своего`);
        if (!byId(id)) throw new Refusal("no_ticket", `тикета ${id} нет`);
        if (id === self) throw new Refusal("bad_input", "тикет не ждёт сам себя");
      }
      return [...new Set(after)].filter((id) => ["ready", "work", "wait"].includes(byId(id)!.state));
    }
    /** Усыпить: кого ждёт и до какого срока; ждать нечего и срока нет — тикет сразу в очереди. */
    function sleep(t: Row, after: string[], term: string | undefined): void {
      (t.state = "wait"), (t.moved = now());
      if (after.length) t.after = after;
      else delete t.after;
      if (term) t.start = now() + termMs(term);
      if (!after.length && !term) wake(t);
    }
    /** Что человек может сделать с тикетом — как ответили бы службы: вердикт — тикету в работе; в работе исполнителя меняет только его сессия. */
    const actsOf = (t: Row): TicketAct[] => [
      ...(t.state === "work" ? (["verdict"] as const) : []), ...(t.state === "stop" || t.state === "wait" ? (["resume"] as const) : []),
      ...(t.state !== "done" ? (["drop"] as const) : []), ...(t.state !== "work" && t.state !== "done" ? (["assign"] as const) : []),
    ];
    /** Тикет глазами спросившего: строка списка — без текста, заметок и файлов; у тикета в работе поста — проверка поста. */
    function view(t: Row, full: boolean): Ticket {
      const { notes, target: _target, term: _term, ran: _ran, text, files, ...rest } = t;
      const check = t.state === "work" && t.to ? def.posts[t.to]?.check : undefined;
      return { ...rest, ...(check ? { check: { ...check, run: check.run.replaceAll("{id}", t.id) } } : {}), ...(full ? { text: text ?? "", notes, ...(files ? { files } : {}) } : {}) };
    }
    /** Очереди постов: в работе, в очереди (спящие не в счёт), срочных и сколько ждёт старший. */
    const load = (): FactoryState["load"] =>
      Object.fromEntries(Object.keys(def.posts).map((name) => {
        const mine = tickets.filter((t) => t.to === name);
        const ready = mine.filter((t) => t.state === "ready");
        const oldest = ready.length ? now() - Math.min(...ready.map((t) => t.moved)) : undefined;
        return [name, { work: mine.filter((t) => t.state === "work").length, ready: ready.length, first: ready.filter((t) => t.first).length, ...(oldest !== undefined ? { oldest } : {}) }];
      }));
    const state = (): FactoryState => ({ project, ...fac, def, load: load(), next });

    return {
      project, fac, tickets, state, actsOf, view,
      pause(on: boolean) {
        fac.paused = on;
        if (!on) drain();
        return { paused: fac.paused };
      },
      list(f: any) {
        const rows = tickets.filter((t) => (!f.state || t.state === f.state) && (!f.to || t.to === f.to) && (!f.session || t.session === f.session));
        return { tickets: rows.sort((a, b) => num(b.id) - num(a.id)).map((t) => view(t, false)) };
      },
      create(f: any) {
        if (f.on !== undefined) {
          // событие правила входа: исполнитель и название — у правила; открытый тикет с тем же правилом и ключом получает его заметкой
          if (f.to !== undefined || f.title !== undefined || f.for || f.in || f.after || f.first !== undefined) throw new Refusal("bad_input", "событие правила входа несёт только on, key, text и files: исполнитель и название — у правила");
          const rule = def.on.find((r) => r.name === f.on);
          if (!rule) throw new Refusal("no_rule", `правила входа ${f.on} у проекта ${project} нет`);
          const key = f.key ?? rule.key ?? rule.name;
          const open = tickets.filter((t) => t.on === rule.name && t.key === key && t.state !== "done").sort((a, b) => num(b.id) - num(a.id))[0];
          if (open) {
            open.notes.push({ at: now(), by: c.MY_ADDR, text: f.text || `событие правила «${rule.name}»` });
            return { id: open.id };
          }
          f = { title: rule.title ?? rule.name, text: [rule.text, f.text].filter(Boolean).join("\n\n"), to: rule.to, key, on: rule.name };
        }
        if (!String(f.title ?? "").trim()) throw new Refusal("bad_input", "тикету нужно название: title");
        if (f.to !== undefined && !def.posts[f.to]) {
          if (!CALLSIGN.test(f.to)) throw new Refusal("no_dest", `исполнителя ${f.to} нет: поста с таким именем у проекта ${project} нет; сессии — позывной вида site@laptop`);
          if (!f.for) throw new Refusal("no_term", "тикету сессии нужен срок работы: for — 20m, 2h, 1d");
          if (!c.sessions[f.to]) throw new Refusal("no_session", `сессии ${f.to} нет во флоте`);
        }
        if ((f.in || f.after) && f.to === undefined) throw new Refusal("bad_input", "спать может тикет с исполнителем: назовите to");
        const after = f.after ? blockers(null, f.after) : [];
        const p = plan(f.to, undefined, f.for ? termMs(f.for) : undefined);
        const t: Row = {
          id: `${project}-${++seq}`, project, title: String(f.title).trim(), text: String(f.text ?? ""), ...(f.to ? { to: f.to } : {}), state: "ready", by: c.MY_ADDR, returns: 0, since: now(), moved: now(), notes: [], term: p.term,
          ...(p.target ? { target: p.target } : {}), ...(f.first ? { first: true } : {}), ...(f.key ? { key: f.key } : {}), ...(f.on ? { on: f.on } : {}),
        };
        tickets.push(t);
        if (f.in || f.after) sleep(t, after, f.in);
        settle(null, t, "");
        return { id: t.id };
      },
      set(t: Row, f: any) {
        if ([f.verdict, f.resume, f.drop, f.in || f.after, f.to].filter(Boolean).length > 1) throw new Refusal("bad_input", "одно из пяти: verdict, resume, drop, сон (in, after) или to");
        const was = t.state;
        const no = (act: TicketAct, why: string) => {
          if (!actsOf(t).includes(act)) throw new Refusal("bad_state", `тикет ${t.id} — ${t.state}: ${why}`);
        };
        const said = String(f.note ?? "");
        const say = (text: string, verdict?: Verdict) => (verdict || text) && t.notes.push({ at: now(), by: c.MY_ADDR, text, ...(verdict ? { verdict } : {}) });
        const halt = (why: string) => ((t.state = "stop"), (t.why = why), delete t.until);
        if (f.verdict) {
          no("verdict", "вердикт дают тикету в работе");
          say(said, f.verdict);
          if (f.verdict === "done") (t.state = "done"), delete t.until, delete t.why, delete t.target;
          else if (f.verdict === "stop") halt(said || "нужен человек");
          else if (++t.returns >= 2) halt("второй возврат");
          // возврат ждёт ту же сессию поста
          else queue(t, plan(t.to, t.ran, t.term));
        } else if (f.in || f.after) {
          // тикет усыпляет сессия, которая его ведёт; в моке спрашивает только страница — она и стоит за эту сессию
          if (t.state !== "work") throw new Refusal("bad_state", `тикет ${t.id} — ${t.state}: усыпляют тикет в работе`);
          const after = f.after ? blockers(t.id, f.after) : [];
          say(said);
          (t.target = t.session), delete t.session, delete t.until;
          sleep(t, after, f.in);
        } else if (f.resume) {
          no("resume", "в очередь возвращают вставший или спящий");
          if (t.state === "wait") (say(said || "разбужен"), wake(t));
          else (say(said || "возвращён в очередь"), (t.returns = 0), queue(t, plan(t.to, t.ran, t.term)));
        } else if (f.drop) {
          no("drop", "тикет уже закрыт");
          say(said || "снят");
          (t.state = "done"), (t.dropped = true), delete t.until, delete t.target;
        } else if (f.to !== undefined) {
          no("assign", "исполнителя меняют у тикета в очереди, спящего или вставшего");
          const p = plan(f.to, undefined, f.for ? termMs(f.for) : t.term);
          say(said);
          (t.to = f.to), delete t.ran, delete t.start;
          if (f.first !== undefined) t.first = !!f.first;
          // вставший тикет исполнителя меняет, но в очередь не идёт: его возвращает resume
          if (t.state === "stop") t.term = p.term;
          else queue(t, p);
        } else {
          if (f.for) t.term = termMs(f.for);
          if (f.first !== undefined) {
            if (t.state === "done") throw new Refusal("bad_state", `тикет ${t.id} уже закрыт`);
            if (f.first) t.first = true;
            else delete t.first;
          }
          if (!f.for && f.first === undefined && !said) throw new Refusal("bad_input", "нечего менять: назовите verdict, resume, drop, in, after, to, for, first или note");
          // заметка спящий тикет не будит: её увидят при выдаче
          say(said);
        }
        if (!t.first) delete t.first;
        t.moved = now();
        settle(was, t, said);
        return { id: t.id, state: t.state };
      },
    };
  }

  /* ===== «Инфра»: плотная фабрика ===== */
  const infra = floor({
    project: "infra", repo: REPO, commit: "a41c9e7d2f0b6c8e1a3d5f7092b4c6e8d0f1a2b3", paused: false, seq: 59,
    def: {
      project: "infra", call: [ME],
      posts: {
        nightcheck: { title: "Оператор", at: "@server", cwd: "~/ops", key: "claude", model: "claude-sonnet-5-5", pieces: [`${REPO}/roles/operator`], for: "2h" },
        backup: { title: "Хранитель копий", at: "@base2", cwd: "~/ops", key: "claude", model: "claude-opus-5-5", pieces: [`${REPO}/roles/keeper`], for: "1d" },
        coders: { title: "Кодеры служб", at: "@server", cwd: "~/ops", key: "claude", model: "claude-opus-5-5", pieces: [`${REPO}/roles/coder`], for: "8h", size: 2, check: { run: "sh checks/gate.sh {id}", for: "20m" } },
        postmortem: { title: "Разбор сбоев", at: "@server", cwd: "~/ops", key: "claude", model: "claude-opus-5-5", pieces: [`${REPO}/roles/analyst`], for: "4h" },
      },
      on: [
        { name: "disk", title: "Место на дисках", every: "10m", to: "nightcheck", key: "disk", check: { at: "@server", run: "node checks/disk.mjs", for: "60s" } },
        { name: "retro", title: "Недельная ретроспектива", cron: "0 9 * * 1", tz: "Europe/Kyiv", to: "backup" },
        { name: "alerts", title: "Тревоги мониторинга", hook: true, to: "postmortem" },
        { name: "model", title: "Ответила не та модель", to: "nightcheck" },
      ],
    },
    next: { disk: T + 4 * MIN, retro: T + 4 * DAY },
    fill(add) {
      // пост «Оператор»: его сессия занята тикетом, отданным ей по позывному; в очереди — находка правила и вставший тикет
      add(43, "Предел запросов на входе", "nightcheck@server", "work", { session: "nightcheck@server", since: T - 35 * MIN, until: T + 85 * MIN, term: 2 * HOUR, text: "Вход отдаёт 502 под нагрузкой. Готово: план с числами нагрузки и порогом, подтверждённым журналом." });
      add(49, "Место на дисках", "nightcheck", "ready", { by: FACTORY, on: "disk", key: "disk", since: T - 6 * MIN, text: "проверка «node checks/disk.mjs» не прошла: код 1\n/var занят на 91 %", notes: [note(1, FACTORY, "проверка «node checks/disk.mjs» не прошла: код 1\n/var занят на 92 %")] });
      add(41, "Перенос журналов в архив", "nightcheck", "stop", {
        by: "audit@server", since: T - 25 * MIN, ran: "nightcheck@server", why: "нужно согласие: переносить журналы старше 90 дней?",
        text: "Журналы служб занимают 61 ГБ на /var. Нужен план переноса в архив: что переносить, как не потерять поиск, как откатить.\n\nГотово: план с проверкой на копии за неделю.",
        notes: [note(190, "audit@server", "Заявка команды: «журналы не должны занимать больше трети диска»."), note(25, "nightcheck@server", "нужно согласие: переносить журналы старше 90 дней?", "stop")],
      });
      // пост «Кодеры служб»: одна очередь на две сессии; срочный стоит впереди старших; возврат ждёт ту же сессию; спящий ждёт ответа сессии по позывному
      add(53, "Вход: отказ 429 сверх 200 запросов в секунду", "coders", "work", { session: "coders@server", by: "nightcheck@server", since: T - 48 * MIN, until: T + 7 * HOUR, text: "По плану тикета infra-43. Готово: три сценария предела зелёные." });
      add(54, "Архив: поиск по перенесённым журналам", "coders", "work", { session: "coders-2@server", by: "nightcheck@server", since: T - 20 * MIN, until: T + 7 * HOUR + 40 * MIN });
      add(38, "Права доступа служб выгрузки", "coders", "ready", { target: "coders@server", ran: "coders@server", by: "audit@server", since: T - 2 * HOUR, moved: T - 15 * MIN, returns: 1, notes: [note(95, "coders@server", "Права сведены к группе службы.", "done"), note(15, ME, "Право на запись выдано дважды: службе и её группе. Свести к группе.", "back")] });
      add(39, "Обновление сертификатов стенда", "coders", "stop", { session: "coders-2@server", by: "audit@server", why: "срок вышел", since: T - 70 * MIN, notes: [note(300, ME, "План принят."), note(70, FACTORY, "срок вышел", "stop")] });
      add(58, "Журнал входа: строка на каждый отказ", "coders", "ready", { by: "nightcheck@server", since: T - 5 * MIN });
      add(59, "Вход падает на пустом заголовке", "coders", "ready", { first: true, by: ME, since: T - 2 * MIN, text: "Пустой заголовок Host роняет вход. Готово: отказ 400 и эталон на пустой заголовок." });
      add(55, "Сверка выгрузки: повтор шага при сбое", "coders", "wait", {
        target: "coders-2@server", ran: "coders-2@server", after: ["infra-57"], by: "postmortem@server", since: T - 70 * MIN, moved: T - 12 * MIN,
        text: "По разбору infra-44: сверка падает на первом сбое сети. Готово: повтор шага сверки, ночная выгрузка проходит 10 запусков из 10.",
        notes: [note(12, "coders-2@server", "Жду оператора: сколько повторов допустимо за ночь — infra-57.")],
      });
      add(57, "Сколько повторов сверки допустимо за ночь", "ingest@server", "work", { session: "ingest@server", by: "coders-2@server", parent: "infra-55", since: T - 12 * MIN, until: T + 48 * MIN, term: HOUR, text: "Сверка идёт 4 минуты. Сколько повторов за ночь не сдвинет окно выгрузки?" });
      // сессия по позывному: тикет спит до своего срока
      add(52, "Проверить выкладку статики", "deploy@server", "wait", { by: "deploy@server", since: T - 10 * MIN, start: T + 20 * MIN, term: 30 * MIN, text: "Через 20 минут после выкладки сверить ответы стенда." });
      add(44, "Ночная выгрузка упала 3 раза из 10", "postmortem", "work", { session: "postmortem@server", by: ".hooks", on: "alerts", key: "ingest", since: T - 95 * MIN, until: T + 145 * MIN, text: "Тревога мониторинга: ночная выгрузка, 10 запусков, сбоев 3, все на шаге сверки.\n\nНайти общий признак по журналу и предложить правило запуска." });
      add(48, "Недельная ретроспектива", "backup", "work", { session: "backup@base2", by: FACTORY, on: "retro", key: "retro", since: T - 3 * HOUR, until: T + 21 * HOUR });
      add(36, "Сжатие резервных копий", "backup", "ready", { by: "audit@server", since: T - 3 * HOUR });
      // бэклог: без исполнителя
      add(50, "Таблица владельцев служб", undefined, "ready", { by: "audit@server", since: T - 26 * HOUR });
      add(51, "Ускорить сборку проверок: 9 минут на правку", undefined, "ready", { since: T - 5 * HOUR, text: "Сессии ждут проверок по 9 минут на правку. Нужен замер шагов сборки и предложение." });
      // закрытые за несколько дней
      add(35, "Смена ключа доступа к архиву", "coders", "done", { by: "audit@server", session: "coders@server", since: T - 2 * DAY, moved: T - DAY, notes: [note(24 * 60, "coders@server", "Ключ сменён; проверка gate 41 из 41.", "done")] });
      add(34, "Ключи выгрузки — в хранилище секретов", "coders", "done", { by: "audit@server", session: "coders-2@server", since: T - 3 * DAY, moved: T - 2 * DAY - 3 * HOUR, notes: [note(51 * 60, "coders-2@server", "Ключи перенесены, старые отозваны.", "done")] });
      add(33, "Обход журналов по расписанию ОС", "nightcheck", "done", { dropped: true, since: T - 3 * DAY - 2 * HOUR, moved: T - 3 * DAY - HOUR, notes: [note(3 * 24 * 60 + 60, ME, "Заменён правилом входа «Место на дисках».")] });
    },
  });

  /* ===== «Исследования»: редкая фабрика на паузе ===== */
  const post = (title: string, at: `@${string}`, term = "4h") => ({ title, at, cwd: "~/projects/research", key: "claude", model: "claude-opus-5-5", pieces: [`${LAB}/roles`], for: term });
  const tick = (run: string) => ({ at: "@server" as const, run: `node tools/factory-check.mjs ${run}`, for: "30s" });
  const research = floor({
    project: "research", repo: `${LAB}/main`, commit: "d0cf9c28040c8cf4f15592c18fce468f177ca301", paused: true, seq: 2,
    def: {
      project: "research", call: [ME],
      posts: {
        lead: post("Руководитель: разговор с владельцем и раздача работы", "@laptop", "1d"),
        wing: post("Поиск: вызовы старого клиента оплаты по всем службам", "@laptop"),
        crawler: post("Сборщик: цены конкурентов, обход каталогов, выгрузка в таблицу", "@base2", "1h"),
        prices: post("Аналитик цен: сводка по сегментам и недельная динамика", "@server"),
        sources: post("Источники: поиск и проверка первичных документов", "@server"),
        stats: post("Статистик: проверка выборок и доверительные интервалы", "@server"),
        editor: post("Редактор отчётов: сведение разделов и единый словарь", "@laptop", "2h"),
        charts: post("Графики: рисунки к отчётам из таблиц результатов", "@laptop", "2h"),
      },
      on: [
        { name: "cycle", title: "Цикл руководителя", every: "3h", to: "lead" },
        { name: "crawl", title: "Тик сборщика", every: "10m", to: "crawler", check: tick("crawl") },
        { name: "questions", title: "Вопросы ждут руководителя", every: "15m", to: "lead", check: tick("questions") },
        { name: "stale", title: "Отчёт не сведён", every: "30m", to: "editor", check: tick("stale") },
        { name: "jump", title: "Цена сегмента выросла", hook: true, to: "prices" },
        { name: "halt", title: "Сборщик остановлен", hook: true, to: "crawler" },
      ],
    },
    next: { crawl: T + 3 * MIN, questions: T + 11 * MIN, stale: T + 11 * MIN, cycle: T + 95 * MIN },
    fill(add) {
      add(2, "Сводка цен за октябрь — в общий отчёт", "prices", "ready", { by: "lead@laptop", since: T - 10 * HOUR, text: "Свести цены по сегментам за октябрь в раздел «Рынок». Готово: таблица и абзац вывода в отчёте." });
      add(1, "Ревью раздела «Методика»", undefined, "ready", { by: "lead@laptop", since: T - 10 * HOUR, text: "Раздел в ветке report/method. Готово: вердикт и замечания по восьми вопросам." });
    },
  });

  const floors = [infra, research];
  const own = (project: unknown) => {
    const f = floors.find((x) => x.project === (project ?? HOME));
    if (!f) throw new Refusal("no_factory", `у проекта ${String(project)} определения нет: его применяет factory_apply`);
    return f;
  };
  const find = (id: string) => {
    for (const f of floors) {
      const t = f.tickets.find((x) => x.id === id);
      if (t) return { f, t };
    }
    throw new Refusal("no_ticket", `тикета ${id} нет`);
  };

  return {
    "factory.get": (f) => (f.project === undefined ? { projects: floors.map((x) => ({ project: x.project, ...x.fac })) } : { factory: own(f.project).state() }),
    "factory.pause": (f) => own(f.project).pause(!!f.on),
    "ticket.list": (f) => {
      if (!f.ticket) return own(f.project).list(f);
      const { f: at, t } = find(f.ticket);
      return { tickets: [{ ...at.view(t, true), acts: at.actsOf(t) }] };
    },
    "ticket.new": (f) => own(f.project).create(f),
    "ticket.set": (f) => {
      const { f: at, t } = find(f.ticket);
      return at.set(t, f);
    },
  };
}
