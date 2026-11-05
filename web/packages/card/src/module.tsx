// Модуль карточки: экран сессии, группа «Шапка» для панели вида, настройки шапки на устройстве.
import type { AppPart, Params } from "@switchboard/web-core";
import { Chip, Choices, createStore, folderOf, lamp, linkText, machineLabel, sessionLabel, sessionOf, useApp, useModule, type Store } from "@switchboard/web-ui";
import { machineOf } from "@switchboard/protocol";
import { NarrowCard } from "./narrow.tsx";
import { WideCard } from "./wide.tsx";
import css from "./card.css";

export const HEAD = { haddr: false, howner: true, hprof: true, hmodel: true };
export type HeadView = typeof HEAD;
export type Device = { head: HeadView; info: boolean };
export type CardState = {
  device: Store<Device>;
  setHead(head: HeadView): void;
  setInfo(on: boolean): void;
};

const UNITS: Array<[keyof HeadView, string, string]> = [["haddr", "Адрес", "Адрес сессии"], ["howner", "Владелец", "Владелец в шапке"], ["hprof", "Профиль", "Профиль в шапке"], ["hmodel", "Модель", "Модель и усилие в шапке"]];

function HeadGroup() {
  const app = useApp();
  const s = useModule<CardState>();
  const head = app.use(() => s.device.get().head);
  return (
    <div data-v-head="1">
      <Choices title="Шапка">
        {UNITS.map(([key, label, full]) => (
          <Chip key={key} data-v={key} aria-label={full} on={head[key]} onClick={() => s.setHead({ ...head, [key]: !head[key] })}>
            {label}
          </Chip>
        ))}
      </Choices>
    </div>
  );
}

export const createCard = ((app) => {
  const device = createStore<Device>({ head: HEAD, info: false }, () => app.changed());
  const setHead = (head: HeadView) => {
    device.set((d) => void (d.head = head));
    void app.store("card.head").set(head);
  };
  async function load() {
    const [head, info] = await Promise.all([app.store<Partial<HeadView>>("card.head").get(), app.store<boolean>("card.info").get()]);
    device.set((d) => {
      d.head = { ...HEAD, ...head };
      d.info = !!info;
    });
  }
  const state: CardState = {
    device,
    setHead,
    setInfo(on) {
      device.set((d) => void (d.info = on));
      void app.store("card.info").set(on);
    },
  };
  /** Шапка узкого вида: имя, машина и папка; лампа — состояние. */
  function head({ callsign }: Params) {
    const s = sessionOf(app, callsign);
    const name = sessionLabel(app, callsign);
    const at = machineLabel(app, machineOf(callsign)!).text;
    return { title: name.text, mono: !name.human, sub: s ? `${at} · папка ${folderOf(s.dir)}` : linkText("offline", at), ...(s ? { dot: lamp(s) } : {}) };
  }
  return {
    css,
    state,
    store: ["card.head", "card.info"],
    start: load,
    on: { show: load },
    screens: {
      card: { label: "Сессия", head, view: (p) => (app.wide ? <WideCard {...p} /> : <NarrowCard {...p} />) },
      "card.view": { view: HeadGroup },
    },
    commands: { "card.head.reset": { run: () => setHead(HEAD) } },
  };
}) satisfies AppPart["module"];
