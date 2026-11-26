// Эталон «Фабрики»: раздача при тридцати сессиях постов. Запрос раздачи не перечисляет посты и сессии — число значений в нём от их числа не зависит.
import { describe, expect, it } from "vitest";
import type { Ticket } from "@sb/protocol";
import { appliedFleet } from "../../test/factory.ts";

const POSTS = 15;
const POST = { at: "@laptop", cwd: "~/work/post", key: "claude", model: "claude-opus-5-5", for: "1d", size: 2 };
const names = Array.from({ length: POSTS }, (_, i) => `post${i + 1}`);
const DEF = { project: "site", posts: Object.fromEntries(names.map((n) => [n, POST])) };

describe("фабрика: много сессий", () => {
  // эталон 29 — чьё: факт — прод 26 нояб. 2026: при 27 сессиях постов раздача стояла 7 минут, отказ записи «too many SQL variables»
  it("29 · тридцать сессий постов: тикет каждому — все тридцать выданы, отказов записи нет", async () => {
    const { s } = await appliedFleet(DEF);
    const ids: string[] = [];
    for (const post of names)
      for (const k of [1, 2]) {
        const r = await s.ask("ticket.new", { project: "site", to: post, title: `Дело ${post}-${k}` });
        expect(r).toMatchObject({ ok: true });
        ids.push((r.result as { id: string }).id);
      }
    const work = ((await s.ask("ticket.list", { project: "site", state: "work" })).result as { tickets: Ticket[] }).tickets;
    expect(work.length).toBe(POSTS * 2);
    expect(s.seen.delivered.filter((f) => f.type === "work.give").length).toBe(POSTS * 2);
  });
});
