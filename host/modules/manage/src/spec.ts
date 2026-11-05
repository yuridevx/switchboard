// Выбор клиента для сессии: модель, усилие, флаги ответа. Проверка полей кадра и перевод флагов в settings.
import { refuse } from "@switchboard/host";
import type { Frame } from "@switchboard/host";

/** Нет поля — значение по умолчанию claude. */
export type Spec = { model?: string; effort?: string; fast?: boolean; style?: string; thinking?: boolean };

const EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
const filled = (v: unknown) => typeof v === "string" && !!v;
const flag = (v: unknown) => typeof v === "boolean";

const FIELDS: Array<[keyof Spec | "title", (v: unknown) => boolean]> = [
  ["model", filled],
  ["effort", (v) => typeof v === "string" && EFFORT.has(v)],
  ["fast", flag],
  ["style", filled],
  ["thinking", flag],
  ["title", filled],
];

/** Поля выбора из кадра; не того вида — bad_spec. Незнакомые поля пропускаются, заголовок проверяется, но в выбор не входит. */
export function specOf(f: Frame): Spec {
  const spec: Record<string, unknown> = {};
  for (const [k, ok] of FIELDS) {
    if (f[k] === undefined) continue;
    if (!ok(f[k])) throw refuse("bad_spec", `${f.type} ${String(f.callsign ?? f.name ?? "")}: ${k} = ${JSON.stringify(f[k])}`);
    if (k !== "title") spec[k] = f[k];
  }
  return spec as Spec;
}

/** Флаги ответа → ключ settings в applyFlagSettings и в query(). */
const SETTING = { effort: "effortLevel", fast: "fastMode", style: "outputStyle", thinking: "alwaysThinkingEnabled" } as const;

export const FLAGS = Object.keys(SETTING) as Array<keyof typeof SETTING>;

export function settingsOf(spec: Spec): Record<string, unknown> {
  return Object.fromEntries(FLAGS.filter((k) => spec[k] !== undefined).map((k) => [SETTING[k], spec[k]]));
}
