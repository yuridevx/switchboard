// Снесено: экраны точек отвечают словом, пока не написаны заново.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./points.css";

export function createPoints(_app: App): AppModule {
  const Gone = () => <div>снесено</div>;
  return {
    screens: {
      points: { nav: "Точки", group: "Флот", label: "Точки", view: Gone, head: () => ({ title: "Точки" }) },
      "session.points": { place: "card.tab", label: "Точки", path: "session-points", show: () => true, view: Gone },
    },
    marks: { fire: () => [] },
    css,
  };
}
