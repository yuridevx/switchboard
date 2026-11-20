// Часы теста страницы: таймеры и Date каждого теста — поддельные часы vitest. Время идёт, только когда его двигает тест
// (vi.advanceTimersByTime…) или ожидание testing-library: её waitFor и findBy при поддельных часах сами двигают время шагами по 50 мс.
// Мок флота создаётся внутри теста — его ответ через 90 мс и такт живых сессий идут по этим же часам.
import { afterEach, beforeEach, vi } from "vitest";

// testing-library узнаёт поддельные часы по глобальному jest и setTimeout.clock (так она устроена) и двигает их через jest.advanceTimersByTime
(globalThis as { jest?: unknown }).jest = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());
