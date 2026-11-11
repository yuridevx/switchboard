// Архив, вторая итерация: ветки линии точек, сверка «в архиве уже другая точка», перенос только хозяином, текст вызова модели.
import { describe, expect, it } from "vitest";
import { sha256hex } from "@sb/protocol";
import { blockKey, callText } from "./archive/archive.ts";
import { gzip } from "../r2.ts";
import { type Stand, stand } from "../../test/stand.ts";

const usage = { input_tokens: 100, output_tokens: 20 };
const LINES = [
  { type: "api-request-shape", shapeHash: "h1", shape: { system: [{ text: "Ты помощник флота." }, { text: "Отвечай кратко." }] } },
  { type: "user", uuid: "u1", message: { role: "user", content: "выложи сайт" } },
  { type: "api-request", id: "req1", shapeHash: "h1" },
  { type: "assistant", uuid: "a1", requestRef: "req1", message: { id: "msg_1", model: "claude-fable-5-2", usage, content: [{ type: "text", text: "Начинаю" }, { type: "tool_use", name: "Bash", input: { command: "npm run build" } }] } },
  { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", content: "готово" }] } },
  { type: "api-request", id: "req2", shapeHash: "h1" },
  { type: "assistant", uuid: "a2", requestRef: "req2", message: { id: "msg_2", model: "claude-fable-5-2", usage, content: [{ type: "text", text: "Выложено" }] } },
];

/** Сохранить точку от имени машины: загрузить блоки и записать. */
async function save(s: Stand, sid: string, point: string, extra: Record<string, unknown> = {}, as = "klaptop") {
  const text = LINES.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const hash = await sha256hex(text);
  const put = { sid, callsign: "site@laptop", point, files: [{ path: `projects/site/${sid}.jsonl`, blocks: [hash], size: text.length }], ...extra };
  const first = (await s.ask("points.put", put, as)).result as { upload: Record<string, string>; done: boolean };
  const machine = s.whos.get(s.key(as))!.addr.slice(1);
  if (first.upload[hash]) await s.env.FILES.put(blockKey(s.fleet, machine, hash), await gzip(text));
  if (!first.done) expect(await s.ask("points.put", { ...put, commit: true }, as)).toMatchObject({ result: { done: true } });
}

describe("архив: ветки, сверка и хозяин", () => {
  it("точка знает, от какой продолжена: линия той же сессии и копия от чужой точки", async () => {
    const s = await stand();
    await save(s, "s1", "p1");
    await save(s, "s1", "p2", { base: "p1" });
    await save(s, "s2", "p1", { base: "s1/p2" });
    const line = (await s.ask("points.list", { sid: "s1" })).result as { points: { point: string; base?: string }[] };
    expect(line.points.map((p) => [p.point, p.base])).toEqual([["p2", "p1"], ["p1", undefined]]);
    const copy = (await s.ask("points.get", { sid: "s2" })).result as { point: { base?: string } };
    expect(copy.point.base).toBe("s1/p2");
  });

  it("поднимают то, что видели: в архиве уже другая точка — changed", async () => {
    const s = await stand();
    await save(s, "s1", "p1");
    await save(s, "s1", "p2");
    expect(await s.ask("points.get", { sid: "s1", expect: "p1" })).toMatchObject({ ok: false, error: "changed" });
    expect((await s.ask("points.get", { sid: "s1", expect: "p2" })).ok).toBe(true);
  });

  it("перенос забирает сессию у машины: начал не владелец и не админ — not_owner; копию берёт любой, кто достаёт", async () => {
    const s = await stand();
    await save(s, "s1", "p1");
    // Аня достаёт до laptop, но владелец — Юра: перенос ей не дан, копия — дана
    expect(await s.ask("points.get", { sid: "s1", move: true, by: "pult~anya@example.com" }, "klaptop")).toMatchObject({ ok: false, error: "not_owner" });
    expect((await s.ask("points.get", { sid: "s1", by: "pult~anya@example.com" }, "klaptop")).ok).toBe(true);
    expect((await s.ask("points.get", { sid: "s1", move: true, by: "pult~yuri@example.com" }, "klaptop")).ok).toBe(true);
  });
});

describe("архив: текст вызова модели", () => {
  it("системный промпт из формы запроса и сообщения до ответа, страницами с конца", () => {
    const first = callText(LINES, "msg_1", undefined, 50)!;
    expect(first).toMatchObject({ model: "claude-fable-5-2", system: "Ты помощник флота.\n\nОтвечай кратко.", more: false });
    expect(first.messages).toEqual([{ n: 0, role: "user", text: "выложи сайт" }]);
    const second = callText(LINES, "msg_2", undefined, 2)!;
    expect(second.messages.map((m) => m.n)).toEqual([1, 2]);
    expect(second.messages[0]!.text).toContain("[вызов Bash]");
    expect(second.messages[1]!.text).toBe("[итог] готово");
    expect(second.more).toBe(true);
    expect(callText(LINES, "msg_2", 1, 2)!.messages).toEqual([{ n: 0, role: "user", text: "выложи сайт" }]);
    expect(callText(LINES, "msg_9", undefined, 50)).toBeNull();
  });

  it("points.call отдаёт текст вызова точки; вызова нет — not_found", async () => {
    const s = await stand();
    await save(s, "s1", "p1");
    const r = (await s.ask("points.call", { sid: "s1", call: "msg_2" })).result as { point: string; system: string; messages: unknown[] };
    expect(r).toMatchObject({ point: "p1", system: expect.stringContaining("помощник флота") });
    expect(r.messages).toHaveLength(3);
    expect(await s.ask("points.call", { sid: "s1", call: "nope" })).toMatchObject({ ok: false, error: "not_found" });
  });
});
