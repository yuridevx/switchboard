// Группа «Шапка» в панели вида «Работы». Вернуть встроенное — команда card.view (app.open).
import { Choices, useApp, Chip } from "@switchboard/web-ui";
import { useCard } from "./hooks.ts";
import type { HeadView } from "./session.ts";

/** Единицы шапки в панели вида. */
const UNITS: Array<[keyof HeadView, string, string]> = [["haddr", "Адрес", "Адрес сессии"], ["howner", "Владелец", "Владелец в шапке"], ["hprof", "Профиль", "Профиль в шапке"], ["hmodel", "Модель", "Модель и усилие в шапке"]];

export function HeadPanel() {
  const app = useApp();
  const card = useCard();
  const view = app.use(card.head);
  return (
    <Choices title="Шапка">
      {UNITS.map(([k, label, full]) => (
        <Chip key={k} on={!!view[k]} data-v={k} aria-label={full} onClick={() => card.toggleHead(k)}>
          {label}
        </Chip>
      ))}
    </Choices>
  );
}
