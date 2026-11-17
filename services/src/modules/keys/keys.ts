// Ключи флота — провайдеры моделей: аккаунты Claude (годовой токен) и ключи API провайдеров. Значение получает только машина.
// Каталог моделей служба спрашивает у провайдера на каждый запрос и копии не держит.
import { CLAUDE, Refusal, type Model, type Protocol } from "@sb/protocol";
import type { Ctx, Env, Module } from "../../env.ts";
import { records } from "../../records.ts";

const NAME = "keys";
const SCHEMA = [
  // provider — вид API ключа: в договоре он зовётся protocol
  "CREATE TABLE IF NOT EXISTS keys (name TEXT PRIMARY KEY, provider TEXT, value TEXT, base TEXT, at INTEGER)",
  // дополнения ключа одним объектом: настройки и окружение сессии; у аккаунта Claude — флаг запаса Fable и когда записан токен
  "CREATE TABLE IF NOT EXISTS keyopts (name TEXT PRIMARY KEY, opts TEXT NOT NULL)",
  // окна лимитов аккаунта Claude, одни на флот: что последней увидела любая машина
  "CREATE TABLE IF NOT EXISTS limits (name TEXT NOT NULL, win TEXT NOT NULL, used REAL NOT NULL, resets INTEGER, at INTEGER NOT NULL, PRIMARY KEY (name, win))",
];
const db = (env: Env, fleet: string) => records(env, fleet, NAME, SCHEMA);

/** keep — беречь запас недели под Fable; since — когда записано значение, мс. */
type Opts = { settings?: Record<string, unknown>; env?: Record<string, string>; cache?: number; keep?: boolean; since?: number };
type Stored = { name: string; provider: string; value: string; base: string | null; at: number; opts: string | null };
type Seen = { name: string; win: string; used: number; resets: number | null; at: number };
type Input = { name: string; protocol: string; value?: string; base?: string; keep?: boolean; settings?: Record<string, unknown>; env?: Record<string, string>; cache?: number };

const SELECT = "SELECT keys.name, keys.provider, keys.value, keys.base, keys.at, keyopts.opts AS opts FROM keys LEFT JOIN keyopts ON keyopts.name = keys.name";
/** Токен `claude setup-token` действует год. */
const TOKEN_MS = 365 * 24 * 3_600_000;
const ANTHROPIC = "https://api.anthropic.com";
/** Срок ответа провайдера о каталоге. */
const CATALOG_MS = 15_000;

const optsOf = (s: Stored): Opts => (s.opts ? (JSON.parse(s.opts) as Opts) : {});
/** Свойства ключа наружу: адрес, настройки и окружение сессии; у аккаунта Claude — флаг запаса. */
function extras(s: Stored) {
  const o = optsOf(s);
  return {
    ...(s.base ? { base: s.base } : {}), ...(o.settings ? { settings: o.settings } : {}), ...(o.env ? { env: o.env } : {}), ...(o.cache ? { cache: o.cache } : {}),
    ...(s.provider === CLAUDE ? { keep: o.keep !== false } : {}),
  };
}
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

/** Один вопрос провайдеру о его каталоге. status — статус отказа: по нему каталог Claude идёт к следующему аккаунту. */
async function catalog(ctx: Ctx, base: string, headers: Record<string, string>, key: Protocol): Promise<{ models: Model[] } | { status: number; why: string }> {
  // адрес провайдера назван с версией API или без неё
  const root = base.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await ctx.fetch(`${/\/v\d+$/.test(root) ? root : `${root}/v1`}/models?limit=1000`, { headers: { "anthropic-version": "2023-06-01", ...headers }, signal: AbortSignal.timeout(CATALOG_MS) });
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
            name: s.name, protocol: s.provider, at: s.at, tail: s.value.slice(-4), ...extras(s),
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
      const before = was ? optsOf(was) : {};
      const now = Date.now();
      const opts: Opts = {
        ...(i.settings ?? before.settings ? { settings: i.settings ?? before.settings } : {}),
        ...(i.env ?? before.env ? { env: i.env ?? before.env } : {}),
        // 0 — срок снят: провайдер его не называет, и человек больше не утверждает
        ...((i.cache ?? before.cache) ? { cache: i.cache ?? before.cache } : {}),
        // у аккаунта Claude запас Fable бережётся, пока человек не снял флаг
        ...(i.protocol === CLAUDE ? { keep: i.keep ?? before.keep ?? true, since: i.value !== undefined ? now : before.since } : {}),
      };
      await d.batch([
        ["INSERT OR REPLACE INTO keys (name, provider, value, base, at) VALUES (?, ?, ?, ?, ?)", i.name, i.protocol, i.value ?? was!.value, i.base ?? was?.base ?? null, now],
        Object.keys(opts).length ? ["INSERT OR REPLACE INTO keyopts (name, opts) VALUES (?, ?)", i.name, JSON.stringify(opts)] : ["DELETE FROM keyopts WHERE name = ?", i.name],
      ]);
      await told(ctx);
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
      const s = await db(ctx.env, ctx.fleet).first<Stored>(`${SELECT} WHERE keys.name = ?`, i.name);
      if (!s) throw new Refusal("not_found", `ключа ${i.name} нет`);
      return { value: s.value, protocol: s.provider, ...extras(s) };
    },

    /** Каталог провайдера — его ответ на этот запрос. Каталог Claude — токеном первого аккаунта, который Claude принял. */
    async "keys.models"(i: { name: string }, ctx) {
      const d = db(ctx.env, ctx.fleet);
      if (i.name !== CLAUDE) {
        const s = await d.first<Stored>(`${SELECT} WHERE keys.name = ?`, i.name);
        if (!s || s.provider === CLAUDE) throw new Refusal("no_key", s ? `${i.name} — аккаунт Claude: его модели — в каталоге ${CLAUDE}` : `ключа ${i.name} нет`);
        const r = await catalog(ctx, s.base ?? ANTHROPIC, { "x-api-key": s.value, authorization: `Bearer ${s.value}` }, s.provider as Protocol);
        if ("status" in r) throw new Refusal("catalog_failed", `каталог ${i.name}: ${r.why}`);
        return r;
      }
      const accounts = await d.all<Stored>(`${SELECT} WHERE keys.provider = ? ORDER BY keys.name`, CLAUDE);
      if (!accounts.length) throw new Refusal("no_account", "аккаунтов Claude у флота нет");
      let why = "";
      for (const a of accounts) {
        const r = await catalog(ctx, ANTHROPIC, { authorization: `Bearer ${a.value}`, "anthropic-beta": "oauth-2025-04-20" }, CLAUDE);
        if (!("status" in r)) return r;
        why = `${a.name}: ${r.why}`;
        // токен не принят — спросить следующим аккаунтом; остальное — отказ самого Claude
        if (r.status !== 401 && r.status !== 403) break;
      }
      throw new Refusal("catalog_failed", `каталог Claude: ${why}`);
    },
  },
};
