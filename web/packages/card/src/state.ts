// Стор карточки: что показывать на этом устройстве — сведения сбоку и шапка.
import { createStore, type App } from "@switchboard/web-ui";

export const DEFAULT_HEAD: Record<string, boolean> = { haddr: false, howner: true, hprof: true, hmodel: true };

export function createCardState(app: App) {
  const infoPart = () => app.store<boolean>("card.info");
  const headPart = () => app.store<Record<string, boolean>>("card.head");
  const s = createStore({ info: false, head: DEFAULT_HEAD }, app.changed);
  return {
    get: s.get,
    async load() {
      const [info, head] = await Promise.all([infoPart().get(), headPart().get()]);
      s.set((d) => {
        d.info = !!info;
        d.head = { ...DEFAULT_HEAD, ...head };
      });
    },
    setInfo(on: boolean) {
      s.set((d) => void (d.info = on));
      void infoPart().set(on);
    },
    setHead(next: Record<string, boolean>) {
      s.set((d) => void (d.head = next));
      void headPart().set(next);
    },
  };
}

export type CardState = ReturnType<typeof createCardState>;
