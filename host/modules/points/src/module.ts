// Модуль точек: пометка «в R2» и правило. Конец хода — не чаще раза в 2 мин, ход 10 мин без точки — посреди хода, закрытие и старт Host — всегда.
// Точки одной сессии идут по очереди; штатная остановка доводит начатые и новых не начинает.
import type { Ctx, Frame, Host, Module, Session } from "@switchboard/host";
import { isRefusal, refuse } from "@switchboard/host";
import { capture, hasConversation, type Took, type Why } from "./capture.ts";
import { raise, type Marks } from "./raise.ts";

const GAP_MS = 2 * 60_000;
const LONG_MS = 10 * 60_000;
/** Ждать конец хода перед стопом: ход законно идёт часами. */
const TURN_MS = 6 * 3_600_000;

type Mark = { r2: true; base?: number };

export function make(): Module {
  let host!: Host;
  let ready = false;
  let startDone = false;
  let stopping = false;
  /** последняя удачная точка: от неё считается правило */
  const lastAt = new Map<string, number>();
  const errors = new Map<string, { error: string; at: number }>();
  const longTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const queues = new Map<string, Promise<unknown>>();
  /** отдана или убрана: на закрытии точки нет */
  const leaving = new Set<string>();
  const turnEnds = new Map<string, Array<() => void>>();

  const markOf = (s: Session) => s.store<Mark>();
  const marked = (s: Session) => !!markOf(s).get()?.r2;

  function inTurn<T>(callsign: string, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(callsign) ?? Promise.resolve()).then(work);
    queues.set(callsign, run.catch(() => {}));
    return run;
  }

  function took(s: Session): void {
    lastAt.set(s.info.callsign, Date.now());
    errors.delete(s.info.callsign);
    s.refresh();
  }

  /** Точка и её след: срок правила и поле r2. */
  function save(s: Session, why: Why): Promise<Took> {
    return inTurn(s.info.callsign, async () => {
      try {
        const t = await capture(host, s, why);
        took(s);
        return t;
      } catch (e) {
        errors.set(s.info.callsign, { error: isRefusal(e) ? e.word : "failed", at: Date.now() });
        s.refresh();
        throw e;
      }
    });
  }

  /** Сессию подняли в другом месте: отдаём дописанное веткой и уходим. */
  async function yieldSession(s: Session): Promise<void> {
    const { callsign } = s.info;
    leaving.add(callsign);
    await capture(host, s, { why: "yield" });
    await host.request("session.remove", { callsign });
  }

  /** Точка по правилу: отказ — поле r2 и журнал; модуль живёт дальше. */
  function auto(s: Session, why: Why["why"]): void {
    if (stopping || leaving.has(s.info.callsign) || !marked(s) || !hasConversation(s)) return;
    const base = markOf(s).get()?.base;
    const reason: Why = base === undefined ? { why } : { why: "raise", base };
    save(s, reason)
      .then(() => {
        if (base !== undefined) markOf(s).update((m) => (m ? { r2: true } : m));
      })
      .catch((e: unknown) => {
        if (isRefusal(e) && e.word === "not_owner") return yieldSession(s);
        if (!isRefusal(e)) host.log({ kind: "refuse", ev: "point", word: "failed", callsign: s.info.callsign, why: String(e) });
        return undefined;
      })
      .catch((e: unknown) => host.log({ kind: "refuse", ev: "yield", word: "failed", callsign: s.info.callsign, why: String(e) }));
  }

  function armLong(s: Session): void {
    const { callsign } = s.info;
    if (longTimers.has(callsign)) return;
    longTimers.set(
      callsign,
      setTimeout(() => {
        longTimers.delete(callsign);
        auto(s, "rule");
        if (s.state === "busy" && !stopping) armLong(s);
      }, LONG_MS),
    );
  }

  function disarm(callsign: string): void {
    clearTimeout(longTimers.get(callsign));
    longTimers.delete(callsign);
  }

  function startPoints(): void {
    if (startDone || !ready || !host.roster()) return;
    startDone = true;
    for (const { callsign } of host.sessions()) auto(host.session(callsign)!, "start");
  }

  /** Дождаться конца хода. Предел — шесть часов, затем слово running; остановка Host снимает ожидание. */
  function turnEnd(s: Session, signal: AbortSignal): Promise<void> {
    return new Promise((done, fail) => {
      const { callsign } = s.info;
      const timer = setTimeout(() => fail(refuse("running", `${callsign}: ход не кончился`)), TURN_MS);
      const finish = () => {
        clearTimeout(timer);
        done();
      };
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          fail(refuse("shutting_down", "Host останавливается"));
        },
        { once: true },
      );
      turnEnds.set(callsign, [...(turnEnds.get(callsign) ?? []), finish]);
    });
  }

  const sessionOf = (req: Frame): Session => {
    const s = host.session(String(req.callsign));
    if (!s) throw refuse("offline", `${String(req.callsign)}: сессии нет на этой машине`);
    return s;
  };

  const marks: Marks = {
    mark: (s, base) => markOf(s).set(base === undefined ? { r2: true } : { r2: true, base }),
    leave: (callsign) => void leaving.add(callsign),
    took,
  };

  async function pointsSave(req: Frame, ctx: Ctx): Promise<Took> {
    const s = sessionOf(req);
    const { callsign } = s.info;
    if (!marked(s)) throw refuse("not_r2", `${callsign} не в R2`);
    if (req.stop === true) {
      if (!req.interrupt) {
        if (s.state === "busy") await turnEnd(s, ctx.signal);
        if (s.state === "waiting") throw refuse("waiting", `${callsign} ждёт ответа человека`);
      }
      if (s.state !== "stopped") {
        const stopped = await host.request("session.stop", { callsign });
        if (!stopped.ok) throw refuse(stopped.error, `${callsign} не остановилась`);
      }
    }
    return save(s, { why: "save" });
  }

  async function sessionR2(req: Frame, ctx: Ctx): Promise<unknown> {
    const s = sessionOf(req);
    const { callsign, session_id: sid } = s.info;
    if (req.on) {
      markOf(s).update((m) => ({ ...m, r2: true }));
      if (!hasConversation(s)) {
        s.refresh();
        return { point: null };
      }
      return { point: (await save(s, { why: "save" })).point };
    }
    const r = await host.request("points.delete", { to: ".points", sid, ...(ctx.from ? { by: ctx.from } : {}) });
    if (!r.ok) throw refuse(r.error, `${callsign}: реестр не удалил точки`);
    markOf(s).set(undefined);
    disarm(callsign);
    lastAt.delete(callsign);
    errors.delete(callsign);
    s.refresh();
    host.log({ ev: "r2_off", callsign, why: `${callsign}: пометка «в R2» снята, точки удалены из R2` });
    return { deleted: (r.result as { points: number }).points };
  }

  return {
    start(h) {
      host = h;
    },
    async stop() {
      stopping = true;
      for (const callsign of [...longTimers.keys()]) disarm(callsign);
      await Promise.allSettled(queues.values());
    },
    requests: {
      "points.save": pointsSave,
      "points.raise": (req, ctx) => raise(host, marks, req, ctx),
      "session.r2": sessionR2,
    },
    fields: {
      r2: (s) => (marked(s) ? (errors.get(s.info.callsign) ?? {}) : undefined),
    },
    on: {
      ready() {
        ready = true;
        startPoints();
      },
      frame(f) {
        if (f.type === "roster") startPoints();
      },
      state(s, state) {
        const { callsign } = s.info;
        if (state !== "busy") {
          const waiters = turnEnds.get(callsign) ?? [];
          turnEnds.delete(callsign);
          for (const finish of waiters) finish();
        }
        if (!marked(s)) return;
        if (state === "busy") armLong(s);
        if (state !== "idle") return;
        disarm(callsign);
        // до точки старта правило молчит: первая точка после перезапуска Host — она
        if (startDone && Date.now() - (lastAt.get(callsign) ?? 0) >= GAP_MS) auto(s, "rule");
      },
      close(s) {
        const { callsign } = s.info;
        disarm(callsign);
        if (!leaving.has(callsign)) auto(s, "rule");
      },
    },
  };
}
