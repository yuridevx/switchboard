// Эталоны и стыки модуля accounts на стенде Host: поддельные SDK, relay, keeper и часы;
// короткий claude и claude auth status — поддельные, отвечают по своему окружению. Номер эталона — номер теста.
// Всё во временных папках: SWITCHBOARD_HOME и папка пользователя (HOME/USERPROFILE) — свои на каждый тест.
// Ссылки слотов — настоящие: junction на Windows, symlink на Linux.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { CHECK_MS, CREDENTIALS, LOCK_WAIT_MS, REFRESH_LOCK, linkSlot, make } from "../src/accounts.ts";
import type { Accounts } from "../src/accounts.ts";

const { module, standHost, until } = stand;
type Stand = stand.Stand;
const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

let st: Stand | null = null;
let home = "";
let user = "";
const saved = { ...process.env };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sb-accounts-"));
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

type ProbeLog = { env: Record<string, string | undefined>; calls: Array<{ name: string; args: unknown[] }> };

/** Стенд с настоящим accounts. */
async function bench(o: {
  accounts?: Accounts | Record<string, unknown>;
  status?: (env: Record<string, string | undefined>) => { code: number; out: string };
  usage?: (env: Record<string, string | undefined>) => unknown;
} = {}) {
  if (o.accounts) {
    mkdirSync(join(home, "store"), { recursive: true });
    writeFileSync(join(home, "store", "host-accounts.json"), JSON.stringify({ machine: o.accounts }));
  }
  st = await standHost({
    home,
    modules: [{ manifest: manifest as Manifest, module: make() }, module("host-slots", {}, { uses: { "account.place@host-accounts": 2, "account.usage@host-accounts": 1 } })],
  });
  const probes: ProbeLog[] = [];
  const cli: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
  const orig = st.sdk.query;
  st.sdk.query = (p) => {
    const q = orig(p) as unknown as Record<string, unknown>;
    const env = (p.options?.env ?? {}) as Record<string, string | undefined>;
    if (p.options?.spawnClaudeCodeProcess) return q as never;
    const log: ProbeLog = { env, calls: [] };
    probes.push(log);
    const rec = (name: string, fn: (...a: unknown[]) => unknown) => (q[name] = async (...a: unknown[]) => (log.calls.push({ name, args: a }), fn(...a)));
    rec("claudeAuthenticate", () => ({ manualUrl: "https://claude.ai/oauth/authorize?code=true&state=Qm9vY", automaticUrl: "http://localhost:5555/callback" }));
    rec("claudeOAuthCallback", (code) => {
      if (code !== "Xk2pL") throw new Error("Request failed with status code 400");
      // claude кладёт вход и почту в свою папку
      const dir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR!;
      writeFileSync(join(dir, CREDENTIALS), JSON.stringify({ claudeAiOauth: { accessToken: "tok-corp" } }));
      writeFileSync(join(env.CLAUDE_CONFIG_DIR!, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "corp@x" } }));
      return { account: { email: "corp@x", subscriptionType: "max" } };
    });
    rec("accountInfo", () => ({ email: "corp@x", subscriptionType: "max" }));
    rec(USAGE, () => o.usage?.(env) ?? { rate_limits: null });
    return q as never;
  };
  st.sdk.cli = async (args, env) => {
    cli.push({ args, env });
    return o.status?.(env) ?? { code: 0, out: JSON.stringify({ loggedIn: true }) };
  };
  return { st, probes, cli };
}

const ask = async (f: Record<string, unknown>) => (await st!.relay.request({ v: 1, machine: "laptop", ...f } as Frame)) as Frame & { ok: boolean; result: any; error?: string };
const place = (account: string | null, dir: string) => st!.host("host-slots").request("account.place", { v: 2, account, dir });
const accDir = (n: string) => join(home, "accounts", n);
const slot = (n: string) => join(home, "slots", n);
function cred(dir: string, who: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CREDENTIALS), JSON.stringify({ claudeAiOauth: { accessToken: `tok-${who}` } }));
}
const read = (dir: string) => readFileSync(join(dir, CREDENTIALS), "utf8");
const isLink = (p: string) => existsSync(p) && lstatSync(p).isSymbolicLink();
const now = () => Math.floor(Date.now() / 1000);
const acc = (links: string[] = [], extra: Record<string, unknown> = {}) => ({ login: "ok" as const, links, limits: {}, ...extra });

describe("эталоны accounts", () => {
  it("160 · вход corp по ссылке и коду: своя папка, ~/.claude.json машины прежний, кода нет в журнале и аргументах", async () => {
    writeFileSync(join(homedir(), ".claude.json"), '{"oauthAccount":{"emailAddress":"me@machine"}}');
    const before = readFileSync(join(homedir(), ".claude.json"));
    const { probes, cli } = await bench();
    const r1 = await ask({ type: "machine.login", account: "corp" });
    expect(r1.ok).toBe(true);
    expect(r1.result.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/);
    expect(probes).toHaveLength(1);
    expect(probes[0].env.CLAUDE_CONFIG_DIR).toBe(accDir("corp"));
    expect(probes[0].calls).toEqual([{ name: "claudeAuthenticate", args: [true] }]);
    expect((await ask({ type: "machine.accounts" })).result.accounts.corp.login).toBe("pending");

    const r2 = await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" });
    expect(r2.ok).toBe(true);
    expect(r2.result).toEqual({ email: "corp@x", plan: "max" });
    expect(probes[0].calls[1]).toEqual({ name: "claudeOAuthCallback", args: ["Xk2pL", "Qm9vY"] });
    expect(existsSync(join(accDir("corp"), CREDENTIALS))).toBe(true);
    expect(readFileSync(join(homedir(), ".claude.json"))).toEqual(before);
    const a = (await ask({ type: "machine.accounts" })).result.accounts.corp;
    expect(a).toMatchObject({ login: "ok", links: [], email: "corp@x", plan: "max" });
    // проверка входа той же папкой
    expect(cli.at(-1)!.args).toEqual(["auth", "status"]);
    expect(cli.at(-1)!.env.CLAUDE_CONFIG_DIR).toBe(accDir("corp"));
    const all = JSON.stringify(st!.journal()) + JSON.stringify(cli.map((c) => c.args)) + JSON.stringify(probes.map((p) => p.env));
    expect(all).not.toContain("Xk2pL");
  });

  it("161 · max_age: опрошен только y0902 своей папкой, infirex — нет; в сессии запрос не уходит", async () => {
    const t = now();
    const { probes } = await bench({
      accounts: {
        infirex: acc([slot("main")], { limits: { five_hour: { utilization: 0.83, resetsAt: t + 9000, at: t - 10, src: "poll" } } }),
        y0902: acc([], { limits: { five_hour: { utilization: 0.5, resetsAt: t + 9000, at: t - 600, src: "poll" } } }),
      },
      usage: (env) => ({
        subscription_type: "max",
        rate_limits: { five_hour: { utilization: env.CLAUDE_CONFIG_DIR === accDir("y0902") ? 4 : 83, resets_at: new Date((t + 9000) * 1000).toISOString() } },
      }),
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
    cred(accDir("y0902"), "y0902");
    cred(accDir("corp"), "corp");
    linkSlot(slot("bot"), accDir("corp"));
    const { cli } = await bench({
      accounts: { y0902: acc(), corp: acc([slot("bot")]) },
      status: (env) => (env.CLAUDE_CONFIG_DIR === accDir("corp") ? { code: 1, out: '{"loggedIn":false}' } : { code: 0, out: '{"loggedIn":true}' }),
    });
    vi.advanceTimersByTime(CHECK_MS);
    await until(() => cli.length === 2);
    expect(cli.every((c) => c.env.CLAUDE_SECURESTORAGE_CONFIG_DIR === undefined)).toBe(true);
    expect(cli.map((c) => c.env.CLAUDE_CONFIG_DIR).sort()).toEqual([accDir("corp"), accDir("y0902")].sort());
    await until(() => st!.journal().some((l) => l.why === "corp: вход пропал"));
    const r = await ask({ type: "machine.accounts" });
    expect(r.result.accounts.corp.login).toBe("none");
    expect(r.result.accounts.y0902.login).toBe("ok");
    expect(read(slot("bot"))).toContain("tok-corp");
  });

  it("163 · account.place: слот — ссылка на папку аккаунта, входы не двигаются; один аккаунт — в двух слотах; null снимает ссылку", async () => {
    cred(accDir("infirex"), "infirex");
    cred(accDir("y0902"), "y0902");
    linkSlot(slot("main"), accDir("infirex"));
    await bench({ accounts: { infirex: acc([slot("main")]), y0902: acc() } });

    expect(await place("y0902", slot("main"))).toEqual({ ok: true, result: { from: "infirex" } });
    expect(isLink(slot("main"))).toBe(true);
    expect(read(slot("main"))).toContain("tok-y0902");
    expect(read(accDir("infirex"))).toContain("tok-infirex");
    expect(read(accDir("y0902"))).toContain("tok-y0902");

    // тот же аккаунт — и во второй слот
    expect(await place("y0902", slot("bot"))).toEqual({ ok: true, result: { from: null } });
    expect(read(slot("bot"))).toContain("tok-y0902");
    let a = (await ask({ type: "machine.accounts" })).result.accounts;
    expect(a.y0902.links).toEqual([slot("main"), slot("bot")]);
    expect(a.infirex.links).toEqual([]);

    // повтор — ничего не меняется
    expect(await place("y0902", slot("bot"))).toEqual({ ok: true, result: { from: "y0902" } });
    // снять ссылку bot: папка аккаунта цела
    expect(await place(null, slot("bot"))).toEqual({ ok: true, result: { from: "y0902" } });
    expect(existsSync(slot("bot"))).toBe(false);
    expect(read(accDir("y0902"))).toContain("tok-y0902");
    a = (await ask({ type: "machine.accounts" })).result.accounts;
    expect(a.y0902.links).toEqual([slot("main")]);
    expect(existsSync(join(accDir("infirex"), REFRESH_LOCK))).toBe(false);
  });

  it("164 · удалить corp — только его папка; infirex в слоте — in_slot; logout не зовётся", async () => {
    cred(accDir("corp"), "corp");
    cred(accDir("infirex"), "infirex");
    cred(accDir("y0902"), "y0902");
    linkSlot(slot("main"), accDir("infirex"));
    mkdirSync(join(user, ".claude"), { recursive: true });
    writeFileSync(join(user, ".claude", "settings.json"), "{}");
    const { cli } = await bench({ accounts: { corp: acc(), infirex: acc([slot("main")]), y0902: acc() } });
    const r = await ask({ type: "machine.account_remove", account: "corp" });
    expect(r.result).toEqual({ wiped: true });
    expect(existsSync(accDir("corp"))).toBe(false);
    const r2 = await ask({ type: "machine.account_remove", account: "infirex" });
    expect(r2).toMatchObject({ ok: false, error: "in_slot" });
    expect(read(slot("main"))).toContain("tok-infirex");
    expect(read(accDir("y0902"))).toContain("tok-y0902");
    expect(existsSync(join(user, ".claude", "settings.json"))).toBe(true);
    const accs = (await ask({ type: "machine.accounts" })).result.accounts;
    expect(Object.keys(accs).sort()).toEqual(["infirex", "y0902"]);
    expect(cli.some((c) => c.args.includes("logout"))).toBe(false);
  });

  it("165 · каждое окно — из самого свежего источника; сброс прошёл — 0 %", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = (h: number, m: number) => Date.UTC(2026, 9, 31, h, m) / 1000;
    vi.setSystemTime(at(14, 40) * 1000);
    await bench({
      accounts: { y0902: acc([slot("main")], { limits: { five_hour: { utilization: 0.04, resetsAt: at(16, 20), at: at(14, 40), src: "event" } } }) },
    });
    const h = st!.host("host-slots");
    expect(await h.request("account.usage", { v: 1, account: "y0902", src: "event", at: at(14, 55), windows: { five_hour: { utilization: 0.09, resetsAt: at(16, 20) } } })).toEqual({ ok: true });
    const pc = await ask({
      type: "account.usage",
      account: "y0902",
      src: "pc",
      at: at(14, 50),
      windows: { five_hour: { utilization: 0.06, resetsAt: at(16, 20) } },
    });
    expect(pc.ok).toBe(true);
    await ask({ type: "account.usage", account: "y0902", src: "pc", at: at(14, 58), windows: { seven_day: { utilization: 0.66, resetsAt: at(16, 20) + 5 * 86400 } } });
    const l = (await ask({ type: "machine.accounts" })).result.accounts.y0902.limits;
    expect(l.five_hour).toEqual({ utilization: 0.09, resetsAt: at(16, 20), at: at(14, 55), src: "event" });
    expect(l.seven_day).toMatchObject({ utilization: 0.66, src: "pc" });
    vi.setSystemTime(at(16, 21) * 1000);
    const l2 = (await ask({ type: "machine.accounts" })).result.accounts.y0902.limits;
    expect(l2.five_hour.utilization).toBe(0);
    expect(l2.seven_day.utilization).toBe(0.66);
  });

  it("171 · claude обновляет вход прежнего аккаунта — подмена ждёт его блокировку и идёт сразу после (опыт 1 ноя)", async () => {
    cred(accDir("infirex"), "infirex");
    cred(accDir("y0902"), "y0902");
    linkSlot(slot("main"), accDir("infirex"));
    await bench({ accounts: { infirex: acc([slot("main")]), y0902: acc() } });
    // блокировка claude — папка рядом с файлом входа; через ссылку слота она в папке infirex
    mkdirSync(join(slot("main"), REFRESH_LOCK));
    expect(existsSync(join(accDir("infirex"), REFRESH_LOCK))).toBe(true);
    let done = false;
    const p = place("y0902", slot("main")).then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false);
    expect(read(slot("main"))).toContain("tok-infirex");
    rmdirSync(join(accDir("infirex"), REFRESH_LOCK));
    expect(await p).toEqual({ ok: true, result: { from: "infirex" } });
    expect(read(slot("main"))).toContain("tok-y0902");
    expect(existsSync(join(accDir("infirex"), REFRESH_LOCK))).toBe(false);
  });

  it("265 · блокировка держится дольше LOCK_WAIT_MS — refresh_locked, ссылка прежняя, строка журнала", async () => {
    cred(accDir("infirex"), "infirex");
    cred(accDir("y0902"), "y0902");
    linkSlot(slot("main"), accDir("infirex"));
    await bench({ accounts: { infirex: acc([slot("main")]), y0902: acc() } });
    mkdirSync(join(accDir("infirex"), REFRESH_LOCK));
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const p = place("y0902", slot("main"));
    for (let t = 0; t <= LOCK_WAIT_MS + 200; t += 100) await vi.advanceTimersByTimeAsync(100);
    vi.useRealTimers();
    expect(await p).toMatchObject({ ok: false, error: "refresh_locked" });
    expect(read(slot("main"))).toContain("tok-infirex");
    expect(existsSync(join(accDir("infirex"), REFRESH_LOCK))).toBe(true); // чужую не трогаем
    expect((await ask({ type: "machine.accounts" })).result.accounts.infirex.links).toEqual([slot("main")]);
  });

  it("266 · прежний формат (вход перенесён в папку слота, lent) — при старте вход дома, слот — ссылка, lent и given ушли", async () => {
    cred(slot("main"), "infirex"); // настоящая папка слота с перенесённым входом
    mkdirSync(accDir("infirex"), { recursive: true });
    cred(accDir("y0902"), "y0902");
    await bench({
      accounts: {
        infirex: { login: "ok", lent: slot("main"), given: "abc", limits: {} },
        y0902: { login: "ok", lent: null, limits: {} },
      },
    });
    expect(read(accDir("infirex"))).toContain("tok-infirex");
    expect(isLink(slot("main"))).toBe(true);
    expect(read(slot("main"))).toContain("tok-infirex");
    const raw = JSON.parse(readFileSync(join(home, "store", "host-accounts.json"), "utf8")).machine;
    expect(raw.infirex).toEqual({ login: "ok", limits: {}, links: [slot("main")] });
    expect(raw.y0902).toEqual({ login: "ok", limits: {}, links: [] });
  });
});

describe("accounts: ветки и стыки", () => {
  it("неверный код — bad_code, процесс входа закрыт; второй код — not_started", async () => {
    const { probes } = await bench();
    await ask({ type: "machine.login", account: "corp" });
    const r = await ask({ type: "machine.login_code", account: "corp", code: "WRONG#Qm9vY" });
    expect(r).toMatchObject({ ok: false, error: "bad_code" });
    expect(st!.sdk.queries.filter((q) => !q.options.spawnClaudeCodeProcess).every((q) => q.closed)).toBe(true);
    expect(probes).toHaveLength(1);
    const r2 = await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" });
    expect(r2).toMatchObject({ ok: false, error: "not_started" });
    expect(JSON.stringify(st!.journal())).not.toContain("WRONG");
  });

  it("код без # — состояние из ссылки; повтор machine.login закрывает прежний процесс", async () => {
    const { probes } = await bench();
    await ask({ type: "machine.login", account: "corp" });
    await ask({ type: "machine.login", account: "corp" });
    expect(st!.sdk.queries[0].closed).toBe(true);
    const r = await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL" });
    expect(r.ok).toBe(true);
    expect(probes[1].calls[1]).toEqual({ name: "claudeOAuthCallback", args: ["Xk2pL", "Qm9vY"] });
  });

  it("Host перезапущен посреди входа: pending → none, код — not_started", async () => {
    await bench({ accounts: { corp: { login: "pending", links: [], limits: {} } } });
    expect((await ask({ type: "machine.accounts" })).result.accounts.corp.login).toBe("none");
    expect(await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" })).toMatchObject({ ok: false, error: "not_started" });
  });

  it("аккаунт в слоте, вход пропал — «Войти» кладёт вход в свою папку, слот видит его через ссылку", async () => {
    mkdirSync(accDir("corp"), { recursive: true });
    linkSlot(slot("bot"), accDir("corp"));
    const { probes } = await bench({ accounts: { corp: { login: "none", links: [slot("bot")], limits: {} } } });
    await ask({ type: "machine.login", account: "corp" });
    expect(probes[0].env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    await ask({ type: "machine.login_code", account: "corp", code: "Xk2pL#Qm9vY" });
    expect(read(accDir("corp"))).toContain("tok-corp");
    expect(read(slot("bot"))).toContain("tok-corp");
  });

  it("на месте слота папка с файлами — slot_dir_busy, файлы не тронуты; пустая папка — заменяется ссылкой", async () => {
    cred(accDir("y0902"), "y0902");
    mkdirSync(slot("main"), { recursive: true });
    writeFileSync(join(slot("main"), "keep.txt"), "x");
    mkdirSync(slot("bot"), { recursive: true });
    await bench({ accounts: { y0902: acc() } });
    expect(await place("y0902", slot("main"))).toEqual({ ok: false, error: "slot_dir_busy" });
    expect(readFileSync(join(slot("main"), "keep.txt"), "utf8")).toBe("x");
    expect(await place("y0902", slot("bot"))).toEqual({ ok: true, result: { from: null } });
    expect(isLink(slot("bot"))).toBe(true);
  });

  it("слова: no_account, not_logged_in, bad_frame; опрос не ответил — прежние окна и err", async () => {
    const t = now();
    await bench({
      accounts: {
        none: { login: "none", links: [], limits: {} },
        y0902: acc([], { limits: { five_hour: { utilization: 0.5, resetsAt: t + 900, at: t - 600, src: "poll" } } }),
      },
      usage: () => {
        throw new Error("нет сети");
      },
    });
    expect(await place("ghost", slot("main"))).toEqual({ ok: false, error: "no_account" });
    expect(await place("none", slot("main"))).toEqual({ ok: false, error: "not_logged_in" });
    expect(await place("y0902", slot("main"))).toEqual({ ok: false, error: "not_logged_in" }); // файла входа нет
    expect(await st!.host("host-slots").request("account.place", { v: 2, account: "y0902" })).toEqual({ ok: false, error: "bad_frame" });
    const r = await ask({ type: "machine.accounts", max_age: 60 });
    expect(r.result.accounts.y0902.limits.five_hour.utilization).toBe(0.5);
    expect(r.result.accounts.y0902.err).toBe("нет сети");
  });
});
