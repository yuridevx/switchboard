// Аккаунты и модели сессий машины. Аккаунт Claude — ключ флота с протоколом claude: годовой токен, один на весь флот.
// Машина держит токены только в памяти; у процесса сессии вместо токена слово-заглушка, настоящий ставит прокси.
// Сессия привязана к аккаунту, пока кэш её разговора тёплый; новая и остывшая выбирают лучший по счёту (limits.ts). Порядка аккаунтов нет нигде.
// Числа окон — из заголовков ответов Claude; они общие для флота: машина сообщает их службе ключей и берёт оттуда то, что видели другие. Каждый вызов, решение и событие аккаунта — строка журнала машины
// (call, route, account.*): историю читают из ClickHouse, от него выбор не зависит.
// Аккаунт без свежих ответов (новый, без сессий) машина пробует сама, когда её спрашивают об аккаунтах: разовый claude с ответом в одно слово
// идёт через прокси этим аккаунтом — окна приходят теми же заголовками, что у любого вызова.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CLAUDE, findModels, incidentRaise, keysLimits, keysList, keysModels, keysValue, LIMIT_WORD, READ_MS, Refusal, within, type Account as AccountOut, type Model, type Offer, type Protocol, type SessionState } from "@sb/protocol";
import type { HostApi, Module, QueryPart, SessionApi } from "../../core/contract.ts";
import { cacheOf, hours, launchEnv, launchSig, procModel, wireModel, type Cache, type Pair } from "./pair.ts";
import { choose, closed, FABLE, FIVE, fits, isFable, nextReset, read, refusalHeaders, shown, WEEK, type Account, type Candidate } from "./limits.ts";

/** Запись машины: окна и годность аккаунтов переживают подмену Host. */
type Book = { accounts: Record<string, Account> };
/** Запись сессии — всё о паре «провайдер · модель» в одном месте. account — привязка к аккаунту Claude, at — когда привязана;
 *  cut — годных аккаунтов не было, ход оборван: wait — час ближайшего сброса. pair — что известно о паре документа: пишется при смене и при запуске;
 *  ran — подпись окружения, с которым поднят процесс; cache — кэш разговора у модели, которая ответила; answers — ответила не та модель. */
type Seat = { account?: string; at?: number; cut?: boolean; wait?: number; pair?: Pair; ran?: string; cache?: Cache; answers?: string };

/** Куда идёт вызов модели. account и token — аккаунт Claude: токен подписки идёт только в Authorization.
 *  key — ключ провайдера; protocol — каким API с ним говорить; model — имя модели, которое слать: его решает хозяин пары, прокси только подставляет;
 *  window — окно модели по каталогу. */
export type Route = { /** позывной сессии; у пробы аккаунта и проверки ключа сессии нет */ callsign: string; to: string; protocol: Protocol; account?: string; token?: string; key?: string; name?: string; model?: string; window?: number; env?: Record<string, string> };
/** Что делать с ответом: отдать сессии; послать тот же вызов на следующий аккаунт; подождать и повторить на том же. */
export type Verdict = { act: "pass" } | { act: "next" } | { act: "wait"; ms: number };
export type Answered = { status: number; headers: Record<string, string | string[] | undefined>; path: string; ms: number; hops: number; waited: boolean; model?: string; /** что провайдер написал в отказе */ why?: string };
export type AccountsApi = {
  /** Маршрут вызова сессии. skip — аккаунты, которые этот вызов уже пробовал; asked — имя модели из вызова. Маршрут в полёте, пока не назван done. */
  route(sessionId: string, skip?: string[], asked?: string): Promise<Route>;
  /** Заголовки ответа пришли: окна аккаунта, вид отказа, строка журнала. */
  answer(route: Route, r: Answered): Verdict;
  /** Вызов кончился: ответ отдан или оборван. */
  done(route: Route): void;
  /** Адрес прокси машины: через него идут пробы аккаунтов. Называет прокси при старте. */
  proxied(url: string): void;
  /** Маршрут проверки ключа провайдера: без сессии. */
  keyRoute(name: string): Promise<Route>;
  /** Модели всех провайдеров флота: для «/model слова» из сообщения. Имя модели — имя для документа сессии. */
  offers(): Promise<Offer[]>;
};

const ANTHROPIC = "https://api.anthropic.com";
/** Слово вместо секрета в окружении сессии: настоящий токен или ключ ставит прокси. */
const FLEET_WORD = "fleet";
const CONTINUE = "Продолжай";
/** Кэш разговора живёт час: столько же держится привязка сессии без ответов. */
const HOUR_MS = 3_600_000;
/** Короткая пауза Claude: ждём не дольше. */
const THROTTLE_MAX_S = 60;
/** Окна аккаунта во всём флоте старше этого — проба при вопросе об аккаунтах: расход вне флота виден только в ответе Claude. */
const FRESH_MS = 120_000;
/** Обход аккаунтов: раз в этот срок машина сама спрашивает у Claude окна аккаунтов, о которых флот столько же ничего не слышал, — и закрытых:
 *  сброс лимитов человеком иначе не заметить до прежнего часа. Срок — решение агента 16 нояб. (слово пользователя — «периодический перезапрос», без числа). */
const ROUND_MS = 600_000;
/** Предел пробы: ответ на account.list не ждёт дольше. */
const PROBE_MS = READ_MS - 2_000;
/** Кто делает вызов пробы: в строке журнала вместо позывного. */
const PROBE = "проба";
/** Вид обращения в «Инциденты»: токен аккаунта не принят. */
const ACCOUNT_INCIDENT = "account";
/** Вид обращения в «Инциденты»: ответила не та модель. */
const MODEL_INCIDENT = "model";
/** Имя модели у записи, которую процесс написал сам (ошибка API, прерывание): модель её не давала. */
const SYNTHETIC = "<synthetic>";
/** Предел шага смены: сколько ждём, пока живой процесс примет новую модель, — как у остальных шагов сессии. */
const SWAP_MS = 30_000;
/** Имена моделей Claude начинаются так: на пути Claude такие имена идут как есть — ими работают помощники сессии. */
const CLAUDE_NAME = `${CLAUDE}-`;
const KIND: Record<string, string> = { [WEEK]: "week", [FABLE]: "fable", [FIVE]: "five_hour" };

const clock = (t: number) => new Date(t).toTimeString().slice(0, 5);
const say = (e: unknown) => (e as Refusal).why ?? (e as Error).message;

export function make(): Module {
  let host: HostApi;
  let stopping = false;
  let wake: unknown;
  let round: unknown;
  /** токены аккаунтов Claude и значения ключей провайдеров — только в памяти */
  const tokens = new Map<string, string>();
  const values = new Map<string, string>();
  /** вызовов в полёте по аккаунту */
  const flying = new Map<string, number>();
  /** «полон»: при скольких вызовах в полёте Claude отказал аккаунту */
  const full = new Map<string, number>();
  let loading: Promise<void> | null = null;
  /** когда аккаунт последний раз назвал свои окна — этой машине или, по словам службы ключей, любой машине флота */
  const seen = new Map<string, number>();
  /** когда эта машина последний раз сообщала окна аккаунта флоту */
  const reported = new Map<string, number>();
  /** идущие пробы: id разового claude → аккаунт; на аккаунт — одна */
  const probes = new Map<string, string>();
  const probing = new Map<string, Promise<void>>();
  let proxyUrl = "";
  /** кэш разговора после последнего ответа: в память на каждый ответ, в запись сессии — когда она освободилась */
  const caches = new Map<string, Cache>();
  /** таймер сжатия при простое и его час; late — о пропущенном сроке журнал уже сказал */
  const compacts = new Map<string, { timer: unknown; at: number }>();
  const late = new Set<string>();
  /** в идущем ходе модель сменили: ответ прежней модели до конца хода — не тревога */
  const swapped = new Set<string>();
  /** модель последнего ответа в основном разговоре: ей принадлежит размер, который вызов называет в конце */
  const answered = new Map<string, string>();
  /** пара, только что сверенная с каталогом: проверка документа и запись о паре читают каталог один раз */
  const fresh = new Map<string, Pair>();

  const now = () => host.clock.now();
  const shelf = () => host.store<Book>();
  const book = (): Record<string, Account> => shelf().get()?.accounts ?? {};
  const write = (fn: (all: Record<string, Account>) => void) => void shelf().update((b = { accounts: {} }) => (fn(b.accounts), b));
  const seatOf = (s: SessionApi) => s.store<Seat>();
  const onClaude = (s: SessionApi) => s.spec.key === CLAUDE;
  const alive = (s: SessionApi) => s.state !== "stopped" && s.state !== "failed";
  const sessionOf = (sessionId: string) => host.sessions().find((x) => x.info.sessionId === sessionId);
  const isFull = (name: string) => full.has(name) && (flying.get(name) ?? 0) >= full.get(name)!;

  /** Кэш разговора тёплый или привязка свежая: такая сессия держится своего аккаунта и занимает его в счёте. */
  const cacheOfSession = (s: SessionApi): Cache | undefined => caches.get(s.callsign) ?? seatOf(s).get()?.cache;
  /** До какого времени кэш разговора тёплый; срока нет — ноль. */
  const warmUntil = (s: SessionApi): number => { const c = cacheOfSession(s); return c ? (hours(c).until ?? 0) : 0; };
  const warm = (s: SessionApi, seat: Seat | undefined, t: number) => Math.max((seat?.at ?? 0) + HOUR_MS, warmUntil(s)) > t;
  /** Тёплые сессии по аккаунтам на этой машине; other — без этой сессии. */
  function warmBy(t: number, other?: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of host.sessions()) {
      const seat = seatOf(s).get();
      if (s.callsign === other || !onClaude(s) || !alive(s) || !seat?.account || !warm(s, seat, t)) continue;
      out[seat.account] = (out[seat.account] ?? 0) + 1;
    }
    return out;
  }

  /** Аккаунты Claude флота: имена и флаги — из списка ключей, токены — в память. Один запрос на всех, кто ждёт. */
  function load(): Promise<void> {
    loading ??= (async () => {
      try {
        const { keys } = await within(host.call(keysList, {}), READ_MS, `список ключей флота: службы не ответили за ${READ_MS / 1000} с`);
        const rows = keys.filter((k) => k.protocol === CLAUDE);
        await Promise.all(rows.filter((k) => !tokens.has(k.name)).map(async (k) => tokens.set(k.name, (await within(host.call(keysValue, { name: k.name }), READ_MS, `токен ${k.name}: службы не ответили`)).value)));
        for (const n of [...tokens.keys()]) if (!rows.some((k) => k.name === n)) tokens.delete(n);
        write((all) => {
          for (const k of rows) {
            const was = all[k.name];
            // хвост значения сменился — токен новый: аккаунт снова в выборе
            const a = (all[k.name] = { ...(was && was.tail === k.tail ? was : { limits: was?.limits ?? {}, ok: true }), keep: k.keep !== false, tail: k.tail });
            // окна — общие для флота: что другая машина видела позже, то и верно
            for (const l of k.limits ?? []) {
              const at = l.at ?? 0;
              if (at > (a.limits[l.name]?.at ?? 0)) a.limits[l.name] = { used: l.used, resets: l.resets ?? 0, at };
              seen.set(k.name, Math.max(seen.get(k.name) ?? 0, at));
            }
          }
          for (const n of Object.keys(all)) if (!rows.some((k) => k.name === n)) delete all[n];
        });
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  /** Побудка одна на машину: на ближайший сброс закрытого окна. По ней сессии, чей ход оборвался без годного аккаунта, продолжают сами. */
  function plan(): void {
    host.clock.clearTimeout(wake);
    wake = undefined;
    if (stopping) return;
    const t = now();
    const at = Math.min(...Object.values(book()).map((a) => nextReset(a, t)), ...host.sessions().map((s) => seatOf(s).get()).filter((x) => x?.cut && x.wait && x.wait > t).map((x) => x!.wait!), Infinity);
    if (!Number.isFinite(at)) return;
    wake = host.clock.setTimeout(() => {
      revive();
      plan();
    }, Math.max(0, at - t));
    (wake as { unref?: () => void }).unref?.();
  }

  /** Обход: аккаунты с принятым токеном, о которых флот не слышал дольше срока, пробуются — открытые и закрытые. Числа уходят флоту, и другая машина их уже не пробует. */
  async function sweep(): Promise<void> {
    try {
      await load();
      const t = now();
      const quiet = Object.keys(book()).filter((n) => tokens.has(n) && book()[n]!.ok && (seen.get(n) ?? 0) < t - ROUND_MS);
      await within(Promise.all(quiet.map(probe)), PROBE_MS, "проба не успела").catch(() => {});
      revive();
      plan();
    } catch (e) {
      host.log.warn("accounts", { why: `обход аккаунтов: ${say(e)}` });
    }
  }

  /** Следующий обход. Первый — со сдвигом по имени машины: машины флота стартуют разом, а пробовать аккаунт должна одна. */
  function rounds(first = false): void {
    if (stopping) return;
    const shift = ([...host.machine].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0) % ROUND_MS;
    round = host.clock.setTimeout(() => void sweep().then(() => rounds()), first ? shift : ROUND_MS);
    (round as { unref?: () => void }).unref?.();
  }

  /** Сессии с оборванным ходом: годный аккаунт появился — продолжают, когда свободны. */
  function revive(): void {
    const t = now();
    for (const s of host.sessions()) {
      const seat = seatOf(s).get();
      if (!seat?.cut || !onClaude(s) || s.state !== "idle") continue;
      if (!choose(book(), isFable(s.spec.model), {}, t, (n) => !tokens.has(n)).account) continue;
      seatOf(s).update((x) => ({ ...x, cut: undefined, wait: undefined }));
      s.sync();
      s.input(CONTINUE);
    }
  }

  /** Строка решения о выборе: кандидаты со счётом — входы решения. */
  function routed(s: SessionApi, account: string | undefined, why: string, candidates: Candidate[]): void {
    const pct = (x: number) => Math.round(x * 1000) / 10;
    // годного аккаунта нет — беда сессии: строка уровня warn уходит в её ленту, человек видит причину и час сброса сразу, а не после всех повторов claude
    host.log[account ? "info" : "warn"]("route", {
      callsign: s.callsign, ...(account ? { account } : {}), model: s.spec.model, why,
      candidates: candidates.map((c) => ({ account: c.account, rem: pct(c.rem), hours: Math.round(c.hours * 10) / 10, warm: c.warm, score: pct(c.score) })),
    });
  }

  /** Каталог моделей провайдера: спрашивается у службы каждый раз, своей копии нет. */
  const catalog = async (key: string): Promise<Model[]> => (await within(host.call(keysModels, { name: key }), READ_MS, `каталог ${key}: службы не ответили за ${READ_MS / 1000} с`)).models;

  /** Пара по каталогу и ключу провайдера: одно чтение каталога; значение ключа — в память. Модели в каталоге нет — отказ словом с похожими именами. */
  async function learn(key: string, model: string): Promise<Pair> {
    const [models, opts] = await Promise.all([catalog(key), key === CLAUDE ? undefined : takeKey(key)]);
    const m = models.find((x) => x.id === model);
    if (!m) {
      const near = findModels(model.split(/[-./]/).filter((w) => w.length > 2 && w !== CLAUDE)[0] ?? model, models.map((x) => ({ key, model: x.id }))).slice(0, 6).map((o) => o.model);
      throw new Refusal("no_model", `у провайдера ${key} нет модели ${model}${near.length ? `; похожие: ${near.join(", ")}` : ""}`);
    }
    return {
      key, model, protocol: m.protocol ?? (key === CLAUDE ? CLAUDE : ((opts?.protocol as Protocol | undefined) ?? "anthropic")), ...(m.window ? { window: m.window } : {}),
      ...(opts?.base ? { base: opts.base } : {}), ...(opts?.env ? { env: opts.env } : {}), ...(opts?.settings && Object.keys(opts.settings).length ? { settings: opts.settings } : {}), ...(opts?.cache ? { cache: opts.cache } : {}),
    };
  }

  /** Свежий ключ провайдера: значение — в память, настройки — ответом. */
  async function takeKey(name: string): Promise<{ protocol: string; base?: string; env?: Record<string, string>; settings?: Record<string, unknown>; cache?: number }> {
    try {
      const { value, keep: _keep, ...config } = await within(host.call(keysValue, { name }), READ_MS, `ключ флота ${name}: службы не ответили за ${READ_MS / 1000} с`);
      values.set(name, value);
      return config;
    } catch (e) {
      const r = e as Refusal;
      throw r.word === "not_found" || r.word === "no_key" ? new Refusal("no_key", `${name}: такого ключа флота нет`) : new Refusal(r.word ?? "module_failed", `ключ флота ${name}: ${r.why ?? say(e)}`);
    }
  }

  /** Пара документа сессии: из записи, пока она о той же паре; иначе — из каталога и ключа, и в запись. */
  async function pairOf(s: SessionApi): Promise<Pair> {
    const { key, model } = s.spec;
    if (!key) throw new Refusal("key_required", `у ${s.callsign} не назван провайдер — session.update { key, model }`);
    if (!model) throw new Refusal("model_required", `у ${s.callsign} не названа модель — session.update { key, model }`);
    const known = seatOf(s).get()?.pair;
    if (known && known.key === key && known.model === model) return known;
    // пара только что сверена с каталогом при открытии: второй раз каталог не читается
    const id = `${key}/${model}`;
    const pair = fresh.get(id) ?? (await learn(key, model));
    fresh.delete(id);
    seatOf(s).update((x) => ({ ...x, pair }));
    return pair;
  }

  /** Кэш из памяти — в запись сессии: когда она освободилась. */
  const flush = (s: SessionApi) => { const c = caches.get(s.callsign); if (c) seatOf(s).update((x) => ({ ...x, cache: c })); };

  /** Сжатие при простое: сессия свободна, срок кэша известен, разговор большой — за шесть минут до конца срока уходит «/compact», тем же вводом, что у человека.
   *  Срок прошёл (машина стояла) — строка журнала, догоняющего сжатия нет. Любой новый ход таймер снимает. */
  function arm(s: SessionApi): void {
    disarm(s.callsign);
    const c = cacheOfSession(s);
    const at = c ? hours(c).compact : undefined;
    if (s.state !== "idle" || !c || !at || stopping) return;
    const t = now();
    if (at <= t) {
      // строка — один раз: пока кэш ещё мог быть тёплым или только что остыл
      if (!late.has(s.callsign)) host.log.info("idle_compact_late", { callsign: s.callsign, size: c.size, why: `сжатие при простое: срок прошёл ${Math.round((t - at) / 60_000)} мин назад — разговор не сжат` });
      late.add(s.callsign);
      return;
    }
    late.delete(s.callsign);
    const timer = host.clock.setTimeout(() => {
      compacts.delete(s.callsign);
      if (s.state !== "idle" || stopping) return;
      host.log.info("idle_compact", { callsign: s.callsign, size: c.size, why: `сжатие при простое: разговор ${Math.round(c.size / 1000)} К, кэш тёплый` });
      s.input("/compact", { priority: "next" });
      s.sync();
    }, at - t);
    (timer as { unref?: () => void }).unref?.();
    compacts.set(s.callsign, { timer, at });
  }

  function disarm(callsign: string): void {
    const c = compacts.get(callsign);
    if (c) host.clock.clearTimeout(c.timer);
    compacts.delete(callsign);
  }

  /** Ответ модели в основном разговоре: запись кэша и сверка модели с документом. Сверяется только Claude: стороннему провайдеру модель в каждый вызов ставит машина. */
  function said(s: SessionApi, m: { message?: { model?: string; usage?: Parameters<typeof cacheOf>[0] } }): void {
    const model = m.message?.model;
    const pair = seatOf(s).get()?.pair;
    if (!model || model === SYNTHETIC || !pair || pair.key !== s.spec.key || pair.model !== s.spec.model) return;
    answered.set(s.callsign, model);
    used(s, model, pair, m.message?.usage);
    if (pair.protocol !== CLAUDE || swapped.has(s.callsign)) return;
    const other = model === pair.model ? undefined : model;
    if (other === seatOf(s).get()?.answers) return;
    seatOf(s).update((x) => ({ ...x, answers: other }));
    s.sync();
    if (!other) return;
    // система ловит, агент чинит: строка журнала и обращение в «Инциденты»; сама сессия модель не меняет
    const why = `${s.callsign}: в документе модель ${pair.model}, ответила ${other}`;
    host.log.error("model_drift", { callsign: s.callsign, word: "model_drift", why });
    void host.call(incidentRaise, { to: `@${host.machine}`, kind: MODEL_INCIDENT, key: s.callsign, text: why }).catch((e: unknown) => host.log.warn("incident", { callsign: s.callsign, why: `обращение «модель» не открыто: ${say(e)}` }));
  }

  /** Размер запроса и прочитанное из кэша — в запись кэша. Ответ без размера записи не трогает: у путей с переводом провайдер называет размер
   *  в конце вызова, и его несёт событие потока, а не сам ответ. */
  function used(s: SessionApi, model: string, pair: Pair, usage: Parameters<typeof cacheOf>[0] | undefined): void {
    if (!usage) return;
    const c = cacheOf(usage, model, pair, cacheOfSession(s), now());
    if (c.size > 0) caches.set(s.callsign, c);
  }

  /** Команда живому процессу с пределом шага по часам машины. */
  function swap(s: SessionApi, name: string): Promise<void> {
    return new Promise((done, fail) => {
      const timer = host.clock.setTimeout(() => fail(Object.assign(new Error(`провайдер не ответил за ${SWAP_MS / 1000} с`), { late: true })), SWAP_MS);
      s.sdk("setModel", name).then(() => done(), fail).finally(() => host.clock.clearTimeout(timer));
    });
  }

  /** Вызов уходит этим аккаунтом: он в полёте, пока не назван done. */
  const go = (callsign: string, account: string): Route => {
    flying.set(account, (flying.get(account) ?? 0) + 1);
    // адрес Claude — из настройки модуля: на стенде на его месте подделка
    return { callsign, to: host.config<{ api?: string }>().api ?? ANTHROPIC, protocol: CLAUDE, account, token: tokens.get(account)! };
  };

  /** Проба окон аккаунта: разовый claude с ответом в одно слово через прокси машины, без инструментов и своих настроек. Одновременно на аккаунт — одна.
   *  Модель — Fable из каталога: её ответ называет и неделю, и окно Fable. Отказ пробы — строка журнала вызова, как у любого вызова. */
  function probe(name: string): Promise<void> {
    const going = probing.get(name);
    if (going) return going;
    const run = (async () => {
      const models = await catalog(CLAUDE);
      const model = (models.find((m) => isFable(m.id)) ?? models[0])?.id;
      if (!model || !proxyUrl || stopping) return;
      const sid = randomUUID();
      const dir = mkdtempSync(join(host.dataDir, "probe-"));
      probes.set(sid, name);
      try {
        const args = ["-p", "ok", "--output-format", "json", "--no-session-persistence", "--session-id", sid, "--model", model, "--system-prompt", "Ответь одним словом: ok", "--tools", "", "--strict-mcp-config", "--setting-sources", ""];
        await host.cli(args, { env: { ANTHROPIC_BASE_URL: proxyUrl, CLAUDE_CODE_OAUTH_TOKEN: FLEET_WORD, CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_MAX_RETRIES: "0" } });
      } finally {
        probes.delete(sid);
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      }
    })().catch((e) => host.log.warn("accounts", { account: name, why: `проба окон ${name}: ${say(e)}` })).finally(() => probing.delete(name));
    probing.set(name, run);
    return run;
  }

  /** Маршрут сессии на аккаунте Claude: привязка держится, пока аккаунт годен и кэш тёплый; иначе выбор заново. */
  function claudeRoute(s: SessionApi, skipped: Set<string>): Route {
    const t = now();
    const fable = isFable(s.spec.model);
    const all = book();
    const seat = seatOf(s).get() ?? {};
    const bound = seat.account && all[seat.account] && tokens.has(seat.account) ? seat.account : undefined;
    const hot = !!bound && warm(s, seat, t);
    // тёплая сессия своего аккаунта не пропускает, даже если он полон; новая и остывшая полный обходят
    const pick = choose(all, fable, warmBy(t, s.callsign), t, (n) => !tokens.has(n) || skipped.has(n) || (isFull(n) && !(n === bound && hot)));
    if (bound && hot && pick.candidates.some((c) => c.account === bound)) return go(s.callsign, bound);
    const to = pick.account;
    if (!to) {
      seatOf(s).update((x) => ({ ...x, cut: true, ...(pick.wait ? { wait: pick.wait } : {}) }));
      s.sync();
      plan();
      const why = `годных аккаунтов Claude нет${pick.wait ? `: ближайший сброс в ${clock(pick.wait)}` : ""}`;
      routed(s, undefined, why, pick.candidates);
      throw new Refusal("no_account", `${s.callsign}: ${why}`);
    }
    // аккаунт сессии с тёплым кэшем полон, а окна его открыты: этот вызов уходит на соседа, привязка прежняя; у новой сессии кэша нет — она переходит
    if (bound && warmUntil(s) > t && skipped.has(bound) && fits(all[bound], fable, t, true)) {
      routed(s, to, `${bound} полон: вызов ушёл на ${to}, привязка прежняя`, pick.candidates);
      return go(s.callsign, to);
    }
    const reason = !bound ? (seat.account ? "прежний аккаунт выбыл" : "новая сессия") : !hot ? "кэш остыл, выбран заново" : !all[bound]!.ok ? "токен не принят" : isFull(bound) && skipped.has(bound) ? "аккаунт полон" : "лимит";
    seatOf(s).update((x) => ({ ...x, account: to, at: t, cut: undefined, wait: undefined }));
    s.sync();
    routed(s, to, `${reason}${pick.spare ? " · из запаса Fable" : ""}`, pick.candidates);
    if (seat.account && seat.account !== to) host.log.info("account.moved", { callsign: s.callsign, account: to, from: seat.account, why: `${s.callsign}: ${seat.account} → ${to} · ${reason}` });
    return go(s.callsign, to);
  }

  /** Окна аккаунта — флоту: так другие машины его не пробуют и не шлют на него вызов впустую. Не дошло — строка журнала, числа уйдут со следующим ответом. */
  function report(name: string, windows: Record<string, { used: number; resets: number }>, t: number): void {
    reported.set(name, t);
    const limits = Object.entries(windows).map(([n, w]) => ({ name: n, used: w.used, ...(w.resets ? { resets: w.resets } : {}), at: t }));
    void host.call(keysLimits, { name, limits }).catch((e: unknown) => host.log.warn("accounts", { account: name, why: `окна ${name} флоту не сообщены: ${say(e)}` }));
  }

  /** Аккаунт выбыл или окно закрыто: строка журнала. */
  function mark(name: string, fn: (a: Account) => void): void {
    write((all) => { if (all[name]) fn(all[name]!); });
  }

  const api: AccountsApi = {
    async route(sessionId, skip = [], asked) {
      // вызов пробы идёт названным аккаунтом и ни на какой другой не уходит
      const probed = probes.get(sessionId);
      if (probed) {
        if (skip.includes(probed) || !tokens.has(probed)) throw new Refusal("no_account", `проба ${probed}: аккаунт отказал`);
        return go(PROBE, probed);
      }
      const s = sessionOf(sessionId);
      if (!s) throw new Refusal("unknown_session", `сессии ${sessionId} на ${host.machine} нет`);
      const pair = await pairOf(s);
      if (pair.key === CLAUDE) {
        if (!tokens.size) await load().catch((e) => { throw new Refusal("no_account", `аккаунты Claude не прочитаны: ${say(e)}`); });
        // на пути Claude модели Claude идут как есть — ими работают помощники сессии; чужое имя (вызов, начатый до смены) — на модель документа
        return { ...claudeRoute(s, new Set(skip)), ...(asked && !asked.startsWith(CLAUDE_NAME) ? { model: wireModel(pair.model) } : {}) };
      }
      if (!values.has(pair.key)) await takeKey(pair.key);
      // стороннему провайдеру любой вызов сессии уходит на модель документа
      return { callsign: s.callsign, to: pair.base ?? ANTHROPIC, protocol: pair.protocol, key: values.get(pair.key)!, name: pair.key, model: wireModel(pair.model), ...(pair.window ? { window: pair.window } : {}) };
    },

    answer(route, r) {
      const req = r.headers["request-id"];
      // отказ несёт причину словами провайдера: строка о сессии уходит в её ленту — человек видит, что именно отклонено
      const refused = r.status >= 400 ? { why: `вызов модели отклонён (${r.status})${r.why ? `: ${r.why}` : ""}` } : {};
      const line = { ...(route.callsign === PROBE ? { probe: true } : { callsign: route.callsign }), path: r.path, status: r.status, ms: r.ms, hops: r.hops, ...(r.model ? { model: r.model } : {}), ...(typeof req === "string" ? { req } : {}), ...refused };
      const name = route.account;
      if (!name) {
        host.log[r.status < 400 ? "info" : "warn"]("call", { ...line, key: route.name });
        return { act: "pass" };
      }
      const t = now();
      const fresh = read(r.headers, t);
      if (Object.keys(fresh).length) seen.set(name, t);
      const was = book()[name];
      // на диск — только когда числа изменились: вызовов много, окна меняются редко
      const changed = !!was && Object.entries(fresh).some(([n, w]) => was.limits[n]?.used !== w.used || was.limits[n]?.resets !== w.resets);
      if (changed) mark(name, (a) => void Object.assign(a.limits, fresh));
      // флоту — когда числа изменились, и не реже порога свежести, пока аккаунт отвечает
      if (Object.keys(fresh).length && (changed || (reported.get(name) ?? 0) < t - FRESH_MS)) report(name, fresh, t);
      let kind: string | undefined;
      let verdict: Verdict = { act: "pass" };
      if (r.status === 401) {
        kind = "token";
        verdict = { act: "next" };
        const why = `${name}: Claude не принял токен аккаунта (401) — аккаунт выбыл из выбора; замените токен во «Флоте»`;
        mark(name, (a) => void Object.assign(a, { ok: false, why: "токен не принят" }));
        host.log.error("account.token", { account: name, callsign: route.callsign, word: "bad_token", why });
        void host.call(incidentRaise, { to: `@${host.machine}`, kind: ACCOUNT_INCIDENT, key: name, text: why }).catch((e: unknown) => host.log.warn("incident", { account: name, why: `обращение «аккаунт» не открыто: ${say(e)}` }));
      } else if (r.status === 429) {
        const window = closed(r.headers);
        const after = Number(r.headers["retry-after"]);
        if (window) {
          kind = KIND[window.name];
          verdict = { act: "next" };
          // проба закрытого окна, которое так и осталось закрытым, — не новость: второй строки о закрытии нет
          const still = route.callsign === PROBE && was?.limits[window.name]?.used === 1 && was.limits[window.name]?.resets === window.resets;
          mark(name, (a) => void (a.limits[window.name] = { used: 1, resets: window.resets, at: t }));
          seen.set(name, t);
          report(name, { [window.name]: { used: 1, resets: window.resets } }, t);
          if (!still) host.log.warn("account.closed", { account: name, callsign: route.callsign, kind, why: `${name}: ${LIMIT_WORD[window.name]} выбрано${window.resets ? ` — закрыто до ${clock(window.resets)}` : ""}` });
          plan();
        } else if (after > 0 && after <= THROTTLE_MAX_S && !r.waited) {
          kind = "throttle";
          verdict = { act: "wait", ms: after * 1000 };
        } else {
          kind = "concurrents";
          verdict = { act: "next" };
          const n = flying.get(name) ?? 1;
          full.set(name, n);
          host.log.warn("account.full", { account: name, callsign: route.callsign, kind, flying: n, why: `${name}: аккаунт полон — Claude отказал при ${n} вызовах разом; новые сессии идут на другие` });
        }
      } else if (r.status === 529) kind = "overloaded";
      host.log[r.status < 400 ? "info" : "warn"]("call", { ...line, account: name, ...(kind ? { kind } : {}), ...(r.status >= 400 ? { headers: refusalHeaders(r.headers) } : {}) });
      return verdict;
    },

    done(route) {
      const name = route.account;
      if (!name) return;
      const n = Math.max(0, (flying.get(name) ?? 1) - 1);
      flying.set(name, n);
      // вызовов стало меньше, чем при отказе, — аккаунт снова в выборе
      if (full.has(name) && n < full.get(name)!) full.delete(name);
    },

    proxied(url) {
      proxyUrl = url;
    },

    async keyRoute(name) {
      const [config, models] = await Promise.all([takeKey(name), catalog(name)]);
      const m = models[0];
      // разовый запуск идёт тем же одним способом, что процесс сессии: вместо секрета — слово, настоящий ставит прокси
      return { callsign: `key.check ${name}`, to: config.base ?? ANTHROPIC, protocol: m?.protocol ?? (config.protocol as Protocol), key: values.get(name)!, name, ...(m ? { model: m.id } : {}), ...(m?.window ? { window: m.window } : {}), env: { ...config.env, CLAUDE_CODE_OAUTH_TOKEN: FLEET_WORD } };
    },

    async offers() {
      const { keys } = await within(host.call(keysList, {}), READ_MS, `список ключей флота: службы не ответили за ${READ_MS / 1000} с`);
      const names = [...(keys.some((k) => k.protocol === CLAUDE) ? [CLAUDE] : []), ...keys.filter((k) => k.protocol !== CLAUDE).map((k) => k.name)];
      // каталог одного провайдера не ответил — остальные в списке остаются
      const lists = await Promise.all(names.map((n) => catalog(n).then((ms) => ms.map((m) => ({ key: n, model: m.id, ...(m.name ? { name: m.name } : {}), ...(m.family ? { family: m.family } : {}) })), () => [])));
      return lists.flat();
    },
  };

  return {
    name: "host-accounts",
    api,
    spec: {
      key(value) {
        if (typeof value !== "string" || !value) throw new Refusal("bad_spec", "key — имя провайдера: claude или имя ключа флота");
      },
      model(value) {
        if (typeof value !== "string" || !value) throw new Refusal("bad_spec", "model — точное имя модели из каталога провайдера (keys.models)");
      },
    },
    fill: {
      /** Провайдера называют всегда: значения «по умолчанию» нет. */
      key() {
        throw new Refusal("key_required", "назовите провайдера и модель: key — claude или имя ключа флота (keys.list), model — точное имя из его каталога (keys.models)");
      },
    },
    /** Провайдер и модель согласованы: модель есть в каталоге провайдера. Нет — отказ словом, документ не меняется. */
    async doc(spec, keys) {
      if (!keys.includes("key") && !keys.includes("model")) return;
      if (!spec.key) throw new Refusal("key_required", "назовите провайдера: key — claude или имя ключа флота (keys.list)");
      if (!spec.model) throw new Refusal("model_required", `назовите модель: model — точное имя из каталога провайдера ${spec.key} (keys.models)`);
      fresh.set(`${spec.key}/${spec.model}`, await learn(spec.key, spec.model));
    },
    /** Документ записан — пара доходит до живого процесса командой; прокси с этой секунды шлёт вызовы новой паре, и проба процесса идёт уже новому провайдеру.
     *  Отказ или молчание процесса — запись о паре возвращена, отказ словом: документ возвращает ядро. Перезапуск — только когда процессу нужно другое окружение. */
    async applied(s, keys) {
      if (!keys.includes("key") && !keys.includes("model")) return;
      const id = `${s.spec.key}/${s.spec.model}`;
      const pair = fresh.get(id) ?? (await learn(s.spec.key!, s.spec.model!));
      fresh.delete(id);
      const was = seatOf(s).get();
      // та же пара, что уже в документе: ни команды, ни перезапуска
      if (was?.pair && was.pair.key === pair.key && was.pair.model === pair.model) return void seatOf(s).update((x) => ({ ...x, pair }));
      const cached = caches.get(s.callsign);
      const t0 = now();
      // кэш новой модели холодный до её первого ответа; привязка к аккаунту Claude остаётся, пока провайдер тот же
      seatOf(s).set({ ...(pair.key === was?.pair?.key ? { account: was.account, at: was.at } : {}), pair, ran: was?.ran });
      caches.delete(s.callsign);
      answered.delete(s.callsign);
      disarm(s.callsign);
      const live = s.state === "idle" || s.state === "busy" || s.state === "waiting";
      if (live) {
        if (s.state !== "idle") swapped.add(s.callsign);
        try {
          await swap(s, procModel(pair));
        } catch (e) {
          seatOf(s).set(was);
          if (cached) caches.set(s.callsign, cached);
          swapped.delete(s.callsign);
          // процесс молчит: что он сделал с командой, неизвестно — после хода чистый перезапуск на паре документа
          if ((e as { late?: boolean }).late) void s.restart();
          throw new Refusal("model_refused", `${id}: ${say(e).replace(/^.*setModel — /, "")}`);
        }
        const restart = launchSig(pair) !== was?.ran;
        if (restart) void s.restart();
        host.log.info("model_switch", { callsign: s.callsign, from: was?.pair ? `${was.pair.key}/${was.pair.model}` : "", to: id, protocol: pair.protocol, how: restart ? "restart" : "hot", ms: now() - t0, why: `${s.callsign}: модель ${id}${restart ? " — после хода перезапуск: другое окружение" : ""}` });
      }
      s.sync();
    },
    // один способ запуска для любого провайдера: своего входа у процесса нет, вместо секрета слово — настоящий ставит прокси.
    // Пара — из записи сессии, пока она о паре документа: на старте связи может не быть.
    async compose(s): Promise<QueryPart> {
      const pair = await pairOf(s);
      seatOf(s).update((x) => ({ ...x, ran: launchSig(pair) }));
      return {
        model: procModel(pair),
        env: { ...launchEnv(pair), CLAUDE_CODE_OAUTH_TOKEN: FLEET_WORD },
        ...(pair.settings ? { defaults: { settings: pair.settings } } : {}),
      };
    },
    row(s) {
      const seat = seatOf(s).get();
      const c = cacheOfSession(s);
      const armed = compacts.get(s.callsign);
      return {
        ...(onClaude(s) && seat?.account ? { account: seat.account } : {}), ...(onClaude(s) && seat?.cut && seat.wait ? { wait: seat.wait } : {}),
        // итог, а не правило: часы кэша считает хозяин пары, страница их только показывает
        ...(c ? { cache: { ...(hours(c).until ? { until: hours(c).until } : {}), ...(armed ? { compact: armed.at } : {}), size: c.size, read: c.read } } : {}),
        ...(seat?.answers ? { answers: seat.answers } : {}),
      };
    },
    on: {
      event(s, m) {
        if (m.type === "assistant" && !m.parent_tool_use_id && !m.isReplay) said(s, m);
        // конец вызова в основном разговоре: итоговые числа запроса
        if (m.type === "stream_event" && !m.parent_tool_use_id && m.event?.type === "message_delta" && m.event.usage) {
          const pair = seatOf(s).get()?.pair, model = answered.get(s.callsign);
          if (pair && model && pair.key === s.spec.key && pair.model === s.spec.model) used(s, model, pair, m.event.usage);
        }
        // разговор сжат: кэш написан заново, размер — после сжатия
        const c = cacheOfSession(s);
        if (m.type === "system" && m.subtype === "compact_boundary" && c) {
          const meta = (m.compact_metadata ?? m.compactMetadata ?? {}) as { post_tokens?: number; postTokens?: number };
          caches.set(s.callsign, { ...c, at: now(), size: meta.post_tokens ?? meta.postTokens ?? 0 });
        }
      },
      state(s, state: SessionState) {
        if (state === "idle") {
          swapped.delete(s.callsign);
          flush(s);
          if (seatOf(s).get()?.cut) revive();
        }
        arm(s);
        s.sync();
      },
      removed(callsign) {
        disarm(callsign);
        caches.delete(callsign);
        answered.delete(callsign);
        late.delete(callsign);
        swapped.delete(callsign);
      },
      changed(what) {
        if (what !== "keys") return;
        // ключи флота сменили: значения забыты, аккаунты перечитаны; ждавшие сессии продолжают на новом аккаунте
        values.clear();
        tokens.clear();
        void load().then(() => (revive(), plan()), (e) => host.log.warn("accounts", { why: `аккаунты Claude не перечитаны: ${say(e)}` }));
      },
    },
    requests: {
      async "account.list"(i: { fresh?: boolean }) {
        // список аккаунтов — у службы ключей: только что добавленный виден сразу, без ожидания кадра «изменилось»
        await load().catch((e) => host.log.warn("accounts", { why: `аккаунты Claude не прочитаны: ${say(e)}` }));
        // закрытое окно само до своего сброса не откроется — его не спрашиваем; fresh — человек сбросил лимиты у Claude: спрашиваются все аккаунты
        const open = (a: Account) => fits(a, true, now(), true) || fits(a, false, now(), true);
        const stale = Object.keys(book()).filter((n) => tokens.has(n) && (i.fresh || (open(book()[n]!) && (seen.get(n) ?? 0) < now() - FRESH_MS)));
        // ответ не ждёт пробу дольше предела: её числа придут к следующему вопросу
        await within(Promise.all(stale.map(probe)), PROBE_MS, "проба не успела").catch(() => {});
        // окно открылось раньше своего часа — сессии с оборванным ходом продолжают, побудка считается заново
        if (i.fresh) {
          revive();
          plan();
        }
        const t = now();
        const accounts: AccountOut[] = Object.entries(book()).map(([name, a]) => ({ name, ok: a.ok, ...(a.why ? { why: a.why } : {}), limits: shown(a, t), keep: a.keep, ...(isFull(name) ? { full: true } : {}) }));
        return { accounts };
      },
    },
    start(h) {
      host = h;
      // связи на старте может не быть: первый вызов сессии прочитает аккаунты сам
      void load().then(() => (revive(), plan()), (e) => host.log.warn("accounts", { why: `аккаунты Claude не прочитаны: ${say(e)}` }));
      plan();
      rounds(true);
    },
    stop() {
      stopping = true;
      host.clock.clearTimeout(wake);
      host.clock.clearTimeout(round);
      for (const callsign of [...compacts.keys()]) disarm(callsign);
    },
  };
}
