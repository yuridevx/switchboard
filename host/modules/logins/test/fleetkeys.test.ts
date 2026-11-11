// Леса ключа флота на машине: настоящее ядро Host на поддельных SDK и relay, модуль ключей флота — участник рации. Папки — настоящие, во временной папке.
// Значение ключа — только в памяти logins, его отдаёт route прокси; настоящий claude через прокси — в live.test.ts модуля proxy. Номер эталона — номер теста.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
/** Ключи во флоте; down — слово отказа вместо ответа. */
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

const keyHome = () => join(home, "fleetkeys");
/** Все файлы папки данных. */
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)])) : []);
const onDisk = (text: string) => files(home).filter((f) => readFileSync(f, "utf8").includes(text));

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

const PROBE = { uses: { "machine.accounts@host-logins": 2, "session.slot@host-logins": 2, "route@host-logins": 1 } };

/** Машина с одним слотом main и аккаунтом a@x; seats — сессии в записи модуля. */
async function bench(o: { seats?: Record<string, Record<string, unknown>>; holders?: stand.FakeHolders; slots?: Record<string, string[]> } = {}) {
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
    modules: [{ manifest: manifest as Manifest, module: make() }, module("probe", {}, PROBE)],
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
/** route внутри Host — как его зовёт прокси. */
const route = (o: Record<string, unknown>) => st!.host("probe").request("route", o);
const sidOf = (cs: string) => st!.session("probe", cs)!.info.session_id;
const CONFIG = { env: ORCA.env, settings: ORCA.settings };

describe("ключ флота на машине", () => {
  it("21 · выбор: значение только в памяти — на диске его нет; у claude слово fleet вместо ключа, адреса провайдера и apiKeyHelper нет", async () => {
    await bench();
    await open("job", { slot: "orca" });
    const o = options("job@laptop");
    expect(o.env.ANTHROPIC_API_KEY).toBe("fleet");
    expect(o.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(o.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("orcarouter/auto");
    expect(o.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(keyHome());
    expect(o.settings?.apiKeyHelper).toBeUndefined();
    expect(o.settings.modelOverrides).toEqual({ a: "b" });
    expect(JSON.stringify(o)).not.toContain("SECRET");
    expect(onDisk("SECRET")).toEqual([]);
    expect(files(keyHome())).toEqual([]);
    expect(last("job@laptop")).toMatchObject({ slot: { name: "orca", wait: null } });
    expect(last("job@laptop").account).toBeUndefined();
  });

  it("route: ключ — адрес провайдера и значение; аккаунт — Anthropic без ключа; чужой id — unknown_session; не изнутри Host — denied", async () => {
    await bench();
    await open("job", { slot: "orca" });
    await open("acc", { slot: "main" });
    expect(await route({ sid: sidOf("job@laptop") })).toEqual({ ok: true, result: { to: "https://api.orcarouter.ai", key: ORCA.key } });
    expect(await route({ sid: sidOf("acc@laptop") })).toEqual({ ok: true, result: { to: "https://api.anthropic.com" } });
    expect(await route({ sid: "чужой" })).toMatchObject({ ok: false, error: "unknown_session" });
    expect(await route({ key: "orca" })).toEqual({ ok: true, result: { to: "https://api.orcarouter.ai", key: ORCA.key, env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "orcarouter/auto", ANTHROPIC_API_KEY: "fleet" }, settings: ORCA.settings } });
    expect(await route({ key: "none" })).toMatchObject({ ok: false, error: "no_key" });
    expect(await ask({ type: "route", sid: sidOf("job@laptop") })).toMatchObject({ ok: false, error: "denied" });
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
    expect((await refused(open("ghost", { slot: "nope" })))?.word).toBe("no_slot");
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
    expect(options("job@laptop").env.ANTHROPIC_API_KEY).toBe("fleet");
    await open("next", { slot: "orca" });
    expect(options("next@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(join(home, "slots", "orca"));
    expect(options("next@laptop").env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(await route({ sid: sidOf("next@laptop") })).toEqual({ ok: true, result: { to: "https://api.anthropic.com" } });
  });

  it("смена слота на ключ и обратно: перезапуск, вход тот же, что при открытии", async () => {
    await bench();
    await open("job", { slot: "main" });
    expect(await ask({ type: "session.slot", callsign: "job@laptop", slot: "orca" })).toMatchObject({ ok: true, result: { restart: true } });
    await until(() => st!.holders.spawns.filter((x) => x.id === "job@laptop").length === 2 && st!.holders.procs.get("job@laptop")?.initializes === 1);
    expect(options("job@laptop").env.ANTHROPIC_API_KEY).toBe("fleet");
    expect(await ask({ type: "session.slot", callsign: "job@laptop", slot: "orca" })).toMatchObject({ ok: true, result: { restart: false } });
    expect(await ask({ type: "session.slot", callsign: "job@laptop", slot: "main" })).toMatchObject({ ok: true, result: { restart: true } });
  });

  it("8026 · перезапуск системы при идущей сессии на ключе, модуль ключей молчит: attach прошёл, до готовности запросов 0, route — отказ словом", async () => {
    const holders = new FakeHolders();
    await bench({ seats: { "job@laptop": { slot: "orca", key: true, config: CONFIG } }, holders });
    await until(() => st!.session("probe", "job@laptop")?.state === "idle");
    await ready();
    st!.crash();
    asked = [];
    during = [];
    fleet.down = "offline";
    st = await standHost({ home, holders, start: false, modules: [{ manifest: manifest as Manifest, module: make() }, module("probe", {}, PROBE)] });
    services(st);
    await st.start();
    await ready();
    expect(st.session("probe", "job@laptop")?.info.start).toBe("attach");
    expect(st.session("probe", "job@laptop")?.state).toBe("idle");
    await until(() => asked.length === 1);
    expect(during).toEqual(["idle"]);
    await until(() => st!.journal().some((l) => l.ev === "fleetkey" && l.word === "offline"));
    expect(await route({ sid: sidOf("job@laptop") })).toMatchObject({ ok: false, error: "offline" });
  });

  it("8031 · подъём без связи: настройки из записи сессии, запросов до готовности 0; после подключения 1 запрос, route — новый ключ", async () => {
    fleet.keys.orca = { ...ORCA, key: "новое" };
    await bench({ seats: { "job@laptop": { slot: "orca", key: true, config: CONFIG } } });
    await ready();
    await until(() => asked.length === 1);
    expect(asked).toEqual(["orca"]);
    expect(during).toEqual(["idle"]);
    expect(options("job@laptop").env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("orcarouter/auto");
    await until(async () => ((await route({ sid: sidOf("job@laptop") })) as { result?: { key: string } }).result?.key === "новое");
  });

  it("8031 · ключа во флоте больше нет: значение забыто, следующий подъём — журнал, вход пуст, ключа нет", async () => {
    fleet.keys = {};
    await bench({ seats: { "job@laptop": { slot: "orca", key: true, config: CONFIG } } });
    await ready();
    await until(() => st!.journal().some((l) => l.ev === "fleetkey" && /значение забыто/.test(String(l.why))));
    await st!.session("probe", "job@laptop")!.restart();
    await until(() => st!.holders.spawns.filter((x) => x.id === "job@laptop").length === 2 && st!.holders.procs.get("job@laptop")?.initializes === 1);
    const o = options("job@laptop");
    expect(o.env).toMatchObject({ CLAUDE_SECURESTORAGE_CONFIG_DIR: keyHome(), ANTHROPIC_API_KEY: "fleet" });
    expect(o.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(st!.journal().some((l) => l.ev === "fleetkey" && l.word === "no_key" && l.callsign === "job@laptop")).toBe(true);
    expect(await route({ sid: sidOf("job@laptop") })).toMatchObject({ ok: false, error: "no_key" });
  });

  it("8036 · ключ сменён: следующий route — новое значение без перезапуска; чужой ключ — запросов 0; адрес сменён; ключ удалён — no_key", async () => {
    await bench();
    await open("job", { slot: "orca" });
    const sid = sidOf("job@laptop");
    const spawned = st!.holders.spawns.length;
    asked = [];
    fleet.keys.orca = { ...ORCA, key: "sk-new" };
    changed("orca");
    await until(async () => ((await route({ sid })) as { result?: { key: string } }).result?.key === "sk-new");
    changed("elsewhere");
    await new Promise((r) => setImmediate(r));
    expect(asked).toEqual(["orca"]);
    fleet.keys.orca = { ...fleet.keys.orca, env: { ANTHROPIC_BASE_URL: "https://other" } };
    changed("orca");
    await until(async () => ((await route({ sid })) as { result?: { to: string } }).result?.to === "https://other");
    expect(st!.holders.spawns.length).toBe(spawned);
    delete fleet.keys.orca;
    changed("orca");
    await until(async () => ((await route({ sid })) as { error?: string }).error === "no_key");
    expect(onDisk("sk-new")).toEqual([]);
  });

  it("8036 · кадр при молчащем модуле: ключ прежний, причина в журнале", async () => {
    await bench();
    await open("job", { slot: "orca" });
    fleet.down = "timeout";
    changed("orca");
    await until(() => st!.journal().some((l) => l.ev === "fleetkey" && l.word === "timeout"));
    expect(await route({ sid: sidOf("job@laptop") })).toMatchObject({ ok: true, result: { key: ORCA.key } });
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
});
