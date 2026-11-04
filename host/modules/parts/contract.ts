// Контракт модуля Host parts: выпуски флота из разговора. Своих запросов нет.
// Модели каждой сессии — инструменты MCP parts: list, upload, fetch, deploy, set, log (mcp__parts__*).
// Зовёт «выпуски» (releases.*), gate (keys.list), keeper'ов машин (keeper.state) и журнал машины (machine.journal). Хранить нечего.
import { make } from "./src/parts.ts";

export { make };
export default make().module;
