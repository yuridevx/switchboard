import { randomUUID } from "node:crypto";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Host, Result } from "@switchboard/host";
import { kindOf, machineOf } from "@switchboard/protocol";
import { addProject, labelOf, LABELS, NONE, placeSessions, PROFILE_REPOS, projectByName, projectIdOf, PROJECTS, setLabel } from "@switchboard/records";
import type { Labels, ProjectRec, Settings } from "@switchboard/records";
import { z } from "zod";

type Env = { host: Host; records: Settings };
type Refused = Extract<Result, { ok: false }>;
type Block = { type?: string; text?: string; name?: string };
type Record_ = { type?: string; message?: { content?: string | Block[] } };
type Row = NonNullable<ReturnType<Host["roster"]>>["sessions"][number];

const say = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
const fail = (text: string) => say(text, true);

/** Отказ для модели: один текст на все инструменты. */
function refusal(to: string, r: Refused): string {
  if (r.error === "offline") return `Не доставлено: ${to} не на связи (offline)`;
  if (r.error === "disconnected") return "Доставка не подтверждена: нет связи с relay (disconnected)";
  if (r.error === "timeout") return `Не выполнено: ${to} — timeout: исход неизвестен, проверь list`;
  return `Не выполнено: ${to} — ${r.error}${r.why ? `. ${r.why}` : ""}`;
}

/** Необязательные поля запроса: пустое — как не названное. */
const filled = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

/** owner/name репозитория GitHub. */
const REPO = /^[\w.-]+\/[\w.-]+$/;
/** Переменная модели alias: остальное в env ключа агенту не показывается. */
const MODEL_ENV = /^ANTHROPIC_DEFAULT_(.+)_MODEL$/;

/** Ключ флота глазами агента: только модели. Значение и адрес заводит человек на пульте. */
const modelsOf = (env: Record<string, string> = {}) => Object.fromEntries(Object.entries(env).flatMap(([k, v]) => {
  const m = MODEL_ENV.exec(k);
  return m ? [[m[1].toLowerCase(), v]] : [];
}));

/** Настройки ведомого: то, что можно задать другой сессии. */
const WING = z.object({ profile: z.array(z.string()).optional(), model: z.string().optional(), effort: z.string().optional(), slot: z.string().optional() });
type Wing = z.infer<typeof WING>;

/** Правило пары, одно на все инструменты: ведомый есть только для своего ведущего. */
const mine = (me: string, s: Row) => !s.wing || s.parent === me;
/** Адрес ведомого: open — инструмент из тех, что открыты ведущему. Слова отказа или null. */
function closed(host: Host, me: string, callsign: string, open: boolean): string | null {
  const row = host.roster()?.sessions.find((s) => s.callsign === callsign);
  if (!row?.wing || (open && mine(me, row))) return null;
  return `Не выполнено: ${callsign} — pair_inside. Это ведомый внутри пары, работать с ним можно только через его ведущего`;
}
const wingRowOf = (host: Host, lead: string) => host.roster()?.sessions.find((s) => s.wing && s.parent === lead);

/** Что есть на машине: кусочки, слоты, ключи флота, клоны. Одно не ответило — остальное всё равно видно. */
async function machineView({ host }: Env, machine: string) {
  const [pieces, accounts, keys] = await Promise.all([host.read("machine.profiles", { machine }), host.read("machine.accounts", { machine }), host.read("fleetkeys.list", {})]);
  const said = (r: Result) => (r.ok ? null : r.error);
  const { profiles = {}, repos = {} } = (pieces.ok ? pieces.result : {}) as { profiles?: Record<string, { about?: string; kind?: string }>; repos?: Record<string, { state: string; dir?: string }> };
  const { slots = {} } = (accounts.ok ? accounts.result : {}) as { slots?: Record<string, { account: string | null; wait: number | null }> };
  const fleetKeys = ((keys.ok ? keys.result : {}) as { keys?: Record<string, { env?: Record<string, string> }> }).keys ?? {};
  const meta = [["кусочки", said(pieces)], ["слоты", said(accounts)], ["ключи флота", said(keys)]].filter(([, w]) => w).map(([n, w]) => `${n} недоступны: ${w}`);
  return {
    machine,
    pieces: Object.fromEntries(Object.entries(profiles).map(([id, p]) => [id, { kind: p.kind, ...(p.about ? { about: p.about } : {}) }])),
    slots: Object.fromEntries(Object.entries(slots).map(([s, v]) => [s, { account: v.account, wait: v.wait }])),
    keys: Object.fromEntries(Object.entries(fleetKeys).map(([n, k]) => [n, { models: modelsOf(k.env) }])),
    clones: repos,
    ...(meta.length ? { meta: meta.join("; ") } : {}),
  };
}

/** Каждый блок текста и каждый вызов инструмента — строкой; остальное модели не нужно. */
function historyLines(messages: Record_[]): string {
  const lines = messages.flatMap(({ type, message }) => {
    if (type !== "user" && type !== "assistant") return [];
    const content = message?.content ?? [];
    const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
    return blocks.flatMap((b) => (b.type === "text" && b.text ? [`${type}: ${b.text}`] : b.type === "tool_use" && b.name ? [`tool: ${b.name}`] : []));
  });
  return lines.join("\n") || "записей нет";
}

/** Поставить сессию в конец проекта: нет такого имени — создать; пустое имя — без проекта. null или слово отказа. */
function place(records: Settings, callsign: string, name: string): Promise<string | null> {
  return records.edit<ProjectRec[]>(PROJECTS, (recs) => {
    if (!name.trim()) return placeSessions(recs, [callsign], NONE);
    const known = projectByName(recs, name);
    const target = known ? { recs, id: known.id } : addProject(recs, name);
    return placeSessions(target.recs, [callsign], target.id);
  });
}

/** Настройки строки списка: у ведомого они же лежат внутри его ведущего, без адреса. */
const settingsOf = ({ model, profile, slot }: Row) => ({
  model: model ?? null,
  profile: ((profile ?? []) as Array<{ id: string }>).map((p) => p.id),
  slot: (slot as { name?: string } | undefined)?.name ?? null,
});

async function fleetList(me: string, { host, records }: Env) {
  const roster = host.roster();
  if (!roster) return fail("Нет связи с relay (disconnected): список сессий неизвестен");
  const word = await records.read();
  const recs = word ? undefined : records.get<ProjectRec[]>(PROJECTS);
  const labels = word ? undefined : records.get<Labels>(LABELS);
  const parents = new Map(roster.sessions.map((s) => [s.callsign, s.parent as string | null | undefined]));
  const projectName = (callsign: string) => {
    const id = projectIdOf(recs, callsign, (cs) => parents.get(cs));
    return recs?.find((r) => r.id === id && id !== NONE)?.name ?? null;
  };
  const list = {
    me,
    sessions: roster.sessions.filter((s) => mine(me, s)).map((s) => {
      const wing = wingRowOf(host, s.callsign);
      return {
        callsign: s.callsign,
        state: s.state ?? null,
        parent: s.parent ?? null,
        ...settingsOf(s),
        label: labelOf(labels, s.callsign) ?? null,
        project: projectName(s.callsign),
        ...(wing ? { pair: { state: wing.state ?? null, ...settingsOf(wing) } } : {}),
      };
    }),
    machines: roster.machines.map(({ machine }) => ({ machine, label: labelOf(labels, `@${machine}`) ?? null })),
    projects: (recs ?? []).filter((r) => r.id !== NONE).map((r) => r.name),
    clients: roster.clients,
    ...(word ? { meta: `имена и проекты недоступны: ${word}` } : {}),
  };
  return say(JSON.stringify(list));
}

/** Инструменты MCP сессии me. env — ядро и записи: появляются на старте Host, тексты от них не зависят. */
export function toolsOf(me: string, env: () => Env) {
  const ok = (to: string, text: string) => (r: Result) => (r.ok ? say(text) : fail(refusal(to, r)));

  /** Слот первым, профиль вторым: отказ не меняет остального. Слова отказа или null, сделанное — в done. */
  async function swap(host: Host, callsign: string, { slot, profile }: Pick<Wing, "slot" | "profile">, done: string[]): Promise<string | null> {
    if (slot !== undefined) {
      const r = await host.request("session.slot", { callsign, slot, from: me });
      if (!r.ok) return refusal(callsign, r);
      done.push((r.result as { restart?: boolean } | undefined)?.restart ? `слот ${slot}; перезапуск между ходами` : `слот ${slot}`);
    }
    if (profile !== undefined) {
      const r = await host.request("session.profile", { callsign, profile, from: me });
      if (!r.ok) return refusal(callsign, r);
      done.push((r.result as { restart?: boolean } | undefined)?.restart ? "профиль сменён; перезапуск между ходами" : "профиль сменён");
    }
    return null;
  }

  /** Открыть ведомого: машина ведущего, имя и папку она выводит сама. */
  const openWing = (host: Host, lead: string, { profile, model, effort, slot }: Wing) =>
    host.request("session.open", { machine: machineOf(lead), wing_of: lead, ...filled({ profile, model, effort }), ...(slot === undefined ? {} : { slot }), from: me });

  /** Поле wing у update: нет ведомого — откроет, есть — настройки ему, null — снимет. Слова отказа или null. */
  async function setWing(host: Host, lead: string, wing: Wing | null, done: string[]): Promise<string | null> {
    const row = wingRowOf(host, lead);
    if (wing === null) {
      if (!row) return `Не выполнено: ${lead} — ведомого нет`;
      const r = await host.request("session.remove", { callsign: row.callsign, from: me });
      if (!r.ok) return refusal(row.callsign, r);
      done.push("ведомый снят");
      return null;
    }
    if (!row) {
      const r = await openWing(host, lead, wing);
      if (!r.ok) return `ведомый не открыт — ${r.error}${r.why ? `. ${r.why}` : ""}`;
      done.push("ведомый открыт");
      return null;
    }
    const { callsign } = row;
    const word = await swap(host, callsign, wing, done);
    if (word) return word;
    const { model, effort } = wing;
    if (!model && !effort) return null;
    const r = await host.request("session.update", { callsign, ...filled({ model, effort }), from: me });
    if (!r.ok) return refusal(callsign, r);
    done.push(`ведомому сразу: ${(r.result as { now: string[] }).now.join(", ") || "—"}`);
    return null;
  }

  return [
    tool("list", "Кто на связи: сессии флота с состоянием, родителем, моделью, профилем, слотом, именем и проектом; машины с именами; проекты; клиенты (телефон, пульт).", {}, () => fleetList(me, env())),

    tool(
      "send",
      "Написать сессии флота (callsign имя@машина) или человеку: всем его устройствам ~email или одному устройство~email. Ответа адресата не ждёт.",
      { to: z.string().describe("callsign сессии, ~email человека или устройство~email"), text: z.string().describe("текст сообщения") },
      async ({ to, text }) => {
        const { host } = env();
        if (kindOf(to) === "session") {
          const shut = closed(host, me, to, true);
          return shut ? fail(shut) : ok(to, `доставлено: ${to}`)(await host.request("message", { to, text, from: me }));
        }
        const sent = host.emit({ type: "message", from: me, to, text });
        if (!sent.ok) return fail(refusal(to, sent));
        void host.request("notify", { clients: [to], frame: { type: "message", from: me, notify: { title: me, body: text, tag: randomUUID() } } });
        return say(`отправлено: ${to}`);
      },
    ),

    tool(
      "answer",
      "Ответить на вопрос другой сессии (тег <fleet-question>), которой эта сессия дала задачу.",
      {
        to: z.string().describe("callsign сессии, задавшей вопрос"),
        question: z.string().describe("id вопроса из тега"),
        answers: z.record(z.string(), z.string()).describe("текст вопроса → ответ; несколько вариантов — через запятую"),
      },
      async ({ to, question, answers }) => {
        const { host } = env();
        const shut = closed(host, me, to, true);
        return shut ? fail(shut) : ok(to, "принято")(await host.request("answer", { callsign: to, question, answers, from: me }));
      },
    ),

    tool(
      "open",
      "Открыть сессию с задачей на любой машине флота. Она твоя дочь: итог каждого её хода, начатого тобой, придёт сам. Без параметра slot: на машине один слот — он, слотов нет — отказ (войдите в аккаунт на машине), два и больше — отказ со списком слотов. wing — открыть пару: вторую сессию на той же машине и в той же папке, задачу ей ставит только эта сессия.",
      {
        name: z.string().describe("имя сессии: буквы, цифры, . _ -"),
        dir: z.string().describe("папка: от ~ или полный путь"),
        text: z.string().describe("задача — первое сообщение сессии"),
        machine: z.string().optional().describe("машина; по умолчанию — твоя"),
        profile: z.array(z.string()).optional().describe("кусочки профиля сессии по порядку: нижний выигрывает"),
        model: z.string().optional(),
        effort: z.string().optional(),
        slot: z.string().optional().describe("имя слота машины или ключа флота"),
        project: z.string().optional().describe("имя проекта: сессия встанет в его конец, нет такого — создастся; без него — в проект открывшей"),
        wing: WING.optional().describe("настройки ведомого: профиль, модель, усилие, слот"),
      },
      async ({ name, dir, text, machine, profile, model, effort, slot, project, wing }) => {
        const { host, records } = env();
        const where = machine ?? host.machine;
        const opened = await host.request("session.open", { machine: where, name, dir, ...filled({ profile, model, effort }), ...(slot === undefined ? {} : { slot }), from: me });
        if (!opened.ok) return fail(refusal(`${name}@${where}`, opened));
        const { callsign, slot: used } = opened.result as { callsign: string; slot?: string | null };
        const shown = used ? `${callsign} · слот ${used}` : callsign;
        const word = project === undefined ? null : await place(records, callsign, project);
        if (wing) {
          const r = await openWing(host, callsign, wing);
          if (!r.ok) return fail(`открыта: ${shown}, ведомый не открыт — ${r.error}${r.why ? `. ${r.why}` : ""}; задача не ушла`);
        }
        const task = await host.request("message", { to: callsign, text, from: me });
        if (!task.ok) return fail(`открыта: ${shown}, но задача не доставлена — ${task.error}`);
        return say(`открыта: ${shown}; задача во вводе, итог хода придёт сам${word ? `; проект не записан: ${word}` : ""}`);
      },
    ),

    tool(
      "history",
      "Что делала сессия: последние записи разговора — ввод, ответы, вызванные инструменты.",
      { callsign: z.string(), limit: z.number().int().min(1).optional().describe("сколько записей; по умолчанию 20") },
      async ({ callsign, limit }) => {
        const { host } = env();
        const shut = closed(host, me, callsign, true);
        if (shut) return fail(shut);
        const r = await host.request("session.history", { callsign, limit: limit ?? 20, before: null, from: me });
        return r.ok ? say(historyLines((r.result as { messages: Record_[] }).messages)) : fail(refusal(callsign, r));
      },
    ),

    tool(
      "update",
      "Сменить сессии слот, профиль, модель, усилие, заголовок разговора или проект. Живой сессии модель и усилие — сразу, слот и профиль — перезапуском между ходами, разговор продолжается. Слот меняется первым, профиль вторым: отказ не меняет остального. wing — настройки ведомого этой сессии: нет его — откроет; null — снимет.",
      {
        callsign: z.string(),
        slot: z.string().optional().describe("имя слота машины этой сессии или ключа флота"),
        profile: z.array(z.string()).optional().describe("заменить список кусочков: нижний выигрывает, пустой — без кусочков"),
        model: z.string().optional(),
        effort: z.string().optional(),
        title: z.string().optional(),
        project: z.string().optional().describe("имя проекта: конец его списка, нет такого — создастся; пустая строка — без проекта"),
        wing: WING.nullable().optional().describe("настройки ведомого: профиль, модель, усилие, слот; null — снять ведомого"),
      },
      async ({ callsign, slot, profile, model, effort, title, project, wing }) => {
        const { host, records } = env();
        const shut = closed(host, me, callsign, false);
        if (shut) return fail(shut);
        const done: string[] = [];
        const said = await swap(host, callsign, { slot, profile }, done);
        if (said) return fail([...done, said].join("; "));
        if (project !== undefined) {
          const word = await place(records, callsign, project);
          if (word) return fail([...done, `Не выполнено: проект ${callsign} — ${word}`].join("; "));
          done.push(project.trim() ? `проект ${callsign}: ${project.trim()}` : `${callsign}: без проекта`);
        }
        if (wing !== undefined) {
          const word = await setWing(host, callsign, wing, done);
          if (word) return fail([...done, word].join("; "));
        }
        if (!done.length || model || effort || title) {
          const r = await host.request("session.update", { callsign, ...filled({ model, effort, title }), from: me });
          if (!r.ok) return fail(refusal(callsign, r));
          done.push(`сразу: ${(r.result as { now: string[] }).now.join(", ") || "—"}`);
        }
        return say(done.join("; "));
      },
    ),

    tool(
      "profile",
      "Что получит сессия с этим списком кусочков — тот же ответ, что на экране профилей. Без списка — кусочки и наборы машины, её слоты, ключи флота с моделями и клоны репозиториев. Новый кусочек пишется файлами в клоне: отправит сведение.",
      {
        machine: z.string().optional().describe("машина; по умолчанию — твоя"),
        profile: z.array(z.string()).optional().describe("кусочки по порядку"),
      },
      async ({ machine, profile }) => {
        const e = env();
        const where = machine ?? e.host.machine;
        if (!profile) return say(JSON.stringify(await machineView(e, where)));
        const r = await e.host.read("profile.view", { machine: where, profile });
        return r.ok ? say(JSON.stringify(r.result)) : fail(refusal(where, r));
      },
    ),

    tool(
      "repos",
      "Подключить и убрать репозитории кусочков: один список на весь флот. Машины сами клонируют, сводят и убирают клоны. Без параметров — нынешний список.",
      {
        add: z.array(z.string()).optional().describe("подключить: владелец/имя"),
        remove: z.array(z.string()).optional().describe("убрать: владелец/имя"),
      },
      async ({ add = [], remove = [] }) => {
        const { records } = env();
        const bad = add.find((r) => !REPO.test(r));
        if (bad) return fail(`Не выполнено: ${bad} — нужно владелец/имя`);
        if (!add.length && !remove.length) {
          const word = await records.read();
          return word ? fail(`Не выполнено: список репозиториев — ${word}`) : say(JSON.stringify(records.get<string[]>(PROFILE_REPOS) ?? []));
        }
        const word = await records.edit<string[]>(PROFILE_REPOS, (old = []) => [...new Set([...old.filter((r) => !remove.includes(r)), ...add])]);
        if (word) return fail(`Не выполнено: список репозиториев — ${word}`);
        return say(JSON.stringify(records.get<string[]>(PROFILE_REPOS)));
      },
    ),

    tool(
      "label",
      "Имя в интерфейсе: сессии (site@laptop) или машины (@laptop); адрес остаётся адресом. Пустой текст снимает имя.",
      { to: z.string().describe("callsign сессии или @машина"), text: z.string().describe("имя; пустое — снять") },
      async ({ to, text }) => {
        const kind = kindOf(to);
        if (kind !== "session" && kind !== "machine") return fail(`Не выполнено: ${to} — не сессия и не машина`);
        const { host, records } = env();
        const shut = closed(host, me, to, false);
        if (shut) return fail(shut);
        const word = await records.edit<Labels>(LABELS, (labels) => setLabel(labels, to, text));
        if (word) return fail(`Не выполнено: имя ${to} — ${word}`);
        return say(text.trim() ? `имя ${to}: ${text.trim()}` : `имя ${to} снято`);
      },
    ),

    tool(
      "remove",
      "Закрыть сессию: она забыта, разговор остаётся на диске машины. Другую — сразу; без callsign — себя, после этого хода.",
      { callsign: z.string().optional() },
      async ({ callsign = me }) => {
        const { host } = env();
        const shut = closed(host, me, callsign, false);
        if (shut) return fail(shut);
        const self = callsign === me;
        const r = await host.request("session.remove", { callsign, from: me, ...(self ? { after_turn: true } : {}) });
        return ok(callsign, self ? "закроюсь после этого хода" : `закрыта: ${callsign}`)(r);
      },
    ),
  ];
}
