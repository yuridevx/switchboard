// web-board — «Работа»: связка стора и экрана с ядром.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./board.css";
import { BoardScreen } from "./screen.tsx";
import { createBoardState } from "./state.ts";

export function createBoard(app: App): AppModule {
  const b = createBoardState(app);
  return {
    state: b,
    on: { roster: b.onRoster, link: b.onLink, current: b.onCurrent, show: b.start },
    screens: {
      board: {
        nav: "Работа",
        path: "sessions",
        view: BoardScreen,
        head: () => ({ title: "Работа", action: { label: "Новая сессия", text: "+", run: () => app.open("open") } }),
        find: (q) => b.find(q),
      },
    },
    commands: {
      "board.assign": { place: "open.after", run: (p) => void (p.project && b.assign(p.callsign, p.project)) },
      "board.pin": { place: "card.menu", label: "Закрепить", show: (p) => b.canPin(p.callsign), run: (p) => b.setPinned(p.callsign, true) },
      "board.unpin": { place: "card.menu", label: "Закреплена", show: (p) => b.isPinned(p.callsign), run: (p) => b.setPinned(p.callsign, false) },
    },
    marks: {
      mine: (callsign) => b.mine(callsign),
      "project.machines": (id) => b.projectMachines(id),
      "project.current": () => b.current(),
      "project.of": (callsign) => b.projectOf(callsign),
    },
    store: ["flt", "collapsed", "view"],
    css,
    start: b.start,
    stop: b.stop,
  };
}
