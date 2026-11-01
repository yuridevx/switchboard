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
  });

  it("широкий вид: группы «нужны вы, в работе, свободны, остановлены», счётчик раздела need", async () => {
    const t = await stand(parts(), { wide: true });
    expect(t.$$(".board-mach").map((x) => x.textContent)).toEqual(["нужны вы1", "в работе1", "свободны1", "остановлены1"]);
    expect(t.$(".sb-navcol button")!.textContent).toBe("Сессии1");
  });

  it("дочь под родителем: отступ и порядок дерева; родитель на другой машине — его позывной в строке; сессия инцидента — значок типа", async () => {
    const r = homeRoster();
    r.sessions = [
      { callsign: "lead@laptop", state: "idle", model: "opus" },
      { callsign: "disk-full-1@laptop", state: "busy", parent: "@laptop", incident: { type: "disk-full", key: "C:" } },
      { callsign: "docs@laptop", state: "busy", parent: "lead@laptop" },
      { callsign: "fix-auth@pc", state: "busy", parent: "lead@laptop", model: "sonnet" },
    ];
    const t = await stand(parts(), { roster: r });
    expect(t.$$(".board-row").map((x) => x.getAttribute("data-callsign"))).toEqual(["lead@laptop", "docs@laptop", "disk-full-1@laptop", "fix-auth@pc"]);
    expect(t.$('[data-callsign="docs@laptop"]')!.className).toBe("board-row kid");
    expect(t.$('[data-callsign="docs@laptop"]')!.getAttribute("style")).toBe("margin-left:18px");
    expect(t.$('[data-callsign="lead@laptop"]')!.className).toBe("board-row");
    expect(t.$('[data-callsign="disk-full-1@laptop"] .board-inc')!.textContent).toBe("disk-full");
    expect(t.$('[data-callsign="fix-auth@pc"] .board-rt span')!.textContent).toBe("↳ lead@laptop · sonnet");
  });
});
