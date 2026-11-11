// «Правила модели»: правила замены прокси — ключ proxy.rules в области флота prefs (prefs.changed доводит их до прокси).
// Правка идёт прямо в наборе и сразу проверяется тем же пакетом правил rules, что у прокси: на тексте или на запросе вызова из архива (points.history: system — из api-request-shape, сообщения — записи до вызова).
// Сохранение — одно, всего набора.
import { useEffect, useMemo, useState } from "react";
import { Area, Btn, Chip, Chips, CopyButton, In, M, Note, Opts, Pill, Sec, Switch, TextBtn, useApp, useLoad } from "@switchboard/web-ui";

import { applyRules, flawOf, type Rule, type Scope } from "@switchboard/rules";
import { diffLines, type DiffLine } from "./diff.ts";

type Msg = { type: string; uuid: string; parent_tool_use_id?: string; message: { content: unknown } };
type Call = { uuid: string; at: string; model: string; tok_in: number; tok_out: number; system: string };
type Called = { call: Call; sid: string; title: string; callsign: string; system: string; messages: Array<{ role: string; text: string }> };

/** Блоки записи по видам: текст, ответ инструмента. */
function partsOf(m: Msg, kind: "text" | "tool_result"): string {
  const c = m.message.content;
  if (typeof c === "string") return kind === "text" ? c : "";
  if (!Array.isArray(c)) return "";
  return (c as Array<{ type: string; text?: string; content?: unknown }>)
    .filter((b) => b.type === kind)
    .map((b) => (kind === "text" ? (b.text ?? "") : typeof b.content === "string" ? b.content : JSON.stringify(b.content)))
    .join("\n");
}

/** Запрос вызова: «sid/uuid» — записи разговора до ответа модели и system вызова; имя сессии — из каталога архива. */
async function readCall(app: ReturnType<typeof useApp>, id: string) {
  const [sid, uuid] = id.split("/");
  if (!sid || !uuid) return { ok: false as const, error: "bad_call" };
  const [r, cat] = await Promise.all([app.read<{ messages: Msg[]; calls: Call[] }>("points.history", { sid, before: uuid, limit: 400 }), app.read<{ sessions: Array<{ sid: string; title: string; callsign?: string }> }>("points.list", {})]);
  if (!r.ok) return r;
  const s = cat.ok ? cat.result.sessions.find((x) => x.sid === sid) : undefined;
  const call = r.result.calls.find((c) => c.uuid === uuid);
  if (!call) return { ok: false as const, error: "no_call" };
  const main = r.result.messages.filter((m) => !m.parent_tool_use_id);
  const messages = main.flatMap((m) => {
    const text = partsOf(m, "text");
    const tool = partsOf(m, "tool_result");
    return [...(text ? [{ role: m.type, text }] : []), ...(tool ? [{ role: "tool_result", text: tool }] : [])];
  });
  return { ok: true as const, result: { call, sid, title: s?.title ?? "", callsign: s?.callsign ?? sid, system: call.system, messages } satisfies Called };
}

const KEY = "proxy.rules";
const SCOPES: Array<[string, string]> = [["system", "system"], ["user", "user"], ["assistant", "assistant"], ["tool_result", "tool_result"]];
const UNITS: Array<[Rule["unit"], string]> = [["match", "совпадение"], ["line", "строка"], ["paragraph", "абзац"], ["block", "весь блок"]];
const BLANK: Rule = { name: "", on: true, scopes: ["system"], kind: "literal", unit: "paragraph", action: "replace", pattern: "", replacement: "" };
const unitName = (u: Rule["unit"]) => UNITS.find(([k]) => k === u)![1];
/** Что не даёт сохранить правило — словами. */
const flaw = (r: Rule) => (!r.name.trim() ? "без имени" : flawOf(r));

function Editor({ rule, set }: { rule: Rule; set(p: Partial<Rule>): void }) {
  const bad = rule.pattern ? flawOf(rule) : "";
  return (
    <Sec data-rule-editor="">
      <In data-f="rname" aria-label="Имя правила" placeholder="имя правила" value={rule.name} onInput={(e) => set({ name: e.currentTarget.value })} />
      <Chips>
        {SCOPES.map(([k, n]) => (
          <Chip key={k} on={rule.scopes.includes(k)} onClick={() => set({ scopes: rule.scopes.includes(k) ? rule.scopes.filter((x) => x !== k) : [...rule.scopes, k] })}>
            {n}
          </Chip>
        ))}
      </Chips>
      <Opts>
        <Chips>
          <Chip on={rule.kind === "literal"} onClick={() => set({ kind: "literal" })}>
            текст
          </Chip>
          <Chip on={rule.kind === "regex"} onClick={() => set({ kind: "regex" })}>
            регулярка
          </Chip>
        </Chips>
        <Chips data-f="unit" aria-label="Что править">
          {UNITS.map(([k, n]) => (
            <Chip key={k} on={rule.unit === k} onClick={() => set({ unit: k })}>
              {n}
            </Chip>
          ))}
        </Chips>
        <Chips>
          <Chip on={rule.action === "replace"} onClick={() => set({ action: "replace" })}>
            заменить
          </Chip>
          <Chip on={rule.action === "delete"} onClick={() => set({ action: "delete" })}>
            удалить
          </Chip>
        </Chips>
      </Opts>
      <Area data-f="pattern" className="pr-mono" rows={2} aria-label="Что искать" placeholder="что искать" value={rule.pattern} onInput={(e) => set({ pattern: e.currentTarget.value })} />
      {bad && (
        <Note tone="bad" role="alert">
          {bad}
        </Note>
      )}
      {rule.action === "replace" && <Area data-f="replacement" className="pr-mono" rows={2} aria-label="Чем заменить" placeholder="чем заменить" value={rule.replacement ?? ""} onInput={(e) => set({ replacement: e.currentTarget.value })} />}
    </Sec>
  );
}

/** Разница: только изменённые строки и по строке вокруг них. */
function Diff({ lines }: { lines: DiffLine[] }) {
  const near = (i: number) => lines.slice(Math.max(0, i - 1), i + 2).some((x) => x.kind !== "same");
  const shown = lines.map((x, i) => ({ ...x, i })).filter((x) => x.kind !== "same" || near(x.i));
  return (
    <pre className="pr-diff" data-diff="">
      {shown.map((x, k) => (
        <span key={x.i} className={`pr-d ${x.kind}`}>
          {k > 0 && shown[k - 1].i !== x.i - 1 ? "⋯\n" : ""}
          {`${x.kind === "add" ? "+ " : x.kind === "del" ? "− " : "  "}${x.text}\n`}
        </span>
      ))}
    </pre>
  );
}

/** Проверка черновика: на своём тексте или на вызове из архива — текст вызова по выбранной роли виден целиком. */
function Tester({ rules, call: start }: { rules: Rule[]; call?: string }) {
  const app = useApp();
  const [text, setText] = useState("");
  const [call, setCall] = useState(start ?? "");
  const [scope, setScope] = useState("system");
  const read = useLoad<Called | null>(() => (call ? readCall(app, call) : Promise.resolve({ ok: true as const, result: null })), [call]);
  const c = read.data;
  const source = c ? (scope === "system" ? c.system : c.messages.filter((m) => m.role === scope).map((m) => m.text).join("\n\n")) : text;
  const out = useMemo(() => (source ? applyRules(rules, scope as Scope, source) : null), [rules, scope, source]);
  const lines = useMemo(() => (out && source ? diffLines(source, out.after) : []), [out, source]);
  const when = (at: string) => new Date(at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <Sec data-rule-test="">
      <b>Проверка</b>
      {c ? (
        <Opts className="pr-src">
          {/* назад — история браузера: сюда приходят со страницы сессии, а экран «Сессий» настройкам не зависимость — иначе цикл */}
          <TextBtn data-f="back" onClick={() => history.back()}>
            {`← ${c.title || c.callsign}`}
          </TextBtn>
          <span className="pr-call">
            <M>{c.callsign}</M>
            {` · ${when(c.call.at)} · ${c.call.model.replace(/^claude-/, "")}`}
          </span>
          <Btn onClick={() => setCall("")}>Свой текст</Btn>
        </Opts>
      ) : null}
      {read.error ? (
        <Note tone="bad" role="alert">
          Вызова нет в архиве
        </Note>
      ) : null}
      <Chips data-f="tscope" aria-label="Где">
        {SCOPES.map(([k, n]) => (
          <Chip key={k} on={scope === k} onClick={() => setScope(k)}>
            {n}
          </Chip>
        ))}
      </Chips>
      {c ? (
        source ? (
          <div className="pr-sys">
            <CopyButton text={source} label="Копировать" />
            <pre data-source={scope}>{source}</pre>
          </div>
        ) : (
          <Note>{`В этом вызове нет ${scope}`}</Note>
        )
      ) : (
        <Area data-f="ttext" className="pr-mono" rows={4} aria-label="Текст" placeholder="текст запроса" value={text} onInput={(e) => setText(e.currentTarget.value)} />
      )}
      {out && (
        <Opts>
          {Object.entries(out.hits).map(([n, k]) => (
            <Pill key={n} tone="ok">{`${n} · ${k}`}</Pill>
          ))}
          {!Object.keys(out.hits).length && <Pill>ни одно правило не сработало</Pill>}
        </Opts>
      )}
      {out && Object.keys(out.hits).length > 0 && <Diff lines={lines} />}
    </Sec>
  );
}

export function ProxyRulesTab({ call }: { call?: string }) {
  const app = useApp();
  const stored = useLoad(() => app.read<{ values: Record<string, unknown> }>("prefs.get", { scope: "global", prefix: "proxy." }), []);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [edit, setEdit] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [word, setWord] = useState("");
  useEffect(() => {
    if (stored.data && rules === null) setRules((stored.data.values[KEY] as Rule[] | undefined) ?? []);
  }, [stored.data, rules]);
  const change = (next: Rule[]) => (setRules(next), setDirty(true));
  const flawed = (rules ?? []).some((r) => flaw(r));
  async function save() {
    const r = await app.request("prefs.set", { scope: "global", name: KEY, value: rules });
    if (!r.ok) return setWord(r.error === "denied" ? "Правила модели меняет владелец флота" : `Не сохранилось: ${r.why ?? r.error}`);
    setWord("");
    setDirty(false);
    app.toast("Правила сохранены — прокси машин перечитают их", "ok");
  }
  const move = (i: number, by: number) => {
    const next = [...rules!];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    change(next);
    if (edit === i) setEdit(i + by);
  };
  if (stored.error) return <Note tone="bad">{`Правила не загрузились: ${stored.error}`}</Note>;
  if (!rules) return <Note>…</Note>;
  return (
    <>
      <Opts>
        <Btn onClick={() => (change([...rules, { ...BLANK }]), setEdit(rules.length))}>＋ правило</Btn>
        <Btn pri disabled={!dirty || flawed} onClick={() => void save()}>
          Сохранить
        </Btn>
      </Opts>
      {word && (
        <Note tone="bad" role="alert">
          {word}
        </Note>
      )}
      <Sec data-rules="">
        {!rules.length && "Правил нет."}
        {rules.map((r, i) => (
          <div key={i} className="pr-item">
            <div className="pr-row" data-rule={r.name}>
              <Switch on={r.on !== false} aria-label={`Включить ${r.name}`} onClick={() => change(rules.map((y, j) => (j === i ? { ...y, on: y.on === false } : y)))} />
              <b>{r.name || "новое правило"}</b>
              <span className="pr-scopes">{r.scopes.join(" · ")}</span>
              <M>{`${unitName(r.unit)} · ${r.action === "delete" ? "удалить" : "заменить"}`}</M>
              <span className="pr-acts">
                <Btn ghost disabled={i === 0} aria-label="Выше" onClick={() => move(i, -1)}>
                  ↑
                </Btn>
                <Btn ghost disabled={i === rules.length - 1} aria-label="Ниже" onClick={() => move(i, 1)}>
                  ↓
                </Btn>
                <Btn aria-expanded={edit === i} onClick={() => setEdit(edit === i ? null : i)}>
                  {edit === i ? "Свернуть" : "Изменить"}
                </Btn>
                <Btn bad onClick={() => (change(rules.filter((_, j) => j !== i)), setEdit(null))}>
                  Удалить
                </Btn>
              </span>
            </div>
            {edit === i && <Editor rule={r} set={(p) => change(rules.map((y, j) => (j === i ? { ...y, ...p } : y)))} />}
          </div>
        ))}
      </Sec>
      <Tester rules={rules} call={call} />
    </>
  );
}
