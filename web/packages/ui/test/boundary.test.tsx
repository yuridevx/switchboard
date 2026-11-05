// Леса границы «основа страницы», набор: компоненты, форматы, данные экрана, ответы машин, настройки, текст ответа.
// Вход — только контракт web-ui, исход — разметка и значения. Номер — эталон-источник; без номера — чьё: код.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ui from "../contract.ts";
import { ago, at, Check, CommitIn, createStore, DisclosureBtn, duration, failText, folderOf, IconBtn, isLive, lamp, LimitRow, linkText, machineAnswers, machineLabel, machinesWith, plural, remoteOf, RowBtn, sessionLabel, stateLabel, Switch, TextBtn, useLoad, useNow } from "../contract.ts";

describe("состояние и подписи", () => {

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

    it("7230 · первый рисунок с новыми deps: уже loading и stale, данных прежних deps как готовых нет", async () => {
      // чьё: код — слепой архитектор, 4 нояб.: «дальше» в журнале карточки на один кадр показывал страницу дважды; источник свойства — web/packages/card/src/LogTab.tsx
      const l = loader<string>();
      const renders: Array<{ k: string; loading: boolean; stale: boolean }> = [];
      function Seen({ k }: { k: string }) {
        const r = useLoad(() => l.load(k), [k]);
        renders.push({ k, loading: r.loading, stale: r.stale });
        return null;
      }
      await draw(<Seen k="a" />);
      await act(async () => l.calls[0].reply({ ok: true, result: "A" }));
      expect(renders.at(-1)).toEqual({ k: "a", loading: false, stale: false });
      renders.length = 0;
      await act(async () => root!.render(<Seen k="b" />));
      expect(renders[0]).toEqual({ k: "b", loading: true, stale: true });
    });

    it("7231 · again перечитывает, как reload: отказ держит данные", async () => {
      // чьё: код — web/packages/ui/src/hooks.ts: машина вернулась, ответ не снимает прежний
      const l = loader<string>();
      let seenData: string | undefined;
      function Seen({ again }: { again: number }) {
        seenData = useLoad(() => l.load("a"), ["a"], again).data;
        return null;
      }
      await draw(<Seen again={1} />);
      await act(async () => l.calls[0].reply({ ok: true, result: "A" }));
      await act(async () => root!.render(<Seen again={2} />));
      expect(l.calls).toHaveLength(2);
      await act(async () => l.calls[1].reply({ ok: false, error: "disconnected" }));
      expect(seenData).toBe("A");
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
      // сравнение since — у ядра (link.ts): здесь то же, что оно сообщает
      const known: Record<string, number> = Object.fromEntries(first);
      const set = (ms: Array<[string, number]>) => {
        r = rosterOf(ms);
        for (const [x, since] of ms) {
          if (known[x] === since) continue;
          known[x] = since;
          m.onLink("open", x);
        }
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
      t.m.onLink("open");
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
});

describe("помощники набора", () => {

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

  const rosterOf = (ms: Array<[string, number]>) => ({ type: "roster", machines: ms.map(([machine, since]) => ({ machine, since, proto: 1, contract: {} })), sessions: [], clients: [] }) as never;

  describe("ответы машин", () => {
    function setup() {
      let r = rosterOf([["a", 1]]);
      const asked: string[] = [];
      const changed = vi.fn();
      const m = machineAnswers<number>({ roster: () => r, changed }, async (x) => {
        asked.push(x);
        return x === "bad" ? { ok: false, error: "offline" } : { ok: true, result: asked.length };
      });
      return { m, asked, changed, setRoster: (x: never) => (r = x) };
    }

    it("6230 · открыт экран — спросить все машины; закрыт — машина в roster не спрашивается", async () => {
      const { m, asked, setRoster } = setup();
      const close = m.mount();
      await act(async () => {});
      expect(asked).toEqual(["a"]);
      expect(m.get().a).toBe(1);
      close();
      setRoster(rosterOf([["a", 1], ["b", 1]]) as never);
      m.onLink("open", "b");
      await act(async () => {});
      expect(asked).toEqual(["a"]);
    });

    it("6800 · второй экран рядом ответы не спрашивает заново: один запрос на машину; закрылись оба — снова спросит", async () => {
      const { m, asked } = setup();
      const a = m.mount();
      const b = m.mount();
      await act(async () => {});
      expect(asked).toEqual(["a"]);
      expect(m.isOpen()).toBe(true);
      a();
      b();
      expect(m.isOpen()).toBe(false);
      m.mount();
      await act(async () => {});
      expect(asked).toEqual(["a", "a"]);
    });

    it("6801 · put кладёт известный ответ без запроса; reload с how спрашивает другим запросом", async () => {
      const { m, asked } = setup();
      m.put("a", 7);
      expect(m.get().a).toBe(7);
      expect(asked).toEqual([]);
      await act(async () => m.reload("a", async () => ({ ok: true, result: 9 })));
      expect(m.get().a).toBe(9);
      expect(asked).toEqual([]);
    });

    it("6231 · при открытом экране: пришла новая и вернулась прежняя — спрошены; та же — нет; отказ — словом", async () => {
      const { m, asked, setRoster } = setup();
      m.mount();
      await act(async () => {});
      const r1 = rosterOf([["a", 1], ["bad", 1]]);
      setRoster(r1 as never);
      m.onLink("open", "bad");
      await act(async () => {});
      expect(asked).toEqual(["a", "bad"]);
      expect(m.get().bad).toEqual({ error: "offline" });
      const r2 = rosterOf([["a", 2], ["bad", 1]]);
      setRoster(r2 as never);
      m.onLink("open", "a");
      await act(async () => {});
      expect(asked).toEqual(["a", "bad", "a"]);
    });

    // источник: факт — обрывы раз в 4,8 мин стирали экран машины; перенесено из общих тестов пульта
    function hand(machines = ["a"]) {
      const answers: Array<(r: ui.Result<{ n: number }>) => void> = [];
      const m = machineAnswers<{ n: number }>({ roster: () => rosterOf([["a", 1]]) as never, changed: () => {} }, () => new Promise((ok) => answers.push(ok)), () => machines);
      return { m, answers };
    }

    it("E32 · отказ чтения: прежний ответ рядом со словом", async () => {
      const { m, answers } = hand();
      const first = m.reload("a");
      answers[0]({ ok: true, result: { n: 1 } });
      await first;
      const second = m.reload("a");
      answers[1]({ ok: false, error: "timeout" });
      await second;
      expect(ui.wordOf(m.get().a)).toBe("timeout");
      expect(ui.okOf(m.get().a)).toEqual({ n: 1 });
    });

    it("E32 · вопрос, ушедший раньше, отказал позже свежего ответа — свежий не затёрт", async () => {
      const { m, answers } = hand();
      const old = m.reload("a");
      const fresh = m.reload("a");
      answers[1]({ ok: true, result: { n: 2 } });
      await fresh;
      answers[0]({ ok: false, error: "timeout" });
      await old;
      expect(m.get().a).toEqual({ n: 2 });
    });

    it("E32 · связь вернулась: машину с timeout спросить снова; ответившую — нет", async () => {
      const { m, answers } = hand(["a", "b"]);
      const stop = m.mount();
      answers[0]({ ok: false, error: "timeout" });
      answers[1]({ ok: true, result: { n: 1 } });
      await act(async () => {});
      m.onLink("open");
      expect(answers).toHaveLength(3);
      stop();
    });
  });

  describe("поле с фиксацией", () => {
    const type = async (i: HTMLInputElement, v: string) => {
      await act(async () => {
        i.value = v;
        i.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    it("6233 · Enter и следующий уход с поля — одна фиксация; без изменений — ни одной", async () => {
      const commit = vi.fn();
      const el = await draw(<CommitIn value="x" onCommit={commit} />);
      const i = el.querySelector("input")!;
      await act(async () => i.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      expect(commit).not.toHaveBeenCalled();
      await type(i, "y");
      await act(async () => i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      await act(async () => i.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      expect(commit.mock.calls).toEqual([["y"]]);
    });

    it("6234 · Esc возвращает прежнее без фиксации; новое значение снаружи заменяет текст", async () => {
      const commit = vi.fn();
      const cancel = vi.fn();
      const el = await draw(<CommitIn value="x" onCommit={commit} onCancel={cancel} />);
      const i = el.querySelector("input")!;
      await type(i, "y");
      await act(async () => i.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(i.value).toBe("x");
      expect(cancel).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      await act(async () => root!.render(<CommitIn value="z" onCommit={commit} />));
      expect(i.value).toBe("z");
      await act(async () => i.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      expect(commit).not.toHaveBeenCalled();
    });
  });

  describe("таймер и подписи", () => {
    it("6235 · useNow идёт шагами и снимает таймер с экрана", async () => {
      vi.useFakeTimers();
      let seen = 0;
      const Clock = () => {
        seen = useNow(1000);
        return null;
      };
      await draw(<Clock />);
      const first = seen;
      await act(async () => vi.advanceTimersByTime(1000));
      expect(seen).toBeGreaterThan(first);
      await act(async () => root!.unmount());
      root = null;
      expect(vi.getTimerCount()).toBe(0);
    });

    it("6236 · один словарь состояний: слова карточки; сбой — лампа bad; неизвестное — как есть, лампа остановленной", () => {
      expect(stateLabel("failed")).toEqual({ text: "не запустилась", tone: "bad", dot: "bad" });
      expect(stateLabel("idle").text).toBe("свободна");
      expect(stateLabel("waiting").text).toBe("ждёт вас");
      expect(stateLabel("x")).toEqual({ text: "x", tone: "", dot: "" });
      expect(lamp({ state: "failed" } as never)).toBe("bad");
      expect(lamp({ state: "x" } as never)).toBe("stop");
    });

    it("6237 · причина сбоя — «часть: причина»; ссылка remote — строкой и объектом", () => {
      expect(failText({ failed: { host: "a", start: "b" } } as never)).toBe("host: a; start: b");
      expect(failText({} as never)).toBe("");
      expect(remoteOf({ remote: "u" } as never)).toBe("u");
      expect(remoteOf({ remote: { url: "v" } } as never)).toBe("v");
    });

    it("7236 · слова связи: offline — один текст, с машиной и без; слова владельца — как есть", () => {
      // чьё: код — слепой архитектор, 4 нояб.: offline переводился в чате и точках по-разному
      expect(linkText("offline", "pc")).toBe("pc не на связи");
      expect(linkText("offline")).toBe("Машина не на связи");
      expect(linkText("disconnected")).toBe("нет связи");
      expect(linkText("timeout")).toBe("нет ответа");
      expect(linkText("name_taken")).toBe("name_taken");
    });

    it("6238 · имена: метка или адрес; машины с запросами: все названные в contract", () => {
      const app = {
        mark: (n: string, x: string) => (n === "label.session" && x === "a@b" ? { text: "Имя", human: true } : undefined),
        roster: () => ({ machines: [{ machine: "m1", contract: { p: 1, q: 1 } }, { machine: "m2", contract: { p: 1 } }] }) as never,
      };
      expect(sessionLabel(app, "a@b")).toEqual({ text: "Имя", human: true });
      expect(sessionLabel(app, "c@d")).toEqual({ text: "c", human: false });
      expect(machineLabel(app, "m1")).toEqual({ text: "@m1", human: false });
      expect(machinesWith(app, "p")).toEqual(["m1", "m2"]);
      expect(machinesWith(app, "p", "q")).toEqual(["m1"]);
    });

    it("6239 · строка лимита: пороги 70 и 90 — один цвет на все экраны", async () => {
      const el = await draw(
        <>
          <LimitRow data-p="a" label="5 ч" used={0.69} />
          <LimitRow data-p="b" label="5 ч" used={0.7} />
          <LimitRow data-p="c" label="5 ч" used={0.9} resets={1_800_000_000} />
        </>,
      );
      const cls = (k: string) => el.querySelector(`[data-p="${k}"] .sb-barw`)!.className;
      expect(cls("a")).toBe("sb-barw");
      expect(cls("b")).toContain("warn");
      expect(cls("c")).toContain("bad");
      expect(el.querySelector('[data-p="c"] em')!.textContent).toMatch(/^90 % · до \d\d:\d\d$/);
    });

    it("7322 · кнопки набора в форме её не отправляют, отправка — только явным type; раскрытие, переключатель и флажок говорят состояние", async () => {
      // источник: факт 4 нояб. — голая <button> в форме отправляет её; кнопки набора заменили голые
      const send = vi.fn((e: Event) => e.preventDefault());
      const el = await draw(
        <form onSubmit={(e) => send(e.nativeEvent)}>
          <RowBtn data-k="r" />
          <IconBtn data-k="i" aria-label="значок" />
          <DisclosureBtn data-k="d" open />
          <TextBtn data-k="t" />
          <Switch data-k="s" on={false} />
          <Check data-k="c" readOnly checked />
          <IconBtn data-k="go" aria-label="отправить" type="submit" />
        </form>,
      );
      const at = (k: string) => el.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!;
      for (const k of ["r", "i", "d", "t", "s"]) await act(async () => at(k).click());
      expect(send).not.toHaveBeenCalled();
      expect(at("d").getAttribute("aria-expanded")).toBe("true");
      expect(at("s").getAttribute("role")).toBe("switch");
      expect(at("s").getAttribute("aria-checked")).toBe("false");
      expect(at("c").type).toBe("checkbox");
      await act(async () => at("go").click());
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});

describe("набор сверх старых тестов (чьё: код)", () => {
  let root: Root | null = null;
  async function draw(node: React.ReactNode) {
    await act(async () => root?.unmount());
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
    vi.unstubAllGlobals();
  });
  const firstEl = (el: Element) => el.firstElementChild as HTMLElement;

  describe("компоненты: один компонент — один класс основания", () => {
    it.each([
      ["Btn", <ui.Btn className="x" data-p="1" />, "BUTTON", "sb-b x"],
      ["Btn pri bad dash ghost", <ui.Btn pri bad dash ghost />, "BUTTON", "sb-b pri bad dash ghost"],
      ["RowBtn", <ui.RowBtn className="x" />, "BUTTON", "sb-rw x"],
      ["IconBtn", <ui.IconBtn aria-label="з" className="x" />, "BUTTON", "sb-ic x"],
      ["DisclosureBtn", <ui.DisclosureBtn open={false} className="x" />, "BUTTON", "sb-ds x"],
      ["TextBtn", <ui.TextBtn className="x" />, "BUTTON", "sb-tx x"],
      ["Chips", <ui.Chips className="x" />, "DIV", "sb-chips x"],
      ["Chips quiet", <ui.Chips quiet />, "DIV", "sb-chips quiet"],
      ["Chip", <ui.Chip on className="x" />, "BUTTON", "sb-chip x"],
      ["LinkBtn", <ui.LinkBtn pri ghost className="x" />, "A", "sb-b pri ghost x"],
      ["Cta", <ui.Cta className="x" />, "BUTTON", "sb-cta x"],
      ["In", <ui.In className="x" />, "INPUT", "sb-in x"],
      ["In mono", <ui.In mono />, "INPUT", "sb-in m"],
      ["Area", <ui.Area className="x" />, "TEXTAREA", "sb-in x"],
      ["Sel", <ui.Sel className="x" />, "SELECT", "sb-in x"],
      ["Note", <ui.Note tone="bad" className="x" />, "DIV", "sb-note bad x"],
      ["Hint", <ui.Hint tone="wait" className="x" />, "SPAN", "sb-note wait x"],
      ["Cmd", <ui.Cmd className="x" />, "CODE", "sb-cmd x"],
      ["Pill", <ui.Pill tone="ok" conn className="x" />, "SPAN", "sb-pill ok conn x"],
      ["Dot", <ui.Dot kind="busy" className="x" />, "SPAN", "sb-dot busy x"],
      ["Badge", <ui.Badge wait className="x" />, "SPAN", "sb-badge wait x"],
      ["Page", <ui.Page className="x" />, "DIV", "sb-page x"],
      ["Pad", <ui.Pad className="x" />, "DIV", "sb-pad x"],
      ["PageHead", <ui.PageHead className="x" />, "DIV", "sb-ph x"],
      ["Sec", <ui.Sec dlg tone="ok" className="x" />, "SECTION", "sb-sec dlg ok x"],
      ["H4", <ui.H4 className="x" />, "H4", "sb-h4 x"],
      ["Row", <ui.Row label="п" className="x" />, "DIV", "sb-row x"],
      ["Opts", <ui.Opts className="x" />, "DIV", "sb-opts x"],
      ["OptsLabel", <ui.OptsLabel className="x" />, "LABEL", "sb-opts x"],
      ["OptsInline", <ui.OptsInline className="x" />, "SPAN", "sb-opts x"],
      ["M", <ui.M className="x" />, "SPAN", "sb-m x"],
      ["Meter", <ui.Meter value={5} warn className="x" />, "SPAN", "sb-barw warn x"],
      ["Meter bad", <ui.Meter value={5} bad />, "SPAN", "sb-barw bad"],
      ["OkCard", <ui.OkCard className="x" />, "DIV", "sb-okc x"],
      ["WaitCard", <ui.WaitCard className="x" />, "DIV", "sb-waitc x"],
      ["BadCard", <ui.BadCard className="x" />, "DIV", "sb-badc x"],
    ] as const)("%s", async (_n, node, tag, cls) => {
      const el = firstEl(await draw(node));
      expect(el.tagName).toBe(tag);
      expect(el.className).toBe(cls);
    });

    it("лишние свойства идут на элемент; ref — на него же", async () => {
      let got: HTMLElement | null = null;
      const el = firstEl(await draw(<ui.RowBtn data-k="1" aria-current="page" ref={(x) => void (got = x)} />));
      expect(el.getAttribute("data-k")).toBe("1");
      expect(el.getAttribute("aria-current")).toBe("page");
      expect(got).toBe(el);
    });

    it("состояния: чип, вкладки, заголовок страницы, строка, полоса, группа выбора", async () => {
      const pick = vi.fn();
      const el = await draw(
        <>
          <ui.Chip on data-k="on" />
          <ui.Chip on={false} data-k="off" />
          <ui.Tabs tabs={[["a", "Первая"], ["b", "Вторая"]]} cur="a" pick={pick} data-k="tabs" />
          <ui.PageHead title="Заголовок" data-k="ph">
            <i>справа</i>
          </ui.PageHead>
          <ui.Row label="Подпись" data-k="row">
            значение
          </ui.Row>
          <ui.Meter value={42} data-k="meter" />
          <ui.Choices title="Группа">
            <i>выбор</i>
          </ui.Choices>
        </>,
      );
      const at = (k: string) => el.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
      expect(at("on").getAttribute("aria-pressed")).toBe("true");
      expect(at("off").getAttribute("aria-pressed")).toBe("false");
      expect(at("tabs").getAttribute("role")).toBe("tablist");
      const tabs = [...at("tabs").querySelectorAll<HTMLElement>('[role="tab"]')];
      expect(tabs.map((t) => [t.textContent, t.getAttribute("aria-selected"), t.dataset.tab])).toEqual([["Первая", "true", "a"], ["Вторая", "false", "b"]]);
      await act(async () => tabs[1].click());
      expect(pick).toHaveBeenCalledWith("b");
      expect(at("ph").querySelector("h2")!.textContent).toBe("Заголовок");
      expect(at("ph").textContent).toBe("Заголовокsправа".replace("s", "с"));
      expect(at("row").querySelector("span")!.textContent).toBe("Подпись");
      expect(at("row").textContent).toBe("Подписьзначение");
      expect(at("meter").querySelector("i")!.getAttribute("style")).toContain("width: 42%");
      expect(el.querySelector(".vw-g .vw-t")!.textContent).toBe("Группа");
      expect(el.querySelector(".vw-g .sb-chips.quiet i")!.textContent).toBe("выбор");
    });

    it("PageHead без заголовка — без h2; итог действия: нет текста — нет строки; отказ — alert, иначе status", async () => {
      const a = await draw(<ui.PageHead />);
      expect(a.querySelector("h2")).toBeNull();
      const b = await draw(
        <>
          <ui.Outcome note={null} />
          <ui.Outcome note={{ text: "" }} />
          <ui.Outcome data-k="bad" note={{ text: "упало", tone: "bad" }} />
          <ui.Outcome data-k="ok" note={{ text: "готово", tone: "ok" }} />
          <ui.Outcome data-k="plain" note={{ text: "так" }} />
        </>,
      );
      expect(b.querySelectorAll(".sb-note")).toHaveLength(3);
      expect(b.querySelector('[data-k="bad"]')!.getAttribute("role")).toBe("alert");
      expect(b.querySelector('[data-k="bad"]')!.className).toBe("sb-note bad");
      expect(b.querySelector('[data-k="ok"]')!.getAttribute("role")).toBe("status");
      expect(b.querySelector('[data-k="plain"]')!.className).toBe("sb-note");
    });

    it("выбор слота: два слота — строка и чипы; ждущий — со сбросом; один ждущий — подпись; один свободный — ничего", async () => {
      const on = vi.fn();
      const reset = new Date(2026, 10, 3, 14, 5).getTime();
      const two = await draw(<ui.SlotPick slots={{ main: { wait: null }, bot: { wait: reset } }} value="main" on={on} />);
      expect(two.querySelector("[data-slot-pick] > span")!.textContent).toBe("Слот");
      const chips = [...two.querySelectorAll<HTMLElement>("[data-slot]")];
      expect(chips.map((c) => c.textContent)).toEqual(["main", "bot · ждёт сброса 14:05"]);
      expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
      await act(async () => chips[1].click());
      expect(on).toHaveBeenCalledWith("bot");
      const other = await draw(<ui.SlotPick slots={{ a: { wait: null }, b: { wait: null } }} value="a" on={on} label="Аккаунт" />);
      expect(other.querySelector("[data-slot-pick] > span")!.textContent).toBe("Аккаунт");
      const wait = await draw(<ui.SlotPick slots={{ main: { wait: reset } }} value="" on={on} />);
      expect(wait.querySelector("[data-slot-wait]")!.textContent).toBe("Слот main · ждёт сброса 14:05");
      expect(wait.querySelector("[data-slot-wait]")!.className).toBe("sb-note wait");
      expect((await draw(<ui.SlotPick slots={{ main: { wait: null } }} value="" on={on} />)).innerHTML).toBe("");
    });

    it("выбор одного из многих: выбранный и ближние — кнопками, остальные — списком «ещё N…»; выбор зовёт on", async () => {
      const on = vi.fn();
      const el = await draw(<ui.PickOne all={["a", "b", "c", "d"]} near={["b"]} cur="a" on={on} select={{ "data-f": "m" }} button={(v) => ({ "data-v": v })} />);
      const buttons = [...el.querySelectorAll<HTMLElement>("button")];
      expect(buttons.map((b) => [b.textContent, b.getAttribute("aria-pressed"), b.dataset.v])).toEqual([["a", "true", "a"], ["b", "false", "b"]]);
      await act(async () => buttons[1].click());
      expect(on).toHaveBeenLastCalledWith("b");
      const sel = el.querySelector<HTMLSelectElement>('select[data-f="m"]')!;
      expect([...sel.options].map((o) => o.textContent)).toEqual(["ещё 2…", "c", "d"]);
      expect((await draw(<ui.PickOne all={["a"]} near={[]} cur="a" on={on} />)).querySelector("select")).toBeNull();
    });
  });

  describe("подписи и форматы", () => {
    it("состояния: все слова", () => {
      expect(["busy", "waiting", "idle", "starting", "stopping", "stopped", "failed"].map((s) => ui.stateLabel(s).text)).toEqual(["работает", "ждёт вас", "свободна", "запускается", "останавливается", "остановлена", "не запустилась"]);
      expect([...ui.LIVE]).toEqual(["idle", "busy", "waiting"]);
    });

    it("модели, усилия и профиль", () => {
      expect(ui.MODELS).toEqual(["opus", "sonnet", "haiku", "fable"]);
      expect(ui.EFFORTS.map(([, n]) => n)).toEqual(["низкое", "среднее", "высокое", "очень высокое", "макс."]);
      expect(ui.effortName("xhigh")).toBe("очень высокое");
      expect(ui.effortName("x")).toBe("x");
      expect(ui.effortName(undefined)).toBe("");
      expect(ui.profileName("team/profiles/ops")).toBe("ops");
      expect(ui.profileIdOf({ profile: { id: "team/ops" } } as never)).toBe("team/ops");
      expect(ui.profileIdOf(undefined)).toBeUndefined();
      expect(ui.profileNameOf({ profile: { id: "team/ops" } } as never)).toBe("ops");
      expect(ui.profileNameOf({} as never)).toBeUndefined();
    });

    it("запись сессии: сессия, слот, инцидент, строка, имя без подписи; адрес из пропуска", () => {
      const s = { callsign: "a@b", model: "opus", effort: "high", slot: { name: "main", wait: null }, incident: { type: "t", key: "k" } } as never;
      const app = { roster: () => ({ sessions: [s] }) as never, address: () => "phone~me@x.io" };
      expect(ui.sessionOf(app, "a@b")).toBe(s);
      expect(ui.sessionOf(app, "z@b")).toBeUndefined();
      expect(ui.slotOf(s)).toEqual({ name: "main", wait: null });
      expect(ui.incidentOf(s)).toEqual({ type: "t", key: "k" });
      expect(ui.sessionLine(s)).toBe("opus · main");
      expect(ui.sessionLine(s, true)).toBe("opus · высокое · main");
      expect(ui.sessionLine(undefined)).toBe("");
      expect(ui.plainSession("a@b")).toEqual({ text: "a", human: false });
      expect(ui.plainMachine("b")).toEqual({ text: "@b", human: false });
      expect(ui.myAddress(app)).toBe("~me@x.io");
      expect(ui.myAddress({ address: () => null })).toBeNull();
      expect(ui.remoteOf({} as never)).toBeUndefined();
      expect(ui.machinesWith({ roster: () => null })).toEqual([]);
    });

    it("время: ЧЧ:ММ, день, полночь, длительность часами", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 3, 12, 0, 0));
      expect(ui.hhmm()).toBe("12:00");
      expect(ui.hhmm(new Date(2026, 10, 3, 9, 5))).toBe("09:05");
      expect(ui.day(new Date(2026, 10, 3).getTime())).toMatch(/^3 нояб/);
      expect(ui.midnight()).toBe(new Date(2026, 10, 3).toISOString());
      expect(ui.midnight(2)).toBe(new Date(2026, 10, 1).toISOString());
      expect([90 * 60000, 120 * 60000, 2 * 60000].map(ui.duration)).toEqual(["1 ч 30 мин", "2 ч", "2 мин"]);
    });

    it("выбор слота без компонента: выбранный есть — он, нет — первый; меньше двух — пусто; ждущий один — подпись", () => {
      expect(ui.slotChoice(["a", "b"], "b")).toBe("b");
      expect(ui.slotChoice(["a", "b"], "z")).toBe("a");
      expect(ui.slotChoice(["a", "b"])).toBe("a");
      expect(ui.slotChoice(["a"], "a")).toBe("");
      expect(ui.slotWait(null)).toBe("");
      expect(ui.slotWait({ a: { wait: null } })).toBe("");
      expect(ui.slotWait({ a: { wait: 1 }, b: { wait: 1 } })).toBe("");
      expect(ui.slotWait({ a: { wait: new Date(2026, 10, 3, 14, 5).getTime() } })).toBe("a · ждёт сброса 14:05");
    });

    it("лимиты: подписи окон, пороги; строка без срока", async () => {
      expect(ui.LIMIT_NAMES).toEqual({ five_hour: "5 ч", seven_day: "неделя", seven_day_opus: "неделя opus", seven_day_sonnet: "неделя sonnet" });
      expect([ui.LIMIT_WARN, ui.LIMIT_BAD]).toEqual([70, 90]);
      const el = await draw(<ui.LimitRow data-p="x" label="5 ч" used={1.5} />);
      expect(el.querySelector('[data-p="x"] > span')!.textContent).toBe("5 ч");
      expect(el.querySelector("em")!.textContent).toBe("150 %");
      expect(el.querySelector(".sb-barw i")!.getAttribute("style")).toContain("width: 100%");
    });

    it("смена аккаунта: прошлый известен — сменился; первый раз — не смена; без аккаунта — мимо", () => {
      const known: Record<string, string> = { a: "x" };
      const sessions = [{ callsign: "a", account: "y" }, { callsign: "b", account: "z" }, { callsign: "c" }];
      expect(ui.accountChanged(known, sessions)).toEqual(["a"]);
      expect(known).toEqual({ a: "y", b: "z" });
      expect(ui.accountChanged(known, sessions)).toEqual([]);
      expect(ui.accountChanges({ sessions: [{ callsign: "a", account: "y" }, { callsign: null, account: "z" }] }, () => "old")).toEqual([{ callsign: "a", from: "old", account: "y" }]);
    });

    it("разрешения: режимы и места", () => {
      expect(ui.PERM_MODES.map(([, n]) => n)).toEqual(["Без вопросов", "Спрашивать", "Правки сами", "План", "Авто"]);
      expect(ui.permModeName("plan")).toBe("План");
      expect(ui.permModeName("x")).toBeUndefined();
      expect(ui.PERM_PLACES).toEqual({ localSettings: "локально", projectSettings: "проект", userSettings: "пользователь", policySettings: "организация", flagSettings: "запуск", cliArg: "запуск", command: "команда", session: "сессия" });
    });
  });

  describe("хуки экрана", () => {
    const fakeApp = (over: Partial<ui.App> = {}) =>
      ({
        use: <T,>(s: (p?: T) => T) => s(),
        link: () => "open",
        can: () => true,
        roster: () => ({ machines: [{ machine: "m", since: 1 }] }),
        read: vi.fn(async () => ({ ok: true, result: "ответ" })),
        state: { n: 1 },
        ...over,
      }) as never as ui.App;

    it("useModule: поле state модуля; useOutcome: строка по ключу, ключи независимы", async () => {
      let state: unknown;
      let say!: (k: string, t: string, tone?: "ok" | "bad") => void;
      let notes: Record<string, unknown> = {};
      const V = () => {
        state = ui.useModule();
        [notes, say] = ui.useOutcome();
        return null;
      };
      await draw(
        <ui.AppCtx.Provider value={fakeApp()}>
          <V />
        </ui.AppCtx.Provider>,
      );
      expect(state).toEqual({ n: 1 });
      await act(async () => say("a", "готово", "ok"));
      await act(async () => say("b", "упало", "bad"));
      expect(notes).toEqual({ a: { text: "готово", tone: "ok" }, b: { text: "упало", tone: "bad" } });
    });

    it("useMachineLoad: нельзя спросить — запроса нет и слова нет; можно — читает; вернулась связь — перечитывает", async () => {
      let r: { data?: unknown; error: string } = { error: "" };
      const V = ({ when }: { when: boolean }) => {
        r = ui.useMachineLoad("m", "x", { machine: "m" }, when);
        return null;
      };
      const read = vi.fn(async () => ({ ok: true as const, result: "ответ" }));
      const tree = (app: ui.App, when: boolean) => (
        <ui.AppCtx.Provider value={app}>
          <V when={when} />
        </ui.AppCtx.Provider>
      );
      await draw(tree(fakeApp({ read: read as never }), false));
      expect(read).not.toHaveBeenCalled();
      expect(r.error).toBe("");
      await act(async () => root!.render(tree(fakeApp({ read: read as never }), true)));
      expect(read).toHaveBeenCalledWith("x", { machine: "m" });
      expect(r.data).toBe("ответ");
      await act(async () => root!.render(tree(fakeApp({ read: read as never, roster: () => ({ machines: [{ machine: "m", since: 2 }] }) as never }), true)));
      expect(read).toHaveBeenCalledTimes(2);
    });
  });

  describe("настройки модуля", () => {
    const fake = () => {
      const asked: Array<[string, Record<string, unknown>]> = [];
      const toast = vi.fn();
      const answer = { set: { ok: true, result: undefined } as ui.Result, get: { ok: true, result: { values: { "x.a": 5 } } } as ui.Result };
      const go = (name: string, body?: Record<string, unknown>) => {
        asked.push([name, body ?? {}]);
        return Promise.resolve(name === "prefs.get" ? answer.get : answer.set) as never;
      };
      return { asked, toast, answer, app: { application: "pult", read: go, request: go, toast } };
    };

    it("чтение при открытой связи: ключи с префиксом; возврат одной машины настройки не трогает; закрытая связь — нет", async () => {
      const t = fake();
      const changed = vi.fn();
      const p = ui.personal(t.app, "x", changed);
      expect(p.ready()).toBe(false);
      expect(p.onLink("closed")).toBeUndefined();
      expect(p.onLink("open", "pc")).toBeUndefined();
      await p.onLink("open");
      expect(t.asked[0][0]).toBe("prefs.get");
      expect(p.ready()).toBe(true);
      expect(p.get("a")).toBe(5);
      expect(changed).toHaveBeenCalled();
    });

    it("правка на экране сразу, в prefs циклом; отказ записи — словом в тосте; остановка ждёт цикл", async () => {
      const t = fake();
      const p = ui.personal(t.app, "x", () => {});
      await p.onLink("open");
      t.answer.set = { ok: false, error: "too_large" };
      p.edit<number>("a", (n = 0) => n + 1);
      expect(p.get("a")).toBe(6);
      await p.stop();
      await act(async () => {});
      expect(t.asked.some(([n, b]) => n === "prefs.set" && b.name === "x.a" && b.value === 6)).toBe(true);
      expect(t.toast).toHaveBeenCalledWith("Настройка не сохранилась: too_large", "bad");
    });

    it("6594 · область: человек — без поля, флот — global, приложение — app:<имя>", async () => {
      const scope = async (s?: ui.Scope) => {
        const t = fake();
        await ui.personal(t.app, "x", () => {}, s).onLink("open");
        return t.asked[0][1].scope;
      };
      expect(await scope()).toBeUndefined();
      expect(await scope("user")).toBeUndefined();
      expect(await scope("global")).toBe("global");
      expect(await scope("app")).toBe("app:pult");
    });
  });

  describe("блок кода и просмотр", () => {
    it("копирование: значок — галочка на 1,5 с, текст доходит; подпись меняется словом", async () => {
      vi.useFakeTimers();
      const writeText = vi.fn(async () => {});
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const el = await draw(<ui.CopyButton text="код" label="Копировать" />);
      const b = el.querySelector("button")!;
      expect(b.getAttribute("aria-label")).toBe("Копировать");
      expect(b.textContent).toBe("Копировать");
      await act(async () => b.click());
      expect(writeText).toHaveBeenCalledWith("код");
      expect(b.textContent).toBe("скопировано");
      await act(async () => vi.advanceTimersByTime(1500));
      expect(b.textContent).toBe("Копировать");
    });

    it("буфера нет или отказал — «буфер недоступен», экран жив", async () => {
      vi.stubGlobal("navigator", {});
      const none = (await draw(<ui.CopyButton text="к" label="Копировать" />)).querySelector("button")!;
      await act(async () => none.click());
      expect(none.textContent).toBe("буфер недоступен");
      vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new Error("нет")) } });
      const bad = (await draw(<ui.CopyButton text="к" label="Копировать" />)).querySelector("button")!;
      await act(async () => bad.click());
      expect(bad.textContent).toBe("буфер недоступен");
    });

    it("блок кода: язык, подсветка; неизвестный язык и имя из прототипа — текстом", async () => {
      const ts = await draw(<ui.CodeBlock code="const a = 1;" lang="TS" />);
      expect(ts.querySelector(".cb")!.getAttribute("data-lang")).toBe("TS");
      expect(ts.querySelector(".cb-l")!.textContent).toBe("TS");
      expect(ts.querySelector("code")!.className).toBe("hljs language-TS");
      expect(ts.querySelector("code .hljs-keyword")!.textContent).toBe("const");
      for (const lang of ["nosuch", "constructor", "__proto__"]) {
        const el = await draw(<ui.CodeBlock code="x" lang={lang} />);
        expect(el.querySelector("code")!.textContent).toBe("x");
      }
      const plain = await draw(<ui.CodeBlock code="x" lang="" />);
      expect(plain.querySelector("code")!.className).toBe("hljs");
      expect(plain.querySelector(".cb")!.hasAttribute("data-lang")).toBe(false);
    });

    it("язык файла по расширению; незнакомое и имя из прототипа — пусто", () => {
      expect(["a.ts", "a.TSX", "a.sh", "a.svg", "a.h", "a.ps1", "a.yml", "a.toml"].map(ui.langOfPath)).toEqual(["ts", "ts", "bash", "html", "c", "ps1", "yaml", "toml"]);
      expect(["a.xyz", "a.constructor", undefined].map(ui.langOfPath)).toEqual(["", "", ""]);
    });

    it("текст узла разметки с вложенными", () => {
      expect(ui.textOfNode({ type: "element", children: [{ type: "text", value: "а" }, { type: "element", children: [{ type: "text", value: "б" }] }] })).toBe("аб");
      expect(ui.textOfNode(undefined)).toBe("");
    });

    it("документ в песочнице: правило CSP раньше всего; знак сигнала виден только скрипту", () => {
      const doc = ui.framed("<p>тело</p>", "знак");
      expect(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; webrtc 'block'"><script>`)).toBe(true);
      expect(doc).toContain('p.postMessage("знак","*")');
      expect(doc.endsWith("<p>тело</p>")).toBe(true);
    });

    /** Рамка: сообщения документа подаёт тест. */
    async function frame() {
      const el = await draw(<ui.HtmlFrame html="<p>т</p>" />);
      const f = el.querySelector("iframe")!;
      const say = (data: unknown) => act(async () => window.dispatchEvent(new MessageEvent("message", { data, source: f.contentWindow })));
      return { el, f, say };
    }

    it("рамка: песочница без своего источника и реферера; подпись; высота от документа в пределах 60…640", async () => {
      const t = await frame();
      expect(t.f.getAttribute("sandbox")).toBe("allow-scripts");
      expect(t.f.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(t.f.getAttribute("title")).toBe("Просмотр HTML");
      const height = () => t.el.querySelector<HTMLElement>(".html-frame")!.style.height;
      expect(height()).toBe("");
      await t.say({ height: 300.2 });
      expect(height()).toBe("301px");
      await t.say({ height: 5 });
      expect(height()).toBe("60px");
      await t.say({ height: 99999 });
      expect(height()).toBe("640px");
      await t.say({ height: "много" });
      expect(height()).toBe("640px");
    });

    it("рамка: чужой источник сообщения не слушаем; нет сигнала за 0,5 с — просмотр снят; второе load — снят; «Показать снова» возвращает", async () => {
      vi.useFakeTimers();
      const t = await frame();
      await act(async () => window.dispatchEvent(new MessageEvent("message", { data: { height: 300 }, source: window })));
      expect(t.el.querySelector<HTMLElement>(".html-frame")!.style.height).toBe("");
      // первое load стенд браузера присылает сам при вставке рамки
      await act(async () => vi.advanceTimersByTime(499));
      expect(t.el.querySelector("iframe")).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(1));
      expect(t.el.querySelector(".html-left")!.textContent).toBe("Документ ушёл на другую страницу — просмотр снятПоказать снова");
      expect(t.el.querySelector(".html-left")!.getAttribute("role")).toBe("status");
      await act(async () => t.el.querySelector<HTMLElement>(".html-left button")!.click());
      const again = t.el.querySelector("iframe")!;
      expect(again).not.toBeNull();
      const sign = /postMessage\("([^"]+)"/.exec(again.getAttribute("srcdoc")!)![1];
      await act(async () => window.dispatchEvent(new MessageEvent("message", { data: sign, source: again.contentWindow })));
      await act(async () => vi.advanceTimersByTime(600));
      expect(t.el.querySelector("iframe")).not.toBeNull();
      await act(async () => again.dispatchEvent(new Event("load")));
      expect(t.el.querySelector(".html-left")).not.toBeNull();
    });

    it("текст ответа: класс живого потока; сноска ведёт внутри текста, адрес страницы не меняется; ссылка на эту страницу без адреса", async () => {
      history.replaceState(null, "", "/#board");
      const el = await draw(<ui.Markdown text={"Текст[^1] [сюда](#card?x=1) [туда](https://example.com/#a)\n\n[^1]: сноска"} live />);
      await act(async () => {});
      expect(el.querySelector(".md.caret")).not.toBeNull();
      const links = [...el.querySelectorAll("a")];
      const note = links.find((a) => a.getAttribute("href")?.startsWith("#user-content-fn-"))!;
      await act(async () => note.click());
      expect(location.hash).toBe("#board");
      expect(links.find((a) => a.textContent === "сюда")!.hasAttribute("href")).toBe(false);
      const out = links.find((a) => a.textContent === "туда")!;
      expect(out.getAttribute("href")).toBe("https://example.com/#a");
      expect(out.getAttribute("target")).toBe("_blank");
      expect(out.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("разметка компонентов сверх класса: переключатель, флажок, вкладки, поле, группа, лимит, выбор, копирование, блок кода", async () => {
      const el = await draw(
        <>
          <ui.Switch on data-k="sw" className="x" />
          <ui.Check readOnly checked data-k="ch" className="x" />
          <ui.Tabs tabs={[["a", "A"]]} cur="a" pick={() => {}} className="x" data-k="tabs" />
          <ui.CommitIn value="v" onCommit={() => {}} mono className="x" data-k="in" />
          <ui.LimitRow label="L" used={0.5} className="x" data-k="lim" />
          <ui.PickOne all={["a", "b", "c"]} near={["b"]} cur="a" on={() => {}} />
          <ui.Row label="L" data-k="row">v</ui.Row>
          <ui.CopyButton text="t" />
          <ui.CodeBlock code="<a/>" lang="html" />
          <ui.Btn data-k="btn" />
          <ui.Cta data-k="cta" />
          <ui.Chip on data-k="chip" />
        </>,
      );
      const at = (k: string) => el.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
      expect(at("sw").tagName).toBe("BUTTON");
      expect(at("sw").getAttribute("type")).toBe("button");
      expect(at("sw").className).toBe("x");
      expect(at("sw").getAttribute("aria-checked")).toBe("true");
      expect(at("ch").className).toBe("x");
      expect(at("tabs").className).toBe("x");
      const tab = at("tabs").querySelector("button")!;
      expect(tab.className).toBe("sb-b");
      expect(tab.hasAttribute("type")).toBe(false);
      expect(at("in").className).toBe("sb-in m x");
      expect(at("lim").className).toBe("x");
      expect([...at("lim").children].map((c) => c.tagName)).toEqual(["SPAN", "SPAN", "EM"]);
      for (const k of ["btn", "cta", "chip"]) expect(at(k).hasAttribute("type"), k).toBe(false);
      const [pick1, pick2] = el.querySelectorAll<HTMLElement>("button[aria-pressed].sb-b");
      expect([pick1.textContent, pick2.textContent]).toEqual(["a", "b"]);
      expect(el.querySelector("select")!.className).toBe("sb-in");
      expect(el.querySelector<HTMLOptionElement>("select option")!.value).toBe("");
      expect(at("row").textContent).toBe("Lv");
      const copy = el.querySelector<HTMLElement>('.cb-b[aria-label="Копировать"]')!;
      expect(copy.getAttribute("type")).toBe("button");
      expect(copy.getAttribute("title")).toBe("Копировать");
      expect(copy.querySelector("svg")!.getAttribute("class")).toContain("lucide-copy");
      expect(copy.querySelector("svg")!.getAttribute("width")).toBe("13");
      const cb = el.querySelector(".cb")!;
      expect([...cb.children].map((c) => c.className || c.tagName)).toEqual(["cb-h", "PRE"]);
      const view = [...cb.querySelectorAll<HTMLElement>(".cb-b")];
      expect(view.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", null]);
      expect(view[0].textContent).toBe("Просмотр");
      expect(view[0].querySelector("svg")!.getAttribute("class")).toContain("lucide-eye");
      await act(async () => view[0].click());
      expect(cb.querySelector(".html-frame iframe")).not.toBeNull();
      expect(cb.querySelector("pre")).toBeNull();
      expect(cb.querySelector(".cb-b")!.getAttribute("aria-pressed")).toBe("true");
      expect(cb.querySelector(".cb-b")!.textContent).toBe("Код");
    });

    it("useHighlighted: узлы подсветки; незнакомый язык — текст как есть", async () => {
      const Show = ({ code, lang }: { code: string; lang: string }) => <code>{ui.useHighlighted(code, lang)}</code>;
      const known = await draw(<Show code="const a" lang="ts" />);
      expect(known.querySelector(".hljs-keyword")!.textContent).toBe("const");
      const other = await draw(<Show code="const a" lang="nosuch" />);
      expect(other.querySelector("code")!.innerHTML).toBe("const a");
    });

    it("текст ответа: таблица в прокрутке, картинка лениво и без реферера, список задач, сноска с ссылкой назад", async () => {
      const el = await draw(<ui.Markdown text={"| a |\n|---|\n| 1 |\n\n- [x] t\n\n![x](https://e.com/i.png)\n\nx[^1]\n\n[^1]: n"} />);
      expect(el.querySelector(".md > .md-table > table")).not.toBeNull();
      expect(el.querySelector(".md.caret")).toBeNull();
      const img = el.querySelector("img")!;
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(el.querySelector("ul.contains-task-list li.task-list-item input")!.hasAttribute("disabled")).toBe(true);
      expect(el.querySelector("section.footnotes li#user-content-fn-1 a.data-footnote-backref")!.getAttribute("href")).toBe("#user-content-fnref-1");
    });

    it("манифест и основание стилей — у контракта", () => {
      expect(ui.manifest.name).toBe("web-ui");
      expect(typeof ui.UI_CSS).toBe("string");
    });
  });
});
