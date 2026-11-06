// Модуль карточки: экран сессии, группа «Шапка» для панели вида, настройки шапки и выбор стороны пары на устройстве.
import type { AppPart, Params } from "@switchboard/web-core";
import { Chip, Choices, createStore, effortName, folderOf, lamp, linkText, machineLabel, sessionLabel, sessionOf, useApp, useModule, type Store } from "@switchboard/web-ui";
import { machineOf } from "@switchboard/protocol";
import { NarrowCard } from "./narrow.tsx";
import { WideCard } from "./wide.tsx";
import css from "./card.css";

export const HEAD = { hat: true, howner: true, hprof: true, hmodel: true, hacc: true };
export type HeadView = typeof HEAD;
/** Что видно у пары: одна сторона или обе. */
export type Shown = "lead" | "wing" | "both";
export type Device = { head: HeadView; shown: Shown };
export type CardState = {
  device: Store<Device>;
  setHead(head: HeadView): void;
  /** Участник — только он; он же ещё раз — обе стороны; на телефоне одна сторона всегда. */
  pick(v: Shown, wide: boolean): void;
};

const UNITS: Array<[keyof HeadView, string, string]> = [["hat", "Машина", "Машина в шапке"], ["howner", "Владелец", "Владелец в шапке"], ["hprof", "Профиль", "Профиль в шапке"], ["hmodel", "Модель", "Модель и усилие в шапке"], ["hacc", "Аккаунт", "Аккаунт и лимит в шапке"]];

function HeadGroup() {
  const app = useApp();
  const s = useModule<CardState>();
  const head = app.use(() => s.device.get().head);
  return (
    <Choices title="Шапка">
      {UNITS.map(([key, label, full]) => (
        <Chip key={key} data-v={key} aria-label={full} on={head[key]} onClick={() => s.setHead({ ...head, [key]: !head[key] })}>
          {label}
        </Chip>
      ))}
    </Choices>
  );
}

export const createCard = ((app) => {
  const device = createStore<Device>({ head: HEAD, shown: "both" }, () => app.changed());
  const setHead = (head: HeadView) => {
    device.set((d) => void (d.head = head));
    void app.store("card.head").set(head);
  };
  const pick = (v: Shown, wide: boolean) => {
    const next = wide && v === device.get().shown ? "both" : v;
    device.set((d) => void (d.shown = next));
    void app.store("card.pair").set(next);
  };
  async function load() {
    const [head, shown] = await Promise.all([app.store<Partial<HeadView>>("card.head").get(), app.store<Shown>("card.pair").get()]);
    device.set((d) => {
      d.head = { ...HEAD, ...head };
      d.shown = shown ?? "both";
    });
  }
  const state: CardState = { device, setHead, pick };
  /** Шапка: имя; на телефоне — машина и папка, лампа — состояние; на пульте — модель и усилие. */
  function head({ callsign }: Params) {
    const s = sessionOf(app, callsign);
    const name = sessionLabel(app, callsign);
    const at = machineLabel(app, machineOf(callsign)!).text;
    const title = { title: name.text, mono: !name.human };
    if (!s) return { ...title, sub: linkText("offline", at) };
    return app.wide ? { ...title, sub: [s.model, effortName(s.effort)].filter(Boolean).join(" · ") } : { ...title, sub: `${at} · папка ${folderOf(s.dir)}`, dot: lamp(s) };
  }
  return {
    css,
    state,
    store: ["card.head", "card.pair"],
    start: load,
    on: { show: load },
    screens: {
      card: { label: "Карточка", head, view: (p) => (app.wide ? <WideCard {...p} /> : <NarrowCard {...p} />) },
      "card.view": { label: "Шапка", path: "card-view", view: HeadGroup },
    },
    commands: { "card.head.reset": { run: () => setHead(HEAD) } },
  };
}) satisfies AppPart["module"];
