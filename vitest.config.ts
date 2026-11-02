import { defineConfig } from "vitest/config";

// Корневой прогон: Node-пакеты (protocol, tools, host) и скрипты выкладки. У Worker-модулей и веб-приложений — свои конфиги.
export default defineConfig({
  test: {
    include: ["protocol/**/*.test.ts", "tools/**/*.test.ts", "host/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
