// Уход с экрана и возвращение: начатые запросы доводятся до reply, модули дописывают своё, затем close(1000). Шаги идут строго по очереди.
import { withLimit } from "@switchboard/protocol";
import type { Link } from "./link.ts";
import type { Registry } from "./registry.ts";
import type { CoreStore } from "./state.ts";

export type Lifecycle = ReturnType<typeof createLifecycle>;

/** Предел шага ухода и возвращения: не успел — жёсткий выход с причиной в журнале, очередь идёт дальше. */
export const LIFE_MS = 30_000;
const late = (what: string) => () => console.warn(`switchboard: ${what} не успело за ${LIFE_MS / 1000} с`);

export function createLifecycle(d: { registry: Registry; link: Link; state: CoreStore }) {
  const { registry, link, state } = d;
  let hidden = false;
  let life: Promise<void> = Promise.resolve();

  return {
    hide(): Promise<void> {
      life = life.then(async () => {
        if (hidden || state.get().full) return;
        hidden = true;
        const goodbye = async () => {
          await link.settle();
          await registry.stopAll();
          await link.settle();
        };
        await withLimit(goodbye(), LIFE_MS, late("прощание модулей"));
        link.close();
      });
      return life;
    },
    show(): Promise<void> {
      life = life.then(async () => {
        if (!hidden || state.get().full) return;
        hidden = false;
        await withLimit(registry.showAll(), LIFE_MS, late("возвращение модулей"));
        link.connect();
      });
      return life;
    },
    /** Страница скрыта при старте: связь откроет возвращение. */
    startHidden() {
      hidden = true;
    },
  };
}
