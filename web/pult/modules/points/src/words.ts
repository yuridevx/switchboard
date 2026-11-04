// Слова экрана точек: отказы, что будет с папкой, размер.
import type { SessionRecord } from "@switchboard/web-core";
import { linkText, plural } from "@switchboard/web-ui";
import type { Check, CheckResult } from "./store.ts";

export { nameOf } from "@switchboard/protocol";
export const r2Of = (s: SessionRecord | undefined) => s?.r2 as { error?: string; at?: number } | undefined;
export const mb = (bytes: number) => `${Math.round(bytes / 1048576)} МБ`;

/** Слово отказа машины или реестра → строка на экране. who — сессия, target и source — куда и откуда поднимали. */
export function refusal(word: string, who = "", target = "", source = ""): string {
  const openFailed = !target ? "Не поднялась" : `Не поднялась на ${target}${source && source !== target ? ` — снова идёт на ${source}` : ""}`;
  const known: Record<string, string> = {
    waiting: `${who || "Сессия"} ждёт ответа человека — после ответа или с «прервать»`,
    bad_dir: "Правки точки сюда не встанут — другой репозиторий; выберите другую папку или «оставить как есть»",
    bad_point: "Точка не открылась — причина в журнале машины",
    not_owner: "Сессию уже подняли на другой машине",
    open_failed: openFailed,
    not_r2: "Сессия не в R2",
    running: "Сессия ещё идёт — сначала точка со стопом",
    name_taken: "Имя занято на этой машине",
    slot_required: "Выберите слот",
    no_slot: `Такого слота нет на ${target || "машине"}`,
    not_logged_in: "В слоте нет вошедшего аккаунта",
  };
  return known[word] ?? linkText(word);
}

/** Подъём возможен: проверка пришла, отказа нет, папка не чужая. */
export const canRaise = (c: CheckResult | null) => !!c && !("error" in c) && c.folder !== "other";

/** Ответ проверки подъёма → что будет с папкой на целевой машине. */
export function folderText(c: Check, machine: string): string {
  const files = c.files ?? 0;
  const sessions = c.sessions ?? [];
  const known: Record<string, string> = {
    same: "тот же репозиторий, своих правок нет — правки точки применятся",
    dirty: `тот же репозиторий, но в нём свои правки (${c.files ?? "?"} ${plural(files, "файл", "файла", "файлов")}): правки точки НЕ применятся, ваши файлы останутся`,
    empty: `нет на ${machine} — будет клон репозитория и правки точки поверх`,
    shared: `здесь же ${sessions.join(", ")} — в этой папке будут ${sessions.length + 1} сессии`,
    nogit: "в точке нет git — файлы останутся как есть",
    other: "Другой репозиторий — выберите другую папку",
  };
  return known[c.folder] ?? c.folder;
}
