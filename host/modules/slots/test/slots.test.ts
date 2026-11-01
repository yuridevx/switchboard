// Эталоны и стыки модуля slots на стенде Host: поддельные SDK, relay, keeper и часы;
// accounts — настоящий, с временной папкой; ссылки слотов — настоящие. Номер эталона — номер теста.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import accountsManifest from "../../accounts/module.json" with { type: "json" };
import { linkSlot, make as makeAccounts } from "../../accounts/src/accounts.ts";
import manifest from "../module.json" with { type: "json" };
import { CONTINUE, make } from "../src/slots.ts";

const { msg, module, standHost, turn, until } = stand;
type Stand = stand.Stand;
const CRED = ".credentials.json";
const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

let st: Stand | null = null;
let home = "";
const saved = { ...process.env };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sb-slots-"));
  process.env.SWITCHBOARD_HOME = home;
});
afterEach(async () => {
  await st?.close();
  st = null;
  vi.useRealTimers();
  process.env = { ...saved };
});

type Win = { utilization: number; resetsAt: number; at?: number; src?: string };
/** in — слоты, где аккаунт стоит сейчас (ссылка слота ведёт на его папку). */
type AccSpec = { in?: string | string[]; login?: "ok" | "none"; limits?: Record<string, Win> };
const accDir = (n: string) => join(home, "accounts", n);
const slotDir = (n: string) => join(home, "slots", n);
const now = () => Math.floor(Date.now() / 1000);
const read = (d: string) => readFileSync(join(d, CRED), "utf8");
const isLink = (p: string) => existsSync(p) && lstatSync(p).isSymbolicLink();

/**
 * Машина: аккаунты (вход — файлом в папке аккаунта, слоты — ссылки на неё), порядок слотов и слоты сессий.
 * Сессии из списка поднимаются Host по resume.
 */
async function bench(o: { accounts: Record<string, AccSpec>; slots?: Record<string, string[]>; sessions?: Record<string, { slot: string | null; cut?: string }> }) {
  const store = join(home, "store");
  mkdirSync(store, { recursive: true });
  const recs: Record<string, unknown> = {};
  for (const [n, a] of Object.entries(o.accounts)) {
    mkdirSync(accDir(n), { recursive: true });
    if ((a.login ?? "ok") === "ok") writeFileSync(join(accDir(n), CRED), JSON.stringify({ claudeAiOauth: { accessToken: `tok-${n}` } }));
    const links = (a.in === undefined ? [] : [a.in].flat()).map(slotDir);
    for (const l of links) linkSlot(l, accDir(n));
    recs[n] = {
      login: a.login ?? "ok",
      links,
      limits: Object.fromEntries(Object.entries(a.limits ?? {}).map(([w, v]) => [w, { at: now() - 30, src: "event", ...v }])),
    };
  }
  writeFileSync(join(store, "host-accounts.json"), JSON.stringify({ machine: recs }));
  writeFileSync(join(store, "host-slots.json"), JSON.stringify({ machine: { slots: o.slots ?? {} }, sessions: o.sessions ?? {} }));
  const acc = { ...(accountsManifest as Manifest), calls: (accountsManifest as Manifest).calls!.filter((c) => c !== USAGE) };
  st = await standHost({
    home,
    sessions: Object.keys(o.sessions ?? {}).map((callsign) => ({ callsign })),
    modules: [
      { manifest: acc, module: makeAccounts() },
      { manifest: manifest as Manifest, module: make() },
      module("probe", {}, { uses: { "machine.accounts@host-accounts": 1 } }),
    ],
  });
  for (const cs of Object.keys(o.sessions ?? {})) await until(() => st!.session("probe", cs)?.state === "idle");
  return st;
}

const ask = async (f: Record<string, unknown>) => (await st!.relay.request({ v: 1, machine: "laptop", ...f } as Frame)) as Frame & { ok: boolean; result: any; error?: string };
const accounts = async () => ((await st!.host("probe").request("machine.accounts", { v: 1 })) as any).result.accounts;
const places = () => st!.journal().filter((l) => l.ev === "place");
const swaps = () => st!.relay.frames("ledger.add").filter((f) => f.ev === "slot.swapped");
const limit = (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info, uuid: "00000000-0000-4000-8000-00000000aaaa", session_id: "s" });
const last = (cs: string) => st!.states(cs).at(-1)!;
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

describe("эталоны slots", () => {
  it("16 · у порога 95 % — один account.place, обе сессии на y0902 без перезапуска, ledger.add slot.swapped", async () => {
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

  it("88 · поздний ответ infirex после подмены: account.usage infirex, слот остаётся на y0902", async () => {
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { limits: { five_hour: { utilization: 0.95, resetsAt: R } } }, y0902: { in: "main", limits: { five_hour: { utilization: 0.05, resetsAt: R + 3600 } } } },
      slots: { main: ["infirex", "y0902"] },
      sessions: { "site@laptop": { slot: "main" }, "wiki@laptop": { slot: "main" } },
    });
    st!.proc("wiki@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96, resetsAt: R }));
    await until(() => st!.journal().some((l) => l.why === "main: поздний ответ infirex"));
    const a = await waitFor(async () => {
      const x = await accounts();
      return x.infirex.limits.five_hour.utilization === 0.96 ? x : null;
    });
    expect(a.y0902.links).toEqual([slotDir("main")]);
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
    await until(() => st!.journal().some((l) => l.ev === "slot.wait" && /все аккаунты у порога — жду сброса/.test(l.why)));
    turn(st!.proc("site@laptop"));
    await until(() => (last("site@laptop").slot as { wait?: number } | undefined)?.wait === Y);
    expect(last("site@laptop").account).toBe("y0902");
    expect(places()).toHaveLength(0);
    const r = await ask({ type: "machine.slots" });
    expect(r.result.slots.main).toMatchObject({ account: "y0902", wait: Y, sessions: ["site@laptop"] });
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
    writeFileSync(join(slotDir("main"), `${CRED}.tmp.5d666bc0`), fresh);
    const { renameSync } = await import("node:fs");
    renameSync(join(slotDir("main"), `${CRED}.tmp.5d666bc0`), join(slotDir("main"), CRED));
    expect(readFileSync(join(accDir("infirex"), CRED), "utf8")).toBe(fresh);
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95, resetsAt: R }));
    await until(() => swaps().length === 1);
    expect(readFileSync(join(accDir("infirex"), CRED), "utf8")).toBe(fresh);
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
    let r = await ask({ type: "machine.slots" });
    expect(r.result.slots.main.account).toBe("infirex");
    expect(r.result.slots.bot.account).toBe("infirex");
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95, resetsAt: R }));
    await until(() => swaps().length === 1);
    r = await ask({ type: "machine.slots" });
    expect(r.result.slots.main.account).toBe("y0902");
    expect(r.result.slots.bot.account).toBe("infirex");
    expect(read(slotDir("bot"))).toContain("tok-infirex");
    st!.proc("poe@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96, resetsAt: R }));
    await until(() => swaps().length === 2);
    expect(swaps().map((x) => x.text)).toEqual(["слот main: infirex → y0902 · 5 ч 95 %", "слот bot: infirex → y0902 · 5 ч 96 %"]);
    expect((await accounts()).y0902.links).toEqual([slotDir("main"), slotDir("bot")]);
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
    expect((await ask({ type: "machine.slots" })).result.slots.main.wait).toBe(t + 60);
    vi.setSystemTime((t + 61) * 1000);
    vi.advanceTimersByTime(61_000);
    await until(() => st!.journal().some((l) => l.why === "main: сброс y0902 — продолжаю"));
    expect(read(slotDir("main"))).toContain("tok-y0902");
    expect(read(accDir("infirex"))).toContain("tok-infirex");
    await until(() => st!.proc("site@laptop").inputs.length === 1);
    expect(JSON.stringify(st!.proc("site@laptop").inputs[0].message.content)).toContain(CONTINUE);
    expect((await ask({ type: "machine.slots" })).result.slots.main.wait).toBeNull();
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
    const r = await ask({ type: "slot.swap", slot: "main" });
    expect(r).toMatchObject({ ok: false, error: "no_reserve" });
    expect(read(slotDir("main"))).toContain("tok-y0902");
  });

  it("169 · новый слот: аккаунт уже стоит в main — встаёт и в s2; в порядке нет вошедших — no_reserve, слот не создан (живой прогон 31 окт.)", async () => {
    await bench({
      accounts: { infirex: { in: "main" }, corp: { login: "none" } },
      slots: { main: ["infirex"] },
      sessions: {},
    });
    const ok = await ask({ type: "slot.set", slot: "s2", order: ["infirex"] });
    expect(ok).toMatchObject({ ok: true, result: { account: "infirex" } });
    expect(read(slotDir("s2"))).toContain("tok-infirex");
    expect((await accounts()).infirex.links).toEqual([slotDir("main"), slotDir("s2")]);
    const r = await ask({ type: "slot.set", slot: "s3", order: ["corp"] });
    expect(r).toMatchObject({ ok: false, error: "no_reserve" });
    const slots = await ask({ type: "machine.slots" });
    expect(Object.keys(slots.result.slots).sort()).toEqual(["main", "s2"]);
    expect(existsSync(slotDir("s3"))).toBe(false);
  });

  it("170 · сессия без слота: ключа нет, лимиты не в accounts; slot.set с default — no_account", async () => {
    await bench({ accounts: { y0902: {} }, slots: {} });
    await st!.open("wiki@laptop");
    expect(st!.proc("wiki@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    st!.proc("wiki@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.99, resetsAt: now() + 99 }));
    turn(st!.proc("wiki@laptop"));
    await until(() => last("wiki@laptop").state === "idle");
    expect((await accounts()).y0902.limits).toEqual({});
    expect(last("wiki@laptop").slot).toBeUndefined();
    const r = await ask({ type: "slot.set", slot: "bot", order: ["default"] });
    expect(r).toMatchObject({ ok: false, error: "no_account" });
    expect((await ask({ type: "machine.slots" })).result.slots).toEqual({});
    expect(existsSync(slotDir("bot"))).toBe(false);
  });
});

describe("slots: ветки и стыки", () => {
  it("slot.set — новый слот берёт первый вошедший; session.slot живой сессии — restart с папкой слота", async () => {
    await bench({ accounts: { corp: { login: "none" }, y0902: {} }, slots: {} });
    const r = await ask({ type: "slot.set", slot: "bot", order: ["corp", "y0902"] });
    expect(r.result).toEqual({ account: "y0902" });
    expect(read(slotDir("bot"))).toContain("tok-y0902");
    await st!.open("site@laptop");
    expect(st!.proc("site@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    const s = await ask({ type: "session.slot", callsign: "site@laptop", slot: "bot" });
    expect(s.result).toEqual({ restart: true });
    await until(() => st!.sdk.of("site@laptop").length === 2 && st!.session("probe", "site@laptop")!.state === "idle");
    expect(st!.proc("site@laptop").env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(slotDir("bot"));
    expect(st!.query("site@laptop").options.resume).toBeDefined();
    expect((await ask({ type: "session.slot", callsign: "site@laptop", slot: "nope" })).error).toBe("no_slot");
  });

  it("slot.set с пустым порядком: есть сессии — has_sessions; без сессий — ссылка снята, вход дома, слот удалён", async () => {
    await bench({ accounts: { y0902: { in: "bot" } }, slots: { bot: ["y0902"] }, sessions: { "site@laptop": { slot: "bot" } } });
    expect(await ask({ type: "slot.set", slot: "bot", order: [] })).toMatchObject({ ok: false, error: "has_sessions" });
    await st!.session("probe", "site@laptop")!.remove();
    const r = await ask({ type: "slot.set", slot: "bot", order: [] });
    expect(r.result).toEqual({ account: null });
    expect(read(accDir("y0902"))).toContain("tok-y0902");
    expect(existsSync(slotDir("bot"))).toBe(false);
    expect((await accounts()).y0902.links).toEqual([]);
    expect((await ask({ type: "machine.slots" })).result.slots).toEqual({});
  });

  it("slot.swap «Сменить сейчас» — by в журнале флота; no_slot у незнакомого слота", async () => {
    await bench({ accounts: { infirex: { in: "main" }, y0902: {}, work3: {} }, slots: { main: ["infirex", "y0902", "work3"] } });
    const r = await ask({ type: "slot.swap", slot: "main", account: "work3" });
    expect(r.result).toEqual({ from: "infirex", to: "work3" });
    expect(swaps()[0]).toMatchObject({ by: "panel-desk~owner@example.com", text: "слот main: infirex → work3 · вручную" });
    expect((await ask({ type: "slot.swap", slot: "x" })).error).toBe("no_slot");
  });

  it("accounts отказал в подмене — слот прежний, строка журнала со словом", async () => {
    const R = now() + 3600;
    await bench({
      accounts: { infirex: { in: "main", limits: { five_hour: { utilization: 0.9, resetsAt: R } } }, y0902: {} },
      slots: { main: ["infirex", "y0902"] },
      sessions: { "site@laptop": { slot: "main" } },
    });
    // файл входа y0902 пропал — accounts отвечает not_logged_in
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(accDir("y0902"), CRED));
    st!.proc("site@laptop").send(limit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.96, resetsAt: R }));
    await until(() => st!.journal().some((l) => l.ev === "slot.swap" && l.word === "not_logged_in"));
    expect(read(slotDir("main"))).toContain("tok-infirex");
    expect(swaps()).toHaveLength(0);
  });
});
