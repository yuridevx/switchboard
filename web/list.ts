// Список сборки лежит рядом со страницей и обработчиком пушей. Номер сборки меняется на месте: кэш браузера его не держит.
import { withLimit } from "@switchboard/protocol";
import type { BuildList } from "@switchboard/web-core";

const LIMIT_MS = 30_000;

export function readList(silence: string): Promise<BuildList> {
  const answer = fetch("./build.json", { cache: "no-store" }).then((r) => r.json() as Promise<BuildList>);
  return withLimit(answer, LIMIT_MS, () => {
    throw new Error(silence);
  });
}
