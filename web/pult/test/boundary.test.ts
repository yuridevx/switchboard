// Леса границы «оболочка приложения», сторона пульта и общее: оболочка страницы, обработчик пушей, статика, архив каталога.
// Вход — файл сборки build.json, браузерные API и команда сборки, исход — страница, кадры и файлы. Номер — эталон-источник; без номера — чьё: код.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { check, loadRepo, order } from "@switchboard/manifest-gate";
import { webBuild, type BuildList } from "@switchboard/release";
import { appGate, idbStore, memoryStore, type BuildOptions } from "@switchboard/web-core";
import { packFromRepo as packModule } from "../../../tools/release-cli/src/module.ts";
import { fakeScope } from "../../packages/alerts/stand/fakes.ts";
import { defined } from "../../packages/core/stand/app.ts";
import { FakeRelay, flush, KEY } from "../../packages/core/stand/relay.ts";
import { pultParts } from "../stand/parts.ts";
import { fleetRelay, fleetRoster, HOST, pult } from "./stand.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const app = join(here, "..");
const dist = join(app, "dist");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const QUESTION = {
  type: "question",
  from: "profiles@laptop",
  to: ["phone", "panel-desk"],
  question: "toolu_01Hq",
  kind: "ask",
  questions: [{ question: "Какую базу мигрировать первой?", header: "База", multiSelect: false, options: [{ label: "прод", description: "Боевая база" }, { label: "стенд", description: "Копия" }] }],
};

/** Список сборки пульта из into монорепо: имена и версии. */
function listOf(appName: string): BuildList {
  const mods = order(loadRepo(root).filter((m) => m.into?.includes(appName)));
  return { app: appName, version: "1.0.0+1", fleet: "test", modules: mods.map((m) => ({ name: m.name, version: m.version })), workers: FakeRelay.WORKERS };
}

/** Браузер без страницы: build.json на fetch, relay на WebSocket, хранилище страницы с ключом. */
async function browser(list: BuildList, relay = fleetRelay()) {
  vi.stubGlobal("indexedDB", new IDBFactory());
  await idbStore().set("key", KEY);
  const asked: Array<[string, RequestInit | undefined]> = [];
  vi.stubGlobal("fetch", async (u: string, o?: RequestInit) => {
    asked.push([String(u), o]);
    if (u === "./build.json") return { json: async () => list };
    return relay.fetch(u, o);
  });
  vi.stubGlobal("WebSocket", relay.WebSocket);
  return { relay, asked };
}

describe("состав приложения", () => {
  it("5138 · модули стенда пульта — те же, что в into пульта: свои восемь, набор проходит гейты монорепо и ядра", () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): список сборки — единственная запись состава
    const repo = loadRepo(root);
    expect(repo.filter((m) => m.name.startsWith("pult-")).map((m) => m.name).sort()).toEqual(["pult-accounts", "pult-incidents", "pult-journal", "pult-machines", "pult-open", "pult-points", "pult-profiles", "pult-settings"]);
    expect(check(repo)).toEqual([]);
    const want = order(repo.filter((m) => m.into?.includes("pult") && m.name !== "web-core")).map((m) => m.name);
    expect(pultParts().map((p) => p.manifest.name).sort()).toEqual([...want].sort());
    expect(want.length).toBe(17);
    expect(appGate(defined(pultParts()))).toEqual([]);
  });

  it("5193 · состав приложения — только into модулей: оболочка пульта и телефона пользуется лишь ядром страницы, снять любой модуль страницы её uses не мешает", () => {
    // источник: отчёт слепого архитектора 2 нояб.: состав приложения записан дважды (uses оболочки и into модулей)
    const repo = loadRepo(root).map(({ imports: _i, pkg: _p, dir: _d, ...m }) => m);
    for (const name of ["pult", "phone"]) {
      const shell = repo.find((m) => m.name === name)!;
      expect(Object.keys(shell.uses)).toEqual(["app@web-core"]);
      const set = repo.filter((m) => m.name === name || m.into?.includes(name));
      for (const gone of set.filter((m) => m.name !== name && m.name !== "web-core")) {
        expect(check(set.filter((m) => m !== gone)).filter((e) => e.startsWith(`модуль ${name}:`))).toEqual([]);
      }
    }
  });
});

describe("оболочка страницы", () => {
  it("main: build.json без кэша, модули — из списка, адрес relay — из списка, разделы, имя и широкий вид пульта", async () => {
    const list = { ...listOf("pult"), workers: { ...FakeRelay.WORKERS, relay: "https://relay.from-build/" } };
    const { relay, asked } = await browser(list);
    const urls: string[] = [];
    const WS = relay.WebSocket as unknown as new (u: string) => object;
    vi.stubGlobal(
      "WebSocket",
      class extends WS {
        constructor(u: string) {
          urls.push(u);
          super(u);
        }
      },
    );
    // загрузчик вместо import map браузера: те же модули, настоящая оболочка и настоящий старт сборки
    const set = pultParts();
    const load = async (name: string) => {
      const p = set.find((x) => x.manifest.name === name)!;
      return { default: p.module, manifest: p.manifest };
    };
    vi.doMock("../../shell.ts", async (real) => {
      const { boot } = (await real()) as typeof import("../../shell.ts");
      return { boot: (o: object) => boot({ ...o, load } as never) };
    });
    await import("../src/main.ts");
    await vi.waitFor(() => expect(document.querySelector(".sb-brand b")?.textContent, document.body.textContent ?? "").toBe("Пульт"), { timeout: 15_000 });
    await flush();
    expect(asked[0]).toEqual(["./build.json", { cache: "no-store" }]);
    expect([...document.querySelectorAll<HTMLElement>(".sb-navcol .sb-nv")].map((b) => b.dataset.screen)).toEqual(["inbox", "board", "incidents", "machines", "accounts", "profiles", "journal", "points", "settings"]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("wss://relay.from-build/m/"))).toBe(true);
  }, 30_000);

  it("список сборки не прочитан: причина на странице, обещание отказывает", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("сети нет");
    });
    const { boot } = await import("../../shell.ts");
    await expect(boot({})).rejects.toThrow("сети нет");
    expect(document.getElementById("app")!.textContent).toBe("Сборка не загрузилась: сети нет");
  });

  it("список сборки молчит: через 30 с причина на странице", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { boot } = await import("../../shell.ts");
    const run = boot({}).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(document.getElementById("app")!.textContent).toBe("");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await run).toBe("нет ответа за 30 с");
    expect(document.getElementById("app")!.textContent).toBe("Сборка не загрузилась: нет ответа за 30 с");
  });

  it("ядро страницы не загрузилось: причина на странице, обещание отказывает", async () => {
    // чьё: код; файл ядра страницы лежит рядом со списком сборки и может не прийти
    vi.stubGlobal("fetch", async () => ({ json: async () => listOf("pult") }));
    vi.doMock("@switchboard/web-core", () => {
      throw new Error("файла ядра нет");
    });
    const { boot } = await import("../../shell.ts");
    const why = await boot({}).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(why).not.toBe("");
    expect(document.getElementById("app")!.textContent).toBe(`Сборка не загрузилась: ${why}`);
  });

  it("ядро страницы молчит: через 30 с причина на странице", async () => {
    // устав: у всех операций есть предел
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => ({ json: async () => listOf("pult") }));
    vi.doMock("@switchboard/web-core", () => new Promise(() => {}));
    const { boot } = await import("../../shell.ts");
    const run = boot({}).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await run).toBe("нет ответа за 30 с");
    expect(document.getElementById("app")!.textContent).toBe("Сборка не загрузилась: нет ответа за 30 с");
  });

  it("ядро отказало при старте: причина на странице, обещание отказывает", async () => {
    // чьё: код
    vi.stubGlobal("fetch", async () => ({ json: async () => listOf("pult") }));
    vi.doMock("@switchboard/web-core", () => ({
      startBuild: async () => {
        throw new Error("старт отказал");
      },
    }));
    const { boot } = await import("../../shell.ts");
    await expect(boot({})).rejects.toThrow("старт отказал");
    expect(document.getElementById("app")!.textContent).toBe("Сборка не загрузилась: старт отказал");
  });

  it("6903 · колонка разделов: «Перейти… Ctrl K», Вам, Работа, Инциденты, группа «Флот» с профилями; машин и имени устройства в колонке нет", async () => {
    // источник: прототип «Пульт и телефон» (подписан пользователем 2 нояб.); «не нужны внизу машины» — комментарий пользователя
    const t = await pult();
    expect(t.$$(".sb-navcol .sb-nv").map((b) => b.dataset.screen)).toEqual(["inbox", "board", "incidents", "machines", "accounts", "profiles", "journal", "points", "settings"]);
    expect(t.$$(".sb-navcol .sb-grp").map((x) => x.textContent)).toEqual(["Флот"]);
    expect(t.$(".sb-navcol .sb-nv.sub")).toBeNull();
    expect(t.$(".sb-goto")).not.toBeNull();
    expect(t.$(".sb-nm, .sb-me")).toBeNull();
    expect(t.$(".sb-brand b")!.textContent).toBe("Пульт");
  });

  it.each([
    ["inbox", "card", "#card?callsign=site%40laptop"],
    ["inbox", "chat", "#chat?callsign=site%40laptop"],
    ["inbox", "ask", "#ask?callsign=profiles%40laptop"],
    ["inbox", "open", "#open"],
    ["board", "card", "#card?callsign=site%40laptop"],
    ["board", "chat", "#chat?callsign=site%40laptop"],
    ["board", "ask", "#ask?callsign=profiles%40laptop"],
    ["board", "open", "#open"],
    ["incidents", "card", "#card?callsign=site%40laptop"],
    ["incidents", "chat", "#chat?callsign=site%40laptop"],
    ["incidents", "ask", "#ask?callsign=profiles%40laptop"],
    ["incidents", "open", "#open"],
  ])("beside: от «%s» экран %s открывается справа, список остаётся", async (list, screen, hash) => {
    const t = await pult({ url: `/#${list === "board" ? "sessions" : list}` });
    await t.go(hash);
    expect(t.$(".sb-master")?.getAttribute("data-screen")).toBe(list);
    expect(t.$(".sb-screen")!.getAttribute("data-screen")).toBe(screen);
    expect(t.$('.sb-navcol .sb-nv[aria-current="page"]')!.dataset.screen).toBe(list);
  });

  it("не список («Машины»): второй экран рядом с «Работой», а не с ним", async () => {
    const t = await pult({ url: "/#machines" });
    await t.go("#card?callsign=site%40laptop");
    expect(t.$(".sb-master")!.getAttribute("data-screen")).toBe("board");
    expect(t.$(".sb-screen")!.getAttribute("data-screen")).toBe("card");
  });

  it("сквозной флоу: вопрос приходит кадром, строка «Работы» показывает его, чат рядом со списком отвечает", async () => {
    const relay = fleetRelay();
    relay.handlers["question.list"] = () => ({ ok: true, result: [{ question: QUESTION.question, kind: "ask", questions: QUESTION.questions }] });
    relay.handlers.answer = () => ({ ok: true });
    const t = await pult({ relay });
    relay.push(QUESTION);
    await flush();
    expect(t.$('[data-callsign="profiles@laptop"] .bd-t2')!.textContent).toBe("? Какую базу мигрировать первой?");
    await t.click(t.$('[data-callsign="profiles@laptop"]'));
    expect(t.$(".bd-row")).not.toBeNull();
    expect(t.$(".chat-ask")!.textContent).toContain("Какую базу мигрировать первой?");
    await t.click(t.btn(t.$(".chat-ask"), /^стенд/));
    await t.click(t.btn(t.$(".chat-ask"), "Ответить"));
    expect(relay.sent("answer")).toEqual([expect.objectContaining({ v: 1, callsign: "profiles@laptop", question: "toolu_01Hq", answers: { "Какую базу мигрировать первой?": "стенд" } })]);
    expect(t.$(".chat-ask")!.textContent).toContain("Ответ «стенд» принят.");
  });

  it("188 · у pc нет session.files и session.call: у poe-bot нет «@», «/», сведений и «Прервать», запросов к pc нет; у site — есть, session.files ушёл", async () => {
    const r = fleetRoster();
    const pc = { ...HOST };
    delete pc["session.files"];
    delete pc["session.call"];
    r.machines[1].contract = pc;
    const relay = fleetRelay(r);
    relay.handlers["session.files"] = () => ({ ok: true, result: ["src/worker.ts", "test/worker.test.ts"] });
    const t = await pult({ relay });
    await t.expand();
    await t.click(t.$('[data-callsign="poe-bot@pc"]'));
    await t.type(t.$(".chat-inp"), "@");
    expect(t.$('[aria-label="Файл папки"]')).toBeNull();
    expect(t.$('[aria-label="Команда"]')).toBeNull();
    expect(t.btn(null, "Прервать")).toBeNull();
    await t.click(t.$('.cw-tabs [data-tab="set"]'));
    expect(t.$('[data-sec="call"]')).toBeNull();
    expect(t.btn(null, "Прервать")).toBeNull();
    expect(relay.got.filter((f) => (f.type === "session.files" || f.type === "session.call") && String(f.callsign).endsWith("@pc"))).toEqual([]);

    await t.click(t.$('[data-callsign="site@laptop"]'));
    expect(t.$('[aria-label="Файл папки"]')).not.toBeNull();
    expect(t.$('[aria-label="Команда"]')).not.toBeNull();
    expect(t.btn(null, "Прервать")).not.toBeNull();
    await t.type(t.$(".chat-inp"), "Сравни с @wor");
    expect(relay.sent("session.files")).toEqual([expect.objectContaining({ callsign: "site@laptop", query: "wor", limit: 20 })]);
    expect(t.$$(".chat-sugi").map((b) => b.textContent)).toEqual(["src/worker.ts", "test/worker.test.ts"]);
    await t.click(t.$(".chat-sugi"));
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("Сравни с @src/worker.ts ");
  });
});

describe("обработчик пушей", () => {
  /** Кнопка уведомления: адрес relay обработчик берёт из build.json рядом, ключ — из хранилища страницы. */
  async function clicked(answerList: () => Promise<{ json(): Promise<unknown> }>) {
    const relay = new FakeRelay(fleetRoster());
    relay.handlers.answer = () => ({ ok: true });
    vi.stubGlobal("indexedDB", new IDBFactory());
    await idbStore().set("key", KEY);
    const scope = fakeScope();
    vi.stubGlobal("self", scope);
    const urls: string[] = [];
    const WS = relay.WebSocket as unknown as new (u: string) => object;
    vi.stubGlobal(
      "WebSocket",
      class extends WS {
        constructor(u: string) {
          urls.push(u);
          super(u);
        }
      },
    );
    const asked: unknown[][] = [];
    vi.stubGlobal("fetch", (...a: unknown[]) => {
      asked.push(a);
      return answerList();
    });
    await import("../../sw.ts");
    const frame = { type: "answer", v: 1, callsign: "profiles@laptop", question: "toolu_01Hx", answers: { "База?": "стенд" } };
    await scope.fire("push", { data: { json: () => ({ type: "question", from: "profiles@laptop", notify: { title: "t", body: "b", tag: "toolu_01Hx", actions: [{ title: "стенд", frame }] } }) } });
    return { relay, scope, urls, asked };
  }

  it("кнопка уведомления: адрес relay — из build.json сборки, без кэша; ключ — из хранилища страницы; кадр кнопки ушёл", async () => {
    const { relay, scope, urls, asked } = await clicked(async () => ({ json: async () => ({ workers: { ...FakeRelay.WORKERS, relay: "https://relay.from-build/" } }) }));
    expect(asked[0]).toEqual(["./build.json", { cache: "no-store" }]);
    expect(scope.shown).toHaveLength(1);
    await scope.fire("notificationclick", { action: "0", notification: { data: scope.shown[0].o.data, close: () => {} } });
    await flush();
    expect(urls).toEqual(["wss://relay.from-build/m/laptop"]);
    expect(relay.hellos[0]).toMatchObject({ key: KEY });
    expect(relay.got.find((f) => f.type === "answer")).toMatchObject({ callsign: "profiles@laptop", question: "toolu_01Hx" });
  });

  it("список сборки молчит 30 с: кнопка не молчит, «Ответ не отправлен: …» с тем же текстом и tag, сокета нет", async () => {
    // опыт в настоящем Chromium: без адреса нажатие закрывало уведомление, причины человек не видел
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { scope, urls } = await clicked(() => new Promise(() => {}));
    expect(scope.shown).toHaveLength(1);
    const click = scope.fire("notificationclick", { action: "0", notification: { data: scope.shown[0].o.data, close: () => {} } });
    // ключ из хранилища прочитан, обработчик ждёт адрес
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(30_000);
    await click;
    expect(scope.shown[1]).toMatchObject({ title: "Ответ не отправлен: нет ответа за 30 с", o: { body: "b", tag: "toolu_01Hx" } });
    expect(urls).toEqual([]);
  });
});

describe("кнопки уведомления", () => {
  // чьё: код; сколько кнопок вмещает уведомление, говорит браузер
  it.each([
    [2, 2],
    [1, 0],
    [undefined, 0],
  ])("браузер вмещает %s: две кнопки показаны числом %i", async (maxActions, shown) => {
    vi.stubGlobal("Notification", { maxActions });
    vi.stubGlobal("indexedDB", new IDBFactory());
    const scope = fakeScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("fetch", async () => ({ json: async () => ({ workers: FakeRelay.WORKERS }) }));
    await import("../../sw.ts");
    const frame = { type: "answer", callsign: "profiles@laptop" };
    const actions = [{ title: "да", frame }, { title: "нет", frame }];
    await scope.fire("push", { data: { json: () => ({ type: "question", from: "profiles@laptop", notify: { title: "t", actions } }) } });
    expect(scope.shown[0].o.actions).toHaveLength(shown);
  });
});

describe("статика и архив", () => {
  it("4187 · dist: app.js, sw.js, статика и значки; адресов relay и Worker'ов, модулей и ключа флота нет; значки те же; обработчик пушей работает из своего файла", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): адресов relay в коде оболочек 0
    // чьё: код; в архив каталога идёт вся папка: сборка начинает с чистой
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "stale.js"), "");
    const r = spawnSync(process.execPath, [join(app, "build.mjs")], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readdirSync(dist).sort()).toEqual(["app.js", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "index.html", "manifest.webmanifest", "sw.js"]);
    for (const f of ["app.js", "sw.js", "index.html"]) {
      const text = readFileSync(join(dist, f), "utf8");
      expect(text).not.toMatch(/wss:\/\/|workers\.dev|pfarm\.app/);
      expect(text).not.toMatch(/client\.[a-z-]+\.[a-z0-9]+\./);
    }
    // модули — в m/ сборки, а не в оболочке: экранов модулей в app.js нет
    expect(readFileSync(join(dist, "app.js"), "utf8")).not.toContain("Новая сессия");
    // обработчик пушей — классический скрипт, рантайма страницы в нём нет
    expect(readFileSync(join(dist, "sw.js"), "utf8")).not.toMatch(/createRoot|^import /m);
    expect(readFileSync(join(dist, "app.js"), "utf8")).not.toMatch(/^import /m);
    expect(readFileSync(join(dist, "index.html"), "utf8")).toContain('<script src="app.js" defer></script>');
    for (const f of ["index.html", "manifest.webmanifest"]) expect(readFileSync(join(dist, f), "utf8")).toBe(readFileSync(join(app, "public", f), "utf8"));
    const png = (f: string) => createHash("sha256").update(readFileSync(join(dist, f))).digest("hex").slice(0, 16);
    expect(["icon-192.png", "icon-512.png", "apple-touch-icon.png"].map(png)).toEqual(ICONS);
    expect(r.stdout).toContain("pult: dist/ собран — оболочка без модулей и адресов");
    // опыт в настоящем Chromium: зелёные леса, а с внешним импортом регистрация падает; у обработчика нет загрузчика и карты импорта
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("fetch", async () => ({ json: async () => ({ workers: FakeRelay.WORKERS }) }));
    const scope = fakeScope();
    new Function("self", readFileSync(join(dist, "sw.js"), "utf8"))(scope);
    await scope.fire("push", { data: { json: () => ({ type: "message", notify: { title: "t" } }) } });
    expect(scope.shown[0].title).toBe("t");
  }, 60_000);

  it("5137 · оболочка и модули из архивов, раскладка сборки, старт по build.json: модули загружены, разделы оболочки, адрес relay — из списка", async () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): «Выпуски» собирают пульт из каталога;
    // модули, адреса relay и Worker'ов страница берёт из списка сборки
    const repo = loadRepo(root);
    const mods = order(repo.filter((m) => m.into?.includes("pult")));
    const shell = packModule(join(root, "web/pult"));
    const packed = mods.map((m) => packModule(join(root, m.dir)));
    const list: BuildList = {
      app: "pult",
      version: `${shell.version}+1`,
      fleet: "test",
      modules: packed.map((p) => ({ name: p.name, version: p.version })),
      workers: { ...FakeRelay.WORKERS, relay: "https://relay.from-build/" },
    };
    const files = webBuild(shell.tgz, packed, list);
    expect(files.filter((f) => f.path.startsWith("m/")).length).toBe(18);

    // сборка на диске; m/<модуль>.<версия>.js — пакетом @switchboard/<модуль>, как import map страницы
    const dir = mkdtempSync(join(tmpdir(), "switchboard-pult-build-"));
    for (const f of files) {
      const m = /^m\/(.+?)\.\d+\.\d+\.\d+\.js$/.exec(f.path);
      const p = m ? join(dir, "node_modules", "@switchboard", m[1]) : join(dir, ...dirname(f.path).split("/"));
      mkdirSync(p, { recursive: true });
      if (!m) writeFileSync(join(dir, ...f.path.split("/")), f.data);
      else {
        writeFileSync(join(p, "package.json"), JSON.stringify({ name: `@switchboard/${m[1]}`, type: "module", exports: "./index.js" }));
        writeFileSync(join(p, "index.js"), f.data);
      }
    }
    const at = (name: string) => pathToFileURL(join(dir, "node_modules", "@switchboard", name, "index.js")).href;
    const core = (await import(/* @vite-ignore */ at("web-core"))) as { startBuild(o: BuildOptions): Promise<{ ready: Promise<void>; failed: Record<string, string>; stopped: string | null }> };
    const { PULT } = await import("../src/options.ts");

    const relay = new FakeRelay(fleetRoster());
    const urls: string[] = [];
    const WS = relay.WebSocket as unknown as new (u: string) => object;
    const run = await core.startBuild({
      root: document.getElementById("app")!,
      build: JSON.parse(files.find((f) => f.path === "build.json")!.data.toString()),
      load: (name) => import(/* @vite-ignore */ at(name)),
      fetch: relay.fetch,
      store: memoryStore({ key: KEY }),
      WebSocket: class extends WS {
        constructor(u: string) {
          urls.push(u);
          super(u);
        }
      } as never,
      platform: { ios: false, standalone: false },
      pauseMs: 5,
      ...PULT,
    });
    await run.ready;
    await flush();
    expect(run.stopped).toBeNull();
    expect(run.failed).toEqual({});
    expect([...document.querySelectorAll<HTMLElement>(".sb-navcol .sb-nv")].map((b) => b.dataset.screen)).toEqual(["inbox", "board", "incidents", "machines", "accounts", "profiles", "journal", "points", "settings"]);
    expect(document.querySelector(".sb-brand b")!.textContent).toBe("Пульт");
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("wss://relay.from-build/m/"))).toBe(true);
  }, 120_000);
});

const ICONS = ["5c52146e1da8e8f2", "fcb1346571a28910", "10c5d6b0c4d007a1"];
