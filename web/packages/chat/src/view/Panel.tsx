// Панель контекста: сколько занято, по частям; разделы из своих методов Host. Открытая панель спрашивает каждый метод один раз; метода нет — раздела нет; другой отказ — слово в разделе.
import type { ReactNode } from "react";
import { Archive, Gauge, RefreshCw } from "lucide-react";
import { Btn, duration, LIMIT_BAD, LIMIT_NAMES, LIMIT_WARN, LimitRow, Meter, PERM_PLACES, useLoad, useModule } from "@switchboard/web-ui";
import type { Chat } from "../state/chat.ts";
import { costText, kTokens } from "../state/words.ts";

const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

type Usage = {
  session?: { total_cost_usd?: number; total_api_duration_ms?: number; total_lines_added?: number; total_lines_removed?: number };
  rate_limits?: Record<string, { utilization?: number; resets_at?: string | null } | null> | null;
};
type Context = { totalTokens?: number; maxTokens?: number; percentage?: number; categories?: Array<{ name: string; tokens: number }> };
type Agent = { name: string; description?: string };
type Status = { sections?: Array<{ title: string; rows?: Array<{ label: string; value: string }> }> };
type Hook = { event: string; matcher?: string; displayText?: string };
type Rule = { behavior: string; source: string; rule: string };

/** Подписи частей контекста. */
const NAMES: Record<string, string> = { "System prompt": "Системная подсказка", "System tools": "Инструменты", "MCP tools": "Инструменты MCP", "Custom agents": "Свои агенты", "Memory files": "CLAUDE.md и память", Skills: "Скилы", Messages: "Разговор", "Free space": "Свободно", "Autocompact buffer": "Запас на сжатие" };
/** Подписи правил разрешений: что делает. */
const BEHAVIOR: Record<string, string> = { allow: "можно", deny: "нельзя", ask: "спросить" };
/** Подписи строк /status. */
const STATUS: Record<string, string> = { Version: "Версия", "Session name": "Имя", "Session ID": "Номер", "Session kind": "Вид", cwd: "Папка", "Login method": "Вход", Organization: "Организация", Email: "Почта", Model: "Модель", "MCP servers": "MCP", "Setting sources": "Настройки", Memory: "Память" };
/** Служебные строки /status: человеку не нужны. */
const HIDDEN = new Set(["Peer address"]);

function useMethod<T>(callsign: string, method: string, args: unknown[] = []) {
  const chat = useModule<Chat>();
  return useLoad<T>(() => chat.ask<T>(callsign, method, args), [chat, callsign, method]);
}

function Sec({ name, title, error, children }: { name: string; title: string; error: string; children: ReactNode }) {
  if (error === "unknown_method") return null;
  return (
    <div className="chat-pn-s" data-sec={name}>
      <h4>{title}</h4>
      {error ? <div className="bad">{error}</div> : children}
    </div>
  );
}

function UsageSection({ callsign }: { callsign: string }) {
  const { data, error } = useMethod<Usage>(callsign, USAGE, [{ skipBehaviors: true }]);
  const s = data?.session;
  const windows = Object.entries(data?.rate_limits ?? {}).filter(([, w]) => w && typeof w.utilization === "number");
  return (
    <Sec name="usage" title="Расход" error={error}>
      {s ? (
        <dl className="chat-pn-k">
          <dt>Запуск</dt>
          <dd>{costText(s.total_cost_usd ?? 0)}</dd>
          <dt>Время API</dt>
          <dd>{duration(s.total_api_duration_ms ?? 0)}</dd>
          <dt>Строки</dt>
          <dd>
            <span className="chat-pn-plus">{`+${s.total_lines_added ?? 0}`}</span> <span className="chat-pn-minus">{`−${s.total_lines_removed ?? 0}`}</span>
          </dd>
        </dl>
      ) : null}
      {windows.map(([k, w]) => (
        <LimitRow key={k} className="chat-pn-w" data-window={k} label={LIMIT_NAMES[k] ?? k} used={w!.utilization! / 100} resets={w!.resets_at ? Date.parse(w!.resets_at) : undefined} />
      ))}
    </Sec>
  );
}

function AboutSection({ callsign }: { callsign: string }) {
  const { data, error } = useMethod<Status>(callsign, "getStatus");
  const rows = (data?.sections ?? []).flatMap((s) => (s.rows ?? []).filter((r) => !HIDDEN.has(r.label)).map((r) => ({ ...r, key: `${s.title}:${r.label}` })));
  if (!error && !rows.length) return null;
  return (
    <Sec name="claude" title="Claude" error={error}>
      <dl className="chat-pn-k">
        {rows.map((r) => (
          <div key={r.key} style={{ display: "contents" }}>
            <dt>{STATUS[r.label] ?? r.label}</dt>
            <dd>{r.value.replace(/\bconnected\b/, "подключено")}</dd>
          </div>
        ))}
      </dl>
    </Sec>
  );
}

function RulesSection({ callsign }: { callsign: string }) {
  const { data, error } = useMethod<{ state?: { rules?: Rule[] } }>(callsign, "listPermissionRules");
  const rules = data?.state?.rules ?? [];
  if (!error && !rules.length) return null;
  return (
    <Sec name="rules" title="Разрешения" error={error}>
      {rules.map((r, i) => (
        <div key={`${r.rule}:${i}`} className="chat-pn-r" data-behavior={r.behavior}>
          <b>{BEHAVIOR[r.behavior] ?? r.behavior}</b>
          <span>{r.rule}</span>
          <em>{PERM_PLACES[r.source] ?? r.source}</em>
        </div>
      ))}
    </Sec>
  );
}

function HooksSection({ callsign }: { callsign: string }) {
  const { data, error } = useMethod<{ hooks?: Hook[] }>(callsign, "getHooksListing");
  const hooks = data?.hooks ?? [];
  if (!error && !hooks.length) return null;
  return (
    <Sec name="hooks" title="Хуки" error={error}>
      {hooks.map((h, i) => (
        <div key={`${h.event}:${h.matcher ?? ""}:${i}`} className="chat-pn-h2">
          <b>{h.matcher ? `${h.event} · ${h.matcher}` : h.event}</b>
          {h.displayText ? <span>{h.displayText}</span> : null}
        </div>
      ))}
    </Sec>
  );
}

export function Panel({ callsign, close }: { callsign: string; close(): void }) {
  const chat = useModule<Chat>();
  const { data: usage, error: usageWord } = useMethod<Context | null>(callsign, "getContextUsage");
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
          <Btn
            type="button"
            className="chat-mini"
            onClick={() => {
              chat.send(callsign, "/compact", []);
              close();
            }}
          >
            <Archive size={13} />
            Сжать контекст
          </Btn>
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
      <Btn type="button" className="chat-mini" onClick={() => void chat.reloadPlugins(callsign)}>
        <RefreshCw size={13} />
        Перечитать плагины
      </Btn>
    </section>
  );
}
