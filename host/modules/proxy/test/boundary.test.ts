// Леса прокси модели: настоящее ядро Host на поддельных SDK и relay, настоящий прокси на 127.0.0.1, поддельные провайдеры на localhost.
// Ключ флота — настоящий модуль logins (эталон 21); слот-аккаунт — подделка route с адресом поддельного Anthropic (эталон 22).
// Номер эталона — номер теста; без номера — чьё: код.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refuse, stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import logins from "../../logins/module.json" with { type: "json" };
import { make as makeLogins } from "../../logins/contract.ts";
import manifest from "../module.json" with { type: "json" };
import { make } from "../contract.ts";

const { module, standHost, until } = stand;
type Got = { path: string; headers: IncomingMessage["headers"]; body: any };

/** Поддельный провайдер Messages API: пишет запросы, отвечает потоком; cut — оборвать поток после первых слов. */
function provider() {
  const got: Got[] = [];
  const o = { cut: false };
  const server: Server = createServer((q, r) => {
    let b = "";
    q.on("data", (d) => (b += d));
    q.on("end", () => {
      got.push({ path: q.url ?? "", headers: q.headers, body: b ? JSON.parse(b) : null });
      if (!q.url?.startsWith("/v1/messages")) return r.writeHead(404).end();
      r.writeHead(200, { "content-type": "text/event-stream", "x-provider": "stub" });
      r.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", content: [] } })}\n\n`);
      if (o.cut) return void setTimeout(() => r.destroy(), 50);
      r.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    });
  });
  return { got, o, server, url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

let st: stand.Stand | null = null;
let home = "";
let up: ReturnType<typeof provider>;
/** Правила флота у prefs; null — prefs молчит. */
let rules: unknown[] | null = [];
let prefsAsked = 0;
const saved = { ...process.env };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "sb-proxy-"));
  process.env.SWITCHBOARD_HOME = home;
  rules = [];
  prefsAsked = 0;
  up = provider();
  await new Promise<void>((r) => up.server.listen(0, "127.0.0.1", r));
});
afterEach(async () => {
  await st?.close();
  st = null;
  await new Promise((r) => up.server.close(r));
  process.env = { ...saved };
});

/** Ответы Worker'ов стенда: prefs.get и fleetkeys.key. */
function services(s: stand.Stand, keys: Record<string, unknown> = {}) {
  const answer = (f: Frame) => {
    let reply: Record<string, unknown> | null = null;
    if (f.type === "prefs.get") {
      prefsAsked++;
      reply = rules ? { ok: true, result: { values: rules.length ? { "proxy.rules": rules } : {} } } : { ok: false, error: "offline" };
    }
    if (f.type === "fleetkeys.key") reply = keys[String(f.name)] ? { ok: true, result: keys[String(f.name)] } : { ok: false, error: "no_key" };
    if (reply) queueMicrotask(() => s.relay.deliver({ type: "reply", id: f.id as string, from: "stand", ...reply } as Frame));
  };
  const recv = s.relay.receive.bind(s.relay);
  s.relay.receive = (ws, text) => {
    recv(ws, text);
    if (text !== "ping") answer(JSON.parse(text) as Frame);
  };
}

/** Прокси и подделка route: сессия site — слот-аккаунт с поддельным Anthropic; прочие id — чужие. */
async function bench() {
  const route = module("host-logins", {
    requests: {
      route: (req) => {
        if (req.sid !== "sid-site") throw refuse("unknown_session", `сессии ${String(req.sid)} нет`);
        return { to: up.url() };
      },
    },
  });
  st = await standHost({ home, sessions: [{ callsign: "site@laptop" }], start: false, modules: [route, { manifest: manifest as Manifest, module: make() }] });
  services(st);
  await st.start();
  return st;
}

/** Адрес прокси — тот, с которым сессия пошла бы в claude. */
const proxyUrl = (cs = "site@laptop") => (st!.query(cs).options as { env: Record<string, string> }).env.ANTHROPIC_BASE_URL;
const call = (sid: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${proxyUrl()}/v1/messages?beta=true`, { method: "POST", headers: { "content-type": "application/json", "x-claude-code-session-id": sid, ...headers }, body: JSON.stringify(body) });
const BODY = { model: "claude-opus-5-5", stream: true, system: [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.\n\nRest." }], messages: [{ role: "user", content: "привет" }] };

describe("прокси модели", () => {
  it("20 · незнакомый id сессии — 403 unknown_session, к провайдеру не ушло", async () => {
    await bench();
    await until(() => st!.query("site@laptop"));
    const r = await call("stranger", BODY);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/^unknown_session/);
    expect(up.got).toEqual([]);
  });

  it("22 · слот-аккаунт: Authorization входа claude дошёл без изменений, ключа нет; ответ провайдера — claude как есть", async () => {
    await bench();
    await until(() => st!.query("site@laptop"));
    const r = await call("sid-site", BODY, { authorization: "Bearer sk-ant-oat01-login" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-provider")).toBe("stub");
    expect(await r.text()).toContain("message_stop");
    expect(up.got[0].headers.authorization).toBe("Bearer sk-ant-oat01-login");
    expect(up.got[0].headers["x-api-key"]).toBeUndefined();
    expect(up.got[0].headers["x-claude-code-session-id"]).toBe("sid-site");
    expect(up.got[0].path).toBe("/v1/messages?beta=true");
  });

  it("18 · правило абзаца флота: провайдер видит замену; правило сменили — prefs.changed, следующий вызов с новым", async () => {
    rules = [{ name: "Имя агента", scopes: ["system"], kind: "literal", unit: "paragraph", action: "replace", pattern: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", replacement: "You are a coding agent of the ops fleet." }];
    await bench();
    await until(() => st!.query("site@laptop"));
    await call("sid-site", BODY);
    expect(up.got[0].body.system[0].text).toBe("You are a coding agent of the ops fleet.\n\nRest.");
    expect(up.got[0].body.messages).toEqual(BODY.messages);
    rules = [{ ...(rules[0] as object), replacement: "Второе имя." }];
    st!.relay.deliver({ type: "prefs.changed", v: 1, to: "@laptop", from: ".prefs", name: "proxy.rules" } as Frame);
    await until(() => prefsAsked === 2);
    await new Promise((r) => setTimeout(r, 20));
    await call("sid-site", BODY);
    expect(up.got[1].body.system[0].text).toBe("Второе имя.\n\nRest.");
  });

  it("без правил тело уходит байт в байт; prefs молчит — 529 rules_unavailable, к провайдеру не ушло", async () => {
    rules = null;
    await bench();
    await until(() => st!.query("site@laptop"));
    const r = await call("sid-site", BODY);
    expect(r.status).toBe(529);
    expect(JSON.stringify(await r.json())).toContain("rules_unavailable");
    expect(up.got).toEqual([]);
    rules = [];
    const raw = `{"model":"claude-opus-5-5",  "stream":true,"messages":[{"role":"user","content":"\\u043f"}]}`;
    await fetch(`${proxyUrl()}/v1/messages`, { method: "POST", headers: { "x-claude-code-session-id": "sid-site" }, body: raw });
    expect(up.got[0].body).toEqual(JSON.parse(raw));
  });

  it("16 · провайдер оборвал поток — обрыв доходит до claude, своих повторов нет", async () => {
    await bench();
    await until(() => st!.query("site@laptop"));
    up.o.cut = true;
    const r = await call("sid-site", BODY);
    await expect(r.text()).rejects.toThrow();
    expect(up.got.length).toBe(1);
  });

  it("порт тот же после перезапуска Host: сессии у держателей идут на прежний адрес", async () => {
    await bench();
    await until(() => st!.query("site@laptop"));
    const first = proxyUrl();
    await st!.close();
    st = null;
    await bench();
    await until(() => st!.query("site@laptop"));
    expect(proxyUrl()).toBe(first);
  });
});

describe("ключ флота через прокси", () => {
  const SECRET = "sk-orca-SECRET";
  async function keyBench() {
    mkdirSync(join(home, "store"), { recursive: true });
    writeFileSync(join(home, "store", "host-logins.json"), JSON.stringify({ machine: { accounts: {}, slots: {} }, sessions: {} }));
    st = await standHost({ home, start: false, modules: [{ manifest: logins as Manifest, module: makeLogins() }, { manifest: manifest as Manifest, module: make() }] });
    services(st, { orca: { env: { ANTHROPIC_BASE_URL: up.url(), ANTHROPIC_DEFAULT_OPUS_MODEL: "orca/auto" }, settings: {}, key: SECRET } });
    await st.start();
    await st.kernel.open({ callsign: "job@laptop", cwd: join(home, "work", "job"), mkdir: true, opening: { slot: "orca" } });
    return st.session("host-proxy", "job@laptop")!.info.session_id;
  }
  /** Все файлы папки данных: ключа в них нет. */
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

  it("21 · сессия на ключе: слово fleet у claude, провайдер получил ключ от logins; файла ключа и apiKeyHelper на машине нет", async () => {
    const sid = await keyBench();
    const o = st!.query("job@laptop").options as { env: Record<string, string>; settings?: Record<string, unknown> };
    expect(o.env.ANTHROPIC_API_KEY).toBe("fleet");
    expect(o.env.ANTHROPIC_BASE_URL).toBe(proxyUrl("job@laptop"));
    expect(o.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("orca/auto");
    expect(o.settings?.apiKeyHelper).toBeUndefined();
    const r = await fetch(`${proxyUrl("job@laptop")}/v1/messages`, { method: "POST", headers: { "x-api-key": "fleet", "x-claude-code-session-id": sid }, body: JSON.stringify(BODY) });
    expect(r.status).toBe(200);
    expect(up.got[0].headers["x-api-key"]).toBe(SECRET);
    expect(up.got[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(files(home).filter((f) => readFileSync(f, "utf8").includes(SECRET))).toEqual([]);
    expect(JSON.stringify(o)).not.toContain(SECRET);
  });

  it("проверка ключа: разовый claude идёт через прокси со словом fleet и своим id; значения ключа нет в аргументах и окружении", async () => {
    await keyBench();
    let seen: { args: string[]; env: Record<string, string | undefined> } | null = null;
    st!.sdk.cli = async (args, env) => {
      seen = { args, env };
      const sid = args[args.indexOf("--session-id") + 1];
      const r = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", headers: { "x-api-key": String(env.ANTHROPIC_API_KEY), "x-claude-code-session-id": sid }, body: JSON.stringify(BODY) });
      return { code: r.ok ? 0 : 1, out: JSON.stringify({ type: "result", is_error: !r.ok, result: "ok", duration_ms: 12, modelUsage: { "orca/auto": {} } }) };
    };
    const r = await st!.relay.request({ v: 1, machine: "laptop", type: "machine.key_check", name: "orca" } as Frame);
    expect(r).toMatchObject({ ok: true, result: { ok: true, word: "ключ принят, отвечает orca/auto, 12 мс" } });
    expect(up.got.at(-1)!.headers["x-api-key"]).toBe(SECRET);
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(await st!.relay.request({ v: 1, machine: "laptop", type: "machine.key_check", name: "none" } as Frame)).toMatchObject({ ok: false, error: "no_key" });
  });
});
