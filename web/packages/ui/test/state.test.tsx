// Основа состояния и подписи набора: снимок, данные экрана, часы, поле с фиксацией, цикл ответов машин, словарь и форматы.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ago, at, CommitIn, createStore, duration, failText, folderOf, isLive, lamp, machineAnswers, plural, stateLabel, useLoad, useNow } from "../contract.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

async function draw(node: React.ReactNode) {
  document.body.innerHTML = '<div id="r"></div>';
  const el = document.getElementById("r")!;
  root = createRoot(el);
  await act(async () => root!.render(node));
  return el;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe("снимок", () => {
  it("6810 · правка — новый снимок и один notify; без изменения — тот же и без notify; неизменённая ветвь — та же ссылка", () => {
    // чьё: код — web/packages/ui/src/store.ts
    const notify = vi.fn();
    const s = createStore({ a: { n: 1 }, b: { n: 2 } }, notify);
    const first = s.get();
    s.set((d) => void (d.a.n = 5));
    expect(notify).toHaveBeenCalledOnce();
    expect(s.get()).not.toBe(first);
    expect(s.get().a.n).toBe(5);
    expect(s.get().b).toBe(first.b);
    const second = s.get();
    s.set((d) => void (d.a.n = 5));
    expect(s.get()).toBe(second);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("6811 · запись мимо set — TypeError: снимок прежний, notify нет", () => {
    // факт: store.ts «снимок: менять нельзя»
    const notify = vi.fn();
    const s = createStore({ n: 1 }, notify);
    s.set((d) => void (d.n = 2));
    notify.mockClear();
    expect(() => {
      (s.get() as { n: number }).n = 9;
    }).toThrow(TypeError);
    expect(s.get().n).toBe(2);
    expect(notify).not.toHaveBeenCalled();
  });
});

type Reply<T> = { ok: true; result: T } | { ok: false; error: string };
/** Чтение с ручным ответом: тест решает, когда и что отвечает каждый вызов. */
function loader<T>() {
  const calls: Array<{ key: string; reply(r: Reply<T>): void }> = [];
  return { calls, load: (key: string) => new Promise<Reply<T>>((res) => calls.push({ key, reply: res })) };
}

function Loaded({ l, k, expose }: { l: ReturnType<typeof loader<string>>; k: string; expose(x: { reload(): void }): void }) {
  const r = useLoad(() => l.load(k), [k]);
  expose(r);
  return <output>{JSON.stringify({ data: r.data ?? null, error: r.error, loading: r.loading })}</output>;
}
const seen = (el: HTMLElement) => JSON.parse(el.querySelector("output")!.textContent!) as { data: string | null; error: string; loading: boolean };

describe("данные экрана", () => {
  const start = async () => {
    const l = loader<string>();
    let api!: { reload(): void };
    const el = await draw(<Loaded l={l} k="a" expose={(x) => (api = x)} />);
    const answer = (n: number, r: Reply<string>) => act(async () => l.calls[n].reply(r));
    const key = (k: string) => act(async () => root!.render(<Loaded l={l} k={k} expose={(x) => (api = x)} />));
    return { l, el, answer, key, reload: () => act(async () => api.reload()) };
  };

  it("6812 · читает при открытии, смене deps и reload; data прежняя, пока идёт чтение", async () => {
    // чьё: код — web/packages/ui/src/hooks.ts
    const t = await start();
    expect(seen(t.el)).toEqual({ data: null, error: "", loading: true });
    await t.answer(0, { ok: true, result: "A" });
    expect(seen(t.el)).toEqual({ data: "A", error: "", loading: false });
    await t.key("b");
    expect(t.l.calls.map((c) => c.key)).toEqual(["a", "b"]);
    expect(seen(t.el)).toEqual({ data: "A", error: "", loading: true });
    await t.answer(1, { ok: true, result: "B" });
    expect(seen(t.el).data).toBe("B");
    await t.reload();
    expect(t.l.calls.map((c) => c.key)).toEqual(["a", "b", "b"]);
    expect(seen(t.el)).toEqual({ data: "B", error: "", loading: true });
  });

  it("6813 · устаревший ответ отброшен: deps сменились, пока шёл запрос", async () => {
    // чьё: код
    const t = await start();
    await t.key("b");
    await t.answer(1, { ok: true, result: "B" });
    await t.answer(0, { ok: true, result: "A" });
    expect(seen(t.el).data).toBe("B");
  });

  it("6814 · отказ перечитывания: слово, данные те же; повтор: слово снято, данные новые", async () => {
    // источник: устав — отказ словом
    const t = await start();
    await t.answer(0, { ok: true, result: "A" });
    await t.reload();
    await t.answer(1, { ok: false, error: "offline" });
    expect(seen(t.el)).toEqual({ data: "A", error: "offline", loading: false });
    await t.reload();
    expect(seen(t.el)).toEqual({ data: "A", error: "offline", loading: true });
    await t.answer(2, { ok: true, result: "A2" });
    expect(seen(t.el)).toEqual({ data: "A2", error: "", loading: false });
  });

  it("6815 · отказ по новым deps: данных прежних deps нет — слот первой машины не уходит за вторую", async () => {
    // источник: слепой архитектор и план action-open-form, «другая машина отказала: чужого слота нет»; находка hooks.ts
    const t = await start();
    await t.answer(0, { ok: true, result: "A" });
    await t.key("b");
    await t.answer(1, { ok: false, error: "offline" });
    expect(seen(t.el)).toEqual({ data: null, error: "offline", loading: false });
  });
});

describe("часы", () => {
  it("6816 · useNow(0) стоит: таймера нет", async () => {
    // источник: устав — у операций лимит; шаг и снятие таймера — эталон 6235
    vi.useFakeTimers();
    let n = 0;
    const Clock = () => {
      n = useNow(0);
      return null;
    };
    await draw(<Clock />);
    const first = n;
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(n).toBe(first);
  });
});

describe("поле с фиксацией", () => {
  it("6817 · набрать и Esc, уйти с поля — фиксации нет", async () => {
    // факт: parts.tsx «только если изменилось»
    const commit = vi.fn();
    const Wrap = () => {
      const [v] = useState("x");
      return <CommitIn value={v} onCommit={commit} />;
    };
    const el = await draw(<Wrap />);
    const i = el.querySelector("input")!;
    await act(async () => {
      i.value = "y";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => i.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => i.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(commit).not.toHaveBeenCalled();
  });
});

const rosterOf = (ms: Array<[string, number]>) => ({ type: "roster", machines: ms.map(([machine, since]) => ({ machine, since, proto: 1, contract: {} })), sessions: [], clients: [] }) as never;

describe("ответы машин", () => {
  function setup(first: Array<[string, number]> = [["a", 1], ["b", 1]], machines?: () => string[]) {
    let r = rosterOf(first);
    const asked: string[] = [];
    const changed = vi.fn();
    const words: Record<string, string> = {};
    const m = machineAnswers<number>(
      { roster: () => r, changed },
      async (x) => {
        asked.push(x);
        return words[x] ? { ok: false, error: words[x] } : { ok: true, result: asked.length };
      },
      machines,
    );
    const set = (ms: Array<[string, number]>) => {
      r = rosterOf(ms);
      m.onRoster(r);
    };
    return { m, asked, changed, words, set };
  }
  const settle = () => act(async () => {});

  it("6820 · открытие: спрошена каждая машина; ответы лежат по машинам", async () => {
    // чьё: код — web/packages/ui/src/machines.ts
    const t = setup();
    t.m.mount();
    await settle();
    expect(t.asked).toEqual(["a", "b"]);
    expect(t.m.get()).toEqual({ a: 1, b: 2 });
  });

  it("6821 · roster без новых машин: сменились только сессии — лишнего запроса нет", async () => {
    // источник: гейт архитектора — лишняя коммуникация; факт: machines.ts «пришла или вернулась машина — доспросить её»
    const t = setup();
    t.set([["a", 1], ["b", 1]]);
    t.m.mount();
    await settle();
    t.set([["a", 1], ["b", 1]]);
    await settle();
    expect(t.asked).toEqual(["a", "b"]);
  });

  it("6822 · закрыт и открыт снова: все спрошены заново, прежние ответы видны до новых", async () => {
    // факт: machines.ts «открыт экран — спросить все машины»; прежние ответы — чьё: код
    const t = setup();
    const close = t.m.mount();
    await settle();
    close();
    expect(t.m.isOpen()).toBe(false);
    t.m.mount();
    expect(t.m.isOpen()).toBe(true);
    expect(t.m.get()).toEqual({ a: 1, b: 2 });
    await settle();
    expect(t.asked).toEqual(["a", "b", "a", "b"]);
    expect(t.m.get()).toEqual({ a: 3, b: 4 });
  });

  it("6823 · новый ответ будит экран один раз; ответ соседней машины — та же ссылка", async () => {
    // факт: machines.ts «неизменяемый снимок: его читает выборка app.use»
    const objects = machineAnswers<{ n: number }>({ roster: () => rosterOf([["a", 1], ["b", 1]]), changed: vi.fn() }, async (x) => ({ ok: true, result: { n: x.length } }));
    objects.mount();
    await settle();
    const before = objects.get();
    const b = before.b;
    const changed = vi.fn();
    const t = machineAnswers<{ n: number }>({ roster: () => rosterOf([["a", 1]]), changed }, async () => ({ ok: true, result: { n: 1 } }));
    await t.reload("a");
    expect(changed).toHaveBeenCalledOnce();
    await objects.reload("a");
    expect(objects.get().b).toBe(b);
    expect(objects.get()).not.toBe(before);
  });

  it("6824 · свой список: спрашиваются только его машины — при открытии и при возвращении", async () => {
    // факт: machines.ts «machines — кого спрашивать»
    const t = setup([["a", 1], ["b", 1]], () => ["a"]);
    t.set([["a", 1], ["b", 1]]);
    t.m.mount();
    await settle();
    expect(t.asked).toEqual(["a"]);
    t.set([["a", 1], ["b", 2]]);
    await settle();
    expect(t.asked).toEqual(["a"]);
    t.set([["a", 2], ["b", 2]]);
    await settle();
    expect(t.asked).toEqual(["a", "a"]);
  });

  it("6825 · связь клиента вернулась: машина с отказом disconnected спрошена заново, остальные — нет", async () => {
    // источник: устав — соединение с объектом relay оборвалось: клиенты переподключаются; находка плана: отказ держался до нового открытия
    const t = setup();
    t.set([["a", 1], ["b", 1]]);
    t.words.a = "disconnected";
    t.m.mount();
    await settle();
    expect(t.m.get().a).toEqual({ error: "disconnected" });
    delete t.words.a;
    t.set([["a", 1], ["b", 1]]);
    await settle();
    expect(t.asked).toEqual(["a", "b", "a"]);
    expect(t.m.get().a).toBe(3);
  });

  it("6826 · экран закрыт: roster без запросов; другое слово отказа не спрашивается заново", async () => {
    // источник: гейт архитектора — опрос без нужды; устав — отказ словом, система не повторяет сама
    const t = setup([["a", 1]]);
    t.set([["a", 1]]);
    t.words.a = "offline";
    const close = t.m.mount();
    await settle();
    t.set([["a", 1]]);
    await settle();
    expect(t.asked).toEqual(["a"]);
    t.words.a = "disconnected";
    await t.m.reload("a");
    close();
    t.set([["a", 1]]);
    await settle();
    expect(t.asked).toEqual(["a", "a"]);
  });
});

describe("подписи", () => {
  it("6830 · словарь: слово, тон и лампа каждого состояния; undefined — «—»", () => {
    // факт: одно правило на все экраны — гейт архитектора, дубликат логики; слова — карточка сессии
    expect(["busy", "waiting", "idle", "starting", "stopping", "stopped", "failed"].map((s) => stateLabel(s).dot)).toEqual(["busy", "wait", "idle", "busy", "stop", "stop", "bad"]);
    expect(["busy", "waiting", "idle", "failed"].map((s) => stateLabel(s).tone)).toEqual(["busy", "wait", "ok", "bad"]);
    expect(stateLabel(undefined)).toEqual({ text: "—", tone: "", dot: "" });
  });

  it("6831 · живая сессия: idle, busy, waiting; остальные и undefined — нет", () => {
    // чьё: код
    expect(["idle", "busy", "waiting"].every(isLive)).toBe(true);
    expect(["starting", "stopping", "stopped", "failed", undefined].some(isLive)).toBe(false);
  });

  it("6832 · несколько причин сбоя и лампа сбоя и незнакомого состояния", () => {
    // факт: host/core/contract.ts «failed: { модуль: причина }»
    expect(failText({ failed: { start: "причина" } } as never)).toBe("start: причина");
    expect(failText({ failed: { core: "а", chat: "б" } } as never)).toBe("core: а; chat: б");
    expect(lamp({ state: "failed" } as never)).toBe("bad");
  });

  it("6833 · время, длительность и склонение", () => {
    // чьё: код
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 3, 12, 0, 0));
    const t = new Date(2026, 10, 3, 11, 55).getTime();
    expect(at(t)).toBe("11:55");
    expect(at(t / 1000)).toBe("11:55");
    expect(ago(Date.now() - 10_000)).toBe("только что");
    expect(ago(t)).toBe("5 мин назад");
    expect(ago(Date.now() - 125 * 60000)).toBe("2 ч 5 мин назад");
    expect(ago(new Date(2026, 10, 1, 12).getTime())).toMatch(/^1 нояб/);
    expect([18_000, 33 * 60000, 134_000].map(duration)).toEqual(["18 с", "33 мин", "2 мин 14 с"]);
    expect([1, 4, 11, 21].map((n) => plural(n, "сессия", "сессии", "сессий"))).toEqual(["сессия", "сессии", "сессий", "сессия"]);
  });

  it("6834 · папка сессии: последнее имя в нижнем регистре; «~» и пусто — «~»", () => {
    // чьё: код
    expect(folderOf("C:\\Work\\PFarm\\")).toBe("pfarm");
    expect(folderOf("~/projects/Switchboard")).toBe("switchboard");
    expect(folderOf("~")).toBe("~");
    expect(folderOf("")).toBe("~");
  });
});
