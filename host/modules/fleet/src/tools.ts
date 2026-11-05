// Инструменты MCP сессии: зовут чужие запросы от её имени и пишут ответ словами для модели. Отправитель — сама сессия, в аргументах его нет.
import { randomUUID } from "node:crypto";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Host, Result } from "@switchboard/host";
import { addProject, LABELS, labelOf, NONE, placeSessions, PROJECTS, projectByName, projectIdOf, setLabel, type Labels, type ProjectRec, type Settings } from "@switchboard/records";
import { kindOf } from "@switchboard/protocol";
import { linesOf, type Entry } from "./prompt.ts";

type RosterSession = { callsign: string; state?: string | null; parent?: string; model?: string };
type Roster = { sessions?: RosterSession[]; machines?: Array<{ machine: string }>; clients?: string[] };

/** Что нужно инструментам; появляется при старте модуля. */
export type Env = { host: Host; meta: Settings };

const say = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

/** Отказ словом — текстом для модели; причина владельца — следом: список слотов машины и подобное. */
function failed(to: string, r: Result & { ok: false }) {
  if (r.error === "offline") return say(`Не доставлено: ${to} не на связи (offline)`, true);
  if (r.error === "disconnected") return say(`Доставка не подтверждена: нет связи с relay (disconnected)`, true);
  if (r.error === "timeout") return say(`Не выполнено: ${to} — timeout: исход неизвестен, проверь list`, true);
  return say(`Не выполнено: ${to} — ${r.error}${typeof r.why === "string" && r.why ? `. ${r.why}` : ""}`, true);
}

/** Поставить сессию в конец проекта по имени; нет такого — проект создаётся; пустое имя — «Без проекта». Ответ — слово отказа или null. */
const assign = (meta: Settings, callsign: string, project: string) =>
  meta.edit<ProjectRec[]>(PROJECTS, (old) => {
    if (!project.trim()) return placeSessions(old, [callsign], NONE);
    const had = projectByName(old, project);
    if (had) return placeSessions(old, [callsign], had.id);
    const made = addProject(old, project);
    return placeSessions(made.recs, [callsign], made.id);
  });

export function fleetTools(me: string, env: Env): SdkMcpToolDefinition<any>[] {
  return [
    tool("list", "Кто на связи: сессии флота с состоянием, родителем, моделью, именем и проектом; машины с именами; проекты; клиенты (телефон, пульт).", {}, async () => {
      const roster = env.host.roster() as Roster | null;
      if (!roster) return say("Нет связи с relay (disconnected): список сессий неизвестен", true);
      // служба настроек не ответила — список сессий всё равно приходит, а вместо меток слово причины
      const word = await env.meta.read();
      const recs = word ? undefined : env.meta.get<ProjectRec[]>(PROJECTS);
      const labels = word ? undefined : env.meta.get<Labels>(LABELS);
      const list = roster.sessions ?? [];
      const parentOf = (cs: string) => list.find((s) => s.callsign === cs)?.parent;
      const projectName = (cs: string) => {
        const id = projectIdOf(recs, cs, parentOf);
        return id === NONE ? null : (recs?.find((r) => r.id === id)?.name ?? null);
      };
      return say(
        JSON.stringify({
          me,
          sessions: list.map((s) => ({ callsign: s.callsign, state: s.state ?? null, parent: s.parent ?? null, model: s.model ?? null, label: labelOf(labels, s.callsign) ?? null, project: projectName(s.callsign) })),
          machines: (roster.machines ?? []).map((m) => ({ machine: m.machine, label: labelOf(labels, `@${m.machine}`) ?? null })),
          projects: (recs ?? []).filter((r) => r.id !== NONE).map((r) => r.name),
          clients: roster.clients ?? [],
          ...(word ? { meta: `имена и проекты недоступны: ${word}` } : {}),
        }),
      );
    }),
    tool(
      "send",
      "Написать сессии флота (callsign имя@машина) или человеку: всем его устройствам ~email или одному устройство~email. Ответа адресата не ждёт.",
      { to: z.string().describe("callsign сессии, ~email человека или устройство~email"), text: z.string().describe("текст сообщения") },
      async ({ to, text }) => {
        if (kindOf(to) === "session") {
          const r = await env.host.request("message", { to, text, from: me });
          return r.ok ? say(`доставлено: ${to}`) : failed(to, r);
        }
        // клиенту — кадр без подтверждения; кого нет на связи, достанет пушем модуль push
        const r = env.host.emit({ type: "message", from: me, to, text });
        if (!r.ok) return failed(to, r);
        void env.host.request("notify", { clients: [to], frame: { type: "message", from: me, notify: { title: me, body: text, tag: randomUUID() } } });
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
        const r = await env.host.request("answer", { callsign: to, question, answers, from: me });
        return r.ok ? say("принято") : failed(to, r);
      },
    ),
    tool(
      "open",
      "Открыть сессию с задачей на любой машине флота. Она твоя дочь: итог каждого её хода, начатого тобой, придёт сам. Без параметра slot: на машине один слот — он, слотов нет — общий вход, а без него слот main из вошедших аккаунтов (их нет — отказ), два и больше — отказ со списком слотов.",
      {
        name: z.string().describe("имя сессии: буквы, цифры, . _ -"),
        dir: z.string().describe("папка: от ~ или полный путь"),
        text: z.string().describe("задача — первое сообщение сессии"),
        machine: z.string().optional().describe("машина; по умолчанию — твоя"),
        profile: z.string().optional().describe("профиль сессии"),
        model: z.string().optional(),
        effort: z.string().optional(),
        slot: z.string().optional().describe("имя слота машины"),
        project: z.string().optional().describe("имя проекта: сессия встанет в его конец, нет такого — создастся; без него — в проект открывшей"),
      },
      async ({ name, dir, text, machine, profile, model, effort, slot, project }) => {
        const where = machine ?? env.host.machine;
        const o = await env.host.request("session.open", { machine: where, name, dir, ...(profile ? { profile } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(slot !== undefined ? { slot } : {}), from: me });
        if (!o.ok) return failed(`${name}@${where}`, o);
        const { callsign, slot: inSlot } = o.result as { callsign: string; slot?: string | null };
        const opened = inSlot ? `${callsign} · слот ${inSlot}` : callsign;
        const word = project === undefined ? null : await assign(env.meta, callsign, project);
        const m = await env.host.request("message", { to: callsign, text, from: me });
        if (!m.ok) return say(`открыта: ${opened}, но задача не доставлена — ${m.error}`, true);
        return say(`открыта: ${opened}; задача во вводе, итог хода придёт сам${word ? `; проект не записан: ${word}` : ""}`);
      },
    ),
    tool(
      "history",
      "Что делала сессия: последние записи разговора — ввод, ответы, вызванные инструменты.",
      { callsign: z.string(), limit: z.number().int().min(1).optional().describe("сколько записей; по умолчанию 20") },
      async ({ callsign, limit }) => {
        const r = await env.host.request("session.history", { callsign, limit: limit ?? 20, before: null, from: me });
        return r.ok ? say(linesOf((r.result as { messages: Entry[] }).messages)) : failed(callsign, r);
      },
    ),
    tool(
      "update",
      "Сменить сессии слот, модель, усилие, заголовок разговора или проект. Живой сессии модель и усилие — сразу, слот — перезапуском между ходами. Слот меняется первым: его отказ не меняет остального.",
      {
        callsign: z.string(),
        slot: z.string().optional().describe("имя слота машины этой сессии"),
        model: z.string().optional(),
        effort: z.string().optional(),
        title: z.string().optional(),
        project: z.string().optional().describe("имя проекта: конец его списка, нет такого — создастся; пустая строка — без проекта"),
      },
      async ({ callsign, slot, model, effort, title, project }) => {
        const more = !!(model || effort || title);
        let moved = "";
        if (slot !== undefined) {
          const r = await env.host.request("session.slot", { callsign, slot, from: me });
          if (!r.ok) return failed(callsign, r);
          moved = `слот ${slot}${(r.result as { restart?: boolean }).restart ? "; перезапуск между ходами" : ""}`;
          if (project === undefined && !more) return say(moved);
          moved += "; ";
        }
        if (project !== undefined) {
          const word = await assign(env.meta, callsign, project);
          if (word) return say(`${moved}Не выполнено: проект ${callsign} — ${word}`, true);
          if (!more) return say(moved + (project.trim() ? `проект ${callsign}: ${project.trim()}` : `${callsign}: без проекта`));
        }
        const r = await env.host.request("session.update", { callsign, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(title ? { title } : {}), from: me });
        return r.ok ? say(`${moved}сразу: ${(r.result as { now: string[] }).now.join(", ") || "—"}`) : failed(callsign, r);
      },
    ),
    tool(
      "label",
      "Имя в интерфейсе: сессии (site@laptop) или машины (@laptop); адрес остаётся адресом. Пустой текст снимает имя.",
      { to: z.string().describe("callsign сессии или @машина"), text: z.string().describe("имя; пустое — снять") },
      async ({ to, text: name }) => {
        const kind = kindOf(to);
        if (kind !== "session" && kind !== "machine") return say(`Не выполнено: ${to} — не сессия и не машина`, true);
        const word = await env.meta.edit<Labels>(LABELS, (old) => setLabel(old, to, name));
        if (word) return say(`Не выполнено: имя ${to} — ${word}`, true);
        return say(name.trim() ? `имя ${to}: ${name.trim()}` : `имя ${to} снято`);
      },
    ),
    tool(
      "remove",
      "Закрыть сессию: она забыта, разговор остаётся на диске машины. Другую — сразу; без callsign — себя, после этого хода.",
      { callsign: z.string().optional() },
      async ({ callsign = me }) => {
        const self = callsign === me;
        const r = await env.host.request("session.remove", { callsign, ...(self ? { after_turn: true } : {}), from: me });
        if (!r.ok) return failed(callsign, r);
        return say(self ? "закроюсь после этого хода" : `закрыта: ${callsign}`);
      },
    ),
  ];
}
