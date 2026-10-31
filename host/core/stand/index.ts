// Стенд Host для тестов ядра и модулей: поддельные SDK, relay, keeper и часы вокруг настоящего ядра.
//
//   import { stand } from "@switchboard/host";
//   const st = await stand.standHost({ modules: [stand.module("host-cost", cost)] });
//   await st.open("site@laptop");
//   stand.turn(st.proc("site@laptop"));                 // ход: running → assistant → result → idle
//   const r = await st.relay.request({ type: "session.cost", v: 1, callsign: "site@laptop" });
//   await st.close();
export { FakeClock } from "./clock.ts";
export { FakeKeeper, FakeProc } from "./keeper.ts";
export { FakeRelay } from "./relay.ts";
export { FakeQuery, FakeSdk } from "./sdk.ts";
export { CORE, module, release, standHost, until } from "./host.ts";
export type { Stand, StandOptions } from "./host.ts";
import type { FakeProc } from "./keeper.ts";

let uuid = 0;
const u = () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`;

/** Сообщения SDK 0.3.311 для поддельного процесса. */
export const msg = {
  init: (session_id: string, model = "claude-haiku-4-5") => ({ type: "system", subtype: "init", session_id, model, tools: [], mcp_servers: [], uuid: u() }),
  state: (state: "idle" | "running" | "requires_action") => ({ type: "system", subtype: "session_state_changed", state, uuid: u(), session_id: "s" }),
  assistant: (text: string) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid: u(),
    session_id: "s",
  }),
  result: (o: Record<string, unknown> = {}) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: "",
    total_cost_usd: 0.012,
    session_id: "s",
    uuid: u(),
    ...o,
  }),
};

/** Один ход сессии: running → assistant → result → idle. */
export function turn(p: FakeProc, text = "готово", result: Record<string, unknown> = {}): void {
  p.send(msg.state("running"));
  p.send(msg.assistant(text));
  p.send(msg.result(result));
  p.send(msg.state("idle"));
}
