// Решение по инструменту и форма MCP: владелец решает, ядро только находит его. Ответа за человека ядро не выбирает.
import type { ElicitationResult, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { LogRecord, Session } from "../contract.ts";
import type { Mod, Scope, Trap } from "./trap.ts";
import { MODULE_ERROR } from "./trap.ts";

/** Сессия, о которой спрашивают: где выключить владельца и как его глазами её видно. */
export type Asker = Scope & { facade(m: Mod): Session };

export class Decisions {
  private readonly trap: Trap;
  private readonly log: (rec: LogRecord) => void;
  private readonly byTool = new Map<string, Mod>();
  private forms: Mod | null = null;

  constructor(trap: Trap, log: (rec: LogRecord) => void) {
    this.trap = trap;
    this.log = log;
  }

  /** Владельцы по загруженным модулям. */
  index(mods: Mod[]): void {
    for (const m of mods) {
      for (const tool of Object.keys(m.module.decide ?? {})) this.byTool.set(tool, m);
      if (m.module.elicit) this.forms = m;
    }
  }

  /** canUseTool: своё решение у инструмента или общее decide.* — запрос разрешения в режимах, где claude спрашивает. */
  canUseTool(s: Asker, tool: string, input: Record<string, unknown>, o: Record<string, unknown>): Promise<PermissionResult> {
    const owner = this.byTool.get(tool) ?? this.byTool.get("*");
    if (!owner) {
      this.log({ kind: "refuse", ev: "decide", word: "unknown_request", callsign: s.callsign, tool, why: `${tool}: у решения нет владельца — ответ за человека не выбран` });
      return Promise.resolve({ behavior: "deny", message: "unknown_request" });
    }
    const deny = (): PermissionResult => {
      this.log({ kind: "refuse", ev: "decide", word: MODULE_ERROR, callsign: s.callsign, module: owner.name, tool });
      return { behavior: "deny", message: MODULE_ERROR };
    };
    const decide = owner.module.decide!;
    return this.waitHuman<PermissionResult>(s, owner, `decide.${tool}`, () => (decide[tool] ?? decide["*"])(s.facade(owner), input, { ...o, tool } as never), deny);
  }

  /** onElicitation: владельца нет или он упал — decline. */
  elicit(s: Asker, req: unknown, o: { signal: AbortSignal; requestId: string }): Promise<ElicitationResult> {
    const owner = this.forms;
    const decline: ElicitationResult = { action: "decline" };
    if (!owner) {
      this.log({ ev: "elicit", callsign: s.callsign, why: "у форм MCP нет владельца — decline" });
      return Promise.resolve(decline);
    }
    return this.waitHuman<ElicitationResult>(s, owner, "elicit", () => owner.module.elicit!(s.facade(owner), req as never, o), () => decline);
  }

  /** Вызов, ждущий человека: сбой или отказ владельца — ответ onFail. */
  private waitHuman<T>(s: Asker, owner: Mod, where: string, fn: () => T | Promise<T>, onFail: () => T): Promise<T> {
    return (async () => this.trap.call(owner, where, s, fn, onFail))().catch(onFail);
  }
}
