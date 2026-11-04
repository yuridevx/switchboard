// Модуль точек: запросы контракта, поле roster и события сессий; своё у него — пометка «в R2» в разделе сессии.
import { refuse } from "@switchboard/host";
import type { Host, Module, Session, SessionState } from "@switchboard/host";
import { Cadence } from "./cadence.ts";
import { makeCapture } from "./capture.ts";
import type { Why } from "./capture.ts";
import { makeRaise } from "./raise.ts";
import type { Mark } from "./raise.ts";

export function make(): Module {
  let host: Host;
  let stopping = false;
  // R2 — глобальным fetch на момент вызова
  const fetcher = ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch;
  const capture = makeCapture(() => host, fetcher, (s) => cadenceOf(s).taken());
  const raise = makeRaise(() => host, capture, fetcher);
  const cadences = new Map<string, Cadence>();
  /** кто ждёт конца хода перед остановкой */
  const turnEnds = new Map<string, Array<() => void>>();
  /** сессии, чью точку старта Host уже снимали */
  const started = new Set<string>();
  /** точки старта ждут первого roster: до связи points.put получил бы disconnected */
  const waitingLink = new Set<string>();

  const marked = (s: Session) => !!s.store<Mark>().get()?.r2;
  const need = (callsign: unknown) => {
    const s = host.session(String(callsign));
    if (!s) throw refuse("offline", `${String(callsign)}: сессии нет на машине`);
    return s;
  };

  function cadenceOf(s: Session): Cadence {
    const cs = s.info.callsign;
    let c = cadences.get(cs);
    if (!c) cadences.set(cs, (c = new Cadence(() => onRule(s), () => s.state)));
    return c;
  }

  /** Повод правила; модуль останавливается — новых точек не начинать. */
  function onRule(s: Session, why: Why = "rule"): void {
    if (stopping || !marked(s)) return;
    const base = s.store<Mark>().get()?.base;
    if (base === undefined) return void capture.take(s, why);
    // копия: файл нового разговора уже есть — снять точку подъёма с её базой
    void capture.take(s, "raise", { base }).then((out) => {
      if (!("error" in out)) s.store<Mark>().set({ r2: true });
    });
  }

  return {
    requests: {
      async "session.r2"(fr, ctx) {
        const s = need(fr.callsign);
        const cs = s.info.callsign;
        if (fr.on === true) {
          s.store<Mark>().set({ r2: true });
          // новая сессия до первого хода: снимать нечего, первая точка — на первом конце хода
          if (!capture.hasConversation(s)) return { point: null };
          const out = await capture.take(s, "save");
          if ("error" in out) throw refuse(out.error, `${cs}: первая точка не снята`);
          return { point: out.point };
        }
        const r = await host.request("points.delete", { sid: s.info.session_id, ...(ctx.from ? { by: ctx.from } : {}) });
        if (!r.ok) throw refuse(r.error, `${cs}: points.delete — пометка стоит`);
        s.store<Mark>().set(undefined);
        cadences.get(cs)?.dispose();
        cadences.delete(cs);
        capture.forget(cs);
        host.log({ ev: "r2_off", callsign: cs, why: `${cs}: пометка «в R2» снята, точки удалены из R2` });
        return { deleted: (r.result as { points?: number })?.points ?? 0 };
      },

      async "points.save"(fr) {
        const s = need(fr.callsign);
        const cs = s.info.callsign;
        if (!marked(s)) throw refuse("not_r2", `${cs}: нет пометки «в R2»`);
        if (fr.stop === true) {
          if (s.state === "waiting" && fr.interrupt !== true) throw refuse("waiting", `${cs}: ждёт ответа человека`);
          // дождаться конца хода; interrupt — ядро прервёт ход само в session.stop
          if (s.state === "busy" && fr.interrupt !== true) await new Promise<void>((done) => turnEnds.set(cs, [...(turnEnds.get(cs) ?? []), done]));
          capture.silent.add(cs);
          const stopped = await host.request("session.stop", { callsign: cs });
          if (!stopped.ok) {
            capture.silent.delete(cs);
            throw refuse(stopped.error, `${cs}: session.stop — ${stopped.error}`);
          }
        }
        const out = await capture.take(s, "save");
        capture.silent.delete(cs);
        if ("error" in out) throw refuse(out.error, `${cs}: точка не снята`);
        return out;
      },

      "points.raise": (fr, ctx) => raise(fr, ctx.from),
    },

    fields: {
      r2: (s) => (marked(s) ? (capture.failure(s.info.callsign) ?? {}) : undefined),
    },

    on: {
      state(s, st: SessionState) {
        const cs = s.info.callsign;
        if (st === "idle") {
          for (const done of turnEnds.get(cs) ?? []) done();
          turnEnds.delete(cs);
        }
        if (marked(s)) cadenceOf(s).onState(st);
      },
      open(s) {
        const cs = s.info.callsign;
        if (started.has(cs)) return;
        started.add(cs);
        // старт Host: точка каждой помеченной сессии — дописанное без связи и смена хозяина
        if (s.info.start !== "attach" && s.info.start !== "resume") return;
        if (host.roster() !== null) onRule(s, "start");
        else waitingLink.add(cs);
      },
      frame(f) {
        if (f.type !== "roster") return;
        for (const cs of waitingLink) {
          const s = host.session(cs);
          if (s) onRule(s, "start");
        }
        waitingLink.clear();
      },
      close(s) {
        const cs = s.info.callsign;
        cadences.get(cs)?.closed();
        if (!capture.silent.has(cs)) onRule(s);
      },
    },

    start(h) {
      host = h;
      stopping = false;
    },

    async stop() {
      // новых точек не начинать, начатые — довести до points.put
      stopping = true;
      for (const c of cadences.values()) c.dispose();
      cadences.clear();
      await capture.settled();
    },
  };
}
