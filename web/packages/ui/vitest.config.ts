import { defineConfig } from "vitest/config";

// Тесты пакета — в happy-dom: страница без экрана.
export default defineConfig({
  test: { environment: "happy-dom", include: ["test/**/*.test.{ts,tsx}"] },
});
