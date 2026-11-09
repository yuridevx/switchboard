// Сессия: документ, строка картины, жизненный цикл (ядро Host) и разговор (модуль chat).
import { Callsign, Done, Empty, frame, MachineAddr, Name, Person, request, z } from "../define.ts";

/** Состояния сессии. */
export const SessionState = z.enum(["starting", "idle", "busy", "waiting", "stopping", "stopped", "failed"]);
export type SessionState = z.infer<typeof SessionState>;

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
/** Режим разрешений: all — разрешено всё (по умолчанию), ask — спрашивать, plan — только план, edits — правки без вопросов. */
export const Mode = z.enum(["all", "ask", "plan", "edits"]);

/** Документ сессии: у каждого ключа один хозяин. Ядро: name, cwd, model, effort, mode, parent, wing, project.
 *  accounts: account · profiles: pieces · points: backup · remote: remote. */
export const Spec = z.object({
  name: Name,
  cwd: z.string().min(1),
  model: z.string().optional(),
  effort: Effort.optional(),
  mode: Mode.optional(),
  /** сессия, которая дала задачу: ей уходит итог хода */
  parent: Callsign.optional(),
  /** ведомый пары */
  wing: Callsign.optional(),
  /** проект доски */
  project: z.string().optional(),
  /** вход Claude или ключ флота; auto — выбирает модуль аккаунтов по лимитам */
  account: z.string().optional(),
  /** кусочки профиля */
  pieces: z.array(z.string()).optional(),
  /** сохранять точки в архив */
  backup: z.boolean().optional(),
  /** открыть в приложении Claude (Remote Control) */
  remote: z.boolean().optional(),
});
export type Spec = z.infer<typeof Spec>;
export const SpecPatch = Spec.partial().omit({ name: true });
export type SpecPatch = z.infer<typeof SpecPatch>;

/** Вопрос сессии человеку: живёт в строке сессии, пока не отвечен. */
export const Ask = z.object({
  id: z.string(),
  kind: z.enum(["question", "permission", "plan", "form", "url"]),
  title: z.string().optional(),
  text: z.string(),
  /** варианты ответа у question; у permission — allow, allow_always, deny */
  options: z.array(z.object({ label: z.string(), about: z.string().optional() })).optional(),
  multi: z.boolean().optional(),
  /** инструмент и его ввод у permission */
  tool: z.string().optional(),
  input: z.unknown().optional(),
  /** схема формы у form */
  schema: z.unknown().optional(),
  url: z.string().optional(),
  at: z.number(),
});
export type Ask = z.infer<typeof Ask>;

/** Строка сессии в картине флота. Меняется со сменой состояния, вопроса, документа и пометки «непрочитано» — не на каждое событие. */
export const SessionRow = z.object({
  callsign: Callsign,
  state: SessionState,
  spec: Spec,
  /** кто открыл: человек или сессия */
  by: z.string(),
  /** когда открыта и когда кончился последний ход, мс */
  since: z.number(),
  last: z.number().optional(),
  /** заголовок разговора от claude */
  title: z.string().optional(),
  ask: Ask.nullable().optional(),
  /** люди, у которых есть непрочитанное */
  unread: z.array(Person).optional(),
  /** чем занят ход — короткая строка для списка */
  doing: z.string().optional(),
  /** причина failed словами */
  error: z.string().optional(),
  /** аккаунт, на котором идёт сейчас (после выбора auto) */
  account: z.string().optional(),
  /** доля занятого контекста, 0..1 */
  context: z.number().optional(),
  /** ссылка Remote Control, если включён */
  remoteUrl: z.string().optional(),
});
export type SessionRow = z.infer<typeof SessionRow>;

const toSession = z.object({ to: Callsign });

export const sessionOpen = request("session.open", {
  owner: "host", target: "machine",
  tool: "Открыть новую сессию Claude Code на машине: to — машина вида @laptop, spec — документ сессии (name, cwd обязательны). prompt — первое сообщение сессии.",
  input: z.object({ to: MachineAddr, spec: Spec, prompt: z.string().optional() }),
  output: z.object({ callsign: Callsign }),
});

export const sessionUpdate = request("session.update", {
  owner: "host", target: "session",
  tool: "Изменить документ сессии: patch — ключи для замены (model, effort, mode, account, pieces, project, wing, backup, remote, cwd).",
  input: z.object({ to: Callsign, patch: SpecPatch }),
  output: Done,
});

export const sessionStop = request("session.stop", {
  owner: "host", target: "session", tool: "Остановить процесс сессии; разговор сохраняется.",
  input: toSession, output: Done,
});
export const sessionStart = request("session.start", {
  owner: "host", target: "session", tool: "Запустить остановленную сессию: разговор возобновляется.",
  input: toSession, output: Done,
});
export const sessionRemove = request("session.remove", {
  owner: "host", target: "session", tool: "Убрать сессию с машины; точки в архиве остаются.",
  input: toSession, output: Done,
});

/** Проход к методам SDK живой сессии: один список методов — здесь. */
export const SDK_METHODS = [
  "interrupt", "contextUsage", "commands", "models", "agents", "mcpStatus", "mcpToggle", "mcpReconnect", "mcpAuthenticate",
  "rewindFiles", "tasks", "taskStop", "taskOutput", "reload", "sideQuestion", "cancelMessage", "status", "hooks",
] as const;
export const sessionCall = request("session.call", {
  owner: "host", target: "session",
  input: z.object({ to: Callsign, method: z.enum(SDK_METHODS), args: z.unknown().optional() }),
  output: z.unknown(),
});

/* ===== Разговор ===== */

export const FileIn = z.object({ name: z.string(), mime: z.string(), base64: z.string() });

export const message = request("message", {
  owner: "host-chat", target: "session",
  tool: "Написать сессии флота: to — позывной вида site@laptop, text — сообщение. От сессии оно придёт адресату с пометкой отправителя.",
  input: z.object({ to: Callsign, text: z.string(), files: z.array(FileIn).optional() }),
  output: z.object({ queued: z.boolean().optional() }).loose(),
});

/** Событие ленты: сообщение SDK как есть. */
export const SdkEvent = z.object({ type: z.string(), uuid: z.string().optional() }).loose();
export type SdkEvent = z.infer<typeof SdkEvent>;

export const sessionHistory = request("session.history", {
  owner: "host-chat", target: "session",
  tool: "Прочитать разговор сессии страницами с конца: before — uuid, до которого читать.",
  input: z.object({ to: Callsign, before: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({ events: z.array(SdkEvent), more: z.boolean(), seq: z.number() }),
});

export const sessionFiles = request("session.files", {
  owner: "host-chat", target: "session",
  input: z.object({ to: Callsign, q: z.string() }),
  output: z.object({ files: z.array(z.string()) }),
});

export const sessionWatch = request("session.watch", { owner: "host-chat", target: "session", input: toSession, output: z.object({ seq: z.number() }) });
export const sessionUnwatch = request("session.unwatch", { owner: "host-chat", target: "session", input: toSession, output: Done });

/** «Прочитано»: человек дочитал сессию — пометка снимается у него на всех устройствах. */
export const sessionRead = request("session.read", { owner: "host-chat", target: "session", input: toSession, output: Done });

export const answer = request("answer", {
  owner: "host-chat", target: "session",
  tool: "Ответить на вопрос сессии: ask — номер вопроса из строки сессии, answer — ответ. Первый ответ выигрывает.",
  input: z.object({ to: Callsign, ask: z.string(), answer: z.unknown() }),
  output: Done,
});

/** Лента: события пачкой тем, кто смотрит сессию. */
export const sessionEvents = frame("session.events", {
  owner: "host-chat",
  payload: z.object({ callsign: Callsign, seq: z.number(), events: z.array(SdkEvent) }),
});

/** Изменение строки сессии: Host → объект машины → картина флота. row null — сессии больше нет. */
export const sessionState = frame("session.state", {
  owner: "host",
  payload: z.object({ callsign: Callsign, row: SessionRow.partial().nullable() }),
});

/** Снимок машины от Host при подключении: заменяет её строки в картине. */
export const machineHello = frame("machine.hello", {
  owner: "host",
  payload: z.object({ build: z.number(), sdk: z.string().optional(), os: z.string().optional(), sessions: z.array(SessionRow) }),
});

export { Empty };
