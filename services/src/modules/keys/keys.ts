// Ключи флота — провайдеры моделей: аккаунты Claude (годовой токен), аккаунты ChatGPT (вход, который служба обновляет сама) и ключи API провайдеров.
// Значение получает только машина. Настройки аккаунта Claude — флаг запаса Fable и рычаг (выключен, по счёту, первым) — называет только список ключей.
// Каталог моделей служба спрашивает у провайдера на каждый запрос и копии не держит.
import { CLAUDE, errFields, Refusal, USE_WORD, type Model, type Protocol, type Use } from "@sb/protocol";
import type { Ctx, Env, Module } from "../../env.ts";
import { records } from "../../records.ts";
import { line } from "../analytics/contract.ts";

const NAME = "keys";
const SCHEMA = [
  // provider — вид API ключа: в договоре он зовётся protocol
  "CREATE TABLE IF NOT EXISTS keys (name TEXT PRIMARY KEY, provider TEXT, value TEXT, base TEXT, at INTEGER)",
  // дополнения ключа одним объектом: настройки и окружение сессии; у аккаунта Claude — флаг запаса Fable, рычаг и когда записан токен
  "CREATE TABLE IF NOT EXISTS keyopts (name TEXT PRIMARY KEY, opts TEXT NOT NULL)",
  // окна лимитов аккаунта Claude, одни на флот: что последней увидела любая машина
  "CREATE TABLE IF NOT EXISTS limits (name TEXT NOT NULL, win TEXT NOT NULL, used REAL NOT NULL, resets INTEGER, at INTEGER NOT NULL, PRIMARY KEY (name, win))",
];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

/** keep — беречь запас недели под Fable; use — как флот пользуется аккаунтом (не записан — по счёту); since — когда записано значение, мс. */
type Opts = { settings?: Record<string, unknown>; env?: Record<string, string>; cache?: number; keep?: boolean; use?: Use; since?: number };
type Stored = { name: string; provider: string; value: string; base: string | null; at: number; opts: string | null };
type Seen = { name: string; win: string; used: number; resets: number | null; at: number };
type Input = { name: string; protocol: string; value?: string; base?: string; keep?: boolean; use?: Use; settings?: Record<string, unknown>; env?: Record<string, string>; cache?: number };

const SELECT = "SELECT keys.name, keys.provider, keys.value, keys.base, keys.at, keyopts.opts AS opts FROM keys LEFT JOIN keyopts ON keyopts.name = keys.name";
/** Токен `claude setup-token` действует год. */
const TOKEN_MS = 365 * 24 * 3_600_000;
const ANTHROPIC = "https://api.anthropic.com";
/** Срок ответа провайдера о каталоге. */
const CATALOG_MS = 15_000;

/** Аккаунт ChatGPT: сервер входа OpenAI и его клиент Codex; бэкенд подписки. Каталог моделей — файл каталога Codex в открытом репо OpenAI:
 *  бэкенд подписки запросам из Worker'а закрыт (замер 18 нояб.: 403), репо отвечает без токена. */
const CHATGPT = "chatgpt";
const OPENAI_TOKEN = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_BASE = "https://chatgpt.com/backend-api/codex";
const CHATGPT_CATALOG = "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
/** Срок обмена токена: короче, чем машина ждёт ответ служб. */
const EXCHANGE_MS = 8_000;
/** Токен доступа меняется за сутки до своего срока: вызов, начатый на прежнем, успевает кончиться. */
const AHEAD_MS = 24 * 3_600_000;

/** Вход аккаунта ChatGPT — значение его ключа: токен доступа для вызовов и refresh-токен для обмена. */
type Login = { access: string; refresh: string };
const loginOf = (s: Stored): Login => JSON.parse(s.value) as Login;
/** Срок токена доступа — из него самого, мс. */
function expiryOf(access: string): number | undefined {
  try {
    const exp = (JSON.parse(atob(access.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Обмен refresh-токена на новый вход. OpenAI отказал — bad_token его словами: вход умер. Сеть, срок и сбой сервера входа — upstream: вход цел. */
async function exchange(ctx: Ctx, name: string, refresh: string): Promise<Login> {
  let res: Response;
  try {
    res = await ctx.fetch(OPENAI_TOKEN, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(EXCHANGE_MS),
      body: JSON.stringify({ client_id: OPENAI_CLIENT, grant_type: "refresh_token", refresh_token: refresh, scope: "openid profile email" }),
    });
  } catch (e) {
    throw new Refusal("upstream", `вход ChatGPT ${name}: сервер входа OpenAI не ответил — ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  if (res.status >= 500 || res.status === 429) throw new Refusal("upstream", `вход ChatGPT ${name}: сервер входа OpenAI ответил ${res.status}`);
  let j: { access_token?: string; refresh_token?: string; error?: string | { code?: string; message?: string }; error_description?: string } = {};
  try {
    j = JSON.parse(text);
  } catch {
    // ответ не JSON — причина ниже по статусу
  }
  if (!res.ok || !j.access_token || expiryOf(j.access_token) === undefined) {
    const said = typeof j.error === "string" ? [j.error, j.error_description] : [j.error?.code, j.error?.message];
    throw new Refusal("bad_token", `вход ChatGPT ${name}: ${said.filter(Boolean).join(": ") || `OpenAI ответил ${res.status}`}`);
  }
  return { access: j.access_token, refresh: j.refresh_token ?? refresh };
}

type Codex = { slug?: string; display_name?: string; context_window?: number; visibility?: string };
/** Каталог аккаунта ChatGPT: модели, которые Codex показывает в списке. */
async function chatgptCatalog(ctx: Ctx, name: string): Promise<{ models: Model[] }> {
  let res: Response;
  try {
    res = await ctx.fetch(CHATGPT_CATALOG, { signal: AbortSignal.timeout(CATALOG_MS) });
  } catch (e) {
    throw new Refusal("catalog_failed", `каталог ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Refusal("catalog_failed", `каталог ${name}: репо OpenAI ответило ${res.status}`);
  const list = ((await res.json().catch(() => null)) as { models?: Codex[] } | null)?.models;
  if (!Array.isArray(list)) throw new Refusal("catalog_failed", `каталог ${name}: в файле репо OpenAI нет списка моделей`);
  return {
    models: list.filter((m) => typeof m.slug === "string" && m.slug && m.visibility === "list").map((m) => ({
      id: m.slug!, ...(m.display_name && m.display_name !== m.slug ? { name: m.display_name } : {}), ...(m.context_window ? { window: m.context_window } : {}), protocol: CHATGPT,
    })),
  };
}

const optsOf = (s: Stored): Opts => (s.opts ? (JSON.parse(s.opts) as Opts) : {});
/** Свойства ключа наружу — и в список, и машине с токеном: адрес, настройки и окружение сессии. */
function extras(s: Stored) {
  const o = optsOf(s);
  return { ...(s.base ? { base: s.base } : {}), ...(o.settings ? { settings: o.settings } : {}), ...(o.env ? { env: o.env } : {}), ...(o.cache ? { cache: o.cache } : {}) };
}
/** Рычаг аккаунта Claude: не записан — по счёту. */
const useOf = (s: Stored): Use => optsOf(s).use ?? "auto";
/** Настройки аккаунта Claude — только в список ключей: флаг запаса и рычаг. */
const accountOf = (s: Stored) => (s.provider === CLAUDE ? { keep: optsOf(s).keep !== false, use: useOf(s) } : {});
const told = (ctx: Ctx) => ctx.platform.broadcast(ctx.fleet, { type: "changed", what: "keys", trace: ctx.trace }, "host");

/** Сессии флота, которые сейчас идут на ключе: провайдер — по документу сессии, аккаунт Claude — по строке сессии. */
async function sessionsOn(ctx: Ctx): Promise<Map<string, string[]>> {
  const by = new Map<string, string[]>();
  for (const s of await ctx.platform.sessions(ctx.fleet)) {
    const name = s.account ?? s.spec?.key;
    if (name) (by.get(name) ?? by.set(name, []).get(name)!).push(s.callsign);
  }
  return by;
}

type Listed = { id?: string; display_name?: string; name?: string; family?: string; owned_by?: string; max_input_tokens?: number; context_length?: number; context_window?: number; supported_endpoint_types?: unknown };
/** Каким API говорить с моделью: что объявил о ней провайдер — Anthropic, если он есть, иначе OpenAI; не объявил ничего — вид ключа.
 *  Объявил, но разговорного API среди объявленного нет (картинки, видео, эмбеддинги) — модели в каталоге сессий нет. */
function protocolOf(m: Listed, key: Protocol): Protocol | undefined {
  const said = m.supported_endpoint_types;
  if (!Array.isArray(said)) return key;
  if (said.includes("anthropic")) return "anthropic";
  return said.includes("openai-response") || said.includes("openai") ? "openai" : undefined;
}
/** Семейство модели Claude — слово её имени: claude-opus-4-8 → Opus. */
const claudeFamily = (id: string) => {
  const word = /^claude-(?:[\d.-]+-)?([a-z]+)/.exec(id)?.[1];
  return word ? word[0]!.toUpperCase() + word.slice(1) : undefined;
};
/** Модель каталога — как её отдал провайдер: имя, семейство и окно, если он их назвал, и протокол. */
function modelOf(m: Listed, key: Protocol, protocol: Protocol): Model {
  const name = m.display_name ?? m.name;
  const family = m.family ?? (key === CLAUDE ? claudeFamily(m.id!) : m.owned_by);
  const window = m.max_input_tokens ?? m.context_length ?? m.context_window;
  return { id: m.id!, ...(name && name !== m.id ? { name } : {}), ...(family ? { family } : {}), ...(window ? { window } : {}), protocol };
}

/** Один вопрос провайдеру о его каталоге. status — статус отказа: по нему каталог Claude идёт к следующему аккаунту.
 *  Ключ OpenAI-вида спрашивает список по-OpenAI — без заголовка версии Anthropic: провайдер с двумя API называет виды API своих моделей только в нём. */
async function catalog(ctx: Ctx, base: string, headers: Record<string, string>, key: Protocol): Promise<{ models: Model[] } | { status: number; why: string }> {
  // адрес провайдера назван с версией API или без неё
  const root = base.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await ctx.fetch(`${/\/v\d+$/.test(root) ? root : `${root}/v1`}/models?limit=1000`, { headers: { ...(key === "openai" ? {} : { "anthropic-version": "2023-06-01" }), ...headers }, signal: AbortSignal.timeout(CATALOG_MS) });
  } catch (e) {
    return { status: 0, why: e instanceof Error ? e.message : String(e) };
  }
  const text = await res.text();
  if (!res.ok) return { status: res.status, why: `провайдер ответил ${res.status}: ${text.slice(0, 200)}` };
  try {
    const list = (JSON.parse(text) as { data?: Listed[] }).data;
    if (!Array.isArray(list)) return { status: res.status, why: "в ответе провайдера нет списка моделей" };
    return { models: list.filter((m) => typeof m.id === "string" && m.id).flatMap((m) => { const p = protocolOf(m, key); return p ? [modelOf(m, key, p)] : []; }) };
  } catch {
    return { status: res.status, why: "ответ провайдера — не JSON" };
  }
}

export const keys: Module = {
  name: NAME,
  handlers: {
    async "keys.list"(_i, ctx) {
      const d = db(ctx.env, ctx.fleet);
      const [rows, on, seen] = await Promise.all([d.all<Stored>(`${SELECT} ORDER BY keys.name`), sessionsOn(ctx), d.all<Seen>("SELECT name, win, used, resets, at FROM limits ORDER BY name, win")]);
      const limitsOf = (name: string) => seen.filter((l) => l.name === name).map((l) => ({ name: l.win, used: l.used, ...(l.resets ? { resets: l.resets } : {}), at: l.at }));
      return {
        keys: rows.map((s) => {
          const since = optsOf(s).since;
          return {
            name: s.name, protocol: s.provider, at: s.at, tail: (s.provider === CHATGPT ? loginOf(s).access : s.value).slice(-4), ...extras(s), ...accountOf(s),
            ...(s.provider === CLAUDE && since ? { expires: since + TOKEN_MS } : {}), sessions: on.get(s.name)?.length ?? 0,
            ...(s.provider === CLAUDE && limitsOf(s.name).length ? { limits: limitsOf(s.name) } : {}),
          };
        }),
      };
    },

    async "keys.set"(i: Input, ctx) {
      // это имя занято провайдером «аккаунты Claude флота»
      if (i.name === CLAUDE) throw new Refusal("bad_input", `имя ${CLAUDE} занято: так в документе сессии зовутся аккаунты Claude флота`);
      const d = db(ctx.env, ctx.fleet);
      const was = await d.first<Stored>(`${SELECT} WHERE keys.name = ?`, i.name);
      // без значения правятся свойства уже записанного ключа
      if (i.value === undefined && !was) throw new Refusal("not_found", `ключа ${i.name} нет: первому сохранению нужно значение`);
      // ключ другого вида аккаунтом ChatGPT без входа не становится: в его записи лежал бы не вход
      if (i.protocol === CHATGPT && i.value === undefined && was!.provider !== CHATGPT) throw new Refusal("bad_input", `${i.name}: аккаунту ChatGPT нужен refresh-токен входа`);
      // аккаунт ChatGPT: значение — refresh-токен входа; обмен сразу — негодный вход виден при записи, ключ не записан
      const login = i.protocol === CHATGPT && i.value !== undefined ? await exchange(ctx, i.name, i.value) : undefined;
      const before = was ? optsOf(was) : {};
      const now = Date.now();
      const opts: Opts = {
        ...(i.settings ?? before.settings ? { settings: i.settings ?? before.settings } : {}),
        ...(i.env ?? before.env ? { env: i.env ?? before.env } : {}),
        // 0 — срок снят: провайдер его не называет, и человек больше не утверждает
        ...((i.cache ?? before.cache) ? { cache: i.cache ?? before.cache } : {}),
        // у аккаунта Claude запас Fable бережётся, пока человек не снял флаг; рычаг стоит, пока его не повернули
        ...(i.protocol === CLAUDE ? { keep: i.keep ?? before.keep ?? true, ...((i.use ?? before.use) ? { use: i.use ?? before.use } : {}), since: i.value !== undefined ? now : before.since } : {}),
      };
      const turned = i.protocol === CLAUDE && i.use !== undefined && i.use !== (was && was.provider === CLAUDE ? useOf(was) : "auto");
      await d.batch([
        ["INSERT OR REPLACE INTO keys (name, provider, value, base, at) VALUES (?, ?, ?, ?, ?)", i.name, i.protocol, login ? JSON.stringify(login) : (i.value ?? was!.value), i.base ?? was?.base ?? (i.protocol === CHATGPT ? CHATGPT_BASE : null), now],
        Object.keys(opts).length ? ["INSERT OR REPLACE INTO keyopts (name, opts) VALUES (?, ?)", i.name, JSON.stringify(opts)] : ["DELETE FROM keyopts WHERE name = ?", i.name],
      ]);
      await told(ctx);
      // рычаг повёрнут: кто и как — строкой истории флота; история не ответила — рычаг всё равно повёрнут
      if (turned) {
        await line(ctx.env, ctx.fetch, ctx.fleet, { file: NAME, msg: "account.use", account: i.name, kind: i.use, text: `${i.name.split("@")[0]}: ${USE_WORD[i.use!]} · ${ctx.who.addr}`, data: { by: ctx.who.addr } })
          .catch((e: unknown) => ctx.log.warn("строка истории о рычаге аккаунта не записалась", { module: NAME, account: i.name, ...errFields(e) }));
      }
      return {};
    },

    async "keys.remove"(i: { name: string; probe?: boolean }, ctx) {
      // проба: ничего не удаляет — человек видит, какие сессии останутся без ключа
      if (i.probe) return { sessions: (await sessionsOn(ctx)).get(i.name) ?? [] };
      await db(ctx.env, ctx.fleet).batch([
        ["DELETE FROM keys WHERE name = ?", i.name],
        ["DELETE FROM keyopts WHERE name = ?", i.name],
        ["DELETE FROM limits WHERE name = ?", i.name],
      ]);
      await told(ctx);
      return {};
    },

    /** Окна аккаунта от машины: по окну остаётся последнее по времени. Обычные числа машинам не рассылаются — они берут их со списком ключей.
     *  Закрытое окно открылось раньше своего часа (человек сбросил лимиты у Claude) — машины перечитывают аккаунты: сами они до этого часа его не спросят. */
    async "keys.limits"(i: { name: string; limits: Array<{ name: string; used: number; resets?: number; at: number }> }, ctx) {
      const d = db(ctx.env, ctx.fleet);
      const s = await d.first<Stored>(`${SELECT} WHERE keys.name = ?`, i.name);
      if (!s || s.provider !== CLAUDE) throw new Refusal("not_found", `аккаунта Claude ${i.name} у флота нет`);
      if (!i.limits.length) return {};
      const was = await d.all<Seen>("SELECT name, win, used, resets, at FROM limits WHERE name = ?", i.name);
      await d.batch(i.limits.map((l) => [
        "INSERT INTO limits (name, win, used, resets, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (name, win) DO UPDATE SET used = excluded.used, resets = excluded.resets, at = excluded.at WHERE excluded.at >= limits.at",
        i.name, l.name, l.used, l.resets ?? null, l.at,
      ]));
      const reopened = i.limits.some((l) => l.used < 1 && was.some((w) => w.win === l.name && w.used >= 1 && l.at >= w.at && (w.resets ?? 0) > l.at));
      if (reopened) await told(ctx);
      return {};
    },

    async "keys.value"(i: { name: string }, ctx) {
      const d = db(ctx.env, ctx.fleet);
      const s = await d.first<Stored>(`${SELECT} WHERE keys.name = ?`, i.name);
      if (!s) throw new Refusal("not_found", `ключа ${i.name} нет`);
      if (s.provider === CHATGPT) {
        let login = loginOf(s);
        // машинам «ключи изменились» не рассылается: прежний токен работает до своего срока, каждая машина придёт по своему until
        if (Date.now() >= (expiryOf(login.access) ?? 0) - AHEAD_MS) {
          login = await exchange(ctx, s.name, login.refresh);
          await d.run("UPDATE keys SET value = ? WHERE name = ?", JSON.stringify(login), s.name);
        }
        return { value: login.access, protocol: s.provider, until: expiryOf(login.access)! - AHEAD_MS, ...extras(s) };
      }
      return { value: s.value, protocol: s.provider, ...extras(s) };
    },

    /** Каталог провайдера — его ответ на этот запрос. Каталог Claude — токеном первого включённого аккаунта, который Claude принял. */
    async "keys.models"(i: { name: string }, ctx) {
      const d = db(ctx.env, ctx.fleet);
      if (i.name !== CLAUDE) {
        const s = await d.first<Stored>(`${SELECT} WHERE keys.name = ?`, i.name);
        if (!s || s.provider === CLAUDE) throw new Refusal("no_key", s ? `${i.name} — аккаунт Claude: его модели — в каталоге ${CLAUDE}` : `ключа ${i.name} нет`);
        if (s.provider === CHATGPT) return chatgptCatalog(ctx, i.name);
        const r = await catalog(ctx, s.base ?? ANTHROPIC, { "x-api-key": s.value, authorization: `Bearer ${s.value}` }, s.provider as Protocol);
        if ("status" in r) throw new Refusal("catalog_failed", `каталог ${i.name}: ${r.why}`);
        return r;
      }
      const all = await d.all<Stored>(`${SELECT} WHERE keys.provider = ? ORDER BY keys.name`, CLAUDE);
      if (!all.length) throw new Refusal("no_account", "аккаунтов Claude у флота нет");
      // токеном выключенного аккаунта к Claude не ходит никто
      const accounts = all.filter((a) => useOf(a) !== "off");
      if (!accounts.length) throw new Refusal("no_account", "включённых аккаунтов Claude у флота нет: все выключены");
      let why = "";
      for (const a of accounts) {
        const r = await catalog(ctx, a.base ?? ANTHROPIC, { authorization: `Bearer ${a.value}`, "anthropic-beta": "oauth-2025-04-20" }, CLAUDE);
        if (!("status" in r)) return r;
        why = `${a.name}: ${r.why}`;
        // токен не принят — спросить следующим аккаунтом; остальное — отказ самого Claude
        if (r.status !== 401 && r.status !== 403) break;
      }
      throw new Refusal("catalog_failed", `каталог Claude: ${why}`);
    },
  },
};
