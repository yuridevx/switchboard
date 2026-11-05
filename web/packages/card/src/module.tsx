// web-card — карточка сессии: узкий вид телефона и широкий вид пульта над одним стором.
import type { AppModule, ScreenProps } from "@switchboard/web-core";
import { effortName, folderOf, machineLabel, sessionLabel, sessionOf, stateLabel, useApp, type App } from "@switchboard/web-ui";
import { machineOf } from "@switchboard/protocol";
import css from "./card.css";
import { HeadUnits } from "./head.tsx";
import { NarrowCard } from "./narrow.tsx";
import { createCardState } from "./state.ts";
import { WideCard } from "./wide.tsx";

function CardScreen({ params }: ScreenProps) {
  const app = useApp();
  return app.wide ? <WideCard callsign={params.callsign} tab={params.tab} /> : <NarrowCard callsign={params.callsign} tab={params.tab} />;
}

export function createCard(app: App): AppModule {
  const card = createCardState(app);
  return {
    state: card,
    on: { show: card.load },
    screens: {
      card: {
        label: "Карточка",
        view: CardScreen,
        head({ callsign }) {
          const s = sessionOf(app, callsign);
          const name = sessionLabel(app, callsign);
          const head = { title: name.text, mono: !name.human };
          if (app.wide) return s ? { ...head, sub: [s.model, effortName(s.effort)].filter(Boolean).join(" · ") } : head;
          const at = machineLabel(app, machineOf(callsign) ?? "").text;
          return s ? { ...head, sub: `${at} · папка ${folderOf(s.dir)}`, dot: stateLabel(s.state).dot } : { ...head, sub: `${at} не на связи` };
        },
      },
      "card.view": { label: "Шапка", path: "card-view", view: HeadUnits },
    },
    commands: { "card.head.reset": { run: () => card.setHead({ haddr: false, howner: true, hprof: true, hmodel: true }) } },
    store: ["card.info", "card.head"],
    css,
    start: card.load,
  };
}
