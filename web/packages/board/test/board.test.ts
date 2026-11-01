// web-board на стенде: строки по машинам, сводка, серые сессии ушедшей машины, группы широкого вида.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createBoard, manifest as boardM } from "../contract.ts";
import { flush, homeRoster, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("список сессий", () => {
  it("строки по машинам: callsign, строка модели и слота, состояние; сводка в шапке; кто смотрит", async () => {
    const t = await stand(parts());
    expect(t.$(".sb-bt")!.textContent).toBe("Флот2 машины · 4 сессии");
    expect(t.$$(".board-mach").map((x) => x.firstChild!.textContent)).toEqual(["laptop", "pc"]);
    const site = t.$('[data-callsign="site@laptop"]')!;
    expect(site.textContent).toBe("site@laptopopus · mainработает");
    expect(site.querySelector(".sb-dot")!.className).toBe("sb-dot busy");
    expect(t.$('[data-callsign="wiki@pc"]')!.textContent).toBe("wiki@pcостановленастоп");
    expect(t.text()).toContain("Флот смотрят: вы и panel-desk");
  });

  it("машина ушла — её сессии серые из последнего roster; шапка «1 машина из 2»", async () => {
    const t = await stand(parts());
    const r = homeRoster();
    r.machines = r.machines.filter((m) => m.machine !== "pc");
    r.sessions = r.sessions.filter((s) => !s.callsign.endsWith("@pc"));
    t.relay.setRoster(r);
    await flush();
    expect(t.$(".sb-bt")!.textContent).toBe("Флот1 машина из 2 · 2 сессии");
    expect(t.$(".board-mach.off")!.textContent).toMatch(/^pcне на связи с \d\d:\d\d$/);
    const poe = t.$('[data-callsign="poe-bot@pc"]')!;
    expect(poe.className).toBe("board-row off");
    expect(poe.textContent).toBe("poe-bot@pcпоследнее: простаивала");
    t.relay.setRoster(homeRoster());
    await flush();
    expect(t.$(".board-mach.off")).toBeNull();
  });

  it("нажатие строки — карточка сессии", async () => {
    const t = await stand(parts());
    t.relay.handlers["session.watch"] = () => ({ ok: true });
    await t.click(t.$('[data-callsign="site@laptop"]'));
    expect(location.hash).toBe("#card?callsign=site%40laptop");
    expect(t.$(".card-tabs")).not.toBeNull();
    // сессия спрашивает — строка ведёт к экрану вопроса
    t.relay.handlers["question.list"] = () => ({ ok: true, result: [] });
    t.relay.push({ type: "question", from: "profiles@laptop", question: "q1", kind: "ask", questions: [{ question: "База?", options: [{ label: "a" }, { label: "b" }] }] });
    t.button("‹")!.click();
    await flush();
    await t.click(t.$('[data-callsign="profiles@laptop"]'));
    expect(location.hash).toBe("#ask?callsign=profiles%40laptop");
  });

  it("широкий вид: группы «нужны вы, в работе, свободны, остановлены», счётчик раздела need", async () => {
    const t = await stand(parts(), { wide: true });
    expect(t.$$(".board-mach").map((x) => x.textContent)).toEqual(["нужны вы1", "в работе1", "свободны1", "остановлены1"]);
    expect(t.$$(".board-wr").map((x) => x.dataset.callsign)).toEqual(["profiles@laptop", "site@laptop", "poe-bot@pc", "wiki@pc"]);
    expect(t.$(".sb-navcol button")!.textContent).toBe("Сессии1");
    expect(t.$$(".board-seg button").map((x) => x.textContent)).toEqual(["Все4", "Нужны вы1", "Отвечают1"]);
    expect(t.$$(".board-tile b").map((x) => x.textContent)).toEqual(["1", "1", "1", "1"]);
    expect(t.$(".board-slot")!.textContent).toBe("laptop · main · y0902site1");
    // кроме hello — ни одного кадра
    expect(t.relay.got.filter((f) => f.type !== "question.list")).toEqual([]);
  });

  it("дочь под родителем — и с другой машины: отступ и порядок дерева в группе машины корня; сессия инцидента — значок типа", async () => {
    // источник: принятый дизайн — «Пульт и телефон рисуют это дерево по полю parent» (lead@win ├ fix-auth@wsl); инциденты — со значком типа
    const r = homeRoster();
    r.sessions = [
      { callsign: "lead@laptop", state: "idle", model: "opus" },
      { callsign: "disk-full-1@laptop", state: "busy", parent: "@laptop", incident: { type: "disk-full", key: "C:" } },
      { callsign: "docs@laptop", state: "busy", parent: "lead@laptop" },
      { callsign: "fix-auth@pc", state: "busy", parent: "lead@laptop", model: "sonnet" },
    ];
    const t = await stand(parts(), { roster: r });
    expect(t.$$(".board-row").map((x) => x.getAttribute("data-callsign"))).toEqual(["lead@laptop", "docs@laptop", "fix-auth@pc", "disk-full-1@laptop"]);
    expect(t.$$(".board-mach").map((x) => x.textContent)).toEqual(["laptop3 сессии", "pc1 сессия"]);
    expect(t.$('[data-callsign="docs@laptop"]')!.className).toBe("board-row kid");
    expect(t.$('[data-callsign="docs@laptop"]')!.getAttribute("style")).toBe("margin-left:18px");
    expect(t.$('[data-callsign="lead@laptop"]')!.className).toBe("board-row");
    expect(t.$('[data-callsign="disk-full-1@laptop"] .board-inc')!.textContent).toBe("disk-full");
    expect(t.$('[data-callsign="fix-auth@pc"]')!.className).toBe("board-row kid");
    expect(t.$('[data-callsign="fix-auth@pc"] .board-rt span')!.textContent).toBe("sonnet");
  });

  it("343 · пульт, широкий вид: дочь под родителем в своей группе; дочь в другой группе — в корне со строкой «↳ родитель»; значок типа у инцидента", async () => {
    // источник: принятый дизайн — «Пульт и телефон рисуют это дерево по полю parent; инциденты — со значком типа»;
    // дочь в другой группе — в корне со строкой «↳ родитель», отступ и класс kid — чьё: код
    const r = homeRoster();
    r.sessions = [
      { callsign: "lead@laptop", state: "busy", model: "opus" },
      { callsign: "disk-full-1@laptop", state: "busy", parent: "@laptop", incident: { type: "disk-full", key: "C:" } },
      { callsign: "docs@laptop", state: "busy", parent: "lead@laptop" },
      { callsign: "fix-auth@pc", state: "idle", parent: "lead@laptop", model: "sonnet" },
    ];
    const t = await stand(parts(), { wide: true, roster: r });
    expect(t.$$(".board-wr").map((x) => x.getAttribute("data-callsign"))).toEqual(["lead@laptop", "docs@laptop", "disk-full-1@laptop", "fix-auth@pc"]);
    expect(t.$('[data-callsign="docs@laptop"]')!.className).toBe("board-wr kid");
    expect(t.$('[data-callsign="docs@laptop"]')!.getAttribute("style")).toBe("margin-left:14px");
    expect(t.$('[data-callsign="lead@laptop"]')!.className).toBe("board-wr");
    expect(t.$('[data-callsign="fix-auth@pc"]')!.className).toBe("board-wr");
    expect(t.$('[data-callsign="fix-auth@pc"] .m')!.textContent).toBe("↳ lead@laptop · pc · sonnet");
    expect(t.$('[data-callsign="disk-full-1@laptop"] .board-inc')!.textContent).toBe("disk-full");
  });
});
