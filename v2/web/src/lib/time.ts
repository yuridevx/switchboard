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
const LIMIT_NAMES: Record<string, string> = { five_hour: "5 ч", seven_day: "неделя" };
/** Имя окна лимита: недельное окно модели — «неделя fable», «неделя opus»; незнакомое — как назвал Claude. */
export const limitName = (name: string) => LIMIT_NAMES[name] ?? (name.startsWith("seven_day_") ? "неделя " + name.slice(10).replaceAll("_", " ") : name.replaceAll("_", " "));
/** Когда сброс: сегодня — час, в ближайшую неделю — день недели и час, дальше — дата. */
export function resetWord(t: number, now = Date.now()) {
  const d = new Date(t);
  if (d.toDateString() === new Date(now).toDateString()) return hhmm(d);
  return t - now < 7 * 86_400_000 ? d.toLocaleDateString("ru-RU", { weekday: "short" }) + " " + hhmm(d) : day(t);
}
/** Сколько осталось до t: «через 40 мин», «через 3 ч», «через 2 дн». */
export function untilWord(t: number, now = Date.now()) {
  const min = Math.max(1, Math.round((t - now) / 60_000));
  return "через " + (min < 60 ? min + " мин" : min < 48 * 60 ? Math.round(min / 60) + " ч" : Math.round(min / 1440) + " дн");
}
export const num = (n: number) => n.toLocaleString("ru-RU");
export const kilo = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} млн` : n >= 1000 ? `${Math.round(n / 1000)} тыс` : String(n));

/** Число со словом в нужной форме — одна функция на всю страницу. */
export const count = (n: number, one: string, few: string, many: string) => `${n} ${plural(n, one, few, many)}`;
export const nPoints = (n: number) => count(n, "точка", "точки", "точек");
export const nTurns = (n: number) => count(n, "ход", "хода", "ходов");
export const nTools = (n: number) => count(n, "инструмент", "инструмента", "инструментов");
export const nActions = (n: number) => count(n, "действие", "действия", "действий");
export const nDays = (n: number) => count(n, "день", "дня", "дней");
export const nMachines = (n: number) => count(n, "машина", "машины", "машин");
export const nSessions = (n: number) => count(n, "сессия", "сессии", "сессий");

/** День словами для заголовка группы: «Сегодня», «Вчера», иначе «4 нояб.». */
export function dayWord(t: number, now = Date.now()) {
  const d0 = (x: number) => new Date(new Date(x).getFullYear(), new Date(x).getMonth(), new Date(x).getDate()).getTime();
  const days = Math.round((d0(now) - d0(t)) / 86_400_000);
  return days === 0 ? "Сегодня" : days === 1 ? "Вчера" : day(t);
}
/** Разложить по дням, свежие выше: [[день словами, строки], …]. Порядок строк внутри дня сохраняется. */
export function byDay<T>(list: T[], at: (x: T) => number, now = Date.now()): Array<[string, T[]]> {
  const out: Array<[string, T[]]> = [];
  for (const x of list) {
    const w = dayWord(at(x), now);
    const last = out.at(-1);
    if (last && last[0] === w) last[1].push(x);
    else out.push([w, [x]]);
  }
  return out;
}
export const nFiles = (n: number) => count(n, "файл", "файла", "файлов");
export const nCalls = (n: number) => count(n, "вызов", "вызова", "вызовов");
export const nDevices = (n: number) => count(n, "устройство", "устройства", "устройств");
export const nRules = (n: number) => count(n, "правило", "правила", "правил");
/** Байты словами. */
export const bytesWord = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1).replace(".", ",")} МБ` : n >= 1024 ? `${Math.round(n / 1024)} КБ` : `${n} Б`);
