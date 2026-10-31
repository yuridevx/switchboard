// Эталоны вида «Пульт: флот» — аккаунты, слоты, машины, точки. Стенд — поддельный relay с заданным roster
// и ответами владельцев; код пульта настоящий. Номер эталона — номер теста.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { fleetRelay, fleetRoster, flush, pult } from "./stand.ts";

const T = (hh: number, mm: number) => Math.floor(Date.UTC(2026, 9, 31, hh, mm) / 1000);
const SID = "42bc5ad4";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** site@laptop в R2 с линией точек; ответы реестра и host-points. */
function pointsRelay(over: (r: Roster) => void = () => {}) {
  const r = fleetRoster();
  Object.assign(r.sessions[2], { r2: {} });
  over(r);
  const relay = fleetRelay(r);
  const at = (hh: number, mm: number) => Date.UTC(2026, 9, 31, hh, mm);
  relay.handlers["points.list"] = (f) =>
    f.sid
      ? {
          ok: true,
          result: {
            owner: "laptop",
            head: 41,
            points: [
              { id: 41, at: at(14, 49), machine: "laptop", why: "rule", base: 40, dir: "~/Projects/site", msgs: 212, git: { state: "dirty", files: 2, branch: "main" }, line: true, until: null },
              { id: 38, at: at(10, 0), machine: "laptop", why: "rule", base: 37, dir: "~/Projects/site", msgs: 194, git: { state: "clean", branch: "main" }, line: true, until: 1824993120000 },
              { id: 33, at: at(8, 15), machine: "laptop", why: "rule", base: 31, dir: "~/Projects/site", line: false, until: 1824993120000 },
            ],
          },
        }
      : {
          ok: true,
          result: {
            sessions: [{ sid: SID, callsign: "site@laptop", dir: "~/Projects/site", owner: "laptop", head: { id: 41, at: at(14, 49) }, points: 41, branches: 1 }],
            r2: { bytes: 432013312, blocks: 2410 },
            sweep: null,
          },
        };
  relay.handlers["points.get"] = (f) => ({ ok: true, result: { owner: "laptop", points: (f.ids as number[]).map((id) => ({ id, last: [["обнови зависимости и прогони тесты", "Обновил 14 пакетов"]] })) } });
  relay.handlers["machine.slots"] = () => ({ ok: true, result: { slots: { main: { account: "y0902", order: ["y0902"], wait: null, sessions: [] } } } });
  return relay;
}

describe("эталоны пульта: аккаунты и слоты", () => {
  async function newLogin(code: { ok: true; result: unknown } | { ok: false; error: string }) {
    const relay = fleetRelay();
    relay.handlers["machine.slots"] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.login"] = () => ({ ok: true, result: { url: "https://claude.ai/oauth/authorize?x" } });
    relay.handlers["machine.login_code"] = () => code;
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
    await t.click(t.btn(null, "+ Новый аккаунт"));
    await t.click(t.btn(t.$(".sb-sec.dlg"), "laptop"));
    await t.type(t.$('[data-f="account"]'), "corp");
    await t.click(t.btn(t.$(".sb-sec.dlg"), "Войти"));
    expect(relay.sent("machine.login")).toEqual([expect.objectContaining({ v: 1, machine: "laptop", account: "corp" })]);
    expect(t.$('[data-login="laptop:corp"] a')!.getAttribute("href")).toBe("https://claude.ai/oauth/authorize?x");
    await t.type(t.$('[data-f="code"]'), "Xk2p…#Qm9w…");
    await t.click(t.btn(t.$('[data-login="laptop:corp"]'), "Отправить"));
    return t;
  }

  it("190 · вход: machine.login → ссылка; один machine.login_code с кодом как есть; кода нет в хранилище, поле пустое; «Вошёл: corp@… · max»", async () => {
    const t = await newLogin({ ok: true, result: { email: "corp@x.io", plan: "max" } });
    expect(t.relay.sent("machine.login_code")).toEqual([{ type: "machine.login_code", id: expect.any(String), v: 1, machine: "laptop", account: "corp", code: "Xk2p…#Qm9w…" }]);
    expect(JSON.stringify(t.store.data)).not.toContain("Xk2p");
    expect(t.$('[data-f="code"]')).toBeNull();
    expect(t.$('[data-login="laptop:corp"]')!.textContent).toContain("Вошёл: corp@x.io · max");
  });

  it("191 · bad_code: «Код не принят — вход закрыт», второго machine.login_code нет; «Войти заново» — новый machine.login", async () => {
    const t = await newLogin({ ok: false, error: "bad_code" });
    const card = t.$('[data-login="laptop:corp"]')!;
    expect(card.textContent).toContain("Код не принят — вход закрыт");
    expect(t.$('[data-f="code"]')).toBeNull();
    expect(t.relay.sent("machine.login_code")).toHaveLength(1);
    await t.click(t.btn(card, "Войти заново"));
    expect(t.relay.sent("machine.login")).toHaveLength(2);
    expect(t.relay.sent("machine.login_code")).toHaveLength(1);
  });

  it("192 · лимиты по почте: machine.accounts { max_age: 120 } каждой машине; account.usage — свои наблюдения машины её соседям с src = имя машины; пересланное дальше не идёт", async () => {
    const relay = fleetRelay();
    relay.handlers["machine.slots"] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["machine.accounts"] = (f) => ({
      ok: true,
      result: {
        accounts:
          f.machine === "laptop"
            ? { y0902: { email: "y0902@x.io", plan: "max", login: "ok", links: [], limits: { five_hour: { utilization: 0.04, resetsAt: T(16, 20), at: T(14, 40), src: "poll" } } } }
            : {
                y0902: {
                  email: "y0902@x.io",
                  plan: "max",
                  login: "ok",
                  links: [],
                  limits: { five_hour: { utilization: 0.09, resetsAt: T(16, 20), at: T(14, 55), src: "event" }, seven_day: { utilization: 0.66, resetsAt: T(20, 0), at: T(14, 58), src: "laptop" } },
                },
              },
      },
    });
    relay.handlers["account.usage"] = () => ({ ok: true });
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
    await flush(10);
    expect(relay.sent("machine.accounts").map((f) => [f.machine, f.max_age])).toEqual([
      ["laptop", 120],
      ["pc", 120],
    ]);
    const usage = relay.sent("account.usage").map(({ id: _, ...f }) => f);
    expect(usage).toEqual([
      { type: "account.usage", v: 1, machine: "pc", account: "y0902", src: "laptop", at: T(14, 40), windows: { five_hour: { utilization: 0.04, resetsAt: T(16, 20) } } },
      { type: "account.usage", v: 1, machine: "laptop", account: "y0902", src: "pc", at: T(14, 55), windows: { five_hour: { utilization: 0.09, resetsAt: T(16, 20) } } },
    ]);
    // одна карточка на почту; окна — запись одной машины, как пришла
    expect(t.$$("[data-account]")).toHaveLength(1);
    expect(t.$$('[data-account] [data-window]').map((x) => x.textContent!.split(" · ")[0])).toEqual(["5 ч4 %"]);
  });

  async function slots(swap: { ok: true; result: unknown } | { ok: false; error: string }) {
    const relay = fleetRelay();
    relay.handlers["machine.slots"] = (f) =>
      ({ ok: true, result: { slots: f.machine === "laptop" ? { main: { account: "y0902", order: ["y0902", "infirex", "work3"], wait: null, sessions: ["site@laptop", "profiles@laptop"] } } : {} } });
    relay.handlers["slot.swap"] = () => swap;
    const t = await pult({ relay });
    await t.go("#accounts?view=slots");
    await t.click(t.$('[data-slot="laptop:main"] [data-act="swap"]'));
    return t;
  }

  it("193 · «Сменить сейчас» → «следующего по порядку»: slot.swap без account, ответ to — в карточке; no_reserve — словами, слот прежний, повтора нет", async () => {
    const t = await slots({ ok: true, result: { from: "y0902", to: "infirex" } });
    expect(t.relay.sent("slot.swap")).toEqual([{ type: "slot.swap", id: expect.any(String), v: 1, machine: "laptop", slot: "main" }]);
    expect(t.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: infirex");
    const t2 = await slots({ ok: false, error: "no_reserve" });
    expect(t2.$('[data-slot="laptop:main"]')!.textContent).toContain("В запасе нет вошедшего ниже порога — слот прежний");
    expect(t2.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: y0902");
    expect(t2.relay.sent("slot.swap")).toHaveLength(1);
  });

  it("268 · один аккаунт в двух слотах: «в слотах main, bot» и «Сессии main/bot»; в слоте — «сейчас и в слоте bot»; удаление меняет его в обоих слотах по очереди", async () => {
    const relay = fleetRelay();
    const both = { main: ["infirex", "y0902"], bot: ["infirex", "y0902"] };
    const current: Record<string, string> = { main: "infirex", bot: "infirex" };
    relay.handlers["machine.slots"] = (f) => ({
      ok: true,
      result: { slots: f.machine === "laptop" ? Object.fromEntries(Object.entries(both).map(([n, o]) => [n, { account: current[n], order: o, wait: null, sessions: [`${n}-s@laptop`] }])) : {} },
    });
    relay.handlers["machine.accounts"] = (f) => ({
      ok: true,
      result: { accounts: f.machine === "laptop" ? { infirex: { login: "ok", links: ["/s/main", "/s/bot"], limits: {} }, y0902: { login: "ok", links: [], limits: {} } } : {} },
    });
    relay.handlers["slot.swap"] = (f) => ((current[f.slot as string] = "y0902"), { ok: true, result: { from: "infirex", to: "y0902" } });
    relay.handlers["slot.set"] = () => ({ ok: true, result: { account: "y0902" } });
    relay.handlers["machine.account_remove"] = () => ({ ok: true, result: { wiped: true } });
    const t = await pult({ relay });
    await t.go("#accounts?view=slots");
    await flush(10);
    expect(t.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: infirex · сейчас и в слоте bot");
    expect(t.$('[data-slot="laptop:bot"] [data-current]')!.textContent).toBe("в слоте: infirex · сейчас и в слоте main");
    await t.go("#accounts?view=accounts");
    await flush(10);
    const row = t.$$('[data-machine="laptop"]').find((x) => x.textContent!.startsWith("laptop") && x.textContent!.includes("в слотах"))!;
    expect(row.textContent).toContain("в слотах main, bot");
    expect(t.$$("[data-sess]").map((b) => b.textContent)).toEqual(["Сессии main (1)…", "Сессии bot (1)…"]);
    await t.click(t.btn(row, "Удалить…"));
    expect(t.$('[data-dlg="rm"]')!.textContent).toContain("infirex сейчас в слотах main, bot");
    await t.click(t.btn(t.$('[data-dlg="rm"]'), "Сменить и удалить"));
    await flush(10);
    expect(relay.sent("slot.swap").map((f) => f.slot)).toEqual(["main", "bot"]);
    expect(relay.sent("slot.set").map((f) => [f.slot, f.order])).toEqual([
      ["main", ["y0902"]],
      ["bot", ["y0902"]],
    ]);
    expect(relay.sent("machine.account_remove")).toEqual([expect.objectContaining({ machine: "laptop", account: "infirex" })]);
  });

  it("194 · подмену делает Host: до roster запросов нет; сменился account — один machine.slots и один machine.accounts к laptop; «в слоте: y0902»; в чате site — «⇄ аккаунт: infirex → y0902»", async () => {
    const r = fleetRoster();
    for (const s of r.sessions) if (s.callsign.endsWith("@laptop")) Object.assign(s, { account: "infirex", slot: { name: "main", wait: null } });
    const relay = fleetRelay(r);
    let inSlot = "infirex";
    relay.handlers["machine.slots"] = (f) => ({ ok: true, result: { slots: f.machine === "laptop" ? { main: { account: inSlot, order: ["infirex", "y0902"], wait: null, sessions: ["site@laptop", "wiki@laptop", "profiles@laptop"] } } : {} } });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await t.go("#accounts?view=slots");
    await flush(10);
    const before = relay.got.length;
    expect(t.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: infirex");
    inSlot = "y0902";
    const r2 = fleetRoster();
    for (const s of r2.sessions) if (s.callsign.endsWith("@laptop")) Object.assign(s, { account: "y0902", slot: { name: "main", wait: null } });
    relay.setRoster(r2);
    await flush(10);
    const after = relay.got.slice(before);
    expect(after.map((f) => `${f.type} ${f.machine}`)).toEqual(["machine.slots laptop", "machine.accounts laptop"]);
    expect(t.$('[data-slot="laptop:main"] [data-current]')!.textContent).toBe("в слоте: y0902");
    await t.click(t.$('.sb-navcol button[data-screen="board"]'));
    await t.click(t.$('[data-callsign="site@laptop"]'));
    expect(t.$(".chat-sys.swap")!.textContent).toBe("⇄ аккаунт: infirex → y0902");
  });
});

describe("эталоны пульта: машины", () => {
  async function machines(upgrade: { ok: true; result: unknown } | { ok: false; error: string }) {
    const relay = fleetRelay();
    let host: Record<string, string> = { laptop: "1.4.1", pc: "1.4.0" };
    relay.handlers["machine.state"] = (f) => ({ ok: true, result: { host: host[String(f.machine)], sdk: "0.3.311", os: { platform: f.machine === "pc" ? "linux" : "win32", arch: "x64", release: "6.8.0" }, processes: [{ id: "a", pid: 1 }] } });
    relay.handlers["machine.upgrade"] = (f) => (f.dryRun ? { ok: true, result: { from: host[String(f.machine)], to: "1.4.1" } } : upgrade);
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: { "team/profiles": { state: "ok" } } } });
    relay.handlers["github.app"] = () => ({ ok: true, result: { app: { slug: "switchboard-team", id: 1, owner: "team" }, repos: ["team/profiles"], install: "https://github.com/apps/switchboard-team/installations/new" } });
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="machines"]'));
    await flush(10);
    return { t, relay, setHost: (m: string, v: string) => (host = { ...host, [m]: v }) };
  }

  it("195 · «есть новая версия» — только у pc по ответу dryRun; «Обновить» — machine.upgrade { version: latest } без поля версии; pc ушла — «обновляется», вернулась — machine.state 1.4.1; check_failed — словами, без повтора", async () => {
    const { t, relay, setHost } = await machines({ ok: true, result: { from: "1.4.0", to: "1.4.1", sdk: { from: "0.3.311", to: "0.3.311" }, restart: true } });
    expect(relay.sent("machine.upgrade").map((f) => [f.machine, f.version, f.dryRun])).toEqual([
      ["laptop", "latest", true],
      ["pc", "latest", true],
    ]);
    expect(t.$('[data-machine="pc"] [data-newer]')!.textContent).toBe("есть новая версия · 1.4.1");
    expect(t.$('[data-machine="laptop"] [data-newer]')).toBeNull();
    await t.click(t.btn(t.$('[data-machine="pc"]'), "Обновить до 1.4.1"));
    await t.click(t.btn(t.$('[data-dlg="upgrade"]'), "Обновить"));
    expect(relay.sent("machine.upgrade").at(-1)).toEqual({ type: "machine.upgrade", id: expect.any(String), v: 1, machine: "pc", version: "latest" });
    const r = fleetRoster();
    relay.setRoster({ ...r, machines: r.machines.filter((m) => m.machine !== "pc") });
    await flush();
    expect(t.$('[data-machine="pc"] [data-upg]')!.textContent).toContain("pc обновляется: 1.4.0 → 1.4.1");
    setHost("pc", "1.4.1");
    const states = relay.sent("machine.state").length;
    relay.setRoster({ ...r, machines: r.machines.map((m) => (m.machine === "pc" ? { ...m, since: m.since + 60_000 } : m)) });
    await flush(10);
    expect(relay.sent("machine.state").length).toBe(states + 1);
    expect(t.$('[data-machine="pc"] [data-host]')!.textContent).toBe("1.4.1 · SDK 0.3.311");
    expect(t.$('[data-machine="pc"] [data-upg="done"]')!.textContent).toContain("pc: 1.4.0 → 1.4.1Сессии не останавливались.");

    const m2 = await machines({ ok: false, error: "check_failed" });
    await m2.t.click(m2.t.btn(m2.t.$('[data-machine="pc"]'), "Обновить до 1.4.1"));
    await m2.t.click(m2.t.btn(m2.t.$('[data-dlg="upgrade"]'), "Обновить"));
    expect(m2.t.$('[data-machine="pc"]')!.textContent).toContain("Новая версия не прошла проверку");
    expect(m2.t.$('[data-machine="pc"] [data-host]')!.textContent).toBe("1.4.0 · SDK 0.3.311");
    expect(m2.relay.sent("machine.upgrade").filter((f) => !f.dryRun)).toHaveLength(1);
  });
});

describe("эталоны пульта: точки", () => {
  it("196 · перенос: dryRun к pc → «тот же репозиторий»; points.save со стопом → points.raise к pc с point 42 → «site перенесена на pc»; закрыли вкладку — новое «Перенести» снова с points.save, та же точка", async () => {
    const run = async (same: boolean) => {
      const relay = pointsRelay();
      relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same", branch: "main", sessions: [] } } : { ok: true, result: { callsign: "site@pc", point: 43, folder: "same", branch: "points-1031-1453" } });
      relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same } });
      const t = await pult({ relay });
      await t.click(t.$('[data-callsign="site@laptop"]'));
      await t.click(t.$('.cw-tabs [data-tab="points"]'));
      await flush(10);
      await t.click(t.btn(null, "Перенести…"));
      await flush(10);
      expect(relay.sent("points.raise")[0]).toEqual(expect.objectContaining({ machine: "pc", sid: SID, point: 41, dir: "~/Projects/site", files: "point", dryRun: true }));
      expect(t.$('[data-dlg="move"] [data-check]')!.textContent).toBe("тот же репозиторий, своих правок нет — правки точки применятся");
      await t.click(t.$('[data-dlg="move"] [data-act="run"]'));
      return { t, relay };
    };
    const { t, relay } = await run(false);
    const steps = relay.got.filter((f) => f.type === "points.save" || (f.type === "points.raise" && !f.dryRun));
    expect(steps.map(({ id: _, ...f }) => f)).toEqual([
      { type: "points.save", v: 1, callsign: "site@laptop", stop: true },
      { type: "points.raise", v: 1, machine: "pc", sid: SID, point: 42, dir: "~/Projects/site", slot: "main", files: "point" },
    ]);
    expect(t.$('[data-dlg="move"] [data-phase="done"]')!.textContent).toContain("site перенесена на pc: site@pc");
    const again = await run(true);
    expect(again.relay.got.filter((f) => f.type === "points.save" || (f.type === "points.raise" && !f.dryRun)).map((f) => [f.type, f.point ?? null])).toEqual([
      ["points.save", null],
      ["points.raise", 42],
    ]);
  });

  it("197 · «пожар»: mac нет в roster — плашка «mac не на связи с ЧЧ:ММ · 2 сессии ждут»; dryRun на каждую; points.raise по одной, scrape — после ответа notes; points.save нет; open_failed — строка «не поднялась»", async () => {
    const relay = fleetRelay();
    const left = Date.UTC(2026, 9, 31, 3, 12);
    relay.handlers["points.list"] = () => ({
      ok: true,
      result: {
        sessions: [
          { sid: "77ae", callsign: "notes@mac", dir: "~/notes", owner: "mac", head: { id: 88, at: Date.UTC(2026, 9, 31, 3, 5) }, points: 88, branches: 0 },
          { sid: "51cd", callsign: "scrape@mac", dir: "~/scrape", owner: "mac", head: { id: 61, at: Date.UTC(2026, 9, 31, 2, 50) }, points: 61, branches: 0 },
        ],
        r2: { bytes: 1, blocks: 1 },
        sweep: null,
      },
    });
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [{ id: 812, t: left, ev: "machine.left", from: "ledger", machine: "mac", text: "mac пропала" }], more: true } });
    relay.handlers["machine.slots"] = () => ({ ok: true, result: { slots: { main: { account: "y0902", order: ["y0902"], wait: null, sessions: [] } } } });
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "empty", sessions: [] } } : f.sid === "51cd" ? { ok: false, error: "open_failed" } : undefined);
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="points"]'));
    await flush(10);
    expect(relay.sent("ledger.read")).toEqual([expect.objectContaining({ to: "ledger", machine: "mac", limit: 1 })]);
    const d = new Date(left);
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(t.$('[data-fire="mac"] b')!.textContent).toBe(`mac не на связи с ${hm} · 2 сессии ждут на последних точках`);
    expect(t.$('.sb-navcol button[data-screen="points"]')!.textContent).toBe("Точки2");
    await t.click(t.btn(null, "Перенести на другую машину…"));
    await flush(10);
    expect(relay.sent("points.raise").map((f) => [f.machine, f.sid, f.dryRun])).toEqual([
      ["laptop", "77ae", true],
      ["laptop", "51cd", true],
    ]);
    await t.click(t.btn(null, "Перенести 2 из 2 на laptop"));
    const real = () => relay.sent("points.raise").filter((f) => !f.dryRun);
    expect(real().map((f) => f.sid)).toEqual(["77ae"]);
    expect(t.$('[data-dlg="fire"] [data-progress]')!.textContent).toContain("0 из 2 готовы — не закрывайте страницу");
    relay.reply(String(real()[0].id), { ok: true, result: { callsign: "notes@laptop", point: 89, folder: "empty" } });
    await flush(10);
    expect(real().map((f) => [f.sid, f.point, f.slot, f.files])).toEqual([
      ["77ae", 88, "main", "point"],
      ["51cd", 61, "main", "point"],
    ]);
    expect(relay.sent("points.save")).toHaveLength(0);
    expect(t.$('[data-dlg="fire"] [data-progress]')!.textContent).toContain("1 из 2 готовы");
    expect(t.$('[data-row="notes"]')!.textContent).toContain("готова — notes@laptop");
    expect(t.$('[data-row="scrape"]')!.textContent).toContain("не поднялась");
  });

  it("198 · «только в R2»: с «old-bo» кнопка недоступна, запросов нет; с «old-bot» — points.delete { sid } → строка пропала, «old-bot удалена — 57 точек»", async () => {
    const relay = fleetRelay();
    let gone = false;
    relay.handlers["points.list"] = () => ({
      ok: true,
      result: { sessions: gone ? [] : [{ sid: "9f03", callsign: "old-bot@laptop", dir: "~/Projects/bot", owner: "laptop", head: { id: 212, at: Date.UTC(2026, 8, 2) }, points: 57, branches: 0 }], r2: { bytes: 1, blocks: 1 }, sweep: null },
    });
    relay.handlers["points.delete"] = () => ((gone = true), { ok: true, result: { points: 57, blocks: 9, bytes: 1 } });
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="points"]'));
    await flush(10);
    expect(t.$('[data-only] [data-sid="9f03"]')).not.toBeNull();
    await t.click(t.btn(t.$('[data-sid="9f03"]'), "Удалить…"));
    const before = relay.got.length;
    await t.type(t.$('[data-f="del:9f03"]'), "old-bo");
    expect(t.$<HTMLButtonElement>('[data-act="delete"]')!.disabled).toBe(true);
    expect(relay.got.length).toBe(before);
    await t.type(t.$('[data-f="del:9f03"]'), "old-bot");
    await t.click(t.$('[data-act="delete"]'));
    expect(relay.sent("points.delete")).toEqual([expect.objectContaining({ to: "points", sid: "9f03" })]);
    await flush(10);
    expect(t.$('[data-sid="9f03"]')).toBeNull();
    expect(t.$("[data-only]")!.textContent).toContain("old-bot удалена — 57 точек");
  });

  it("262 · не в R2: points.list и points.get не шлются, переноса и отката нет; «Хранить в R2» — session.r2 on; второй прогон: «wik» — недоступно, «wiki» — session.r2 off → «12 точек удалено», points.delete нет", async () => {
    const relay = pointsRelay();
    relay.handlers["session.r2"] = (f) => ({ ok: true, result: f.on ? { point: 1 } : { deleted: 12 } });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="wiki@laptop"]'));
    await t.click(t.$('.cw-tabs [data-tab="points"]'));
    expect(t.$('[data-r2="off"] b')!.textContent).toBe("wiki@laptop не в R2");
    expect(relay.sent("points.list")).toHaveLength(0);
    expect(relay.sent("points.get")).toHaveLength(0);
    expect(t.btn(null, "Перенести…")).toBeNull();
    expect(t.btn(null, "Сменить папку…")).toBeNull();
    await t.click(t.$('[data-r2="off"] [data-act="r2"]'));
    expect(relay.sent("session.r2")).toEqual([expect.objectContaining({ v: 1, callsign: "wiki@laptop", on: true })]);
    expect(t.$("[data-note]")!.textContent).toContain("Первая точка — №1");

    const relay2 = pointsRelay((r) => Object.assign(r.sessions[4], { r2: {} }));
    relay2.handlers["session.r2"] = relay.handlers["session.r2"];
    const t2 = await pult({ relay: relay2 });
    await t2.click(t2.$('[data-callsign="wiki@laptop"]'));
    await t2.click(t2.$('.cw-tabs [data-tab="points"]'));
    await flush(10);
    await t2.click(t2.$('[data-r2="on"] ~ .sb-sec [data-act="r2"]'));
    await t2.type(t2.$('[data-f="unmark"]'), "wik");
    expect(t2.$<HTMLButtonElement>('[data-act="unmark"]')!.disabled).toBe(true);
    expect(relay2.sent("session.r2")).toHaveLength(0);
    await t2.type(t2.$('[data-f="unmark"]'), "wiki");
    await t2.click(t2.$('[data-act="unmark"]'));
    expect(relay2.sent("session.r2")).toEqual([expect.objectContaining({ callsign: "wiki@laptop", on: false })]);
    expect(t2.$("[data-note]")!.textContent).toContain("12 точек удалено из R2 — сразу, без отмены");
    expect(relay2.sent("points.delete")).toHaveLength(0);
  });

  it("261 · смена папки: points.save со стопом → points.raise copy в новую папку, files keep → session.remove прежней; open_failed — «Копия не поднялась», session.remove нет", async () => {
    const run = async (raise: { ok: true; result: unknown } | { ok: false; error: string }) => {
      const relay = pointsRelay();
      relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same: false } });
      relay.handlers["points.raise"] = () => raise;
      relay.handlers["session.remove"] = () => ({ ok: true });
      const t = await pult({ relay });
      await t.click(t.$('[data-callsign="site@laptop"]'));
      await t.click(t.$('.cw-tabs [data-tab="points"]'));
      await flush(10);
      await t.click(t.$('[data-act="dir"]'));
      expect(t.$<HTMLInputElement>('[data-dlg="dir"] [data-f="dir"]')!.value).toBe("~/Projects/site-v2");
      expect(t.$<HTMLInputElement>('[data-dlg="dir"] [data-f="name"]')!.value).toBe("site-v2");
      await t.click(t.$('[data-dlg="dir"] [data-act="run"]'));
      return { t, relay };
    };
    const { relay } = await run({ ok: true, result: { callsign: "site-v2@laptop", point: 1, folder: "keep", branch: null } });
    const steps = relay.got.filter((f) => ["points.save", "points.raise", "session.remove"].includes(f.type)).map(({ id: _, ...f }) => f);
    expect(steps).toEqual([
      { type: "points.save", v: 1, callsign: "site@laptop", stop: true },
      { type: "points.raise", v: 1, machine: "laptop", sid: SID, point: 42, dir: "~/Projects/site-v2", files: "keep", copy: true, name: "site-v2" },
      { type: "session.remove", v: 1, callsign: "site@laptop" },
    ]);
    const bad = await run({ ok: false, error: "open_failed" });
    expect(bad.t.$('[data-dlg="dir"] [data-phase="err"]')!.textContent).toContain("Копия не поднялась");
    expect(bad.relay.sent("session.remove")).toHaveLength(0);
  });

  it("263 · откат к 10:00: «Привязка к claude.ai снимется»; points.save со стопом, затем points.raise с точкой 38; новая remote.url из roster — в «В claude.ai»; remote пульт не зовёт", async () => {
    const relay = pointsRelay();
    relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same: false } });
    relay.handlers["points.raise"] = () => ({ ok: true, result: { callsign: "site@laptop", point: 43, folder: "keep", branch: null } });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await t.click(t.$('.cw-tabs [data-tab="points"]'));
    await flush(10);
    await t.click(t.$('[data-point="38"]'));
    await t.click(t.$('[data-card="38"] [data-act="rb"]'));
    expect(t.$('[data-dlg="rb"] [data-remote]')!.textContent).toContain("Привязка к claude.ai снимется");
    await t.click(t.$('[data-dlg="rb"] [data-act="run"]'));
    const steps = relay.got.filter((f) => f.type === "points.save" || f.type === "points.raise");
    expect(steps.map((f) => [f.type, f.stop ?? null, f.point ?? null])).toEqual([
      ["points.save", true, null],
      ["points.raise", null, 38],
    ]);
    const r = fleetRoster();
    Object.assign(r.sessions[2], { r2: {}, remote: { url: "https://claude.ai/code/session_02Qx" } });
    relay.setRoster(r);
    await flush();
    expect(t.btn(null, "В claude.ai ↗") ?? t.$(".cw-acts a")).not.toBeNull();
    expect(t.$(".cw-acts a")!.getAttribute("href")).toBe("https://claude.ai/code/session_02Qx");
    expect(relay.got.some((f) => f.type.startsWith("remote"))).toBe(false);
  });
});
