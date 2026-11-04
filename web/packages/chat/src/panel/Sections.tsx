// Разделы панели контекста: расход и лимиты, сведения claude, хуки. Метода нет на Host — раздела нет; другой отказ — слово в разделе.
import type { ReactNode } from "react";
import { LIMIT_NAMES, LimitRow, useLoad } from "@switchboard/web-ui";
import { duration, money } from "../cards/format.ts";
import { useChat } from "../context.ts";

const USAGE = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

type Usage = {
  session?: { total_cost_usd?: number; total_api_duration_ms?: number; total_lines_added?: number; total_lines_removed?: number };
  rate_limits?: Record<string, { utilization?: number; resets_at?: string | null } | null> | null;
};
type Status = { sections?: Array<{ title: string; rows?: Array<{ label: string; value: string }> }> };
type Hook = { event: string; matcher?: string; displayText?: string };

/** Подписи строк /status. */
const STATUS: Record<string, string> = { Version: "Версия", "Session name": "Имя", "Session ID": "Номер", "Session kind": "Вид", cwd: "Папка", "Login method": "Вход", Organization: "Организация", Email: "Почта", Model: "Модель", "MCP servers": "MCP", "Setting sources": "Настройки", Memory: "Память" };
/** Служебные строки /status: человеку не нужны. */
const HIDDEN = new Set(["Peer address"]);

/** Раздел одного метода: ответ — children, unknown_method — ничего, отказ — слово. */
function useMethod<T>(callsign: string, method: string, args: unknown[] = []) {
  const chat = useChat();
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

export function UsageSection({ callsign }: { callsign: string }) {
  const { data, error } = useMethod<Usage>(callsign, USAGE, [{ skipBehaviors: true }]);
  const s = data?.session;
  const windows = Object.entries(data?.rate_limits ?? {}).filter(([, w]) => w && typeof w.utilization === "number");
  return (
    <Sec name="usage" title="Расход" error={error}>
      {s ? (
        <dl className="chat-pn-k">
          <dt>Запуск</dt>
          <dd>{money(s.total_cost_usd ?? 0)}</dd>
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

export function AboutSection({ callsign }: { callsign: string }) {
  const { data, error } = useMethod<Status>(callsign, "getStatus");
  const rows = (data?.sections ?? []).flatMap((s) => (s.rows ?? []).filter((r) => !HIDDEN.has(r.label)).map((r) => ({ ...r, key: `${s.title}:${r.label}` })));
  if (!error && !rows.length) return null;
  return (
    <Sec name="claude" title="Claude" error={error}>
      <dl className="chat-pn-k">
        {rows.map((r) => (
          <div key={r.key} style={{ display: "contents" }}>
            <dt>{STATUS[r.label] ?? r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </Sec>
  );
}

export function HooksSection({ callsign }: { callsign: string }) {
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
