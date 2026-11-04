// Состояние карточки: выбор этого устройства — сведения сбоку и что показывать в шапке. Шапка экрана — из roster и этого выбора не зависит.
import type { App, Head, Params } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { createStore, effortName, folderOf, machineLabel, sessionLabel, sessionOf, stateLabel } from "@switchboard/web-ui";
import { HEAD0, type HeadView } from "./session.ts";

type State = {
  /** сведения сбоку в широкой карточке */
  info: boolean;
  /** что показывать в шапке карточки пульта */
  head: HeadView;
};

export type CardStore = ReturnType<typeof createCardStore>;

export function createCardStore(app: App) {
  const store = createStore<State>({ info: false, head: { ...HEAD0 } }, () => app.changed());

  function saveHead(head: HeadView) {
    store.set((s) => void (s.head = head));
    void app.store<HeadView>("card.head").set(head);
  }

  return {
    async start() {
      const info = (await app.store<boolean>("card.info").get()) === true;
      const head = { ...HEAD0, ...(await app.store<HeadView>("card.head").get()) };
      store.set((s) => {
        s.info = info;
        s.head = head;
      });
    },
    info: () => store.get().info,
    head: () => store.get().head,
    setInfo(v: boolean) {
      store.set((s) => void (s.info = v));
      void app.store<boolean>("card.info").set(v);
    },
    toggleHead: (k: keyof HeadView) => saveHead({ ...store.get().head, [k]: !store.get().head[k] }),
    resetHead: () => saveHead({ ...HEAD0 }),
    /** Шапка экрана: у каждого вида своя. */
    screenHead(params: Params): Head {
      const callsign = params.callsign ?? "";
      const s = sessionOf(app, callsign);
      const name = sessionLabel(app, callsign);
      if (app.wide) {
        if (!s) return { title: name.text, mono: !name.human };
        return { title: name.text, mono: !name.human, sub: [s.model, effortName(s.effort)].filter(Boolean).join(" · ") };
      }
      const host = machineLabel(app, machineOf(callsign) ?? "").text;
      if (!s) return { title: name.text, mono: !name.human, sub: `${host} не на связи` };
      // лампа без слов: состояние понятно по индикатору
      return { title: name.text, mono: !name.human, sub: `${host} · папка ${folderOf(s.dir)}`, dot: stateLabel(s.state).dot };
    },
  };
}
