// Снесено: экраны точек пульта показывают «снесено» до реализации.
import type { App, AppModule } from "@switchboard/web-core";

const Gone = () => <p>снесено</p>;

export function createPoints(_app: App): AppModule {
  return {
    marks: { fire: () => [] },
    screens: {
      points: { nav: "Точки", label: "Точки", view: Gone },
      "session.points": { place: "card.tab", label: "Точки", view: Gone },
    },
  };
}
