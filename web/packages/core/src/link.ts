// Связь страницы: клиент флота relay, из состояний машин — одно состояние для экрана; roster — когда ответили все машины.
import { fleet, type FleetClient, type Frame, type Roster, type WsCtor } from "@switchboard/relay";
import type { Reply } from "@switchboard/protocol";
import { plural } from "@switchboard/web-ui";
import type { Modules } from "./modules.ts";
import type { Page } from "./page.ts";
import type { Route } from "./route.ts";
import type { ConnState } from "./types.ts";

const list = new Intl.ListFormat("ru", { type: "conjunction" });

const welcome = (r: Roster) => {
  const names = r.machines.map((m) => m.machine);
  const n = r.sessions.length;
  return `Вы во флоте: ${names.length ? list.format(names) : "машин нет"} на связи, ${n} ${plural(n, "сессия", "сессии", "сессий")}.`;
};

export type Link = ReturnType<typeof createLink>;

export function createLink(page: Page, mods: Modules, route: Route, stop: (word: string) => void, toast: (text: string, tone: "ok") => void) {
  const { o } = page;
  let client: FleetClient | null = null;
  /** gate назвал пустой список машин */
  let empty = false;
  /** since машин: сравнение — только здесь; пусто — точка отсчёта */
  let known: Map<string, number> | null = null;

  function setLink(next: ConnState) {
    if (page.link === next) return;
    page.link = next;
    if (next === "open") page.down = null;
    page.changed();
    mods.each("связи", (d) => d.on?.link?.(next));
  }

  /** roster флота модулям; вернувшаяся, новая и перезапущенная машина — on.link с её именем. */
  function publish(c: FleetClient) {
    const merged = c.roster;
    const roster = o.seam?.roster(merged) ?? merged;
    page.roster = roster;
    page.dataAt = Date.now();
    page.address = c.addr ?? page.address;
    page.changed();
    mods.each("roster", (d) => d.on?.roster?.(roster));
    const was = known;
    known = new Map(roster.machines.map((m) => [m.machine, m.since]));
    for (const [machine, since] of known) if (was && was.get(machine) !== since) mods.each("связи", (d) => d.on?.link?.("open", machine));
  }

  /** Сводка машин: открыта, когда ответили все; открытая держится, пока жива хоть одна. */
  function settle(c: FleetClient) {
    const states = [...c.links().values()].map((l) => l.state);
    const waiting = states.includes("connecting");
    const open = states.includes("open") || (empty && !states.length);
    if (open && (page.link === "open" || !waiting)) {
      const first = !page.roster;
      if (page.link !== "open") known = null;
      publish(c);
      setLink("open");
      if (first) route.follow();
      if (first && page.saved) toast(welcome(page.roster!), "ok");
    } else if (!waiting) setLink("closed");
    else if (!open && page.down) setLink("connecting");
  }

  function connect() {
    empty = false;
    known = null;
    const c: FleetClient = fleet({
      workers: o.workers,
      key: page.key!,
      fetch: o.fetch,
      WebSocket: o.WebSocket as WsCtor | undefined,
      pauseMs: o.pauseMs,
      onFrame(f) {
        if (c === client) f.type === "roster" ? settle(c) : take(f);
      },
      onState(machine, state, why, retryAt) {
        if (c !== client) return;
        if (state === "stopped") return stop(why ?? "");
        if (state === "closed") {
          const s = Math.ceil(((retryAt ?? 0) - Date.now()) / 1000);
          console.warn(`switchboard: связь с ${machine || "gate"} оборвалась (${why}), снова через ${s} с`);
          page.down = { retryAt: retryAt ?? 0 };
          page.changed();
          if (!machine) return setLink("closed");
        }
        if (!machine && state === "open") empty = true;
        if (state !== "open" || !machine) settle(c);
      },
    });
    client = c;
  }

  /** Кадр модулю; запрос без владельца — отказ спросившему; поздний ответ никому не нужен. */
  function take(f: Frame) {
    if (f.type !== "reply") deliver(f);
  }

  function deliver(f: Frame, open = false) {
    const owner = mods.frames.get(f.type);
    if (owner) return void mods.call(owner.mod, `кадре ${f.type}`, () => owner.def(f, { open }));
    if (f.id) return void client?.send({ type: "reply", id: f.id, ok: false, error: "unknown_request", to: f.from });
    console.warn(`switchboard: кадр ${f.type} — владельца в приложении нет`);
  }

  function drop(reason: string) {
    const c = client;
    client = null;
    c?.close(1000, reason);
  }

  const pending = new Set<Promise<unknown>>();

  return {
    connect,
    deliver,
    /** Закрыть всё и не показывать это как обрыв. */
    drop(reason: string, next: ConnState = "closed") {
      drop(reason);
      setLink(next);
    },
    /** Новая попытка без паузы. */
    now() {
      drop("now");
      page.link = "connecting";
      connect();
    },
    /** Подключиться снова после ухода: промежуточного «connecting» модули не слышат. */
    back() {
      page.link = "connecting";
      connect();
    },
    /** Запрос; связи нет — отказ сразу. */
    request(f: Frame, read: boolean): Promise<Reply> {
      const real = (x: Frame) => client?.request(x, read) ?? Promise.resolve({ type: "reply", id: x.id ?? "", ok: false, error: "disconnected" } as Reply);
      const r = o.seam ? o.seam.request(f, read, real) : real(f);
      pending.add(r);
      void r.finally(() => pending.delete(r));
      return r;
    },
    /** Дождаться начатых запросов, в том числе начатых за это время. */
    async drain() {
      while (pending.size) await Promise.all(pending);
    },
  };
}
