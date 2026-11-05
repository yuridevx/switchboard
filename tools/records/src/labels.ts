// Запись имён области флота: имя сессии по её адресу, имя машины по имени.
export const FLEET_PREFIX = "fleet";
export const LABELS = "labels";

export type Labels = { sessions?: Record<string, string>; machines?: Record<string, string> };

/** Адрес → где лежит имя: @машина — среди машин, остальное — среди сессий. */
const slot = (to: string) => (to.startsWith("@") ? (["machines", to.slice(1)] as const) : (["sessions", to] as const));

export function labelOf(labels: Labels | undefined, to: string): string | undefined {
  const [kind, key] = slot(to);
  return labels?.[kind]?.[key];
}

/** Поставить имя; пустой текст снимает его. */
export function setLabel(labels: Labels | undefined, to: string, text: string): Labels {
  const [kind, key] = slot(to);
  const { [key]: _old, ...names } = labels?.[kind] ?? {};
  const name = text.trim();
  return { ...labels, [kind]: name ? { ...names, [key]: name } : names };
}
