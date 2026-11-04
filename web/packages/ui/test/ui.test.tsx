// Общие помощники набора: цикл ответов машин, поле с фиксацией, таймер, правила подписей.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitIn, failText, lamp, LimitRow, linkText, machineAnswers, machineLabel, machinesWith, remoteOf, sessionLabel, stateLabel, useNow } from "../contract.ts";

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
    const next = rosterOf([["a", 1], ["b", 1]]);
    setRoster(next);
    m.onRoster(next);
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
    const r0 = rosterOf([["a", 1]]);
    m.onRoster(r0);
    m.mount();
    await act(async () => {});
    const r1 = rosterOf([["a", 1], ["bad", 1]]);
    setRoster(r1);
    m.onRoster(r1);
    await act(async () => {});
    expect(asked).toEqual(["a", "bad"]);
    expect(m.get().bad).toEqual({ error: "offline" });
    const r2 = rosterOf([["a", 2], ["bad", 1]]);
    setRoster(r2);
    m.onRoster(r2);
    await act(async () => {});
    expect(asked).toEqual(["a", "bad", "a"]);
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
});
