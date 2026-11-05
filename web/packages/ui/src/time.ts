// Время на экране: часы, день, сколько прошло, длительность.
const two = (n: number) => String(n).padStart(2, "0");

/** ЧЧ:ММ по местному времени. */
export function hhmm(t: number | Date = Date.now()): string {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** ЧЧ:ММ момента: секунды или миллисекунды эпохи. */
export const at = (t: number) => hhmm(t < 1e12 ? t * 1000 : t);

/** «3 нояб.» */
export const day = (t: number) => new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

/** Сколько прошло: «только что», «5 мин назад», «2 ч 5 мин назад»; с суток — день. */
export function ago(t: number): string {
  const minutes = Math.round((Date.now() - t) / 60000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} ч ${minutes % 60} мин назад` : day(t);
}

/** Полночь по местному времени daysBack дней назад — since журнала машины. */
export function midnight(daysBack = 0): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.toISOString();
}

/** «2 мин 14 с», «33 мин», «18 с» — длительность хода. */
export function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} с`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 ? `${minutes} мин ${total % 60} с` : `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} ч ${minutes % 60} мин` : `${hours} ч`;
}
