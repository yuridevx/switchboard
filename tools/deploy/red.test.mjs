// Проверка правила «красное не сливается»: этот тест падает нарочно, PR закрывается без слияния.
import assert from "node:assert/strict";
import { test } from "node:test";

test("красный тест", () => assert.fail("нарочно"));
