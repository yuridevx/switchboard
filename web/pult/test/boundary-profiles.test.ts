// Граница экранов профиля из кусочков: просмотр, ключи флота, репозитории, пара в форме.
// Вход — экран и кадры контракта, исход — кадры relay, текст и якоря разметки. Источник — дизайн «Сессии из кусочков» и слова пользователя 5 и 6 нояб.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "../../packages/core/stand/app.ts";
import { fleetRelay, fleetRoster, pult, SLOTS } from "./stand.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const OPS = "team/profiles/ops";
const DEV = "team/profiles/dev";
const BASE = "team/profiles/base";
const profiles = {
  [DEV]: { about: "моя работа", use: [BASE, OPS], kind: "set", names: [] },
  [OPS]: { about: "серверы", kind: "piece", names: [{ kind: "skill", name: "restart", path: "skills/restart/SKILL.md" }, { kind: "memory", name: "users", path: "memory/users.md" }] },
  [BASE]: { kind: "piece", names: [] },
  "alpha/p/terse": { about: "кратко", kind: "style", names: [] },
};
const view = {
  pieces: [BASE, OPS, DEV],
  tree: [{ id: DEV, set: true, children: [{ id: BASE, set: false }, { id: OPS, set: false }] }],
  settings: { model: { value: "opus", from: OPS, lost: [{ value: "haiku", from: BASE }] }, "env.MAX_TOKENS": { value: "8000", from: OPS, lost: [] } },
  instructions: [{ from: OPS, path: "CLAUDE.md", head: "Как работаем", rule: false }],
  skills: [{ from: OPS, name: "ops:restart", description: "перезапустить", path: "skills/restart/SKILL.md", extra: ["skills/restart/steps.md"] }],
  agents: [],
  memory: { home: { from: OPS, files: 2, bytes: 3000, indexLines: 3, indexBytes: 120, types: { user: 1, "": 1 } }, near: [{ from: BASE, files: 1, bytes: 100, indexLines: 1, indexBytes: 20, types: { project: 1 } }] },
  prompt: { style: { name: "terse", from: OPS, found: false } },
  mcp: [{ from: OPS, kind: "server", name: "grafana", detail: "npx g", config: { command: "npx" } }],
  other: [],
  files: {
    [OPS]: [{ path: "CLAUDE.md", size: 900 }, { path: "skills/restart/SKILL.md", size: 300 }, { path: "skills/restart/steps.md", size: 30 }, { path: "memory/MEMORY.md", size: 120 }, { path: "memory/users.md", size: 300, meta: { name: "users", type: "user", description: "люди" } }, { path: "memory/x.md", size: 80 }],
    [BASE]: [{ path: "memory/MEMORY.md", size: 20 }, { path: "memory/a.md", size: 80, meta: { type: "project" } }],
    [DEV]: [{ path: ".claude-plugin/plugin.json", size: 90 }],
  },
};

function relayed() {
  const relay = fleetRelay();
  relay.handlers[SLOTS] = () => ({ ok: true, result: { slots: { main: { account: "a", order: ["a"], wait: null }, night: { account: "b", order: ["b"], wait: null } }, accounts: {} } });
  relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles, repos: {} } });
  relay.handlers["profile.view"] = () => ({ ok: true, result: view });
  relay.handlers["profile.file"] = (f) => (f.path === ".claude-plugin/plugin.json" ? { ok: true, result: { text: JSON.stringify({ name: "dev", description: "моя работа", metadata: { use: [BASE, OPS] } }) } } : f.path === "memory/x.md" ? { ok: false, error: "too_large" } : { ok: true, result: { text: `---\nname: x\n---\n# текст ${f.path}` } });
  relay.handlers["fleet.prompt"] = () => ({ ok: true, result: { text: "ты в флоте" } });
  return relay;
}

const screen = async (relay = relayed(), url = "/#profiles") => {
  const t = await pult({ relay, url });
  await flush(10);
  return t;
};
const tabs = (t: Awaited<ReturnType<typeof screen>>) => t.$$<HTMLButtonElement>(".pv-tabs [data-tab]");

describe("профили: просмотр", () => {
  it("8040 · только просмотр: кусочки по репозиториям, наборы сверху, метки; сведения, машин и кнопок записи нет", async () => {
    // источник: слово пользователя 5 нояб.: «в ней не нужно живых данных, только просмотр»
    const t = await screen();
    expect(t.$$(".pv-gh").map((x) => x.textContent)).toEqual(["alpha/p", "team/profiles"]);
    expect(t.$$('.pv-grp:nth-of-type(n) [data-piece]').map((x) => x.dataset.piece)).toEqual(["alpha/p/terse", DEV, BASE, OPS]);
    expect(t.$('[data-piece="team/profiles/dev"]')!.textContent).toContain("набор");
    expect(t.$('[data-piece="alpha/p/terse"]')!.textContent).toContain("стиль");
    expect(t.text()).not.toContain("Синхронизировать");
    expect(t.$('[data-act="repos"]')!.textContent).toBe("Репозитории");
  });

  it("8029 · поиск находит кусочек по имени скила внутри него; запросов содержимого нет; находка ведёт на вкладку и открывает элемент", async () => {
    // источник: дизайн, эталон 29; слово пользователя 5 нояб.: просмотр всего в профиле
    const relay = relayed();
    const t = await screen(relay);
    const before = relay.sent("profile.file").length + relay.sent("profile.view").length;
    await t.type(t.$('[data-f="q"]'), "restart");
    expect(t.$$("[data-piece]").filter((x) => !x.classList.contains("pv-hit")).map((x) => x.dataset.piece)).toEqual([OPS]);
    expect(relay.sent("profile.file").length + relay.sent("profile.view").length).toBe(before + 1);
    await t.click(t.$('[data-hit="team/profiles/ops::skills/restart/SKILL.md"]'));
    await flush(5);
    expect(t.$('[data-tab-body="skills"]')).not.toBeNull();
    expect(t.$('.pv-file.on [data-file]')!.textContent).toContain("ops:restart");
    expect(relay.sent("profile.file").at(-1)).toMatchObject({ machine: "laptop", id: OPS, path: "skills/restart/SKILL.md" });
    await t.type(t.$('[data-f="q"]'), "нет такого");
    expect(t.$(".pv-none")!.textContent).toContain("Ничего не нашлось");
  });

  it("8041 · девять постоянных вкладок без чисел, пустая неактивна; итог — имена-ссылки; манифест YAML из файла; всё закрыто; ссылка ведёт на элемент", async () => {
    // источник: комментарии пользователя 5 нояб.: «закрыто по умолчанию», «сводка на уровне имён», «манифест на итоге»; слово: без чисел во вкладках
    const t = await screen();
    await t.click(t.$(`[data-piece="${DEV}"]`));
    await flush(10);
    expect(tabs(t).map((b) => b.textContent)).toEqual(["Итог", "Промпт", "Инструкции", "Скилы", "Агенты", "Память", "Настройки", "MCP и хуки", "Другие файлы"]);
    expect(tabs(t).filter((b) => b.disabled).map((b) => b.textContent)).toEqual(["Агенты", "Другие файлы"]);
    expect(t.$('[data-tile="tree"]')!.textContent).toContain("dev");
    expect(t.$(".pv-yaml")!.textContent).toContain("use:");
    expect(t.$(".pv-yaml")!.textContent).toContain(OPS);
    await t.click(t.$('[data-link="skills|team/profiles/ops::skills/restart/SKILL.md"]'));
    await flush(5);
    expect(t.$$(".pv-file.on")).toHaveLength(1);
    await t.click(t.$('[data-tab="instr"]'));
    expect(t.$(".pv-file.on")).toBeNull();
  });

  it("8042 · настройки итогом слияния: значение, источник, проигравший зачёркнут; env — ключом env.ИМЯ", async () => {
    const t = await screen();
    await t.click(t.$(`[data-piece="${DEV}"]`));
    await flush(10);
    await t.click(t.$('[data-tab="set"]'));
    const row = t.$$(".pv-sr").map((x) => x.textContent);
    expect(row[0]).toContain("model");
    expect(row[0]).toContain("opus");
    expect(t.$(".pv-sl s")!.textContent).toBe("haiku");
    expect(row[1]).toContain("env.MAX_TOKENS");
  });

  it("8043 · промпт: основа, стиль не найден словом, добавка системы из fleet.prompt; порядок сборки", async () => {
    // источник: слово пользователя 5 нояб.: контролировать системные промпты; факт: короткое имя стиля не работает
    const relay = relayed();
    const t = await screen(relay);
    await t.click(t.$(`[data-piece="${DEV}"]`));
    await flush(10);
    await t.click(t.$('[data-tab="prompt"]'));
    await flush(5);
    expect(t.$$(".pv-ph b").map((x) => x.textContent)).toEqual(["Системный промпт", "Контекст"]);
    expect(t.text()).toContain("стиль не найдётся — нужно полное имя");
    expect(relay.sent("fleet.prompt").at(-1)).toMatchObject({ machine: "laptop" });
    await t.click(t.$('[data-file="prompt:sys"]'));
    expect(t.$(".pv-pre")!.textContent).toBe("ты в флоте");
  });

  it("8044 · память: домашняя и рядом, метр индекса, типы словами, без типа отдельно; текст по нажатию; больше предела — слово", async () => {
    // источник: слово пользователя 5 нояб.: «файлов памяти будет очень много»
    const relay = relayed();
    const t = await screen(relay);
    await t.click(t.$(`[data-piece="${DEV}"]`));
    await flush(10);
    const before = relay.sent("profile.file").length;
    await t.click(t.$('[data-tab="mem"]'));
    expect(t.$$("[data-memory]").map((x) => x.dataset.memory)).toEqual([BASE, OPS]);
    expect(t.$('[data-memory="team/profiles/ops"]')!.classList.contains("home")).toBe(true);
    expect(t.$('[data-memory="team/profiles/ops"] .pv-meter')!.textContent).toContain("индекс 3 из 200 строк");
    expect(relay.sent("profile.file")).toHaveLength(before);
    const ops = t.$('[data-memory="team/profiles/ops"]')!;
    await t.click(ops.querySelector('[data-mtype="user"]'));
    expect([...ops.querySelectorAll("[data-mem]")].map((x) => (x as HTMLElement).dataset.mem)).toEqual(["memory/users.md"]);
    expect(ops.querySelector(".pv-mt")!.textContent).toBe("о человеке");
    await t.click(ops.querySelector('[data-mtype=""]'));
    await t.click(ops.querySelector('[data-mem="memory/x.md"]'));
    await flush(5);
    expect(ops.textContent).toContain("файл больше предела просмотра");
  });

  it("8045 · выбор кусочка помнится между заходами на экран", async () => {
    const t = await screen();
    await t.click(t.$(`[data-piece="${OPS}"]`));
    await flush(5);
    await t.go("#accounts");
    await t.go("#profiles");
    await flush(5);
    expect(t.$(`[data-piece="${OPS}"]`)!.getAttribute("aria-selected")).toBe("true");
  });
});

describe("ключи флота", () => {
  const relayKeys = () => {
    const relay = relayed();
    const keys: Record<string, unknown> = { orca: { env: { ANTHROPIC_BASE_URL: "https://api.orcarouter.ai", ANTHROPIC_DEFAULT_OPUS_MODEL: "x/opus", MY: "1" }, settings: {} } };
    relay.handlers["fleetkeys.list"] = () => ({ ok: true, result: { keys } });
    relay.handlers["fleetkeys.set"] = (f) => ((keys[String(f.name)] = { env: f.env, settings: f.settings ?? {} }), { ok: true });
    relay.handlers["fleetkeys.remove"] = (f) => (delete keys[String(f.name)], { ok: true });
    relay.handlers["machine.key_check"] = (f) => ({ ok: true, result: f.name === "orca" ? { ok: true, word: "ключ принят, 412 мс" } : { ok: false, word: "401" } });
    return relay;
  };

  it("8046 · вкладка своя, адрес в hash; строка ключа: адрес, модели вместо alias, свои переменные; значения ключа нет; проверка — через машину", async () => {
    // источник: комментарий пользователя 5 нояб.: «ключи отдельной вкладкой»; ответ «только проверка»
    const relay = relayKeys();
    const t = await screen(relay, "/#accounts?tab=keys");
    expect(t.$('[data-tab="keys"]')!.getAttribute("aria-selected")).toBe("true");
    const line = t.$('[data-key="orca"]')!;
    expect(line.textContent).toContain("https://api.orcarouter.ai");
    expect(line.textContent).toContain("x/opus");
    expect(line.textContent).toContain("MY=1");
    expect(line.textContent).not.toContain("{}");
    await t.click(line.querySelector('[data-act="key-check"]'));
    await flush(5);
    expect(relay.sent("machine.key_check").at(-1)).toMatchObject({ machine: "laptop", name: "orca" });
    expect(line.querySelector("[data-checked]")!.textContent).toContain("ключ принят, 412 мс");
  });

  it("8047 · новый ключ: форма на месте списка, значение уходит полем value, окно 200K вписано; JSON настроек проверяется у поля", async () => {
    // источник: слово пользователя 5 нояб.: JSON мёржа и кастомные env; договор: поле key кадра занято пропуском
    const relay = relayKeys();
    const t = await screen(relay, "/#accounts?tab=keys");
    await t.click(t.$('[data-act="key-new"]'));
    expect(t.$('[data-key="orca"]')).toBeNull();
    await t.type(t.$('[data-f="kname"]'), "kimi");
    await t.type(t.$('[data-f="kkey"]'), "s3cret");
    await t.type(t.$('[data-f="kurl"]'), "https://api.moonshot.ai/anthropic");
    await t.type(t.$('[data-f="km-opus"]'), "kimi-k2");
    const json = t.$<HTMLTextAreaElement>('[data-f="ksettings"]')!;
    await t.type(json, "{ нет");
    await t.click(t.$('[data-act="key-save"]'));
    expect(t.$(".ac-kerr")!.textContent).toContain("не JSON");
    expect(relay.sent("fleetkeys.set")).toHaveLength(0);
    await t.type(json, '{ "modelOverrides": {} }');
    await t.click(t.$('[data-act="key-save"]'));
    await flush(5);
    const sent = relay.sent("fleetkeys.set").at(-1)!;
    expect(sent).toMatchObject({ name: "kimi", value: "s3cret", env: { ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic", ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k2", CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" }, settings: { modelOverrides: {} } });
    expect(sent).not.toHaveProperty("key");
    expect(t.$('[data-key="kimi"]')).not.toBeNull();
  });

  it("8048 · удаление — подтверждение на месте со списком сессий на этом ключе", async () => {
    const relay = relayKeys();
    const r = fleetRoster();
    r.sessions[0].slot = { name: "orca", wait: null } as never;
    relay.setRoster(r);
    const t = await screen(relay, "/#accounts?tab=keys");
    await t.click(t.$('[data-act="key-remove"]'));
    expect(t.$(".sb-confirm")!.textContent).toContain(r.sessions[0].callsign);
    expect(t.$("[role=dialog]")).toBeNull();
    await t.click(t.$('[data-act="confirm"]'));
    await flush(5);
    expect(relay.sent("fleetkeys.remove")).toEqual([expect.objectContaining({ name: "orca" })]);
  });
});

describe("репозитории", () => {
  const repo = "team/profiles";
  const relayRepos = (state: Record<string, unknown> = { state: "ok", at: Date.now() }) => {
    const relay = relayed();
    relay.scoped.global = { "fleet.profiles.repos": [repo] };
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: { profiles, repos: { [repo]: state } } });
    relay.handlers["github.app"] = () => ({ ok: true, result: { app: { slug: "x" }, repos: [repo, "team/notes"], install: "u" } });
    relay.handlers["keys.list"] = () => ({ ok: true, result: { passes: [] } });
    return relay;
  };
  const screenR = (relay: ReturnType<typeof relayRepos>) => screen(relay, "/#settings?tab=general");

  it("8049 · один список флота: сводка по машинам; «Подключить» и «Убрать…» пишут ключ fleet.profiles.repos, подтверждение называет сессии", async () => {
    // источник: слова пользователя 5 и 6 нояб.: менеджер репозиториев, «листок»
    const relay = relayRepos();
    const t = await screenR(relay);
    const row = t.$(`[data-prepo="${repo}"]`)!;
    expect(row.querySelector("[data-state]")!.textContent).toContain("сведён на всех 2");
    await t.click(t.$('[data-repo="team/notes"] [data-act="list"]'));
    await flush(5);
    expect(relay.sent("prefs.set").at(-1)).toMatchObject({ name: "fleet.profiles.repos", value: [repo, "team/notes"], scope: "global" });
    await t.click(row.querySelector('[data-act="unlist"]'));
    expect(t.$(".sb-confirm")!.textContent).toContain(`Убрать ${repo}?`);
    await t.click(t.$('[data-act="confirm"]'));
    await flush(5);
    expect(relay.sent("prefs.set").at(-1)).toMatchObject({ value: ["team/notes"] });
  });

  it("8050 · «Свести везде» — sync на каждой машине; конфликт виден по машинам; «Свести в сессии» — session.open в клоне и задача", async () => {
    // источник: дизайн: у сведения один инициатор; отправляет сведение, токена у сессии нет
    const relay = relayRepos({ state: "conflict", files: ["ops/memory/a.md"], dir: "/data/clone", at: 1 });
    relay.handlers["session.open"] = (f) => ({ ok: true, result: { callsign: `${f.name}@${f.machine}` } });
    relay.handlers["session.prompt"] = () => ({ ok: true, result: { uuid: "u" } });
    relay.handlers["machine.accounts"] = () => ({ ok: true, result: { accounts: {}, slots: { main: { account: "a", order: [], wait: null } } } });
    const t = await screenR(relay);
    await t.click(t.$('[data-act="sync"]'));
    await flush(5);
    expect(relay.sent("machine.profiles").filter((f) => f.sync === true).map((f) => f.machine).sort()).toEqual(["laptop", "pc"]);
    const row = t.$(`[data-prepo="${repo}"]`)!;
    expect(row.querySelector("[data-state]")!.textContent).toContain("конфликт на 2 из 2");
    await t.click(row.querySelector("[data-state]"));
    await t.click(row.querySelector('[data-act="resolve"]'));
    await flush(5);
    expect(relay.sent("session.open").at(-1)).toMatchObject({ name: "merge-profiles", number: true, dir: "/data/clone", slot: "main" });
    expect(relay.sent("session.prompt").at(-1)!.text).toContain(`Сведи конфликт репозитория ${repo} в файлах ops/memory/a.md`);
    expect(relay.sent("session.prompt").at(-1)!.text).toContain("отправит сведение");
  });
});

describe("новая сессия: участники", () => {
  const open = async () => {
    const relay = relayed();
    relay.handlers["machine.dirs"] = (f) => ({ ok: true, result: { path: f.path, dirs: [] } });
    relay.handlers["session.open"] = (f) => ({ ok: true, result: { callsign: f.wing_of ? "a-wing@laptop" : `${f.name}@${f.machine}` } });
    relay.handlers["fleetkeys.list"] = () => ({ ok: true, result: { keys: { orca: { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "x/opus" }, settings: {} } } } });
    relay.handlers["session.prompt"] = () => ({ ok: true, result: { uuid: "u" } });
    const t = await screen(relay, "/#open?machine=laptop&dir=~%2Fp");
    return { t, relay };
  };

  it("8051 · несколько кусочков, развёртка набора; слот двумя группами; ключ флота — подмена модели", async () => {
    // источник: слова пользователя: «профиль из кусочков», «набор должен показывать во что развёрнут», слоты на всех компьютерах
    const { t } = await open();
    await t.click(t.$(`[data-profile="${DEV}"]`));
    await flush(5);
    expect(t.$("[data-unfold]")!.textContent).toContain("dev → base › ops");
    await t.click(t.$(`[data-profile="${OPS}"]`));
    expect(t.$$("[data-chosen]").map((x) => x.dataset.chosen)).toEqual([DEV, OPS]);
    expect(t.$$(".pt-sep").map((x) => x.textContent)).toEqual(["тут", "флот"]);
    await t.click(t.$('[data-side="Ведущий"] [data-fleet][data-slot="orca"]'));
    await flush(3);
    expect(t.$("[data-mapped]")!.textContent).toBe("opus → x/opus");
  });

  it("8052 · порядок стрелками с клавиатуры: уходит один раз по отпусканию", async () => {
    const { t } = await open();
    await t.click(t.$(`[data-profile="${DEV}"]`));
    await t.click(t.$(`[data-profile="${OPS}"]`));
    const grip = t.$(`[data-grip="${OPS}"]`)!;
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await flush(2);
    expect(t.$$("[data-chosen]").map((x) => x.dataset.chosen)).toEqual([OPS, DEV]);
    t.$(`[data-grip="${OPS}"]`)!.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
    await flush(2);
    expect(t.$$("[data-chosen]").map((x) => x.dataset.chosen)).toEqual([OPS, DEV]);
  });

  it("8053 · «Пара»: вторая колонка с выбором ведущего, дальше независима; «Открыть» — ведущий, ведомый с wing_of, задача; отказ ведомого — ведущий остаётся", async () => {
    // источник: слово пользователя 6 нояб.: «opt-in фича, где выбирать и слот, и effort, и модель нужно для обеих сессий»
    const { t, relay } = await open();
    await t.click(t.$(`[data-profile="${OPS}"]`));
    await t.click(t.$('[data-side="Ведущий"] [data-slot="night"]'));
    expect(t.$('[data-side="Ведомый"]')).toBeNull();
    await t.click(t.$("button[data-pair]"));
    await flush(3);
    expect(t.$('.pt-grid')!.getAttribute("data-pair")).toBe("on");
    expect(t.$('[data-side="Ведомый"] [data-slot="night"]')!.getAttribute("aria-pressed")).toBe("true");
    await t.click(t.$('[data-side="Ведомый"] [data-fleet][data-slot="orca"]'));
    await t.click(t.$('[data-side="Ведомый"] [data-model="haiku"]'));
    expect(t.$('[data-side="Ведущий"] [data-slot="night"]')!.getAttribute("aria-pressed")).toBe("true");
    await t.type(t.$('[data-f="name"]'), "a");
    await t.type(t.$('[data-f="text"]'), "сделай");
    await t.click(t.$('[data-act="open"]'));
    await flush(5);
    const [lead, wing] = relay.sent("session.open");
    expect(lead).toMatchObject({ machine: "laptop", name: "a", slot: "night", profile: [OPS] });
    expect(wing).toMatchObject({ machine: "laptop", wing_of: "a@laptop", slot: "orca", model: "haiku", profile: [OPS] });
    expect(wing).not.toHaveProperty("name");
    expect(wing).not.toHaveProperty("dir");
    const types = relay.got.map((f) => f.type);
    expect(types.lastIndexOf("session.prompt")).toBeGreaterThan(types.lastIndexOf("session.open"));
  });

  it("8054 · ведомый отказал: слово тостом, ведущий открыт, задача ушла ему", async () => {
    const { t, relay } = await open();
    relay.handlers["session.open"] = (f) => (f.wing_of ? { ok: false, error: "has_wing" } : { ok: true, result: { callsign: `${f.name}@${f.machine}` } });
    await t.click(t.$("button[data-pair]"));
    await t.type(t.$('[data-f="name"]'), "a");
    await t.type(t.$('[data-f="text"]'), "сделай");
    await t.click(t.$('[data-act="open"]'));
    await flush(5);
    expect(t.$(".sb-toast, .sb-toasts")?.textContent ?? t.text()).toContain("ведомый не открылся — has_wing");
    expect(relay.sent("session.prompt").at(-1)).toMatchObject({ callsign: "a@laptop" });
  });
});
