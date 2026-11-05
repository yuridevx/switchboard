// Время на экране.
const two = (n: number) => String(n).padStart(2, "0");

/** ЧЧ:ММ по местному времени. */
export function hhmm(t: number | Date = new Date()): string {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** ЧЧ:ММ момента: секунды или миллисекунды эпохи. */
export const at = (t: number): string => hhmm(t < 1e11 ? t * 1000 : t);

/** «3 нояб.» */
export const day = (t: number): string => new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

/** Сколько прошло: «только что», «5 мин назад», «2 ч 5 мин назад»; с суток — день. */
export function ago(t: number): string {
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} ч ${min % 60} мин назад`;
  return day(t);
}

/** Полночь по местному времени daysBack дней назад — since журнала машины. */
export function midnight(daysBack = 0): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).toISOString();
}

/** «2 мин 14 с», «33 мин», «18 с» — длительность хода. */
export function duration(time: number): string {
  const s = Math.round(time / 1000);
  if (s < 60) return `${s} с`;
  const min = Math.floor(s / 60);
  if (min >= 60) return min % 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${Math.floor(min / 60)} ч`;
  return s % 60 ? `${min} мин ${s % 60} с` : `${min} мин`;
}
