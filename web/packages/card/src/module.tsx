// web-card — карточка сессии: шапка из roster, вкладки «Чат» (экран chat в месте карточки), вкладки места card.tab
// и «Сведения» (поля roster как прислали владельцы; остановить и поднять — если они есть в contract машины).
// Здесь — только связка с ядром: состояние — store.ts, узкий вид — NarrowCard.tsx, широкий (пульт) — WideCard.tsx.
import type { ComponentType } from "react";
import { useApp, type AppModule, type ScreenProps } from "@switchboard/web-core";
import css from "./card.css";
import { CardCtx } from "./context.ts";
import { HeadPanel } from "./HeadPanel.tsx";
import { NarrowCard } from "./NarrowCard.tsx";
import { createCardStore } from "./store.ts";
import { WideCard } from "./WideCard.tsx";

function CardScreen({ params }: ScreenProps) {
  const app = useApp();
  return app.wide ? <WideCard params={params} /> : <NarrowCard params={params} />;
}

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createCard(): AppModule {
  const card = createCardStore();
  const provided = (View: ComponentType<ScreenProps>) => (p: ScreenProps) => (
    <CardCtx.Provider value={card}>
      <View {...p} />
    </CardCtx.Provider>
  );
  return {
    screens: {
      card: { label: "Карточка", view: provided(CardScreen), head: card.screenHead },
      // группа «Шапка» в панели вида «Работы»: настройки шапки — у карточки
      "card.view": { label: "Шапка", path: "card-view", view: provided(HeadPanel) },
    },
    css,
    store: ["card.info", "card.head"],
    start: card.start,
  };
}
