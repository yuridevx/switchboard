// Подписи точек: время, размер, слова отказа, что будет с папкой.
import type { SessionRecord } from "@switchboard/web-core";
import { plural } from "@switchboard/web-ui";
import type { Check } from "./store.ts";

export const r2Of = (s: SessionRecord | undefined) => s?.r2 as { error?: string; at?: number } | undefined;
export const nameOf = (callsign: string) => callsign.split("@")[0];
export const mb = (b: number) => `${Math.round(b / 1048576)} МБ`;

/** Слова отказа host-points и points → строка на экране. */
export function say(w: string, cs = "", target = "", src = ""): string {
  const t: Record<string, string> = {
    waiting: `${cs || "Сессия"} ждёт ответа человека — после ответа или с «прервать»`,
    bad_dir: "Правки точки сюда не встанут — другой репозиторий; выберите другую папку или «оставить как есть»",
    bad_point: "Точка не открылась — причина в журнале машины",
    not_owner: "Сессию уже подняли на другой машине",
    open_failed: target ? `Не поднялась на ${target}${src && src !== target ? ` — снова идёт на ${src}` : ""}` : "Не поднялась",
    not_r2: "Сессия не в R2",
    running: "Сессия ещё идёт — сначала точка со стопом",
    name_taken: "Имя занято на этой машине",
    offline: "Машины нет на связи",
  };
  return t[w] ?? w;
}

/** Что будет с папкой на целевой машине — ответ points.raise с dryRun. */
export function folderText(c: Check, m: string): string {
  switch (c.folder) {
    case "same":
      return "тот же репозиторий, своих правок нет — правки точки применятся";
    case "dirty":
      return `тот же репозиторий, но в нём свои правки (${c.files ?? "?"} ${plural(c.files ?? 0, "файл", "файла", "файлов")}): правки точки НЕ применятся, ваши файлы останутся`;
    case "empty":
      return `нет на ${m} — будет клон репозитория и правки точки поверх`;
    case "shared":
      return `здесь же ${(c.sessions ?? []).join(", ")} — в этой папке будут ${(c.sessions?.length ?? 0) + 1} сессии`;
    case "nogit":
      return "в точке нет git — файлы останутся как есть";
    case "other":
      return "Другой репозиторий — выберите другую папку";
    default:
      return c.folder;
  }
}
