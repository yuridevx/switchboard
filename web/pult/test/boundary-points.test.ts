// Леса границы «Сессии» (архив сессий флота), сторона страницы: настоящий пульт на поддельном relay. Вход — экран и кадры контракта,
// исход — кадры relay, текст и якоря разметки. Номер — эталон-источник; без номера — чьё: код (экраны прототипа «Сессии» дизайна «Прокси модели»).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roster } from "@switchboard/web-core";
import { CALLS, fleetRelay, fleetRoster, flush, pointsRelay, pult, SID, SITE_ROW, SLOTS } from "./stand.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type P = Awaited<ReturnType<typeof pult>>;
type Relay = ReturnType<typeof pointsRelay>;
const at = (hh: number, mm: number) => Date.UTC(2026, 9, 31, hh, mm);
const CATALOG = (sessions: unknown[], extra: Record<string, unknown> = {}) => () => ({ ok: true as const, result: { search: true, sessions, store: { bytes: 0, blocks: 0 }, sweep: null, ...extra } });
/** Сессия только в архиве: old-bot на pc, в roster её нет. */
const OLD = { sid: "old", callsign: "old-bot@pc", title: "Чистка старых логов", model: "claude-sonnet-5-5", tok_in: 52000, tok_out: 1200, dir: "~/b", owner: "pc", head: { id: 4, at: at(8, 0) }, points: 4, branches: 0 };

/** Архив: site@laptop (идёт) и old-bot@pc (только в архиве); ответы подъёма. */
function archiveRelay(over: (r: Roster) => void = () => {}) {
  const relay = pointsRelay(over);
  const line = relay.handlers["points.list"];
  relay.handlers["points.list"] = (f) => (f.sid === SID ? line(f) : f.sid === "old" ? { ok: true, result: { owner: "pc", head: 4, points: [{ id: 4, at: at(8, 0), machine: "pc", why: "rule", base: 3, dir: "~/b", msgs: 2, line: true, until: null }] } } : CATALOG([SITE_ROW, OLD])());
  relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : { ok: true, result: { callsign: `${f.name ?? (f.sid === "old" ? "old-bot" : "site")}@${f.machine}`, point: f.point, folder: "same", branch: null } });
  relay.handlers["points.save"] = () => ({ ok: true, result: { point: 42, same: false } });
  relay.handlers["session.remove"] = () => ({ ok: true });
  return relay;
}

/** Экран «Сессии» из навигации. */
async function sessions(relay: Relay = archiveRelay()) {
  const t = await pult({ relay });
  await t.click(t.$('.sb-navcol button[data-screen="points"]'));
  await flush(10);
  return t;
}

/** Страница сессии sid: из строки каталога. */
async function sessionPage(relay: Relay = archiveRelay(), sid = SID) {
  const t = await sessions(relay);
  await t.click(t.$(`[data-archive] [data-sid="${sid}"]`));
  await flush(10);
  return t;
}

/** Выбрать точку в линии. */
async function pick(t: P, id: number) {
  await t.click(t.$(`.ss-line [data-point="${id}"]`));
  await flush(10);
}

/** Вкладка «Архив» карточки site@laptop. */
async function cardTab(relay: Relay = archiveRelay(), callsign = "site@laptop") {
  const t = await pult({ relay });
  await t.expand();
  await t.click(t.$(`[data-callsign="${callsign}"]`));
  await t.click(t.$('.cw-tabs [data-tab="session.points"]'));
  await flush(10);
  return t;
}

const hashParams = () => new URLSearchParams(location.hash.split("?")[1] ?? "");
const steps = (relay: Relay, types = ["points.save", "points.raise", "session.remove"]) => relay.got.filter((f) => types.includes(f.type) && !f.dryRun).map(({ id: _, ...f }) => f);

describe("каталог", () => {
  it("строка — заголовок, callsign, модель, токены и время; идущая и только в архиве различимы; points.list к .points за неделю, порядок «последние»", async () => {
    const relay = archiveRelay();
    const t = await sessions(relay);
    const asked = relay.sent("points.list").filter((f) => !f.sid && f.order);
    expect(asked.at(-1)).toMatchObject({ to: ".points", order: "last" });
    expect(Date.parse(String(asked.at(-1)!.since))).toBeGreaterThan(Date.now() - 8 * 86_400_000);
    const site = t.$(`[data-archive] [data-sid="${SID}"]`)!;
    expect(site.textContent).toContain("Перенеси журнал в ClickHouse");
    expect(site.textContent).toContain("site@laptop");
    expect(site.textContent).toContain("opus-5-5");
    expect(site.textContent).toContain("3,1 M → 88 K");
    expect(site.querySelector('[title="идёт на машине"]')).not.toBeNull();
    expect(t.$('[data-archive] [data-sid="old"] [title="только в архиве"]')).not.toBeNull();
  });

  it("период и порядок — новые points.list: «всё время» без since, «токены» — order tokens", async () => {
    const relay = archiveRelay();
    const t = await sessions(relay);
    await t.click(t.btn(t.$('[data-f="period"]'), "всё время"));
    await flush(10);
    expect(relay.sent("points.list").at(-1)).not.toHaveProperty("since");
    await t.click(t.btn(t.$('[data-f="order"]'), "токены"));
    await flush(10);
    expect(relay.sent("points.list").at(-1)).toMatchObject({ order: "tokens" });
  });

  it("проект — по доске на странице: переключатель при двух проектах, points.list без project, строки другого проекта скрыты", async () => {
    const relay = Object.assign(archiveRelay(), {
      scoped: { global: { "fleet.projects": [{ id: "ops", name: "ops", sessions: ["site@laptop"] }, { id: "web", name: "web", sessions: ["old-bot@pc"] }] } } as Record<string, Record<string, unknown>>,
    });
    const t = await sessions(relay);
    expect(t.$(`[data-archive] [data-sid="${SID}"]`)!.textContent).toContain("ops");
    await t.click(t.btn(t.$('[data-f="project"]'), "web"));
    await flush(10);
    expect(relay.sent("points.list").every((f) => !("project" in f))).toBe(true);
    expect(t.$(`[data-archive] [data-sid="${SID}"]`)).toBeNull();
    expect(t.$('[data-archive] [data-sid="old"]')).not.toBeNull();
  });

  it("каталог отказал — «Архив не загрузился» со словом; пустой период — «сессий нет»", async () => {
    const relay = archiveRelay();
    relay.handlers["points.list"] = (f) => (f.sid ? undefined : { ok: false, error: "offline" });
    const t = await sessions(relay);
    expect(t.$('[role="alert"]')!.textContent).toContain("Архив не загрузился: Машина не на связи");
    relay.handlers["points.list"] = CATALOG([]);
    await t.click(t.btn(t.$('[data-f="period"]'), "сегодня"));
    await flush(10);
    expect(t.text()).toContain("За этот период сессий нет.");
  });
});

describe("поиск по переписке", () => {
  it("хранилище ищет — поле над списком; points.list с q и limit, совпадения по сессии, найденное слово отмечено; «Сбросить» — снова каталог", async () => {
    const relay = archiveRelay();
    const list = relay.handlers["points.list"];
    relay.handlers["points.list"] = (f) =>
      f.q ? CATALOG([{ ...SITE_ROW, hits: [{ uuid: "u2", point: 41, at: "2026-10-31T14:40:00.000Z", text: "перенеси журнал в ClickHouse" }] }])() : list(f);
    const t = await sessions(relay);
    await t.type(t.$('[data-f="q"]'), "журнал");
    await t.click(t.btn(t.$(".ss-q"), "Найти"));
    await flush(10);
    expect(relay.sent("points.list").at(-1)).toMatchObject({ q: "журнал", limit: 60 });
    const hit = t.$('[data-hits] [data-hit="u2"]')!;
    expect(hit.querySelector("mark")!.textContent).toBe("журнал");
    expect(t.$(`[data-hits] [data-sid="${SID}"]`)!.textContent).toContain("Перенеси журнал в ClickHouse");
    await t.click(t.btn(t.$(".ss-q"), "Сбросить"));
    await flush(10);
    expect(t.$("[data-hits]")).toBeNull();
    expect(t.$("[data-archive]")).not.toBeNull();
  });

  it("совпадение открывает сессию на этой точке и записи: в адресе sid, point, uuid и q; запись в ленте отмечена", async () => {
    const relay = archiveRelay();
    const list = relay.handlers["points.list"];
    relay.handlers["points.list"] = (f) => (f.q ? CATALOG([{ ...SITE_ROW, hits: [{ uuid: "u2", point: 41, at: "2026-10-31T14:40:00.000Z", text: "перенеси журнал" }] }])() : list(f));
    const t = await sessions(relay);
    await t.type(t.$('[data-f="q"]'), "журнал");
    await t.click(t.btn(t.$(".ss-q"), "Найти"));
    await flush(10);
    await t.click(t.$('[data-hit="u2"]'));
    await flush(10);
    expect(Object.fromEntries(hashParams())).toMatchObject({ sid: SID, point: "41", uuid: "u2", q: "журнал" });
    expect(t.$('.chat-at.hit[data-at="u2"]')).not.toBeNull();
  });

  it("хранилище без поиска (search: false) — поля поиска нет, каталог работает", async () => {
    const relay = archiveRelay();
    const list = relay.handlers["points.list"];
    relay.handlers["points.list"] = (f) => (f.sid ? list(f) : CATALOG([SITE_ROW], { search: false })());
    const t = await sessions(relay);
    expect(t.$('[data-f="q"]')).toBeNull();
    expect(t.$(`[data-archive] [data-sid="${SID}"]`)).not.toBeNull();
  });

  it("поиск отказал словом no_search — «Поиск не прошёл: Поиска нет: хранилище флота — R2»", async () => {
    const relay = archiveRelay();
    const list = relay.handlers["points.list"];
    relay.handlers["points.list"] = (f) => (f.q ? { ok: false, error: "no_search" } : list(f));
    const t = await sessions(relay);
    await t.type(t.$('[data-f="q"]'), "журнал");
    await t.click(t.btn(t.$(".ss-q"), "Найти"));
    await flush(10);
    expect(t.text()).toContain("Поиск не прошёл: Поиска нет: хранилище флота — R2");
  });
});

describe("страница сессии", () => {
  it("разговор — лента web-chat из points.history головы; точки стоят в ней разделителями; линия точек и ветка справа", async () => {
    const relay = archiveRelay();
    const t = await sessionPage(relay);
    expect(hashParams().get("sid")).toBe(SID);
    expect(relay.sent("points.list").filter((f) => f.sid === SID)).toHaveLength(1);
    expect(relay.sent("points.history")[0]).toMatchObject({ to: ".points", sid: SID, point: 41, before: null, limit: 200 });
    const talk = t.$(`[data-archive="${SID}"]`)!;
    expect(talk.textContent).toContain("обнови зависимости и прогони тесты");
    expect(talk.textContent).toContain("Журнал перенесён.");
    expect(t.$$(".chat-pt").map((x) => x.dataset.mark)).toEqual(["38", "41"]);
    // точка 38 (2 записи) — перед третьей записью, а не перед ответом модели; голова — в конце
    expect((t.$('.chat-pt[data-mark="38"]')!.nextElementSibling as HTMLElement).dataset.at).toBe("u2");
    expect(t.$('.chat-pt[data-mark="41"]')!.nextElementSibling).toBeNull();
    expect(t.$$(".ss-line [data-point]").map((x) => x.dataset.point)).toEqual(["41", "38", "33"]);
    expect(t.$('.ss-line [data-point="33"]')!.className).toContain("br");
    expect(t.text()).toContain("Точки и ветки");
    // голова раскрыта: последняя, без «Откатить»
    expect(t.$('[data-card="41"]')!.textContent).toContain("последняя");
    expect(t.$('[data-card="41"] [data-act="rb"]')).toBeNull();
  });

  it("шапка: заголовок, callsign — ссылка в карточку живой, модель, токены, «идёт»", async () => {
    const t = await sessionPage();
    const head = t.$(".ss-head")!;
    expect(head.querySelector(".ss-h")!.textContent).toBe("Перенеси журнал в ClickHouse");
    expect(head.textContent).toContain("opus-5-5");
    expect(head.textContent).toContain("идёт");
    await t.click(t.$('.ss-head [data-f="card"]'));
    await flush(10);
    expect(location.hash).toContain("card");
    expect(location.hash).toContain("site%40laptop");
  });

  it("выбор точки: адрес с point, разговор после неё приглушён, точка раскрыта — факты и действия живой сессии", async () => {
    const t = await sessionPage();
    await pick(t, 38);
    expect(hashParams().get("point")).toBe("38");
    expect(t.$('.chat-pt[data-mark="38"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(t.$('.chat-at[data-at="u2"]')!.className).toContain("after");
    expect(t.$('.chat-at[data-at="u1"]')!.className).not.toContain("after");
    const card = t.$('[data-card="38"]')!;
    expect(card.textContent).toContain("конец хода");
    expect(card.textContent).toContain("laptop");
    expect(card.textContent).toContain("2 записи");
    expect(card.textContent).toContain("git чисто · main");
    expect(["move", "copy", "rb", "pull"].map((a) => !!card.querySelector(`[data-act="${a}"]`))).toEqual([true, true, true, true]);
  });

  it("точка-разделитель в ленте выбирает точку", async () => {
    const t = await sessionPage();
    await t.click(t.$('.chat-pt[data-mark="38"]'));
    await flush(10);
    expect(hashParams().get("point")).toBe("38");
    expect(t.$('[data-card="38"]')).not.toBeNull();
  });

  it("точка ветки — разговор на ней: points.history с её номером, без разделителей линии", async () => {
    const relay = archiveRelay();
    const t = await sessionPage(relay);
    await pick(t, 33);
    expect(relay.sent("points.history").some((f) => f.point === 33)).toBe(true);
    expect(t.$$(".chat-pt")).toHaveLength(0);
  });

  it("«На свой компьютер» — команда pull: у головы без --point, у старой точки — с её номером", async () => {
    const t = await sessionPage();
    await t.click(t.$('[data-card="41"] [data-act="pull"]'));
    expect(t.$('[data-pull="41"]')!.textContent).toContain("switchboard pull site@laptop");
    expect(t.$('[data-pull="41"]')!.textContent).not.toContain("--point");
    await pick(t, 38);
    await t.click(t.$('[data-card="38"] [data-act="pull"]'));
    expect(t.$('[data-pull="38"]')!.textContent).toContain("switchboard pull site@laptop --point 38");
  });

  it("вызовы модели точки — из points.history: время, модель, токены; «Правила» ведут в настройки с вызовом", async () => {
    const relay = archiveRelay();
    const t = await sessionPage(relay);
    const calls = t.$('[data-calls="41"]')!;
    expect(calls.querySelectorAll("[data-call]")).toHaveLength(CALLS.length);
    expect(calls.querySelector('[data-call="a2"]')!.textContent).toContain("3,1 M → 88 K");
    await t.click(calls.querySelector('[data-call="a2"] [data-f="test-rules"]'));
    await flush(10);
    expect(location.hash).toContain("settings");
    expect(Object.fromEntries(hashParams())).toMatchObject({ tab: "rules", call: `${SID}/a2` });
  });

  it("«Сохранить точку» — points.save, итог «Точка №N»; та же — «— та же»; отказ — словом", async () => {
    const relay = archiveRelay();
    const t = await sessionPage(relay);
    await t.click(t.btn(t.$(".ss-head"), "Сохранить точку"));
    await flush(10);
    expect(relay.sent("points.save")[0]).toMatchObject({ callsign: "site@laptop" });
    expect(t.$("[data-note]")!.textContent).toBe("Точка №42");
    relay.handlers["points.save"] = () => ({ ok: true, result: { point: 41, same: true } });
    await t.click(t.btn(t.$(".ss-head"), "Сохранить точку"));
    await flush(10);
    expect(t.$("[data-note]")!.textContent).toBe("Точка №41 — та же");
    relay.handlers["points.save"] = () => ({ ok: false, error: "waiting" });
    await t.click(t.btn(t.$(".ss-head"), "Сохранить точку"));
    await flush(10);
    expect(t.$("[data-note]")!.textContent).toContain("ждёт ответа человека");
  });

  it("строка каталога без заголовка — имя callsign; без callsign — sid", async () => {
    const relay = archiveRelay();
    const list = relay.handlers["points.list"];
    relay.handlers["points.list"] = (f) => (f.sid ? list(f) : CATALOG([{ ...SITE_ROW, title: undefined }, { ...OLD, callsign: undefined, title: undefined }])());
    const t = await sessions(relay);
    expect(t.$(`[data-archive] [data-sid="${SID}"] .ss-title`)!.textContent).toBe("site");
    expect(t.$('[data-archive] [data-sid="old"] .ss-title')!.textContent).toBe("old");
  });
});

describe("действия точки", () => {
  it("196 · перенос из свежей точки: проба к pc → points.save со стопом → points.raise с её номером → итог со ссылкой на новую, выбрана новая последняя", async () => {
    const relay = archiveRelay();
    const t = await sessionPage(relay);
    await t.click(t.$('[data-card="41"] [data-act="move"]'));
    await flush(10);
    expect(t.$('[data-dlg="move"]')!.textContent).toContain("Перенести на машину site@laptop — из свежей точки");
    expect(relay.sent("points.raise").find((f) => f.dryRun)).toMatchObject({ machine: "pc", sid: SID, point: 41 });
    await t.click(t.$('[data-act="run"]'));
    await flush(10);
    expect(steps(relay)).toEqual([
      expect.objectContaining({ type: "points.save", callsign: "site@laptop", stop: true }),
      expect.objectContaining({ type: "points.raise", machine: "pc", sid: SID, point: 42, files: "point" }),
    ]);
    expect(t.$('[data-dlg="move"]')).toBeNull();
    expect(t.$("[data-done]")!.textContent).toContain("site перенесена на pc:");
    expect(t.$('[data-done] [data-f="result"]')!.textContent).toBe("site@pc");
    expect(hashParams().get("point")).toBeNull();
  });

  it("перенос из старой точки — подъём с её номером; отказ подъёма — словом в окне, окно остаётся", async () => {
    const relay = archiveRelay();
    const t = await sessionPage(relay);
    await pick(t, 38);
    await t.click(t.$('[data-card="38"] [data-act="move"]'));
    await flush(10);
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : { ok: false, error: "bad_dir" });
    await t.click(t.$('[data-act="run"]'));
    await flush(10);
    expect(steps(relay, ["points.raise"])[0]).toMatchObject({ point: 38 });
    expect(t.$('[data-dlg="move"] [data-phase="err"]')!.textContent).toContain("другой репозиторий");
  });

  it("копия из точки 38 — без points.save, copy и имя копии; итог «Копия поднята:»", async () => {
    const relay = archiveRelay();
    const t = await sessionPage(relay);
    await pick(t, 38);
    await t.click(t.$('[data-card="38"] [data-act="copy"]'));
    await flush(10);
    await t.click(t.$('[data-act="run"]'));
    await flush(10);
    expect(steps(relay)).toEqual([expect.objectContaining({ type: "points.raise", point: 38, copy: true, name: "site-copy" })]);
    expect(t.$("[data-done]")!.textContent).toContain("Копия поднята:");
  });

  it("263 · откат к точке 38: та же машина, «как сейчас» по умолчанию; points.save со стопом, затем points.raise с точкой 38 и files keep", async () => {
    const relay = archiveRelay();
    const t = await sessionPage(relay);
    await pick(t, 38);
    await t.click(t.$('[data-card="38"] [data-act="rb"]'));
    await flush(10);
    expect(t.$('[data-dlg="rb"]')!.textContent).toContain("Откатить site@laptop к №38");
    expect(t.$('[data-dlg="rb"] [data-remote]')).not.toBeNull();
    await t.click(t.$('[data-act="run"]'));
    await flush(10);
    expect(steps(relay)).toEqual([
      expect.objectContaining({ type: "points.save", stop: true }),
      expect.objectContaining({ type: "points.raise", machine: "laptop", point: 38, files: "keep" }),
    ]);
    expect(t.$("[data-done]")!.textContent).toContain("Откат к №38");
  });

  it("261 · смена папки: points.save со стопом → points.raise copy в новую папку, files keep → «Забыть» прежней → итог", async () => {
    const relay = archiveRelay();
    const t = await sessionPage(relay);
    await t.click(t.$('.ss-head [data-act="dir"]'));
    await flush(10);
    await t.click(t.$('[data-act="run"]'));
    await flush(10);
    expect(steps(relay)).toEqual([
      expect.objectContaining({ type: "points.save", stop: true }),
      expect.objectContaining({ type: "points.raise", machine: "laptop", copy: true, files: "keep", dir: "~/Projects/site-v2" }),
      expect.objectContaining({ type: "session.remove", callsign: "site@laptop" }),
    ]);
    expect(t.$("[data-done]")!.textContent).toContain("Копия в новой папке, site@laptop забыта:");
  });

  it("окно закрывается Escape; повторное нажатие действия закрывает его", async () => {
    const t = await sessionPage();
    await t.click(t.$('[data-card="41"] [data-act="copy"]'));
    expect(t.$('[data-dlg="copy"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(t.$('[data-dlg="copy"]')).toBeNull();
    await t.click(t.$('[data-card="41"] [data-act="copy"]'));
    await t.click(t.$('[data-card="41"] [data-act="copy"]'));
    expect(t.$('[data-dlg="copy"]')).toBeNull();
  });
});

describe("сессия только в архиве", () => {
  it("4170 · подъём: «Поднять на машине…» вместо переноса; проба и points.raise с выбранной точкой; итог «Поднята:» со ссылкой", async () => {
    const relay = archiveRelay();
    const t = await sessionPage(relay, "old");
    const card = t.$('[data-card="4"]')!;
    expect(card.querySelector('[data-act="move"]')).toBeNull();
    expect(t.$(".ss-head")!.textContent).toContain("в архиве");
    expect(t.$('.ss-head [data-f="card"]')).toBeNull();
    await t.click(card.querySelector('[data-act="raise"]'));
    await flush(10);
    const run = t.btn(t.$('[data-dlg="raise"]'), /^Поднять на /)!;
    await t.click(run);
    await flush(10);
    expect(steps(relay, ["points.raise"])[0]).toMatchObject({ sid: "old", point: 4, dir: "~/b", files: "point" });
    expect(t.$("[data-done]")!.textContent).toContain("Поднята:");
  });

  it("198 · удаление из архива: после ввода имени — points.delete { sid }, назад к каталогу", async () => {
    const relay = archiveRelay();
    relay.handlers["points.delete"] = () => ({ ok: true, result: { points: 4, blocks: 3, bytes: 1000 } });
    const t = await sessionPage(relay, "old");
    await t.click(t.$('.ss-head [data-act="delete"]'));
    const go = t.$<HTMLButtonElement>('[data-dlg="delete"] [data-act="delete"]')!;
    expect(go.disabled).toBe(true);
    await t.type(t.$('[data-f="del:old"]'), "Чистка старых логов");
    await t.click(go);
    await flush(10);
    expect(relay.sent("points.delete")[0]).toMatchObject({ to: ".points", sid: "old" });
    expect(hashParams().get("sid")).toBeNull();
  });

  it("4165 · отказ points.delete — слово на странице, сессия остаётся", async () => {
    const relay = archiveRelay();
    relay.handlers["points.delete"] = () => ({ ok: false, error: "offline" });
    const t = await sessionPage(relay, "old");
    await t.click(t.$('.ss-head [data-act="delete"]'));
    await t.type(t.$('[data-f="del:old"]'), "Чистка старых логов");
    await t.click(t.$('[data-dlg="delete"] [data-act="delete"]'));
    await flush(10);
    expect(t.$("[data-note]")!.textContent).toBe("Машина не на связи");
    expect(hashParams().get("sid")).toBe("old");
  });

  it("нет машин с points.raise — подъёма нет", async () => {
    const relay = archiveRelay((r) => {
      for (const m of r.machines) delete m.contract!["points.raise"];
    });
    const t = await sessionPage(relay, "old");
    expect(t.$('[data-card="4"] [data-act="raise"]')).toBeNull();
    expect(t.$('[data-card="4"] [data-act="pull"]')).not.toBeNull();
  });
});

describe("«пожар»", () => {
  /** Архив с сессиями хозяина mac (mac не в roster) и ответы машин на пробы и подъём. */
  function fireRelay() {
    const relay = fleetRelay(fleetRoster());
    relay.handlers["points.list"] = CATALOG([
      { sid: "s1", callsign: "one@mac", title: "Первая", dir: "~/p1", owner: "mac", head: { id: 5, at: at(9, 0) }, points: 5, branches: 0 },
      { sid: "s2", callsign: "two@mac", dir: "~/p2", owner: "mac", head: { id: 9, at: at(9, 30) }, points: 9, branches: 0 },
    ]);
    relay.handlers["ledger.read"] = () => ({ ok: true, result: { events: [{ id: 1, t: at(10, 0), ev: "machine.left", from: ".relay", text: "mac ушла" }], more: false } });
    relay.handlers[SLOTS] = (f) => ({ ok: true, result: { slots: { [f.machine === "pc" ? "main" : "bot"]: {} } } });
    relay.handlers["points.raise"] = (f) => (f.dryRun ? { ok: true, result: { folder: "same" } } : f.sid === "s2" ? { ok: false, error: "open_failed" } : { ok: true, result: { callsign: `one@${f.machine}` } });
    return relay;
  }

  it("197 · mac нет в roster — плашка «mac не на связи · 2 сессии ждут»; проба на каждую; points.raise по одной; open_failed — строка «не поднялась»", async () => {
    const relay = fireRelay();
    const t = await sessions(relay);
    expect(t.$('[data-fire="mac"]')!.textContent).toContain("mac не на связи");
    expect(t.$('[data-fire="mac"]')!.textContent).toContain("2 сессии ждут на последних точках");
    await t.click(t.btn(t.$('[data-fire="mac"]'), "Перенести на другую машину…"));
    await flush(10);
    expect(relay.sent("points.raise").filter((f) => f.dryRun).map((f) => f.sid).sort()).toEqual(["s1", "s2"]);
    await t.click(t.btn(t.$('[data-dlg="fire"]'), /^Перенести 2 из 2/));
    await flush(10);
    expect(steps(relay, ["points.raise"]).map((f) => f.sid)).toEqual(["s1", "s2"]);
    expect(steps(relay, ["points.save"])).toHaveLength(0);
    expect(t.$('[data-dlg="fire"]')!.textContent).toContain("не поднялась");
    expect(t.$("[data-progress]")!.dataset.progress).toBe("1/2");
  });

  it("7251 · метка fire знает ушедшую машину без экрана «Сессии»: каталог спрошен один раз, журнал флота — нет", async () => {
    const relay = fireRelay();
    const t = await pult({ relay, url: "/#inbox" });
    await flush(10);
    expect(t.$('[data-kind="fire"]')!.textContent).toContain("машин не на связи: 1");
    expect(relay.sent("points.list")).toHaveLength(1);
    expect(relay.sent("ledger.read")).toHaveLength(0);
  });
});

describe("вкладка «Архив» карточки", () => {
  it("4177 · вкладка — только у машины с session.archive; линия точек и «Хранить в архиве» отмечено; разговора во вкладке нет", async () => {
    const relay = archiveRelay();
    const t = await cardTab(relay);
    expect(t.$('.cw-tabs [data-tab="session.points"]')!.textContent).toBe("Архив");
    expect(t.$('.ss-line [data-point="41"]')).not.toBeNull();
    expect(t.$<HTMLInputElement>('[data-act="archive"]')!.checked).toBe(true);
    expect(t.$("[data-archive]")).toBeNull();
    const off = archiveRelay((r) => {
      for (const m of r.machines) delete m.contract!["session.archive"];
    });
    const t2 = await pult({ relay: off });
    await t2.expand();
    await t2.click(t2.$('[data-callsign="site@laptop"]'));
    expect(t2.$('.cw-tabs [data-tab="session.points"]')).toBeNull();
  });

  it("не в архиве: галочка — session.archive on, «Первая точка — №N»; без файла — «на конце хода»; отказ — словом", async () => {
    const relay = archiveRelay((r) => void delete r.sessions[2].archive);
    relay.handlers["session.archive"] = () => ({ ok: true, result: { point: 7 } });
    const t = await cardTab(relay);
    expect(relay.sent("points.list").filter((f) => f.sid)).toHaveLength(0);
    await t.click(t.$('[data-act="archive"]'));
    await flush(10);
    expect(relay.sent("session.archive")[0]).toMatchObject({ callsign: "site@laptop", on: true });
    expect(t.$("[data-note]")!.textContent).toBe("Первая точка — №7.");
    relay.handlers["session.archive"] = () => ({ ok: true, result: { point: null } });
    await t.click(t.$('[data-act="archive"]'));
    await flush(10);
    expect(t.$("[data-note]")!.textContent).toBe("Первая точка — на конце хода.");
    relay.handlers["session.archive"] = () => ({ ok: false, error: "offline" });
    await t.click(t.$('[data-act="archive"]'));
    await flush(10);
    expect(t.$("[data-note]")!.textContent).toBe("Машина не на связи");
  });

  it("262 · снятие: подтверждение именем; session.archive off — «N точек удалено», points.delete нет", async () => {
    const relay = archiveRelay();
    relay.handlers["session.archive"] = () => ({ ok: true, result: { deleted: 12 } });
    const t = await cardTab(relay);
    await t.click(t.$('[data-act="archive"]'));
    const go = t.$<HTMLButtonElement>('[data-dlg="unmark"] [data-act="unmark"]')!;
    await t.type(t.$('[data-f="unmark"]'), "sit");
    expect(go.disabled).toBe(true);
    await t.type(t.$('[data-f="unmark"]'), "site");
    await t.click(go);
    await flush(10);
    expect(relay.sent("session.archive")[0]).toMatchObject({ callsign: "site@laptop", on: false });
    expect(relay.sent("points.delete")).toHaveLength(0);
    expect(t.$("[data-note]")!.textContent).toBe("12 точек удалено.");
  });

  it("4176 · последняя точка не удалась — поле archive { error } словом во вкладке", async () => {
    const relay = archiveRelay((r) => void (r.sessions[2].archive = { error: "offline", at: at(14, 0) }));
    const t = await cardTab(relay);
    expect(t.$("[data-failed]")!.textContent).toBe("последняя точка не удалась: Машина не на связи");
  });

  it("вкладка открывается своим адресом #session-points", async () => {
    const t = await pult({ relay: archiveRelay(), url: "/#session-points?callsign=site%40laptop" });
    await flush(10);
    expect(t.$('.ss-line [data-point="41"]')).not.toBeNull();
  });
});
