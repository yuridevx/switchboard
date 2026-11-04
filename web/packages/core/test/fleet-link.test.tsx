// Связь флота на краях: флот без машин, gate недоступен, адрес команды, сообщение «машина вернулась» и предел ухода.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, AppPart, ConnState, Manifest, Params } from "../contract.ts";
import { createLifecycle, LIFE_MS } from "../src/lifecycle.ts";
import { flush, homeRoster, stand, FakeRelay } from "../stand/app.ts";

const man = (provides: Record<string, number>, uses: Record<string, number> = {}): Manifest => ({ name: "m", type: "web", version: "1.0.0", provides, uses: { "app@web-core": 2, "roster@relay": 1, ...uses } });

/** Модуль с разделом a и командой cmd; записывает on.link. */
function sample() {
  const seen: Array<[ConnState, string | undefined]> = [];
  const run = vi.fn<(p: Params) => void>();
  const box: { app: App | null } = { app: null };
  const part: AppPart = {
    manifest: man({ a: 1, cmd: 1 }),
    module: (app) => {
      box.app = app;
      return {
        on: { link: (s, m) => void seen.push([s, m]), roster: () => {} },
        screens: { a: { nav: "А", label: "А", view: () => <div data-s="a">а</div> } },
        commands: { cmd: { run } },
      };
    },
  };
  return { part, seen, run, box };
}

const emptyFleet = () => homeRoster({ machines: [], sessions: [], clients: [] });
afterEach(() => vi.useRealTimers());

describe("флот без машин и gate", () => {
  it("7280 · keys.list пуст: связь открыта, roster пуст, страница доходит до экрана", async () => {
    // источник: отчёт архитектора, ошибка 1 — без машин до «Настроек» и приглашения машины не добраться
    const s = sample();
    const t = await stand([s.part], { relay: new FakeRelay(emptyFleet()) });
    await flush(10);
    expect(t.$('[data-s="a"]')).not.toBeNull();
    expect(s.box.app!.link()).toBe("open");
    expect(s.box.app!.roster()!.machines).toEqual([]);
    expect(s.seen).toEqual([["open", undefined]]);
  });

  it("7281 · gate недоступен при старте: полоса «Нет связи», gate ответил — полоса снята, экран виден", async () => {
    // источник: контракт web-core — «обрыв и gate_unavailable — полоса «Нет связи», переподключение с растущей паузой»
    const relay = new FakeRelay(homeRoster());
    let down = true;
    const fetchFleet = (async (url: string, init?: RequestInit) => {
      const f = JSON.parse(String(init?.body ?? "{}")) as { type?: string; id?: string };
      if (down && f.type === "keys.list") return Response.json({ type: "reply", id: f.id, ok: false, error: "gate_unavailable" });
      return relay.fetch(url, init);
    }) as typeof fetch;
    const s = sample();
    const t = await stand([s.part], { relay, pauseMs: 20, options: { fetch: fetchFleet } });
    await flush(10);
    expect(t.$(".sb-off")!.hidden).toBe(false);
    expect(t.$(".sb-off")!.textContent).toContain("Нет связи");
    expect(s.box.app!.link()).toBe("closed");
    down = false;
    await new Promise((r) => setTimeout(r, 60));
    await flush(10);
    expect(t.$(".sb-off")!.hidden).toBe(true);
    expect(t.$('[data-s="a"]')).not.toBeNull();
  });

  it("7282 · адрес команды #cmd — домашний экран, команда не выполнена; app.open команды не исполняет", async () => {
    // источник: отчёт архитектора, ошибка 7 — #pin?callsign=… вёл на команду, пустой экран
    const s = sample();
    const t = await stand([s.part], { url: "/#cmd?x=1" });
    await flush(10);
    expect(t.$('[data-s="a"]')).not.toBeNull();
    expect(s.box.app!.current()!.screen).toBe("a");
    expect(s.run).not.toHaveBeenCalled();
    s.box.app!.run("cmd", { x: "2" });
    expect(s.run).toHaveBeenCalledWith({ x: "2" });
  });
});

describe("машина вернулась или перезапустилась — сообщает только ядро", () => {
  const machineLinks = (s: ReturnType<typeof sample>) => s.seen.filter(([, m]) => m).map(([state, m]) => [state, m]);

  it("6821 · roster без смены since: сменились только сессии — on.link молчит", async () => {
    // источник: гейт архитектора — лишняя коммуникация
    const s = sample();
    const relay = new FakeRelay(homeRoster());
    await stand([s.part], { relay });
    await flush(10);
    relay.setRoster(homeRoster({ sessions: [] }));
    await flush(10);
    expect(machineLinks(s)).toEqual([]);
  });

  it("7283 · новый since — on.link open с машиной; пришла новая машина — тоже; первый roster — точка отсчёта", async () => {
    // источник: отчёт архитектора, логика 1 — одно место вместо четырёх
    const s = sample();
    const relay = new FakeRelay(homeRoster());
    await stand([s.part], { relay });
    await flush(10);
    expect(machineLinks(s)).toEqual([]);
    const r = homeRoster();
    relay.setRoster({ ...r, machines: r.machines.map((m) => (m.machine === "pc" ? { ...m, since: m.since + 1 } : m)) });
    await flush(10);
    expect(machineLinks(s)).toEqual([["open", "pc"]]);
    const gone = homeRoster();
    relay.setRoster({ ...gone, machines: gone.machines.filter((m) => m.machine !== "pc") });
    await flush(10);
    relay.setRoster(gone);
    await flush(10);
    expect(machineLinks(s)).toEqual([["open", "pc"], ["open", "pc"]]);
  });
});

describe("предел ухода и возвращения", () => {
  it("7284 · модуль не отпускает: уход закрывает связь за предел, возвращение идёт дальше", async () => {
    // источник: устав — у всех операций лимит и graceful shutdown; не успела — жёсткий выход, это ожидаемая ветка
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const never = new Promise<void>(() => {});
    const close = vi.fn();
    const connect = vi.fn();
    const life = createLifecycle({
      registry: { stopAll: () => never, showAll: () => never } as never,
      link: { settle: () => Promise.resolve([]), close, connect } as never,
      state: { get: () => ({ full: null }) } as never,
    });
    const hide = life.hide();
    await vi.advanceTimersByTimeAsync(LIFE_MS - 1);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await hide;
    expect(close).toHaveBeenCalledOnce();
    const show = life.show();
    await vi.advanceTimersByTimeAsync(LIFE_MS);
    await show;
    expect(connect).toHaveBeenCalledOnce();
  });
});
