// Эталоны машины дизайна «ChatGPT в сессиях флота» (docs/designs/v2-codex): путь вызова в бэкенд подписки, срок значения ключа, умерший вход.
// Бэкенд на стенде — локальный сервер: помнит каждый вызов. Источник свойства — над каждым эталоном; номер — номер эталона дизайна.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Refusal } from "@sb/protocol";
import { make as accounts } from "../src/modules/accounts/accounts.ts";
import { make as proxy } from "../src/modules/proxy/proxy.ts";
import { signal, stand, until, type Stand } from "../stand/index.ts";

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

const KEY = "gpt", MODEL = "gpt-6.2-astra";
const DAY = 86_400_000;
type Hit = { path: string; headers: IncomingHttpHeaders; body: any };
/** События машины правилам входа: запросы ticket.new службам. */
const raised: Array<{ project: string; on: string; key: string; text: string }> = [];

/** Флот на стенде: аккаунт ChatGPT ключом флота; бэкенд подписки — локальный сервер, отвечает 503. value — что служба ключей отвечает на keys.value. */
async function fleet(value: (base: string) => Record<string, unknown>) {
  raised.length = 0;
  const hits: Hit[] = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hits.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
      signal();
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "upstream is down" } }));
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  // адрес бэкенда подписки — с путём и без версии API, как у настоящего
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/backend-api/codex`;
  st = await stand({ modules: [accounts(), proxy()], start: false });
  st.services.handlers["people.list"] = () => ({ people: [], projects: [{ id: "site", name: "Сайт", members: [] }] });
  st.services.handlers["ticket.new"] = (f: any) => (raised.push(f), { id: "site-1" });
  st.services.handlers["keys.list"] = () => ({ keys: [{ name: KEY, protocol: "chatgpt", at: 1, tail: "tail", base }] });
  st.services.handlers["keys.value"] = () => value(base);
  st.services.handlers["keys.models"] = () => ({ models: [{ id: MODEL, window: 272_000, protocol: "chatgpt" }] });
  st.services.handlers["prefs.get"] = () => ({ values: { "proxy.rules": [] } });
  await st.kernel.start();
  const { s } = await st.open("site", { key: KEY, model: MODEL, project: "site" });
  return { hits, sid: s.rec.sessionId as string };
}
const journal = (msg: string) => st!.journal().filter((l) => l.msg === msg) as any[];
const taken = () => st!.services.of("keys.value").length;
/** Вызов модели от процесса сессии через прокси машины. */
const call = (sid: string) => {
  const base = (st!.sdk.queries.at(-1)!.options as any).env.ANTHROPIC_BASE_URL as string;
  return fetch(`${base}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fleet", "x-claude-code-session-id": sid },
    body: JSON.stringify({ model: MODEL, max_tokens: 100, messages: [{ role: "user", content: "привет" }], metadata: { user_id: JSON.stringify({ session_id: sid }) } }),
  });
};

describe("аккаунт ChatGPT: путь вызова", () => {
  // эталон 5 — чьё: факт опыта 18 нояб. — бэкенд подписки читает кэш только с заголовком session_id (0 → 8192 токенов из 8413)
  it("5 · вызов уходит на {база}/responses без /v1, с токеном доступа и заголовком session_id, равным ключу кэша тела", async () => {
    const api = await fleet((base) => ({ value: "at-1", protocol: "chatgpt", base, until: st!.clock.now() + 9 * DAY }));
    const r = await call(api.sid);
    // отказ бэкенда доходит словами
    expect(r.status).toBe(529);
    expect(((await r.json()) as any).error.message).toContain("upstream is down");
    const hit = api.hits[0]!;
    expect([hit.path, hit.headers.authorization, hit.body.model]).toEqual(["/backend-api/codex/responses", "Bearer at-1", MODEL]);
    expect(hit.body.prompt_cache_key).toBe(`ccp:${api.sid}`);
    expect(hit.headers.session_id).toBe(hit.body.prompt_cache_key);
    expect([hit.body.store, hit.body.stream]).toEqual([false, true]);
    // строка вызова — с именем ключа: по ней вызов виден в истории флота
    expect(journal("call").at(-1)).toMatchObject({ callsign: "site@laptop", key: KEY, model: MODEL, status: 529 });
  });
});

describe("аккаунт ChatGPT: срок значения ключа", () => {
  // эталон 6 — чьё: факт опыта 18 нояб. — токен доступа живёт 10 дней; код — один запрос на всех, кто ждёт, как у списка аккаунтов
  it("6 · до until ключ у служб не спрашивается; после — один запрос на все вызовы, что идут разом, и вызовы идут с новым токеном; строка key называет until", async () => {
    let n = 0;
    const api = await fleet((base) => ({ value: `at-${++n}`, protocol: "chatgpt", base, until: st!.clock.now() + 9 * DAY }));
    const until1 = st!.clock.now() + 9 * DAY;
    await call(api.sid);
    await call(api.sid);
    expect([taken(), api.hits.map((h) => h.headers.authorization)]).toEqual([1, ["Bearer at-1", "Bearer at-1"]]);
    st!.clock.advance(9 * DAY);
    await Promise.all([call(api.sid), call(api.sid), call(api.sid)]);
    expect(taken()).toBe(2);
    expect(api.hits.slice(2).map((h) => h.headers.authorization)).toEqual(["Bearer at-2", "Bearer at-2", "Bearer at-2"]);
    expect(journal("key")).toMatchObject([{ key: KEY, until: until1 }, { key: KEY, until: until1 + 9 * DAY }]);
  });
});

describe("аккаунт ChatGPT: вход умер", () => {
  /** Служба ключей: до конца срока — токен, потом — отказ обновления словами OpenAI, пока вход не записан заново. */
  async function dying() {
    const state = { dead: true, token: "at-1" };
    const api = await fleet((base) => {
      if (st!.clock.now() > T_OPEN && state.dead) throw new Refusal("bad_token", `вход ChatGPT ${KEY}: refresh_token_expired: Your refresh token has expired`);
      return { value: state.token, protocol: "chatgpt", base, until: st!.clock.now() + 9 * DAY };
    });
    return { ...api, state };
  }
  const T_OPEN = Date.UTC(2026, 9, 30, 14, 0, 0);

  // эталон 8 — чьё: факт опыта 18 нояб. — на 401 claude делает 2 вызова за 3 с, на 529 — 11 за 185 с; код — негодный аккаунт Claude выбывает после первого отказа
  it("8 · отказ bad_token — сессии 401 со словами отказа, а не «перегружено»; строка account.token и событие правилу «account» — одни; второй вызов — тот же 401 без запроса к службам", async () => {
    const api = await dying();
    st!.clock.advance(9 * DAY);
    const before = taken();
    const r1 = await call(api.sid);
    expect(r1.status).toBe(401);
    expect((await r1.json()) as any).toMatchObject({ type: "error", error: { type: "authentication_error", message: expect.stringMatching(/bad_token: вход ChatGPT gpt: refresh_token_expired.*войдите в аккаунт заново/) } });
    const r2 = await call(api.sid);
    expect(r2.status).toBe(401);
    await until(() => raised.length, "событие правилу «account»");
    // служб спросили один раз; бэкенду не ушло ничего
    expect([taken() - before, api.hits.length]).toEqual([1, 0]);
    expect(journal("account.token")).toMatchObject([{ level: "error", account: KEY, word: "bad_token" }]);
    expect(raised).toMatchObject([{ project: "site", on: "account", key: KEY, text: expect.stringContaining("refresh_token_expired") }]);
  });

  // эталон 9 — чьё: код — «ключи изменились» сбрасывает значения ключей в памяти машины
  it("9 · новый вход: после «ключи изменились» следующий вызов берёт ключ заново и идёт с новым токеном", async () => {
    const api = await dying();
    st!.clock.advance(9 * DAY);
    expect((await call(api.sid)).status).toBe(401);
    // человек вошёл заново: служба ключей рассылает машинам «ключи изменились»
    Object.assign(api.state, { dead: false, token: "at-2" });
    // вызов сам ждёт перечитанных аккаунтов
    st!.link.deliver({ type: "changed", what: "keys" });
    expect((await call(api.sid)).status).toBe(529);
    expect(api.hits.map((h) => h.headers.authorization)).toEqual(["Bearer at-2"]);
    expect(raised).toHaveLength(1);
  });
});
