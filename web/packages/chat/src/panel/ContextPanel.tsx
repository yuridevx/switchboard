// Панель контекста: сколько занято, по частям; «Сжать» — команда /compact; субагенты сессии. Открытая панель спрашивает session.call один раз.
import { Archive, Gauge } from "lucide-react";
import { Meter, useLoad } from "@switchboard/web-ui";
import { useChat } from "../context.ts";
import { kTokens } from "../cards/format.ts";

type Usage = { totalTokens?: number; maxTokens?: number; percentage?: number; categories?: Array<{ name: string; tokens: number }> };
type Agent = { name: string; description?: string };

/** Подписи частей контекста. */
const NAMES: Record<string, string> = { "System prompt": "Системная подсказка", "System tools": "Инструменты", "MCP tools": "Инструменты MCP", "Custom agents": "Свои агенты", "Memory files": "CLAUDE.md и память", Skills: "Скилы", Messages: "Разговор", "Free space": "Свободно", "Autocompact buffer": "Запас на сжатие" };

export function ContextPanel({ callsign, close }: { callsign: string; close(): void }) {
  const chat = useChat();
  // отказ метода — тост словом (chat.call); панель остаётся с тем, что ответили
  const { data: usage } = useLoad<Usage>(() => chat.call<Usage>(callsign, "getContextUsage").then((u) => ({ ok: true as const, result: u ?? {} })), [chat, callsign]);
  const { data: agentList } = useLoad<Agent[] | undefined>(() => chat.call<Agent[]>(callsign, "supportedAgents").then((a) => ({ ok: true as const, result: a })), [chat, callsign]);
  const agents = Array.isArray(agentList) ? agentList : [];

  const pct = Math.round(usage?.percentage ?? 0);
  return (
    <section className="chat-panel" aria-label="Контекст">
      {usage ? (
        <>
          <div className="chat-pn-h">
            <Gauge size={14} />
            <b>{`${kTokens(usage.totalTokens)} из ${kTokens(usage.maxTokens)}`}</b>
            <em>{`${pct}%`}</em>
          </div>
          <Meter value={pct} warn={pct >= 70} bad={pct >= 90} />
          <dl className="chat-pn-l">
            {(usage.categories ?? [])
              .filter((x) => x.tokens > 0)
              .map((x) => (
                <div key={x.name}>
                  <dt>{NAMES[x.name] ?? x.name}</dt>
                  <dd>{kTokens(x.tokens)}</dd>
                </div>
              ))}
          </dl>
          <button
            type="button"
            className="chat-mini"
            onClick={() => {
              chat.send(callsign, "/compact", []);
              close();
            }}
          >
            <Archive size={13} />
            Сжать контекст
          </button>
        </>
      ) : null}
      {agents.length ? (
        <dl className="chat-pn-a">
          {agents.map((a) => (
            <div key={a.name}>
              <dt>{a.name}</dt>
              {a.description ? <dd>{a.description}</dd> : null}
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
