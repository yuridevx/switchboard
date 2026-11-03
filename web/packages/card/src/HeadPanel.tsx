// Группа «Шапка» в панели вида «Работы». Вернуть встроенное — команда card.view (app.open).
import { useApp } from "@switchboard/web-core";
import { Choices } from "@switchboard/web-ui";
import { useCard } from "./context.ts";
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
        <button key={k} data-v={k} aria-label={full} aria-pressed={String(view[k]) as "true" | "false"} onClick={() => card.toggleHead(k)}>
          {label}
        </button>
      ))}
    </Choices>
  );
}
