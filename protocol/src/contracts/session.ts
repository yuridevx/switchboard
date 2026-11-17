// Сессия: документ, строка картины, жизненный цикл (ядро Host) и разговор (модуль chat).
import { Callsign, Done, Empty, frame, MachineAddr, Name, Person, request, z } from "../define.ts";

/** Состояния сессии. */
export const SessionState = z.enum(["starting", "idle", "busy", "waiting", "stopping", "stopped", "failed"]);
export type SessionState = z.infer<typeof SessionState>;

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
/** Режим разрешений: all — разрешено всё (по умолчанию), ask — спрашивать, plan — только план, edits — правки без вопросов, auto — решает классификатор Claude. */
export const Mode = z.enum(["all", "ask", "plan", "edits", "auto"]);

/** Документ сессии: у каждого ключа один хозяин. Ядро: name, cwd, model, effort, mode, fast, style, thinking, title, parent, wing, project.
 *  accounts: key · profiles: pieces · points: backup. */
export const Spec = z.object({
  name: Name,
  cwd: z.string().min(1),
  /** точное имя модели из каталога провайдера (keys.models): псевдонимов и «по умолчанию» нет; открыть сессию без модели — отказ model_required */
  model: z.string().optional(),
  /** провайдер модели: claude — аккаунты Claude флота (аккаунт выбирает машина), иначе имя ключа флота; открыть без него — отказ key_required */
  key: z.string().optional(),
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
  /** кусочки профиля */
  pieces: z.array(z.string()).optional(),
  /** сохранять точки в архив */
  backup: z.boolean().optional(),
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
  /** аккаунт Claude, к которому сессия привязана сейчас: выбирает машина; у сессии провайдера его нет */
  account: z.string().optional(),
  /** кэш разговора у модели, которая ответила последней: until — до какого времени он тёплый, мс (нет — провайдер срока не называет и на ключе он не задан);
   *  compact — когда машина сама сожмёт разговор, мс (нет — сжимать не будет); size — сколько токенов занято в контексте по последнему ответу модели;
   *  read — сколько из них последний ответ прочитал из кэша. Часы считает машина: страница их только показывает */
  cache: z.object({ until: z.number().optional(), compact: z.number().optional(), size: z.number().optional(), read: z.number().optional() }).optional(),
  /** модель, которая ответила вместо выбранной; нет — отвечает выбранная */
  answers: z.string().optional(),
  /** последняя точка в архив не удалась: причина */
  archiveError: z.string().optional(),
  /** когда Host повторит неудавшуюся точку сам, мс; раньше — при конце хода */
  archiveRetryAt: z.number().optional(),
  /** до какого времени Host повторяет неудавшуюся точку сам, мс; после — повторов нет, причина остаётся */
  archiveUntil: z.number().optional(),
  /** идёт сжатие контекста */
  compacting: z.boolean().optional(),
  /** годных аккаунтов Claude нет: когда ближайший сброс лимита, мс — в этот час сессия продолжит сама */
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
  tool: "Открыть новую сессию Claude Code на машине и дать ей первую задачу. Бери, чтобы поручить работу отдельной сессии: открытая тобой сессия — твоя дочь, итоги её ходов по твоей задаче придут сами. to — машина вида @laptop. spec — документ сессии: name, cwd, key и model обязательны (key — провайдер: claude или имя ключа флота; model — точное имя из keys_models; свои key и model видны в fleet_list, в строке с твоим позывным). Проект не называй — дочь встанет в твой; другой проект — его номер из people_list. prompt — первая задача. mkdir — создать папку, если её нет; number — к имени первый свободный номер; pair — открыть вместе с ведомым <имя>-wing; resume — продолжить разговор с диска машины по его id, fork — его копией. Ответ: callsign новой сессии. Отказы: key_required, model_required, no_model — нет провайдера или такой модели; no_project — проекта нет, в отказе список «номер — имя»; name_taken — имя занято; bad_dir — папки нет.", example: {"to":"@server","spec":{"name":"coder","cwd":"~/projects/site","key":"claude","model":"claude-opus-5-5"},"prompt":"Собери срез 2 и пришли номер коммита"},
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
  tool: "Изменить документ сессии. Бери, чтобы сменить модель, режим или проект сессии или открыть себе ведомого. patch — ключи для замены: key и model (провайдер и точное имя из keys_models, меняются вместе), effort, mode, fast, style, thinking, title, pieces, project (номер из people_list), backup, cwd. wing: null — снять ведомого; pair: true — открыть ведомого <имя>-wing. Ответ: now — что подействовало сразу, later — что вступит в силу после хода, wing — позывной открытого ведомого.", example: {"to":"site@laptop","patch":{"effort":"high"}},
  input: z.object({ to: Callsign, patch: SpecPatch.extend({ wing: Callsign.nullable().optional() }), pair: z.boolean().optional() }),
  /** now — что подействовало сразу; later — что вступит в силу после хода, с новым процессом */
  output: z.object({ now: z.array(z.string()), later: z.array(z.string()), wing: Callsign.optional() }).loose(),
});

export const sessionStop = request("session.stop", {
  owner: "host", target: "session", tool: "Остановить процесс сессии; разговор сохраняется. Запустить снова — session_start.", example: {"to":"site@laptop"},
  input: toSession, output: Done,
});
export const sessionStart = request("session.start", {
  owner: "host", target: "session", tool: "Запустить остановленную сессию: разговор продолжается с того же места. Бери после отказа stopped у message.", example: {"to":"site@laptop"},
  input: toSession, output: Done,
});
export const sessionRemove = request("session.remove", {
  owner: "host", target: "session", tool: "Убрать сессию с машины; точки в архиве остаются. Себя убирай так: to — свой позывной, after_turn: true — сессия уйдёт после конца хода.", example: {"to":"site@laptop","after_turn":true},
  input: z.object({ to: Callsign, after_turn: z.boolean().optional() }), output: z.object({ after_turn: z.boolean().optional() }).loose(),
});

/** Проход к методам SDK живой сессии: один список методов — здесь.
 *  compact — сжать контекст сейчас; permissionRules — правила разрешений сессии; renameSession — args: заголовок. */
export const SDK_METHODS = [
  "interrupt", "contextUsage", "commands", "agents", "mcpStatus", "mcpToggle", "mcpReconnect", "mcpAuthenticate",
  "tasks", "taskStop", "taskOutput", "reload", "sideQuestion", "status", "hooks",
  "renameSession", "getSessionInfo", "permissionRules", "compact",
] as const;
/** Методы, которые сессия зовёт у другой сессии инструментом: остальные — только страница. */
export const TOOL_METHODS = ["interrupt", "compact", "reload", "mcpStatus", "mcpReconnect", "mcpToggle", "contextUsage", "status"] as const;
export const sessionCall = request("session.call", {
  owner: "host", target: "session",
  tool: "Действие над живой сессией: method — interrupt (прервать ход), compact (сжать разговор), reload (перечитать скилы, агентов и серверы плагинов), mcpStatus (серверы MCP), mcpReconnect (args: имя сервера), mcpToggle (args: [имя сервера, включён]), contextUsage (занятость контекста), status (состояние). Ответ — то, что вернул метод. Отказ stopped — сессия остановлена.", example: {"to":"site@laptop","method":"interrupt"},
  input: z.object({ to: Callsign, method: z.enum(SDK_METHODS), args: z.unknown().optional() }),
  output: z.unknown(),
});

/* ===== Разговор ===== */

/** Файл в разговоре: имя, хэш содержимого (SHA-256) и размер. Содержимое лежит в хранилище флота по хэшу (служба files); в сообщениях, ленте и журнале его нет. */
export const Hash = z.string().regex(/^[0-9a-f]{64}$/);
export const FileIn = z.object({ name: z.string(), hash: Hash, size: z.number() });
export type FileIn = z.infer<typeof FileIn>;
/** Срочность сообщения занятой сессии: now — прервать ход и взять сейчас; next — после нынешнего шага (по умолчанию). Набор объявлен один раз — здесь. */
export const Priority = z.enum(["now", "next"]);
export type Priority = z.infer<typeof Priority>;

export const message = request("message", {
  owner: "host-chat", target: "session",
  tool: "Написать сессии флота. Бери, чтобы дать задачу дочери, ответить соседу, сообщить новость. Человеку — reach_send. to — позывной вида site@laptop; text — сообщение; priority: next (по умолчанию) — после нынешнего шага адресата, now — прервать его ход; files — файлы из хранилища флота, каждый {name, hash, size}, как в ответе file_send: встанут в uploads/ папки адресата. Текст «/model слова» меняет модель адресата: слова — часть имени модели, семейство или провайдер. Ответ: uuid и queued — адресат занят, сообщение ждёт; model — «/model» поставило эту модель. Отказы: stopped — сессия остановлена: session_start; many_models — под слова подошло несколько моделей, в отказе список.", example: {"to":"coder@server","text":"Собери срез 2 и пришли номер коммита"},
  input: z.object({ to: Callsign, text: z.string(), files: z.array(FileIn).optional(), priority: Priority.optional() }),
  /** queued — сессия занята, сообщение ждёт в очереди; uuid — его номер: по нему приходит статус в ленте и отмена */
  /** model — «/model слова» поставило сессии эту модель: в разговор команда не ушла */
  output: z.object({ queued: z.boolean().optional(), uuid: z.string().optional(), model: z.string().optional() }).loose(),
});

/** Вид входящего от флота: что это и что с ним делать. task и message ставит машина адресата (отправитель — родитель сессии → task);
 *  result, question и news называет машина отправителя запросом notice; incident — модуль обращений. У инструмента message поля вида нет. */
export const Kind = z.enum(["task", "message", "result", "question", "news", "incident"]);
export type Kind = z.infer<typeof Kind>;
/** Разобранное входящее в событии ленты и истории: тег собирает и разбирает только модуль разговора. ask — номер вопроса; incident и key — вид и ключ обращения. */
export const Peer = z.object({ from: z.string(), kind: Kind, text: z.string(), ask: z.string().optional(), incident: z.string().optional(), key: z.string().optional() });
export type Peer = z.infer<typeof Peer>;

/** Служебное сообщение сессии от машины: итог хода дочери (result), вопрос дочери (question), событие со своей работой (news). Не инструмент: вид называет машина, а не модель. */
export const notice = request("notice", {
  owner: "host-chat", target: "session", machineOnly: true,
  input: z.object({ to: Callsign, kind: z.enum(["result", "question", "news"]), text: z.string(), ask: z.string().optional() }),
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
 *  сообщение человека, сессии или службы сразу, как оно принято (type user, uuid — номер сообщения, from — отправитель; у входящего от флота — peer: Peer;
 *  files — файлы сообщения: имя, хэш, размер — в тексте события строки уведомления о них уже нет);
 *  итог хода (type result: duration_ms, num_turns, total_cost_usd, usage) — в истории он стоит за последней записью своего хода;
 *  статус своего сообщения (MessageStatus);
 *  беду сессии (LogEvent) — в истории она стоит за записью разговора, после которой пришла. */
export const SdkEvent = z.object({ type: z.string(), uuid: z.string().optional() }).loose();
export type SdkEvent = z.infer<typeof SdkEvent>;

/** Беда сессии — событие ленты `log`: строка журнала машины о сессии уровня warn или error, кто бы её ни написал — ядро, модуль или таблица бед Claude.
 *  msg — имя строки журнала, why — причина словами машины: страница рисует её как есть и своих слов о бедах не держит. */
export const LogEvent = z.object({ type: z.literal("log"), uuid: z.string(), level: z.enum(["warn", "error"]), msg: z.string(), why: z.string().optional(), at: z.number() });
export type LogEvent = z.infer<typeof LogEvent>;

export const sessionHistory = request("session.history", {
  owner: "host-chat", target: "session",
  tool: "Прочитать разговор сессии страницами с конца. Бери, чтобы узнать, что сессия делала и что ответила. limit — сколько событий (по умолчанию 50, не больше 200); before — uuid события, до которого читать дальше назад; people: true — только переписка с людьми (их сообщения, сообщения им, вопросы и ответы). Ответ: events — сообщения и вызовы инструментов по порядку, more — есть ли более ранние.", example: {"to":"site@laptop","limit":30}, reads: true,
  input: z.object({ to: Callsign, before: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), people: z.boolean().optional() }),
  output: z.object({ events: z.array(SdkEvent), more: z.boolean(), seq: z.number() }),
});

export const sessionFiles = request("session.files", {
  owner: "host-chat", target: "session",
  input: z.object({ to: Callsign, q: z.string() }),
  output: z.object({ files: z.array(z.string()) }),
});

/** Отправить человеку файл из папки сессии: Host считает хэш, кладёт содержимое в хранилище флота (если его там ещё нет) и отвечает именем, хэшем и размером.
 *  В разговоре остаются вызов и ответ; содержимое в контекст сессии не попадает. Только в своей ленте: to — свой позывной, иначе not_self. Файла нет — no_file. */
export const fileSend = request("file.send", {
  owner: "host-files", target: "session",
  tool: "Отправить человеку файл: он встанет в ленте твоей сессии, человек увидит его (картинка, SVG, страница HTML одним файлом, схема .mmd, Markdown, текст) и сможет скачать — любой файл. Бери вместо того, чтобы переписывать содержимое в ответ или читать картинку ради показа: в твой контекст попадает только путь. to — свой позывной, path — путь от папки сессии, от домашней папки или полный, title — подпись.",
  example: { to: "site@laptop", path: "out/latency.svg", title: "Время ответа за сутки" },
  input: z.object({ to: Callsign, path: z.string().min(1), title: z.string().optional() }),
  output: FileIn,
});
/** Поднять папку статики сайтом: Host кладёт в хранилище файлы, которых там ещё нет, и записывает список «путь → хэш». Адрес у папки сессии постоянный:
 *  повторный вызов обновляет сайт на том же адресе. Отдаёт сайт Worker из хранилища, машина на пути показа не стоит. Нет index.html — no_index; to — не свой позывной — not_self. */
export const sitePublish = request("site.publish", {
  owner: "host-files", target: "session",
  tool: "Поднять папку со статикой сайтом: страницы, стили, скрипты, картинки. В ответе — адрес; человек увидит сайт в ленте и откроет в новой вкладке. Повторный вызов с той же папкой обновляет сайт на том же адресе, грузятся только изменённые файлы. В папке должен быть index.html; файлы и папки с точки и node_modules в сайт не идут. Сайт открывается в песочнице браузера: localStorage и cookies ему недоступны. to — свой позывной, dir — папка, title — подпись.",
  example: { to: "site@laptop", dir: "out/site", title: "Отчёт за сутки" },
  input: z.object({ to: Callsign, dir: z.string().min(1), title: z.string().optional() }),
  /** files и size — весь сайт; сколько файлов пришлось загрузить, говорит строка журнала машины */
  output: z.object({ url: z.string(), files: z.number(), size: z.number() }),
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
  tool: "Откатить разговор сессии к сообщению человека: upto — uuid этого сообщения, оно и всё после него уходит; без upto — разговор начинается заново. files: true — вернуть и файлы к тому же моменту. dry: true — только показать, что уйдёт. Ответ: cut — сколько записей уходит, files — какие файлы вернутся. Отказы: stopped; no_checkpoint — снимка файлов нет.", example: {"to":"site@laptop","upto":"a0a446ca-1c2d-4e5f-8a9b-0c1d2e3f4a5b","dry":true},
  input: z.object({ to: Callsign, upto: z.string().optional(), files: z.boolean().optional(), dry: z.boolean().optional() }),
  /** nofiles — у показа: почему файлы к этому сообщению не вернуть (снимка нет); откат с файлами тогда отказывает словом */
  output: z.object({ cut: z.number(), text: z.string().optional(), files: z.array(z.string()).optional(), plus: z.number().optional(), minus: z.number().optional(), nofiles: z.string().optional() }),
});
export const sessionRead = request("session.read", { owner: "host-chat", target: "session", input: toSession, output: Done });

export const answer = request("answer", {
  owner: "host-chat", target: "session",
  tool: "Ответить на вопрос сессии. Бери, когда во ввод пришло <fleet kind=\"question\" ask=\"…\">: to — кто спросил, ask — номер вопроса из тега (он же в fleet_list), answer — выбранный вариант или текст. Первый ответ выигрывает; разрешения, планы и формы решает только человек. Отказы: already_answered — уже ответили; unknown_question — такого вопроса нет.", example: {"to":"coder@server","ask":"toolu_01Hq","answer":"main"},
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
