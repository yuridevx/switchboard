// Слова экрана точек: отказы, проверка папки, размеры.
import { plural } from "@switchboard/web-ui";

export const mb = (bytes = 0) => (bytes / 1_048_576).toLocaleString("ru-RU", { maximumFractionDigits: 1 });

export const points = (n: number) => `${n} ${plural(n, "точка", "точки", "точек")}`;

/** Слово отказа человеческими словами; name — как назвать сессию, target и from — куда и откуда поднимается. */
export function wordText(word: string, o: { name?: string; target?: string; from?: string } = {}): string {
  const texts: Record<string, string> = {
    waiting: `${o.name ?? "Сессия"} ждёт ответа человека — после ответа или с «прервать»`,
    bad_dir: "Правки точки сюда не встанут — другой репозиторий; выберите другую папку или «оставить как есть»",
    bad_point: "Точка не открылась — причина в журнале машины",
    not_owner: "Сессию уже подняли на другой машине",
    open_failed: o.from ? `Не поднялась на ${o.target} — снова идёт на ${o.from}` : "Не поднялась",
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

export type Probe = { folder: string; files?: number; sessions?: string[] };
export type Check = { key: string; text: string; tone?: "ok" | "wait" | "bad" };

const fileCount = (n?: number) => (n === undefined ? "? файлов" : `${n} ${plural(n, "файл", "файла", "файлов")}`);

/** Что будет с папкой на машине target: ответ пробы. */
export function folderCheck(p: Probe, target: string): Check {
  const texts: Record<string, string> = {
    same: "тот же репозиторий, своих правок нет — правки точки применятся",
    dirty: `тот же репозиторий, но в нём свои правки (${fileCount(p.files)}): правки точки НЕ применятся, ваши файлы останутся`,
    empty: `нет на ${target} — будет клон репозитория и правки точки поверх`,
    shared: `здесь же ${(p.sessions ?? []).join(", ")} — в этой папке будут ${(p.sessions?.length ?? 0) + 1} ${plural((p.sessions?.length ?? 0) + 1, "сессия", "сессии", "сессий")}`,
    nogit: "в точке нет git — файлы останутся как есть",
    other: "Другой репозиторий — выберите другую папку",
  };
  return { key: p.folder, text: texts[p.folder] ?? p.folder, tone: p.folder === "other" ? "bad" : p.folder === "dirty" ? "wait" : "ok" };
}
