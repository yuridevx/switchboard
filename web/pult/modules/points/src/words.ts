// Слова экранов точек: отказы и проверка папки подъёма. Числа — через plural.
import { plural } from "@switchboard/web-ui";

/** Отказ словами: who — кто ждёт человека, target — куда поднимают, from — откуда. */
export function refused(word: string, o: { who?: string; target?: string; from?: string } = {}): string {
  const texts: Record<string, string> = {
    waiting: `${o.who ?? "Сессия"} ждёт ответа человека — после ответа или с «прервать»`,
    bad_dir: "Правки точки сюда не встанут — другой репозиторий; выберите другую папку или «оставить как есть»",
    bad_point: "Точка не открылась — причина в журнале машины",
    not_owner: "Сессию уже подняли на другой машине",
    open_failed: `Не поднялась на ${o.target}${o.from ? ` — снова идёт на ${o.from}` : ""}`,
    not_r2: "Сессия не в R2",
    running: "Сессия ещё идёт — сначала точка со стопом",
    name_taken: "Имя занято на этой машине",
    slot_required: "Выберите слот",
    no_slot: `Такого слота нет на ${o.target}`,
    not_logged_in: "В слоте нет вошедшего аккаунта",
    offline: "Машина не на связи",
  };
  return texts[word] ?? word;
}

export type Probe = { folder?: string; files?: number; sessions?: string[] };
export type Check = { key: string; text: string; tone: "ok" | "wait" | "bad" };

/** Что будет с папкой подъёма. */
export function checkOf(p: Probe, target: string): Check {
  const { folder = "", files, sessions = [] } = p;
  const dirty = files === undefined ? "? файлов" : `${files} ${plural(files, "файл", "файла", "файлов")}`;
  const lines: Record<string, Omit<Check, "key">> = {
    same: { text: "тот же репозиторий, своих правок нет — правки точки применятся", tone: "ok" },
    dirty: { text: `тот же репозиторий, но в нём свои правки (${dirty}): правки точки НЕ применятся, ваши файлы останутся`, tone: "wait" },
    empty: { text: `нет на ${target} — будет клон репозитория и правки точки поверх`, tone: "ok" },
    shared: { text: `здесь же ${sessions.join(", ")} — в этой папке будут ${sessions.length + 1} сессии`, tone: "ok" },
    nogit: { text: "в точке нет git — файлы останутся как есть", tone: "ok" },
    other: { text: "Другой репозиторий — выберите другую папку", tone: "bad" },
  };
  return { key: folder, ...(lines[folder] ?? { text: folder, tone: "ok" }) };
}

/** Проверка, которой не поднять: другой репозиторий или отказ. */
export const blocked = (c: Check | null) => !c || c.tone === "bad";

export const megabytes = (bytes: number) => `${Math.round(bytes / 1_048_576)} МБ`;
export const countOf = (n: number, one: string, few: string, many: string) => `${n} ${plural(n, one, few, many)}`;
