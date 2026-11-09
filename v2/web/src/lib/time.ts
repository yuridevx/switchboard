// Время и числа словами.
const two = (n: number) => String(n).padStart(2, "0");

export function hhmm(t: number | Date = new Date()) {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}
export const day = (t: number) => new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

/** Сколько прошло: коротко, для строки списка. */
export function ago(t: number, now = Date.now()) {
  const min = Math.round((now - t) / 60_000);
  if (min < 1) return "сейчас";
  if (min < 60) return `${min} мин`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} ч`;
  return day(t);
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
export const LIMIT_NAMES: Record<string, string> = { five_hour: "5 ч", seven_day: "неделя", seven_day_opus: "неделя opus", seven_day_sonnet: "неделя sonnet" };
export const num = (n: number) => n.toLocaleString("ru-RU");
export const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} млн` : n >= 1000 ? `${Math.round(n / 1000)} тыс` : String(n));
