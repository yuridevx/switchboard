// Мелочи вида, общие для модулей приложения: подписи состояний, модели и усилия, время, склонение.
import type { SessionRecord, Roster } from "@switchboard/relay";
import { userOf } from "@switchboard/protocol";

/** Тон метки: цвет пилюли и точки строки. */
export type Tone = "ok" | "wait" | "bad" | "busy" | "";

/** Состояние сессии из roster → подпись и тон. */
export function stateLabel(state: unknown): { text: string; tone: Tone; dot: string } {
  switch (state) {
    case "busy":
      return { text: "работает", tone: "busy", dot: "busy" };
    case "waiting":
      return { text: "ждёт ответа", tone: "wait", dot: "wait" };
    case "idle":
      return { text: "простаивает", tone: "ok", dot: "idle" };
    case "starting":
      return { text: "поднимается", tone: "busy", dot: "busy" };
    case "stopping":
      return { text: "останавливается", tone: "", dot: "stop" };
    case "stopped":
      return { text: "остановлена", tone: "", dot: "stop" };
    case "failed":
      return { text: "сбой", tone: "bad", dot: "wait" };
    default:
      return { text: String(state ?? "—"), tone: "", dot: "" };
  }
}

/** Модели, когда SDK машины не спросить. */
export const MODELS = ["opus", "sonnet", "haiku", "fable"];
/** Усилия и подписи. */
export const EFFORTS: Array<[string, string]> = [["low", "низкое"], ["medium", "среднее"], ["high", "высокое"], ["xhigh", "очень высокое"], ["max", "макс."]];
export const effortName = (e: unknown) => EFFORTS.find(([k]) => k === e)?.[1] ?? String(e ?? "");
/** Короткое имя профиля: team/profiles/ops → ops. */
export const profileName = (id: string) => id.split("/").at(-1) ?? id;

/** Мой адрес ~почта: среди клиентов roster — устройство с именем этого приложения. */
export function myAddress(app: { name: string; roster(): Roster | null }): string | null {
  const c = (app.roster()?.clients ?? []).find((x) => x.startsWith(`${app.name}~`));
  return c ? userOf(c) : null;
}

/** Проект сессии — последнее имя папки dir в нижнем регистре; домашняя папка — «~». Одно правило на все экраны. */
export function projectOf(dir: unknown): string {
  const d = typeof dir === "string" && dir ? dir : "~";
  if (d === "~") return "~";
  return d.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!.toLowerCase();
}

/** Строка «opus · high · main» из записи сессии: модель, усилие, слот. */
export function sessionLine(s: SessionRecord | undefined, withEffort = false): string {
  if (!s) return "";
  const slot = s.slot as { name?: string } | null | undefined;
  return [s.model, withEffort ? s.effort : null, slot?.name].filter((x) => typeof x === "string" && x).join(" · ");
}

/** ЧЧ:ММ по местному времени. */
export function hhmm(t: number | Date = Date.now()): string {
  const d = typeof t === "number" ? new Date(t) : t;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** «2 мин 14 с», «33 мин», «18 с» — длительность хода. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} мин ${s % 60} с` : `${m} мин`;
  const hr = Math.floor(m / 60);
  return m % 60 ? `${hr} ч ${m % 60} мин` : `${hr} ч`;
}

/** Склонение: plural(4, "сессия", "сессии", "сессий") → «сессии». */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
