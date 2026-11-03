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
function host() {
  let app: App;
  const own: Manifest = { name: "host-screen", type: "web", version: "1.0.0", provides: { names: 1 }, uses: { "app@web-core": 1, "labels@web-labels": 1, "label.session@web-labels": 1, "label.machine@web-labels": 1 } };
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
            createElement("div", { "data-place": "1" }, state === "open" ? createElement(app.Slot, { screen: "labels", params: { callsign: "site@laptop" }, close: () => set("closed") }) : state),
          );
        },
      },
    },
    start: (a) => void (app = a),
  };
  return { own, module, session: (c: string) => app.mark("label.session", c) as Shown, machine: (m: string) => app.mark("label.machine", m) as Shown };
}

async function open(values: Record<string, unknown> = {}) {
  const relay = Object.assign(new FakeRelay(homeRoster()), { values });
  const x = host();
  const t = await stand([{ manifest, module: createLabels() }, { manifest: x.own, module: x.module }], { relay, url: "/#names" });
  await flush(5);
  await t.click(t.$("[data-open]"));
  return { t, relay, x };
}
const fill = (t: Awaited<ReturnType<typeof stand>>, f: string, v: string) => {
  const e = t.$<HTMLInputElement>(`[data-f="${f}"]`)!;
  e.value = v;
};

describe("имена", () => {
  it("5270 · имени нет — короткий адрес; окно показывает настоящий адрес; задано — вместо адреса, пишется у почты", async () => {
    const { t, relay, x } = await open();
    expect(x.session("site@laptop")).toEqual({ text: "site", human: false });
    expect(x.machine("laptop")).toEqual({ text: "@laptop", human: false });
    expect(t.$(".lb-a")!.textContent).toBe("site@laptop");
    fill(t, "session", "Сайт");
    fill(t, "machine", "Домашний ПК");
    await t.click(t.$('[data-act="save"]'));
    await flush(5);
    expect(x.session("site@laptop")).toEqual({ text: "Сайт", human: true });
    expect(x.machine("laptop")).toEqual({ text: "Домашний ПК", human: true });
    expect(relay.values["web-labels.names"]).toEqual({ sessions: { "site@laptop": "Сайт" }, machines: { laptop: "Домашний ПК" } });
    expect(t.$('[data-place="1"]')!.textContent).toBe("closed");
  });

  it("5271 · пустое — снова адрес; имена других сессий не трогает", async () => {
    const { t, relay, x } = await open({ "web-labels.names": { sessions: { "site@laptop": "Сайт", "wiki@laptop": "Вики" }, machines: {} } });
    expect(t.$<HTMLInputElement>('[data-f="session"]')!.value).toBe("Сайт");
    fill(t, "session", "");
    await t.click(t.$('[data-act="save"]'));
    await flush(5);
    expect(x.session("site@laptop")).toEqual({ text: "site", human: false });
    expect(relay.values["web-labels.names"]).toEqual({ sessions: { "wiki@laptop": "Вики" }, machines: {} });
  });

  it("5272 · Escape и «Отмена» — без записи", async () => {
    const { t, relay } = await open();
    fill(t, "session", "Сайт");
    t.$('[data-f="session"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush(5);
    expect(relay.sent("prefs.set")).toHaveLength(0);
    expect(t.$('[data-place="1"]')!.textContent).toBe("closed");
  });
});
