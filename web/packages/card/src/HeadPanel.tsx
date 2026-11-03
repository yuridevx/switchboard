// Группа «Шапка» в панели вида «Работы». params.reset — номер сброса панели: новый номер, не «0», возвращает встроенное.
import { useEffect } from "react";
import { useApp, type ScreenProps } from "@switchboard/web-core";
import { Choices } from "@switchboard/web-ui";
import { useCard } from "./context.ts";
import type { HeadView } from "./session.ts";

/** Единицы шапки в панели вида. */
const UNITS: Array<[keyof HeadView, string, string]> = [["haddr", "Адрес", "Адрес сессии"], ["howner", "Владелец", "Владелец в шапке"], ["hprof", "Профиль", "Профиль в шапке"], ["hmodel", "Модель", "Модель и усилие в шапке"]];

export function HeadPanel({ params }: ScreenProps) {
  const app = useApp();
  const card = useCard();
  const view = app.use(card.head);
  useEffect(() => {
    if (params.reset && params.reset !== "0") card.resetHead();
  }, [card, params.reset]);
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
