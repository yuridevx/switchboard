// Сессия: документ, строка картины, жизненный цикл (ядро Host) и разговор (модуль chat).
import { Callsign, Done, Empty, frame, MachineAddr, Name, Person, request, z } from "../define.ts";

/** Состояния сессии. */
export const SessionState = z.enum(["starting", "idle", "busy", "waiting", "stopping", "stopped", "failed"]);
export type SessionState = z.infer<typeof SessionState>;

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
/** Режим разрешений: all — разрешено всё (по умолчанию), ask — спрашивать, plan — только план, edits — правки без вопросов, auto — решает классификатор Claude. */
export const Mode = z.enum(["all", "ask", "plan", "edits", "auto"]);

/** Документ сессии: у каждого ключа один хозяин. Ядро: name, cwd, model, effort, mode, fast, style, thinking, title, parent, wing, project.
 *  accounts: slot · profiles: pieces · points: backup · remote: remote. */
export const Spec = z.object({
  name: Name,
  cwd: z.string().min(1),
  model: z.string().optional(),
  effort: Effort.optional(),
  mode: Mode.optional(),
  /** быстрый режим Claude */
  fast: z.boolean().optional(),
  /** стиль ответа: имя стиля Claude */
  style: z.string().optional(),
  /** всегда размышлять */
  thinking: z.boolean().optional(),
  /** заголовок разговора в claude.ai; без него заголовок даёт первое сообщение, затем сам Claude */
  title: z.string().optional(),
  /** сессия, которая дала задачу: ей уходит итог хода */
  parent: Callsign.optional(),
  /** ведомый пары */
  wing: Callsign.optional(),
  /** проект доски */
  project: z.string().optional(),
  /** очередь аккаунтов машины или ключ флота: на каком аккаунте сессия идёт сейчас, решает очередь — он в поле account её строки */
  slot: z.string().optional(),
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
  /** у permission: rule — что запишет «Разрешать всегда»; blocked — путь, из-за которого спросили; notes — пояснение причины */
  rule: z.string().optional(),
  blocked: z.string().optional(),
  notes: z.string().optional(),
  at: z.number(),
  /** кому вопрос адресован: тот, кто дал задачу (человек или сессия) */
  to: z.string().optional(),
  /** кто видел вопрос в момент, когда он задан: адресат и зрители сессии */
  seen: z.array(z.string()).optional(),
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
  /** итог последнего хода — начало последнего ответа, для строки «Закончили» */
  result: z.string().optional(),
  /** причина failed словами */
  error: z.string().optional(),
  /** аккаунт, на котором идёт сейчас (после выбора auto) */
  account: z.string().optional(),
  /** доля занятого контекста, 0..1 */
  context: z.number().optional(),
  /** ссылка Remote Control, если включён */
  remoteUrl: z.string().optional(),
  /** Remote Control не включился: причина */
  remoteError: z.string().optional(),
  /** последняя точка в архив не удалась: причина */
  archiveError: z.string().optional(),
  /** когда Host повторит неудавшуюся точку сам, мс; раньше — при конце хода */
  archiveRetryAt: z.number().optional(),
  /** до какого времени Host повторяет неудавшуюся точку сам, мс; после — повторов нет, причина остаётся */
  archiveUntil: z.number().optional(),
  /** идёт сжатие контекста */
  compacting: z.boolean().optional(),
  /** очередь аккаунтов ждёт сброса лимита: когда он наступит, мс */
  wait: z.number().optional(),
  /** ведущий пары — в строке ведомого */
  lead: Callsign.optional(),
  /** сессия разбирает обращения службы компьютера этого вида и ключа */
  incident: z.object({ kind: z.string(), key: z.string() }).optional(),
});
export type SessionRow = z.infer<typeof SessionRow>;

const toSession = z.object({ to: Callsign });

export const sessionOpen = request("session.open", {
  owner: "host", target: "machine",
  tool: "Открыть новую сессию Claude Code на машине: to — машина вида @laptop, spec — документ сессии (name, cwd обязательны). prompt — первое сообщение сессии; mkdir — создать папку, если её нет; number — к имени первый свободный номер; pair — открыть вместе с ведомым <имя>-wing; resume — продолжить разговор с диска машины по его id, fork — его копией.",
  input: z.object({
    to: MachineAddr, spec: Spec, prompt: z.string().optional(),
    /** создать папку, если её нет */
    mkdir: z.boolean().optional(),
    /** к имени — первый свободный номер на машине: site-1, site-2 */
    number: z.boolean().optional(),
    /** продолжить разговор с этим id с диска машины; fork — копией, прежний разговор не трогается */
    resume: z.string().optional(),
    fork: z.boolean().optional(),
    /** открыть пару: ведомый <имя>-wing в той же папке */
    pair: z.boolean().optional(),
  }),
  output: z.object({ callsign: Callsign, wing: Callsign.optional() }),
});

export const sessionUpdate = request("session.update", {
  owner: "host", target: "session",
  tool: "Изменить документ сессии: patch — ключи для замены (model, effort, mode, fast, style, thinking, title, slot — очередь аккаунтов или ключ флота, pieces, project, wing, backup, remote, cwd); wing: null — снять ведомого; pair: true — открыть ведомого <имя>-wing.",
  input: z.object({ to: Callsign, patch: SpecPatch.extend({ wing: Callsign.nullable().optional() }), pair: z.boolean().optional() }),
  /** now — что подействовало сразу; later — что вступит в силу после хода, с новым процессом */
  output: z.object({ now: z.array(z.string()), later: z.array(z.string()), wing: Callsign.optional() }).loose(),
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
  owner: "host", target: "session", tool: "Убрать сессию с машины; точки в архиве остаются. after_turn: true — посреди хода убрать после его конца (так сессия убирает сама себя).",
  input: z.object({ to: Callsign, after_turn: z.boolean().optional() }), output: z.object({ after_turn: z.boolean().optional() }).loose(),
});

/** Проход к методам SDK живой сессии: один список методов — здесь.
 *  compact — сжать контекст сейчас; permissionRules — правила разрешений сессии; renameSession — args: заголовок. */
export const SDK_METHODS = [
  "interrupt", "contextUsage", "commands", "models", "agents", "mcpStatus", "mcpToggle", "mcpReconnect", "mcpAuthenticate",
  "tasks", "taskStop", "taskOutput", "reload", "sideQuestion", "status", "hooks",
  "usage", "renameSession", "getSessionInfo", "permissionRules", "compact",
] as const;
/** Методы, которые сессия зовёт у другой сессии инструментом: остальные — только страница. */
export const TOOL_METHODS = ["interrupt", "compact", "reload", "mcpStatus", "mcpReconnect", "mcpToggle", "contextUsage", "status"] as const;
export const sessionCall = request("session.call", {
  owner: "host", target: "session",
  tool: "Действие над живой сессией: method — interrupt (прервать ход), compact (сжать разговор), reload (перечитать скилы, агентов и серверы плагинов), mcpStatus (серверы MCP), mcpReconnect (args: имя сервера), mcpToggle (args: [имя сервера, включён]), contextUsage (занятость контекста), status (состояние).",
  input: z.object({ to: Callsign, method: z.enum(SDK_METHODS), args: z.unknown().optional() }),
  output: z.unknown(),
});

/* ===== Разговор ===== */

export const FileIn = z.object({ name: z.string(), mime: z.string(), base64: z.string() });

export const message = request("message", {
  owner: "host-chat", target: "session",
  tool: "Написать сессии флота: to — позывной вида site@laptop, text — сообщение. От сессии оно придёт адресату с пометкой отправителя. Человеку (~почта) пишут инструментом reach_send.",
  /** priority: now — прервать ход и взять сейчас; next — после нынешнего шага (по умолчанию); later — после хода */
  input: z.object({ to: Callsign, text: z.string(), files: z.array(FileIn).optional(), priority: z.enum(["now", "next", "later"]).optional() }),
  /** queued — сессия занята, сообщение ждёт в очереди; uuid — его номер: по нему приходит статус в ленте и отмена */
  output: z.object({ queued: z.boolean().optional(), uuid: z.string().optional() }).loose(),
});

/** Отменить своё сообщение, пока ход его не взял. */
export const messageCancel = request("message.cancel", {
  owner: "host-chat", target: "session",
  input: z.object({ to: Callsign, uuid: z.string() }),
  output: z.object({ cancelled: z.boolean() }),
});

/** Сообщение в очереди ввода сессии: ещё не взято ходом. */
export const QueuedMessage = z.object({ uuid: z.string(), from: z.string(), text: z.string(), at: z.number() });
export type QueuedMessage = z.infer<typeof QueuedMessage>;
/** Событие ленты о своём сообщении: queued — в очереди, taken — ход его взял, cancelled — отменено. Приходит рядом с событиями SDK. */
export const MessageStatus = z.object({ type: z.literal("message.status"), uuid: z.string(), status: z.enum(["queued", "taken", "cancelled"]) });

/** Событие ленты: сообщение SDK как есть. Сверх него Host кладёт в ленту и историю:
 *  сообщение человека, сессии или службы сразу, как оно принято (type user, uuid — номер сообщения, from — отправитель; у сообщения сессии — peer { from, text });
 *  итог хода (type result: duration_ms, num_turns, total_cost_usd, usage) — в истории он стоит за последней записью своего хода;
 *  статус своего сообщения (MessageStatus). */
export const SdkEvent = z.object({ type: z.string(), uuid: z.string().optional() }).loose();
export type SdkEvent = z.infer<typeof SdkEvent>;

export const sessionHistory = request("session.history", {
  owner: "host-chat", target: "session",
  tool: "Прочитать разговор сессии страницами с конца: before — uuid, до которого читать; people: true — только переписка с людьми (их сообщения, сообщения им, вопросы и ответы).",
  input: z.object({ to: Callsign, before: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), people: z.boolean().optional() }),
  output: z.object({ events: z.array(SdkEvent), more: z.boolean(), seq: z.number() }),
});

export const sessionFiles = request("session.files", {
  owner: "host-chat", target: "session",
  input: z.object({ to: Callsign, q: z.string() }),
  output: z.object({ files: z.array(z.string()) }),
});

/** Смотреть ленту. after — номер последнего события, которое у зрителя есть: в ответе events — пропущенное с этого номера;
 *  gap: true — пропущенного в памяти Host уже нет, разговор надо перечитать историей. queued — сообщения, что ждут в очереди ввода. */
export const sessionWatch = request("session.watch", {
  owner: "host-chat", target: "session",
  input: z.object({ to: Callsign, after: z.number().optional() }),
  /** running — события начала работ, которые идут сейчас (субагенты и фоновые команды): в файле разговора их нет, новому зрителю их отдаёт Host */
  output: z.object({ seq: z.number(), events: z.array(SdkEvent).optional(), gap: z.boolean().optional(), queued: z.array(QueuedMessage).optional(), running: z.array(SdkEvent).optional() }),
});
export const sessionUnwatch = request("session.unwatch", { owner: "host-chat", target: "session", input: toSession, output: Done });

/** «Прочитано»: человек дочитал сессию — пометка снимается у него на всех устройствах. */
/** Откат разговора в той же сессии. upto — uuid сообщения человека или задачи от сессии: оно и всё после него уходит; без upto — разговор начинается заново.
 *  files — вернуть и файлы к тому же моменту; dry — только посчитать. text — текст ушедшего сообщения: страница кладёт его в поле ввода. */
export const sessionRewind = request("session.rewind", {
  owner: "host", target: "session",
  tool: "Откатить разговор сессии к сообщению человека: upto — uuid этого сообщения, оно и всё после него уходит; без upto — разговор начинается заново. files: true — вернуть и файлы к тому же моменту. dry: true — только показать, что уйдёт.",
  input: z.object({ to: Callsign, upto: z.string().optional(), files: z.boolean().optional(), dry: z.boolean().optional() }),
  /** nofiles — у показа: почему файлы к этому сообщению не вернуть (снимка нет); откат с файлами тогда отказывает словом */
  output: z.object({ cut: z.number(), text: z.string().optional(), files: z.array(z.string()).optional(), plus: z.number().optional(), minus: z.number().optional(), nofiles: z.string().optional() }),
});
export const sessionRead = request("session.read", { owner: "host-chat", target: "session", input: toSession, output: Done });

export const answer = request("answer", {
  owner: "host-chat", target: "session",
  tool: "Ответить на вопрос сессии: ask — номер вопроса из строки сессии, answer — ответ. Первый ответ выигрывает.",
  /** via: "push" — ответ дан кнопкой уведомления, а не на странице */
  input: z.object({ to: Callsign, ask: z.string(), answer: z.unknown(), via: z.literal("push").optional() }),
  output: Done,
});

/** Итог вопроса — событие ленты `ask.answered`: кто ответил и чем. answer — выбранные варианты, действие разрешения или «cancelled», если ход снял вопрос. */
export const AskAnswered = z.object({ type: z.literal("ask.answered"), ask: z.string(), kind: Ask.shape.kind, by: z.string().optional(), answer: z.unknown().optional(), via: z.literal("push").optional(), at: z.number() });
export type AskAnswered = z.infer<typeof AskAnswered>;

/** Лента: события пачкой тем, кто смотрит сессию. */
export const sessionEvents = frame("session.events", {
  owner: "host-chat",
  payload: z.object({ callsign: Callsign, seq: z.number(), events: z.array(SdkEvent) }),
});

/** Изменение строки сессии: Host → объект машины → картина флота. Строка идёт целиком и заменяет прежнюю; row null — сессии больше нет. */
export const sessionState = frame("session.state", {
  owner: "host",
  payload: z.object({ callsign: Callsign, row: SessionRow.nullable() }),
});

/** Снимок машины от Host при подключении: заменяет её строки в картине. */
export const machineHello = frame("machine.hello", {
  owner: "host",
  payload: z.object({ build: z.number(), sdk: z.string().optional(), os: z.string().optional(), sessions: z.array(SessionRow) }),
});

export { Empty };
