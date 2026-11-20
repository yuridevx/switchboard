import { defineConfig } from "vitest/config";
// часы всех тестов страницы — поддельные: src/test-clock.ts
export default defineConfig({ test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"], environment: "happy-dom", setupFiles: ["src/test-clock.ts"] } });
