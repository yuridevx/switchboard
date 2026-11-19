// Службы: выпуски, журнал флота, архив сессий, связь с людьми, настройки, ключи флота, GitHub, аналитика, наблюдение.
import { Callsign, Done, Empty, Name, Person, request, z } from "../define.ts";
import { Hash, SdkEvent, Spec } from "./session.ts";
import { HostMetrics, Limit } from "./machine.ts";

/* ===== Выпуски (builds) ===== */

/** digest — отпечаток кода, из которого сборка собрана: по нему сверяют «в дереве то же, что загружено». */
export const Build = z.object({ build: z.number(), at: z.number(), commit: z.string().optional(), note: z.string().optional(), digest: z.string().optional(), files: z.array(z.string()) });
export const buildsList = request("builds.list", {
  owner: "builds", target: "service", tool: "Сборки флота: какая стоит (stable) и какие машины закреплены на другой.", example: {}, reads: true,
  input: Empty,
  output: z.object({ stable: z.number().nullable(), pins: z.record(z.string(), z.number()), builds: z.array(Build) }),
});
/** Ссылки для загрузки файлов сборки (CI). */
export const buildsUpload = request("builds.upload", {
  owner: "builds", target: "service", admin: true,
  input: z.object({ build: z.number(), commit: z.string().optional(), note: z.string().optional(), digest: z.string().optional(), files: z.array(z.object({ name: z.string(), sha256: z.string(), size: z.number() })) }),
  output: z.object({ links: z.record(z.string(), z.string()) }),
});
export const buildsDeploy = request("builds.deploy", {
  owner: "builds", target: "service", admin: true,
  tool: "Назначить сборку флоту (build) или закрепить машину на сборке (machine и build; build null — снять закрепление). Откат — та же команда с прежним номером.", example: {"build":27},
  input: z.object({ build: z.number().nullable(), machine: Name.optional() }), output: Done,
});
const PlanFile = z.object({ url: z.string(), sha256: z.string() });
/** План машины: спрашивает Keeper своим пропуском. Ссылки живут час. */
export const buildsPlan = request("builds.plan", {
  owner: "builds", target: "service", machineOnly: true,
  input: z.object({ os: z.enum(["windows", "linux"]), arch: z.string().optional() }),
  output: z.object({ build: z.number(), host: PlanFile, keeper: PlanFile }).nullable(),
});

/** Файл Keeper стоящей сборки для человека, который ставит машину: ссылка на час. Команду установки собирает страница. */
export const buildsKeeper = request("builds.keeper", {
  owner: "builds", target: "service",
  input: z.object({ os: z.enum(["windows", "linux"]), arch: z.string().optional() }),
  output: z.object({ build: z.number(), file: z.string(), url: z.string(), sha256: z.string() }),
});

/* ===== Журнал флота (ledger) ===== */

export const LedgerEvent = z.object({ id: z.string(), at: z.number(), what: z.string(), who: z.string(), machine: z.string().optional(), callsign: z.string().optional(), text: z.string().optional(), data: z.unknown().optional(), trace: z.string().optional() });
export type LedgerEvent = z.infer<typeof LedgerEvent>;
export const ledgerAdd = request("ledger.add", {
  owner: "ledger", target: "service",
  input: z.object({ what: z.string(), machine: z.string().optional(), callsign: z.string().optional(), text: z.string().optional(), data: z.unknown().optional() }), output: Done,
});
export const ledgerRead = request("ledger.read", {
  owner: "ledger", target: "service", tool: "Журнал флота: выкладки, входы, сбои частей. what — начало имени события, machine — только по машине.", example: {"what":"session.","limit":50}, reads: true,
  // after — события новее этого времени, от старых к новым: подтягивание новых без перечитывания
  input: z.object({ before: z.number().optional(), after: z.number().optional(), limit: z.number().optional(), what: z.string().optional(), machine: z.string().optional() }),
  output: z.object({ events: z.array(LedgerEvent), more: z.boolean() }),
});

/* ===== Архив сессий (archive) ===== */

export const ArchSession = z.object({
  sid: z.string(), machine: z.string(), callsign: z.string(), title: z.string().optional(), model: z.string().optional(),
  /** провайдер из документа сессии на последней точке: вместе с model — чем окно подъёма заполняет выбор модели; у точки прежней системы его нет */
  key: z.string().optional(),
  cwd: z.string().optional(), project: z.string().optional(), points: z.number(), last: z.number(), bytes: z.number().optional(), tokens: z.number().optional(),
  /** строка с найденным словом: до 60 знаков по обе стороны от него */
  hit: z.string().optional(),
  /** запись разговора, в которой слово найдено, и точка, с которой эта запись есть в архиве */
  hitUuid: z.string().optional(),
  hitPoint: z.string().optional(),
  /** документ сессии на последней точке: с ним сессию поднимают (отдаёт points.get) */
  spec: Spec.optional(),
  /** сессия с этим позывным сейчас есть на машине и не остановлена */
  live: z.boolean().optional(),
  /** владелец машины: удалить сессию архива может он и админ */
  owner: z.string().optional(),
});
export type ArchSession = z.infer<typeof ArchSession>;
export const ArchPoint = z.object({
  point: z.string(), at: z.number(), label: z.string().optional(), turns: z.number().optional(), bytes: z.number().optional(), git: z.string().optional(),
  /** до какого времени точка хранится; нет — без срока (последняя точка сессии) */
  until: z.number().optional(),
  /** от какой точки продолжена: `точка` той же сессии или `сессия/точка` — у поднятой копии. Нет — первая точка новой сессии */
  base: z.string().optional(),
});
export type ArchPoint = z.infer<typeof ArchPoint>;

/** Сохранить точку: Host называет файлы точки блоками (хэш содержимого); ответ — ссылки на загрузку блоков, которых ещё нет. */
export const pointsPut = request("points.put", {
  owner: "archive", target: "service", machineOnly: true,
  input: z.object({
    sid: z.string(), callsign: Callsign, point: z.string(), base: z.string().optional(), spec: Spec.optional(), label: z.string().optional(), title: z.string().optional(), model: z.string().optional(),
    cwd: z.string().optional(), project: z.string().optional(), git: z.string().optional(), turns: z.number().optional(), tokens: z.number().optional(),
    files: z.array(z.object({ path: z.string(), blocks: z.array(z.string()), size: z.number() })),
    /** текст новых сообщений для поиска: uuid, роль, текст */
    text: z.array(z.object({ uuid: z.string(), role: z.string(), text: z.string() })).optional(),
    /** блоки уже загружены: записать точку */
    commit: z.boolean().optional(),
  }),
  output: z.object({ upload: z.record(z.string(), z.string()), done: z.boolean() }),
});
export const pointsList = request("points.list", {
  owner: "archive", target: "service",
  tool: "Архив сессий: каталог с поиском. q — слова в разговоре; machine — только эта машина; sid — точки одной сессии; since — не старше этого времени; order — last (последние) или tokens (по токенам).", example: {"q":"шапка сайта","limit":20}, reads: true,
  input: z.object({ q: z.string().optional(), machine: z.string().optional(), sid: z.string().optional(), before: z.number().optional(), since: z.number().optional(), order: z.enum(["last", "tokens"]).optional(), limit: z.number().optional() }),
  output: z.object({ sessions: z.array(ArchSession), points: z.array(ArchPoint).optional(), more: z.boolean() }),
});
/** Обзор архива по машинам, до которых человек достаёт: сколько в нём лежит и когда линии точек редели в последний раз. */
export const ArchStats = z.object({ sessions: z.number(), points: z.number(), blocks: z.number(), bytes: z.number(), sweep: z.object({ at: z.number(), points: z.number(), blocks: z.number() }).optional() });
export const pointsStats = request("points.stats", {
  owner: "archive", target: "service", tool: "Обзор архива сессий: число сессий, точек и блоков, размер, последняя уборка — всего и по машинам.", example: {}, reads: true,
  input: z.object({ machine: z.string().optional() }),
  output: ArchStats.extend({ machines: z.array(ArchStats.extend({ machine: z.string() })) }),
});
export const pointsGet = request("points.get", {
  owner: "archive", target: "service",
  /** expect — последняя точка, которую видел человек: в архиве уже другая — отказ changed. move и by — перенос от имени человека by: не владелец машины сессии и не админ — not_owner. */
  input: z.object({ sid: z.string(), point: z.string().optional(), expect: z.string().optional(), move: z.boolean().optional(), by: z.string().optional() }),
  output: z.object({ session: ArchSession, point: ArchPoint, files: z.array(z.object({ path: z.string(), size: z.number(), blocks: z.array(z.object({ hash: z.string(), url: z.string() })) })) }),
});
export const pointsHistory = request("points.history", {
  owner: "archive", target: "service", tool: "Разговор сессии архива на точке (по умолчанию последней) страницами с конца.", example: {"sid":"a0a446ca-1c2d-4e5f-8a9b-0c1d2e3f4a5b","limit":50}, reads: true,
  input: z.object({ sid: z.string(), point: z.string().optional(), before: z.string().optional(), limit: z.number().optional() }),
  output: z.object({ events: z.array(SdkEvent), more: z.boolean(), /** точка, на которой прочитан разговор */ point: z.string().optional() }),
});
export const ModelCall = z.object({ call: z.string(), at: z.number(), model: z.string(), input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), cost: z.number().optional() });
export type ModelCall = z.infer<typeof ModelCall>;
/** Вызовы модели в разговоре точки: токены по вызовам и стоимость по таблице цен флота (настройка prices). */
export const pointsCalls = request("points.calls", {
  owner: "archive", target: "service", tool: "Вызовы модели в разговоре сессии архива на точке (по умолчанию последней): модель, токены, стоимость.", example: {"sid":"a0a446ca-1c2d-4e5f-8a9b-0c1d2e3f4a5b"}, reads: true,
  input: z.object({ sid: z.string(), point: z.string().optional() }),
  output: z.object({ point: z.string(), calls: z.array(ModelCall) }),
});
/** Текст одного вызова модели: системный промпт и сообщения разговора до ответа — страницами с конца. Для проверки правил прокси на настоящем вызове. */
export const pointsCall = request("points.call", {
  owner: "archive", target: "service",
  input: z.object({ sid: z.string(), point: z.string().optional(), call: z.string(), before: z.number().optional(), limit: z.number().optional() }),
  output: z.object({ point: z.string(), call: z.string(), model: z.string(), system: z.string(), messages: z.array(z.object({ n: z.number(), role: z.string(), text: z.string() })), more: z.boolean() }),
});
/** Удаляет владелец машины и админ, иначе not_owner. expect — последняя точка, которую видел удаляющий: в архиве уже другая — отказ changed. */
export const pointsDelete = request("points.delete", {
  owner: "archive", target: "service", tool: "Удалить сессию архива или одну её точку.", example: {"sid":"a0a446ca-1c2d-4e5f-8a9b-0c1d2e3f4a5b"},
  input: z.object({ sid: z.string(), point: z.string().optional(), expect: z.string().optional() }), output: Done,
});

/* ===== Связь с людьми (reach) ===== */

export const DeviceRow = z.object({ id: z.string(), kind: z.enum(["webpush", "telegram"]), person: Person, label: z.string().optional(), at: z.number(), kid: z.string().optional() });
export type DeviceRow = z.infer<typeof DeviceRow>;
/** Позвать человека: служба сама смотрит, на связи ли он; на связи — не шлёт. */
export const reachSend = request("reach.send", {
  owner: "reach", target: "service",
  tool: "Написать человеку флота. Бери, когда нужен человек: вопрос, новость, просьба; обычный ответ он видит в ленте сессии и так. to — человек вида ~a@b.c, title — заголовок, text — сообщение. Уйдёт на его телефон и в Telegram, если страница у него не открыта; force — слать в любом случае. Ответ человека из Telegram придёт в твою сессию. Ответ: sent — на сколько устройств ушло, online — открыта ли у него страница.", example: {"to":"~a@b.c","title":"Нужен доступ","text":"Не могу зайти на стенд: какой адрес?"},
  input: z.object({ to: Person, title: z.string(), text: z.string(), callsign: Callsign.optional(), kind: z.enum(["ask", "done", "failed", "message", "alert"]).optional(), force: z.boolean().optional(), /** номер вопроса и подписи вариантов: ответ кнопками */ ask: z.string().optional(), options: z.array(z.string()).optional() }),
  output: z.object({ sent: z.number(), online: z.boolean() }),
});
export const reachKey = request("reach.key", { owner: "reach", target: "service", input: Empty, output: z.object({ key: z.string() }) });
export const reachSubscribe = request("reach.subscribe", {
  owner: "reach", target: "service",
  input: z.object({ kind: z.literal("webpush"), endpoint: z.string(), p256dh: z.string(), auth: z.string(), label: z.string().optional() }), output: z.object({ id: z.string() }),
});
export const reachDevices = request("reach.devices", { owner: "reach", target: "service", input: Empty, output: z.object({ devices: z.array(DeviceRow) }) });
/** device — номер устройства из reach.devices. Поле id здесь не работает: это имя занято конвертом кадра. */
export const reachRemove = request("reach.remove", { owner: "reach", target: "service", input: z.object({ id: z.string().optional(), device: z.string() }), output: Done });
/** Код привязки чата Telegram: человек шлёт его боту, чат становится его устройством. */
export const reachTelegram = request("reach.telegram", { owner: "reach", target: "service", input: Empty, output: z.object({ code: z.string(), bot: z.string() }) });
/** Бот Telegram флота: токен хранится в записях флота, вебхук ставится на адрес этого флота. token null — отключить. Без полей — состояние. */
export const reachBot = request("reach.bot", {
  owner: "reach", target: "service", admin: true,
  input: z.object({ token: z.string().nullable().optional() }),
  output: z.object({ bot: z.string().optional(), on: z.boolean() }),
});

/* ===== Настройки (prefs) ===== */

/** Области: me — свои; fleet — общие записи флота (проекты доски, имена, правила прокси). Запись в fleet — машины получают кадр changed. */
export const Scope = z.enum(["me", "fleet"]);
export const prefsGet = request("prefs.get", {
  owner: "prefs", target: "service", tool: "Настройки: scope fleet — общие записи флота, me — свои; prefix — только ключи с этим началом.", example: {"scope":"fleet","prefix":"labels"}, reads: true,
  input: z.object({ scope: Scope, prefix: z.string().optional() }), output: z.object({ values: z.record(z.string(), z.unknown()) }),
});
/** Запись одной настройки; patch — заплатка поверх прежнего значения-объекта (ключ со значением null убирается). */
export const prefsSet = request("prefs.set", {
  owner: "prefs", target: "service", tool: "Записать настройку: name — ключ, value — значение целиком или patch — заплатка объекта. Имена сессий и машин для людей — scope fleet, name labels, patch { \"site@laptop\": \"Сайт\", \"@laptop\": \"Ноутбук\" } (null убирает имя).", example: {"scope":"fleet","name":"labels","patch":{"site@laptop":"Сайт"}},
  input: z.object({ scope: Scope, name: z.string(), value: z.unknown().optional(), patch: z.record(z.string(), z.unknown()).optional() }), output: Done,
});

/* ===== Ключи флота (keys) ===== */

/** Имя провайдера «аккаунты Claude флота» в документе сессии (key) и в keys.models. Ключ флота так назвать нельзя. */
export const CLAUDE = "claude";
/** Виды API провайдера: claude — аккаунт Claude (имя — почта, значение — годовой токен claude setup-token); anthropic — Messages API по адресу base;
 *  openai — OpenAI Responses API по адресу base: запрос и поток переводит прокси машины; meta — тот же перевод с заголовками и поиском Meta;
 *  chatgpt — аккаунт ChatGPT: тот же перевод в бэкенд подписки, значение — refresh-токен входа, служба ключей меняет его на токен доступа и обновляет сама. */
export const PROTOCOLS = ["claude", "anthropic", "openai", "meta", "chatgpt"] as const;
export const Protocol = z.enum(PROTOCOLS);
export type Protocol = z.infer<typeof Protocol>;
/** Дополнения ключа провайдера: settings — настройки сессии на этом ключе; env — окружение сессии;
 *  cache — сколько минут живёт кэш разговора у этого провайдера: сам он срока не называет (нет или 0 — срок неизвестен). */
const KeyOpts = { settings: z.record(z.string(), z.unknown()).optional(), env: z.record(z.string(), z.string()).optional(), cache: z.number().nonnegative().optional() };
/** Ключ флота — провайдер: один ключ открывает весь каталог его моделей. protocol — вид его API: им говорят с моделями, о которых провайдер не сказал иного. */
export const KeyRow = z.object({
  name: z.string(), protocol: z.string(), base: z.string().optional(), at: z.number(), tail: z.string(), ...KeyOpts,
  /** у аккаунта Claude: беречь запас недели под Fable */
  keep: z.boolean().optional(),
  /** у аккаунта Claude: до какого времени действует токен, мс — год от записи значения */
  expires: z.number().optional(),
  /** сколько сессий флота сейчас идёт на этом ключе */
  sessions: z.number().optional(),
  /** у аккаунта Claude: окна лимитов, одни на флот — как их последней назвала любая машина; at — когда она их видела */
  limits: z.array(Limit).optional(),
});
export type KeyRow = z.infer<typeof KeyRow>;
/** Окна аккаунта Claude из ответа Claude машине: машина сообщает их, когда числа изменились, и не реже порога свежести, пока аккаунт отвечает.
 *  Служба хранит по окну последнее по времени at; так машины не пробуют аккаунт, о котором флот уже знает свежее. Только машине. */
export const keysLimits = request("keys.limits", {
  owner: "keys", target: "service", machineOnly: true,
  input: z.object({ name: z.string(), limits: z.array(z.object({ name: z.string(), used: z.number(), resets: z.number().optional(), at: z.number() })) }), output: Done,
});
export const keysList = request("keys.list", {
  owner: "keys", target: "service", tool: "Ключи флота — провайдеры моделей: аккаунты Claude (protocol claude, имя — почта) и ключи API провайдеров с адресом; число сессий на ключе. Значений в ответе нет. Модели провайдера — keys_models.", example: {}, reads: true,
  input: Empty, output: z.object({ keys: z.array(KeyRow) }),
});
/** value не задан — правятся только свойства уже записанного ключа. */
export const keysSet = request("keys.set", {
  owner: "keys", target: "service", admin: true,
  tool: "Записать ключ флота: name — имя (у аккаунта Claude — почта), protocol — вид API (claude — аккаунт Claude, value — токен claude setup-token; anthropic — Messages API; openai — OpenAI Responses API; meta — Meta; chatgpt — аккаунт ChatGPT, value — refresh-токен входа), value — значение ключа, base — адрес API провайдера, cache — сколько минут живёт кэш разговора у провайдера, keep — беречь запас недели аккаунта под Fable.", example: {"name":"router","protocol":"anthropic","base":"https://api.example.com"},
  input: z.object({ name: z.string(), protocol: Protocol, value: z.string().optional(), base: z.string().optional(), keep: z.boolean().optional(), ...KeyOpts }), output: Done,
});
/** Модель каталога провайдера, как её отдал сам провайдер: id — точное имя для документа сессии; family — семейство (группа в списке); window — окно контекста, токены;
 *  protocol — каким API с ней говорить: что объявил о модели провайдер, иначе — вид ключа. */
export const Model = z.object({ id: z.string(), name: z.string().optional(), family: z.string().optional(), window: z.number().optional(), protocol: Protocol.optional() });
export type Model = z.infer<typeof Model>;
/** Каталог моделей провайдера: служба спрашивает провайдера на каждый запрос и копии не держит. name — имя ключа; claude — каталог Claude по токену любого аккаунта. */
export const keysModels = request("keys.models", {
  owner: "keys", target: "service", tool: "Каталог моделей провайдера: name — имя ключа флота или claude. В ответе точные имена моделей для документа сессии (key и model), семейство, окно контекста и протокол.", example: {"name":"claude"}, reads: true,
  input: z.object({ name: z.string() }), output: z.object({ models: z.array(Model) }),
});
/** Предложение списка моделей: провайдер и модель каталога. */
export type Offer = { key: string; model: string; name?: string; family?: string };
/** Одно правило «слова → модели»: его зовут и поиск списка на странице, и машина для «/model слова» из сообщения.
 *  Слово — часть имени модели, её семейства или провайдера; подходят модели, где нашлись все слова. Точное имя модели выигрывает у остальных. */
export function findModels<T extends Offer>(words: string, offers: T[]): T[] {
  const flat = (t: string) => t.toLowerCase().replace(/[._]/g, "-");
  const parts = flat(words).split(/\s+/).filter(Boolean);
  if (!parts.length) return offers;
  const exact = offers.filter((o) => flat(o.model) === parts.join(" "));
  if (exact.length) return exact;
  return offers.filter((o) => {
    const hay = flat([o.key, o.model, o.name ?? "", o.family ?? ""].join(" "));
    return parts.every((p) => hay.includes(p));
  });
}
/** probe — проба: ничего не удаляет, отвечает, какие сессии сейчас идут на ключе. */
export const keysRemove = request("keys.remove", {
  owner: "keys", target: "service", admin: true,
  input: z.object({ name: z.string(), probe: z.boolean().optional() }), output: z.object({ sessions: z.array(z.string()).optional() }).loose(),
});
/** Значение ключа — только машине. until — когда спросить значение снова, мс: есть у ключа, чьё значение стареет (токен доступа аккаунта ChatGPT). */
export const keysValue = request("keys.value", {
  owner: "keys", target: "service", machineOnly: true,
  input: z.object({ name: z.string() }), output: z.object({ value: z.string(), protocol: z.string(), base: z.string().optional(), keep: z.boolean().optional(), until: z.number().optional(), ...KeyOpts }),
});

/* ===== GitHub (github) ===== */

export const githubApp = request("github.app", { owner: "github", target: "service", input: Empty, output: z.object({ installed: z.boolean(), name: z.string().optional(), url: z.string().optional(), repos: z.array(z.string()).optional() }) });
export const githubSetup = request("github.setup", { owner: "github", target: "service", admin: true, input: z.object({ code: z.string().optional(), redirect: z.string().optional(), org: z.string().optional(), replace: z.boolean().optional() }), output: z.object({ url: z.string().optional(), installed: z.boolean(), form: z.object({ action: z.string(), manifest: z.unknown() }).optional() }) });
export const githubToken = request("github.token", { owner: "github", target: "service", machineOnly: true, input: z.object({ repo: z.string() }), output: z.object({ token: z.string(), expires: z.number() }) });

/** Цены моделей в настройке флота prices: доллары за миллион токенов по видам; модель без цены в стоимость не идёт. */
export type Prices = Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;

/* ===== Аналитика (analytics) — ClickHouse в стороне ===== */

export const analyticsQuery = request("analytics.query", {
  owner: "analytics", target: "service",
  tool: "Расход флота: вызовы модели и токены. by — разрез (day, model, machine, session, person, project, account — аккаунт Claude, на котором прошёл вызов), since и until — даты.", example: {"by":"day","since":"2026-11-01","until":"2026-11-15"}, reads: true,
  input: z.object({ by: z.enum(["day", "model", "machine", "session", "person", "project", "account"]), since: z.string(), until: z.string(), machine: z.string().optional() }),
  output: z.object({ rows: z.array(z.object({ key: z.string(), calls: z.number(), input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), cost: z.number().optional() })) }),
});
/** Состояние аналитики. on — ClickHouse подключён; ok и ms — ответил ли и за сколько; по машинам: rows — строк, last — время последнего вызова в нём,
 *  pending — сколько точек архива новее этого времени (ещё не долиты или в очереди). */
export const analyticsState = request("analytics.state", {
  owner: "analytics", target: "service", tool: "Состояние ClickHouse и синхронизации в него: отвечает ли, сколько строк и докуда долито по каждой машине, сколько точек архива ждут.", example: {}, reads: true,
  input: Empty,
  output: z.object({ on: z.boolean(), ok: z.boolean(), ms: z.number().optional(), error: z.string().optional(), machines: z.array(z.object({ machine: z.string(), rows: z.number(), last: z.number().optional(), pending: z.number() })) }),
});
export const analyticsFill = request("analytics.fill", { owner: "analytics", target: "service", admin: true, input: z.object({ since: z.number() }), output: z.object({ queued: z.number() }) });

/* ===== История флота (analytics) — журналы машин в ClickHouse ===== */

/** Пачка строк журнала машины. file — имя файла журнала, pos — место начала пачки в файле, байты; lines — строки файла как есть, по порядку.
 *  Служба пишет пачку в ClickHouse внутри запроса и отвечает после записи: отказ — машина место не сдвигает и шлёт пачку снова.
 *  Ключ строки — машина (из пропуска), файл, начало пачки, номер строки в пачке: повтор пачки строк не добавляет. Только машине. */
export const logWrite = request("log.write", {
  owner: "analytics", target: "service", machineOnly: true,
  input: z.object({ file: z.string(), pos: z.number(), lines: z.array(z.string()) }), output: Done,
});
/** Строка истории: at — мс; session — позывной; account — аккаунт Claude; status — статус ответа провайдера; kind — вид отказа или события; text — причина словами; data — остальные поля строки журнала. */
export const LogRow = z.object({
  at: z.number(), machine: z.string(), part: z.string(), level: z.string(), msg: z.string(),
  session: z.string().optional(), account: z.string().optional(), status: z.number().optional(), kind: z.string().optional(), text: z.string().optional(), data: z.unknown().optional(),
});
export type LogRow = z.infer<typeof LogRow>;
/** Чтение истории из ClickHouse, новые первыми. msg — имя строки или его начало: call — вызов модели, route — решение о выборе аккаунта, account. — события аккаунтов. */
export const logQuery = request("log.query", {
  owner: "analytics", target: "service",
  tool: "История флота из ClickHouse — строки журналов всех машин, новые первыми. msg — имя строки или его начало (call — вызовы модели, route — выбор аккаунта со счётом кандидатов, account. — события аккаунтов: переход, полон, окно закрыто, токен не годен); machine, session (позывной), account (почта), level; since и before — время, мс.", example: {"msg":"call","limit":20}, reads: true,
  input: z.object({ msg: z.string().optional(), machine: z.string().optional(), session: z.string().optional(), account: z.string().optional(), level: z.enum(["info", "warn", "error"]).optional(), since: z.number().optional(), before: z.number().optional(), limit: z.number().optional() }),
  output: z.object({ lines: z.array(LogRow), more: z.boolean() }),
});

/* ===== Наблюдение (obs) ===== */

export const ObsRow = z.object({
  trace: z.string(), at: z.number(), type: z.string(), from: z.string(), to: z.string().optional(), ok: z.boolean(), word: z.string().optional(), why: z.string().optional(),
  ms: z.number(), spans: z.array(z.object({ part: z.string(), ms: z.number() })).optional(),
});
export type ObsRow = z.infer<typeof ObsRow>;
export const obsRecent = request("obs.recent", {
  owner: "obs", target: "service", tool: "Последние запросы флота с исходом и временем по частям. name — имя запроса (или его начало), failed — только отказы, of — один запрос по его trace.", example: {"failed":true,"limit":20}, reads: true,
  // of — строки одного запроса по его trace. Поле trace здесь не работает: это имя занято конвертом кадра.
  // name — имя запроса. Поле type здесь не работает: это имя занято конвертом кадра.
  input: z.object({ type: z.string().optional(), name: z.string().optional(), failed: z.boolean().optional(), trace: z.string().optional(), of: z.string().optional(), before: z.number().optional(), limit: z.number().optional() }),
  output: z.object({ rows: z.array(ObsRow), more: z.boolean() }),
});
export const obsStats = request("obs.stats", {
  owner: "obs", target: "service", tool: "Сводка запросов флота за период: число, отказы, медиана и 95-й процентиль времени по именам.", example: {"since":1794700000000,"until":1794786400000}, reads: true,
  input: z.object({ since: z.number(), until: z.number() }),
  output: z.object({ types: z.array(z.object({ type: z.string(), n: z.number(), failed: z.number(), p50: z.number(), p95: z.number() })), buckets: z.array(z.object({ at: z.number(), n: z.number(), failed: z.number() })) }),
});
/** Сводка здоровья флота одним ответом: машины, отказы за час, медленные запросы, последние сбои частей и ошибки, пойманные на месте. */
export const obsHealth = request("obs.health", {
  owner: "obs", target: "service", tool: "Здоровье флота: машины на связи и без связи, доля отказов за час, самые медленные запросы, последние сбои частей и ошибки страницы и Host.", example: {}, reads: true,
  input: Empty,
  output: z.object({
    machines: z.object({ total: z.number(), online: z.number(), offline: z.array(z.object({ name: z.string(), since: z.number() })) }),
    sessions: z.object({ total: z.number(), failed: z.array(z.string()), waiting: z.number() }),
    requests: z.object({ n: z.number(), failed: z.number(), rate: z.number() }),
    slow: z.array(z.object({ type: z.string(), p95: z.number(), n: z.number() })),
    failures: z.array(LedgerEvent),
    reports: z.array(z.object({ at: z.number(), part: z.string(), level: z.string(), msg: z.string(), who: z.string() })),
    /** последние числа Host каждой машины */
    hosts: z.array(HostMetrics.extend({ machine: z.string() })).optional(),
    /** когда служба последний раз сверяла картину флота (машины без связи, сессии со сбоем): срок держат часы флота */
    watched: z.number().optional(),
  }),
});
/** Числа Host за минуту: шлёт машина своим пропуском. Первое число машины заводит на часах флота сверку картины: машина без связи дольше порога и сессия со сбоем — оповещение админам. */
export const obsMetrics = request("obs.metrics", { owner: "obs", target: "service", machineOnly: true, input: HostMetrics, output: Done });
/** Ряд чисел Host одной машины за период (хранится 7 дней), старые первыми. */
export const obsSeries = request("obs.series", {
  owner: "obs", target: "service", tool: "Ряд чисел Host машины по минутам за период: сессии, очередь ввода, время провайдера, сбои процессов. Хранится 7 дней.", example: {"machine":"laptop"}, reads: true,
  input: z.object({ machine: Name, since: z.number().optional(), until: z.number().optional(), limit: z.number().optional() }),
  output: z.object({ rows: z.array(HostMetrics) }),
});
/** Ошибка страницы или Host, пойманная на месте. Видна в obs.recent строкой с именем report. */
export const obsReport = request("obs.report", {
  owner: "obs", target: "service",
  input: z.object({ part: z.string(), level: z.enum(["warn", "error"]), msg: z.string(), stack: z.string().optional(), data: z.unknown().optional() }), output: Done,
});

/* ===== Файлы (files) ===== */

/** Загрузить содержимое по хэшу: в ответе — подписанные ссылки на загрузку для тех хэшей, которых в хранилище ещё нет. Байты идут по ссылке, мимо Worker'а. */
export const filesPut = request("files.put", {
  owner: "files", target: "service",
  input: z.object({ files: z.array(z.object({ hash: Hash, size: z.number() })) }),
  output: z.object({ upload: z.record(z.string(), z.string()) }),
});
/** Подписанная ссылка на содержимое по хэшу, на час. name — имя для скачивания: с ним ссылка отдаёт файл вложением. Содержимого нет — no_file. */
export const filesGet = request("files.get", {
  owner: "files", target: "service",
  input: z.object({ hash: Hash, name: z.string().optional() }),
  output: z.object({ url: z.string() }),
});
/** Записать список файлов сайта: путь → хэш. site — номер сайта: его выводит Host из своего секрета, позывного сессии и папки. Отдаёт сайт этот же Worker по адресу /s/<номер>/, без пропуска. */
export const filesSite = request("files.site", {
  owner: "files", target: "service", machineOnly: true,
  input: z.object({ site: z.string().regex(/^[0-9a-f]{32}$/), files: z.array(z.object({ path: z.string(), hash: Hash, size: z.number() })) }),
  output: z.object({ url: z.string() }),
});
