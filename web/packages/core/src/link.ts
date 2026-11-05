// Связь страницы: клиент флота relay; из состояний машин — одно состояние для экрана, roster — когда ответили все машины.
import { fleet, type FleetClient, type Frame, type Roster, type WsCtor } from "@switchboard/relay";
import type { Reply } from "@switchboard/protocol";
import { plural } from "@switchboard/web-ui";
import type { Modules } from "./modules.ts";
import type { Page } from "./page.ts";
import type { Route } from "./route.ts";
import type { ConnState } from "./types.ts";

const welcome = ({ machines, sessions: { length: n } }: Roster) => `Вы во флоте: ${machines.map((m) => m.machine).join(" и ") || "машин нет"} на связи, ${n} ${plural(n, "сессия", "сессии", "сессий")}.`;

export type Link = ReturnType<typeof createLink>;

export function createLink(page: Page, mods: Modules, route: Route, stop: (word: string) => void, toast: (text: string, tone: "ok") => void) {
  const { o } = page;
  let client: FleetClient | null = null;
  /** gate ответил: машин нет */
  let empty = false;
  /** since машин в последнем roster: сравнение — только здесь */
  let known = new Map<string, number>();
  /** запросы, которые ещё ждут ответа: уход их доводит */
  const pending = new Set<Promise<unknown>>();

  function setLink(next: ConnState) {
    if (page.link === next) return;
    page.link = next;
    if (next === "open") page.down = null;
    page.changed();
    mods.each("связи", (d) => d.on?.link?.(next));
  }

  function take(c: FleetClient) {
    const merged = c.roster;
    page.roster = o.seam?.roster(merged) ?? merged;
    page.dataAt = Date.now();
    page.address = c.addr ?? page.address;
    known = new Map(page.roster.machines.map((m) => [m.machine, m.since]));
  }

  const spread = () => {
    page.changed();
    mods.each("roster", (d) => d.on?.roster?.(page.roster!));
  };

  /** roster открытого флота; вернувшаяся, новая и перезапущенная машина — on.link с её именем. */
  function publish(c: FleetClient) {
    const was = known;
    take(c);
    spread();
    for (const [machine, since] of known) if (was.get(machine) !== since) mods.each("связи", (d) => d.on?.link?.("open", machine));
  }

  /** Сводка машин: собран, когда не ждём ни одной; собранный держится, пока жива хоть одна. */
  function settle(c: FleetClient) {
    const states = [...c.links().values()].map((l) => l.state);
    const waiting = states.includes("connecting");
    const open = states.includes("open") || (empty && !states.length);
    if (page.link === "open" && open) return;
    if (!open || waiting) return setLink(waiting ? (page.down ? "connecting" : page.link) : "closed");
    const first = !page.roster;
    take(c);
    setLink("open");
    spread();
    if (first) route.follow();
    if (first && page.saved) toast(welcome(page.roster!), "ok");
  }

  function deliver(f: Frame, open = false) {
    const owner = mods.frames.get(f.type);
    if (owner) mods.call(owner.mod, `кадре ${f.type}`, () => owner.def(f, { open }));
    else if (f.id && f.type !== "reply") client?.send({ type: "reply", id: f.id, ok: false, error: "unknown_request", to: f.from });
    else if (f.type !== "reply") console.warn(`switchboard: кадр ${f.type} — владельца в приложении нет`);
  }

  function connect() {
    empty = false;
    const c: FleetClient = fleet({
      workers: o.workers,
      key: page.key!,
      fetch: o.fetch,
      WebSocket: o.WebSocket as WsCtor | undefined,
      pauseMs: o.pauseMs,
      onFrame(f) {
        if (c !== client) return;
        if (f.type !== "roster") deliver(f);
        else if (page.link === "open") publish(c);
        else settle(c);
      },
      onState(machine, state, why, retryAt) {
        if (c !== client) return;
        if (state === "stopped") return stop(why ?? "");
        if (state === "open" && machine) return;
        if (!machine) empty = state === "open";
        if (state === "closed") {
          known.delete(machine);
          console.warn(`switchboard: связь с relay оборвалась (${why}) · снова через ${Math.round((retryAt! - Date.now()) / 1000)} с`);
        }
        if (state === "closed" && (!machine || !c.links().size)) setLink("closed");
        else settle(c);
        if (state === "closed" && page.link !== "open") page.down = { retryAt: retryAt! };
        page.changed();
      },
    });
    client = c;
  }

  /** Закрыть всё: это не обрыв, старый клиент больше не слышен. */
  function close(reason: string) {
    const c = client;
    client = null;
    c?.close(1000, reason);
  }

  /** Подключиться: промежуточного «connecting» модули не слышат. */
  function open() {
    page.link = "connecting";
    connect();
  }

  return {
    deliver,
    open,
    close(reason: string, next: ConnState = "closed") {
      close(reason);
      setLink(next);
    },
    /** «Сейчас»: новое соединение без паузы. */
    now() {
      close("now");
      open();
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
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
