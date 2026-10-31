import { defineConfig } from "vitest/config";

// Тесты пакета — в happy-dom: страница без экрана, поддельный relay стенда.
export default defineConfig({
  test: { environment: "happy-dom", include: ["test/**/*.test.ts"] },
});
