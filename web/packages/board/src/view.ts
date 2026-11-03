// Вид списка — настройка устройства: раздел хранилища view, на сервер не уходит, у пульта и телефона свои значения.
// Каждая единица информации — свой переключатель. Панель не перерисовывается целиком: прокрутка и фокус остаются на месте.
// Группа «Шапка» — экран card.view карточки в месте панели (только пульт): её настройки — у карточки.
import { h, type App } from "@switchboard/web-core";

export const VIEW0 = { projects: true, group: false, tree: true, dense: false, lamp: true, at: true, owner: true, pin: true, inc: true, badge: true, q: true, unread: true, fail: true, prof: true, model: true, pjlamps: true, pjcount: true, grip: true, add: true, fcount: true };
export type View = typeof VIEW0;
type Unit = [keyof View, string, string];

const UNITS: Array<[string, Unit[]]> = [
  ["Список", [["projects", "По проектам", "Группировать по проектам"], ["group", "По машинам", "Группы по машинам в проекте"], ["tree", "Дочерние", "Дочерние под родителем"], ["dense", "В одну строку", "В одну строку"]]],
  ["Строка", [["lamp", "Лампа", "Лампа состояния"], ["at", "Машина", "Машина"], ["owner", "Владелец", "Владелец чужой сессии"], ["pin", "Закрепление", "Значок закрепления"], ["inc", "Инцидент", "Инцидент"], ["badge", "«?» и число", "Значок вопроса и непрочитанного"], ["q", "Вопрос", "Текст вопроса"], ["unread", "Непрочитанное", "Текст непрочитанного"], ["fail", "Сбой", "Причина сбоя"], ["prof", "Профиль", "Профиль"], ["model", "Модель", "Модель"]]],
  ["Проект", [["pjlamps", "Лампы", "Лампы свёрнутого проекта"], ["pjcount", "Число", "Число сессий проекта"], ["grip", "Ручка", "Ручка перетаскивания"], ["add", "«+»", "Кнопка новой сессии"]]],
  ["Фильтры", [["fcount", "Число", "Число сессий в фильтре"]]],
];

export type ViewPanel = { el: HTMLElement; close(): void };

/** Панель вида: get — значения сейчас, set — поменять и перерисовать список, reset — вернуть встроенное, onClose — кнопка закрытия. */
export function viewPanel(app: App, o: { get(): View; set(k: keyof View, v: boolean): void; reset(): void; onClose(): void }): ViewPanel {
  const sync = () => {
    const v = o.get();
    for (const b of el.querySelectorAll<HTMLButtonElement>("[data-v]")) {
      const k = b.dataset.v as keyof View;
      b.setAttribute("aria-pressed", String(!!v[k]));
      b.disabled = k === "group" && !v.projects;
    }
  };
  const host = h("div");
  const el = h(
    "div",
    { class: "bd-vw", role: "dialog", "aria-label": "Вид списка" },
    h(
      "div",
      { class: "vw-h" },
      h("b", null, "Вид списка"),
      h("button", { class: "vw-x", "data-act": "view-reset", onclick: () => (o.reset(), sync(), host.firstElementChild?.dispatchEvent(new CustomEvent("sb-reset"))) }, "Вернуть"),
      app.wide ? h("button", { class: "vw-x", "aria-label": "Закрыть", onclick: o.onClose }, "✕") : h("button", { class: "vw-x pri", onclick: o.onClose }, "Готово"),
    ),
    h(
      "div",
      { class: "vw-b" },
      UNITS.map(([title, items]) =>
        h(
          "div",
          { class: "vw-g" },
          h("span", { class: "vw-t" }, title),
          h(
            "div",
            { class: "vw-c" },
            items.map(([k, label, full]) => h("button", { "data-v": k, "aria-label": full, onclick: () => (o.set(k, !o.get()[k]), sync()) }, label)),
          ),
        ),
      ),
      app.wide ? host : null,
    ),
  );
  sync();
  const card = app.wide ? app.open("card.view", {}, host) : undefined;
  return {
    el,
    close() {
      card?.close?.();
      el.remove();
    },
  };
}
