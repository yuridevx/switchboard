// Модуль «Работа»: экран, команды закрепления и постановки в проект, метки.
import { ListChecks } from "lucide-react";
import type { AppPart } from "@switchboard/web-core";
import { BoardScreen } from "./list.tsx";
import { createState } from "./state.ts";
import css from "./board.css";

export const createBoard = ((app) => {
  const s = createState(app);
  const pinned = (callsign: string) => s.pins().includes(callsign);
  return {
    css,
    state: s,
    store: ["flt", "collapsed", "view", "picked"],
    start: s.load,
    stop: s.stop,
    on: { link: s.link, current: s.current, show: s.load },
    marks: s.marks as Record<string, (...args: string[]) => unknown>,
    screens: {
      board: {
        nav: "Работа", icon: ListChecks,
        path: "sessions",
        view: BoardScreen,
        find: s.find,
        head: () => ({ title: "Работа", action: { label: "Новая сессия", text: "+", run: () => app.open("open") } }),
      },
    },
    commands: {
      "board.pin": { place: "card.menu", label: "Закрепить", show: (p) => s.sessions().some((x) => x.callsign === p.callsign) && !s.mine(p.callsign), run: (p) => s.setPin(p.callsign, true) },
      "board.unpin": { place: "card.menu", label: "Закреплена", show: (p) => pinned(p.callsign), run: (p) => s.setPin(p.callsign, false) },
      "board.assign": { place: "open.after", show: (p) => !!p.project, run: (p) => s.assign(p.callsign, p.project) },
    },
  };
}) satisfies AppPart["module"];
