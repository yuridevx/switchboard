// Интеграция пульта: гейт выпуска со своими модулями, раскладка широкого вида, журнал флота, чат и карточка
// на стыках с владельцами запросов, приложение GitHub. Стенд — поддельный relay, код пульта настоящий.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { check, loadRepo, order } from "@switchboard/manifest-gate";
import { appGate } from "@switchboard/web-core";
import { OWN, pultParts } from "../stand/parts.ts";
import { fleetRelay, fleetRoster, flush, pult } from "./stand.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Импорты @switchboard/* кода папки (без тестов) — как считает гейт монорепо. */
function imports(dir: string): string[] {
  const out = new Set<string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(e) && !/\.test\./.test(e)) for (const m of readFileSync(p, "utf8").matchAll(/from\s*["'](@switchboard\/[^"']+)["']/g)) out.add(m[1]);
    }
  };
  walk(dir);
  return [...out].sort();
}

describe("гейт выпуска пульта", () => {
  it("свои модули пульта с манифестами монорепо: у имени один владелец, uses — у владельцев той же версии, импорт — только из uses", () => {
    // гейт монорепо сам находит модули пульта (web/pult/modules/*) — набор берём целиком из него
    const repo = loadRepo(root);
    expect(repo.filter((m) => m.name.startsWith("pult-")).map((m) => m.name).sort()).toEqual(["pult-accounts", "pult-incidents", "pult-journal", "pult-machines", "pult-open", "pult-points", "pult-profiles", "pult-settings"]);
    expect(check(repo)).toEqual([]);
  });

  it("набор выпуска проходит гейт ядра при старте", () => {
    expect(appGate(pultParts())).toEqual([]);
  });

  it("в коде оболочки пульта нет адресов, ключа флота и списка модулей: всё — из build.json сборки", () => {
    for (const f of ["../src/main.ts", "../src/options.ts", "../../shell.ts"]) {
      const text = readFileSync(join(here, f), "utf8");
      expect(text).not.toMatch(/wss:\/\/|workers\.dev|RELAY_URL|WORKERS/);
      expect(text).not.toMatch(/client\.[a-z-]+\.[a-z0-9]+\./);
      // модулей страниц оболочка не импортирует; правило карты импорта — у владельца формата выпуска
      expect(text).not.toMatch(/from\s*["']@switchboard\/(?!web-core"|release\/importmap")/);
    }
  });

  it("5138 · модули стенда пульта — те же, что в into пульта, в порядке списка сборки", () => {
    // источник: дизайн «Открытый флот» (слово пользователя 2 нояб. «делай»): список сборки — единственная запись состава
    const want = order(loadRepo(root).filter((m) => m.into?.includes("pult") && m.name !== "web-core")).map((m) => m.name);
    expect(pultParts().map((p) => p.manifest.name).sort()).toEqual([...want].sort());
    expect(want.length).toBe(17);
  });
});

describe("раскладка широкого вида", () => {
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

  it("6904 · карточка открывается справа от списка «Работы»: список остаётся слева с выбранной строкой", async () => {
    // источник: прототип «Пульт и телефон» (подписан 2 нояб.): список проекта слева, сессия справа
    const t = await pult();
    expect(t.$(".sb-split")).toBeNull();
    await t.expand();
    await t.click(t.$('[data-callsign="site@laptop"]'));
    expect(t.$(".sb-split .sb-master .bd-list")).not.toBeNull();
    expect(t.$(".sb-split .sb-detail .cw")).not.toBeNull();
    expect(t.$('.bd-row[aria-current="true"]')!.dataset.callsign).toBe("site@laptop");
    const master = t.$(".sb-master");
    await t.click(t.$('[data-callsign="wiki@laptop"]'));
    expect(t.$(".sb-master")).toBe(master);
    expect(t.$('.bd-row[aria-current="true"]')!.dataset.callsign).toBe("wiki@laptop");
  });

  it("6905 · закрепление: чужая сессия — «Закрепить» в шапке карточки → в «Моём» со значком; «Закреплена» — откреплена", async () => {
    // источник: прототип «Пульт и телефон» (подписан 2 нояб.): «закрепление — моя на этом устройстве»
    const roster = fleetRoster();
    roster.sessions = roster.sessions.map((s) => (s.callsign === "wiki@laptop" ? { ...s, by: "laptop~anna@example.com" } : s));
    const t = await pult({ relay: fleetRelay(roster) });
    const mine = () => t.$$(".bd-row").map((b) => b.dataset.callsign);
    expect(mine()).not.toContain("wiki@laptop");
    await t.go("#card?callsign=wiki%40laptop");
    await t.click(t.$('.cw-h [data-screen="board.pin"]'));
    await flush(10);
    await t.go("#sessions");
    await t.expand();
    expect(mine()).toContain("wiki@laptop");
    expect(t.$('[data-callsign="wiki@laptop"] .bd-pin')).not.toBeNull();
    await t.go("#card?callsign=wiki%40laptop");
    await t.click(t.$('.cw-h [data-screen="board.unpin"]'));
    await flush(10);
    await t.go("#sessions");
    expect(mine()).not.toContain("wiki@laptop");
  });

  it("6906 · моё по цепочке: задачу дала моя сессия (by — позывной) — сессия в «Моём»; дала чужая — нет", async () => {
    // источник: прототип «Пульт и телефон»: «моё — дочерние моих»; живой флот 3 нояб.: flow-1@wsl с from flow@win была «чужой»
    const roster = fleetRoster();
    roster.sessions = roster.sessions.map((s) =>
      s.callsign === "wiki@laptop" ? { ...s, by: "site@laptop" } : s.callsign === "docs@pc" ? { ...s, by: "laptop~anna@example.com" } : s.callsign === "api@pc" ? { ...s, by: "docs@pc" } : s,
    );
    const t = await pult({ relay: fleetRelay(roster) });
    const mine = t.$$(".bd-row").map((b) => b.dataset.callsign);
    expect(mine).toContain("wiki@laptop");
    expect(mine).not.toContain("api@pc");
  });

  it("5219 · поиск сессии — Ctrl K: по позывному, без кадров; строка открывает карточку", async () => {
    // источник: прототип «Пульт и телефон»: «Найти сессию — Ctrl K, отдельного поиска в «Работе» нет»
    const t = await pult();
    const sent = t.relay.got.length;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }));
    await flush();
    const input = document.querySelector<HTMLInputElement>(".sb-palin")!;
    input.value = "wiki";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect([...document.querySelectorAll(".sb-palit .l")].map((x) => x.textContent)).toEqual(["wiki"]);
    expect(t.relay.got.length).toBe(sent);
  });

  it("галерея карточек #gallery: образцы сообщений SDK тем же кодом ленты, кадров нет", async () => {
    const t = await pult({ url: "/#gallery" });
    expect(t.$$(".chat-galr").length).toBeGreaterThan(10);
    expect(t.text()).toContain("ход закончен · 2 мин 14 с · 6 шагов · $0,41");
    expect(t.text()).toContain("контекст сжат · 182 К → 41 К");
    expect(t.text()).toContain("сессия Claude · poe-bot@pc");
    expect(t.relay.got.filter((f) => !["machine.journal", "prefs.get", "question.list"].includes(f.type))).toEqual([]);
  });
});

describe("чат и карточка на стыках", () => {
  it("«/» — session.call supportedCommands один раз на чат; «В фон» — backgroundTasks; откат — rewindFiles с dryRun, затем без", async () => {
    const relay = fleetRelay();
    relay.handlers["session.call"] = (f) => {
      if (f.method === "supportedCommands") return { ok: true, result: [{ name: "review", description: "ревью" }, { name: "reload-plugins" }] };
      if (f.method === "rewindFiles") return { ok: true, result: { canRewind: true, filesChanged: ["src/worker.ts", "vitest.config.ts"], insertions: 4, deletions: 1 } };
      return { ok: true, result: null };
    };
    relay.handlers["session.history"] = () => ({ ok: true, result: { messages: [{ type: "user", uuid: "5b1e", message: { content: "Почини сборку" } }, { type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "toolu_01Bx", name: "Bash", input: { command: "npm test" } }] } }], more: false } });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await t.type(t.$(".chat-inp"), "/");
    await t.type(t.$(".chat-inp"), "/re");
    expect(relay.sent("session.call").filter((f) => f.method === "supportedCommands")).toHaveLength(1);
    expect(t.$$(".chat-sugi").map((b) => b.textContent)).toEqual(["/reviewревью", "/reload-plugins"]);
    await t.click(t.$$(".chat-sugi")[1]);
    expect(t.$<HTMLTextAreaElement>(".chat-inp")!.value).toBe("/reload-plugins ");
    await t.click(t.btn(t.$(".chat-feed"), "В фон"));
    expect(relay.sent("session.call").at(-1)).toMatchObject({ callsign: "site@laptop", method: "backgroundTasks", args: ["toolu_01Bx"] });
    await t.click(t.btn(t.$(".chat-feed"), "откатить файлы"));
    expect(relay.sent("session.call").at(-1)).toMatchObject({ method: "rewindFiles", args: ["5b1e", { dryRun: true }] });
    expect(t.$(".chat-rwc")!.textContent).toContain("Откатить файлы к этому сообщению? проба: 2 файла · +4 −1 · команды Bash не откатываются");
    await t.click(t.btn(t.$(".chat-rwc"), "Откатить"));
    expect(relay.sent("session.call").at(-1)).toMatchObject({ method: "rewindFiles", args: ["5b1e"] });
  });

  it("фокус: сводка шагов и итоговый ответ; итог хода и сжатие видны; выгрузка .md — из ленты", async () => {
    const relay = fleetRelay();
    const tool = (id: string, name: string) => ({ type: "tool_use", id, name, input: { command: "x" } });
    relay.handlers["session.history"] = () => ({
      ok: true,
      result: {
        messages: [
          { type: "user", uuid: "u1", message: { content: "Почини сборку" } },
          { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "Смотрю лог." }, tool("t1", "Read"), tool("t2", "Edit")] } },
          { type: "assistant", uuid: "a2", message: { content: [tool("t3", "Bash"), tool("t4", "Bash")] } },
          { type: "assistant", uuid: "a3", message: { content: [{ type: "text", text: "Сборка зелёная." }] } },
          { type: "result", uuid: "z1", subtype: "success", duration_ms: 134_000, num_turns: 6, total_cost_usd: 0.41 },
        ],
        more: false,
      },
    });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    await t.click(t.btn(null, "фокус"));
    expect(t.$$(".chat-col > :not(.chat-work)").map((x) => x.className.replace("dis ", "").split(" ")[0])).toEqual(["chat-me", "chat-steps", "chat-reply", "chat-res"]);
    expect(t.$(".chat-steps")!.textContent).toBe("4 шага · Команда ×2 · Чтение · Правка");
    expect(t.$(".chat-txt")!.textContent).toBe("Сборка зелёная.");
    const a = t.$<HTMLAnchorElement>(".chat-bar a")!;
    // переход по ссылке на стенде не нужен: браузер по download сохраняет файл
    a.addEventListener("click", (e) => e.preventDefault());
    a.dispatchEvent(new MouseEvent("click", { cancelable: true, bubbles: true }));
    expect(decodeURIComponent(a.href)).toContain("## Claude\n\nСборка зелёная.");
  });

  it("сведения сбоку — серверы MCP (mcpServerStatus, toggleMcpServer); «Убрать…» в «Настройках» — session.remove после подтверждения", async () => {
    const relay = fleetRelay();
    relay.handlers["session.call"] = (f) =>
      f.method === "getContextUsage"
        ? { ok: true, result: { percentage: 21 } }
        : f.method === "mcpServerStatus"
          ? { ok: true, result: [{ name: "github", status: "needs-auth" }] }
          : f.method === "supportedAgents"
            ? { ok: true, result: [{ name: "Explore" }, { name: "Plan" }] }
            : { ok: true, result: null };
    relay.handlers["session.remove"] = () => ({ ok: true });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="wiki@laptop"]'));
    await t.click(t.$('[data-pop="menu"]'));
    await t.click(t.$('.cw-pop [data-act="info"]'));
    expect(relay.sent("session.call").map((f) => f.method)).toContain("mcpServerStatus");
    await t.click(t.$('aside.cw-info [data-mcp="github"]'));
    expect(relay.sent("session.call").find((f) => f.method === "toggleMcpServer")).toMatchObject({ args: ["github", false] });
    await t.click(t.$('.cw-tabs [data-tab="set"]'));
    await t.click(t.btn(null, "Убрать…"));
    expect(relay.sent("session.remove")).toHaveLength(0);
    await t.click(t.btn(t.$(".cw-confirm"), "Убрать"));
    expect(relay.sent("session.remove")).toEqual([expect.objectContaining({ callsign: "wiki@laptop" })]);
  });
});

describe("аккаунты: шаги по контракту", () => {
  it("«Удалить…» аккаунт в слоте: slot.swap → slot.set без него → machine.account_remove, каждый после ответа", async () => {
    const relay = fleetRelay();
    relay.handlers["machine.accounts"] = (f) => ({ ok: true, result: { accounts: f.machine === "laptop" ? { y0902: { email: "y0902@x.io", login: "ok", limits: {} }, work3: { email: "w@x.io", login: "ok", limits: {} } } : {} } });
    relay.handlers["machine.slots"] = (f) => ({ ok: true, result: { slots: f.machine === "laptop" ? { main: { account: "y0902", order: ["y0902", "infirex", "work3"], wait: null, sessions: ["site@laptop"] } } : {} } });
    relay.handlers["slot.swap"] = () => ({ ok: true, result: { from: "y0902", to: "work3" } });
    relay.handlers["slot.set"] = () => ({ ok: true, result: { account: "work3" } });
    relay.handlers["machine.account_remove"] = () => ({ ok: true, result: { wiped: true } });
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="accounts"]'));
    await flush(10);
    await t.click(t.btn(t.$('[data-account="y0902@x.io"]'), "Удалить…"));
    expect(t.$('[data-dlg="rm"]')!.textContent).toContain("y0902 сейчас в слоте main");
    await t.click(t.btn(t.$('[data-dlg="rm"]'), "Сменить и удалить"));
    await flush(10);
    const steps = relay.got.filter((f) => ["slot.swap", "slot.set", "machine.account_remove"].includes(f.type)).map(({ id: _, ...f }) => f);
    expect(steps).toEqual([
      { type: "slot.swap", v: 1, machine: "laptop", slot: "main" },
      { type: "slot.set", v: 1, machine: "laptop", slot: "main", order: ["infirex", "work3"] },
      { type: "machine.account_remove", v: 1, machine: "laptop", account: "y0902" },
    ]);
  });

  it("вложение: «＋ файл» → session.prompt с attachments { name, media_type, data base64 }", async () => {
    const relay = fleetRelay();
    relay.handlers["session.prompt"] = (f) => ({ ok: true, result: { uuid: f.uuid } });
    const t = await pult({ relay });
    await t.click(t.$('[data-callsign="wiki@laptop"]'));
    const picker = t.$<HTMLInputElement>('.chat input[type="file"]')!;
    Object.defineProperty(picker, "files", { value: [new File(["hi"], "a.txt", { type: "text/plain" })], configurable: true });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(10);
    expect(t.$(".chat-file")!.textContent).toBe("a.txt");
    await t.type(t.$(".chat-inp"), "Посмотри файл");
    await t.click(t.$(".chat-send"));
    expect(relay.sent("session.prompt")[0]).toMatchObject({ callsign: "wiki@laptop", text: "Посмотри файл", attachments: [{ name: "a.txt", media_type: "text/plain", data: "aGk=" }] });
  });
});

describe("журнал флота и машины", () => {
  it("ledger.read: limit 50 при открытии; на roster — after последнего id; «Раньше» — before; машина — machine", async () => {
    const relay = fleetRelay();
    const t0 = Date.now();
    relay.handlers["ledger.read"] = (f) =>
      f.after
        ? { ok: true, result: { events: [{ id: 906, t: t0, ev: "slot.swapped", from: "@laptop", by: "panel-desk", machine: "laptop", text: "слот main: y0902 → work3" }], more: false } }
        : f.before
          ? { ok: true, result: { events: [{ id: 700, t: t0 - 86_400_000, ev: "machine.back", from: "ledger", machine: "mac", text: "mac вернулась" }], more: false } }
          : { ok: true, result: { events: [{ id: 905, t: t0, ev: "machine.left", from: "ledger", machine: "pc", text: "pc пропала · была на связи с 11:40" }], more: true } };
    const t = await pult({ relay });
    await t.click(t.$('.sb-navcol button[data-screen="journal"]'));
    expect(relay.sent("ledger.read")[0]).toMatchObject({ to: ".ledger", limit: 50 });
    relay.setRoster(fleetRoster());
    await flush(10);
    expect(relay.sent("ledger.read")[1]).toMatchObject({ after: 905, limit: 50 });
    expect(t.$$(".jr-r").map((x) => x.dataset.id)).toEqual(["906", "905"]);
    expect(t.$('.jr-r[data-id="906"]')!.textContent).toContain("слот main: y0902 → work3 · by panel-desk");
    await t.click(t.btn(null, "Раньше"));
    expect(relay.sent("ledger.read")[2]).toMatchObject({ before: 905 });
    expect(t.text()).toContain("Вчера");
    const sel = t.$<HTMLSelectElement>('[data-f="machine"]')!;
    sel.value = "pc";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(relay.sent("ledger.read")[3]).toMatchObject({ machine: "pc", limit: 50 });
  });

  it("«Аккаунты машины» в карточке машины — экран аккаунтов с формой входа на этой машине", async () => {
    const relay = fleetRelay();
    relay.handlers["machine.slots"] = () => ({ ok: true, result: { slots: {} } });
    relay.handlers["keeper.state"] = () => ({ ok: true, result: { keeper: "0.5.0", rev: 1, os: "linux", parts: [{ part: "host", version: "1.1.58", state: "running", restarts: 0 }] } });
    const t = await pult({ relay, url: "/#machines" });
    await flush(10);
    await t.click(t.$('[data-row="pc"] .mc-head'));
    await t.click(t.btn(t.$('[data-machine="pc"]'), "Аккаунты машины"));
    expect(location.hash).toBe("#accounts?machine=pc");
    expect(t.$('.sb-sec.dlg [aria-pressed="true"]')!.textContent).toBe("pc");
  });
});
