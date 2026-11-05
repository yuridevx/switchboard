// Текст для модели: строка системного промпта и записи разговора строками.

/** Модель знает свой позывной (опыт 13) и как вести другие сессии. */
export const prompt = (me: string) =>
  `Ты во флоте как ${me}. Кто на связи — fleet.list; написать сессии или человеку — fleet.send. ` +
  `Открыть сессию с задачей — fleet.open: она твоя дочь, итог каждого её хода, начатого тобой, придёт сам тегом <fleet-message from="…">. ` +
  `Проект сессии — параметр project у fleet.open и fleet.update, имя в интерфейсе — fleet.label. Что делала сессия — fleet.history; модель, усилие, заголовок — fleet.update; закрыть — fleet.remove (без callsign — себя, после этого хода). ` +
  `Сообщения флота приходят во ввод тегом <fleet-message from="…">; вопрос другой сессии — тегом <fleet-question>, ответ на него — fleet.answer. ` +
  `Если тебя открыла другая сессия, итог твоего хода, начатого ею, уйдёт ей сам — отвечать ей отдельно не нужно.`;

type Block = { type?: string; text?: string; name?: string };
export type Entry = { type?: string; message?: { content?: string | Block[] } };

/** Ввод, ответы, вызванные инструменты; служебного нет. */
export function linesOf(messages: Entry[]): string {
  const out = messages
    .filter((m) => m.type === "user" || m.type === "assistant")
    .flatMap((m) => {
      const c = m.message?.content;
      const blocks: Block[] = typeof c === "string" ? [{ type: "text", text: c }] : (c ?? []);
      return blocks.flatMap((b) => (b.type === "text" && b.text ? [`${m.type}: ${b.text}`] : b.type === "tool_use" && b.name ? [`tool: ${b.name}`] : []));
    });
  return out.join("\n") || "записей нет";
}
