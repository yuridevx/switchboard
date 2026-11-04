// Мелочи вида, общие для модулей приложения: подписи состояний, модели и усилия, время, склонение.
import type { SessionRecord, Roster } from "@switchboard/relay";
import { nameOf, userOf } from "@switchboard/protocol";

/** Тон метки: цвет пилюли и точки строки. */
export type Tone = "ok" | "wait" | "bad" | "busy" | "";

/** Состояние сессии из roster → подпись, тон и лампа. Один словарь на все экраны; неизвестное — как есть, без лампы. */
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
  return STATES[String(state)] ?? { text: String(state ?? "—"), tone: "", dot: "" };
}
/** Лампа строки сессии: неизвестное состояние — как остановленная. */
export const lamp = (s: SessionRecord) => stateLabel(s.state).dot || "stop";

/** Живая сессия: процесс claude отвечает. */
export const LIVE = new Set(["idle", "busy", "waiting"]);
export const isLive = (state: unknown) => LIVE.has(String(state));

/** Модели, когда SDK машины не спросить. */
export const MODELS = ["opus", "sonnet", "haiku", "fable"];
/** Усилия и подписи. */
export const EFFORTS: Array<[string, string]> = [["low", "низкое"], ["medium", "среднее"], ["high", "высокое"], ["xhigh", "очень высокое"], ["max", "макс."]];
export const effortName = (e: unknown) => EFFORTS.find(([k]) => k === e)?.[1] ?? String(e ?? "");
/** Короткое имя профиля: team/profiles/ops → ops. */
export const profileName = (id: string) => id.split("/").at(-1) ?? id;
/** Номер профиля сессии: team/profiles/ops. */
export const profileIdOf = (s?: SessionRecord) => (s?.profile as { id?: string } | null | undefined)?.id;
/** Имя профиля сессии: ops. */
export const profileNameOf = (s?: SessionRecord) => {
  const id = profileIdOf(s);
  return id ? profileName(id) : undefined;
};

type Marks = { mark(name: string, ...args: string[]): unknown };
type Rostered = { roster(): Roster | null };
/** Подпись имени: человеческое имя или адрес. */
export type Shown = { text: string; human: boolean };

/** Запись сессии из roster. */
export const sessionOf = (app: Rostered, callsign: string) => app.roster()?.sessions.find((s) => s.callsign === callsign);
/** Имя сессии; модуля имён нет или он упал — то же, что без своего имени: имя из позывного. */
export const sessionLabel = (app: Marks, callsign: string) => (app.mark("label.session", callsign) as Shown | undefined) ?? { text: nameOf(callsign), human: false };
/** Имя машины; модуля имён нет или он упал — адрес. */
export const machineLabel = (app: Marks, machine: string) => (app.mark("label.machine", machine) as Shown | undefined) ?? { text: `@${machine}`, human: false };
/** Машины на связи, у которых в contract есть все эти запросы; без запросов — все. */
export const machinesWith = (app: Rostered, ...names: string[]) => (app.roster()?.machines ?? []).filter((m) => names.every((n) => m.contract?.[n] !== undefined)).map((m) => m.machine);
/** Ссылка Remote Control сессии. */
export const remoteOf = (s?: SessionRecord) => (typeof s?.remote === "string" ? s.remote : (s?.remote as { url?: string } | undefined)?.url);
/** Причина сбоя сессии: «часть: причина; …». */
export const failText = (s: SessionRecord) =>
  s.failed
    ? Object.entries(s.failed as Record<string, string>)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ")
    : "";

/** Мой адрес ~почта: среди клиентов roster — устройство с именем этого приложения. */
export function myAddress(app: { name: string; roster(): Roster | null }): string | null {
  const c = (app.roster()?.clients ?? []).find((x) => x.startsWith(`${app.name}~`));
  return c ? userOf(c) : null;
}

/** Имя папки сессии — последнее имя dir в нижнем регистре; домашняя папка — «~». Папка — свойство сессии, проект с ней не связан. */
export function folderOf(dir: unknown): string {
  const d = typeof dir === "string" && dir ? dir : "~";
  if (d === "~") return "~";
  return d.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!.toLowerCase();
}

/** Строка «opus · high · main» из записи сессии: модель, усилие, слот. */
export function sessionLine(s: SessionRecord | undefined, withEffort = false): string {
  if (!s) return "";
  const slot = s.slot as { name?: string } | null | undefined;
  return [s.model, withEffort && s.effort ? effortName(s.effort) : null, slot?.name].filter((x) => typeof x === "string" && x).join(" · ");
}

/** ЧЧ:ММ по местному времени. */
export function hhmm(t: number | Date = Date.now()): string {
  const d = typeof t === "number" ? new Date(t) : t;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** ЧЧ:ММ момента: секунды или миллисекунды эпохи. */
export const at = (t: number) => hhmm(t < 1e12 ? t * 1000 : t);
/** «3 нояб.» */
export const day = (t: number) => new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
/** Сколько прошло: «только что», «5 мин назад», «2 ч 5 мин назад»; с суток — день. */
export function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const hr = Math.floor(m / 60);
  return hr < 24 ? `${hr} ч ${m % 60} мин назад` : day(t);
}
/** Полночь по местному времени daysBack дней назад — since журнала машины. */
export function midnight(daysBack = 0): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.toISOString();
}

/** Порог окна лимита: доля в процентах → цвет полосы. */
export const LIMIT_WARN = 70;
export const LIMIT_BAD = 90;
/** Окна лимитов: подпись. */
export const LIMIT_NAMES: Record<string, string> = { five_hour: "5 ч", seven_day: "неделя", seven_day_opus: "неделя opus", seven_day_sonnet: "неделя sonnet" };

/** Слова пути до машины → строка на экране; machine — чья. Остальные слова — как есть: их переводит владелец. */
export function linkText(word: string, machine?: string | null): string {
  if (word === "offline") return `${machine || "Машина"} не на связи`;
  if (word === "disconnected") return "нет связи";
  if (word === "timeout") return "нет ответа";
  return word;
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
