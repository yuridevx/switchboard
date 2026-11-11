// Тесты mcp: Worker как функция fetch с поддельными gate, «Выпусками» и владельцами запросов — среда Node.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", include: ["test/**/*.test.ts"] } });
