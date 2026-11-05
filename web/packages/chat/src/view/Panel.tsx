// Панель контекста: разделы из своих методов SDK, по одному запросу на открытие. Метода нет — раздела нет; другой отказ — слово в разделе.
import type { ReactNode } from "react";
import { machineOf } from "@switchboard/protocol";
import { Archive, Gauge, RefreshCw } from "lucide-react";
import { Btn, duration, LIMIT_BAD, LIMIT_NAMES, LIMIT_WARN, LimitRow, Meter, PERM_PLACES, useLoad, useModule } from "@switchboard/web-ui";
import type { Msg } from "../fold.ts";
import type { Chats } from "../store.ts";
import { CONTEXT_PARTS, kilo, sayWord, STATUS_LABELS } from "../words.ts";

const RULE: Record<string, string> = { allow: "можно", deny: "нельзя", ask: "спросить" };
const HIDDEN_STATUS = new Set(["Peer address"]);

/** Ответ метода сессии при открытии панели. */
function useCall<T = Msg>(callsign: string, method: string, args: unknown[] = []) {
  const chats = useModule<Chats>();
  return useLoad<T>(() => chats.read<T>(callsign, method, args), [callsign, method]);
}

/** Раздел панели: пустой и без метода — нет раздела; другой отказ — слово. */
function Section({ id, title, word, machine, children }: { id: string; title?: string; word: string; machine: string; children: ReactNode }) {
  if (word === "unknown_method" || (!word && !children)) return null;
  return (
    <div className="chat-pn-s" data-sec={id}>
      {title ? <h4>{title}</h4> : null}
      {word ? <div className="bad">{sayWord(word, machine)}</div> : children}
    </div>
  );
}

function Usage({ callsign, machine }: { callsign: string; machine: string }) {
  const { data, error } = useCall(callsign, "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET", [{ skipBehaviors: true }]);
  const s = data?.session;
  const windows = Object.entries((data?.rate_limits ?? {}) as Record<string, Msg | null>).filter(([, w]) => w);
  return (
    <Section id="usage" title="Расход" word={error} machine={machine}>
      {data ? (
        <>
          {s ? (
            <dl className="chat-pn-k">
              <dt>Запуск</dt>
              <dd>{`$${Number(s.total_cost_usd ?? 0).toFixed(2).replace(".", ",")}`}</dd>
              <dt>Время API</dt>
              <dd>{duration(s.total_api_duration_ms ?? 0)}</dd>
              <dt>Строки</dt>
              <dd>
                <span className="chat-pn-plus">{`+${s.total_lines_added ?? 0}`}</span> <span className="chat-pn-minus">{`−${s.total_lines_removed ?? 0}`}</span>
              </dd>
            </dl>
          ) : null}
          {windows.map(([name, w]) => (
            <LimitRow key={name} className="chat-pn-w" data-window={name} label={LIMIT_NAMES[name] ?? name} used={Number(w!.utilization ?? 0) / 100} resets={w!.resets_at ? new Date(w!.resets_at).getTime() : undefined} />
          ))}
        </>
      ) : null}
    </Section>
  );
}

function Status({ callsign, machine }: { callsign: string; machine: string }) {
  const { data, error } = useCall(callsign, "getStatus");
  const rows = ((data?.sections ?? []) as Msg[]).flatMap((x) => (x.rows ?? []) as Msg[]).filter((r) => !HIDDEN_STATUS.has(r.label));
  return (
    <Section id="claude" title="Claude" word={error} machine={machine}>
      {rows.length ? (
        <dl className="chat-pn-k">
          {rows.map((r, i) => (
            <div key={i} style={{ display: "contents" }}>
              <dt>{STATUS_LABELS[r.label] ?? r.label}</dt>
              <dd>{String(r.value).replace("connected", "подключено")}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Section>
  );
}

function Rules({ callsign, machine }: { callsign: string; machine: string }) {
  const { data, error } = useCall(callsign, "listPermissionRules");
  const rules = (data?.state?.rules ?? []) as Msg[];
  return (
    <Section id="rules" title="Разрешения" word={error} machine={machine}>
      {rules.length
        ? rules.map((r, i) => (
            <div key={i} className="chat-pn-r" data-behavior={r.behavior}>
              <b>{RULE[r.behavior] ?? r.behavior}</b>
              <span>{r.rule}</span>
              <em>{PERM_PLACES[r.source] ?? r.source}</em>
            </div>
          ))
        : null}
    </Section>
  );
}

function Hooks({ callsign, machine }: { callsign: string; machine: string }) {
  const { data, error } = useCall(callsign, "getHooksListing");
  const hooks = (data?.hooks ?? []) as Msg[];
  return (
    <Section id="hooks" title="Хуки" word={error} machine={machine}>
      {hooks.length
        ? hooks.map((h, i) => (
            <div key={i} className="chat-pn-h2">
              <b>{[h.event, h.matcher].filter(Boolean).join(" · ")}</b>
              {h.displayText ? <span>{h.displayText}</span> : null}
            </div>
          ))
        : null}
    </Section>
  );
}

export function Panel({ callsign, close }: { callsign: string; close(): void }) {
  const chats = useModule<Chats>();
  const machine = machineOf(callsign) ?? "";
  const usage = useCall(callsign, "getContextUsage");
  const agents = useCall<Msg[]>(callsign, "supportedAgents");
  const parts = ((usage.data?.categories ?? []) as Msg[]).filter((c) => c.tokens > 0);
  const pct = Math.round(Number(usage.data?.percentage ?? 0));
  return (
    <section className="chat-panel" aria-label="Контекст">
      {usage.error ? <div className="bad">{sayWord(usage.error, machine)}</div> : null}
      {usage.data ? (
        <>
          <div className="chat-pn-h">
            <Gauge size={14} />
            <b>{usage.data.maxTokens ? `${kilo(usage.data.totalTokens ?? 0)} из ${kilo(usage.data.maxTokens)}` : ""}</b>
            <em>{`${pct}%`}</em>
          </div>
          <Meter value={Math.min(100, pct)} bad={pct >= LIMIT_BAD} warn={pct < LIMIT_BAD && pct >= LIMIT_WARN} />
          {parts.length ? (
            <dl className="chat-pn-l">
              {parts.map((c) => (
                <div key={c.name}>
                  <dt>{CONTEXT_PARTS[c.name] ?? c.name}</dt>
                  <dd>{kilo(c.tokens)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <Btn
            type="button"
            className="chat-mini"
            onClick={() => {
              chats.send(callsign, "/compact");
              close();
            }}
          >
            <Archive size={13} />
            Сжать контекст
          </Btn>
        </>
      ) : null}
      <Usage callsign={callsign} machine={machine} />
      <Status callsign={callsign} machine={machine} />
      <Rules callsign={callsign} machine={machine} />
      <Hooks callsign={callsign} machine={machine} />
      {agents.data?.length ? (
        <dl className="chat-pn-a">
          {agents.data.map((a) => (
            <div key={a.name}>
              <dt>{a.name}</dt>
              <dd>{a.description}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <Btn type="button" className="chat-mini" onClick={() => void chats.reloadPlugins(callsign)}>
        <RefreshCw size={13} />
        Перечитать плагины
      </Btn>
    </section>
  );
}
