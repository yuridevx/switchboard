// web-board — «Работа»: сессии всех машин по проектам в одном списке для колонки пульта и экрана телефона. Проект — логическая группа, папка — свойство сессии.
// Запись fleet.projects (область флота, формат — у records) задаёт состав проектов и порядок строк; порядок меняет только человек, состояние сессии видно по лампе.
// Настройки человека — у его почты (web-board.filters, .row, .pins). Настройки устройства — в хранилище страницы: flt, collapsed, view.
// «Моё» — сессия, ввод или открытие которой пришли от моего адреса (имя~почта), её дочери и закреплённые; метка mine — одно место этого правила.
// Здесь — только связка с ядром; состояние — state.ts и model.ts, жесты — reorder/, вид — компоненты.
import type { App, AppModule } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import css from "./board.css";
import { BoardScreen } from "./screen.tsx";
import { createBoardState } from "./state.ts";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createBoard(app: App): AppModule {
  const board = createBoardState(app);
  return {
    state: board,
    // show — настройка могла измениться в другой вкладке: возвращение страницы читает её заново
    on: { link: board.onLink, roster: board.onRoster, current: board.onCurrent, show: board.start },
    commands: {
      // вставка места «после открытия»: страница новой сессии возвращает номер проекта, не читая его
      "board.assign": { place: "open.after", label: "Проект", show: (x) => !!x.project, run: (x) => board.assign(x) },
      // кнопка карточки: закрепить чужую сессию в «Моём»; своей незачем
      "board.pin": { place: "card.menu", label: "Закрепить", show: (x) => board.canPin(x.callsign ?? ""), run: (x) => board.pin(x.callsign ?? "") },
      "board.unpin": { place: "card.menu", label: "Закреплена", show: (x) => board.pins().includes(x.callsign ?? ""), run: (x) => board.unpin(x.callsign ?? "") },
    },
    screens: {
      board: {
        nav: "Работа",
        label: "Работа",
        path: "sessions",
        view: BoardScreen,
        head: () => ({ title: "Работа", action: { label: "Новая сессия", text: "+", run: board.openNew } }),
        find: board.find,
      },
    },
    marks: {
      mine: (callsign: string) => {
        const s = board.session(callsign);
        return s ? board.whyMine(s) : "";
      },
      "project.machines": (project: string) => [...new Set(board.sessions().filter((s) => board.projectId(s.callsign) === project).map((s) => machineOf(s.callsign) ?? ""))].filter(Boolean),
      "project.current": () => board.lastProject(),
      "project.of": (callsign: string) => {
        const id = board.realProject(callsign);
        return id ? { id, name: board.projectName(id) } : null;
      },
    },
    store: ["flt", "collapsed", "view"],
    css,
    start: board.start,
    stop: board.stop,
  };
}
