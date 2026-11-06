// Панель контекста: разделы из своих методов SDK, по одному запросу на открытие. Метода нет — раздела нет; другой отказ — слово в разделе.
import { useEffect, useState, type ReactNode } from "react";
import { machineOf } from "@switchboard/protocol";
import { Btn, duration, LIMIT_BAD, LIMIT_NAMES, LIMIT_WARN, LimitRow, Meter, PERM_PLACES, useModule, type Result } from "@switchboard/web-ui";
import type { Talks } from "../talk.ts";
import { CONTEXT_PARTS, kilo, sayWord, STATUS_LABELS } from "../words.ts";
import { Icon } from "./icons.tsx";

type Any = Record<string, any>;
const RULE: Record<string, string> = { allow: "можно", deny: "нельзя", ask: "спросить" };
const HIDDEN_STATUS = new Set(["Peer address"]);
const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";
const METHODS: Array<[string, unknown[]]> = [["getContextUsage", []], ["supportedAgents", []], [USAGE, [{ skipBehaviors: true }]], ["getStatus", []], ["getHooksListing", []], ["listPermissionRules", []]];

/** Раздел панели: пустой и без метода — нет раздела; другой отказ — слово. */
function Section({ id, title, r, machine, children }: { id: string; title: string; r?: Result<Any>; machine: string; children(x: Any): ReactNode }) {
  if (!r || (!r.ok && r.error === "unknown_method")) return null;
  const body = r.ok ? children(r.result ?? {}) : <div className="bad">{sayWord(r.error, machine)}</div>;
  if (!body) return null;
  return (
    <div className="chat-pn-s" data-sec={id}>
      <h4>{title}</h4>
      {body}
    </div>
  );
}

function usage(u: Any) {
  const s = u.session;
  const windows = Object.entries((u.rate_limits ?? {}) as Record<string, Any | null>).filter(([, w]) => w);
  return (
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
  );
}

function status(x: Any) {
  const rows = ((x.sections ?? []) as Any[]).flatMap((s) => (s.rows ?? []) as Any[]).filter((r) => !HIDDEN_STATUS.has(r.label));
  if (!rows.length) return null;
  return (
    <dl className="chat-pn-k">
      {rows.flatMap((r, i) => [<dt key={`t${i}`}>{STATUS_LABELS[r.label] ?? r.label}</dt>, <dd key={`d${i}`}>{String(r.value).replace("connected", "подключено")}</dd>])}
    </dl>
  );
}

function rules(x: Any) {
  const list = (x.state?.rules ?? []) as Any[];
  if (!list.length) return null;
  return list.map((r, i) => (
    <div key={i} className="chat-pn-r" data-behavior={r.behavior}>
      <b>{RULE[r.behavior] ?? r.behavior}</b>
      <span>{r.rule}</span>
      <em>{PERM_PLACES[r.source] ?? r.source}</em>
    </div>
  ));
}

function hooks(x: Any) {
  const list = (x.hooks ?? []) as Any[];
  if (!list.length) return null;
  return list.map((h, i) => (
    <div key={i} className="chat-pn-h2">
      <b>{[h.event, h.matcher].filter(Boolean).join(" · ")}</b>
      {h.displayText ? <span>{h.displayText}</span> : null}
    </div>
  ));
}

export function Panel({ cs, close }: { cs: string; close(): void }) {
  const talks = useModule<Talks>();
  const [got, setGot] = useState<Record<string, Result<Any>>>({});
  const machine = machineOf(cs)!;
  useEffect(() => {
    let live = true;
    for (const [m, args] of METHODS)
      void talks.read<Any>(cs, m, args).then((r) => {
        if (live) setGot((g) => ({ ...g, [m]: r }));
      });
    return () => {
      live = false;
    };
  }, [cs]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctx = got.getContextUsage;
  const data = ctx?.ok ? ctx.result : undefined;
  const parts = ((data?.categories ?? []) as Any[]).filter((c) => c.tokens > 0);
  const pct = Math.round(Number(data?.percentage ?? 0));
  const agents = got.supportedAgents?.ok && Array.isArray(got.supportedAgents.result) ? (got.supportedAgents.result as Any[]) : [];
  return (
    <section className="chat-panel" aria-label="Контекст">
      {ctx && !ctx.ok ? <div className="bad">{sayWord(ctx.error, machine)}</div> : null}
      {data ? (
        <>
          <div className="chat-pn-h">
            <Icon name="gauge" size={14} />
            <b>{data.maxTokens ? `${kilo(data.totalTokens ?? 0)} из ${kilo(data.maxTokens)}` : ""}</b>
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
              talks.send(cs, "/compact", []);
              close();
            }}
          >
            <Icon name="archive" />
            Сжать контекст
          </Btn>
        </>
      ) : null}
      <Section id="usage" title="Расход" r={got[USAGE]} machine={machine}>
        {usage}
      </Section>
      <Section id="claude" title="Claude" r={got.getStatus} machine={machine}>
        {status}
      </Section>
      <Section id="rules" title="Разрешения" r={got.listPermissionRules} machine={machine}>
        {rules}
      </Section>
      <Section id="hooks" title="Хуки" r={got.getHooksListing} machine={machine}>
        {hooks}
      </Section>
      {agents.length ? (
        <dl className="chat-pn-a">
          {agents.map((a) => (
            <div key={a.name}>
              <dt>{a.name}</dt>
              <dd>{a.description}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <Btn type="button" className="chat-mini" onClick={() => void talks.reload(cs)}>
        <Icon name="refresh-cw" />
        Перечитать сессию
      </Btn>
    </section>
  );
}
