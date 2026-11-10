// Чего странице не хватает в браузере: без этого она не работает, и человек должен узнать об этом словами, а не увидеть пустой экран.
export function browserLacks(w: { [k: string]: any } = globalThis as never): string[] {
  const lacks: string[] = [];
  if (typeof w.WebSocket !== "function") lacks.push("соединения WebSocket");
  if (typeof w.structuredClone !== "function" || typeof Array.prototype.at !== "function") lacks.push("нового JavaScript");
  if (!w.crypto?.subtle) lacks.push("криптографии (страница открыта не по https)");
  if (!w.CSS?.supports?.("selector(:has(*))")) lacks.push("селектора :has в стилях");
  return lacks;
}
