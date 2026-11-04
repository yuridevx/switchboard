// Вход и уход машины: relay шлёт только имя записи, текст ledger пишет по прежней записи этой машины.
export const LEFT = "machine.left";
export const BACK = "machine.back";

export const isPresence = (ev: string) => ev === LEFT || ev === BACK;

/** Текст записи: last — прежняя запись о входе или уходе машины. */
export function presenceText(ev: string, machine: string, last: { ev: string; t: number } | null, now: number): string {
  if (ev === LEFT) return `${machine} пропала${last?.ev === BACK ? ` · была на связи с ${clock(last.t)}` : ""}`;
  return last?.ev === LEFT ? `${machine} вернулась · не было ${span(now - last.t)}` : `${machine} на связи`;
}

/** Время UTC: «14:00». */
const clock = (t: number) => new Date(t).toISOString().slice(11, 16);

/** Длительность словами: «3 с», «42 мин», «2 ч 5 мин», «3 дн». */
function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.floor(hours / 24)} дн`;
  return minutes % 60 ? `${hours} ч ${minutes % 60} мин` : `${hours} ч`;
}
