import { defineConfig } from "vitest/config";

// Тесты пульта — в happy-dom: страница без экрана, поддельный relay стенда, код приложения настоящий.
export default defineConfig({
  // React на странице без экрана заметно медленнее прежнего кода: длинные сценарии идут 5–6 с
  test: { environment: "happy-dom", include: ["test/**/*.test.{ts,tsx}"], testTimeout: 20_000 },
});
