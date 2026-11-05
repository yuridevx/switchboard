import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Host, Module, Session } from "@switchboard/host";
import { kindOf } from "@switchboard/protocol";
import { FLEET_PREFIX, settings } from "@switchboard/records";
import type { Settings } from "@switchboard/records";
import { prompt } from "./prompt.ts";
import { toolsOf } from "./tools.ts";

type TurnEnd = { type: string; subtype?: string; is_error?: boolean; result?: string };

/** Текст итога хода: что уйдёт родителю. */
function outcome({ subtype, is_error: failed, result }: TurnEnd): string {
  if (failed && result) return `ход кончился ошибкой: ${result}`;
  return failed || subtype !== "success" ? `ход кончился: ${subtype}` : (result ?? "");
}

export function make() {
  let host: Host;
  let records: Settings;

  const tools = (me: string) => toolsOf(me, () => ({ host, records }));

  /** Ход кончился, а начал его родитель, — итог ему сам. */
  function report(s: Session, end: TurnEnd): void {
    const { callsign, from } = s.info;
    const parent = s.field("parent") as string | undefined;
    if (!parent || parent !== from || kindOf(parent) !== "session") return;
    void host.request("message", { to: parent, text: outcome(end), report: true, from: callsign }).then((r) => {
      if (!r.ok) host.log({ kind: "note", ev: "report", word: r.error, callsign, why: `итог хода родителю ${parent} не доставлен: ${r.error}` });
    });
  }

  const module: Module = {
    start(h) {
      host = h;
      records = settings({ read: (name, body) => h.read(name, body) as never, ask: (name, body) => h.request(name, body) as never, prefix: FLEET_PREFIX, scope: "global" });
    },
    stop: () => records.settled(),
    session: ({ info: { callsign } }) => ({
      mcpServers: { fleet: createSdkMcpServer({ name: "fleet", tools: tools(callsign) }) },
      append: prompt(callsign),
      // сессии говорят друг с другом только через fleet (слово пользователя 1 нояб.)
      env: { CLAUDE_CODE_HARBOR_KITE: "0" },
    }),
    on: {
      event(s, msg) {
        if (msg.type === "result") report(s, msg as TurnEnd);
      },
    },
  };

  return { module, tools };
}
