// Список сборки лежит рядом со страницей и обработчиком пушей. Номер сборки меняется на месте: кэш браузера его не держит.
import { withLimit } from "@switchboard/protocol";
import type { BuildList } from "@switchboard/web-core";

const LIMIT_MS = 30_000;

/** Файл сборки приходит за предел или отказ словом. */
export const inTime = <T>(file: Promise<T>): Promise<T> =>
  withLimit(file, LIMIT_MS, () => {
    throw new Error(`нет ответа за ${LIMIT_MS / 1000} с`);
  });

export const readList = (): Promise<BuildList> => inTime(fetch("./build.json", { cache: "no-store" }).then((r) => r.json() as Promise<BuildList>));
