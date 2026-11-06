// Леса ключа флота на машине: настоящее ядро Host на поддельных SDK и relay, модуль ключей флота — участник рации. Папки — настоящие, во временной папке.
// Что claude действительно читает команду токена и окно 200K — в live.test.ts. Номер эталона — номер теста.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../contract.ts";

const { FakeHolders, module, standHost, until } = stand;
type Stand = stand.Stand;
type Key = { env: Record<string, string>; settings: Record<string, unknown>; key: string };

const ORCA: Key = { env: { ANTHROPIC_BASE_URL: "https://api.orcarouter.ai", ANTHROPIC_DEFAULT_OPUS_MODEL: "orcarouter/auto" }, settings: { modelOverrides: { a: "b" } }, key: "sk-orca-SECRET" };

let st: Stand | null = null;
let home = "";
/** Ключи во флоте; down — слово отказа вместо ответа; held — ответ придержан. */
let fleet: { keys: Record<string, Key>; down: string | null };
let asked: string[] = [];
/** Состояние сессии job в момент каждого запроса ключа. */
let during: Array<string | undefined> = [];
const saved = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sb-keys-"));
  process.env.SWITCHBOARD_HOME = home;
  fleet = { keys: { orca: ORCA }, down: null };
  asked = [];
  during = [];
});
afterEach(async () => {
  await st?.close();
  st = null;
  process.env = { ...saved };
});

const keyDir = (name: string) => join(home, "fleetkeys", name);
const token = (name: string) => readFileSync(join(keyDir(name), "token"), "utf8");
const config = (name: string) => JSON.parse(readFileSync(join(keyDir(name), "key.json"), "utf8"));

/** Папка ключа на диске, как её оставила прошлая жизнь системы. */
function folder(name: string, k: Key) {
  mkdirSync(keyDir(name), { recursive: true });
  writeFileSync(join(keyDir(name), "token"), k.key);
  writeFileSync(join(keyDir(name), "key.json"), JSON.stringify({ env: k.env, settings: k.settings }));
}

function services(s: Stand) {
  const answer = (f: Frame) => {
    asked.push(String(f.name));
    during.push(s.session("probe", "job@laptop")?.state);
    const k = fleet.keys[String(f.name)];
    const reply = fleet.down ? { ok: false, error: fleet.down } : k ? { ok: true, result: k } : { ok: false, error: "no_key" };
    queueMicrotask(() => s.relay.deliver({ type: "reply", id: f.id as string, from: "fleetkeys", ...reply } as Frame));
  };
  for (const f of s.relay.frames("fleetkeys.key")) answer(f as Frame);
  const recv = s.relay.receive.bind(s.relay);
  s.relay.receive = (ws, text) => {
    recv(ws, text);
    if (text === "ping") return;
    const f = JSON.parse(text) as Frame;
    if (f.type === "fleetkeys.key") answer(f);
  };
}

/** Машина с одним слотом main и аккаунтом a@x; seats — сессии в записи модуля. */
async function bench(o: { seats?: Record<string, { slot: string; key?: true }>; holders?: stand.FakeHolders; slots?: Record<string, string[]> } = {}) {
  const store = join(home, "store");
  mkdirSync(store, { recursive: true });
  mkdirSync(join(home, "accounts", "a@x"), { recursive: true });
  writeFileSync(join(home, "accounts", "a@x", ".credentials.json"), "{}");
  mkdirSync(join(home, "slots"), { recursive: true });
  const { symlinkSync } = await import("node:fs");
  if (!existsSync(join(home, "slots", "main"))) symlinkSync(join(home, "accounts", "a@x"), join(home, "slots", "main"), process.platform === "win32" ? "junction" : "dir");
  if (!existsSync(join(store, "host-logins.json"))) writeFileSync(join(store, "host-logins.json"), JSON.stringify({ machine: { accounts: { "a@x": { login: "ok", limits: {} } }, slots: o.slots ?? { main: ["a@x"] } }, sessions: o.seats ?? {} }));
  st = await standHost({
    home,
    holders: o.holders,
    sessions: Object.keys(o.seats ?? {}).map((callsign) => ({ callsign })),
    start: false,
    modules: [{ manifest: manifest as Manifest, module: make() }, module("probe", {}, { uses: { "machine.accounts@host-logins": 2, "session.slot@host-logins": 2 } })],
  });
  services(st);
  await st.start();
  return st;
}

const V2 = new Set(["session.slot", "machine.accounts"]);
const ask = async (f: Record<string, unknown>) => (await st!.relay.request({ v: V2.has(String(f.type)) ? 2 : 1, machine: "laptop", ...f } as Frame)) as Frame & { ok: boolean; result: any; error?: string; why?: string };
const open = (name: string, req: Record<string, unknown> = {}) => st!.kernel.open({ callsign: `${name}@laptop`, cwd: join(home, "work", name), mkdir: true, opening: req });
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e as { word: string };
  }
};
const options = (cs: string) => st!.query(cs).options as Record<string, any>;
const last = (cs: string) => st!.states(cs).at(-1)!;
const changed = (name: string) => st!.relay.deliver({ type: "fleetkeys.changed", v: 1, to: "@laptop", from: ".fleetkeys", name } as Frame);
const ready = () => until(() => st!.journal().some((l) => l.ev === "ready"));

describe("ключ флота на машине", () => {
  it("8011 · выбор: ключ в папке, сессия помнит ключ; значения в окружении нет", async () => {
    await bench();
    await open("job", { slot: "orca" });
    expect(token("orca")).toBe("sk-orca-SECRET");
    expect(config("orca")).toEqual({ env: ORCA.env, settings: ORCA.settings });
    const o = options("job@laptop");
    expect(o.env.ANTHROPIC_BASE_URL).toBe("https://api.orcarouter.ai");
    expect(o.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(keyDir("orca"));
    expect(o.settings.apiKeyHelper).toContain("token");
    expect(o.settings.modelOverrides).toEqual({ a: "b" });
    expect(JSON.stringify({ env: o.env, settings: o.settings })).not.toContain("SECRET");
    expect(last("job@laptop")).toMatchObject({ slot: { name: "orca", wait: null } });
    expect(last("job@laptop").account).toBeUndefined();
  });

  it("8011 · slot.set и slot.swap с именем ключа — no_account; ключ не в слотах машины", async () => {
    await bench();
    await open("job", { slot: "orca" });
    expect(await ask({ type: "slot.set", slot: "x", order: ["orca"] })).toMatchObject({ ok: false, error: "no_account" });
    expect(await ask({ type: "slot.swap", slot: "main", account: "orca" })).toMatchObject({ ok: false, error: "no_account" });
    expect(Object.keys((await ask({ type: "machine.accounts" })).result.slots)).toEqual(["main"]);
  });

  it("8011 · модуль не ответил при открытии и смене слота — отказ словом, сессия на месте; ключа нет — no_slot со списком слотов", async () => {
    await bench();
    fleet.down = "offline";
    expect((await refused(open("job", { slot: "orca" })))?.word).toBe("offline");
    await open("keep", { slot: "main" });
    expect(await ask({ type: "session.slot", callsign: "keep@laptop", slot: "orca" })).toMatchObject({ ok: false, error: "offline" });
    expect(last("keep@laptop")).toMatchObject({ slot: { name: "main" } });
    fleet.down = null;
    const none = await refused(open("ghost", { slot: "nope" }));
    expect(none?.word).toBe("no_slot");
    expect(existsSync(keyDir("nope"))).toBe(false);
    expect((await refused(open("bad", { slot: "../up" })))?.word).toBe("no_slot");
    expect(asked).not.toContain("../up");
  });

  it("8011 · open без slot на машине с одним слотом и двумя ключами — слот машины", async () => {
    fleet.keys.kimi = { ...ORCA, key: "sk-k" };
    await bench();
    await open("job");
    expect(last("job@laptop")).toMatchObject({ slot: { name: "main" } });
    expect(asked).toEqual([]);
  });

  it("8011 · слот машины заведён с именем ключа: идущая сессия остаётся на ключе, новая встаёт в слот", async () => {
    await bench();
    await open("job", { slot: "orca" });
    expect(await ask({ type: "slot.set", slot: "orca", order: ["a@x"] })).toMatchObject({ ok: true });
    await st!.session("probe", "job@laptop")!.restart();
    await until(() => st!.holders.spawns.filter((x) => x.id === "job@laptop").length === 2 && st!.holders.procs.get("job@laptop")?.initializes === 1);
    expect(options("job@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(keyDir("orca"));
    await open("next", { slot: "orca" });
    expect(options("next@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(join(home, "slots", "orca"));
    expect(options("next@laptop").settings?.apiKeyHelper).toBeUndefined();
  });

  it("смена слота на ключ и обратно: перезапуск, папка и вход те же, что при открытии", async () => {
    await bench();
    await open("job", { slot: "main" });
    expect(await ask({ type: "session.slot", callsign: "job@laptop", slot: "orca" })).toMatchObject({ ok: true, result: { restart: true } });
    await until(() => st!.holders.spawns.filter((x) => x.id === "job@laptop").length === 2 && st!.holders.procs.get("job@laptop")?.initializes === 1);
    expect(options("job@laptop").settings.apiKeyHelper).toBeTruthy();
    expect(await ask({ type: "session.slot", callsign: "job@laptop", slot: "orca" })).toMatchObject({ ok: true, result: { restart: false } });
    expect(await ask({ type: "session.slot", callsign: "job@laptop", slot: "main" })).toMatchObject({ ok: true, result: { restart: true } });
  });

  it("8026 · перезапуск системы при идущей сессии на ключе, модуль ключей молчит: attach прошёл, папка на месте, до готовности запросов 0", async () => {
    folder("orca", ORCA);
    const holders = new FakeHolders();
    await bench({ seats: { "job@laptop": { slot: "orca", key: true } }, holders });
    await until(() => st!.session("probe", "job@laptop")?.state === "idle");
    await ready();
    st!.crash();
    asked = [];
    during = [];
    fleet.down = "offline";
    st = await standHost({
      home,
      holders,
      start: false,
      modules: [{ manifest: manifest as Manifest, module: make() }, module("probe", {}, { uses: { "machine.accounts@host-logins": 2, "session.slot@host-logins": 2 } })],
    });
    services(st);
    await st.start();
    await ready();
    expect(st.session("probe", "job@laptop")?.info.start).toBe("attach");
    expect(st.session("probe", "job@laptop")?.state).toBe("idle");
    expect(token("orca")).toBe(ORCA.key);
    await until(() => asked.length === 1);
    expect(during).toEqual(["idle"]);
    await until(() => st!.journal().some((l) => l.ev === "fleetkey" && l.word === "offline"));
  });

  it("8031 · подъём без связи: из папки, запросов до готовности 0; после подключения 1 запрос, папка обновлена", async () => {
    folder("orca", { ...ORCA, key: "старое" });
    fleet.keys.orca = { ...ORCA, key: "новое" };
    await bench({ seats: { "job@laptop": { slot: "orca", key: true } } });
    await ready();
    await until(() => token("orca") === "новое");
    expect(asked).toEqual(["orca"]);
    expect(during).toEqual(["idle"]);
    expect(options("job@laptop").env.ANTHROPIC_BASE_URL).toBe("https://api.orcarouter.ai");
  });

  it("8031 · ключа во флоте больше нет: папка удалена, следующий подъём — журнал, папка входа пуста, чужого входа нет", async () => {
    folder("orca", ORCA);
    fleet.keys = {};
    await bench({ seats: { "job@laptop": { slot: "orca", key: true } } });
    await ready();
    await until(() => !existsSync(keyDir("orca")));
    await st!.session("probe", "job@laptop")!.restart();
    await until(() => st!.holders.spawns.filter((x) => x.id === "job@laptop").length === 2 && st!.holders.procs.get("job@laptop")?.initializes === 1);
    const o = options("job@laptop");
    expect(o.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(keyDir("orca"));
    expect(o.settings?.apiKeyHelper).toBeUndefined();
    expect(st!.journal().some((l) => l.ev === "fleetkey" && l.word === "no_key" && l.callsign === "job@laptop")).toBe(true);
  });

  it("8036 · ключ сменён: папка есть — новый файл без перезапуска; папки нет — запросов 0; адрес сменён; ключ удалён — папки нет", async () => {
    await bench();
    await open("job", { slot: "orca" });
    const spawned = st!.holders.spawns.length;
    asked = [];
    fleet.keys.orca = { ...ORCA, key: "sk-new" };
    changed("orca");
    await until(() => token("orca") === "sk-new");
    changed("elsewhere");
    await new Promise((r) => setImmediate(r));
    expect(asked).toEqual(["orca"]);
    fleet.keys.orca = { ...fleet.keys.orca, env: { ANTHROPIC_BASE_URL: "https://other" } };
    changed("orca");
    await until(() => config("orca").env.ANTHROPIC_BASE_URL === "https://other");
    expect(options("job@laptop").env.ANTHROPIC_BASE_URL).toBe("https://api.orcarouter.ai");
    expect(st!.holders.spawns.length).toBe(spawned);
    delete fleet.keys.orca;
    changed("orca");
    await until(() => !existsSync(keyDir("orca")));
    expect(st!.journal().some((l) => l.ev === "fleetkey" && /папка удалена/.test(String(l.why)))).toBe(true);
  });

  it("8036 · кадр при молчащем модуле: папка прежняя, причина в журнале", async () => {
    await bench();
    await open("job", { slot: "orca" });
    fleet.down = "timeout";
    changed("orca");
    await until(() => st!.journal().some((l) => l.ev === "fleetkey" && l.word === "timeout"));
    expect(token("orca")).toBe(ORCA.key);
  });

  it("8027 · 429 и rate_limit на ключе: лимиты аккаунта не считаются, подмен 0, опросов 0", async () => {
    await bench();
    await open("job", { slot: "orca" });
    const s = st!.session("probe", "job@laptop")!;
    const proc = st!.proc("job@laptop");
    proc.send({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1 }, uuid: "00000000-0000-4000-8000-00000000aaaa", session_id: "s" } as never);
    proc.send({ type: "assistant", error: "rate_limit", message: { role: "assistant", content: [] }, parent_tool_use_id: null, uuid: "00000000-0000-4000-8000-00000000aaab", session_id: "s" } as never);
    await new Promise((r) => setImmediate(r));
    expect(s.state).not.toBe("failed");
    expect(st!.relay.frames("ledger.add").filter((f) => f.ev === "slot.swapped")).toEqual([]);
    expect(st!.journal().some((l) => l.ev === "slot.wait" || l.ev === "poll")).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "store", "host-logins.json"), "utf8")).machine.accounts["a@x"].limits).toEqual({});
  });

  const answer = (o: Record<string, unknown>) => JSON.stringify({ type: "result", duration_ms: 412, modelUsage: { "orcarouter/auto": {} }, ...o });

  it("8032 · проверка: рабочий ключ — модель и время; значения ключа нет в аргументах и окружении; копии на машине без сессий не остаётся", async () => {
    await bench();
    const calls: Array<{ args: string[]; env: Record<string, string | undefined>; helper: string }> = [];
    st!.sdk.cli = async (args, env) => {
      const settings = JSON.parse(args[args.indexOf("--settings") + 1]) as { apiKeyHelper: string };
      calls.push({ args, env, helper: readFileSync(settings.apiKeyHelper.slice(5, -1), "utf8") });
      return { code: 0, out: answer({ is_error: false, result: "ok" }) };
    };
    const r = await ask({ type: "machine.key_check", name: "orca" });
    expect(r).toMatchObject({ ok: true, result: { ok: true, word: "ключ принят, отвечает orcarouter/auto, 412 мс" } });
    expect(calls[0].helper).toBe(ORCA.key);
    expect(JSON.stringify(calls[0].args)).not.toContain("SECRET");
    expect(Object.values(calls[0].env).join(" ")).not.toContain("SECRET");
    expect(calls[0].env).toMatchObject({ ANTHROPIC_BASE_URL: "https://api.orcarouter.ai", CLAUDE_CONFIG_DIR: keyDir("orca") });
    expect(JSON.parse(calls[0].args[calls[0].args.indexOf("--settings") + 1]).modelOverrides).toEqual({ a: "b" });
    expect(existsSync(keyDir("orca"))).toBe(false);
  });

  it("8032 · ключ с ответом 401: ok false со словом ответа; ключа нет — no_key; на машине с сессией папка остаётся", async () => {
    await bench();
    await open("job", { slot: "orca" });
    st!.sdk.cli = async () => ({ code: 1, out: answer({ is_error: true, result: "API Error: 401 invalid key" }) });
    expect(await ask({ type: "machine.key_check", name: "orca" })).toMatchObject({ ok: true, result: { ok: false, word: "API Error: 401 invalid key" } });
    expect(existsSync(keyDir("orca"))).toBe(true);
    expect(await ask({ type: "machine.key_check", name: "none" })).toMatchObject({ ok: false, error: "no_key" });
  });
});
