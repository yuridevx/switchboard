// Контракт модуля Host keys: пропуска флота из разговора. Своих запросов нет.
// Модели каждой сессии — инструменты MCP keys: invite, list, revoke (mcp__keys__*).
// invite и list зовут gate, revoke — вход relay; пропуск за сессию подставляет ядро. Хранить нечего.
import { make } from "./src/keys.ts";

export default make().module;
