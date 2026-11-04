// web-labels на стенде. Источник: дизайн «Сессии, проекты и профили» (блок «Эталоны», «найс делай» пользователя 3 нояб.):
// имена сессии и машины — у почты; пустое — снова адрес; настоящий адрес виден в окне «Имена».
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

async function open(values: Record<string, unknown> = {}, params?: Record<string, string>) {
  const relay = Object.assign(new FakeRelay(homeRoster()), { scoped: { global: values } });
  const x = host(params);
  const t = await stand([{ manifest, module: createLabels }, {
      manifest: x.own,
      module: (a) => {
        x.app(a);
        return x.module;
      },
    }], { relay, url: "/#names" });
  await flush(5);
  await t.click(t.$("[data-open]"));
  return { t, relay, x };
}
const fill = async (t: Awaited<ReturnType<typeof stand>>, f: string, v: string) => {
  const e = t.$<HTMLInputElement>(`[data-f="${f}"]`)!;
  e.value = v;
  e.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
};

describe("имена", () => {
  it("7264 · окно открылось: фокус на первом поле — имя сессии, а без сессии имя машины", async () => {
    // источник: чьё: код
    const a = await open();
    expect(document.activeElement).toBe(a.t.$('[data-f="session"]'));
    const b = await open({}, { machine: "laptop" });
    expect(document.activeElement).toBe(b.t.$('[data-f="machine"]'));
  });

  it("5270 · имени нет — короткий адрес; окно показывает настоящий адрес; задано — вместо адреса, пишется у почты", async () => {
    const { t, relay, x } = await open();
    expect(x.session("site@laptop")).toEqual({ text: "site", human: false });
    expect(x.machine("laptop")).toEqual({ text: "@laptop", human: false });
    expect(t.$(".lb-a")!.textContent).toBe("site@laptop");
    await fill(t, "session", "Сайт");
    await fill(t, "machine", "Домашний ПК");
    await t.click(t.$('[data-act="save"]'));
    await flush(5);
    expect(x.session("site@laptop")).toEqual({ text: "Сайт", human: true });
    expect(x.machine("laptop")).toEqual({ text: "Домашний ПК", human: true });
    expect(relay.scoped.global["fleet.labels"]).toEqual({ sessions: { "site@laptop": "Сайт" }, machines: { laptop: "Домашний ПК" } });
    expect(t.$('[data-place="1"]')!.textContent).toBe("closed");
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

  it("5272 · Escape и «Отмена» — без записи", async () => {
    const { t, relay } = await open();
    await fill(t, "session", "Сайт");
    t.$('[data-f="session"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush(5);
    expect(relay.sent("prefs.set")).toHaveLength(0);
    expect(t.$('[data-place="1"]')!.textContent).toBe("closed");
  });
});
