// web-card — карточка сессии: шапка из roster, вкладки «Чат» (экран chat в месте карточки), вкладки места card.tab
// и «Сведения» (поля roster как прислали владельцы; остановить и поднять — если они есть в contract машины).
// Здесь — только связка с ядром: состояние — store.ts, узкий вид — NarrowCard.tsx, широкий (пульт) — WideCard.tsx.
import { useApp } from "@switchboard/web-ui";
import type { App, AppModule, ScreenProps } from "@switchboard/web-core";
import css from "./card.css";
import { HeadPanel } from "./HeadPanel.tsx";
import { NarrowCard } from "./NarrowCard.tsx";
import { createCardStore } from "./store.ts";
import { WideCard } from "./WideCard.tsx";

function CardScreen({ params }: ScreenProps) {
  const app = useApp();
  return app.wide ? <WideCard params={params} /> : <NarrowCard params={params} />;
}

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createCard(app: App): AppModule {
  const card = createCardStore(app);
  return {
    state: card,
    screens: {
      card: { label: "Карточка", view: CardScreen, head: card.screenHead },
      // группа «Шапка» в панели вида «Работы»: настройки шапки — у карточки
      "card.view": { label: "Шапка", path: "card-view", view: HeadPanel },
    },
    commands: { "card.head.reset": { run: card.resetHead } },
    // настройка могла измениться в другой вкладке: возвращение страницы читает её заново
    on: { show: card.start },
    css,
    store: ["card.info", "card.head"],
    start: card.start,
  };
}
