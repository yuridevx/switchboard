// Слова и словари: одно правило на все экраны.
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

export function stateLabel(state: unknown): { text: string; tone: Tone; dot: string } {
  if (typeof state === "string" && Object.hasOwn(STATES, state)) return STATES[state];
  return { text: state === undefined || state === null ? "—" : String(state), tone: "", dot: "" };
}

export const isLive = (state: unknown) => state === "idle" || state === "busy" || state === "waiting";

export const MODELS = ["opus", "sonnet", "haiku", "fable"];

export const EFFORTS: Array<[string, string]> = [
  ["low", "низкое"],
  ["medium", "среднее"],
  ["high", "высокое"],
  ["xhigh", "очень высокое"],
  ["max", "макс."],
];

export const effortName = (effort: unknown) => EFFORTS.find(([e]) => e === effort)?.[1] ?? (effort ? String(effort) : "");

export const PERM_MODES: Array<[string, string]> = [
  ["bypassPermissions", "Без вопросов"],
  ["default", "Спрашивать"],
  ["acceptEdits", "Правки сами"],
  ["plan", "План"],
  ["auto", "Авто"],
];

export const permModeName = (mode: string) => PERM_MODES.find(([m]) => m === mode)?.[1];
/** Режимы сессии: «Авто» — если модель умеет или он уже включён; модель не нашлась в списке SDK — запись по умолчанию. */
export function permModesOf(mode: string, model: string, models: ReadonlyArray<{ value: string; supportsAutoMode?: boolean }> | null | undefined) {
  const list = models ?? [];
  const found = list.find((m) => m.value !== "default" && model.includes(m.value)) ?? list.find((m) => m.value === "default");
  return PERM_MODES.filter(([value]) => value !== "auto" || found?.supportsAutoMode || mode === "auto");
}

export const PERM_PLACES: Record<string, string> = {
  localSettings: "локально",
  projectSettings: "проект",
  userSettings: "пользователь",
  policySettings: "организация",
  flagSettings: "запуск",
  cliArg: "запуск",
  command: "команда",
  session: "сессия",
};

export const LIMIT_NAMES: Record<string, string> = { five_hour: "5 ч", seven_day: "неделя", seven_day_opus: "неделя opus", seven_day_sonnet: "неделя sonnet" };
export const LIMIT_WARN = 70;
export const LIMIT_BAD = 90;

/** Переменная окружения, которой ключ флота задаёт модель вместо имени Claude. */
export const modelEnv = (model: string) => `ANTHROPIC_DEFAULT_${model.toUpperCase()}_MODEL`;

/** Отказ связи словами; слова владельца — как есть. */
export function linkText(word: string, machine?: string | null) {
  if (word === "offline") return `${machine || "Машина"} не на связи`;
  if (word === "disconnected") return "нет связи";
  return word === "timeout" ? "нет ответа" : word;
}
