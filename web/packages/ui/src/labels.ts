// Слова интерфейса: состояния сессии, усилия и модели, пороги лимитов, слова пути до машины, склонение. Одна таблица на все экраны.
import type { SessionRecord } from "@switchboard/relay";

/** Тон метки: цвет пилюли и точки строки. */
export type Tone = "ok" | "wait" | "bad" | "busy" | "";

const STATES: Record<string, { text: string; tone: Tone; dot: string }> = {
  busy: { text: "работает", tone: "busy", dot: "busy" },
  waiting: { text: "ждёт вас", tone: "wait", dot: "wait" },
  idle: { text: "свободна", tone: "ok", dot: "idle" },
  starting: { text: "запускается", tone: "busy", dot: "busy" },
  stopping: { text: "останавливается", tone: "", dot: "stop" },
  stopped: { text: "остановлена", tone: "", dot: "stop" },
  failed: { text: "не запустилась", tone: "bad", dot: "bad" },
};

/** Состояние сессии → подпись, тон и лампа; неизвестное — как есть, без лампы. */
export const stateLabel = (state: unknown): { text: string; tone: Tone; dot: string } => STATES[String(state)] ?? { text: String(state ?? "—"), tone: "", dot: "" };
/** Лампа строки сессии: неизвестное состояние — как остановленная. */
export const lamp = (s: SessionRecord) => stateLabel(s.state).dot || "stop";

/** Живая сессия: процесс claude отвечает. */
export const LIVE = new Set(["idle", "busy", "waiting"]);
export const isLive = (state: unknown) => LIVE.has(String(state));

/** Модели, когда SDK машины не спросить. */
export const MODELS = ["opus", "sonnet", "haiku", "fable"];
export const EFFORTS: Array<[string, string]> = [["low", "низкое"], ["medium", "среднее"], ["high", "высокое"], ["xhigh", "очень высокое"], ["max", "макс."]];
export const effortName = (effort: unknown) => EFFORTS.find(([k]) => k === effort)?.[1] ?? String(effort ?? "");

/** Порог окна лимита: доля в процентах → цвет полосы. */
export const LIMIT_WARN = 70;
export const LIMIT_BAD = 90;
export const LIMIT_NAMES: Record<string, string> = { five_hour: "5 ч", seven_day: "неделя", seven_day_opus: "неделя opus", seven_day_sonnet: "неделя sonnet" };

/** Слова пути до машины → строка на экране; machine — чья. Остальные слова — как есть: их переводит владелец. */
export function linkText(word: string, machine?: string | null): string {
  if (word === "offline") return `${machine || "Машина"} не на связи`;
  if (word === "disconnected") return "нет связи";
  return word === "timeout" ? "нет ответа" : word;
}

/** Склонение: plural(4, "сессия", "сессии", "сессий") → «сессии». */
export function plural(n: number, one: string, few: string, many: string): string {
  const tens = Math.abs(n) % 100;
  const units = tens % 10;
  if (tens > 10 && tens < 20) return many;
  if (units === 1) return one;
  return units >= 2 && units <= 4 ? few : many;
}
