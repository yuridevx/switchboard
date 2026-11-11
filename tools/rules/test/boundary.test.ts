// Леса движка правил: только входы контракта. Случаи — из движка museclaude (чьё: код), правило абзаца на запросе — эталон 18.
import { describe, expect, it } from "vitest";
import { applyRules, compile, editRequest, flawOf, type Rule } from "../contract.ts";

const rule = (p: Partial<Rule>): Rule => ({ name: "r", scopes: ["user"], kind: "literal", unit: "match", action: "replace", pattern: "x", replacement: "", ...p });
const run = (rules: Rule[], text: string, model = "claude-opus-5-5") => applyRules(rules, "user", text, model);

describe("правила", () => {
  it("совпадение регулярки с группами: каждое вхождение, $1 и ${имя}", () => {
    const r = run([rule({ kind: "regex", pattern: "ticket ([A-Z]+-\\d+)", replacement: "(ticket ${1} redacted)" })], "see ticket AB-12 and ticket CD-3");
    expect(r).toEqual({ after: "see (ticket AB-12 redacted) and (ticket CD-3 redacted)", hits: { r: 2 } });
    expect(run([rule({ kind: "regex", pattern: "(?P<k>\\d+)", replacement: "<${k}>$$" })], "a 12").after).toBe("a <12>$");
  });

  it("литерал: замена без подстановки, точка — точка", () => {
    expect(run([rule({ pattern: "a.b", replacement: "$1 cost" })], "x a.b axb").after).toBe("x $1 cost axb");
  });

  it("абзац: заменить и удалить, последний абзац забирает разделитель перед собой", () => {
    const text = "Hello.\n\nticket ABC-12 is open\n\nBye.";
    expect(run([rule({ pattern: "ticket", unit: "paragraph", replacement: "(redacted)" })], text).after).toBe("Hello.\n\n(redacted)\n\nBye.");
    expect(run([rule({ pattern: "ticket", unit: "paragraph", action: "delete" })], text).after).toBe("Hello.\n\nBye.");
    expect(run([rule({ pattern: "Bye", unit: "paragraph", action: "delete" })], text).after).toBe("Hello.\n\nticket ABC-12 is open");
  });

  it("строка и весь блок; ^ — начало строки", () => {
    expect(run([rule({ kind: "regex", pattern: "^secret", unit: "line", action: "delete" })], "a\nsecret=1\nb").after).toBe("a\nb");
    expect(run([rule({ pattern: "x", unit: "block", replacement: "whole" })], "a x b").after).toBe("whole");
  });

  it("место, модель, порядок, выключенное и регистр", () => {
    expect(run([rule({ pattern: "a", replacement: "b", models: ["*haiku*"] })], "a")).toEqual({ after: "a", hits: {} });
    expect(run([rule({ pattern: "a", replacement: "b", models: ["*opus*"] })], "a").after).toBe("b");
    expect(run([rule({ name: "1", pattern: "a", replacement: "b" }), rule({ name: "2", pattern: "b", replacement: "c" })], "a").after).toBe("c");
    expect(run([rule({ pattern: "a", replacement: "b", scopes: ["system"] })], "a").after).toBe("a");
    expect(run([rule({ pattern: "a", replacement: "b", on: false })], "a").after).toBe("a");
    expect(run([rule({ pattern: "A", replacement: "b", icase: true })], "a").after).toBe("b");
  });

  it("неверные правила названы словами и не применяются; пустое совпадение не зацикливает", () => {
    expect(flawOf(rule({ kind: "regex", pattern: "(" }))).not.toBe("");
    expect(flawOf(rule({ pattern: "" }))).toBe("нечего искать");
    expect(flawOf(rule({ scopes: [] }))).toBe("не выбрано, где искать");
    expect(Object.keys(compile([rule({ name: "bad", kind: "regex", pattern: "(" }), rule({ name: "ok" })]).flaws)).toEqual(["bad"]);
    expect(run([rule({ kind: "regex", pattern: "z*", replacement: "-" })], "ab").after).toBe("-a-b-");
  });

  it("регулярка RE2: линейное время на длинном тексте", () => {
    const t = Date.now();
    run([rule({ kind: "regex", pattern: "(a+)+$", replacement: "" })], `${"a".repeat(50_000)}b`);
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it("18 · правило абзаца на запросе: system, литерал, абзац, замена; тексты сообщений и ответов инструментов — по своим местам", () => {
    const body = {
      model: "claude-opus-5-5",
      system: [{ type: "text", text: "x-anthropic-billing-header: cc" }, { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.\n\nRest." }],
      messages: [
        { role: "user", content: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
        { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t", name: "Bash", input: { cmd: "hi" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "hi there" }] }] },
      ],
    };
    const rules = compile([
      rule({ name: "Имя агента", scopes: ["system"], unit: "paragraph", pattern: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", replacement: "You are a coding agent of the ops fleet." }),
      rule({ name: "out", scopes: ["tool_result"], pattern: "hi", replacement: "HI" }),
    ]);
    expect(editRequest(body, rules)).toEqual({ "Имя агента": 1, out: 1 });
    expect(body.system[1].text).toBe("You are a coding agent of the ops fleet.\n\nRest.");
    expect(body.messages[0].content).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
    expect(JSON.stringify(body.messages[1])).toContain('"text":"hi"');
    expect(JSON.stringify(body.messages[1])).toContain('"cmd":"hi"');
    expect(JSON.stringify(body.messages[2])).toContain("HI there");
  });
});
