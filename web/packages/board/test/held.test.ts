// Удержание ответа выборки: новый ответ — одно рисование, пока нельзя рисовать — прошлый ответ и ни одного.
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { App, AppPart } from "@switchboard/web-core";
import { useHeld } from "../src/useHeld.ts";
import { FakeRelay, flush, homeRoster, stand } from "../../core/stand/app.ts";

describe("useHeld", () => {
  it("7291 · новый ответ — одно рисование; удержан — прошлый ответ без рисования; отпустили — новый", async () => {
    // источник: чьё: код — выборка отдаёт прошлый ответ, пока held; второй проход рисования убран (отчёт архитектора)
    let value = 1;
    let hold = false;
    let renders = 0;
    let app!: App;
    function Screen() {
      const v = useHeld(() => value);
      renders++;
      return createElement("div", { className: "h" }, String(v));
    }
    const part: AppPart = {
      manifest: { name: "h", type: "web", version: "1.0.0", provides: { h: 1 }, uses: {} },
      module: (a) => {
        app = a;
        return { state: { held: () => hold }, screens: { h: { nav: "H", view: Screen } } };
      },
    };
    const t = await stand([part], { relay: new FakeRelay(homeRoster()) });
    await flush();
    const text = () => t.$(".h")!.textContent;
    expect(text()).toBe("1");
    const step = async () => {
      const was = renders;
      app.changed();
      await flush();
      return renders - was;
    };
    value = 2;
    expect(await step()).toBe(1);
    expect(text()).toBe("2");
    hold = true;
    value = 3;
    expect(await step()).toBe(0);
    expect(text()).toBe("2");
    hold = false;
    expect(await step()).toBe(1);
    expect(text()).toBe("3");
  });
});
