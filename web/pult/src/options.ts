// Пульт — широкий вид: разделы колонкой, второй экран справа от списка.
const LISTS = ["inbox", "board", "incidents"];

export const PULT = {
  wide: true,
  brand: "Пульт",
  sections: ["inbox", "board", "incidents", "machines", "accounts", "profiles", "journal", "points", "settings"],
  beside: { card: LISTS, chat: LISTS, ask: LISTS, open: LISTS },
};
