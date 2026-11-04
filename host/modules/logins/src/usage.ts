// Окна лимитов аккаунта: наблюдения из потока сессий и опрос коротким claude. Каждое окно — из самого свежего источника.
import { READ_MS, within } from "@switchboard/protocol";
import type { Host, Probe } from "@switchboard/host";
import { sec, type Book } from "./book.ts";

/** Предел опроса окон: на 2 с раньше предела чтения — часы страницы пошли раньше, ответ должен успеть к ней (замер: до 4,9 с). */
const POLL_MS = READ_MS - 2_000;
const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

type Reading = { utilization: number; resetsAt: number };
type UsageAnswer = {
  subscription_type?: string | null;
  rate_limits?: Record<string, { utilization: number | null; resets_at: string | null } | null> | null;
};

export function makeUsage(host: () => Host, book: Book) {
  let stopping = false;
  /** идущие опросы: стирание папки аккаунта и остановка закрывают их раньше */
  const running = new Map<Probe, string>();

  function observe(name: string, windows: Record<string, Reading>, src: string, at: number): void {
    book.edit(name, (a) => {
      if (!a) return a;
      const limits = { ...a.limits };
      for (const [window, r] of Object.entries(windows)) {
        const known = limits[window];
        if (!known || known.at <= at) limits[window] = { utilization: r.utilization, resetsAt: r.resetsAt, at, src };
      }
      return { ...a, limits };
    });
  }

  /** Спросить Claude. Не ответил за предел — процесс закрыт, прежние окна, причина в журнале. */
  async function poll(name: string): Promise<void> {
    if (stopping) return;
    const p = host().probe({ env: book.envOf(name) });
    running.set(p, name);
    try {
      const answer = (await within(p.sdk(USAGE, { skipBehaviors: true }), `не ответил за ${POLL_MS / 1000} с`, POLL_MS)) as UsageAnswer;
      const windows: Record<string, Reading> = {};
      for (const [window, v] of Object.entries(answer.rate_limits ?? {})) {
        if (typeof v?.utilization === "number") windows[window] = { utilization: v.utilization / 100, resetsAt: v.resets_at ? Math.floor(Date.parse(v.resets_at) / 1000) : 0 };
      }
      observe(name, windows, "poll", sec());
      if (answer.subscription_type) book.edit(name, (a) => a && { ...a, plan: answer.subscription_type as string });
    } catch (e) {
      host().log({ kind: "refuse", ev: "poll", account: name, why: `${name}: опрос лимитов — ${(e as Error).message}` });
    } finally {
      running.delete(p);
      p.close();
    }
  }

  return {
    observe,
    poll,
    /** Закрыть идущие опросы аккаунта. */
    cancel(name: string) {
      for (const [p, who] of running) if (who === name) p.close();
    },
    stop() {
      stopping = true;
      for (const p of running.keys()) p.close();
    },
  };
}

export type Usage = ReturnType<typeof makeUsage>;
