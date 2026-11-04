// Панель контекста: сколько занято, по частям; «Сжать» — команда /compact; субагенты; расход, сведения claude, правила разрешений, хуки; «Перечитать плагины». Открытая панель спрашивает session.call один раз.
import { Archive, Gauge, RefreshCw } from "lucide-react";
import { Meter, LIMIT_BAD, LIMIT_WARN } from "@switchboard/web-ui";
import { useChat } from "../context.ts";
import { kTokens } from "../cards/format.ts";
import { AboutSection, HooksSection, RulesSection, UsageSection, useMethod } from "./Sections.tsx";

type Usage = { totalTokens?: number; maxTokens?: number; percentage?: number; categories?: Array<{ name: string; tokens: number }> };
type Agent = { name: string; description?: string };

/** Подписи частей контекста. */
const NAMES: Record<string, string> = { "System prompt": "Системная подсказка", "System tools": "Инструменты", "MCP tools": "Инструменты MCP", "Custom agents": "Свои агенты", "Memory files": "CLAUDE.md и память", Skills: "Скилы", Messages: "Разговор", "Free space": "Свободно", "Autocompact buffer": "Запас на сжатие" };

export function ContextPanel({ callsign, close }: { callsign: string; close(): void }) {
  const chat = useChat();
  const { data: usage, error: usageWord } = useMethod<Usage | null>(callsign, "getContextUsage");
  const { data: agentList, error: agentsWord } = useMethod<Agent[] | null>(callsign, "supportedAgents");
  const agents = Array.isArray(agentList) ? agentList : [];
  // отказ метода — слово в панели; панель остаётся с тем, что ответили
  const word = [usageWord, agentsWord].find((w) => w && w !== "unknown_method");

  const pct = Math.round(usage?.percentage ?? 0);
  return (
    <section className="chat-panel" aria-label="Контекст">
      {word ? <div className="bad">{word}</div> : null}
      {usage ? (
        <>
          <div className="chat-pn-h">
            <Gauge size={14} />
            <b>{`${kTokens(usage.totalTokens)} из ${kTokens(usage.maxTokens)}`}</b>
            <em>{`${pct}%`}</em>
          </div>
          <Meter value={pct} warn={pct >= LIMIT_WARN} bad={pct >= LIMIT_BAD} />
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
      <UsageSection callsign={callsign} />
      <AboutSection callsign={callsign} />
      <RulesSection callsign={callsign} />
      <HooksSection callsign={callsign} />
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
      <button type="button" className="chat-mini" onClick={() => void chat.reloadPlugins(callsign)}>
        <RefreshCw size={13} />
        Перечитать плагины
      </button>
    </section>
  );
}
