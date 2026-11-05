// Список сборки рядом со страницей: его читают оболочка и обработчик пушей. Без кэша: файл меняет каждая сборка.
import { within } from "@switchboard/protocol";
import type { BuildList } from "@switchboard/web-core";

const LIMIT_MS = 30_000;

export const limited = <T>(p: Promise<T>) => within(p, `нет ответа за ${LIMIT_MS / 1000} с`, LIMIT_MS);

export const readList = () => limited(fetch("./build.json", { cache: "no-store" }).then((r) => r.json() as Promise<BuildList>));
