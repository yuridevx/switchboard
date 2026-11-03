// Человеческие имена сессий и машин: одна запись на флот. Адрес в протоколе и журнале остаётся адресом.
export const FLEET_PREFIX = "fleet";
/** Раздел записи имён; полный ключ — fleet.labels. */
export const LABELS = "labels";

export type Labels = { sessions?: Record<string, string>; machines?: Record<string, string> };

/** Имя сессии site@laptop или машины @laptop; имени нет — undefined. */
export function labelOf(labels: Labels | undefined, to: string): string | undefined {
  return to.startsWith("@") ? labels?.machines?.[to.slice(1)] : labels?.sessions?.[to];
}

/** Новая запись: имя поставлено; пустой текст снимает его. */
export function setLabel(labels: Labels | undefined, to: string, text: string): Labels {
  const sessions = { ...labels?.sessions };
  const machines = { ...labels?.machines };
  const [bag, key] = to.startsWith("@") ? [machines, to.slice(1)] : [sessions, to];
  const t = text.trim();
  if (t) bag[key] = t;
  else delete bag[key];
  return { sessions, machines };
}
