// Панель вида списка: каждая единица информации — свой переключатель.
// Группа «Шапка» — экран card.view карточки в месте панели (только пульт): её настройки — у карточки.
import { Choices, useApp } from "@switchboard/web-ui";
import { useBoard } from "./store.ts";
import type { View } from "./rules.ts";

type Unit = [keyof View, string, string];

const UNITS: Array<[string, Unit[]]> = [
  ["Список", [["projects", "По проектам", "Группировать по проектам"], ["group", "По машинам", "Группы по машинам в проекте"], ["tree", "Дочерние", "Дочерние под родителем"], ["dense", "В одну строку", "В одну строку"]]],
  ["Строка", [["lamp", "Лампа", "Лампа состояния"], ["at", "Машина", "Машина"], ["owner", "Владелец", "Владелец чужой сессии"], ["pin", "Закрепление", "Значок закрепления"], ["inc", "Инцидент", "Инцидент"], ["badge", "«?» и число", "Значок вопроса и непрочитанного"], ["q", "Вопрос", "Текст вопроса"], ["unread", "Непрочитанное", "Текст непрочитанного"], ["fail", "Сбой", "Причина сбоя"], ["prof", "Профиль", "Профиль"], ["model", "Модель", "Модель"]]],
  ["Проект", [["pjlamps", "Лампы", "Лампы свёрнутого проекта"], ["grip", "Ручка", "Ручка перетаскивания"], ["add", "«+»", "Кнопка новой сессии"]]],
  ["Фильтры", [["fcount", "Число", "Число сессий в фильтре"]]],
];

export function ViewPanel({ onClose }: { onClose(): void }) {
  const app = useApp();
  const board = useBoard();
  const v = app.use(board.view);
  return (
    // data-hide-tabs: на телефоне панель встаёт блоком под список, вкладки ядра на это время убираются
    <div className="bd-vw" role="dialog" aria-label="Вид списка" data-hide-tabs="">
      <div className="vw-h">
        <b>Вид списка</b>
        <button
          className="vw-x"
          data-act="view-reset"
          onClick={() => {
            board.resetView();
            // настройки шапки — у карточки: её команда возвращает свои; вне широкого вида группы нет
            if (app.wide) app.run("card.head.reset");
          }}
        >
          Вернуть
        </button>
        {app.wide ? (
          <button className="vw-x" aria-label="Закрыть" onClick={onClose}>
            ✕
          </button>
        ) : (
          <button className="vw-x pri" onClick={onClose}>
            Готово
          </button>
        )}
      </div>
      <div className="vw-b">
        {UNITS.map(([title, items]) => (
          <Choices key={title} title={title}>
              {items.map(([k, label, full]) => (
                <button key={k} data-v={k} aria-label={full} aria-pressed={String(!!v[k]) as "true" | "false"} disabled={k === "group" && !v.projects} onClick={() => board.toggleView(k)}>
                  {label}
                </button>
              ))}
            </Choices>
        ))}
        {app.wide ? (
          <div>
            <app.Slot screen="card.view" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
