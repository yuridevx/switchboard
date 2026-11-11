// Контракт mcp: один публичный сервер MCP флота — Streamable HTTP по адресу <mcp>/mcp, вход — Bearer пропуска gate.
// Инструмент — запрос Worker-модуля с tool в манифесте (releases.tools); имя — запрос через _ вместо точки.
// initialize и tools/list: пропуск сверяет gate.verify; tools/call — POST владельцу с пропуском клиента, сверяет владелец.
// Неживой пропуск — 401 с WWW-Authenticate: resource_metadata — /.well-known/oauth-protected-resource (сервер входа — gate).
// Прав нет: любой живой пропуск зовёт любой инструмент. Состояния и своих инструментов нет.
export const ENDPOINT = "/mcp";
