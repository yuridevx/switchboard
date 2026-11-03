// Вид списка — настройка устройства: раздел хранилища view, на сервер не уходит, у пульта и телефона свои значения.
// Каждая единица информации — свой переключатель.
// Группа «Шапка» — экран card.view карточки в месте панели (только пульт): её настройки — у карточки.
import { useState } from "react";
import type { App } from "@switchboard/web-core";
import { Choices } from "@switchboard/web-ui";

export const VIEW0 = { projects: true, group: false, tree: true, dense: false, lamp: true, at: true, owner: true, pin: true, inc: true, badge: true, q: true, unread: true, fail: true, prof: true, model: true, pjlamps: true, grip: true, add: true, fcount: true };
export type View = typeof VIEW0;
type Unit = [keyof View, string, string];

const UNITS: Array<[string, Unit[]]> = [
  ["Список", [["projects", "По проектам", "Группировать по проектам"], ["group", "По машинам", "Группы по машинам в проекте"], ["tree", "Дочерние", "Дочерние под родителем"], ["dense", "В одну строку", "В одну строку"]]],
  ["Строка", [["lamp", "Лампа", "Лампа состояния"], ["at", "Машина", "Машина"], ["owner", "Владелец", "Владелец чужой сессии"], ["pin", "Закрепление", "Значок закрепления"], ["inc", "Инцидент", "Инцидент"], ["badge", "«?» и число", "Значок вопроса и непрочитанного"], ["q", "Вопрос", "Текст вопроса"], ["unread", "Непрочитанное", "Текст непрочитанного"], ["fail", "Сбой", "Причина сбоя"], ["prof", "Профиль", "Профиль"], ["model", "Модель", "Модель"]]],
  ["Проект", [["pjlamps", "Лампы", "Лампы свёрнутого проекта"], ["grip", "Ручка", "Ручка перетаскивания"], ["add", "«+»", "Кнопка новой сессии"]]],
  ["Фильтры", [["fcount", "Число", "Число сессий в фильтре"]]],
];

/** Панель вида: get — значения сейчас, set — поменять, reset — вернуть встроенное, onClose — кнопка закрытия. */
export function ViewPanel({ app, get, set, reset, onClose }: { app: App; get(): View; set(k: keyof View, v: boolean): void; reset(): void; onClose(): void }) {
  const v = app.use(get);
  // номер сброса: новый номер — экран карточки начат заново и возвращает свои настройки
  const [resets, setResets] = useState(0);
  return (
    // data-hide-tabs: на телефоне панель встаёт блоком под список, вкладки ядра на это время убираются
    <div className="bd-vw" role="dialog" aria-label="Вид списка" data-hide-tabs="">
      <div className="vw-h">
        <b>Вид списка</b>
        <button
          className="vw-x"
          data-act="view-reset"
          onClick={() => {
            reset();
            setResets((n) => n + 1);
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
                <button key={k} data-v={k} aria-label={full} aria-pressed={String(!!v[k]) as "true" | "false"} disabled={k === "group" && !v.projects} onClick={() => set(k, !get()[k])}>
                  {label}
                </button>
              ))}
            </Choices>
        ))}
        {app.wide ? (
          <div>
            <app.Slot screen="card.view" params={{ reset: String(resets) }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
