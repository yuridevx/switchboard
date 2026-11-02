// Оболочка пульта: широкий вид, имя, порядок разделов и beside — карточка, новая сессия, чат и вопрос открываются
// справа от списка сессий. Модули оболочка не знает: они — в списке сборки.
import type { ShellOptions } from "../../shell.ts";

export const PULT: ShellOptions = {
  wide: true,
  brand: "Пульт",
  sections: ["board", "open", "points", "accounts", "machines", "journal"],
  beside: { card: "board", chat: "board", ask: "board", open: "board" },
};
