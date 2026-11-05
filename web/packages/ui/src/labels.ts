// Слова страницы: одно правило на все экраны.
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
const known = (state: unknown) => (typeof state === "string" && Object.hasOwn(STATES, state) ? STATES[state] : undefined);

/** Состояние сессии → подпись, тон и лампа; неизвестное — как есть, без лампы. */
export const stateLabel = (state: unknown): { text: string; tone: Tone; dot: string } => known(state) ?? { text: state === undefined || state === null ? "—" : String(state), tone: "", dot: "" };

/** Лампа строки сессии: неизвестное состояние — как остановленная. */
export const lamp = (s: SessionRecord): string => known(s.state)?.dot ?? "stop";

/** Живая сессия: процесс claude отвечает. */
export const LIVE = new Set(["idle", "busy", "waiting"]);
export const isLive = (state: unknown): boolean => LIVE.has(state as string);

/** Модели, когда SDK машины не спросить. */
export const MODELS = ["opus", "sonnet", "haiku", "fable"];
export const EFFORTS: Array<[string, string]> = [["low", "низкое"], ["medium", "среднее"], ["high", "высокое"], ["xhigh", "очень высокое"], ["max", "макс."]];
export const effortName = (effort: unknown): string => EFFORTS.find(([e]) => e === effort)?.[1] ?? (effort ? String(effort) : "");

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
  const tens = n % 100;
  const units = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  return units >= 2 && units <= 4 ? few : many;
}

export const PERM_MODES: Array<[string, string]> = [["bypassPermissions", "Без вопросов"], ["default", "Спрашивать"], ["acceptEdits", "Правки сами"], ["plan", "План"], ["auto", "Авто"]];
export const permModeName = (mode: string): string | undefined => PERM_MODES.find(([m]) => m === mode)?.[1];
/** Откуда правило и куда ляжет. */
export const PERM_PLACES: Record<string, string> = { localSettings: "локально", projectSettings: "проект", userSettings: "пользователь", policySettings: "организация", flagSettings: "запуск", cliArg: "запуск", command: "команда", session: "сессия" };
