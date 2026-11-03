// Модуль fleet: сессии флота видят друг друга, пишут, открывают и ведут других — как в десктоп-приложении Claude.
// Каждой сессии — сервер MCP fleet: list, send, answer, open, history, update, remove; открыть, прочитать, сменить модель
// и закрыть — запросы manage и chat, fleet их только зовёт. Чужое сообщение — запрос message: текст с отправителем
// ложится во ввод с priority "next" (простаивающая просыпается, занятая читает на границе шага). Адресата нет — отказ сразу.
// Итог хода: ход кончился, отправитель последнего ввода — родитель сессии (поле parent от manage этой машины), и это сессия, —
// текст result уходит родителю тем же message. Своего хранения нет: проекты и имена — записи области флота у службы настроек, формат — у records.
import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Ctx, Frame, Host, Module, Result, SDKMessage, Session } from "@switchboard/host";
import { addProject, FLEET_PREFIX, LABELS, labelOf, NONE, placeSessions, PROJECTS, projectByName, projectIdOf, setLabel, settings, type Labels, type ProjectRec, type Settings } from "@switchboard/records";
import { kindOf } from "@switchboard/protocol";
import { refuse } from "@switchboard/host";

type RosterSession = { callsign: string; state?: string | null; parent?: string; model?: string };
type Roster = { sessions?: RosterSession[]; machines?: Array<{ machine: string }>; clients?: string[] };
type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const text = (t: string, isError = false): Text => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** Что видит модель адресата: отправитель в тексте — поле origin модель не видит (опыт 12). */
export const wrap = (from: string, body: string) => `<fleet-message from="${from}">\n${body}\n</fleet-message>`;

/** Задача от родителя: подсказка рядом с ней — строку системного промпта модель пропускает и отвечает fleet.send (живой прогон 1 нояб.). */
export const task = (from: string, body: string) => `${wrap(from, body)}\n(Задача от родителя ${from}: итог этого хода уйдёт ему сам — fleet.send ему не нужен.)`;

/** Строка в системный промпт: модель знает свой позывной (опыт 13) и как вести другие сессии. */
export const prompt = (me: string) =>
  `Ты во флоте как ${me}. Кто на связи — fleet.list; написать сессии или человеку — fleet.send. ` +
  `Открыть сессию с задачей — fleet.open: она твоя дочь, итог каждого её хода, начатого тобой, придёт сам тегом <fleet-message from="…">. ` +
  `Проект сессии — параметр project у fleet.open и fleet.update, имя в интерфейсе — fleet.label. Что делала сессия — fleet.history; модель, усилие, заголовок — fleet.update; закрыть — fleet.remove (без callsign — себя, после этого хода). ` +
  `Сообщения флота приходят во ввод тегом <fleet-message from="…">; вопрос другой сессии — тегом <fleet-question>, ответ на него — fleet.answer. ` +
  `Если тебя открыла другая сессия, итог твоего хода, начатого ею, уйдёт ей сам — отвечать ей отдельно не нужно.`;

/** Отказ словом — текстом для модели. */
function failed(to: string, r: Result & { ok: false }): Text {
  if (r.error === "offline") return text(`Не доставлено: ${to} не на связи (offline)`, true);
  if (r.error === "disconnected") return text(`Доставка не подтверждена: нет связи с relay (disconnected)`, true);
  return text(`Не выполнено: ${to} — ${r.error}`, true);
}

type Block = { type?: string; text?: string; name?: string };
type Entry = { type?: string; message?: { content?: string | Block[] } };

/** Записи разговора — строками для модели: ввод, ответы, вызванные инструменты. */
export function lines(messages: Entry[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.type !== "user" && m.type !== "assistant") continue;
    const c = m.message?.content;
    const blocks: Block[] = typeof c === "string" ? [{ type: "text", text: c }] : (c ?? []);
    for (const b of blocks) {
      if (b.type === "text" && b.text) out.push(`${m.type}: ${b.text}`);
      else if (b.type === "tool_use" && b.name) out.push(`tool: ${b.name}`);
    }
  }
  return out.join("\n") || "записей нет";
}

export function make() {
  let host: Host;
  /** записи области флота: правки этой машины идут по одной, остановка их дожидается */
  let meta: Settings;

  /** Поставить сессию в конец проекта по имени; нет такого — проект создаётся; пустое имя — «Без проекта». Ответ — слово отказа или null. */
  const assign = (callsign: string, project: string) =>
    meta.edit<ProjectRec[]>(PROJECTS, (old) => {
      if (!project.trim()) return placeSessions(old, [callsign], NONE);
      const had = projectByName(old, project);
      if (had) return placeSessions(old, [callsign], had.id);
      const made = addProject(old, project);
      return placeSessions(made.recs, [callsign], made.id);
    });

  /** Инструменты сервера MCP одной сессии: отправитель — сама сессия, в аргументах его нет. */
  function tools(me: string): SdkMcpToolDefinition<any>[] {
    return [
      tool("list", "Кто на связи: сессии флота с состоянием, родителем, моделью, именем и проектом; машины с именами; проекты; клиенты (телефон, пульт).", {}, async () => {
        const roster = host.roster() as Roster | null;
        if (!roster) return text("Нет связи с relay (disconnected): список сессий неизвестен", true);
        // служба настроек не ответила — список сессий всё равно приходит, а вместо меток слово причины
        const word = await meta.read();
        const recs = word ? undefined : meta.get<ProjectRec[]>(PROJECTS);
        const labels = word ? undefined : meta.get<Labels>(LABELS);
        const list = roster.sessions ?? [];
        const parentOf = (cs: string) => list.find((s) => s.callsign === cs)?.parent;
        const projectName = (cs: string) => {
          const id = projectIdOf(recs, cs, parentOf);
          return id === NONE ? null : (recs?.find((r) => r.id === id)?.name ?? null);
        };
        const sessions = list.map((s) => ({ callsign: s.callsign, state: s.state ?? null, parent: s.parent ?? null, model: s.model ?? null, label: labelOf(labels, s.callsign) ?? null, project: projectName(s.callsign) }));
        const machines = (roster.machines ?? []).map((m) => ({ machine: m.machine, label: labelOf(labels, `@${m.machine}`) ?? null }));
        const projects = (recs ?? []).filter((r) => r.id !== NONE).map((r) => r.name);
        return text(JSON.stringify({ me, sessions, machines, projects, clients: roster.clients ?? [], ...(word ? { meta: `имена и проекты недоступны: ${word}` } : {}) }));
      }),
      tool(
        "send",
        "Написать сессии флота (callsign имя@машина) или человеку: всем его устройствам ~email или одному устройство~email. Ответа адресата не ждёт.",
        { to: z.string().describe("callsign сессии, ~email человека или устройство~email"), text: z.string().describe("текст сообщения") },
        async ({ to, text: body }) => {
          if (kindOf(to) === "session") {
            const r = await host.request("message", { to, text: body, from: me });
            return r.ok ? text(`доставлено: ${to}`) : failed(to, r);
          }
          // клиенту — кадр без подтверждения; кого нет на связи, достанет пушем модуль push
          const r = host.emit({ type: "message", from: me, to, text: body });
          if (!r.ok) return failed(to, r);
          void host.request("notify", { clients: [to], frame: { type: "message", from: me, notify: { title: me, body, tag: randomUUID() } } });
          return text(`отправлено: ${to}`);
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
          const r = await host.request("answer", { callsign: to, question, answers, from: me });
          return r.ok ? text("принято") : failed(to, r);
        },
      ),
      tool(
        "open",
        "Открыть сессию с задачей на любой машине флота. Она твоя дочь: итог каждого её хода, начатого тобой, придёт сам.",
        {
          name: z.string().describe("имя сессии: буквы, цифры, . _ -"),
          dir: z.string().describe("папка: от ~ или полный путь"),
          text: z.string().describe("задача — первое сообщение сессии"),
          machine: z.string().optional().describe("машина; по умолчанию — твоя"),
          profile: z.string().optional().describe("профиль сессии"),
          model: z.string().optional(),
          effort: z.string().optional(),
          project: z.string().optional().describe("имя проекта: сессия встанет в его конец, нет такого — создастся; без него — в проект открывшей"),
        },
        async ({ name, dir, text: body, machine, profile, model, effort, project }) => {
          const where = machine ?? host.machine;
          const opt = { ...(profile ? { profile } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
          const o = await host.request("session.open", { machine: where, name, dir, ...opt, from: me });
          if (!o.ok) return failed(`${name}@${where}`, o);
          const cs = (o.result as { callsign: string }).callsign;
          const word = project === undefined ? null : await assign(cs, project);
          const note = word ? `; проект не записан: ${word}` : "";
          const m = await host.request("message", { to: cs, text: body, from: me });
          return m.ok ? text(`открыта: ${cs}; задача во вводе, итог хода придёт сам${note}`) : text(`открыта: ${cs}, но задача не доставлена — ${m.error}`, true);
        },
      ),
      tool(
        "history",
        "Что делала сессия: последние записи разговора — ввод, ответы, вызванные инструменты.",
        { callsign: z.string(), limit: z.number().int().min(1).optional().describe("сколько записей; по умолчанию 20") },
        async ({ callsign, limit }) => {
          const r = await host.request("session.history", { callsign, limit: limit ?? 20, before: null, from: me });
          if (!r.ok) return failed(callsign, r);
          return text(lines((r.result as { messages: Entry[] }).messages));
        },
      ),
      tool(
        "update",
        "Сменить сессии модель, усилие, заголовок разговора или проект. Живой сессии модель и усилие — сразу.",
        { callsign: z.string(), model: z.string().optional(), effort: z.string().optional(), title: z.string().optional(), project: z.string().optional().describe("имя проекта: конец его списка, нет такого — создастся; пустая строка — без проекта") },
        async ({ callsign, model, effort, title, project }) => {
          if (project !== undefined) {
            const word = await assign(callsign, project);
            if (word) return text(`Не выполнено: проект ${callsign} — ${word}`, true);
            if (!model && !effort && !title) return text(project.trim() ? `проект ${callsign}: ${project.trim()}` : `${callsign}: без проекта`);
          }
          const r = await host.request("session.update", { callsign, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(title ? { title } : {}), from: me });
          return r.ok ? text(`сразу: ${((r.result as { now: string[] }).now ?? []).join(", ") || "—"}`) : failed(callsign, r);
        },
      ),
      tool(
        "label",
        "Имя в интерфейсе: сессии (site@laptop) или машины (@laptop); адрес остаётся адресом. Пустой текст снимает имя.",
        { to: z.string().describe("callsign сессии или @машина"), text: z.string().describe("имя; пустое — снять") },
        async ({ to, text: name }) => {
          const k = kindOf(to);
          if (k !== "session" && k !== "machine") return text(`Не выполнено: ${to} — не сессия и не машина`, true);
          const word = await meta.edit<Labels>(LABELS, (old) => setLabel(old, to, name));
          if (word) return text(`Не выполнено: имя ${to} — ${word}`, true);
          return text(name.trim() ? `имя ${to}: ${name.trim()}` : `имя ${to} снято`);
        },
      ),
      tool(
        "remove",
        "Закрыть сессию: она забыта, разговор остаётся на диске машины. Другую — сразу; без callsign — себя, после этого хода.",
        { callsign: z.string().optional() },
        async ({ callsign }) => {
          const target = callsign ?? me;
          const self = target === me;
          const r = await host.request("session.remove", { callsign: target, ...(self ? { after_turn: true } : {}), from: me });
          if (!r.ok) return failed(target, r);
          return text(self ? "закроюсь после этого хода" : `закрыта: ${target}`);
        },
      ),
    ];
  }

  /**
   * Сообщение во ввод сессии этой машины; отправитель — от Host или relay. report: true — итог хода дочери:
   * отправитель последнего ввода у адресата прежний — вопрос родителя уходит тому, кто дал ему задачу, а не дочери.
   */
  function message(req: Frame, ctx: Ctx): void {
    const to = req.to;
    if (typeof to !== "string" || typeof req.text !== "string") throw refuse("bad_frame", "message: нужны to — callsign и text");
    const s = host.session(to);
    if (!s || s.state === "stopped" || s.state === "failed") throw refuse("offline", `${to}: ${s ? `сессия ${s.state}` : "сессии нет на машине"}`);
    const from = ctx.from ?? "";
    const fromParent = req.report !== true && !!from && s.field("parent") === from;
    s.input(fromParent ? task(from, req.text) : wrap(from, req.text), { ...(req.report === true ? {} : { from }), priority: "next", uuid: randomUUID(), origin: { kind: "peer", from, name: from } });
  }

  /** Конец хода: последний ввод от родителя-сессии — итог ему тем же message. Родитель — поле manage этой машины: relay не нужен. */
  function report(s: Session, m: SDKMessage): void {
    const me = s.info.callsign;
    const from = s.info.from;
    const parent = s.field("parent");
    if (typeof parent !== "string" || kindOf(parent) !== "session" || from !== parent) return;
    const r = m as { subtype: string; is_error?: boolean; result?: string };
    const body = r.subtype === "success" && !r.is_error ? (r.result ?? "") : `ход кончился: ${r.subtype}`;
    void host.request("message", { to: parent, text: body, report: true, from: me }).then((x) => {
      if (!x.ok) host.log({ kind: "note", ev: "report", word: x.error, callsign: me, why: `итог хода родителю ${parent} не доставлен: ${x.error}` });
    });
  }

  const mod: Module = {
    session: (s) => ({
      mcpServers: { fleet: createSdkMcpServer({ name: "fleet", version: "1.4.0", tools: tools(s.info.callsign) }) },
      append: prompt(s.info.callsign),
      // переписка между сессиями — только через fleet: рубильник Claude Code убирает ListAgents и доставку
      // SendMessage чужим сессиям в обе стороны; SendMessage своим субагентам остаётся (исключение устава, слово 1 нояб.)
      env: { CLAUDE_CODE_HARBOR_KITE: "0" },
    }),
    requests: { message },
    on: {
      event(s, m) {
        if (m.type === "result") report(s, m);
      },
    },
    start(h) {
      host = h;
      meta = settings({ ask: (name, body) => h.request(name, body) as never, prefix: FLEET_PREFIX, scope: "global" });
    },
    // своего хранить нечего; правки записей доходят до службы
    stop: () => meta.settled(),
  };
  return { module: mod, tools };
}
