// Человеческие имена: запись fleet.labels одна на флот. Адрес в протоколе и журнале остаётся адресом.
export const FLEET_PREFIX = "fleet";
export const LABELS = "labels";

export type Labels = { sessions?: Record<string, string>; machines?: Record<string, string> };

/** Адрес машины начинается с @: её имя лежит под именем машины, имя сессии — под callsign. */
const slot = (to: string) => (to.startsWith("@") ? { bag: "machines" as const, key: to.slice(1) } : { bag: "sessions" as const, key: to });

export function labelOf(labels: Labels | undefined, to: string): string | undefined {
  const { bag, key } = slot(to);
  return labels?.[bag]?.[key];
}

/** Новая запись с именем адреса; пустой текст снимает имя. */
export function setLabel(labels: Labels | undefined, to: string, text: string): Labels {
  const { bag, key } = slot(to);
  const next = { sessions: { ...labels?.sessions }, machines: { ...labels?.machines } };
  const name = text.trim();
  if (name) next[bag][key] = name;
  else delete next[bag][key];
  return next;
}
