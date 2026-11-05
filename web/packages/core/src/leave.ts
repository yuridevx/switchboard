// Уход с экрана и возвращение: начатые запросы доводятся до reply, модули дописывают своё, затем close(1000). Шаги идут строго по очереди.
import { withLimit } from "@switchboard/protocol";
import type { FleetLink } from "./fleet-link.ts";
import type { Modules } from "./modules.ts";
import type { Snapshot } from "./snapshot.ts";

/** Предел шага: не успел — жёсткий выход с причиной в журнале, очередь идёт дальше. */
export const STEP_MS = 30_000;
const late = (what: string) => () => console.warn(`switchboard: ${what} не успело за ${STEP_MS / 1000} с`);

export type Leave = ReturnType<typeof createLeave>;

export function createLeave({ modules, link, snap }: { modules: Modules; link: FleetLink; snap: Snapshot }) {
  let away = false;
  let queue: Promise<void> = Promise.resolve();

  /** Шаг очереди: страница остановлена или уже там — ничего. */
  function step(wantAway: boolean, run: () => Promise<void>): Promise<void> {
    queue = queue.then(async () => {
      if (away === wantAway || snap.get().full) return;
      away = wantAway;
      await run();
    });
    return queue;
  }

  return {
    hide: () =>
      step(true, async () => {
        const goodbye = async () => {
          await link.finishRequests();
          await modules.stopAll();
          await link.finishRequests();
        };
        await withLimit(goodbye(), STEP_MS, late("прощание модулей"));
        link.close();
      }),
    show: () =>
      step(false, async () => {
        await withLimit(modules.showAll(), STEP_MS, late("возвращение модулей"));
        link.connect();
      }),
    /** Страница скрыта при старте: связь откроет возвращение. */
    startAway() {
      away = true;
    },
  };
}
