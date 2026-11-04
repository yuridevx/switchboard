// Эталоны pult-settings — «Настройки» флота по прототипу «Пульт и телефон» (подписан пользователем 2 нояб.:
// «основа дизайна ок», «Выпуски — вкладка в настройках», «Пропуска — таб в настройках», «нужен полный редизайн
// страницы в разрезе машин»). Стенд: настройки и уведомления на поддельном relay; ответы владельцев — подделки.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore, type AppPart, type Frame, type Roster } from "@switchboard/web-core";
import { manifest as alertsM, createAlerts, type BrowserPush } from "@switchboard/web-alerts";
import { FakeRelay, flush, stand } from "../../packages/core/stand/app.ts";
import { fakeBrowser } from "../../packages/alerts/stand/fakes.ts";
import { manifest as settingsM, createSettings } from "../modules/settings/contract.ts";

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

const contract = { "machine.profiles": 1 };
const roster = (): Roster => ({
  type: "roster",
  machines: [
    { machine: "laptop", since: 1, proto: 1, contract },
    { machine: "pc", since: 1, proto: 1, contract },
  ],
  sessions: [],
  clients: ["pult"],
});

type Plan = Record<string, { pin?: string; on?: boolean }>;
/** Флот «Выпусков»: stable host +7, keeper 1.0.5; laptop держит keeper 1.0.4 закреплённым, pc отстал по host и уронил hello-daemon; old ушла. */
function fleet() {
  const plans: Record<string, Plan> = { laptop: { keeper: { pin: "1.0.4" } }, pc: {}, old: {} };
  const passes = [
    { id: "kh1", role: "host", name: "laptop", person: null, addr: "@laptop", state: "ok", by: "агент", at: Date.UTC(2026, 10, 1) },
    { id: "kc1", role: "client", name: "pult", person: "you@mail", addr: "pult~you@mail", state: "ok", by: "@laptop", at: Date.UTC(2026, 10, 2) },
    { id: "kc2", role: "client", name: "phone", person: "you@mail", addr: "phone~you@mail", state: "ok", by: "pult~you@mail", at: Date.UTC(2026, 10, 2) },
    { id: "kr1", role: "client", name: "old", person: "you@mail", addr: "old~you@mail", state: "revoked", by: "pult~you@mail", at: Date.UTC(2026, 10, 2) },
  ];
  const relay = new FakeRelay(roster());
  relay.handlers["releases.list"] = () => ({
    ok: true,
    result: {
      parts: {
        host: { where: "machine", edge: "1.2.0+8", stable: "1.2.0+7", versions: ["1.2.0+5", "1.2.0+6", "1.2.0+7", "1.2.0+8"] },
        keeper: { where: "machine", edge: "1.0.5", stable: "1.0.5", versions: ["1.0.3", "1.0.4", "1.0.5"] },
        pult: { where: "cloud", edge: "1.2.0+13", stable: "1.2.0+12", versions: ["1.2.0+10", "1.2.0+11", "1.2.0+12", "1.2.0+13"] },
        relay: { where: "cloud", edge: "1.1.0", stable: "1.1.0", versions: ["1.1.0"] },
      },
      machines: Object.entries(plans).map(([machine, plan]) => ({ machine, plan })),
      rev: 9,
      modules: {
        "web-inbox": { into: ["pult", "phone"], built: { pult: "0.1.0", phone: "0.1.0" }, edge: "0.2.0" },
        "web-core": { into: ["pult", "phone"], built: { pult: "1.3.2", phone: "1.3.2" }, edge: "1.3.2" },
      },
    },
  });
  relay.handlers["keeper.state"] = (f: Frame) => {
    const m = String(f.to).split("@")[1];
    if (m === "laptop") return { ok: true, result: { keeper: "1.0.4", rev: 9, os: "windows", parts: [{ part: "host", version: "1.2.0+7", state: "running" }, { part: "keeper", version: "1.0.4", state: "running" }] } };
    return { ok: true, result: { keeper: "1.0.5", rev: 9, os: "linux", parts: [{ part: "host", version: "1.2.0+6", state: "running" }, { part: "keeper", version: "1.0.5", state: "running" }, { part: "hello-daemon", version: "0.1.0", state: "failed", error: "exit 1: нет файла конфигурации" }] } };
  };
  relay.handlers["releases.set"] = (f: Frame) => {
    const p = (plans[String(f.machine)] ??= {});
    const e = (p[String(f.part)] ??= {});
    if (f.pin === null) delete e.pin;
    else if (typeof f.pin === "string") e.pin = f.pin;
    if (typeof f.on === "boolean") e.on = f.on;
    return { ok: true, result: { machine: f.machine, rev: 10 } };
  };
  relay.handlers["releases.deploy"] = (f: Frame) =>
    f.part === "web-inbox" ? { ok: false, error: "check_failed" } : { ok: true, result: { parts: { [String(f.part)]: { from: "1.2.0+12", to: String(f.version) } } } };
  relay.handlers["keys.invite"] = (f: Frame) => ({ ok: true, result: { kid: "k9ab", invite: "k9ab.SECRETsecretSECRETsecretSECRETsecret1234567", addr: `${f.name}~${f.person}` } });
  relay.handlers["keys.revoke"] = (f: Frame) => ({ ok: true, result: { addr: passes.find((p) => p.id === f.kid)!.addr } });
  relay.handlers["github.app"] = () => ({ ok: true, result: { app: { slug: "switchboard-fleet" }, repos: ["you/switchboard", "you/profiles", "you/site"], install: "https://github.com/apps/switchboard-fleet/installations/new" } });
  relay.handlers["github.setup"] = (f: Frame) => ({ ok: true, result: { app: { slug: "switchboard-fleet" }, install: `https://github.com/apps/x?code=${f.code}` } });
  relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles: {}, repos: { "you/profiles": { state: "ok" } } } });
  // пропуска клиентов: стенд сам отвечает на keys.list машинами — здесь весь список gate
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const f = JSON.parse(String(init?.body)) as Frame;
    if (String(url) === FakeRelay.WORKERS.gate && f.type === "keys.list" && f.role === undefined) {
      relay.got.push(f);
      return Response.json({ type: "reply", id: f.id, ...(relay.handlers["keys.list"]?.(f) ?? { ok: true, result: { passes } }) });
    }
    return relay.fetch(url, init);
  }) as typeof globalThis.fetch;
  return { relay, plans, fetch };
}

async function settings(o: { wide?: boolean; url?: string; workers?: Record<string, string>; browser?: BrowserPush; hooks?(relay: FakeRelay): void } = {}) {
  const fl = fleet();
  o.hooks?.(fl.relay);
  const parts: AppPart[] = [
    { manifest: settingsM, module: createSettings },
    { manifest: alertsM, module: createAlerts(o.browser ?? fakeBrowser("granted")) },
  ];
  const t = await stand(parts, { relay: fl.relay, store: memoryStore({ key: "client.pult.k3f1.Qa7sig" }), wide: o.wide ?? true, url: o.url ?? "/#settings", options: { fetch: fl.fetch, ...(o.workers ? { workers: o.workers } : {}) } });
  await flush(10);
  const btn = (text: string | RegExp, scope: Element = t.root) =>
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""))) ?? null;
  const go = async (hash: string) => {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush(10);
  };
  const sent = (type: string) => fl.relay.got.filter((f) => f.type === type);
  const cell = (m: string, p: string) => t.$(`tr[data-machine="${m}"] td[data-part="${p}"]`)?.textContent ?? "";
  return { ...t, ...fl, btn, go, sent, cell };
}

describe("pult-settings", () => {
  it("5501 · выпуски по машинам: stable и сколько машин его держат; матрица машина × часть — stable, отстаёт, 📌, сбой, ушла; план машины сбоку — закрепить версию", async () => {
    const t = await settings();
    expect(t.$('[data-tab="releases"]')!.getAttribute("aria-selected")).toBe("true");
    expect(t.$('[data-roll="host"]')!.textContent).toContain("1.2.0+7");
    expect(t.$('[data-roll="host"]')!.textContent).toContain("1 из 2");
    expect(t.cell("laptop", "host")).toBe("1.2.0+7");
    expect(t.cell("laptop", "keeper")).toBe("📌 1.0.4");
    expect(t.cell("pc", "host")).toBe("1.2.0+6 → 1.2.0+7");
    expect(t.$('tr[data-machine="pc"] td[data-part="hello-daemon"] .st-cell')!.className).toContain("fail");
    expect(t.$('tr[data-machine="old"]')!.textContent).toContain("не на связи");
    await t.click(t.btn("@laptop"));
    const side = t.$('[data-plan="laptop"]')!;
    expect(side.querySelector('[data-part="keeper"]')!.textContent).toContain("1.0.4");
    await t.click(t.btn("📌 +6", side.querySelector('[data-part="host"]')!));
    expect(t.sent("releases.set").at(-1)).toMatchObject({ machine: "laptop", part: "host", pin: "1.2.0+6", to: ".releases" });
    expect(t.plans.laptop.host.pin).toBe("1.2.0+6");
    // stable снимает закрепление
    await t.click(t.btn("stable 1.0.5", t.$('[data-plan="laptop"] [data-part="keeper"]')!));
    expect(t.sent("releases.set").at(-1)).toMatchObject({ machine: "laptop", part: "keeper", pin: null });
  });

  it("5502 · несколько машин: отметить laptop и pc — закрепить host разом и вернуть к stable; часть машины выключается планом", async () => {
    const t = await settings();
    await t.click(t.$('tr[data-machine="laptop"] .st-ck'));
    await t.click(t.$('tr[data-machine="pc"] .st-ck'));
    expect(t.$("[data-bulk]")!.textContent).toContain("Выбрано 2");
    await t.click(t.btn("host: закрепить +6"));
    expect(t.sent("releases.set").map((f) => [f.machine, f.part, f.pin])).toEqual([
      ["laptop", "host", "1.2.0+6"],
      ["pc", "host", "1.2.0+6"],
    ]);
    expect(t.$("[data-bulk]")).toBeNull();
    await t.click(t.$('tr[data-machine="pc"] .st-ck'));
    await t.click(t.btn("host: к stable"));
    expect(t.sent("releases.set").at(-1)).toMatchObject({ machine: "pc", part: "host", pin: null });
    await t.click(t.btn("@pc"));
    await t.click(t.btn("включена", t.$('[data-plan="pc"] [data-part="hello-daemon"]')!));
    expect(t.sent("releases.set").at(-1)).toMatchObject({ machine: "pc", part: "hello-daemon", on: false });
    expect(t.cell("pc", "hello-daemon")).toBe("выключена");
  });

  it("5503 · каталог и сборки: «Выложить» edge — releases.deploy, итог словами; модуль сборки с отказом проверки — причина словами; «Вернуть» прежнюю сборку", async () => {
    const t = await settings();
    await t.click(t.btn("Каталог и сборки"));
    expect(t.$('tr[data-part="relay"]')!.textContent).not.toContain("Выложить");
    await t.click(t.btn("Выложить +13"));
    expect(t.sent("releases.deploy").at(-1)).toMatchObject({ part: "pult", version: "1.2.0+13", to: ".releases" });
    expect(t.text()).toContain("Выложено: pult 1.2.0+12 → 1.2.0+13");
    // модули сборок: в сборке 0.1.0, в каталоге 0.2.0 — «Выложить 0.2.0»; у web-core новее нет
    expect(t.$('tr[data-module="web-core"]')!.textContent).not.toContain("Выложить");
    await t.click(t.btn("Выложить 0.2.0", t.$('tr[data-module="web-inbox"]')!));
    expect(t.sent("releases.deploy").at(-1)).toMatchObject({ part: "web-inbox" });
    expect(t.text()).toContain("Не выложен web-inbox 0.2.0: проверка флота не прошла");
    await t.click(t.btn("Вернуть +11", t.$('tr[data-part="pult"]')!));
    expect(t.sent("releases.deploy").at(-1)).toMatchObject({ part: "pult", version: "1.2.0+11" });
    // история: вернуть можно и более раннюю сборку
    expect(t.btn("Вернуть +10", t.$('tr[data-part="pult"]')!)).not.toBeNull();
  });

  it("5504 · пропуска: пригласить устройство — keys.invite и ссылки #invite= на пульт и телефон, каждая копируется; отозвать с подтверждением — keys.revoke у relay; это устройство не отзывается", async () => {
    // источник: слово пользователя 3 нояб. — «отдавала инвайт сразу и линком на пульт и на телефон, копия по выбору»
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (s: string) => void writes.push(s) } });
    const t = await settings({ url: "/#settings?tab=passes", workers: { ...FakeRelay.WORKERS, phone: "https://phone.test/" } });
    expect(t.$('[data-passes="Машины"]')!.textContent).toContain("@laptop");
    // отозванных не показываем (слово пользователя 3 нояб.)
    expect(t.$('tr[data-pass="kr1"]')).toBeNull();
    const me = t.$('tr[data-pass="kc1"]')!;
    expect(me.textContent).toContain("это устройство");
    expect(t.btn("Отозвать…", me)).toBeNull();
    // колонки таблиц одинаковые
    expect(t.$$(".st-tbl colgroup").length).toBe(2);
    await t.click(t.btn("Пригласить"));
    const nameIn = t.$<HTMLInputElement>('[aria-label="Имя"]')!;
    nameIn.value = "laptop2";
    nameIn.dispatchEvent(new Event("input", { bubbles: true }));
    const who = t.$<HTMLInputElement>('[aria-label="Почта"]')!;
    who.value = "you@mail";
    who.dispatchEvent(new Event("input", { bubbles: true }));
    await t.click(t.btn("Пригласить", t.$("[data-invite]")!));
    expect(t.sent("keys.invite").at(-1)).toMatchObject({ role: "client", name: "laptop2", person: "you@mail", to: ".gate" });
    const inv = "k9ab.SECRETsecretSECRETsecretSECRETsecret1234567";
    expect(t.$("[data-link=\"Пульт\"] code")!.textContent).toBe(`${location.origin}/#invite=${inv}`);
    expect(t.$("[data-link=\"Телефон\"] code")!.textContent).toBe(`https://phone.test/#invite=${inv}`);
    // QR — ссылки на телефон (слово пользователя 3 нояб.)
    expect(t.$("[data-qr] svg")).not.toBeNull();
    expect(t.$("[data-qr]")!.dataset.qr).toBe(`https://phone.test/#invite=${inv}`);
    await t.click(t.btn("Копировать", t.$("[data-link=\"Телефон\"]")!));
    expect(writes).toEqual([`https://phone.test/#invite=${inv}`]);
    expect(t.$("[data-invited]")!.textContent).toContain("laptop2~you@mail");
    await t.click(t.btn("Готово"));
    const phone = t.$('tr[data-pass="kc2"]')!;
    await t.click(t.btn("Отозвать…", phone));
    await t.click(t.btn("Отозвать", t.$('tr[data-pass="kc2"]')!));
    expect(t.sent("keys.revoke").at(-1)).toMatchObject({ kid: "kc2", to: ".relay" });
  });

  it("5505 · GitHub и устройство: репозитории приложения с поиском, профилей на экране нет; устройство — адрес, пропуск, уведомления; телефон — только устройство", async () => {
    const t = await settings({ url: "/#settings?tab=general" });
    expect(t.$$("[data-github] .st-repo").map((r) => r.dataset.repo)).toEqual(["you/switchboard", "you/profiles", "you/site"]);
    expect(t.$("[data-profiles]")).toBeNull();
    expect(t.btn("Синхронизировать")).toBeNull();
    expect(t.sent("machine.profiles")).toHaveLength(0);
    const dev = t.$("[data-device]")!;
    expect(dev.textContent).toContain("pult~you@mail");
    expect(dev.textContent).toContain("действует");
    expect(dev.querySelector("[data-push]")!.textContent).toBe("выключены");

    const p = await settings({ wide: false, url: "/#settings" });
    expect(p.$("[data-device]")).not.toBeNull();
    expect(p.$("[data-github]")).toBeNull();
    expect(p.$('[data-tab="releases"]')).toBeNull();
    expect(p.sent("releases.list")).toHaveLength(0);
  });

  it("6104 · форма создания приложения GitHub уходит один раз: новое открытие экрана её не повторяет", async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    const t = await settings();
    t.relay.handlers["github.app"] = () => ({ ok: true, result: { app: null, form: { action: "https://github.com/settings/apps/new", manifest: { name: "x" } } } });
    await t.go("#settings?tab=general");
    await t.click(t.btn("Создать приложение GitHub"));
    expect(submit).toHaveBeenCalledTimes(1);
    await t.go("#settings?tab=releases");
    await t.go("#settings?tab=general");
    expect(submit).toHaveBeenCalledTimes(1);
    submit.mockRestore();
  });

  it("5506 · GitHub вернул ?code= — «Сохранить приложение» сохраняет его github.setup; поиск Ctrl K находит вкладки настроек", async () => {
    const t = await settings({ url: "/?code=gh123#settings?tab=general" });
    await t.click(t.btn("Сохранить приложение"));
    expect(t.sent("github.setup").at(-1)).toMatchObject({ code: "gh123", to: ".github" });
    expect(location.search).toBe("");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
    await flush();
    const q = document.querySelector<HTMLInputElement>(".sb-palin")!;
    q.value = "пропуска";
    q.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect([...document.querySelectorAll(".sb-palit .l")].map((x) => x.textContent)).toContain("Настройки: пропуска");
  });

  it("6946 · вкладки: «Выпуски» — releases.list и keeper.state; «Пропуска» — keys.list; «GitHub и устройство» — keys.list и github.app", async () => {
    // источник: факт — при открытии ответы владельцев своей вкладки
    const t = await settings();
    expect(t.sent("releases.list").length).toBeGreaterThan(0);
    expect(t.sent("keeper.state").length).toBeGreaterThan(0);
    expect(t.sent("github.app")).toHaveLength(0);
    const t2 = await settings({ url: "/#settings?tab=passes" });
    expect(t2.sent("keys.list").length).toBeGreaterThan(0);
    expect(t2.sent("releases.list")).toHaveLength(0);
    const t3 = await settings({ url: "/#settings?tab=general" });
    expect(t3.sent("keys.list").length).toBeGreaterThan(0);
    expect(t3.sent("github.app").length).toBeGreaterThan(0);
  });

  it("6947 · телефон: keys.list; github.app и keeper.state нет; виден раздел «Это устройство»", async () => {
    // источник: чьё: код
    const t = await settings({ wide: false });
    expect(t.sent("keys.list").length).toBeGreaterThan(0);
    expect(t.sent("github.app")).toHaveLength(0);
    expect(t.sent("keeper.state")).toHaveLength(0);
    expect(t.$("[data-device]")).not.toBeNull();
  });

  it("6948 · отозванные пропуска не показаны", async () => {
    // источник: слово пользователя 3 нояб.: отозванные не показываем
    const t = await settings({ url: "/#settings?tab=passes" });
    expect(t.text()).toContain("phone~you@mail");
    expect(t.text()).not.toContain("old~you@mail");
  });

  it("6949 · владелец отказал: на своей вкладке «запрос: слово»", async () => {
    // источник: устав — отказ словом
    const t = await settings({ hooks: (r) => (r.handlers["releases.list"] = () => ({ ok: false, error: "denied" })) });
    expect(t.text()).toContain("releases.list: denied");
    const t3 = await settings({ url: "/#settings?tab=general", hooks: (r) => (r.handlers["github.app"] = () => ({ ok: false, error: "no_app" })) });
    expect(t3.text()).toContain("github.app: no_app");
    const t2 = await settings({ url: "/#settings?tab=passes", hooks: (r) => (r.handlers["keys.list"] = () => ({ ok: false, error: "denied" })) });
    expect(t2.text()).toContain("keys.list: denied");
  });

  it("6989 · уведомления на устройстве: подписан — «включены»; браузер не умеет — своё слово, ошибок нет", async () => {
    // источник: факт — off: браузер не умеет; разрешение спрашивается только по нажатию
    const sub = fakeBrowser("granted");
    await (await sub.sw!.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array(1) });
    const t = await settings({ url: "/#settings?tab=general", browser: sub });
    expect(t.$("[data-device]")!.textContent).toContain("включены");
    expect(sub.calls).not.toContain("requestPermission");
    const t2 = await settings({ url: "/#settings?tab=general", browser: {} });
    expect(t2.$("[data-device]")!.textContent).toContain("браузер не умеет");
  });
});
