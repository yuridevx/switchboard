// pult-open — новая сессия как проводник. Сверху — имя: первое поле и пустое, само не подставляется. Ниже — машины и адрес: одно поле на путь, поиск и создание.
// Папка в адресе и есть место сессии. Список папок только подсказывает, что будет; решает машина при открытии: session.open с mkdir, запрос один, исхода два — сессия или отказ словом.
// Снизу — чипы «Профиль» и модель · усилие · слот, «Точки в R2» (выключены), задача — необязательно. После открытия зовёт вставки места open.after с новой сессией и параметрами,
// с которыми страницу открыли: так «Работа» получает обратно свой проект, а страница о проектах не знает. Своё — короткий список последних мест в настройках человека.
// Здесь — только связка с ядром; места — store.ts, форма — useOpenForm.ts, вид — компоненты.
import type { App, AppModule } from "@switchboard/web-core";
import css from "./open.css";
import { OpenScreen } from "./OpenScreen.tsx";
import { createOpenStore } from "./store.ts";

/** Функция модуля: ядро зовёт её один раз со своим app; память — на этот запуск. */
export function createOpen(app: App): AppModule {
  const open = createOpenStore(app);
  return {
    state: open,
    on: { link: open.onLink },
    screens: {
      open: {
        label: "Новая сессия",
        view: OpenScreen,
        head: () => ({ title: "Новая сессия" }),
      },
    },
    css,
    stop: open.stop,
  };
}
