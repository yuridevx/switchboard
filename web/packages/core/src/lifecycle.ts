// Уход с экрана и возвращение: начатые запросы доводятся до reply, модули дописывают своё, затем close(1000). Шаги идут строго по очереди.
import type { Link } from "./link.ts";
import type { Registry } from "./registry.ts";
import type { CoreStore } from "./state.ts";

export type Lifecycle = ReturnType<typeof createLifecycle>;

export function createLifecycle(d: { registry: Registry; link: Link; state: CoreStore }) {
  const { registry, link, state } = d;
  let hidden = false;
  let life: Promise<void> = Promise.resolve();

  return {
    hide(): Promise<void> {
      life = life.then(async () => {
        if (hidden || state.get().stopped) return;
        hidden = true;
        await link.settle();
        await registry.stopAll();
        await link.settle();
        link.close();
      });
      return life;
    },
    show(): Promise<void> {
      life = life.then(async () => {
        if (!hidden || state.get().stopped) return;
        hidden = false;
        await registry.startAll();
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
