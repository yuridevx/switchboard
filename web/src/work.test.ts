// «Работа» открывает последнюю сессию; ширина списка в пределах; «Идут сейчас» собирает субагентов и фоновые задачи.
import type { SessionRow } from "@sb/protocol";
import { describe, expect, it } from "vitest";
import { fold } from "./chat/fold.ts";
import { got, reply, say, use, type Ev } from "./mock/convo.ts";
import { clampList, LIST_MIN, pickOpen, TALK_MIN } from "./screens/Work.tsx";
import { runningOf } from "./session/Dock.tsx";

const row = (callsign: string, o: Partial<SessionRow> = {}): SessionRow => ({ callsign, state: "idle", by: "~me@x.y", since: 1, last: 1, spec: { name: callsign.split("@")[0]!, cwd: "~" }, ...o }) as SessionRow;

describe("«Работа»: что открыть самой", () => {
  const sessions = { "a@m": row("a@m", { last: 5 }), "b@m": row("b@m", { last: 9 }), "c@m": row("c@m", { last: 2, ask: { id: "q", kind: "question", text: "?", at: 3 } }) };
  const shown = ["a@m", "b@m", "c@m"];
  it("последняя, с которой человек работал; её уже нет — первая, что ждёт ответа; никто не ждёт — самая свежая; сессий нет — ничего", () => {
    expect(pickOpen(sessions, shown, "a@m")).toBe("a@m");
    expect(pickOpen(sessions, shown, "gone@m")).toBe("c@m");
    expect(pickOpen(sessions, ["a@m", "b@m"], "")).toBe("b@m");
    expect(pickOpen({}, [], "a@m")).toBeUndefined();
  });
  it("ширина списка: не уже предела и не шире, чем оставляет разговору его предел", () => {
    expect(clampList(100, 1200)).toBe(LIST_MIN);
    expect(clampList(300, 1200)).toBe(300);
    expect(clampList(5000, 1200)).toBe(1200 - TALK_MIN);
    // узкое окно: список держит свой предел
    expect(clampList(300, 500)).toBe(LIST_MIN);
  });
});

describe("«Идут сейчас»", () => {
  const T = 1_800_000_000_000;
  const started = (id: string, tool: string | undefined, type: string, bg: boolean, at: number): Ev => ({ type: "system", subtype: "task_started", uuid: "s" + id, task_id: id, ...(tool ? { tool_use_id: tool } : {}), description: id, task_type: type, is_backgrounded: bg, timestamp: new Date(at).toISOString() }) as Ev;
  it("незаконченные задачи и субагент без задачи — по строке, по порядку запуска; законченные уходят", () => {
    const events: Ev[] = [
      say("проверь", T), reply([use("a1", "Agent", { description: "первый", subagent_type: "Explore" }), use("a2", "Agent", { description: "второй" }), use("a3", "Agent", { description: "третий" })], T + 1),
      started("t2", "a2", "local_agent", false, T + 20), started("t1", "a1", "local_agent", false, T + 10), started("bg", undefined, "local_bash", true, T + 30),
    ];
    const v = fold(events);
    expect(runningOf(v).map((r) => r.id)).toEqual(["a3", "t1", "t2", "bg"]);
    expect(runningOf(v).find((r) => r.id === "t1")?.tool?.input?.subagent_type).toBe("Explore");
    const after = fold([...events, got("a3", "готово", T + 40), { type: "system", subtype: "task_updated", uuid: "upd-t1", task_id: "t1", patch: { status: "completed" } } as Ev]);
    expect(runningOf(after).map((r) => r.id)).toEqual(["t2", "bg"]);
  });
});
