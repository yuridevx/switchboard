// Мок дизайна «Перечитать сессии»: машины знают запрос session.reload; каждое второе нажатие первая живая сессия отказывает словом.
import type { Answer, ProtoMock } from "@proto/api";

type State = { first: string; presses: number };
const STOPPED = new Set(["stopped", "failed"]);

export default {
  owns: ["session.reload", "machine.profiles"],
  state: () => ({ first: "", presses: 0 }),
  roster(r, state) {
    state.first ||= r.sessions.find((s) => !STOPPED.has(String(s.state)))?.callsign ?? "";
    return { ...r, machines: r.machines.map((m) => ({ ...m, contract: { ...m.contract, "session.reload": 1 } })) };
  },
  async answer(f, { state, real }) {
    // сведение настоящее только на чтение: прод в прототипе не сводится
    if (f.type === "machine.profiles") {
      const { sync: _sync, ...read } = f;
      return (await real(read as typeof f)) as Answer;
    }
    if (f.type !== "session.reload") return undefined;
    if (f.callsign !== state.first) return { ok: true };
    state.presses += 1;
    return state.presses % 2 === 0 ? { ok: false, error: "sdk_error", why: "Claude не ответил за 30 с" } : { ok: true };
  },
} satisfies ProtoMock<State>;
