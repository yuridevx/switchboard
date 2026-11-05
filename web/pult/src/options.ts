// Опции пульта: широкий вид, имя, порядок разделов; карточка, новая сессия, чат и вопрос открываются справа от списков.
import type { ShellOptions } from "../../shell.ts";

const LISTS = ["board", "inbox", "incidents"];

export const PULT: ShellOptions = {
  wide: true,
  brand: "Пульт",
  sections: ["inbox", "board", "incidents", "machines", "accounts", "profiles", "journal", "points", "settings"],
  beside: { card: LISTS, chat: LISTS, ask: LISTS, open: LISTS },
};
