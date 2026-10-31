// Контракт web-board — список сессий (общий пакет телефона и пульта).
// Экран board (#sessions, раздел «Сессии»): узко — строки по машинам; широко — группы
// «нужны вы, в работе, свободны, остановлены» с поиском, фильтром и сводкой (плитки, слоты);
// рядом с карточкой (место sb-master ядра) — только список.Рисует метки asked (web-ask) и unread (web-chat);
// нажатие — экран ask, если сессия спрашивает, иначе карточка card.
// Метка need — число сессий waiting и failed: счётчик раздела.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createBoard } from "./src/module.ts";

export { createBoard };
export const manifest: Manifest = json;
export default createBoard() satisfies AppModule;
