// Договор «Фабрики»: тикет — единица работы флота; шаг тикета кончается вердиктом; служба отдаёт шаг сессии запросом «дать работу».
import { Callsign, MachineAddr, Name, request, z } from "../define.ts";
import { Spec } from "./session.ts";

/** Вердикт шага: done — сдал, тикет идёт дальше; back — вернул назад с замечанием; stop — нужен человек. */
export const Verdict = z.enum(["done", "back", "stop"]);
export type Verdict = z.infer<typeof Verdict>;
/** Состояние тикета: ready — в очереди (без исполнителя — бэклог); work — шаг у сессии; wait — ждёт человека или события; stop — встал с причиной; done — закрыт. */
export const TicketState = z.enum(["ready", "work", "wait", "stop", "done"]);
export type TicketState = z.infer<typeof TicketState>;
/** Срок словами: число и единица — s, m, h или d. */
export const Term = z.string().regex(/^[1-9]\d*[smhd]$/, "срок вида 90s, 20m, 2h или 3d");
const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** Срок в миллисекундах. */
export const termMs = (t: string): number => Number(t.slice(0, -1)) * UNIT[t.at(-1)!]!;

export const TicketNote = z.object({ at: z.number(), by: z.string(), verdict: Verdict.optional(), text: z.string() });
export type TicketNote = z.infer<typeof TicketNote>;
export const Ticket = z.object({
  /** номер: проект и порядковое число, poe2-41 */
  id: z.string(), project: z.string(), title: z.string(), text: z.string(),
  /** исполнитель: позывной сессии; нет — тикет в бэклоге */
  to: z.string().optional(),
  step: z.number(), state: TicketState,
  /** сессия, которая ведёт шаг */
  session: Callsign.optional(),
  /** кто создал: человек, сессия или машина */
  by: z.string(),
  /** причина у stop */
  why: z.string().optional(),
  key: z.string().optional(), tag: z.string().optional(), pr: z.string().optional(),
  /** возвратов на нынешнем шаге */
  returns: z.number(),
  since: z.number(), moved: z.number(),
  /** срок шага в работе, мс */
  until: z.number().optional(),
  /** закрыт без работы */
  dropped: z.boolean().optional(),
  /** заметки с вердиктами — у тикета, названного по номеру */
  notes: z.array(TicketNote).optional(),
});
export type Ticket = z.infer<typeof Ticket>;

export const ticketNew = request("ticket.new", {
  owner: "factory", target: "service",
  tool: "Создать тикет — единицу работы с номером, исполнителем и вердиктом. Бери, чтобы дать сессии задачу, которая не потеряется: остановленную сессию тикет поднимет сам, а исход вернётся вердиктом. to — позывной сессии-исполнителя (нет — тикет ляжет в бэклог проекта); for — срок работы: 20m, 2h, 1d (исполнителю-сессии обязателен); title и text — что сделать и что считать готовым; project — номер проекта (сессии не нужен: возьмётся её проект). Ответ: id — номер тикета. Отказы: no_project, no_term (не назван срок), no_session (такой сессии нет).",
  example: { to: "coder-move@laptop", for: "2h", title: "Обход не останавливается у поля", text: "Готово: эталон остановки зелёный." },
  input: z.object({ project: z.string().optional(), to: z.string().optional(), title: z.string().min(1), text: z.string().optional(), tag: z.string().optional(), key: z.string().optional(), for: Term.optional() }),
  output: z.object({ id: z.string() }),
});

export const ticketList = request("ticket.list", {
  owner: "factory", target: "service",
  tool: "Тикеты проекта. Бери, чтобы увидеть бэклог, работу в ходу и вставшее. ticket — один тикет по номеру, с заметками и вердиктами; state — ready (очередь и бэклог), work, wait, stop, done; to — исполнитель; session — кто ведёт шаг; project — номер проекта (сессии не нужен). Ответ: tickets, новые первыми; у stop — why.",
  example: { state: "stop" }, reads: true,
  input: z.object({ project: z.string().optional(), ticket: z.string().optional(), to: z.string().optional(), state: TicketState.optional(), session: Callsign.optional() }),
  output: z.object({ tickets: z.array(Ticket) }),
});

export const ticketSet = request("ticket.set", {
  owner: "factory", target: "service",
  tool: "Сдать шаг тикета или изменить тикет. Шаг кончается вердиктом: verdict done — сделано; back — вернуть назад с замечанием; stop — нужен человек. note — заметка к вердикту: что сделано, замечание или вопрос. Вердикт шагу в работе даёт только сессия, которая его ведёт, или человек. Человеку и менеджеру: to — назначить исполнителя; resume: true — вернуть вставший тикет в очередь; drop: true — снять без работы; pr — номер PR вида owner/repo#12. Отказы: not_yours (шаг ведёт другая сессия), no_ticket, bad_state.",
  example: { ticket: "poe2-41", verdict: "done", note: "3 среза, эталоны 12 из 12" },
  input: z.object({ ticket: z.string(), verdict: Verdict.optional(), note: z.string().optional(), to: z.string().optional(), for: Term.optional(), resume: z.boolean().optional(), drop: z.boolean().optional(), pr: z.string().optional() }),
  output: z.object({ id: z.string(), state: TicketState, step: z.number() }),
});

/** Дать работу сессии машины: сессии с таким именем нет — открыть по документу spec; остановлена — поднять; затем ввод тегом вида ticket.
 *  Зовёт только служба «Фабрика» (.factory). on — имя правила входа: текст события — данные, а не команды. */
export const workGive = request("work.give", {
  owner: "host-work", target: "machine",
  input: z.object({ to: MachineAddr, name: Name, spec: Spec.optional(), ticket: z.string(), step: z.string().optional(), on: z.string().optional(), key: z.string().optional(), text: z.string() }),
  output: z.object({ callsign: Callsign }),
});
