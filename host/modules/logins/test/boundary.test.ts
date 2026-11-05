// Леса границы «вход и профиль сессии», сторона Host, вход и слоты. Снаружи: поддельные SDK, relay, keeper и часы; короткий claude и claude auth status —
// поддельные, отвечают по своему окружению. Ссылки слотов — настоящие: junction на Windows, symlink на Linux.
// Всё во временных папках: SWITCHBOARD_HOME и папка пользователя (HOME/USERPROFILE) — свои на каждый тест. Номер эталона — номер теста.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { CALL_MS, READ_MS } from "@switchboard/protocol";
import { make } from "../contract.ts";

const { msg, module, standHost, turn, until } = stand;
type Stand = stand.Stand;
const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
/** Файл входа и блокировка обновления входа — имена самого claude (опыт 1 ноя). */
const CREDENTIALS = ".credentials.json";
const REFRESH_LOCK = ".oauth_refresh.lock";
/** Сколько подмена ждёт блокировку: свою claude держит меньше секунды. */
const LOCK_WAIT_MS = 10_000;
/** Проверка входа — раз в 2 мин, как в claude-fleet. */
const CHECK_MS = 120_000;
/** Опрос окон — на 2 с раньше предела чтения. */
const POLL_MS = READ_MS - 2_000;
const STATUS_MS = READ_MS;
const LOGIN_MS = CALL_MS;
/** Сколько процесс входа ждёт код. */
const LOGIN_WAIT_MS = 30 * 60_000;
const CONTINUE = "Продолжай";
/** Ссылка слота на папку аккаунта: так её видит диск машины. */
function linkSlot(slot: string, target: string) {
  mkdirSync(join(slot, ".."), { recursive: true });
  symlinkSync(target, slot, process.platform === "win32" ? "junction" : "dir");
}

let st: Stand | null = null;
let home = "";
let user = "";
const saved = { ...process.env };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sb-logins-"));
  user = mkdtempSync(join(tmpdir(), "sb-user-"));
  process.env.SWITCHBOARD_HOME = home;
  process.env.HOME = user;
  process.env.USERPROFILE = user;
});
afterEach(async () => {
  vi.useRealTimers();
  await st?.close();
  st = null;
  process.env = { ...saved };
});

type Win = { utilization: number; resetsAt: number; at?: number; src?: string };
/** in — слоты, где аккаунт стоит сейчас (ссылка слота ведёт на его папку). */
type AccSpec = { in?: string | string[]; login?: "ok" | "none" | "pending"; limits?: Record<string, Win>; bare?: boolean };
type ProbeLog = { env: Record<string, string | undefined>; calls: Array<{ name: string; args: unknown[] }> };
type Rates = Record<string, { utilization: number; resets_at: string }>;

const accDir = (n: string) => join(home, "accounts", n);
const slotDir = (n: string) => join(home, "slots", n);
const now = () => Math.floor(Date.now() / 1000);
const read = (d: string) => readFileSync(join(d, CREDENTIALS), "utf8");
const isLink = (p: string) => existsSync(p) && lstatSync(p).isSymbolicLink();
const raw = () => JSON.parse(readFileSync(join(home, "store", "host-logins.json"), "utf8"));
function cred(dir: string, who: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CREDENTIALS), JSON.stringify({ claudeAiOauth: { accessToken: `tok-${who}` } }));
}

/** Ответ Claude на опрос окон: имя аккаунта → rate_limits, нет — окон нет. Кого опрашивали — polled. */
let usage: Record<string, Rates> = {};
let polled: string[] = [];
let probes: ProbeLog[] = [];
let cli: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
let mod: ReturnType<typeof make>;

/** Машина: аккаунты (вход — файлом в папке аккаунта, слоты — ссылки на неё), порядок слотов и слоты сессий. Сессии поднимаются по resume. */
async function bench(
  o: {
    accounts?: Record<string, AccSpec>;
    slots?: Record<string, string[]>;
    sessions?: Record<string, { slot: string | null; cut?: string }>;
    status?: (env: Record<string, string | undefined>) => { code: number; out: string } | Promise<{ code: number; out: string }>;
    poll?: (name: string) => unknown;
  } = {},
) {
  usage = {};
  polled = [];
  probes = [];
  cli = [];
  const store = join(home, "store");
  mkdirSync(store, { recursive: true });
  const recs: Record<string, unknown> = {};
  for (const [n, a] of Object.entries(o.accounts ?? {})) {
    mkdirSync(accDir(n), { recursive: true });
    if ((a.login ?? "ok") === "ok" && !a.bare) cred(accDir(n), n);
    for (const s of a.in === undefined ? [] : [a.in].flat()) linkSlot(slotDir(s), accDir(n));
    recs[n] = { login: a.login ?? "ok", limits: Object.fromEntries(Object.entries(a.limits ?? {}).map(([w, v]) => [w, { at: now() - 30, src: "event", ...v }])) };
  }
  writeFileSync(join(store, "host-logins.json"), JSON.stringify({ machine: { accounts: recs, slots: o.slots ?? {} }, sessions: o.sessions ?? {} }));
  mod = make();
  st = await standHost({
    home,
    sessions: Object.keys(o.sessions ?? {}).map((callsign) => ({ callsign })),
    modules: [{ manifest: manifest as Manifest, module: mod }, module("probe", {}, { uses: { "machine.accounts@host-logins": 1, "session.slot@host-logins": 1 } })],
  });
  const orig = st.sdk.query;
  st.sdk.query = (p) => {
    const q = orig(p) as unknown as Record<string, unknown>;
    if (p.options?.spawnClaudeCodeProcess) return q as never;
    const env = (p.options?.env ?? {}) as Record<string, string | undefined>;
    const name = String(env.CLAUDE_CONFIG_DIR ?? "").split(/[\\/]/).at(-1) ?? "";
    const log: ProbeLog = { env, calls: [] };
    probes.push(log);
    const rec = (n: string, fn: (...a: unknown[]) => unknown) => (q[n] = async (...a: unknown[]) => (log.calls.push({ name: n, args: a }), fn(...a)));
    rec("claudeAuthenticate", () => ({ manualUrl: "https://claude.ai/oauth/authorize?code=true&state=Qm9vY", automaticUrl: "http://localhost:5555/callback" }));
    rec("claudeOAuthCallback", (code) => {
      if (code !== "Xk2pL") throw new Error("Request failed with status code 400");
      // claude кладёт вход и почту в свою папку
      const dir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR!;
      writeFileSync(join(dir, CREDENTIALS), JSON.stringify({ claudeAiOauth: { accessToken: `tok-${name}` } }));
      writeFileSync(join(env.CLAUDE_CONFIG_DIR!, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "corp@x" } }));
      return { account: { email: "corp@x", subscriptionType: "max" } };
    });
    rec("accountInfo", () => ({ email: "corp@x", subscriptionType: "max" }));
    rec(USAGE, () => {
      polled.push(name);
      return o.poll ? o.poll(name) : { rate_limits: usage[name] ?? null };
    });
    return q as never;
  };
  st.sdk.cli = async (args, env) => {
    cli.push({ args, env });
    return (await o.status?.(env)) ?? { code: 0, out: JSON.stringify({ loggedIn: true }) };
  };
  for (const cs of Object.keys(o.sessions ?? {})) await until(() => st!.session("probe", cs)?.state === "idle");
  return st;
}

const ask = async (f: Record<string, unknown>) => (await st!.relay.request({ v: 1, machine: "laptop", ...f } as Frame)) as Frame & { ok: boolean; result: any; error?: string; why?: string };
const accounts = async () => (await ask({ type: "machine.accounts" })).result.accounts;
const slots = async () => (await ask({ type: "machine.accounts" })).result.slots;
const places = () => st!.journal().filter((l) => l.ev === "place");
const swaps = () => st!.relay.frames("ledger.add").filter((f) => f.ev === "slot.swapped");
const limit = (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info, uuid: "00000000-0000-4000-8000-00000000aaaa", session_id: "s" });
const last = (cs: string) => st!.states(cs).at(-1)!;
/** Открыть сессию запросом открытия, как session.open. */
const opening = (name: string, req: Record<string, unknown> = {}) => st!.kernel.open({ callsign: `${name}@laptop`, cwd: join(home, "work", name), mkdir: true, opening: req });
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e as { word: string; why?: string };
  }
};
/** Дождаться асинхронного условия. */
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождались: ${fn.toString().slice(0, 160)}`);
    await new Promise((r) => setImmediate(r));
  }
}

describe("входы аккаунтов", () => {
  it("160 · вход corp по ссылке и коду: своя папка, ~/.claude.json машины прежний, кода нет в журнале и аргументах", async () => {
    writeFileSync(join(homedir(), ".claude.json"), '{"oauthAccount":{"emailAddress":"me@machine"}}');
    const before = readFileSync(join(homedir(), ".claude.json"));
    await bench();
    const r1 = await ask({ type: "machine.login", account: "corp" });
    expect(r1.ok).toBe(true);
    expect(r1.result.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/);
    expect(probes).toHaveLength(1);
    expect(probes[0].env.CLAUDE_CONFIG_DIR).toBe(accDir("corp"));
    expect(probes[0].calls).toEqual([{ name: "claudeAuthenticate", args: [true] }]);
    expect((await accounts()).corp.login).toBe("pending");

    const r2 = await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" });
    expect(r2.ok).toBe(true);
    expect(r2.result).toEqual({ email: "corp@x", plan: "max" });
    expect(probes[0].calls[1]).toEqual({ name: "claudeOAuthCallback", args: ["Xk2pL", "Qm9vY"] });
    expect(existsSync(join(accDir("corp"), CREDENTIALS))).toBe(true);
    expect(readFileSync(join(homedir(), ".claude.json"))).toEqual(before);
    expect((await accounts()).corp).toMatchObject({ login: "ok", email: "corp@x", plan: "max" });
    // проверка входа той же папкой
    expect(cli.at(-1)!.args).toEqual(["auth", "status"]);
    expect(cli.at(-1)!.env.CLAUDE_CONFIG_DIR).toBe(accDir("corp"));
    const all = JSON.stringify(st!.journal()) + JSON.stringify(cli.map((c) => c.args)) + JSON.stringify(probes.map((p) => p.env));
    expect(all).not.toContain("Xk2pL");
  });

  it("161 · max_age: опрошен только y0902 своей папкой, infirex — нет; в сессии запрос не уходит", async () => {
    const t = now();
    await bench({
      accounts: {
        infirex: { in: "main", limits: { five_hour: { utilization: 0.83, resetsAt: t + 9000, at: t - 10, src: "poll" } } },
        y0902: { limits: { five_hour: { utilization: 0.5, resetsAt: t + 9000, at: t - 600, src: "poll" } } },
      },
      poll: (name) => ({ subscription_type: "max", rate_limits: { five_hour: { utilization: name === "y0902" ? 4 : 83, resets_at: new Date((t + 9000) * 1000).toISOString() } } }),
    });
    const r = await ask({ type: "machine.accounts", max_age: 120 });
    expect(probes).toHaveLength(1);
    expect(probes[0].env.CLAUDE_CONFIG_DIR).toBe(accDir("y0902"));
    expect(probes[0].env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect(probes[0].calls).toEqual([{ name: USAGE, args: [{ skipBehaviors: true }] }]);
    expect(r.result.accounts.y0902.limits.five_hour).toMatchObject({ utilization: 0.04, src: "poll" });
    expect(r.result.accounts.infirex.limits.five_hour.utilization).toBe(0.83);
    expect(st!.sdk.queries.filter((q) => q.options.spawnClaudeCodeProcess)).toHaveLength(0);
  });

  it("162 · раз в 2 мин claude auth status — своей папкой, и у аккаунта в слоте; выход 1 — login none", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await bench({
      accounts: { y0902: {}, corp: { in: "bot" } },
      status: (env) => (env.CLAUDE_CONFIG_DIR === accDir("corp") ? { code: 1, out: '{"loggedIn":false}' } : { code: 0, out: '{"loggedIn":true}' }),
    });
    vi.advanceTimersByTime(CHECK_MS);
    await until(() => cli.length === 2);
    expect(cli.every((c) => c.env.CLAUDE_SECURESTORAGE_CONFIG_DIR === undefined)).toBe(true);
    expect(cli.map((c) => c.env.CLAUDE_CONFIG_DIR).sort()).toEqual([accDir("corp"), accDir("y0902")].sort());
    await until(() => st!.journal().some((l) => l.why === "corp: вход пропал"));
    const a = await accounts();
    expect(a.corp.login).toBe("none");
    expect(a.y0902.login).toBe("ok");
    expect(read(slotDir("bot"))).toContain("tok-corp");
  });

  it("163 · слот — ссылка на папку аккаунта, входы не двигаются; один аккаунт — в двух слотах; пустой порядок снимает ссылку", async () => {
    await bench({ accounts: { infirex: { in: "main" }, y0902: {} }, slots: { main: ["infirex", "y0902"] } });
    expect(await ask({ type: "slot.swap", slot: "main", account: "y0902" })).toMatchObject({ ok: true, result: { from: "infirex", to: "y0902" } });
    expect(isLink(slotDir("main"))).toBe(true);
    expect(read(slotDir("main"))).toContain("tok-y0902");
    expect(read(accDir("infirex"))).toContain("tok-infirex");
    expect(read(accDir("y0902"))).toContain("tok-y0902");

    // тот же аккаунт — и во второй слот
    expect(await ask({ type: "slot.set", slot: "bot", order: ["y0902"] })).toMatchObject({ ok: true, result: { account: "y0902" } });
    expect(read(slotDir("bot"))).toContain("tok-y0902");
    let s = await slots();
    expect([s.main.account, s.bot.account]).toEqual(["y0902", "y0902"]);

    // повтор — ничего не меняется
    const n = places().length;
    expect(await ask({ type: "slot.swap", slot: "bot", account: "y0902" })).toMatchObject({ ok: true, result: { from: "y0902", to: "y0902" } });
    expect(places()).toHaveLength(n);
    // снять ссылку bot: папка аккаунта цела
    expect(await ask({ type: "slot.set", slot: "bot", order: [] })).toMatchObject({ ok: true, result: { account: null } });
    expect(existsSync(slotDir("bot"))).toBe(false);
    expect(read(accDir("y0902"))).toContain("tok-y0902");
    s = await slots();
    expect(s.bot).toBeUndefined();
    expect(s.main.account).toBe("y0902");
    expect(existsSync(join(accDir("infirex"), REFRESH_LOCK))).toBe(false);
  });

  it("164 · удалить corp — только его папка; аккаунт в слоте без запаса — no_reserve; logout не зовётся", async () => {
    mkdirSync(join(user, ".claude"), { recursive: true });
    writeFileSync(join(user, ".claude", "settings.json"), "{}");
    await bench({ accounts: { corp: {}, infirex: { in: "main" }, y0902: {} }, slots: { main: ["infirex"] } });
    const r = await ask({ type: "machine.account_remove", account: "corp" });
    expect(r.result).toEqual({ wiped: true });
    expect(existsSync(accDir("corp"))).toBe(false);
    expect(await ask({ type: "machine.account_remove", account: "infirex" })).toMatchObject({ ok: false, error: "no_reserve" });
    expect(read(slotDir("main"))).toContain("tok-infirex");
    expect(read(accDir("y0902"))).toContain("tok-y0902");
    expect(existsSync(join(user, ".claude", "settings.json"))).toBe(true);
    expect(Object.keys(await accounts()).sort()).toEqual(["infirex", "y0902"]);
    expect(cli.some((c) => c.args.includes("logout"))).toBe(false);
  });

  it("165 · каждое окно — из самого свежего источника; сброс прошёл — 0 %", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = (h: number, m: number) => Date.UTC(2026, 9, 31, h, m) / 1000;
    vi.setSystemTime(at(14, 55) * 1000);
    await bench({
      accounts: {
        y0902: {
          in: "main",
          limits: {
            five_hour: { utilization: 0.04, resetsAt: at(16, 20), at: at(14, 40), src: "event" },
            seven_day: { utilization: 0.66, resetsAt: at(16, 20) + 5 * 86400, at: at(14, 58), src: "poll" },
          },
        },
      },
      slots: { main: ["y0902"] },
      sessions: { "site@laptop": { slot: "main" } },
    });
    const p = st!.proc("site@laptop");
    p.send(limit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.09, resetsAt: at(16, 20) }));
    // событие старше окна опроса окно не трогает
    p.send(limit({ status: "allowed", rateLimitType: "seven_day", utilization: 0.1, resetsAt: at(16, 20) + 5 * 86400 }));
    const l = await waitFor(async () => {
      const x = (await accounts()).y0902.limits;
      return x.five_hour.utilization === 0.09 ? x : null;
    });
    expect(l.five_hour).toEqual({ utilization: 0.09, resetsAt: at(16, 20), at: at(14, 55), src: "event" });
    expect(l.seven_day).toMatchObject({ utilization: 0.66, src: "poll" });
    vi.setSystemTime(at(16, 21) * 1000);
    const l2 = (await accounts()).y0902.limits;
    expect(l2.five_hour.utilization).toBe(0);
    expect(l2.seven_day.utilization).toBe(0.66);
  });

  it.each([
    ["265 · подмена", { type: "slot.swap", slot: "main", account: "y0902" }, () => accDir("infirex"), "infirex"],
    ["3039 · удаление слота", { type: "slot.set", slot: "main", order: [] }, () => accDir("infirex"), "infirex"],
  ])("%s: блокировка держится дольше 10 с — refresh_locked, ссылка прежняя, чужую не трогаем", async (_n, frame, lockDir, who) => {
    await bench({ accounts: { infirex: { in: "main" }, y0902: {} }, slots: { main: ["infirex", "y0902"] } });
    mkdirSync(join(lockDir(), REFRESH_LOCK));
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const p = st!.relay.request({ v: 1, machine: "laptop", ...frame } as unknown as Frame);
    for (let t = 0; t <= LOCK_WAIT_MS + 200; t += 100) await vi.advanceTimersByTimeAsync(100);
    vi.useRealTimers();
    expect(await p).toMatchObject({ ok: false, error: "refresh_locked" });
    expect(read(slotDir("main"))).toContain(`tok-${who}`);
    expect(existsSync(join(lockDir(), REFRESH_LOCK))).toBe(true);
    expect((await slots()).main.account).toBe(who);
  });

  it("171 · claude обновляет вход прежнего аккаунта — подмена ждёт его блокировку и идёт сразу после (опыт 1 ноя)", async () => {
    await bench({ accounts: { infirex: { in: "main" }, y0902: {} }, slots: { main: ["infirex", "y0902"] } });
    // блокировка claude — папка рядом с файлом входа; через ссылку слота она в папке infirex
    mkdirSync(join(slotDir("main"), REFRESH_LOCK));
    expect(existsSync(join(accDir("infirex"), REFRESH_LOCK))).toBe(true);
    let done = false;
    const p = ask({ type: "slot.swap", slot: "main", account: "y0902" }).then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false);
    expect(read(slotDir("main"))).toContain("tok-infirex");
    rmdirSync(join(accDir("infirex"), REFRESH_LOCK));
    expect(await p).toMatchObject({ ok: true, result: { from: "infirex", to: "y0902" } });
    expect(read(slotDir("main"))).toContain("tok-y0902");
    expect(existsSync(join(accDir("infirex"), REFRESH_LOCK))).toBe(false);
  });

});

describe("входы: ветки и стыки", () => {
  it("неверный код — bad_code, процесс входа закрыт; второй код — not_started", async () => {
    await bench();
    await ask({ type: "machine.login", account: "corp" });
    const r = await ask({ type: "machine.login_code", account: "corp", code: "WRONG#Qm9vY" });
    expect(r).toMatchObject({ ok: false, error: "bad_code" });
    expect(st!.sdk.queries.filter((q) => !q.options.spawnClaudeCodeProcess).every((q) => q.closed)).toBe(true);
    expect(probes).toHaveLength(1);
    expect(await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" })).toMatchObject({ ok: false, error: "not_started" });
    expect(JSON.stringify(st!.journal())).not.toContain("WRONG");
  });

  it("7340 · код не пришёл за срок входа: процесс закрыт, login none, причина в журнале, поздний код — not_started", async () => {
    // источник: устав — у всех операций лимит; бэклог «процесс входа, ждущий код, без срока»
    await bench();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ask({ type: "machine.login", account: "corp" });
    expect((await accounts()).corp.login).toBe("pending");
    await vi.advanceTimersByTimeAsync(LOGIN_WAIT_MS - 1);
    expect((await accounts()).corp.login).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    expect((await accounts()).corp.login).toBe("none");
    expect(st!.sdk.queries.filter((q) => !q.options.spawnClaudeCodeProcess).every((q) => q.closed)).toBe(true);
    expect(st!.journal().some((l) => l.ev === "login" && String(l.why).includes("срок"))).toBe(true);
    expect(await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" })).toMatchObject({ ok: false, error: "not_started" });
  });

  it("7341 · вход завершён или начат заново: прежний срок не закрывает новое", async () => {
    // источник: устав — у всех операций лимит; чьё: код — повтор machine.login закрывает прежний процесс
    await bench();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await ask({ type: "machine.login", account: "corp" });
    await vi.advanceTimersByTimeAsync(LOGIN_WAIT_MS - 1);
    await ask({ type: "machine.login", account: "corp" });
    await vi.advanceTimersByTimeAsync(1);
    expect((await accounts()).corp.login).toBe("pending");
    expect((await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" })).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(LOGIN_WAIT_MS);
    vi.useRealTimers();
    expect((await accounts()).corp.login).toBe("ok");
  });

  it("код без # — состояние из ссылки; повтор machine.login закрывает прежний процесс", async () => {
    await bench();
    await ask({ type: "machine.login", account: "corp" });
    await ask({ type: "machine.login", account: "corp" });
    expect(st!.sdk.queries[0].closed).toBe(true);
    expect((await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL" })).ok).toBe(true);
    expect(probes[1].calls[1]).toEqual({ name: "claudeOAuthCallback", args: ["Xk2pL", "Qm9vY"] });
  });

  it("Host перезапущен посреди входа: pending → none, код — not_started", async () => {
    await bench({ accounts: { corp: { login: "pending" } } });
    expect((await accounts()).corp.login).toBe("none");
    expect(await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" })).toMatchObject({ ok: false, error: "not_started" });
  });

  it("аккаунт в слоте, вход пропал — «Войти» кладёт вход в свою папку, слот видит его через ссылку", async () => {
    await bench({ accounts: { corp: { login: "none", in: "bot" } }, slots: { bot: ["corp"] } });
    await ask({ type: "machine.login", account: "corp" });
    expect(probes[0].env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" });
    expect(read(accDir("corp"))).toContain("tok-corp");
    expect(read(slotDir("bot"))).toContain("tok-corp");
  });

  it("на месте слота папка с файлами — slot_dir_busy, файлы не тронуты; пустая папка — заменяется ссылкой", async () => {
    mkdirSync(slotDir("main"), { recursive: true });
    writeFileSync(join(slotDir("main"), "keep.txt"), "x");
    mkdirSync(slotDir("bot"), { recursive: true });
    await bench({ accounts: { y0902: {} } });
    expect(await ask({ type: "slot.set", slot: "main", order: ["y0902"] })).toMatchObject({ ok: false, error: "slot_dir_busy" });
    expect(await slots()).toEqual({});
    expect(readFileSync(join(slotDir("main"), "keep.txt"), "utf8")).toBe("x");
    expect(await ask({ type: "slot.set", slot: "bot", order: ["y0902"] })).toMatchObject({ ok: true, result: { account: "y0902" } });
    expect(isLink(slotDir("bot"))).toBe(true);
  });

  it("слова: no_account, not_logged_in; опрос не ответил — прежние окна, причина только в журнале", async () => {
    const t = now();
    await bench({
      accounts: {
        none: { login: "none" },
        bare: { bare: true },
        y0902: { in: "main", limits: { five_hour: { utilization: 0.5, resetsAt: t + 900, at: t - 600, src: "poll" } } },
      },
      slots: { main: ["y0902", "none", "bare"] },
      poll: () => {
        throw new Error("нет сети");
      },
    });
    expect(await ask({ type: "slot.swap", slot: "main", account: "ghost" })).toMatchObject({ ok: false, error: "no_account" });
    expect(await ask({ type: "slot.swap", slot: "main", account: "none" })).toMatchObject({ ok: false, error: "not_logged_in" });
    expect(await ask({ type: "slot.swap", slot: "main", account: "bare" })).toMatchObject({ ok: false, error: "not_logged_in" }); // файла входа нет
    const r = await ask({ type: "machine.accounts", max_age: 60 });
    expect(r.result.accounts.y0902.limits.five_hour.utilization).toBe(0.5);
    expect(r.result.accounts.y0902.err).toBeUndefined();
    expect(st!.journal().some((l) => l.ev === "poll" && /нет сети/.test(String(l.why)))).toBe(true);
  });

  it("3049 · machine.login: имя не по форме — bad_frame; claudeAuthenticate отказал — login_failed, процесс входа закрыт", async () => {
    // источник: чьё: код
    await bench();
    expect(await ask({ type: "machine.login", account: "a b" })).toMatchObject({ ok: false, error: "bad_frame" });
    const orig = st!.sdk.query;
    st!.sdk.query = (p) => {
      const q = orig(p) as unknown as Record<string, unknown>;
      q.claudeAuthenticate = async () => {
        throw new Error("нет сети");
      };
      return q as never;
    };
    expect(await ask({ type: "machine.login", account: "corp" })).toMatchObject({ ok: false, error: "login_failed" });
    expect(st!.sdk.queries.filter((q) => !q.options.spawnClaudeCodeProcess).every((q) => q.closed)).toBe(true);
  });

  it("3050 · login_code: в ответе callback нет почты — почта и тариф из accountInfo", async () => {
    // источник: чьё: код
    await bench();
    await ask({ type: "machine.login", account: "corp" });
    const q = st!.sdk.queries.find((x) => !x.options.spawnClaudeCodeProcess) as unknown as Record<string, unknown>;
    q.claudeOAuthCallback = async () => {
      cred(accDir("corp"), "corp");
      return {};
    };
    expect(await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" })).toMatchObject({ ok: true, result: { email: "corp@x", plan: "max" } });
    expect((await accounts()).corp).toMatchObject({ login: "ok", email: "corp@x", plan: "max" });
  });

  it("3051 · login_code: claude принял код, но auth status — не вошёл: login none, строка журнала", async () => {
    // источник: чьё: код
    await bench({ status: () => ({ code: 1, out: '{"loggedIn":false}' }) });
    await ask({ type: "machine.login", account: "corp" });
    expect(await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" })).toMatchObject({ ok: true });
    expect((await accounts()).corp.login).toBe("none");
    expect(st!.journal().some((l) => l.why === "corp: claude принял код, но auth status — не вошёл")).toBe(true);
  });

  it("3052 · удалить аккаунт посреди входа — процесс входа закрыт, папки и записи нет", async () => {
    // источник: чьё: код
    await bench();
    await ask({ type: "machine.login", account: "corp" });
    expect(await ask({ type: "machine.account_remove", account: "corp" })).toMatchObject({ ok: true, result: { wiped: true } });
    expect(st!.sdk.queries.filter((q) => !q.options.spawnClaudeCodeProcess).every((q) => q.closed)).toBe(true);
    expect(existsSync(accDir("corp"))).toBe(false);
    expect((await accounts()).corp).toBeUndefined();
  });

  it("3054 · проверка входа упала — причина в журнале, следующая проверка идёт", async () => {
    // источник: чьё: код
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let n = 0;
    await bench({
      accounts: { corp: {} },
      status: () => {
        if (++n === 1) throw new Error("claude не запустился");
        return { code: 0, out: '{"loggedIn":true}' };
      },
    });
    vi.advanceTimersByTime(CHECK_MS);
    await until(() => st!.journal().some((l) => l.ev === "check" && l.kind === "refuse"));
    vi.advanceTimersByTime(CHECK_MS);
    await until(() => cli.length === 2);
    await waitFor(async () => (await accounts()).corp.checked);
  });

  it("3055 · штатная остановка закрывает процесс входа", async () => {
    // источник: слово пользователя (устав, graceful shutdown: «закрывает соединения … выходит»)
    await bench();
    expect((await ask({ type: "machine.login", account: "corp" })).ok).toBe(true);
    const s = st!;
    st = null;
    const probe = s.sdk.queries.filter((q) => !q.options.spawnClaudeCodeProcess);
    expect(probe).toHaveLength(1);
    expect(probe[0].closed).toBe(false);
    await s.close();
    expect(probe[0].closed).toBe(true);
    expect(s.exits).toEqual([0]);
  });
});

describe("подмена в слоте", () => {
  it("3056 · подмена: окна кандидата — свежие у Claude (только его, старше 2 мин); по ним он у порога — следующий", async () => {
    // источник: дизайн «Пульт и телефон» (подписан 2 нояб.): расход на других машинах видно только у Claude
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { in: "main", limits: { five_hour: { utilization: 0.9, resetsAt: R } } }, y0902: {}, work3: {} },
      slots: { main: ["infirex", "y0902", "work3"] },
      sessions: { "site@laptop": { slot: "main" } },
    });
    // на другой машине y0902 уже выбран до 97 % — видно только у Claude
    usage.y0902 = { five_hour: { utilization: 97, resets_at: new Date((R + 60) * 1000).toISOString() } };
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96, resetsAt: R }));
    await until(() => swaps().length === 1);
    expect(swaps()[0].text).toBe("слот main: infirex → work3 · 5 ч 96 %");
    expect(polled).toEqual(["y0902", "work3"]);
  });

  it("16 · у порога 95 % — одна подмена, обе сессии на y0902 без перезапуска, ledger.add slot.swapped", async () => {
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { in: "main", limits: { five_hour: { utilization: 0.9, resetsAt: R } } }, y0902: { limits: { five_hour: { utilization: 0.04, resetsAt: R + 600 } } }, work3: {} },
      slots: { main: ["infirex", "y0902", "work3"] },
      sessions: { "site@laptop": { slot: "main" }, "wiki@laptop": { slot: "main" } },
    });
    expect(st!.proc("site@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(slotDir("main"));
    for (const cs of ["site@laptop", "wiki@laptop"]) st!.proc(cs).send(msg.state("running"));
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95, resetsAt: R }));
    await until(() => swaps().length === 1);
    expect(places()).toHaveLength(1);
    expect(places()[0]).toMatchObject({ account: "y0902", dir: slotDir("main"), from: "infirex" });
    expect(isLink(slotDir("main"))).toBe(true);
    expect(read(slotDir("main"))).toContain("tok-y0902");
    // входы не двигаются: оба дома
    expect(read(accDir("infirex"))).toContain("tok-infirex");
    expect(read(accDir("y0902"))).toContain("tok-y0902");
    expect(swaps()[0]).toMatchObject({ to: ".ledger", ev: "slot.swapped", machine: "laptop", text: "слот main: infirex → y0902 · 5 ч 95 %" });
    for (const cs of ["site@laptop", "wiki@laptop"]) {
      expect(st!.sdk.of(cs)).toHaveLength(1); // тот же процесс
      expect(st!.proc(cs).interrupts).toBe(0); // ход не оборван
      turn(st!.proc(cs));
      await until(() => last(cs).account === "y0902");
      expect(last(cs).slot).toEqual({ name: "main", wait: null });
    }
    expect((await accounts()).infirex.limits.five_hour.utilization).toBe(0.95);
  });

  it("88 · поздний ответ infirex после подмены: окно infirex записано, слот остаётся на y0902", async () => {
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { limits: { five_hour: { utilization: 0.95, resetsAt: R } } }, y0902: { in: "main", limits: { five_hour: { utilization: 0.05, resetsAt: R + 3600 } } } },
      slots: { main: ["infirex", "y0902"] },
      sessions: { "site@laptop": { slot: "main" }, "wiki@laptop": { slot: "main" } },
    });
    st!.proc("wiki@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96, resetsAt: R }));
    await until(() => st!.journal().some((l) => l.why === "main: поздний ответ infirex"));
    expect((await accounts()).infirex.limits.five_hour.utilization).toBe(0.96);
    expect((await slots()).main.account).toBe("y0902");
    expect(places()).toHaveLength(0);
    expect(swaps()).toHaveLength(0);
  });

  it("89 · все у порога — подмены нет, slot.wait — ближайший сброс, строка журнала", async () => {
    const t = now();
    const Y = t + 1800;
    await bench({
      accounts: {
        y0902: { in: "main", limits: { five_hour: { utilization: 0.96, resetsAt: Y } } },
        infirex: { limits: { five_hour: { utilization: 0.97, resetsAt: t + 12600 } } },
        work3: { limits: { seven_day: { utilization: 0.98, resetsAt: t + 86400 } } },
      },
      slots: { main: ["y0902", "infirex", "work3"] },
      sessions: { "site@laptop": { slot: "main" } },
    });
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.97, resetsAt: Y }));
    await until(() => st!.journal().some((l) => l.ev === "slot.wait" && /все аккаунты у порога — жду сброса/.test(String(l.why))));
    turn(st!.proc("site@laptop"));
    await until(() => (last("site@laptop").slot as { wait?: number } | undefined)?.wait === Y);
    expect(last("site@laptop").account).toBe("y0902");
    expect(places()).toHaveLength(0);
    expect((await slots()).main).toMatchObject({ account: "y0902", wait: Y, sessions: ["site@laptop"] });
  });

  it("166 · claude обновил вход через ссылку слота — новый токен сразу в папке infirex; подмена ничего не переносит", async () => {
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { in: "main", limits: { five_hour: { utilization: 0.5, resetsAt: R } } }, y0902: {} },
      slots: { main: ["infirex", "y0902"] },
      sessions: { "site@laptop": { slot: "main" } },
    });
    // claude пишет вход как в опыте 1 ноя: временный файл рядом и rename — через ссылку слота
    const fresh = '{"claudeAiOauth":{"accessToken":"tok-infirex-refreshed","expiresAt":2}}';
    writeFileSync(join(slotDir("main"), `${CREDENTIALS}.tmp.5d666bc0`), fresh);
    renameSync(join(slotDir("main"), `${CREDENTIALS}.tmp.5d666bc0`), join(slotDir("main"), CREDENTIALS));
    expect(readFileSync(join(accDir("infirex"), CREDENTIALS), "utf8")).toBe(fresh);
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95, resetsAt: R }));
    await until(() => swaps().length === 1);
    expect(readFileSync(join(accDir("infirex"), CREDENTIALS), "utf8")).toBe(fresh);
    expect(read(slotDir("main"))).toContain("tok-y0902");
    expect(isLink(slotDir("main"))).toBe(true);
  });

  it("267 · один аккаунт в двух слотах: порог в main меняет только main; bot — своим событием; y0902 встаёт в оба", async () => {
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { in: ["main", "bot"], limits: { five_hour: { utilization: 0.9, resetsAt: R } } }, y0902: { limits: { five_hour: { utilization: 0.04, resetsAt: R + 600 } } } },
      slots: { main: ["infirex", "y0902"], bot: ["infirex", "y0902"] },
      sessions: { "site@laptop": { slot: "main" }, "poe@laptop": { slot: "bot" } },
    });
    let s = await slots();
    expect([s.main.account, s.bot.account]).toEqual(["infirex", "infirex"]);
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95, resetsAt: R }));
    await until(() => swaps().length === 1);
    s = await slots();
    expect([s.main.account, s.bot.account]).toEqual(["y0902", "infirex"]);
    expect(read(slotDir("bot"))).toContain("tok-infirex");
    st!.proc("poe@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96, resetsAt: R }));
    await until(() => swaps().length === 2);
    expect(swaps().map((x) => x.text)).toEqual(["слот main: infirex → y0902 · 5 ч 95 %", "слот bot: infirex → y0902 · 5 ч 96 %"]);
    expect(read(slotDir("bot"))).toContain("tok-y0902");
  });

  it("167 · отказ модели: подмена сразу, «Продолжай» только оборванной site после result", async () => {
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { in: "main", limits: { five_hour: { utilization: 0.9, resetsAt: R } } }, y0902: { limits: { five_hour: { utilization: 0.04, resetsAt: R } } } },
      slots: { main: ["infirex", "y0902"] },
      sessions: { "site@laptop": { slot: "main" }, "wiki@laptop": { slot: "main" } },
    });
    const p = st!.proc("site@laptop");
    p.send(msg.state("running"));
    p.send({ ...msg.assistant("You've hit your limit"), error: "rate_limit" });
    p.send(limit({ status: "rejected", rateLimitType: "five_hour", resetsAt: R }));
    await until(() => swaps().length === 1);
    expect(swaps()[0].text).toBe("слот main: infirex → y0902 · отказ");
    expect(p.inputs).toHaveLength(0);
    p.send(msg.result({ subtype: "error_during_execution", is_error: true }));
    p.send(msg.state("idle"));
    await until(() => p.inputs.length === 1);
    expect(JSON.stringify(p.inputs[0].message.content)).toContain(CONTINUE);
    expect(st!.proc("wiki@laptop").inputs).toHaveLength(0);
    expect(places()).toHaveLength(1);
  });

  it("167 · отказ: событие лимита, подмена, затем ошибка хода и result — подмена одна, виновник — отказавший (живой прогон 31 окт.)", async () => {
    const R = now() + 3600;
    await bench({
      accounts: {
        infirex: { in: "main", limits: { five_hour: { utilization: 0.9, resetsAt: R } } },
        y0902: { limits: { five_hour: { utilization: 0.04, resetsAt: R + 60 } } },
        work3: { limits: { five_hour: { utilization: 0.5, resetsAt: R + 120 } } },
      },
      slots: { main: ["infirex", "y0902", "work3"] },
      sessions: { "site@laptop": { slot: "main" } },
    });
    const p = st!.proc("site@laptop");
    p.send(msg.state("running"));
    p.send(limit({ status: "rejected", rateLimitType: "five_hour", resetsAt: R }));
    await until(() => swaps().length === 1);
    // ошибка хода и итог приходят уже после подмены на y0902
    p.send({ ...msg.assistant("You've hit your limit"), error: "rate_limit" });
    p.send(msg.result({ subtype: "error_during_execution", is_error: true }));
    p.send(msg.state("idle"));
    await until(() => p.inputs.length === 1);
    expect(swaps().map((x) => x.text)).toEqual(["слот main: infirex → y0902 · отказ"]);
    // roster узнал новый аккаунт сразу после подмены, без нового события сессии
    expect(st!.relay.frames("session.state").some((f) => f.callsign === "site@laptop" && f.account === "y0902")).toBe(true);
    expect(JSON.stringify(p.inputs[0].message.content)).toContain(CONTINUE);
  });

  it("168 · слот ждёт сброса: в час сброса — y0902 в слот, wait снят, «Продолжай» оборванной site", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() });
    const t = now();
    await bench({
      accounts: {
        infirex: { in: "main", limits: { five_hour: { utilization: 1, resetsAt: t + 12600 } } },
        y0902: { limits: { five_hour: { utilization: 0.97, resetsAt: t + 60 } } },
        work3: { limits: { seven_day: { utilization: 0.98, resetsAt: t + 86400 } } },
      },
      slots: { main: ["infirex", "y0902", "work3"] },
      sessions: { "site@laptop": { slot: "main", cut: "infirex" } },
    });
    expect((await slots()).main.wait).toBe(t + 60);
    vi.setSystemTime((t + 61) * 1000);
    vi.advanceTimersByTime(61_000);
    await until(() => st!.journal().some((l) => l.why === "main: сброс y0902 — продолжаю"));
    expect(read(slotDir("main"))).toContain("tok-y0902");
    expect(read(accDir("infirex"))).toContain("tok-infirex");
    await until(() => st!.proc("site@laptop").inputs.length === 1);
    expect(JSON.stringify(st!.proc("site@laptop").inputs[0].message.content)).toContain(CONTINUE);
    expect((await slots()).main.wait).toBeNull();
  });

  it("169 · work3 у недельного порога и corp без входа пропущены — в слот y0902; ниже порога никого — no_reserve", async () => {
    const R = now() + 3600;
    await bench({
      accounts: {
        infirex: { in: "main", limits: { five_hour: { utilization: 0.9, resetsAt: R } } },
        work3: { limits: { seven_day: { utilization: 0.98, resetsAt: R + 86400 } } },
        corp: { login: "none" },
        y0902: { limits: { five_hour: { utilization: 0.1, resetsAt: R } } },
      },
      slots: { main: ["infirex", "work3", "corp", "y0902"] },
      sessions: { "site@laptop": { slot: "main" } },
    });
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96, resetsAt: R }));
    await until(() => swaps().length === 1);
    expect(places().map((l) => l.account)).toEqual(["y0902"]);
    // теперь y0902 у порога, infirex у порога, work3 — недельный, corp не вошёл
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.97, resetsAt: R + 10 }));
    await waitFor(async () => (await accounts()).y0902.limits.five_hour.utilization === 0.97);
    expect(await ask({ type: "slot.swap", slot: "main" })).toMatchObject({ ok: false, error: "no_reserve" });
    expect(read(slotDir("main"))).toContain("tok-y0902");
  });

  it("169 · новый слот: аккаунт уже стоит в main — встаёт и в s2; в порядке нет вошедших — no_reserve, слот не создан (живой прогон 31 окт.)", async () => {
    await bench({ accounts: { infirex: { in: "main" }, corp: { login: "none" } }, slots: { main: ["infirex"] } });
    expect(await ask({ type: "slot.set", slot: "s2", order: ["infirex"] })).toMatchObject({ ok: true, result: { account: "infirex" } });
    expect(read(slotDir("s2"))).toContain("tok-infirex");
    expect(await ask({ type: "slot.set", slot: "s3", order: ["corp"] })).toMatchObject({ ok: false, error: "no_reserve" });
    expect(Object.keys(await slots()).sort()).toEqual(["main", "s2"]);
    expect(existsSync(slotDir("s3"))).toBe(false);
  });

  it("170 · сессия без слота: ключа нет, лимиты не в записи аккаунта; slot.set с default — no_account", async () => {
    await bench({ accounts: { y0902: {} }, slots: {} });
    await st!.open("wiki@laptop");
    expect(st!.proc("wiki@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    st!.proc("wiki@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.99, resetsAt: now() + 99 }));
    turn(st!.proc("wiki@laptop"));
    await until(() => last("wiki@laptop").state === "idle");
    expect((await accounts()).y0902.limits).toEqual({});
    expect(last("wiki@laptop").slot).toBeUndefined();
    expect(await ask({ type: "slot.set", slot: "bot", order: ["default"] })).toMatchObject({ ok: false, error: "no_account" });
    expect(await slots()).toEqual({});
    expect(existsSync(slotDir("bot"))).toBe(false);
  });

  it("slot.set — новый слот берёт первый вошедший; session.slot живой сессии — restart с папкой слота", async () => {
    await bench({ accounts: { corp: { login: "none" }, y0902: {} }, slots: {} });
    // сессия открыта, когда слотов не было: слот появился позже и сам её не меняет
    await st!.open("site@laptop");
    expect((await ask({ type: "slot.set", slot: "bot", order: ["corp", "y0902"] })).result).toEqual({ account: "y0902" });
    expect(read(slotDir("bot"))).toContain("tok-y0902");
    expect(st!.proc("site@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect((await ask({ type: "session.slot", callsign: "site@laptop", slot: "bot" })).result).toEqual({ restart: true });
    await until(() => st!.holders.spawns.filter((x) => x.id === "site@laptop").length === 2 && st!.holders.procs.get("site@laptop")?.initializes === 1);
    expect(st!.proc("site@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(slotDir("bot"));
    expect(st!.query("site@laptop").options.resume).toBeDefined();
    const r = await ask({ type: "session.slot", callsign: "site@laptop", slot: "nope" });
    expect(r.error).toBe("no_slot");
  });

  it("slot.set с пустым порядком: есть сессии — has_sessions; без сессий — ссылка снята, вход дома, слот удалён", async () => {
    await bench({ accounts: { y0902: { in: "bot" } }, slots: { bot: ["y0902"] }, sessions: { "site@laptop": { slot: "bot" } } });
    expect(await ask({ type: "slot.set", slot: "bot", order: [] })).toMatchObject({ ok: false, error: "has_sessions" });
    await st!.session("probe", "site@laptop")!.remove();
    expect((await ask({ type: "slot.set", slot: "bot", order: [] })).result).toEqual({ account: null });
    expect(read(accDir("y0902"))).toContain("tok-y0902");
    expect(existsSync(slotDir("bot"))).toBe(false);
    expect(await slots()).toEqual({});
  });

  it("slot.swap «Сменить сейчас» — by в журнале флота; no_slot у незнакомого слота", async () => {
    await bench({ accounts: { infirex: { in: "main" }, y0902: {}, work3: {} }, slots: { main: ["infirex", "y0902", "work3"] } });
    expect((await ask({ type: "slot.swap", slot: "main", account: "work3" })).result).toEqual({ from: "infirex", to: "work3" });
    expect(swaps()[0]).toMatchObject({ by: "panel-desk~owner@example.com", text: "слот main: infirex → work3 · вручную" });
    expect((await ask({ type: "slot.swap", slot: "x" })).error).toBe("no_slot");
  });

  it("запасной без файла входа — слот прежний, строка журнала со словом", async () => {
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { in: "main", limits: { five_hour: { utilization: 0.9, resetsAt: R } } }, y0902: {} },
      slots: { main: ["infirex", "y0902"] },
      sessions: { "site@laptop": { slot: "main" } },
    });
    unlinkSync(join(accDir("y0902"), CREDENTIALS));
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96, resetsAt: R }));
    await until(() => st!.journal().some((l) => l.ev === "slot.swap" && l.word === "not_logged_in"));
    expect(read(slotDir("main"))).toContain("tok-infirex");
    expect(swaps()).toHaveLength(0);
  });

  it("3037 · slot.set: новый порядок у слота с аккаунтом — ссылка та же; отказы bad_frame и no_slot", async () => {
    // источник: чьё: код
    await bench({ accounts: { infirex: { in: "main" }, y0902: {} }, slots: { main: ["infirex", "y0902"] } });
    expect(await ask({ type: "slot.set", slot: "main", order: ["y0902", "infirex"] })).toMatchObject({ ok: true, result: { account: "infirex" } });
    expect((await slots()).main).toMatchObject({ account: "infirex", order: ["y0902", "infirex"] });
    expect(places()).toHaveLength(0);
    expect(await ask({ type: "slot.set", slot: "a b", order: ["y0902"] })).toMatchObject({ ok: false, error: "bad_frame" });
    expect(await ask({ type: "slot.set", slot: "nope", order: [] })).toMatchObject({ ok: false, error: "no_slot" });
  });

  it("3040 · slot.swap на названный аккаунт — «Продолжай» оборванной", async () => {
    // источник: чьё: код
    await bench({ accounts: { infirex: { in: "main" }, y0902: {} }, slots: { main: ["infirex", "y0902"] }, sessions: { "site@laptop": { slot: "main", cut: "infirex" } } });
    expect(await ask({ type: "slot.swap", slot: "main", account: "y0902" })).toMatchObject({ ok: true, result: { from: "infirex", to: "y0902" } });
    await until(() => st!.proc("site@laptop").inputs.length === 1);
    expect(JSON.stringify(st!.proc("site@laptop").inputs[0].message.content)).toContain(CONTINUE);
  });

  it("3041 · slot.swap: no_account, no_reserve — словом", async () => {
    // источник: чьё: код
    const R = now() + 3600;
    await bench({ accounts: { infirex: { in: "main" }, y0902: { limits: { five_hour: { utilization: 0.99, resetsAt: R } } }, work3: {} }, slots: { main: ["infirex", "y0902"], bot: ["work3"] } });
    expect(await ask({ type: "slot.swap", slot: "main", account: "nope" })).toMatchObject({ ok: false, error: "no_account" });
    expect(await ask({ type: "slot.swap", slot: "main" })).toMatchObject({ ok: false, error: "no_reserve" });
  });

  it("3042 · журнал флота не отвечает — подмена прошла, причина в журнале Host", async () => {
    // источник: чьё: код
    const R = now() + 3600;
    await bench({ accounts: { infirex: { in: "main", limits: { five_hour: { utilization: 0.9, resetsAt: R } } }, y0902: {} }, slots: { main: ["infirex", "y0902"] }, sessions: { "site@laptop": { slot: "main" } } });
    st!.relay.workersDown = true;
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96, resetsAt: R }));
    await until(() => st!.journal().some((l) => l.ev === "ledger.add" && l.word === "offline"));
    expect(read(slotDir("main"))).toContain("tok-y0902");
  });

  it("3043 · session.slot: тот же слот и остановленная — без restart; null — слот снят, restart; без поля — bad_frame", async () => {
    // источник: чьё: код; дизайн «Предел чтений и слоты»: поле обязательно
    await bench({ accounts: { infirex: { in: "main" } }, slots: { main: ["infirex"] }, sessions: { "site@laptop": { slot: "main" }, "wiki@laptop": { slot: null } } });
    expect(await ask({ type: "session.slot", callsign: "site@laptop", slot: "main" })).toMatchObject({ ok: true, result: { restart: false } });
    expect(st!.sdk.of("site@laptop")).toHaveLength(1);
    await st!.session("probe", "wiki@laptop")!.stop();
    expect(await ask({ type: "session.slot", callsign: "wiki@laptop", slot: "main" })).toMatchObject({ ok: true, result: { restart: false } });
    expect(await ask({ type: "session.slot", callsign: "site@laptop" })).toMatchObject({ ok: false, error: "bad_frame" });
    expect(await ask({ type: "session.slot", callsign: "site@laptop", slot: null })).toMatchObject({ ok: true, result: { restart: true } });
    await until(() => st!.holders.spawns.filter((x) => x.id === "site@laptop").length === 2 && st!.holders.procs.get("site@laptop")?.initializes === 1);
    expect(st!.proc("site@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  });

  it("3045 · ниже порога — окно записано, подмены нет; неделя: 97 % — нет, 98 % — подмена", async () => {
    // источник: чьё: код
    const R = now() + 3600;
    await bench({ accounts: { infirex: { in: "main" }, y0902: {} }, slots: { main: ["infirex", "y0902"] }, sessions: { "site@laptop": { slot: "main" } } });
    const p = st!.proc("site@laptop");
    p.send(limit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: R }));
    await waitFor(async () => (await accounts()).infirex.limits.five_hour?.utilization === 0.5);
    p.send(limit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.97, resetsAt: R + 86400 }));
    await waitFor(async () => (await accounts()).infirex.limits.seven_day?.utilization === 0.97);
    expect(places()).toHaveLength(0);
    p.send(limit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.98, resetsAt: R + 86400 }));
    await until(() => swaps().length === 1);
    expect(swaps()[0].text).toBe("слот main: infirex → y0902 · нед. 98 %");
  });

  it("3046 · отказ без события лимита — подмена на result, «Продолжай» после", async () => {
    // источник: чьё: код
    await bench({ accounts: { infirex: { in: "main" }, y0902: {} }, slots: { main: ["infirex", "y0902"] }, sessions: { "site@laptop": { slot: "main" } } });
    const p = st!.proc("site@laptop");
    p.send(msg.state("running"));
    p.send({ ...msg.assistant("limit hit"), error: "rate_limit" });
    await new Promise((r) => setTimeout(r, 20));
    expect(swaps()).toHaveLength(0);
    p.send(msg.result({ subtype: "error_during_execution", is_error: true }));
    await until(() => swaps().length === 1);
    expect(swaps()[0].text).toBe("слот main: infirex → y0902 · отказ");
    p.send(msg.state("idle"));
    await until(() => p.inputs.length === 1);
    expect(JSON.stringify(p.inputs[0].message.content)).toContain(CONTINUE);
  });

  it("3047 · сброс своего аккаунта — без подмены, «Продолжай»", async () => {
    // источник: чьё: код
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() });
    const t = now();
    await bench({
      accounts: { infirex: { in: "main", limits: { five_hour: { utilization: 1, resetsAt: t + 60 } } }, y0902: { limits: { five_hour: { utilization: 0.99, resetsAt: t + 3600 } } } },
      slots: { main: ["infirex", "y0902"] },
      sessions: { "site@laptop": { slot: "main", cut: "infirex" } },
    });
    vi.setSystemTime((t + 61) * 1000);
    vi.advanceTimersByTime(61_000);
    await until(() => st!.journal().some((l) => l.why === "main: сброс infirex — продолжаю"));
    expect(places()).toHaveLength(0);
    await until(() => st!.proc("site@laptop").inputs.length === 1);
    expect(JSON.stringify(st!.proc("site@laptop").inputs[0].message.content)).toContain(CONTINUE);
  });

  it("3048 · запас пуст — idle без «Продолжай», слот ждёт сброса", async () => {
    // источник: чьё: код
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { in: "main", limits: { five_hour: { utilization: 1, resetsAt: R } } }, y0902: { limits: { five_hour: { utilization: 0.99, resetsAt: R } } } },
      slots: { main: ["infirex", "y0902"] },
      sessions: { "site@laptop": { slot: "main", cut: "infirex" } },
    });
    const p = st!.proc("site@laptop");
    p.send(msg.state("running"));
    p.send(msg.result({ subtype: "error_during_execution", is_error: true }));
    p.send(msg.state("idle"));
    await until(() => st!.states("site@laptop").some((f) => f.state === "busy") && st!.kernel.sessions.get("site@laptop")!.state === "idle");
    await new Promise((r) => setTimeout(r, 30));
    expect(p.inputs).toHaveLength(0);
    expect(last("site@laptop").slot).toMatchObject({ name: "main", wait: R });
  });
});

describe("эталоны дизайна «Предел чтений и слоты»", () => {
  it("E8 · 0 слотов, не сказано — сессия на общем входе, ключа папки входа нет", async () => {
    // источник: чьё: код
    await bench({ accounts: { y0902: {} } });
    await opening("wiki");
    expect(st!.proc("wiki@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    expect(raw().sessions["wiki@laptop"]).toEqual({ slot: null });
    expect(await slots()).toEqual({});
  });

  // Статус общего входа — окружение без папки аккаунта.
  const noShared = (env: Record<string, string | undefined>) => (env.CLAUDE_CONFIG_DIR ? { code: 0, out: JSON.stringify({ loggedIn: true }) } : { code: 1, out: JSON.stringify({ loggedIn: false }) });

  it("7360 · новая машина: вход есть, слота и общего входа нет — слот main из вошедших, ключ есть при первом запуске", async () => {
    // источник: факт, журнал hz-ex44-win-1 4 нояб.: вход 07:07:24, открытие 07:07:46 — «Not logged in»
    await bench({ accounts: { mypoelife: {}, spare: {}, gone: { login: "none" } }, status: noShared });
    await opening("win1");
    expect(st!.proc("win1@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(slotDir("main"));
    expect(read(slotDir("main"))).toContain("tok-mypoelife");
    expect((await slots()).main).toMatchObject({ account: "mypoelife", order: ["mypoelife", "spare"], sessions: ["win1@laptop"] });
    expect(raw().sessions["win1@laptop"]).toEqual({ slot: "main" });
    await opening("win2");
    expect(st!.proc("win2@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(slotDir("main"));
    expect(places()).toHaveLength(1);
  });

  it("7361 · новая машина без единого входа — not_logged_in до запуска: нет процесса, папки и записи сессии", async () => {
    // источник: живое воспроизведение 4 нояб. на машине probe, Host 1.3.3+1: сессия открылась и ответила «Not logged in»
    await bench({ status: noShared });
    const e = await refused(opening("job"));
    expect(e?.word).toBe("not_logged_in");
    expect(e?.why).toContain("laptop");
    expect(existsSync(join(home, "work", "job"))).toBe(false);
    expect(raw().sessions["job@laptop"]).toBeUndefined();
    expect(await slots()).toEqual({});
  });

  it("E9 · 1 слот, не сказано — сессия в слоте, ключ есть уже при первом запуске, в списке виден аккаунт", async () => {
    // источник: слово пользователя 4 нояб.
    await bench({ accounts: { mypoelife: { in: "main" } }, slots: { main: ["mypoelife"] } });
    await opening("win1");
    expect(st!.proc("win1@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(slotDir("main"));
    await until(() => last("win1@laptop").account === "mypoelife");
    expect(last("win1@laptop").slot).toEqual({ name: "main", wait: null });
  });

  it("E10 · 2 слота, не сказано — slot_required со списком, нет процесса, новой папки, записи сессии и её разделов", async () => {
    // источник: слово пользователя 4 нояб.
    const R = now() + 3600;
    await bench({
      accounts: { a: { in: "main", limits: { five_hour: { utilization: 0.99, resetsAt: R } } }, b: { in: "bot" } },
      slots: { main: ["a"], bot: ["b"] },
    });
    const e = await refused(opening("job"));
    expect(e?.word).toBe("slot_required");
    expect(e?.why).toMatch(/^Слоты машины: main \(ждёт сброса \d\d:\d\d\), bot$/);
    expect(st!.sdk.of("job@laptop")).toHaveLength(0);
    expect(existsSync(join(home, "work", "job"))).toBe(false);
    expect(raw().sessions["job@laptop"]).toBeUndefined();
    // следующее открытие того же имени не берёт ничего от несостоявшегося
    await opening("job", { slot: "bot" });
    expect(st!.proc("job@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(slotDir("bot"));
  });

  it("E12 · назван несуществующий слот — no_slot, слоты машины в причине; не строка — bad_frame", async () => {
    // источник: чьё: код
    await bench({ accounts: { a: { in: "main" } }, slots: { main: ["a"] } });
    const e = await refused(opening("job", { slot: "night" }));
    expect(e?.word).toBe("no_slot");
    expect(e?.why).toContain("Слоты машины: main");
    expect((await refused(opening("job", { slot: null })))?.word).toBe("bad_frame");
    expect(st!.sdk.of("job@laptop")).toHaveLength(0);
  });

  it("E18 · 3 аккаунта опрашиваются разом: все начаты до конца первого, ответ — после самого долгого", async () => {
    // источник: факт: замер 4,9 с, опрос в коде шёл по очереди
    const go: Array<() => void> = [];
    await bench({
      accounts: { a: {}, b: {}, c: {} },
      poll: () => new Promise((ok) => go.push(() => ok({ rate_limits: null }))),
    });
    const p = ask({ type: "machine.accounts", max_age: 60 });
    await until(() => polled.length === 3);
    expect([...polled].sort()).toEqual(["a", "b", "c"]);
    go.forEach((f) => f());
    expect((await p).ok).toBe(true);
    expect(probes).toHaveLength(3);
  });

  it("E23 · подмена: запасной аккаунт только что вошёл — слот переходит на него", async () => {
    // источник: факт: копия записей отставала от входа
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { in: "main", limits: { five_hour: { utilization: 0.9, resetsAt: R } } }, corp: { login: "none" } },
      slots: { main: ["infirex", "corp"] },
      sessions: { "site@laptop": { slot: "main" } },
    });
    await ask({ type: "machine.login", account: "corp" });
    await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" });
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96, resetsAt: R }));
    await until(() => swaps().length === 1);
    expect(read(slotDir("main"))).toContain("tok-corp");
  });

  it("E28 · удаление аккаунта в двух слотах одним запросом: слоты сменили аккаунт, порядок без него, папка стёрта", async () => {
    // источник: чьё: код, те же шаги шли со страницы; слово пользователя 4 нояб.: одним запросом
    await bench({
      accounts: { x: { in: ["main", "bot"] }, y: {}, z: {} },
      slots: { main: ["x", "y", "z"], bot: ["x", "z"] },
      sessions: { "site@laptop": { slot: "main", cut: "x" } },
    });
    const r = await ask({ type: "machine.account_remove", account: "x", next: "z" });
    expect(r).toMatchObject({ ok: true, result: { wiped: true } });
    const s = await slots();
    expect(s.main).toMatchObject({ account: "z", order: ["y", "z"] });
    expect(s.bot).toMatchObject({ account: "z", order: ["z"] });
    expect(existsSync(accDir("x"))).toBe(false);
    expect((await accounts()).x).toBeUndefined();
    expect(swaps().map((f) => f.text)).toEqual(["слот main: x → z · удаление аккаунта", "слот bot: x → z · удаление аккаунта"]);
    await until(() => st!.proc("site@laptop").inputs.length === 1);
  });

  it("E28 · запаса нет у второго слота — no_reserve с именем слота, первый слот не тронут, папка цела", async () => {
    // источник: дизайн: ничего не тронуто
    await bench({ accounts: { x: { in: ["main", "bot"] }, y: {} }, slots: { main: ["x", "y"], bot: ["x"] } });
    const r = await ask({ type: "machine.account_remove", account: "x" });
    expect(r).toMatchObject({ ok: false, error: "no_reserve" });
    expect(r.why).toContain("bot");
    expect((await slots()).main).toMatchObject({ account: "x", order: ["x", "y"] });
    expect(places()).toHaveLength(0);
    expect(read(accDir("x"))).toContain("tok-x");
  });

  it.runIf(process.platform === "win32")("E28 · папка занята — отказ словом, модуль жив, запись на месте, повтор дочищает", async () => {
    // источник: замер на Windows 11: rmSync при процессе с рабочей папкой внутри — EPERM
    await bench({ accounts: { x: {}, y: {} } });
    // процесс сам говорит, что живёт в папке: под нагрузкой событие spawn приходит раньше
    const inside = spawn(process.execPath, ["-e", "console.log(1);setTimeout(()=>{},30000)"], { cwd: accDir("x"), stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((ok) => inside.stdout!.once("data", ok));
    const r = await ask({ type: "machine.account_remove", account: "x" });
    inside.kill();
    await new Promise((ok) => inside.once("exit", ok));
    expect(r).toMatchObject({ ok: false, error: "account_dir_busy" });
    expect((await accounts()).x).toBeDefined();
    expect(await ask({ type: "machine.account_remove", account: "x" })).toMatchObject({ ok: true, result: { wiped: true } });
    expect((await accounts()).x).toBeUndefined();
  });

  it("E29 · опрос окон молчит: на POLL_MS процесс закрыт, ответ с прежними окнами и слотами, причина в журнале", async () => {
    // источник: слово пользователя 2 нояб.: у всех операций лимит. Настоящий read страницы — эталон связи.
    const t = now();
    await bench({
      accounts: { y: { in: "main", limits: { five_hour: { utilization: 0.5, resetsAt: t + 900, at: t - 600, src: "poll" } } } },
      slots: { main: ["y"] },
      poll: () => new Promise(() => {}),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = st!.host("probe").request("machine.accounts", { v: 1, max_age: 60 });
    await vi.advanceTimersByTimeAsync(POLL_MS + 1);
    vi.useRealTimers();
    const r = (await p) as { ok: boolean; result: any };
    expect(POLL_MS).toBe(8_000);
    expect(r.ok).toBe(true);
    expect(r.result.accounts.y.limits.five_hour.utilization).toBe(0.5);
    expect(r.result.slots.main.account).toBe("y");
    expect(st!.sdk.queries.filter((q) => !q.options.spawnClaudeCodeProcess).every((q) => q.closed)).toBe(true);
    expect(st!.journal().some((l) => l.ev === "poll" && l.kind === "refuse")).toBe(true);
  });

  it("E30 · machine.accounts без просьбы о свежести — 0 запусков claude, слоты в ответе", async () => {
    // источник: чьё: код
    await bench({ accounts: { y: { in: "main" } }, slots: { main: ["y"] } });
    const r = await ask({ type: "machine.accounts" });
    expect(probes).toHaveLength(0);
    expect(cli).toHaveLength(0);
    expect(r.result.slots).toEqual({ main: { account: "y", order: ["y"], wait: null, sessions: [] } });
  });

  it("E34 · папка аккаунта удалена — в слоте никого, модуль жив; открытие — not_logged_in; смена аккаунта чинит слот", async () => {
    // источник: замер на Windows 11: readlink битой ссылки отдаёт прежний путь, existsSync — нет
    await bench({ accounts: { x: { in: "main" }, y: {} }, slots: { main: ["x", "y"] } });
    rmSync(accDir("x"), { recursive: true, force: true });
    expect((await slots()).main.account).toBeNull();
    const e = await refused(opening("job"));
    expect(e?.word).toBe("not_logged_in");
    expect(e?.why).toContain("main");
    expect(await ask({ type: "slot.swap", slot: "main", account: "y" })).toMatchObject({ ok: true, result: { from: null, to: "y" } });
    expect(read(slotDir("main"))).toContain("tok-y");
    expect((await slots()).main.account).toBe("y");
  });

  it("E34 · на месте ссылки обычная папка; ссылки нет — в слоте никого, чтение не падает", async () => {
    // источник: замер на Windows 11: readlink обычной папки — EINVAL, пустого места — ENOENT
    await bench({ accounts: { x: {} }, slots: { dir: ["x"], gone: ["x"] } });
    mkdirSync(slotDir("dir"), { recursive: true });
    writeFileSync(join(slotDir("dir"), "f"), "x");
    const s = await slots();
    expect([s.dir.account, s.gone.account]).toEqual([null, null]);
    // модуль жив: следующий запрос обслуживается
    expect((await ask({ type: "machine.accounts" })).ok).toBe(true);
  });

  it("E36 · удаление аккаунта идёт, в другом слоте сработал лимит — удаляемый аккаунт не становится запасным", async () => {
    // источник: чьё: код, проверка заменяет прежний отказ in_slot
    const R = now() + 3600;
    await bench({
      accounts: { x: { in: "main" }, y: {}, c: { in: "bot", limits: { five_hour: { utilization: 0.9, resetsAt: R } } } },
      slots: { main: ["x", "y"], bot: ["c", "x"] },
      sessions: { "poe@laptop": { slot: "bot" } },
    });
    // удаление ждёт блокировку входа x; подмена в bot встаёт в ту же очередь
    mkdirSync(join(accDir("x"), REFRESH_LOCK));
    const p = ask({ type: "machine.account_remove", account: "x" });
    await new Promise((r) => setTimeout(r, 50));
    st!.proc("poe@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96, resetsAt: R }));
    await new Promise((r) => setTimeout(r, 200));
    expect(places().filter((l) => l.dir === slotDir("bot"))).toHaveLength(0);
    rmdirSync(join(accDir("x"), REFRESH_LOCK));
    expect(await p).toMatchObject({ ok: true, result: { wiped: true } });
    await until(() => st!.journal().some((l) => l.ev === "account_remove"));
    await new Promise((r) => setTimeout(r, 50));
    expect((await slots()).bot.account).toBe("c");
    expect(places().some((l) => l.account === "x")).toBe(false);
  });

  it("E37 · проверка входа и вызов входа молчат: отказ на своём пределе, процесс закрыт, следующая проверка идёт", async () => {
    // источник: слово пользователя 2 нояб.: у всех операций лимит
    let hang = true;
    await bench({
      accounts: { corp: {} },
      status: () => (hang ? new Promise(() => {}) : { code: 0, out: '{"loggedIn":true}' }),
    });
    const orig = st!.sdk.query;
    st!.sdk.query = (p) => {
      const q = orig(p) as unknown as Record<string, unknown>;
      q.claudeAuthenticate = () => new Promise(() => {});
      return q as never;
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const login = st!.relay.request({ v: 1, machine: "laptop", type: "machine.login", account: "corp2" } as Frame);
    await vi.advanceTimersByTimeAsync(LOGIN_MS + 1);
    expect(await login).toMatchObject({ ok: false, error: "login_failed" });
    vi.useRealTimers();
    expect(st!.sdk.queries.filter((q) => !q.options.spawnClaudeCodeProcess).every((q) => q.closed)).toBe(true);
    await st!.close();
    st = null;
    // проверка входа: таймер модуля должен встать на поддельные часы — новый стенд
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await bench({ accounts: { corp: {} }, status: () => (hang ? new Promise(() => {}) : { code: 0, out: '{"loggedIn":true}' }) });
    await vi.advanceTimersByTimeAsync(CHECK_MS + STATUS_MS + 1);
    expect(st!.journal().some((l) => l.ev === "check" && l.kind === "refuse" && /auth status не ответил/.test(String(l.why)))).toBe(true);
    hang = false;
    const n = cli.length;
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(cli.length).toBeGreaterThan(n);
  });

  it("E37 · при остановке новых опросов и подмен нет; идущий опрос закрыт", async () => {
    // источник: устав: по сигналу не принимает новое; находка архитектора
    const R = now() + 3600;
    await bench({
      accounts: { x: { in: "main", limits: { five_hour: { utilization: 0.9, resetsAt: R } } }, y: {} },
      slots: { main: ["x", "y"] },
      sessions: { "site@laptop": { slot: "main" } },
      poll: () => new Promise(() => {}),
    });
    void st!.relay.request({ v: 1, machine: "laptop", type: "machine.accounts", max_age: 60 } as Frame);
    await until(() => polled.length === 1);
    const s = st!;
    st = null;
    await s.close();
    expect(s.sdk.queries.filter((q) => !q.options.spawnClaudeCodeProcess).every((q) => q.closed)).toBe(true);
    expect(s.exits).toEqual([0]);
  }, 15_000);
});

describe("видимое: причины словами", () => {
  it("отказы называют причину", async () => {
    mkdirSync(slotDir("busy"), { recursive: true });
    writeFileSync(join(slotDir("busy"), "keep.txt"), "x");
    await bench({ accounts: { y: {}, none: { login: "none" }, bare: { bare: true } }, sessions: { "site@laptop": { slot: null } } });
    const why = async (f: Record<string, unknown>) => {
      const r = await ask(f);
      return `${r.error}: ${r.why}`;
    };
    expect(await why({ type: "slot.set", slot: "busy", order: ["y"] })).toBe(`slot_dir_busy: busy: y не встал в слот — ${slotDir("busy")}: на месте ссылки слота папка с файлами`);
    expect(await why({ type: "slot.set", slot: "bad", order: ["none"] })).toBe("no_reserve: bad: в порядке нет вошедшего аккаунта");
    expect(await why({ type: "slot.set", slot: "bad", order: ["ghost"] })).toBe("no_account: ghost: такого аккаунта на машине нет");
    expect(await why({ type: "slot.set", slot: "a b", order: ["y"] })).toBe("bad_frame: имя слота — латиница, цифры, - и _");
    expect(await why({ type: "slot.set", slot: "bad", order: ["bare"] })).toBe("not_logged_in: bad: bare не встал в слот — bare: входа нет");
    expect(await why({ type: "slot.swap", slot: "x" })).toBe("no_slot: слота x нет. На машине нет слотов");
    expect(await why({ type: "machine.login", account: "a b" })).toBe("bad_frame: имя аккаунта — латиница, цифры, - и _");
    expect(await why({ type: "machine.login_code", account: "z", code: "c" })).toBe("not_started: z: входа нет — Host перезапускался, вход начат заново или срок вышел");
    expect(await why({ type: "machine.account_remove", account: "ghost" })).toBe("no_account: аккаунта ghost на машине нет");
    expect(await why({ type: "session.slot", callsign: "site@laptop" })).toBe("bad_frame: session.slot: нужно поле slot — имя слота или null");
    expect((await refused(opening("job", { slot: 5 })))?.why).toBe("session.open: slot — имя слота");
  });

  it("вход и запас: причина отказа и строка журнала", async () => {
    const R = now() + 3600;
    await bench({ accounts: { x: { in: "main", limits: { five_hour: { utilization: 0.99, resetsAt: R } } } }, slots: { main: ["x"] } });
    expect((await ask({ type: "slot.swap", slot: "main" })).why).toBe("main: в запасе нет вошедшего аккаунта ниже порога");
    await ask({ type: "machine.login", account: "corp" });
    expect(st!.journal().some((l) => l.ev === "login" && l.why === "corp: вход начат")).toBe(true);
    const bad = await ask({ type: "machine.login_code", account: "corp", code: "WRONG#Qm9vY" });
    expect(bad.why).toBe("corp: claude не принял код — Request failed with status code 400");
  });

  it("новая машина: причина not_logged_in и строка журнала о слоте main", async () => {
    const shared = (env: Record<string, string | undefined>) => (env.CLAUDE_CONFIG_DIR ? { code: 0, out: '{"loggedIn":true}' } : { code: 1, out: '{"loggedIn":false}' });
    await bench({ status: shared });
    expect((await refused(opening("job")))?.why).toBe("на laptop нет входа Claude: войдите в аккаунт на этой машине");
    await st!.close();
    await bench({ accounts: { a: {} }, status: shared });
    await opening("job");
    expect(st!.journal().some((l) => l.ev === "slot.set" && l.why === "main: общего входа нет, слот из вошедших аккаунтов")).toBe(true);
  });

  it("журнал: вход пропал — login_lost; поздний ответ — late; сброс — slot.reset; опрос и ledger — причина", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { limits: { five_hour: { utilization: 0.95, resetsAt: R } } }, y: { in: "main", limits: { five_hour: { utilization: 0.05, resetsAt: R + 60 } } } },
      slots: { main: ["infirex", "y"] },
      sessions: { "site@laptop": { slot: "main" } },
      status: () => ({ code: 1, out: '{"loggedIn":false}' }),
      poll: () => {
        throw new Error("нет сети");
      },
    });
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96, resetsAt: R }));
    await until(() => st!.journal().some((l) => l.ev === "late" && l.callsign === "site@laptop"));
    vi.advanceTimersByTime(CHECK_MS);
    await until(() => st!.journal().some((l) => l.ev === "login_lost" && l.kind === "stop" && l.why === "y: вход пропал"));
    vi.useRealTimers();
    await ask({ type: "machine.accounts", max_age: 0 });
  });

  it("опрос не ответил: журнал называет аккаунт", async () => {
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { in: "main", limits: { five_hour: { utilization: 0.9, resetsAt: R } } }, y: {} },
      slots: { main: ["infirex", "y"] },
      sessions: { "site@laptop": { slot: "main" } },
      poll: () => {
        throw new Error("нет сети");
      },
    });
    await ask({ type: "machine.accounts", max_age: 0 });
    expect(st!.journal().some((l) => l.ev === "poll" && l.kind === "refuse" && l.why === "infirex: опрос лимитов — нет сети")).toBe(true);
  });

  it("срок входа и молчание claude: причины называют предел", async () => {
    await bench({ accounts: { corp2: {} } });
    const orig = st!.sdk.query;
    st!.sdk.query = (p) => {
      const q = orig(p) as unknown as Record<string, unknown>;
      q.claudeAuthenticate = () => new Promise(() => {});
      return q as never;
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const late = st!.relay.request({ v: 1, machine: "laptop", type: "machine.login", account: "x" } as Frame);
    await vi.advanceTimersByTimeAsync(LOGIN_MS + 1);
    expect(await late).toMatchObject({ error: "login_failed", why: `x: claudeAuthenticate — не ответил за ${LOGIN_MS / 1000} с` });
    st!.sdk.query = orig;
    await bench({});
    await ask({ type: "machine.login", account: "corp" });
    await vi.advanceTimersByTimeAsync(LOGIN_WAIT_MS);
    vi.useRealTimers();
    expect(st!.journal().some((l) => l.ev === "login" && l.kind === "refuse" && l.why === "corp: срок входа вышел — кода нет за 30 мин")).toBe(true);
  });
});

describe("разбор спорного: вход пропал", () => {
  it("аккаунт в слоте без входа: открытие и перевод — not_logged_in до запуска; вход вернулся — идёт", async () => {
    // источник: факт — настоящий SDK на папке без входа отвечает «Not logged in · Please run /login»; бэклог 4 нояб.
    await bench({ accounts: { x: { in: "main", login: "none" } }, slots: { main: ["x"] }, sessions: { "site@laptop": { slot: null } } });
    const e = await refused(opening("job"));
    expect(e?.word).toBe("not_logged_in");
    expect(e?.why).toBe("в слоте main x без входа");
    expect(st!.sdk.of("job@laptop")).toHaveLength(0);
    expect(await ask({ type: "session.slot", callsign: "site@laptop", slot: "main" })).toMatchObject({ ok: false, error: "not_logged_in" });
    await ask({ type: "machine.login", account: "x" });
    await ask({ type: "machine.login_code", account: "x", code: "Xk2pL#Qm9vY" });
    await opening("job");
    expect(st!.proc("job@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(slotDir("main"));
  });
});

describe("сверка строк: чего леса не держали", () => {
  it("новый слот: строка журнала флота и журнала машины", async () => {
    await bench({ accounts: { y0902: {} } });
    expect((await ask({ type: "slot.set", slot: "bot", order: ["y0902"] })).ok).toBe(true);
    expect(swaps().map((x) => x.text)).toEqual(["слот bot: — → y0902 · новый слот"]);
    expect(places()[0]).toMatchObject({ account: "y0902", from: null });
  });

  it("accountInfo упал после принятого кода: вход состоялся, причина в журнале", async () => {
    await bench();
    await ask({ type: "machine.login", account: "corp" });
    const q = st!.sdk.queries.find((x) => !x.options.spawnClaudeCodeProcess) as unknown as Record<string, unknown>;
    q.claudeOAuthCallback = async () => {
      cred(accDir("corp"), "corp");
      return {};
    };
    q.accountInfo = async () => {
      throw new Error("нет сети");
    };
    expect((await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" })).ok).toBe(true);
    expect((await accounts()).corp.login).toBe("ok");
    expect(st!.journal().some((l) => l.ev === "login" && l.why === "corp: accountInfo — нет сети")).toBe(true);
  });
});
