// Эталоны машины дизайна «Аккаунты и модели»: выбор аккаунта, привязка сессии, отказы Claude, провайдеры, сверка модели, «/model».
// Claude на стенде — локальный сервер: отвечает статусом и заголовками лимитов, как настоящий. Источник свойства — над каждым эталоном.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Module } from "../src/core/contract.ts";
import { make as accounts, type AccountsApi } from "../src/modules/accounts/accounts.ts";
import { choose, fits, type Account } from "../src/modules/accounts/limits.ts";
import { make as chat } from "../src/modules/chat/chat.ts";
import { make as proxy } from "../src/modules/proxy/proxy.ts";
import { stand, tick, until, type Stand } from "../stand/index.ts";

let st: Stand | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await st?.stop();
  st = undefined;
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

const A = "a@example.com", B = "b@example.com", C = "c@example.com";
const CS = "site@laptop";
const HOUR = 3_600_000;
/** Начало поддельных часов стенда. */
const T0 = Date.UTC(2026, 9, 30, 14, 0, 0);
const FABLE = "claude-fable-5-2", OPUS = "claude-opus-4-8", HAIKU = "claude-haiku-4-5";
const CATALOG = [
  { id: FABLE, name: "Claude Fable 5.2", family: "Fable", window: 1_000_000 }, { id: OPUS, name: "Claude Opus 4.8", family: "Opus", window: 1_000_000 },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", family: "Opus", window: 200_000 }, { id: HAIKU, name: "Claude Haiku 4.5", family: "Haiku", window: 200_000 },
];
const ORCA = [{ id: "qwen-3.5-coder", window: 256_000 }, { id: "glm-5.3", window: 200_000 }];

/** Запись аккаунта: неделя и окно Fable с часом сброса через hours часов. */
type Preset = { week?: number; hours?: number; fable?: number; keep?: boolean };
const record = (p: Preset): Account => ({
  ok: true, keep: p.keep ?? false, limits: {
    ...(p.week !== undefined ? { seven_day: { used: p.week, resets: T0 + (p.hours ?? 100) * HOUR, at: T0 } } : {}),
    ...(p.fable !== undefined ? { seven_day_overage_included: { used: p.fable, resets: T0 + (p.hours ?? 100) * HOUR, at: T0 } } : {}),
  },
});
const book = (all: Record<string, Preset>) => Object.fromEntries(Object.entries(all).map(([n, p]) => [n, record(p)]));

type Hit = { account: string; model: string; headers: IncomingHttpHeaders };
type Reply = { status?: number; headers?: Record<string, string>; /** тело ответа: у отказа — что написал провайдер */ body?: unknown };
const sec = (ms: number) => String(Math.floor(ms / 1000));
const U = "anthropic-ratelimit-unified";
/** Заголовки лимитов обычного ответа Claude. */
const windows = (o: { week?: number; hours?: number; fable?: number }): Record<string, string> => ({
  [`${U}-status`]: "allowed",
  ...(o.week !== undefined ? { [`${U}-7d-utilization`]: String(o.week), [`${U}-7d-reset`]: sec(T0 + (o.hours ?? 100) * HOUR) } : {}),
  ...(o.fable !== undefined ? { [`${U}-7d_oi-utilization`]: String(o.fable), [`${U}-7d_oi-reset`]: sec(T0 + (o.hours ?? 100) * HOUR) } : {}),
});
/** Отказ Claude по окну: 7d — неделя, 7d_oi — окно Fable. */
const rejected = (short: "7d" | "7d_oi", hours = 2): Reply => ({
  status: 429,
  headers: { [`${U}-status`]: "rejected", [`${U}-representative-claim`]: short === "7d" ? "seven_day" : "seven_day_overage_included", [`${U}-${short}-status`]: "rejected", [`${U}-${short}-reset`]: sec(T0 + hours * HOUR), [`${U}-reset`]: sec(T0 + hours * HOUR) },
});

/** Поддельный Claude: аккаунт вызова — по токену в Authorization. */
async function claudeApi(answer: (hit: Hit, n: number) => Reply): Promise<{ url: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const hit = { account: String(req.headers.authorization ?? "").replace("Bearer tok-", ""), model: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}").model as string, headers: req.headers };
      hits.push(hit);
      const a = answer(hit, hits.length);
      res.writeHead(a.status ?? 200, { "content-type": "application/json", "request-id": `req_${hits.length}`, ...a.headers }).end(JSON.stringify(a.body ?? { type: a.status && a.status >= 400 ? "error" : "message" }));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, hits };
}

const raised: Array<{ kind: string; key: string; text: string }> = [];
/** Подделка «Инцидентов»: помнит обращения. */
const incidents = (): Module => ({ name: "host-incidents", requests: { "incident.raise": (i: { kind: string; key: string; text: string }) => (raised.push(i), { id: String(raised.length) }) } });

/** Флот на стенде: аккаунты Claude с заданными окнами, провайдер orca, поддельный Claude. */
async function fleet(all: Record<string, Preset>, answer: (hit: Hit, n: number) => Reply = () => ({}), o: { home?: string; extra?: Module[] } = {}) {
  raised.length = 0;
  const api = await claudeApi(answer);
  const home = o.home ?? mkdtempSync(join(tmpdir(), "sb2-host-"));
  if (!o.home) {
    mkdirSync(join(home, "store"), { recursive: true });
    writeFileSync(join(home, "store", "host-accounts.json"), JSON.stringify({ machine: { accounts: book(all) } }));
  }
  st = await stand({ home, modules: [...(o.extra ?? []), accounts(), proxy(), incidents()] });
  /** limits — окна аккаунта, которые знает флот (служба ключей) */
  const names: { list: string[]; limits: Record<string, Array<{ name: string; used: number; resets?: number; at: number }>> } = { list: Object.keys(all), limits: {} };
  st.services.handlers["keys.list"] = () => ({ keys: [...names.list.map((n) => ({ name: n, protocol: "claude", at: 1, tail: "tail", keep: all[n]?.keep ?? false, ...(names.limits[n] ? { limits: names.limits[n] } : {}) })), { name: "orca", protocol: "anthropic", base: api.url, at: 1, tail: "orca" }] });
  st.services.handlers["keys.value"] = (f: any) => (f.name === "orca" ? { value: "sk-orca", protocol: "anthropic", base: api.url } : { value: `tok-${f.name}`, protocol: "claude", base: api.url });
  st.services.handlers["keys.models"] = (f: any) => ({ models: f.name === "claude" ? CATALOG : ORCA });
  st.services.handlers["prefs.get"] = () => ({ values: { "proxy.rules": [] } });
  return { ...api, names };
}
const claude = (model = FABLE) => ({ key: "claude", model });
const mod = () => st!.kernel.mods.find((m) => m.name === "host-accounts")!.api as AccountsApi;
const row = (cs = CS) => st!.link.rows(cs).at(-1)!.row as any;
const journal = (msg: string) => st!.journal().filter((l) => l.msg === msg) as any[];
const listed = async () => ((await st!.request("account.list", { to: "@laptop" })).result as any).accounts as Array<{ name: string; ok: boolean; why?: string; full?: boolean; limits: Array<{ name: string; used: number; resets?: number }> }>;
/** Вызов модели от процесса сессии через прокси машины. */
const call = (sid: string, model = FABLE) => {
  const base = (st!.sdk.queries.at(-1)!.options as any).env.ANTHROPIC_BASE_URL as string;
  return fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fleet", "x-claude-code-session-id": sid }, body: JSON.stringify({ model, messages: [{ role: "user", content: "привет" }] }) });
};
/** Маршрут без вызова: привязка и решение. */
const routed = async (sid: string) => {
  const r = await mod().route(sid);
  mod().done(r);
  return r.account;
};

describe("выбор аккаунта — правило", () => {
  const pick = (all: Record<string, Preset>, fable = false, warm: Record<string, number> = {}) => choose(book(all), fable, warm, T0);

  // чьё: слово пользователя 11 нояб. — ближний сброс первым
  it("два годных аккаунта с равным остатком, сброс недели через 21 ч и через 3 дня — берётся аккаунт со сбросом через 21 ч", () => {
    expect(pick({ [A]: { week: 0.4, hours: 72 }, [B]: { week: 0.4, hours: 21 } }).account).toBe(B);
  });

  // чьё: слово пользователя 15 нояб. — «выбирать самый подходящий аккаунт»
  it("у ближнего по сбросу осталось 3 % на 2 часа, у другого 60 % на 30 часов — берётся второй: счёт 2 % в час против 1,5", () => {
    const r = pick({ [A]: { week: 0.97, hours: 2 }, [B]: { week: 0.4, hours: 30 } });
    expect(r.account).toBe(B);
    expect(r.candidates.map((c) => [c.account, Math.round(c.score * 1000) / 10])).toEqual([[A, 1.5], [B, 2]]);
  });

  // чьё: слово пользователя 15 нояб. — «максимальная параллельность»
  it("счёт трёх аккаунтов 4 · 2 · 1, разом открыто семь сессий — они расходятся 4 · 2 · 1", () => {
    const all = { [A]: { week: 0.2, hours: 20 }, [B]: { week: 0.6, hours: 20 }, [C]: { week: 0.8, hours: 20 } };
    const warm: Record<string, number> = {};
    for (let i = 0; i < 7; i++) {
      const to = pick(all, false, warm).account!;
      warm[to] = (warm[to] ?? 0) + 1;
    }
    expect(warm).toEqual({ [A]: 4, [B]: 2, [C]: 1 });
  });

  // чьё: слово пользователя 15 нояб. — флаг «беречь Fable»: «если нет — не сохранять»
  it("флаг снят, неделя 60 %, окно Fable 20 %, сессия Opus — аккаунт годен с остатком 40 %; с флагом он закрыт: вся свободная неделя — запас", () => {
    const off = pick({ [A]: { week: 0.6, fable: 0.2, keep: false } });
    expect(off.candidates).toMatchObject([{ account: A }]);
    expect(off.candidates[0]!.rem).toBeCloseTo(0.4);
    expect(fits(record({ week: 0.6, fable: 0.2, keep: true }), false, T0)).toBe(false);
  });

  // чьё: слово пользователя 11 нояб. — остальные модели без своей половины идут из запаса Fable
  it("сессии Opus негде идти без запаса, запас Fable есть у двух аккаунтов — берётся запас у аккаунта с большим счётом", () => {
    const r = pick({ [A]: { week: 0.6, fable: 0.2, hours: 50, keep: true }, [B]: { week: 0.7, fable: 0.1, hours: 10, keep: true } });
    expect(r).toMatchObject({ account: B, spare: true });
  });

  // чьё: факт — окно недели 168 часов и открывается первым вызовом; числа аккаунта машина знает только из его ответов
  it("неделя аккаунта не начата или машина не видела его ответа — счёт от полного остатка и 168 часов до сброса", () => {
    expect(pick({ [A]: {} }).candidates).toMatchObject([{ account: A, rem: 1, hours: 168 }]);
    expect(pick({ [A]: {} }, true).candidates).toMatchObject([{ account: A, rem: 0.5, hours: 168 }]);
  });

  // чьё: слово пользователя 11 нояб. — окно Fable выбрано: аккаунт не для Fable
  it("сессия Fable, у аккаунта окно Fable 100 % — он не берётся; другой модели его неделя открыта", () => {
    const all = { [A]: { week: 0.3, fable: 1, hours: 5 }, [B]: { week: 0.5, fable: 0.2, hours: 90 } };
    expect(pick(all, true).account).toBe(B);
    expect(pick(all, false).account).toBe(A);
  });
});

describe("привязка сессии", () => {
  // чьё: факт опыта — заглушка в окружении, токен подставляет прокси; кэш часовой
  it("сессия без своего входа: у процесса слово fleet, прокси ставит токен аккаунта только в Authorization", async () => {
    const api = await fleet({ [A]: { week: 0.2 } });
    const { s, q } = await st!.open("site", claude());
    const env = (q.options as any).env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fleet");
    expect(JSON.stringify(env)).not.toContain("tok-");
    expect((await call(s.rec.sessionId)).status).toBe(200);
    expect(api.hits).toMatchObject([{ account: A }]);
    expect(api.hits[0]!.headers.authorization).toBe(`Bearer tok-${A}`);
    expect(api.hits[0]!.headers["x-api-key"]).toBeUndefined();
    expect(readFileSync(join(st!.home, "store", "host-accounts.json"), "utf8")).not.toContain("tok-");
    expect(row().account).toBe(A);
  });

  // чьё: слово пользователя 15 нояб. — «менять только в случае лимитов, пока кэш горячий»
  it("аккаунт сессии годен, кэш тёплый, у другого сброс стал ближе — привязка та же; новая сессия идёт на другой", async () => {
    await fleet({ [A]: { week: 0.4, hours: 21 }, [B]: { week: 0.4, hours: 72 } });
    const { s } = await st!.open("site", claude(OPUS));
    expect(await routed(s.rec.sessionId)).toBe(A);
    mod().answer({ callsign: "other@laptop", to: "", protocol: "claude", account: B, token: "" }, { status: 200, headers: windows({ week: 0.4, hours: 2 }), path: "/v1/messages", ms: 1, hops: 0, waited: false });
    expect(await routed(s.rec.sessionId)).toBe(A);
    const { s: fresh } = await st!.open("fresh", claude(OPUS));
    expect(await routed(fresh.rec.sessionId)).toBe(B);
  });

  // чьё: слово пользователя 15 нояб. — «перезапуск холодного на любом»
  it("сессия молчала час, кэш остыл, у другого годного аккаунта сброс ближе — следующий вызов привязывает её к нему", async () => {
    await fleet({ [A]: { week: 0.4, hours: 21 }, [B]: { week: 0.4, hours: 72 } });
    const { s } = await st!.open("site", claude(OPUS));
    expect(await routed(s.rec.sessionId)).toBe(A);
    mod().answer({ callsign: "other@laptop", to: "", protocol: "claude", account: B, token: "" }, { status: 200, headers: windows({ week: 0.4, hours: 2 }), path: "/v1/messages", ms: 1, hops: 0, waited: false });
    st!.clock.advance(61 * 60_000);
    expect(await routed(s.rec.sessionId)).toBe(B);
    expect(row().account).toBe(B);
    expect(journal("account.moved")).toMatchObject([{ callsign: CS, account: B, from: A }]);
    expect(journal("account.moved")[0].why).toContain("кэш остыл");
  });

  // чьё: слово пользователя 15 нояб. — «сессия или агент стики»
  it("сессия запустила трёх субагентов — их вызовы идут на аккаунте сессии", async () => {
    const api = await fleet({ [A]: { week: 0.4, hours: 21 }, [B]: { week: 0.4, hours: 20 } });
    const { s } = await st!.open("site", claude());
    await Promise.all([call(s.rec.sessionId), call(s.rec.sessionId, HAIKU), call(s.rec.sessionId, OPUS), call(s.rec.sessionId)]);
    expect(new Set(api.hits.map((h) => h.account))).toEqual(new Set([B]));
  });

  // чьё: слово пользователя 11 нояб. — после подмены Host своё поднимается из хранилища
  it("машину подменили, сессия была привязана к годному аккаунту — привязка та же, из записи сессии", async () => {
    const all = { [A]: { week: 0.4, hours: 21 }, [B]: { week: 0.4, hours: 72 } };
    await fleet(all);
    const { s } = await st!.open("site", claude(OPUS));
    expect(await routed(s.rec.sessionId)).toBe(A);
    mod().answer({ callsign: "other@laptop", to: "", protocol: "claude", account: B, token: "" }, { status: 200, headers: windows({ week: 0.4, hours: 2 }), path: "/v1/messages", ms: 1, hops: 0, waited: false });
    const home = st!.home, sid = s.rec.sessionId;
    await st!.stop();
    await fleet(all, () => ({}), { home });
    await until(() => st!.kernel.sessions.get(CS)?.state === "idle", 5000, "site поднята новым Host");
    expect(await routed(sid)).toBe(A);
  });

  // чьё: слово пользователя 15 нояб. — «не хранить цепочку»
  it("аккаунт добавлен — следующая новая сессия считает выбор по новому набору; порядка аккаунтов в записи машины нет", async () => {
    const all: Record<string, Preset> = { [A]: { week: 0.5, hours: 90 } };
    const api = await fleet(all);
    const { s } = await st!.open("site", claude(OPUS));
    expect(await routed(s.rec.sessionId)).toBe(A);
    all[B] = {};
    api.names.list.push(B);
    st!.link.deliver({ type: "changed", what: "keys" });
    await until(async () => (await listed()).length === 2, 5000, "аккаунт B прочитан");
    await until(() => (JSON.parse(readFileSync(join(st!.home, "store", "host-accounts.json"), "utf8")).machine.accounts[B] ? true : false), 5000, "B в записи");
    const { s: fresh } = await st!.open("fresh", claude(OPUS));
    // свежая неделя B: 100 % на 168 часов против 50 % на 90 — счёт выше у B
    expect(await routed(fresh.rec.sessionId)).toBe(B);
    const stored = JSON.parse(readFileSync(join(st!.home, "store", "host-accounts.json"), "utf8")).machine;
    expect(Object.keys(stored)).toEqual(["accounts"]);
  });
});

describe("отказы Claude", () => {
  // чьё: слово пользователя 15 нояб. — «всё через прокси», «вся история и весь лог в ClickHouse»
  it("Claude отказал по окну недели посреди хода: окно закрыто до сброса, тот же запрос ушёл на следующий аккаунт, сессия отказа не увидела; в журнале три строки", async () => {
    const api = await fleet({ [A]: { week: 0.9, hours: 2 }, [B]: { week: 0.4, hours: 90 } }, (hit) => (hit.account === A ? rejected("7d") : { headers: windows({ week: 0.41, hours: 90 }) }));
    const { s } = await st!.open("site", claude());
    expect((await call(s.rec.sessionId)).status).toBe(200);
    expect(api.hits.map((h) => h.account)).toEqual([A, B]);
    expect((await listed()).find((a) => a.name === A)!.limits).toMatchObject([{ name: "seven_day", used: 1, resets: T0 + 2 * HOUR }]);
    expect(row().account).toBe(B);
    // отказанный вызов с видом и аккаунтом, решение со счётом кандидатов, ответивший вызов с числом переходов 1
    expect(journal("call")).toMatchObject([{ callsign: CS, account: A, status: 429, kind: "week", hops: 0 }, { callsign: CS, account: B, status: 200, hops: 1, req: "req_2" }]);
    expect(journal("call")[0].headers).toMatchObject({ [`${U}-representative-claim`]: "seven_day" });
    expect(journal("route").at(-1)).toMatchObject({ callsign: CS, account: B, candidates: [{ account: B }] });
    expect(journal("account.closed")).toMatchObject([{ account: A, kind: "week" }]);
  });

  // чьё: слово пользователя 15 нояб. — «с автопереносом можно добивать до 100 процентов»
  it("неделя аккаунта дошла до 100 % посреди хода — следующий вызов ушёл на следующий аккаунт, до 100 % сессия с аккаунта не уходила", async () => {
    let used = 0.99;
    const api = await fleet({ [A]: { week: 0.98, hours: 2 }, [B]: { week: 0.4, hours: 90 } }, (hit) => (hit.account === A ? { headers: windows({ week: used, hours: 2 }) } : {}));
    const { s } = await st!.open("site", claude(OPUS));
    await call(s.rec.sessionId, OPUS);
    used = 1;
    await call(s.rec.sessionId, OPUS);
    expect((await call(s.rec.sessionId, OPUS)).status).toBe(200);
    expect(api.hits.map((h) => h.account)).toEqual([A, A, B]);
  });

  // чьё: факт прода — 99 отказов, 22 оборванных хода
  it("Claude ответил «аккаунт полон» новой сессии — тот же вызов ушёл на следующий аккаунт, сессия привязана к нему, ход не оборван", async () => {
    const api = await fleet({ [A]: { week: 0.2, hours: 20 }, [B]: { week: 0.4, hours: 90 } }, (hit) => (hit.account === A ? { status: 429 } : {}));
    const { s } = await st!.open("site", claude());
    expect((await call(s.rec.sessionId)).status).toBe(200);
    expect(api.hits.map((h) => h.account)).toEqual([A, B]);
    expect(row().account).toBe(B);
    expect(journal("account.full")).toMatchObject([{ account: A, kind: "concurrents" }]);
    expect(journal("call")[0]).toMatchObject({ account: A, status: 429, kind: "concurrents" });
  });

  // чьё: слово пользователя 15 нояб. — «симлесс для клиента»
  it("Claude ответил «аккаунт полон» сессии с тёплым кэшем — этот вызов ушёл на следующий аккаунт, привязка прежняя", async () => {
    let busy = false;
    const api = await fleet({ [A]: { week: 0.2, hours: 20 }, [B]: { week: 0.4, hours: 90 } }, (hit) => (hit.account === A && busy ? { status: 429 } : {}));
    const { s } = await st!.open("site", claude());
    await call(s.rec.sessionId);
    // ответ записал разговор в часовой кэш аккаунта A
    await st!.turn(CS, [{ type: "assistant", uuid: "a1", parent_tool_use_id: null, message: { model: FABLE, content: [], usage: { input_tokens: 2, cache_creation_input_tokens: 9000, cache_creation: { ephemeral_1h_input_tokens: 9000 } } } }]);
    busy = true;
    expect((await call(s.rec.sessionId)).status).toBe(200);
    busy = false;
    await call(s.rec.sessionId);
    expect(api.hits.map((h) => h.account)).toEqual([A, A, B, A]);
    expect(row().account).toBe(A);
  });

  // чьё: слово пользователя 15 нояб. — «правильно балансить»
  it("аккаунт полон, открыта новая сессия — она привязана к следующему годному аккаунту, а не к полному", async () => {
    await fleet({ [A]: { week: 0.2, hours: 20 }, [B]: { week: 0.4, hours: 90 } });
    const { s } = await st!.open("site", claude());
    const flying = await mod().route(s.rec.sessionId);
    expect(flying.account).toBe(A);
    mod().answer(flying, { status: 429, headers: {}, path: "/v1/messages", ms: 1, hops: 0, waited: false });
    expect((await listed()).find((a) => a.name === A)!.full).toBe(true);
    const { s: fresh } = await st!.open("fresh", claude());
    expect(await routed(fresh.rec.sessionId)).toBe(B);
    // вызовов на аккаунте стало меньше, чем при отказе, — он снова в выборе
    mod().done(flying);
    expect((await listed()).find((a) => a.name === A)!.full).toBeUndefined();
  });

  // чьё: факт — заголовки отказа называют окно Fable
  it("отказ по окну Fable, на аккаунте идёт сессия Opus — сессия Fable ушла на другой аккаунт, сессия Opus осталась", async () => {
    const api = await fleet({ [A]: { week: 0.1, hours: 10 }, [B]: { week: 0.5, hours: 100 } }, (hit) => (hit.account === A && /fable/.test(hit.model) ? rejected("7d_oi", 10) : {}));
    const { s: opus } = await st!.open("opus", claude(OPUS));
    const { s: fable } = await st!.open("fable", claude());
    await call(opus.rec.sessionId, OPUS);
    expect((await call(fable.rec.sessionId)).status).toBe(200);
    await call(opus.rec.sessionId, OPUS);
    expect(api.hits.map((h) => [h.account, h.model])).toEqual([[A, OPUS], [A, FABLE], [B, FABLE], [A, OPUS]]);
    expect([row("opus@laptop").account, row("fable@laptop").account]).toEqual([A, B]);
    expect(journal("account.closed")).toMatchObject([{ account: A, kind: "fable" }]);
  });

  // чьё: слово пользователя 15 нояб. — «авторековериться»
  it("отказ без окна со сроком 20 секунд — через 20 секунд тот же вызов прошёл на том же аккаунте", async () => {
    const api = await fleet({ [A]: { week: 0.2, hours: 20 }, [B]: { week: 0.4, hours: 90 } }, (_hit, n) => (n === 1 ? { status: 429, headers: { "retry-after": "20" } } : {}));
    const { s } = await st!.open("site", claude());
    const answer = call(s.rec.sessionId);
    await until(() => api.hits.length === 1, 5000, "первый вызов дошёл до Claude");
    await tick(20);
    expect(api.hits).toHaveLength(1);
    st!.clock.advance(20_000);
    expect((await answer).status).toBe(200);
    expect(api.hits.map((h) => h.account)).toEqual([A, A]);
    expect(journal("call")).toMatchObject([{ status: 429, kind: "throttle" }, { status: 200 }]);
  });

  // чьё: факт документации — негодный токен; происшествие — обращение в «Инциденты»
  it("Claude ответил, что токен не годен — аккаунт выбыл из выбора с причиной, сессия перешла на следующий, происшествие", async () => {
    const api = await fleet({ [A]: { week: 0.2, hours: 20 }, [B]: { week: 0.4, hours: 90 } }, (hit) => (hit.account === A ? { status: 401 } : {}));
    const { s } = await st!.open("site", claude());
    expect((await call(s.rec.sessionId)).status).toBe(200);
    expect(api.hits.map((h) => h.account)).toEqual([A, B]);
    expect((await listed()).find((a) => a.name === A)).toMatchObject({ ok: false, why: "токен не принят" });
    expect(row().account).toBe(B);
    expect(journal("account.token")).toMatchObject([{ account: A, level: "error" }]);
    await until(() => raised.length === 1, 5000, "обращение об аккаунте");
    expect(raised[0]).toMatchObject({ kind: "account", key: A });
  });

  // чьё: код — сессия ждёт сброса и продолжает сама
  it("годных аккаунтов нет — сессия получает отказ лимита и ждёт сброса; в час сброса продолжает сама", async () => {
    await fleet({ [A]: { week: 0.9, hours: 2 } }, () => rejected("7d"));
    const { s, proc } = await st!.open("site", claude());
    const refused = await call(s.rec.sessionId);
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain("no_account");
    expect(row().wait).toBe(T0 + 2 * HOUR);
    // чьё: слово пользователя 16 нояб. — «показ ошибок вместо скрытия»: строка решения без аккаунта — уровня warn, о сессии и с причиной: она уходит в её ленту
    expect(journal("route").at(-1)).toMatchObject({ callsign: CS, level: "warn" });
    expect(journal("route").at(-1).why).toMatch(/^годных аккаунтов Claude нет: ближайший сброс в \d\d:\d\d$/);
    expect(journal("route").filter((l) => l.account).every((l) => l.level === "info")).toBe(true);
    st!.clock.advance(HOUR);
    await tick();
    expect(proc.inputs.some((i) => i.message.content === "Продолжай")).toBe(false);
    st!.clock.advance(HOUR);
    await until(() => proc.inputs.some((i) => i.message.content === "Продолжай"), 5000, "сессия продолжила в час сброса");
    expect(row().wait).toBeUndefined();
  });
});

describe("провайдеры и модели", () => {
  // чьё: слово пользователя 15 нояб. — «не создавать слот на каждую»
  it("выбрана модель провайдера: в документе провайдер и точная модель, вызов ушёл провайдеру с его ключом; побочный вызов с чужой моделью — на модель сессии", async () => {
    const api = await fleet({ [A]: {} });
    const { s, q } = await st!.open("site", { key: "orca", model: "qwen-3.5-coder" });
    expect(s.rec.spec).toMatchObject({ key: "orca", model: "qwen-3.5-coder" });
    // один способ запуска для любого провайдера; окно 256 К — имя с «[1m]» и точный предел
    const env = (q.options as any).env;
    expect([env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, env.CLAUDE_CODE_OAUTH_TOKEN, (q.options as any).model]).toEqual([undefined, "256000", "fleet", "qwen-3.5-coder[1m]"]);
    await call(s.rec.sessionId, "qwen-3.5-coder");
    await call(s.rec.sessionId, HAIKU);
    expect(api.hits.map((h) => [h.headers["x-api-key"], h.model])).toEqual([["sk-orca", "qwen-3.5-coder"], ["sk-orca", "qwen-3.5-coder"]]);
    expect(row().account).toBeUndefined();
    expect(journal("call")).toMatchObject([{ key: "orca", status: 200 }, { key: "orca", status: 200 }]);
  });

  // чьё: факт — случай 16 нояб.: 14 отказов провайдера в журнале машины без причины, человек видел только «Stop hook error»
  it("отказ провайдера несёт его текст: в строке вызова — статус и слова провайдера о сессии, сессия получает то же тело", async () => {
    const said = "Meta rejected the request: 'required' is required to be supplied and to be an array including every key in properties. Missing 'impossible'.";
    await fleet({ [A]: {} }, () => ({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: said } } }));
    const { s } = await st!.open("site", { key: "orca", model: "qwen-3.5-coder" });
    const r = await call(s.rec.sessionId, "qwen-3.5-coder");
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.message).toBe(said);
    expect(journal("call")).toMatchObject([{ callsign: CS, key: "orca", status: 400, level: "warn", why: `вызов модели отклонён (400): ${said}` }]);
  });

  // чьё: слово пользователя 15 нояб. — «не могу выбрать нужную»; значения «по умолчанию» нет
  it("модели нет в списке провайдера — отказ словом, документ не изменился; сессия без провайдера или модели не открывается", async () => {
    await fleet({ [A]: {} });
    const { s } = await st!.open("site", claude());
    expect(await st!.request("session.update", { to: CS, patch: { key: "orca", model: "qwen-9" } })).toMatchObject({ ok: false, error: "no_model" });
    expect(await st!.request("session.update", { to: CS, patch: { model: "fable" } })).toMatchObject({ ok: false, error: "no_model" });
    expect(s.rec.spec).toMatchObject(claude());
    expect(await st!.request("session.open", { to: "@laptop", spec: { name: "x", cwd: st!.dir } })).toMatchObject({ ok: false, error: "key_required" });
    expect(await st!.request("session.open", { to: "@laptop", spec: { name: "x", cwd: st!.dir, key: "claude" } })).toMatchObject({ ok: false, error: "model_required" });
    // в документе — имя каталога как есть; суффикс окна знает только имя для процесса
    expect(await st!.request("session.update", { to: CS, patch: { model: `${OPUS}[1m]` } })).toMatchObject({ ok: false, error: "no_model" });
    expect(await st!.request("session.update", { to: CS, patch: { model: OPUS } })).toMatchObject({ ok: true });
  });

  // чьё: слово пользователя 15 нояб. — «убрать любой десинк»
  it("ответ пришёл от другой модели — в строке сессии обе модели, строка журнала, происшествие; ответила названная — расхождения нет", async () => {
    await fleet({ [A]: {} });
    const { q } = await st!.open("site", claude(FABLE));
    expect((q.options as any).model).toBe(`${FABLE}[1m]`);
    const said = (model: string) => ({ type: "assistant", uuid: `u-${model}-${Math.random()}`, parent_tool_use_id: null, message: { model, content: [{ type: "text", text: "ок" }] } });
    await st!.turn(CS, [said(FABLE)]);
    expect(row().answers).toBeUndefined();
    await st!.turn(CS, [said("claude-opus-5-5")]);
    expect(row()).toMatchObject({ spec: { model: FABLE }, answers: "claude-opus-5-5" });
    expect(journal("model_drift")).toMatchObject([{ callsign: CS, level: "error" }]);
    await until(() => raised.length === 1, 5000, "обращение о модели");
    expect(raised[0]).toMatchObject({ kind: "model", key: CS });
    // ответ субагента в сверку не идёт; названная модель снимает расхождение
    await st!.turn(CS, [{ ...said(HAIKU), parent_tool_use_id: "toolu_1" }, said(FABLE)]);
    expect(row().answers).toBeUndefined();
    expect(raised).toHaveLength(1);
  });

  // чьё: слово пользователя 15 нояб. — «/model должно правильно отрабатываться»
  it("сообщение «/model opus 4.8» из другой сессии — модель в документе, в разговор команда не ушла, отправителю — модель", async () => {
    await fleet({ [A]: {} }, () => ({}), { extra: [chat()] });
    const { s, proc, q } = await st!.open("site", claude());
    const r = await st!.request("message", { to: CS, text: "/model opus 4.8" }, "lead@laptop");
    expect(r).toMatchObject({ ok: true, result: { model: OPUS } });
    expect(s.rec.spec).toMatchObject({ key: "claude", model: OPUS });
    expect(proc.inputs).toHaveLength(0);
    expect(q.calls.filter((c) => c.name === "setModel").map((c) => c.args[0])).toEqual([`${OPUS}[1m]`]);
  });

  // чьё: слово пользователя 15 нояб. — «выбранная не точно работает»
  it("сообщение «/model opus» — подходят две модели: модель не меняется, отправителю — список подходящих", async () => {
    await fleet({ [A]: {} }, () => ({}), { extra: [chat()] });
    const { s, proc } = await st!.open("site", claude());
    const r = await st!.request("message", { to: CS, text: "/model opus" }, "lead@laptop");
    expect(r).toMatchObject({ ok: false, error: "many_models" });
    expect(r.why).toContain(`claude/${OPUS}`);
    expect(r.why).toContain("claude/claude-opus-5-5");
    expect(await st!.request("message", { to: CS, text: "/model gpt" }, "lead@laptop")).toMatchObject({ ok: false, error: "no_model" });
    expect(s.rec.spec).toMatchObject(claude());
    expect(proc.inputs).toHaveLength(0);
  });
});

describe("проба окон аккаунта", () => {
  /** Разовый claude стенда: делает через прокси тот же вызов, что сделал бы настоящий. */
  const liveCli = () => {
    st!.sdk.cli = async (args, env) => {
      st!.sdk.cliCalls.push({ args, env });
      const sid = args[args.indexOf("--session-id") + 1]!, model = args[args.indexOf("--model") + 1]!;
      const r = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`, "x-claude-code-session-id": sid }, body: JSON.stringify({ model, messages: [{ role: "user", content: "ok" }] }) });
      return { code: r.ok ? 0 : 1, out: await r.text() };
    };
  };

  // чьё: слово пользователя 15 нояб. — «после добавления нет механизма, который показывает и опрашивает API по лимитам»
  it("аккаунт без единого вызова, спросили аккаунты машины — проба этим аккаунтом: в ответе его неделя и окно Fable; свежие числа второй раз не спрашиваются", async () => {
    const api = await fleet({ [A]: {} }, () => ({ headers: windows({ week: 0.37, fable: 0.42, hours: 40 }) }));
    liveCli();
    expect((await listed())[0]!.limits.map((l) => [l.name, l.used])).toEqual([["seven_day", 0.37], ["seven_day_overage_included", 0.42]]);
    expect(api.hits).toMatchObject([{ account: A, model: FABLE }]);
    // у разового claude — слово-заглушка: токен ставит прокси
    const run = st!.sdk.cliCalls.at(-1)!;
    expect(run.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fleet");
    expect(JSON.stringify(run.args)).not.toContain("tok-");
    expect(journal("call")).toMatchObject([{ probe: true, account: A, status: 200 }]);
    await listed();
    expect(api.hits).toHaveLength(1);
    // чьё: код — порог свежести две минуты
    st!.clock.advance(121_000);
    await listed();
    expect(api.hits).toHaveLength(2);
  });

  // чьё: слово пользователя 15 нояб. — «не флудить серверы Anthropic шумом»: числа аккаунта — общие для флота, проба — одна на флот
  it("флот знает свежие числа аккаунта — на нём идёт сессия другой машины: пробы нет, в ответе числа флота", async () => {
    const api = await fleet({ [A]: {} }, () => ({ headers: windows({ week: 0.9, hours: 40 }) }));
    liveCli();
    api.names.limits[A] = [{ name: "seven_day", used: 0.55, resets: T0 + 40 * HOUR, at: T0 - 30_000 }];
    expect((await listed())[0]!.limits.map((l) => [l.name, l.used])).toEqual([["seven_day", 0.55]]);
    expect(api.hits).toHaveLength(0);
    // числа флота устарели — проба этой машиной, одна
    st!.clock.advance(121_000);
    await listed();
    expect(api.hits).toHaveLength(1);
  });

  it("ответ Claude назвал окна — машина сообщает их флоту; те же числа раньше порога свежести второй раз не сообщаются, изменившиеся — сразу", async () => {
    let week = 0.41;
    await fleet({ [A]: {} }, () => ({ headers: windows({ week, hours: 40 }) }));
    const { s } = await st!.open("site", claude(OPUS));
    await call(s.rec.sessionId, OPUS);
    const sent = () => st!.services.of("keys.limits");
    await until(() => sent().length === 1, 5000, "окна сообщены флоту");
    expect(sent()[0]).toMatchObject({ name: A, limits: [{ name: "seven_day", used: 0.41, resets: T0 + 40 * HOUR, at: T0 }] });
    await call(s.rec.sessionId, OPUS);
    await tick(20);
    expect(sent()).toHaveLength(1);
    week = 0.42;
    await call(s.rec.sessionId, OPUS);
    await until(() => sent().length === 2, 5000, "изменившиеся окна сообщены");
    expect((sent()[1] as any).limits[0].used).toBe(0.42);
  });

  // чьё: факт прода 15 нояб. — выбранный аккаунт девять машин пробовали каждые две минуты, все пробы — отказ
  it("неделя аккаунта закрыта до сброса — пробы нет; сброс прошёл — проба", async () => {
    const api = await fleet({ [A]: { week: 1, hours: 2 } }, () => ({ headers: windows({ week: 0.01, hours: 168 }) }));
    liveCli();
    await listed();
    expect(api.hits).toHaveLength(0);
    st!.clock.advance(2 * HOUR + 1000);
    expect((await listed())[0]!.limits.map((l) => [l.name, l.used])).toEqual([["seven_day", 0.01]]);
    expect(api.hits).toHaveLength(1);
  });

  // чьё: слово пользователя 16 нояб. — «нужна кнопка рефреша лимитов: я использовал ресет лимитов, а панель его не схватила»
  it("неделя закрыта, человек сбросил лимиты у Claude — вопрос «заново» пробует и закрытый аккаунт: окно открыто, числа ушли флоту, сессия с оборванным ходом продолжает", async () => {
    const api = await fleet({ [A]: { week: 1, hours: 40 } }, () => ({ headers: windows({ week: 0.02, hours: 168 }) }));
    liveCli();
    const { s, proc } = await st!.open("site", claude(OPUS));
    // годных аккаунтов нет — ход оборван, сессия ждёт сброса
    expect((await call(s.rec.sessionId, OPUS)).status).toBe(429);
    await listed();
    expect(api.hits).toHaveLength(0);
    const fresh = ((await st!.request("account.list", { to: "@laptop", fresh: true })).result as any).accounts as Array<{ limits: Array<{ name: string; used: number }> }>;
    expect(api.hits).toMatchObject([{ account: A }]);
    expect(fresh[0]!.limits.map((l) => [l.name, l.used])).toEqual([["seven_day", 0.02]]);
    expect(st!.services.of("keys.limits").at(-1)).toMatchObject({ name: A, limits: [{ name: "seven_day", used: 0.02 }] });
    await until(() => proc.inputs.some((i) => i.message.content === "Продолжай"), 5000, "сессия продолжила после сброса");
  });

  // чьё: слово пользователя 16 нояб. — «надо сделать периодический перезапрос лимитов»
  it("неделя закрыта, человек сбросил лимиты, никто ничего не спрашивал — за срок обхода машина пробует закрытый аккаунт сама: окно открыто, сессия продолжает", async () => {
    const api = await fleet({ [A]: { week: 1, hours: 40 } }, () => ({ headers: windows({ week: 0.02, hours: 168 }) }));
    liveCli();
    const { s, proc } = await st!.open("site", claude(OPUS));
    expect((await call(s.rec.sessionId, OPUS)).status).toBe(429);
    expect(api.hits).toHaveLength(0);
    // чьё: решение агента — срок обхода десять минут; первый обход машины — внутри срока
    st!.clock.advance(600_000);
    await until(() => api.hits.length === 1, 5000, "обход попробовал закрытый аккаунт");
    await until(() => proc.inputs.some((i) => i.message.content === "Продолжай"), 5000, "сессия продолжила после сброса");
    expect(row().wait).toBeUndefined();
  });

  // чьё: слово пользователя 15 нояб. — «не флудить серверы Anthropic шумом»: аккаунт за срок пробует одна машина флота
  it("обход: флот слышал об аккаунте недавно — другая машина его уже спросила — пробы нет", async () => {
    const api = await fleet({ [A]: { week: 0.4, hours: 40 } }, () => ({ headers: windows({ week: 0.5, hours: 40 }) }));
    liveCli();
    api.names.limits[A] = [{ name: "seven_day", used: 0.45, resets: T0 + 40 * HOUR, at: T0 + 550_000 }];
    st!.clock.advance(600_000);
    await tick(50);
    expect(api.hits).toHaveLength(0);
    // прошёл ещё срок, флот молчал — проба этой машиной, одна
    st!.clock.advance(600_000);
    await until(() => api.hits.length === 1, 5000, "обход попробовал притихший аккаунт");
  });

  it("вопрос «заново», а окно так и закрыто — проба получает тот же отказ: аккаунт закрыт до того же часа, второй строки о закрытии в журнале нет", async () => {
    const api = await fleet({ [A]: { week: 1, hours: 40 } }, () => rejected("7d", 40));
    liveCli();
    const before = journal("account.closed").length;
    const fresh = ((await st!.request("account.list", { to: "@laptop", fresh: true })).result as any).accounts as Array<{ limits: Array<{ name: string; used: number; resets?: number }> }>;
    expect(api.hits).toHaveLength(1);
    expect(fresh[0]!.limits).toMatchObject([{ name: "seven_day", used: 1, resets: T0 + 40 * HOUR }]);
    expect(journal("account.closed")).toHaveLength(before);
  });
});
