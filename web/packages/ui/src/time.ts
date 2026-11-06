// Время и числа словами.
const two = (n: number) => String(n).padStart(2, "0");

export function hhmm(t: number | Date = new Date()) {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Метка времени: секунды или мс. */
export const at = (t: number) => hhmm(t < 1e11 ? t * 1000 : t);
export const day = (t: number) => new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

/** Начало дня: сегодня или daysBack дней назад. */
export function midnight(daysBack = 0) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).toISOString();
}

export function ago(t: number) {
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  return min < 24 * 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин назад` : day(t);
}

export function duration(time: number) {
  const s = Math.round(time / 1000);
  const min = Math.floor(s / 60);
  if (!min) return `${s} с`;
  if (min >= 60) return min % 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${Math.floor(min / 60)} ч`;
  return s % 60 ? `${min} мин ${s % 60} с` : `${min} мин`;
}

export function plural(n: number, one: string, few: string, many: string) {
  const [units, tens] = [n % 10, n % 100];
  if (units === 1 && tens !== 11) return one;
  return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
}

/** Слот ждёт сброса лимита. */
export const slotWaitText = (name: string, wait: number) => `${name} · ждёт сброса ${at(wait)}`;
