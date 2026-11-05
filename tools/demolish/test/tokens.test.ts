// Правило счёта токенов: флоу команды size его не достаёт — он сравнивает два числа, а не их верность.
import { describe, expect, it } from "vitest";
import { tokensOf } from "../measure.ts";

describe("токены", () => {
  it.each([
    ["шаблон с подстановкой не глотает код за собой", "a.ts", "const a = `x${b}y`; const c = d + e;", 14],
    ["регулярка с кавычкой не глотает код за собой", "a.ts", 'const r = /"/; const s = 1;', 10],
    ["комментарии и JSDoc не считаются", "a.ts", "/** док @param x */ const a = 1; // хвост", 5],
    ["пустые скобки — только сами скобки", "a.mjs", "f();", 4],
  ])("%s", (_, file, text, tokens) => {
    expect(tokensOf(file, text)).toBe(tokens);
  });
});
