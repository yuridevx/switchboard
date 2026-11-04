// Форма MCP-сервера: поля по схеме или ссылка. Значения — местное состояние формы; число идёт в ответ числом.
import { useState } from "react";
import { Cta, Btn, Sel, In } from "@switchboard/web-ui";
import { useAsk } from "./store.ts";
import { isLocked, type Rec } from "./store.ts";

type Field = { type?: string; enum?: string[]; title?: string; description?: string };
const isNumber = (p: Field) => p.type === "number" || p.type === "integer";

export function AskForm({ rec }: { rec: Rec }) {
  const ask = useAsk();
  // в поле числа значение — текстом, как набрано: «1.» посреди ввода числом не держится
  const [vals, setVals] = useState<Record<string, string | boolean | undefined>>({});
  const f = rec.frame;
  const url = typeof f.url === "string" ? f.url : null;
  const props = (f.schema as { properties?: Record<string, Field> } | undefined)?.properties ?? {};
  const locked = isLocked(rec);
  const sending = rec.status === "sending";
  const set = (k: string, v: string | boolean | undefined) => setVals((old) => ({ ...old, [k]: v }));

  function content(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vals)) out[k] = props[k] && isNumber(props[k]) ? Number(v) : v;
    return out;
  }

  return (
    <>
      <div className="ask-q">
        <div className="ask-qt">{String(f.message ?? "Форма")}</div>
        {url ? (
          <a className="ask-url" href={url} target="_blank" rel="noopener">
            {url}
          </a>
        ) : (
          Object.entries(props).map(([k, p]) => (
            <label key={k} className="ask-field">
              <span>{p.title ?? k}</span>
              {p.enum ? (
                <Sel className="ask-own" disabled={locked} value={typeof vals[k] === "string" ? vals[k] : ""} onChange={(e) => set(k, e.currentTarget.value || undefined)}>
                  <option value="">—</option>
                  {p.enum.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </Sel>
              ) : p.type === "boolean" ? (
                <input type="checkbox" disabled={locked} checked={vals[k] === true} onChange={(e) => set(k, e.currentTarget.checked)} />
              ) : (
                <In className="ask-own" type={isNumber(p) ? "number" : "text"} disabled={locked} value={typeof vals[k] === "string" ? vals[k] : ""} onInput={(e) => set(k, e.currentTarget.value)} />
              )}
              {p.description ? <small>{p.description}</small> : null}
            </label>
          ))
        )}
      </div>
      {!locked || sending ? (
        <>
          <Cta disabled={sending} onClick={() => void ask.answer(rec, url ? { action: "accept" } : { action: "accept", content: content() })}>
            {url ? "Перешёл" : "Отправить"}
          </Cta>
          <Btn className="ask-decline" disabled={sending} onClick={() => void ask.answer(rec, { action: "decline" })}>
            Отклонить
          </Btn>
        </>
      ) : null}
    </>
  );
}
