// Флоу web-board по плану цикла тестов (web): строки списка, пустой флот, ушедшая машина и память списка в широком виде.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlerts, manifest as alertsM } from "@switchboard/web-alerts";
import { createAsk, manifest as askM } from "@switchboard/web-ask";
import { createCard, manifest as cardM } from "@switchboard/web-card";
import { createChat, manifest as chatM } from "@switchboard/web-chat";
import { createBoard, manifest as boardM } from "../contract.ts";
import { FakeRelay, flush, homeRoster, stand } from "../../core/stand/app.ts";

const parts = () => [
  { manifest: boardM, module: createBoard() },
  { manifest: cardM, module: createCard() },
  { manifest: chatM, module: createChat() },
  { manifest: askM, module: createAsk() },
  { manifest: alertsM, module: createAlerts({}) },
];
const WIDE = { wide: true, options: { beside: { card: "board", chat: "board", ask: "board" } } };

/** relay с лентой и вопросами, как Host. */
function relay(roster = homeRoster()) {
  const r = new FakeRelay(roster);
  r.handlers["session.watch"] = () => ({ ok: true });
  r.handlers["session.unwatch"] = () => ({ ok: true });
  r.handlers["session.history"] = () => ({ ok: true, result: { messages: [] } });
  r.handlers["question.list"] = () => ({ ok: true, result: [] });
  return r;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("список в узком виде", () => {
  it("4070 · строка: вопрос — его текст и «?», сообщение — текст и счётчик, сбой — причина", async () => {
    const r = homeRoster();
    r.sessions.push({ callsign: "bot@pc", state: "failed", model: "sonnet", failed: { host: "resume failed" } });
    const rl = relay(r);
    rl.handlers["question.list"] = (f) => ({ ok: true, result: f.callsign === "profiles@laptop" ? [{ question: "q1", kind: "ask", questions: [{ question: "База?", options: [{ label: "a" }, { label: "b" }] }] }] : [] });
    const t = await stand(parts(), { relay: rl });
    rl.push({ type: "message", from: "poe-bot@pc", to: "phone", text: "Готово, катить?" });
    await flush();
    const row = (cs: string) => t.$(`[data-callsign="${cs}"]`)!;
    expect(row("profiles@laptop").querySelector(".board-rt span")!.textContent).toBe("База?");
    expect(row("profiles@laptop").querySelector(".sb-badge")!.textContent).toBe("?");
    expect(row("poe-bot@pc").querySelector(".board-rt span")!.textContent).toBe("Готово, катить?");
    expect(row("poe-bot@pc").querySelector(".sb-badge")!.textContent).toBe("1");
    expect(row("bot@pc").querySelector(".board-rt span")!.textContent).toBe("host: resume failed");
    expect(row("bot@pc").querySelector(".sb-pill")!.textContent).toBe("сбой");
  });

  it("4072 · сессий нет — «0 сессий» у машины, «Сессий нет», шапка «1 машина · 0 сессий»", async () => {
    const r = homeRoster();
    r.machines = r.machines.filter((m) => m.machine === "laptop");
    r.sessions = [];
    const t = await stand(parts(), { relay: relay(r) });
    expect(t.$(".board-mach")!.textContent).toBe("laptop0 сессий");
    expect(t.text()).toContain("Сессий нет");
    expect(t.$(".sb-bt")!.textContent).toBe("Флот1 машина · 0 сессий");
  });
});

describe("список в широком виде", () => {
  it("4074 · ушедшая машина — плашка «не на связи», группа машины с серыми строками", async () => {
    const rl = relay();
    const t = await stand(parts(), { relay: rl, ...WIDE });
    const r = homeRoster();
    r.machines = r.machines.filter((m) => m.machine !== "pc");
    r.sessions = r.sessions.filter((s) => !s.callsign.endsWith("@pc"));
    rl.setRoster(r);
    await flush();
    expect(t.$(".board-off")!.hidden).toBe(false);
    expect(t.$(".board-off")!.textContent).toMatch(/^pc не на связи с \d\d:\d\d — её сессии серые, отправка им — отказ$/);
    expect(t.$$(".board-gh").at(-1)!.textContent).toBe("pcне на связи");
    const grey = t.$$(".board-wr.off").map((x) => x.dataset.callsign);
    expect(grey).toEqual(["poe-bot@pc", "wiki@pc"]);
    expect(t.$('.board-wr.off[data-callsign="poe-bot@pc"] .t')!.textContent).toBe("не на связи");
  });

  it("4075 · из карточки в «Сессии» — список на весь экран, поиск и фильтр сохранены, лента снята", async () => {
    const rl = relay();
    const t = await stand(parts(), { relay: rl, ...WIDE });
    const q = t.$<HTMLInputElement>(".board-q")!;
    q.value = "laptop";
    q.dispatchEvent(new Event("input"));
    await t.click(t.$('[data-filter="need"]'));
    await t.click(t.$('[data-callsign="profiles@laptop"]'));
    expect(t.$(".sb-split")).not.toBeNull();
    await t.click(t.$('.sb-navcol button[data-screen="board"]'));
    expect(t.$(".sb-split")).toBeNull();
    expect(t.$(".board-sum")).not.toBeNull();
    expect(t.$<HTMLInputElement>(".board-q")!.value).toBe("laptop");
    expect(t.$('[data-filter="need"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$$(".board-wr").map((x) => x.dataset.callsign)).toEqual(["profiles@laptop"]);
    expect(rl.sent("session.unwatch")).toEqual([expect.objectContaining({ callsign: "profiles@laptop" })]);
  });
});
