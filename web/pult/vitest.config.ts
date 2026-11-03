import { defineConfig } from "vitest/config";

// Тесты пульта — в happy-dom: страница без экрана, поддельный relay стенда, код приложения настоящий.
export default defineConfig({
  test: { environment: "happy-dom", include: ["test/**/*.test.{ts,tsx}"] },
});
