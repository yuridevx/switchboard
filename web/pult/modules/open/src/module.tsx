// pult-open — новая сессия как проводник. Сверху — имя: первое поле и пустое, само не подставляется. Ниже — машины и адрес: одно поле на путь, поиск и создание.
// Папка в адресе и есть место сессии. Список папок только подсказывает, что будет; решает машина при открытии: session.open с mkdir, запрос один, исхода два — сессия или отказ словом.
// Снизу — чипы «Профиль» и модель · усилие · слот, «Точки в R2» (выключены), задача — необязательно. После открытия зовёт вставки места open.after с новой сессией и параметрами,
// с которыми страницу открыли: так «Работа» получает обратно свой проект, а страница о проектах не знает. Своё — короткий список последних мест в настройках человека.
// Здесь — только связка с ядром; места — store.ts, форма — useOpenForm.ts, вид — компоненты.
import type { AppModule, ScreenProps } from "@switchboard/web-core";
import { OpenCtx } from "./context.ts";
import css from "./open.css";
import { OpenScreen } from "./OpenScreen.tsx";
import { createOpenStore } from "./store.ts";

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createOpen(): AppModule {
  const open = createOpenStore();
  return {
    on: { link: open.onLink },
    screens: {
      open: {
        label: "Новая сессия",
        view: (p: ScreenProps) => (
          <OpenCtx.Provider value={open}>
            <OpenScreen {...p} />
          </OpenCtx.Provider>
        ),
        head: () => ({ title: "Новая сессия" }),
      },
    },
    css,
    start: open.start,
    stop: open.stop,
  };
}
