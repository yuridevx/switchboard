// Пульт: широкий вид. Экраны сессии открываются справа от списка; с экрана не из списка — рядом с первым, с «Работой».
const LISTS = ["board", "inbox", "incidents"];

export const PULT = {
  wide: true,
  brand: "Пульт",
  sections: ["inbox", "board", "incidents", "accounts", "profiles", "journal", "points", "settings"],
  beside: { card: LISTS, chat: LISTS, ask: LISTS, open: LISTS },
};
