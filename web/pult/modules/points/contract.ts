// Контракт pult-points — «Сессии»: архив сессий флота (свой пакет пульта, раздел группы «Флот»).
// Экран points (#points) — список архива (points.list с периодом и порядком; проект — метка project.of доски, «идёт» — roster), поиск по
// переписке (points.list с q; хранилище без поиска — search: false, поля нет), «пожар» — машина хозяина не в roster, перенос её сессий
// по одной; с sid — страница сессии: шапка, разговор на выбранной точке — экран chat.view web-chat (points.history), линия точек и ветки
// (points.list с sid), у точки — подъём, копия, откат (points.save → points.raise), «На свой компьютер» — команда switchboard pull, вызовы модели
// с переходом к проверке правил (settings, tab rules, call sid/uuid); без живой копии — подъём и удаление (points.delete).
// session.points — та же страница во вкладке «Архив» карточки (место card.tab) и переключатель «Хранить в архиве» (session.archive).
// Метка fire — машины с сессиями в архиве, которых нет в roster; каталог читается один раз при первом roster.
import type { AppPart, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createPoints } from "./src/module.tsx";

declare module "@switchboard/web-ui" {
  interface Marks {
    fire(): string[];
  }
}

export { createPoints };
export const manifest: Manifest = json;
export default createPoints satisfies AppPart["module"];
