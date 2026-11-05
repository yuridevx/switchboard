// Снесено: экраны на месте, содержания нет, новое письмо — следующим коммитом.
import type { AppModule } from "@switchboard/web-core";
import css from "./points.css";

export function createPoints(): AppModule {
  return {
    screens: {
      points: { nav: "Точки", group: "Флот", label: "Точки", view: () => "снесено", head: () => ({ title: "Точки" }) },
      "session.points": { place: "card.tab", label: "Точки", show: () => false, view: () => "снесено" },
    },
    marks: { fire: () => [] },
    css,
  };
}
