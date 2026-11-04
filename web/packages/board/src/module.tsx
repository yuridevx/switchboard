// web-board — «Работа»: сессии всех машин по проектам в одном списке для колонки пульта и экрана телефона. Проект — логическая группа, папка — свойство сессии.
// Запись fleet.projects (область флота, формат — у records) задаёт состав проектов и порядок строк; порядок меняет только человек, состояние сессии видно по лампе.
// Настройки человека — у его почты (ключи web-board.*): свои фильтры, порядок фильтров, закреплённые сессии. Настройки устройства — в хранилище страницы: выбранный фильтр, свёрнутые проекты, вид.
// «Моё» — сессия, ввод или открытие которой пришли от моего адреса (имя~почта), её дочери и закреплённые; метка mine — одно место этого правила.
// Вид: список и ряд фильтров читают модель выборкой, строка — свою выборкой: на изменение одной сессии перерисовывается одна строка.
// Пока идёт перестановка, выборки держат прошлый ответ; её конец рисует ряд и список заново: жест менял их элементы напрямую.
// Здесь — только связка с ядром; состояние — store.ts и model.ts, вид — компоненты.
import type { App, AppModule } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import css from "./board.css";
import { BoardScreen } from "./BoardScreen.tsx";
import { createBoardStore } from "./store.ts";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createBoard(app: App): AppModule {
  const board = createBoardStore(app);
  return {
    state: board,
    on: { link: board.onLink, roster: board.onRoster, current: board.onCurrent },
    screens: {
      // вставка места «после открытия»: страница новой сессии возвращает номер проекта, не читая его
      "board.assign": {
        place: "open.after",
        label: "Проект",
        path: "assign",
        show: (x) => !!x.project,
        run: (x) => board.assign(x),
      },
      // кнопка карточки: закрепить чужую сессию в «Моём»; своей незачем
      "board.pin": {
        place: "card.menu",
        label: "Закрепить",
        path: "pin",
        show: (x) => board.canPin(x.callsign ?? ""),
        run: (x) => board.pin(x.from ?? ""),
      },
      "board.unpin": {
        place: "card.menu",
        label: "Закреплена",
        path: "unpin",
        show: (x) => board.pins().includes(x.callsign ?? ""),
        run: (x) => board.unpin(x.from ?? ""),
      },
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
      /** почему сессия моя; не моя — "" */
      mine: (callsign: string) => {
        const s = board.session(callsign);
        return s ? board.whyMine(s) : "";
      },
      /** машины сессий проекта по номеру */
      "project.machines": (project: string) => [...new Set(board.sessions().filter((s) => board.projectId(s.callsign) === project).map((s) => machineOf(s.callsign) ?? ""))].filter(Boolean),
      /** номер открытого или последнего проекта */
      "project.current": () => board.lastProject(),
      /** проект сессии: номер и имя; без проекта — null */
      "project.of": (callsign: string) => {
        const id = board.realProject(callsign);
        return id ? { id, name: board.projectName(id) } : null;
      },
    },
    store: ["flt", "collapsed", "view", "pins"],
    css,
    start: board.start,
    stop: board.stop,
  };
}
