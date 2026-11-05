// web-card — карточка сессии: шапка из roster, вкладки «Чат» (экран chat в месте карточки), вкладки места card.tab
// и «Сведения» (поля roster как прислали владельцы; остановить и поднять — если они есть в contract машины).
// Здесь — только связка с ядром: состояние — state.ts, узкий вид — narrow.tsx, широкий (пульт) — wide.tsx.
import type { App, AppModule, ScreenProps } from "@switchboard/web-core";
import { Chip, Choices, useApp } from "@switchboard/web-ui";
import css from "./card.css";
import { NarrowCard } from "./narrow.tsx";
import { createCardState, useCard, type HeadView } from "./state.ts";
import { WideCard } from "./wide.tsx";

function CardScreen({ params }: ScreenProps) {
  const app = useApp();
  return app.wide ? <WideCard params={params} /> : <NarrowCard params={params} />;
}

const HEAD_UNITS: Array<[keyof HeadView, string, string]> = [["haddr", "Адрес", "Адрес сессии"], ["howner", "Владелец", "Владелец в шапке"], ["hprof", "Профиль", "Профиль в шапке"], ["hmodel", "Модель", "Модель и усилие в шапке"]];

/** Группа «Шапка» в панели вида «Работы»: настройки шапки — у карточки. */
function HeadPanel() {
  const app = useApp();
  const card = useCard();
  const view = app.use(card.head);
  return (
    <Choices title="Шапка">
      {HEAD_UNITS.map(([k, label, full]) => (
        <Chip key={k} on={!!view[k]} data-v={k} aria-label={full} onClick={() => card.toggleHead(k)}>
          {label}
        </Chip>
      ))}
    </Choices>
  );
}

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createCard(app: App): AppModule {
  const card = createCardState(app);
  return {
    state: card,
    screens: {
      card: { label: "Карточка", view: CardScreen, head: card.screenHead },
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
