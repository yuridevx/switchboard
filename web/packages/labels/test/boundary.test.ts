// Леса границы «настройки людей и флота», сторона страницы: web-labels — настоящий модуль на поддельном relay.
// Источник: дизайн «Сессии, проекты и профили» (блок «Эталоны», «найс делай» пользователя 3 нояб.): имена сессии и машины — у почты; пустое — снова адрес; настоящий адрес виден в окне «Имена». Номер — эталон-источник; без номера — чьё: код.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, Fragment, useState } from "react";
import type { App, AppModule, Manifest } from "@switchboard/web-core";
import { createLabels, manifest } from "../contract.ts";
import { FakeRelay, flush, homeRoster, stand } from "../../core/stand/app.ts";

type Shown = { text: string; human: boolean };

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

/** Хозяин окна: своего экрана у web-labels нет, окно открывает вызывающий. */
function host(params: Record<string, string> = { callsign: "site@laptop" }) {
  let app: App;
  const own: Manifest = { name: "host-screen", type: "web", version: "1.0.0", provides: { names: 1 }, uses: { "app@web-core": 2, "labels@web-labels": 1, "label.session@web-labels": 1, "label.machine@web-labels": 1 } };
  const module: AppModule = {
    screens: {
      names: {
        nav: "Имена",
        // окно открывается нажатием, как в карточке
        view: function Names() {
          const [state, set] = useState<"" | "open" | "closed">("");
          return createElement(
            Fragment,
            null,
            createElement("button", { "data-open": "1", onClick: () => set("open") }),
            createElement("div", { "data-place": "1" }, state === "open" ? createElement(app.Slot, { screen: "labels", params, close: () => set("closed") }) : state),
          );
        },
      },
    },
  };
  return { own, module, app: (a: App) => void (app = a), session: (c: string) => app.mark("label.session", c) as Shown, machine: (m: string) => app.mark("label.machine", m) as Shown };
}

async function bench(values: Record<string, unknown>, params: Record<string, string> | undefined, url: string, wide?: boolean) {
  const relay = Object.assign(new FakeRelay(homeRoster()), { scoped: { global: values } });
  const x = host(params);
  const t = await stand([{ manifest, module: createLabels }, { manifest: x.own, module: (a) => (x.app(a), x.module) }], { relay, url, wide });
  await flush(5);
  return { t, relay, x };
}
async function open(values: Record<string, unknown> = {}, params?: Record<string, string>, wide?: boolean) {
  const b = await bench(values, params, "/#names", wide);
  await b.t.click(b.t.$("[data-open]"));
  return b;
}
const fill = async (t: Awaited<ReturnType<typeof stand>>, f: string, v: string) => {
  const e = t.$<HTMLInputElement>(`[data-f="${f}"]`)!;
  e.value = v;
  e.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
};
const press = async (t: Awaited<ReturnType<typeof stand>>, f: string, key: string) => {
  t.$(`[data-f="${f}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  await flush(5);
};
const place = (t: Awaited<ReturnType<typeof stand>>) => t.$('[data-place="1"]')!.textContent;

describe("метки", () => {
  it("имени нет — короткий адрес без отметки human; задано — имя с отметкой; адрес другой сессии имя не получает", async () => {
    const { x } = await bench({ "fleet.labels": { sessions: { "site@laptop": "Сайт" }, machines: { laptop: "ПК" } } }, undefined, "/#names");
    expect(x.session("site@laptop")).toEqual({ text: "Сайт", human: true });
    expect(x.machine("laptop")).toEqual({ text: "ПК", human: true });
    expect(x.session("wiki@laptop")).toEqual({ text: "wiki", human: false });
    expect(x.machine("pc")).toEqual({ text: "@pc", human: false });
  });

  it("имена читаются из области флота и только своими ключами", async () => {
    const { relay } = await bench({}, undefined, "/#names");
    const gets = relay.sent("prefs.get");
    expect(gets.length).toBeGreaterThan(0);
    for (const g of gets) expect(g).toMatchObject({ scope: "global", prefix: "fleet." });
  });
});

describe("окно «Имена»", () => {
  it("вид окна сессии: заголовок, настоящий адрес, две подписи, подсказки — адрес, кнопки", async () => {
    const { t } = await open();
    const dlg = t.$('.lb-dlg[role="dialog"]')!;
    expect(dlg.getAttribute("aria-label")).toBe("Имена");
    expect(dlg.querySelector("b")!.textContent).toBe("Имена");
    expect(t.$(".lb-a")!.textContent).toBe("site@laptop");
    expect([...dlg.querySelectorAll(".lb-f span")].map((s) => s.textContent)).toEqual(["Имя сессии", "Имя машины"]);
    expect(t.$('[data-f="session"]')!.getAttribute("placeholder")).toBe("site");
    expect(t.$('[data-f="machine"]')!.getAttribute("placeholder")).toBe("@laptop");
    expect(t.$('[data-f="session"]')!.getAttribute("autocomplete")).toBe("off");
    expect([...dlg.querySelectorAll(".lb-ft button")].map((b) => b.textContent)).toEqual(["Отмена", "Сохранить"]);
  });

  it("окно только машины: адрес машины, поля сессии нет; сохранение пишет только машину", async () => {
    const { t, relay } = await open({ "fleet.labels": { sessions: { "site@laptop": "Сайт" }, machines: {} } }, { machine: "laptop" });
    expect(t.$(".lb-a")!.textContent).toBe("@laptop");
    expect(t.$('[data-f="session"]')).toBeNull();
    expect([...t.$$(".lb-f span")].map((s) => s.textContent)).toEqual(["Имя машины"]);
    await fill(t, "machine", "ПК");
    await t.click(t.$('[data-act="save"]'));
    await flush(5);
    expect(relay.scoped.global["fleet.labels"]).toEqual({ sessions: { "site@laptop": "Сайт" }, machines: { laptop: "ПК" } });
  });

  it("машина окна — из адреса сессии; заданная в параметрах важнее", async () => {
    const { t } = await open({ "fleet.labels": { machines: { laptop: "ПК", pc: "Сервер" } } }, { callsign: "site@laptop" });
    expect(t.$<HTMLInputElement>('[data-f="machine"]')!.value).toBe("ПК");
    const other = await open({ "fleet.labels": { machines: { laptop: "ПК", pc: "Сервер" } } }, { callsign: "site@laptop", machine: "pc" });
    expect(other.t.$<HTMLInputElement>('[data-f="machine"]')!.value).toBe("Сервер");
    expect(other.t.$('[data-f="machine"]')!.getAttribute("placeholder")).toBe("@pc");
  });

  it.each<[string, boolean]>([
    ["широкий экран: окно по центру", true],
    ["узкий экран: окно снизу", false],
  ])("%s", async (_n, wide) => {
    const { t } = await open({}, undefined, wide);
    expect(t.$(".lb-veil")!.classList.contains("narrow")).toBe(!wide);
  });

  it("7264 · окно открылось: фокус на первом поле — имя сессии, а без сессии имя машины", async () => {
    const a = await open();
    expect(document.activeElement).toBe(a.t.$('[data-f="session"]'));
    const b = await open({}, { machine: "laptop" });
    expect(document.activeElement).toBe(b.t.$('[data-f="machine"]'));
  });

  it("5270 · имени нет — короткий адрес; окно показывает настоящий адрес; задано — вместо адреса, пишется у почты", async () => {
    const { t, relay, x } = await open();
    expect(x.session("site@laptop")).toEqual({ text: "site", human: false });
    expect(x.machine("laptop")).toEqual({ text: "@laptop", human: false });
    await fill(t, "session", " Сайт ");
    await fill(t, "machine", "Домашний ПК");
    await t.click(t.$('[data-act="save"]'));
    await flush(5);
    expect(x.session("site@laptop")).toEqual({ text: "Сайт", human: true });
    expect(x.machine("laptop")).toEqual({ text: "Домашний ПК", human: true });
    expect(relay.scoped.global["fleet.labels"]).toEqual({ sessions: { "site@laptop": "Сайт" }, machines: { laptop: "Домашний ПК" } });
    expect(place(t)).toBe("closed");
  });

  it("5271 · пустое — снова адрес; имена других сессий не трогает", async () => {
    const { t, relay, x } = await open({ "fleet.labels": { sessions: { "site@laptop": "Сайт", "wiki@laptop": "Вики" }, machines: {} } });
    expect(t.$<HTMLInputElement>('[data-f="session"]')!.value).toBe("Сайт");
    await fill(t, "session", "");
    await t.click(t.$('[data-act="save"]'));
    await flush(5);
    expect(x.session("site@laptop")).toEqual({ text: "site", human: false });
    expect(relay.scoped.global["fleet.labels"]).toEqual({ sessions: { "wiki@laptop": "Вики" }, machines: {} });
  });

  it("Enter в поле сохраняет и закрывает", async () => {
    const { t, relay } = await open();
    await fill(t, "session", "Сайт");
    await press(t, "session", "Enter");
    expect(relay.sent("prefs.set")).toHaveLength(1);
    expect(place(t)).toBe("closed");
  });

  it.each<[string, (t: Awaited<ReturnType<typeof stand>>) => Promise<void>]>([
    ["5272 · Escape", (t) => press(t, "session", "Escape")],
    ["5272 · «Отмена»", (t) => t.click(t.button("Отмена"))],
    ["нажатие мимо окна", (t) => t.click(t.$(".lb-veil"))],
  ])("%s — без записи, окно закрыто", async (_n, close) => {
    const { t, relay } = await open();
    await fill(t, "session", "Сайт");
    await close(t);
    await flush(5);
    expect(relay.sent("prefs.set")).toHaveLength(0);
    expect(place(t)).toBe("closed");
  });

  it("нажатие внутри окна не закрывает его", async () => {
    const { t } = await open();
    await t.click(t.$(".lb-a"));
    expect(t.$(".lb-dlg")).not.toBeNull();
  });

  it("7342 · экран открыт по адресу: «Отмена» уводит с него, а не молчит", async () => {
    // источник: бэклог — «Отмена» ничего не делает, нет close; у окна в месте close передаёт вызывающий
    const { t } = await bench({}, undefined, "/#names");
    location.hash = "#labels?machine=laptop";
    await flush(5);
    expect(t.$(".lb-a")!.textContent).toBe("@laptop");
    await t.click(t.button("Отмена"));
    await flush(5);
    expect(location.hash).toBe("#names");
    expect(t.$(".lb-dlg")).toBeNull();
  });

  it("отказ записи — словом на экране; окно уже закрыто, имя на экране осталось", async () => {
    const { t, relay, x } = await open();
    relay.handlers["prefs.set"] = () => ({ ok: false, error: "too_large" });
    await fill(t, "session", "Сайт");
    await t.click(t.$('[data-act="save"]'));
    await flush(10);
    expect(document.body.textContent).toContain("Настройка не сохранилась: too_large");
    expect(place(t)).toBe("closed");
    expect(x.session("site@laptop")).toEqual({ text: "Сайт", human: true });
  });
});
