// Выборка вида и событие открытого экрана: равные ветви ответа сохраняют ссылку, on.current приходит на каждый переход.
import { describe, expect, it } from "vitest";
import { share } from "../src/same.ts";
import { FakeRelay, flush, homeRoster, stand } from "../stand/app.ts";
import type { AppPart, Params } from "../contract.ts";

describe("share", () => {
  it("6240 · всё равно — прошлый ответ; изменилась одна ветвь — соседние ветви прежние", () => {
    const a = { list: [{ id: 1, s: { x: 1 } }, { id: 2, s: { x: 2 } }], n: 1 };
    expect(share(a, structuredClone(a))).toBe(a);
    const b = structuredClone(a);
    b.list[1].s.x = 9;
    const c = share(a, b);
    expect(c).not.toBe(a);
    expect(c.list[0]).toBe(a.list[0]);
    expect(c.list[1]).not.toBe(a.list[1]);
    expect(c.list[1].s.x).toBe(9);
  });

  it("6241 · ключ убран, длина изменилась, не простой объект — новый ответ верен", () => {
    expect(share({ a: 1, b: 2 } as { a: number; b?: number }, { a: 1 })).toEqual({ a: 1 });
    expect(share([1, 2], [1])).toEqual([1]);
    const d = new Date();
    expect(share({ d: new Date(0) }, { d }).d).toBe(d);
    expect(share<unknown>({ a: 1 }, [1])).toEqual([1]);
  });
});

describe("on.current", () => {
  it("6242 · открытый экран приходит модулю с параметрами на каждый переход; экран в снимке уже новый", async () => {
    const seen: Array<{ screen: string; params: Params }> = [];
    const shown: Array<string | undefined> = [];
    let app!: Parameters<NonNullable<AppPart["module"]["start"]>>[0];
    const part: AppPart = {
      manifest: { name: "m", type: "web", version: "1.0.0", provides: { a: 1, b: 1 }, uses: {} },
      module: {
        on: {
          current: (c) => {
            seen.push(c);
            shown.push(app.current()?.screen);
          },
        },
        screens: { a: { nav: "А", view: () => null }, b: { path: "b", view: () => null } },
        start: (x) => {
          app = x;
        },
      },
    };
    await stand([part], { relay: new FakeRelay(homeRoster()) });
    await flush();
    expect(seen).toEqual([{ screen: "a", params: {} }]);
    app.open("b", { callsign: "x@y" });
    await flush();
    expect(seen.at(-1)).toEqual({ screen: "b", params: { callsign: "x@y" } });
    expect(shown).toEqual(["a", "b"]);
  });
});
