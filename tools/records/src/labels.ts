// Запись fleet.labels: имена сессий по адресу и машин по имени.
export const FLEET_PREFIX = "fleet";
export const LABELS = "labels";

export type Labels = { sessions?: Record<string, string>; machines?: Record<string, string> };

/** Где в записи лежит имя адреса: @laptop — у машин, site@laptop — у сессий. */
const slotOf = (address: string): ["sessions" | "machines", string] => (address.startsWith("@") ? ["machines", address.slice(1)] : ["sessions", address]);

export function labelOf(labels: Labels | undefined, address: string): string | undefined {
  const [area, key] = slotOf(address);
  return labels?.[area]?.[key];
}

/** Имя ставится текстом без краевых пробелов; пустой текст имя снимает. */
export function setLabel(labels: Labels | undefined, address: string, name: string): Labels {
  const [area, key] = slotOf(address);
  const { [key]: _old, ...others } = labels?.[area] ?? {};
  const text = name.trim();
  return { sessions: { ...labels?.sessions }, machines: { ...labels?.machines }, [area]: text ? { ...others, [key]: text } : others };
}
