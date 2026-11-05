// Панель контекста: заполнение, расход, сведения Claude, правила и хуки, субагенты. Спрашивается при каждом открытии.
import { useEffect, useState, type ReactNode } from "react";
import { Btn, LIMIT_BAD, LIMIT_NAMES, LIMIT_WARN, LimitRow, Meter, PERM_PLACES, duration, useModule, type Result } from "@switchboard/web-ui";
import type { Talks } from "../talk.ts";
import { contextPart, kilo, money, refusal, RULE_WORDS, statusLabel } from "../words.ts";
import { useEnv } from "./env.ts";
import { Icon } from "./icons.tsx";

type Any = Record<string, any>;
const METHODS: Array<[string, unknown[]]> = [
  ["getContextUsage", []],
  ["supportedAgents", []],
  ["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET", [{ skipBehaviors: true }]],
  ["getStatus", []],
  ["getHooksListing", []],
  ["listPermissionRules", []],
];

/** Раздел: метода нет — раздела нет; отказ — слово; пусто — раздела нет. */
function Sec({ id, title, r, children }: { id: string; title: string; r?: Result<Any>; children: (x: Any) => ReactNode }) {
  if (!r || (!r.ok && r.error === "unknown_method")) return null;
  const body = r.ok ? children(r.result ?? {}) : <div className="bad">{refusal(r.error)}</div>;
  if (!body) return null;
  return (
    <div className="chat-pn-s" data-sec={id}>
      <h4>{title}</h4>
      {body}
    </div>
  );
}

export function Panel({ close }: { close(): void }) {
  const env = useEnv();
  const talks = useModule<Talks>();
  const [got, setGot] = useState<Record<string, Result<Any>>>({});
  useEffect(() => {
    for (const [m, args] of METHODS) void talks.call<Any>(env.cs, m, args, true).then((r) => setGot((g) => ({ ...g, [m]: r })));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ctx = got.getContextUsage;
  const agents = got.supportedAgents?.ok && Array.isArray(got.supportedAgents.result) ? (got.supportedAgents.result as Any[]) : [];
  return (
    <section className="chat-panel" aria-label="Контекст">
      {ctx && !ctx.ok && <div className="bad">{refusal(ctx.error)}</div>}
      {ctx?.ok && (
        <>
          <div className="chat-pn-h">
            <Icon name="gauge" size={14} />
            {ctx.result.totalTokens !== undefined && <b>{`${kilo(ctx.result.totalTokens)} из ${kilo(ctx.result.maxTokens ?? 0)}`}</b>}
            <em>{`${Math.round(ctx.result.percentage ?? 0)}%`}</em>
          </div>
          <Meter value={Math.min(100, ctx.result.percentage ?? 0)} warn={ctx.result.percentage >= LIMIT_WARN && ctx.result.percentage < LIMIT_BAD} bad={ctx.result.percentage >= LIMIT_BAD} />
          <dl className="chat-pn-l">
            {((ctx.result.categories ?? []) as Any[])
              .filter((c) => c.tokens > 0)
              .map((c) => (
                <div key={c.name}>
                  <dt>{contextPart(c.name)}</dt>
                  <dd>{kilo(c.tokens)}</dd>
                </div>
              ))}
          </dl>
        </>
      )}
      <Sec id="usage" title="Расход" r={got.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET}>
        {(u) => (
          <>
            {u.session && (
              <div className="chat-pn-h2">
                <b>{`${money(u.session.total_cost_usd ?? 0)}${u.session.total_api_duration_ms ? ` · ${duration(u.session.total_api_duration_ms)} API` : ""}`}</b>
                <span>
                  <span className="chat-pn-plus">{`+${u.session.total_lines_added ?? 0}`}</span> <span className="chat-pn-minus">{`−${u.session.total_lines_removed ?? 0}`}</span>
                </span>
              </div>
            )}
            {Object.entries((u.rate_limits ?? {}) as Record<string, Any | null>)
              .filter(([, w]) => w)
              .map(([name, w]) => (
                <LimitRow key={name} className="chat-pn-w" data-window={name} label={LIMIT_NAMES[name] ?? name} used={(w!.utilization ?? 0) / 100} resets={w!.resets_at ? Date.parse(w!.resets_at) : undefined} />
              ))}
          </>
        )}
      </Sec>
      <Sec id="claude" title="Claude" r={got.getStatus}>
        {(s) => {
          const rows = ((s.sections ?? []) as Any[]).flatMap((x) => (x.rows ?? []) as Any[]).filter((x) => x.label !== "Peer address");
          return rows.length ? (
            <dl className="chat-pn-k">
              {rows.map((x, i) => (
                <div key={i} style={{ display: "contents" }}>
                  <dt>{statusLabel(x.label)}</dt>
                  <dd>{String(x.value ?? "").replace(/\bconnected\b/g, "подключено")}</dd>
                </div>
              ))}
            </dl>
          ) : null;
        }}
      </Sec>
      <Sec id="rules" title="Разрешения" r={got.listPermissionRules}>
        {(x) => {
          const rules = (x.state?.rules ?? []) as Any[];
          return rules.length
            ? rules.map((r, i) => (
                <div key={i} className="chat-pn-r" data-behavior={r.behavior}>
                  <b>{RULE_WORDS[r.behavior] ?? r.behavior}</b>
                  <span>{r.rule}</span>
                  <em>{PERM_PLACES[r.source] ?? r.source}</em>
                </div>
              ))
            : null;
        }}
      </Sec>
      <Sec id="hooks" title="Хуки" r={got.getHooksListing}>
        {(x) => {
          const hooks = (x.hooks ?? []) as Any[];
          return hooks.length
            ? hooks.map((h, i) => (
                <div key={i} className="chat-pn-h2">
                  <b>{[h.event, h.matcher].filter(Boolean).join(" · ")}</b>
                  {(h.displayText ?? h.command) && <span>{h.displayText ?? h.command}</span>}
                </div>
              ))
            : null;
        }}
      </Sec>
      {agents.length > 0 && (
        <dl className="chat-pn-a">
          {agents.map((a) => (
            <div key={a.name}>
              <dt>{a.name}</dt>
              <dd>{a.description}</dd>
            </div>
          ))}
        </dl>
      )}
      <div>
        <Btn
          type="button"
          className="chat-mini"
          onClick={() => {
            talks.send(env.cs, "/compact", []);
            close();
          }}
        >
          <Icon name="archive" />
          Сжать контекст
        </Btn>{" "}
        <Btn
          type="button"
          className="chat-mini"
          onClick={() => {
            env.act("reloadPlugins", []);
            talks.edit(env.cs, (t) => void (t.commands = undefined));
          }}
        >
          <Icon name="refresh-cw" />
          Перечитать плагины
        </Btn>
      </div>
    </section>
  );
}
