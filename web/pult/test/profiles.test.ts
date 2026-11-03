// Экран «Профили». Источник: дизайн «Сессии, проекты и профили» (блок «Эталоны», «найс делай» пользователя 3 нояб.).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fleetRelay, fleetRoster, flush, pult } from "./stand.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function relay() {
  const r = fleetRoster();
  r.sessions.find((s) => s.callsign === "site@laptop")!.profile = { id: "team/profiles/ops", state: "ok" };
  const x = fleetRelay(r);
  x.handlers["machine.profiles"] = (f) => ({
    ok: true,
    result:
      f.machine === "laptop"
        ? { profiles: { "team/profiles/ops": { model: "opus", effort: "high", about: "дежурство" }, "team/profiles/writer": { model: "haiku", effort: "low" } }, repos: { "team/profiles": { state: "ok" } } }
        : { profiles: { "team/profiles/ops": { model: "opus", effort: "high", about: "дежурство" } }, repos: { "team/profiles": { state: "conflict", files: ["ops/memory/testing.md"] } } },
  });
  return x;
}

async function screen(x = relay()) {
  const t = await pult({ relay: x, url: "/#profiles" });
  await flush(10);
  return t;
}

describe("профили", () => {
  it("5600 · профиль — одна строка по всем машинам: описание, модель, число машин и сессий; с конфликтом — сверху; repos в шапке", async () => {
    const t = await screen();
    expect(t.relay.sent("machine.profiles").map((f) => f.machine).sort()).toEqual(["laptop", "pc"]);
    expect(t.$$("[data-profile]").map((x) => x.dataset.profile)).toEqual(["team/profiles/ops", "team/profiles/writer"]);
    const ops = t.$('[data-profile="team/profiles/ops"]')!;
    expect(ops.textContent).toContain("дежурство");
    expect(ops.textContent).toContain("opus · высокое");
    expect(ops.textContent).toContain("2/2 машин · 1 сессия");
    expect(ops.textContent).toContain("конфликт @pc");
    expect(t.$(".pf-repo")!.textContent).toBe("team/profiles");
  });

  it("5601 · строка раскрывается: машины, сессии, файлы конфликта; нажатие сессии — карточка", async () => {
    const t = await screen();
    await t.click(t.$('[data-profile="team/profiles/ops"] .pf-r'));
    const ops = t.$('[data-profile="team/profiles/ops"]')!;
    expect(ops.querySelector(".pf-cf")!.textContent).toContain("ops/memory/testing.md");
    await t.click(ops.querySelector('[data-callsign="site@laptop"]'));
    expect(location.hash).toBe("#card?callsign=site%40laptop");
  });

  it("5602 · поиск по имени и описанию; «конфликты N» отбирает; фокус поля остаётся", async () => {
    const t = await screen();
    const q = t.$<HTMLInputElement>('[data-f="q"]')!;
    q.focus();
    q.value = "writ";
    q.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(t.$$("[data-profile]").map((x) => x.dataset.profile)).toEqual(["team/profiles/writer"]);
    expect(document.activeElement).toBe(t.$('[data-f="q"]'));
    q.value = "";
    t.$<HTMLInputElement>('[data-f="q"]')!.value = "";
    t.$('[data-f="q"]')!.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    await t.click(t.$('[data-act="conflicts"]'));
    expect(t.$$("[data-profile]").map((x) => x.dataset.profile)).toEqual(["team/profiles/ops"]);
  });

  it("5603 · «Синхронизировать» — machine.profiles { sync } по всем машинам, одна кнопка; итог — тост с конфликтом; отказ машины — словом", async () => {
    const x = relay();
    const t = await screen(x);
    await t.click(t.$('[data-act="sync"]'));
    await flush(5);
    expect(x.sent("machine.profiles").filter((f) => f.sync === true).map((f) => f.machine).sort()).toEqual(["laptop", "pc"]);
    expect(t.$(".sb-toast")!.textContent).toBe("Сведено. Конфликт: ops @pc");
    x.handlers["machine.profiles"] = () => ({ ok: false, error: "no_app" });
    await t.click(t.$('[data-act="sync"]'));
    await flush(5);
    expect(t.$(".pf-e")!.textContent).toBe("@laptop: machine.profiles: no_app");
  });

  it("5604 · профилей нет на «Машинах» и в «Настройках»: synchronizing — только здесь", async () => {
    const t = await pult({ relay: relay(), url: "/#machines" });
    await flush(10);
    expect(t.btn(null, "Синхронизировать профили")).toBeNull();
    expect(t.relay.sent("machine.profiles")).toHaveLength(0);
  });
});
