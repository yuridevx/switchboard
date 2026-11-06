// Модуль точек Host: пометка «в R2», когда снимать точку и запросы контракта.
import { existsSync } from "node:fs";
import { isRefusal, refuse } from "@switchboard/host";
import type { Host, Module, Session } from "@switchboard/host";
import { raise } from "./raise.ts";
import { conversationOf, snap, type PointExtra, type Why } from "./snap.ts";

/** Конец хода — точка не чаще раза в 2 мин; ход идёт 10 мин — точка посреди хода; конца хода стоп ждёт 6 ч. */
const GAP_MS = 2 * 60_000;
const LONG_MS = 10 * 60_000;
const TURN_MS = 6 * 3_600_000;

/** Раздел сессии: пометка; base — копия, первая точка ещё не снята. */
type Mark = { r2: true; base?: number };

export function make(): Module {
  let host: Host;
  /** машина встала и relay ответил: точка старта — один раз */
  let ready = false;
  let started = false;
  let down = false;
  const lastAt = new Map<string, number>();
  const errors = new Map<string, { error: string; at: number }>();
  const turns = new Map<string, ReturnType<typeof setTimeout>>();
  const idle = new Map<string, Set<() => void>>();
  const leaving = new Set<string>();
  /** точки одной сессии идут по очереди */
  const queue = new Map<string, Promise<unknown>>();

  const markOf = (s: Session) => s.store<Mark>();
  const marked = (s: Session) => markOf(s).get() !== undefined;

  /** Точка и её след: срок правила и поле roster. */
  function save(s: Session, why: Why, extra?: PointExtra) {
    const { callsign } = s.info;
    const turn = (queue.get(callsign) ?? Promise.resolve()).catch(() => {}).then(() => take(s, why, extra));
    queue.set(callsign, turn);
    return turn;
  }

  async function take(s: Session, why: Why, extra?: PointExtra) {
    const { callsign } = s.info;
    try {
      const put = await snap(host, s, why, extra);
      lastAt.set(callsign, Date.now());
      errors.delete(callsign);
      return put;
    } catch (e) {
      const word = isRefusal(e) ? e.word : "failed";
      errors.set(callsign, { error: word, at: Date.now() });
      host.log({ kind: "refuse", ev: "point", word, callsign, why: String(e) });
      throw e;
    } finally {
      s.refresh();
    }
  }

  /** Сессию подняли в другом месте: дописанное — веткой, сессия уходит отсюда. */
  async function leave(s: Session) {
    leaving.add(s.info.callsign);
    await save(s, "yield");
    await host.request("session.remove", { callsign: s.info.callsign });
  }

  /** Точка по поводу машины: сбой — в поле r2 и журнале, запрашивать некому. */
  function auto(s: Session, why: Why = "rule") {
    const mark = markOf(s).get();
    // до точки старта правило молчит: первая точка после перезапуска Host — она
    if (down || leaving.has(s.info.callsign) || !mark || (!started && why === "rule") || !existsSync(conversationOf(s))) return;
    const first = mark.base === undefined ? save(s, why) : save(s, "raise", { base: mark.base }).then(() => markOf(s).update((m) => m && { r2: true }));
    void first.catch((e) => (isRefusal(e) && e.word === "not_owner" ? leave(s) : undefined)).catch(() => {});
  }

  function startPoints() {
    if (started || !ready || !host.roster()) return;
    started = true;
    for (const { callsign } of host.sessions()) {
      const s = host.session(callsign);
      if (s) auto(s, "start");
    }
  }

  function endTurn(callsign: string) {
    clearTimeout(turns.get(callsign));
    return turns.delete(callsign);
  }

  function longTurn(s: Session) {
    turns.set(s.info.callsign, setTimeout(() => {
      turns.delete(s.info.callsign);
      auto(s);
      if (s.state === "busy") longTurn(s);
    }, LONG_MS));
  }

  /** Ждать конца хода: предел и штатная остановка — отказ словом. */
  function turnEnd(s: Session, signal: AbortSignal) {
    const { callsign } = s.info;
    return new Promise<void>((done, fail) => {
      const waiters = idle.get(callsign) ?? new Set();
      idle.set(callsign, waiters);
      const finish = (end: () => void) => {
        clearTimeout(limit);
        signal.removeEventListener("abort", abort);
        waiters.delete(ended);
        end();
      };
      const ended = () => finish(done);
      const abort = () => finish(() => fail(refuse("shutting_down", "Host останавливается")));
      const limit = setTimeout(() => finish(() => fail(refuse("running", `${callsign}: ход не кончился`))), TURN_MS);
      signal.addEventListener("abort", abort);
      waiters.add(ended);
    });
  }

  return {
    fields: {
      r2: (s) => (marked(s) ? (errors.get(s.info.callsign) ?? {}) : undefined),
    },
    on: {
      state(s, state) {
        const { callsign } = s.info;
        if (state !== "busy") for (const ended of [...(idle.get(callsign) ?? [])]) ended();
        if (state === "busy" && !turns.has(callsign) && marked(s)) longTurn(s);
        if (state !== "idle") return;
        endTurn(callsign);
        if (Date.now() - (lastAt.get(callsign) ?? 0) >= GAP_MS) auto(s);
      },
      close(s) {
        endTurn(s.info.callsign);
        auto(s);
      },
      frame: (f) => void (f.type === "roster" && startPoints()),
      ready() {
        ready = true;
        startPoints();
      },
    },
    requests: {
      async "session.r2"(req, ctx) {
        const s = ctx.session();
        if (req.on === true) {
          markOf(s).update((m) => m ?? { r2: true });
          s.refresh();
          if (!existsSync(conversationOf(s))) return { point: null };
          return { point: (await save(s, "save")).id };
        }
        const r = await host.request("points.delete", { to: ".points", sid: s.info.session_id, by: ctx.from });
        if (!r.ok) throw refuse(r.error, r.why as string | undefined);
        const { callsign } = s.info;
        markOf(s).set(undefined);
        errors.delete(callsign);
        endTurn(callsign);
        host.log({ kind: "note", ev: "r2_off", callsign, why: `${callsign}: пометка «в R2» снята, точки удалены из R2` });
        s.refresh();
        return { deleted: (r.result as { points: number }).points };
      },

      async "points.save"(req, ctx) {
        const s = ctx.session();
        if (!marked(s)) throw refuse("not_r2", `${s.info.callsign} не в R2`);
        if (req.stop === true) {
          if (req.interrupt !== true) {
            if (s.state === "busy") await turnEnd(s, ctx.signal);
            if (s.state === "waiting") throw refuse("waiting", `${s.info.callsign} ждёт ответа человека`);
          }
          if (s.state !== "stopped") {
            const r = await host.request("session.stop", { callsign: s.info.callsign });
            if (!r.ok) throw refuse(r.error, r.why as string | undefined);
          }
        }
        const put = await save(s, "save");
        return { point: put.id, same: put.same === true };
      },

      "points.raise": (req, ctx) =>
        raise(req, ctx, {
          mark: (s, base) => markOf(s).set({ r2: true, ...(base === undefined ? {} : { base }) }),
          save,
          drop: (callsign) => void leaving.add(callsign),
        }),
    },
    start(h) {
      host = h;
    },
    async stop() {
      down = true;
      for (const timer of turns.values()) clearTimeout(timer);
      await Promise.allSettled(queue.values());
    },
  };
}
