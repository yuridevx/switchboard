// Модуль fleet: сессии флота видят друг друга, пишут, открывают и ведут других — как в десктоп-приложении Claude.
// Каждой сессии — сервер MCP fleet. Открыть, прочитать, сменить модель и закрыть — запросы manage и chat, fleet их только зовёт.
// Своего хранения нет: проекты и имена — записи области флота у службы настроек, формат — у records.
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Module, SDKMessage, Session } from "@switchboard/host";
import { FLEET_PREFIX, settings } from "@switchboard/records";
import { kindOf } from "@switchboard/protocol";
import { prompt } from "./prompt.ts";
import { fleetTools, type Env } from "./tools.ts";

/** Текст итога хода для родителя. Ход с ошибкой бывает и с типом success («Not logged in»): родителю — текст ошибки, а не тип. */
function outcome({ subtype, is_error, result }: { subtype: string; is_error?: boolean; result?: string }): string {
  if (is_error) return result ? `ход кончился ошибкой: ${result}` : `ход кончился: ${subtype}`;
  return subtype === "success" ? (result ?? "") : `ход кончился: ${subtype}`;
}

export function make() {
  const env = {} as Env;

  /** Конец хода: последний ввод от родителя-сессии — итог ему тем же message. Родитель — поле manage этой машины: relay не нужен. */
  function report(s: Session, m: SDKMessage): void {
    const me = s.info.callsign;
    const parent = s.field("parent");
    if (typeof parent !== "string" || kindOf(parent) !== "session" || s.info.from !== parent) return;
    void env.host.request("message", { to: parent, text: outcome(m as never), report: true, from: me }).then((r) => {
      if (!r.ok) env.host.log({ kind: "note", ev: "report", word: r.error, callsign: me, why: `итог хода родителю ${parent} не доставлен: ${r.error}` });
    });
  }

  const module: Module = {
    start(h) {
      env.host = h;
      env.meta = settings({ read: (name, body) => h.read(name, body) as never, ask: (name, body) => h.request(name, body) as never, prefix: FLEET_PREFIX, scope: "global" });
    },
    session: (s) => ({
      mcpServers: { fleet: createSdkMcpServer({ name: "fleet", version: "1.5.0", tools: fleetTools(s.info.callsign, env) }) },
      append: prompt(s.info.callsign),
      // переписка между сессиями — только через fleet: рубильник Claude Code убирает ListAgents и доставку
      // SendMessage чужим сессиям в обе стороны; SendMessage своим субагентам остаётся (исключение устава, слово 1 нояб.)
      env: { CLAUDE_CODE_HARBOR_KITE: "0" },
    }),
    on: {
      event(s, m) {
        if (m.type === "result") report(s, m);
      },
    },
    // своего хранить нечего; правки записей доходят до службы
    stop: () => env.meta.settled(),
  };
  return { module, tools: (me: string) => fleetTools(me, env) };
}
