// Список сборки build.json рядом со страницей: одно чтение на оболочку и обработчик пушей.
import { withLimit } from "@switchboard/protocol";

/** Предел чтения списка сборки и загрузки ядра страницы. */
export const LIST_MS = 30_000;

/** Прочитать список сборки; не успел за предел — отказ late. */
export const readList = <T>(late: () => never): Promise<T> => withLimit(fetch("./build.json", { cache: "no-store" }).then((r) => r.json() as Promise<T>), LIST_MS, late);
