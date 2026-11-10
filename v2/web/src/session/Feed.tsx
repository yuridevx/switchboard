// Лента разговора: строки свёртки. Вызовы инструментов — одной строкой с сутью, раскрываются по клику.
// Живой ответ идёт с кареткой, размышление сворачивается, своё сообщение показывает свой статус.
import { CopyButton, Text } from "@mantine/core";
import {
  IconAlertTriangle, IconArchive, IconBook, IconBrain, IconChecklist, IconClipboardList, IconFile, IconFilePencil, IconFilePlus, IconFileText, IconFolderSearch, IconInfoCircle,
  IconMessageQuestion, IconPlayerStop, IconRefresh, IconRobot, IconSearch, IconSparkles, IconTerminal2, IconTool, IconWorld,
} from "@tabler/icons-react";
import { createContext, lazy, memo, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import type { Item } from "../chat/focus.ts";
import { todoProgress, type MeState, type Part, type Row, type Task, type Todo, type Tool, type View } from "../chat/fold.ts";
import { agentSteps, deniedWhy, editStat, isAgent, isDenied, isShell, startedInBackground, toolLook, toolState } from "../chat/tools.ts";
import { nActions, plural } from "../lib/time.ts";
import { HtmlFrame, looksHtml } from "./html.tsx";
import "./session.css";

const Markdown = lazy(() => import("./Markdown.tsx"));
export const Md = ({ text }: { text: string }) => (
  <Suspense fallback={<div className="md" style={{ whiteSpace: "pre-wrap" }}>{text}</div>}>
    <Markdown text={text} />
  </Suspense>
);

/** Что лента может сделать с сессией: в архиве и у сессии без связи — ничего. */
export type FeedEnv = {
  canAct: boolean;
  /** человек у страницы: чужое сообщение подписано отправителем */
  me?: string;
  /** метод SDK живой сессии: «В фон», «Стоп» */
  act?(method: "tasks" | "taskStop", args: unknown[]): void;
  cancel?(id: string): void;
  resend?(id: string): void;
  drop?(id: string): void;
  /** вернуть текст в поле ввода */
  edit?(text: string): void;
  /** номер вызова инструмента, который ждёт решения человека */
  waiting?: string;
  /** как звать отправителя: имя сессии из настроек */
  name?(addr: string): string;
};
const Env = createContext<FeedEnv>({ canAct: false });
export const FeedEnvProvider = Env.Provider;

const ICONS: Record<string, typeof IconTool> = {
  terminal: IconTerminal2, "file-pen": IconFilePencil, "file-plus": IconFilePlus, "file-text": IconFileText, search: IconSearch, "folder-search": IconFolderSearch, globe: IconWorld,
  "list-checks": IconChecklist, bot: IconRobot, sparkles: IconSparkles, "message-circle-question": IconMessageQuestion, "clipboard-list": IconClipboardList, square: IconPlayerStop,
  "refresh-cw": IconRefresh, archive: IconArchive, info: IconInfoCircle, "book-open": IconBook,
};
const Icon = ({ name, size = 15 }: { name?: string; size?: number }) => {
  const I = (name && ICONS[name]) || IconTool;
  return <I size={size} stroke={1.7} style={{ flex: "none" }} />;
};

const Pics = ({ pics }: { pics: string[] }) => <>{pics.map((p, i) => <img key={i} className="pic" src={p} alt="" />)}</>;

/** Длинный текст свёрнут до первых строк. */
const LONG = 900;
function Long({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  if (text.length <= LONG || all) return <>{text}</>;
  return <>{text.slice(0, LONG)}… <button type="button" className="linkbtn" onClick={() => setAll(true)}>показать всё</button></>;
}

/** Вопрос модели человеку и то, что на него ответили. */
function Asked({ tool }: { tool: Tool }) {
  const qs = ((tool.input?.questions ?? []) as Array<{ question?: string; options?: Array<{ label?: string }> }>);
  const said = tool.result && !tool.result.error ? tool.result.text : "";
  return (
    <>
      {qs.map((q, i) => <Text key={i} size="sm">{q.question}</Text>)}
      {tool.result ? <Text size="sm" fw={600}>{isDenied(tool) ? `отклонено${deniedWhy(tool) ? `: ${deniedWhy(tool)}` : ""}` : `отвечено: ${said.replace(/^User has answered your questions:\s*/, "").slice(0, 400)}`}</Text> : <Text size="sm" className="muted">ждёт ответа</Text>}
    </>
  );
}

function ToolBody({ tool, view }: { tool: Tool; view: View }) {
  const look = toolLook(tool);
  const input = tool.input ?? {};
  const out = tool.result?.text;
  const pics = tool.result?.pics ?? [];
  const [html, setHtml] = useState(false);
  let body: ReactNode;
  if (look.body === "command") body = <><pre>{String(input.command ?? "")}</pre>{out && <pre>{out}</pre>}</>;
  else if (look.body === "diff") {
    const text = String(input.new_string ?? input.content ?? "");
    const page = tool.name === "Write" && looksHtml(/\.html?$/i.test(String(input.file_path ?? "")) ? "html" : "", text);
    body = (
      <>
        {page && <button type="button" className="linkbtn" aria-pressed={html} onClick={() => setHtml((v) => !v)}>{html ? "Код" : "Просмотр"}</button>}
        {html ? <HtmlFrame html={text} title={String(input.file_path ?? "")} /> : <>{input.old_string != null && <pre className="diff-old">{String(input.old_string)}</pre>}<pre className="diff-new">{text}</pre></>}
      </>
    );
  } else if (look.body === "read") body = out ? <Md text={"```" + (/\.(\w+)$/.exec(String(input.file_path ?? ""))?.[1] ?? "") + "\n" + out.replace(/^\s*\d+[→\t]/gm, "") + "\n```"} /> : null;
  else if (look.body === "todos") body = <TodoList todos={(input.todos as Todo[]) ?? []} />;
  else if (look.body === "agent") body = <>{input.prompt && <pre>{String(input.prompt)}</pre>}<Rows rows={tool.steps} view={view} />{out && <Md text={out} />}</>;
  else if (look.body === "plan") body = <Md text={String(input.plan ?? "")} />;
  else if (look.body === "ask") body = <Asked tool={tool} />;
  else body = <>{look.body === "plain" && Object.keys(input).length > 0 && <pre>{JSON.stringify(input, null, 2)}</pre>}{out && <pre>{out}</pre>}</>;
  return <>{isDenied(tool) && look.body !== "ask" && <Text size="sm" fw={600}>Отклонено{deniedWhy(tool) ? `: ${deniedWhy(tool)}` : ""}</Text>}{body}<Pics pics={pics} /></>;
}

export function TodoList({ todos }: { todos: Todo[] }) {
  const p = todoProgress(todos);
  return (
    <div className="todos">
      <span className="muted" style={{ fontSize: 12 }}>{p.done} из {p.of}</span>
      {todos.map((t, i) => (
        <span key={i} className={t.status === "completed" ? "done" : ""} style={t.status === "in_progress" ? { fontWeight: 600 } : undefined}>
          {t.status === "completed" ? "✓ " : t.status === "in_progress" ? "▸ " : "○ "}{t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}
        </span>
      ))}
    </div>
  );
}

/** Секунды идущего инструмента: что сказал SDK, дальше — по часам страницы. */
function Running({ secs }: { secs?: number }) {
  const [n, setN] = useState(secs ?? 0);
  useEffect(() => setN(secs ?? 0), [secs]);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return n >= 3 ? <span className="muted">идёт {n} с</span> : null;
}

const STATE_WORD: Record<string, string> = { denied: "отклонено", error: "ошибка", stopped: "остановлено", bg: "в фоне", wait: "ждёт вас" };

function ToolLine({ tool, view }: { tool: Tool; view: View }) {
  const env = useContext(Env);
  const look = toolLook(tool);
  const [open, setOpen] = useState(false);
  const task: Task | undefined = tool.task ? view.tasks[tool.task] : undefined;
  const state = toolState(tool, task, env.waiting === tool.id);
  const stat = editStat(tool);
  const running = state === "running";
  const steps = isAgent(tool) ? agentSteps(tool, task) : 0;
  const bg = state === "bg" || startedInBackground(tool, task);
  return (
    <div>
      <div className="toolrow">
        <button type="button" className="tool" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className={`st ${state}`} />
          <Icon name={look.icon} />
          <span className="w">{look.word}</span>
          <span className="trunc muted mono">{look.sum}</span>
          {stat && (stat.plus > 0 || stat.minus > 0) && <span className="stat-pm"><b className="plus">+{stat.plus}</b> <b className="minus">−{stat.minus}</b></span>}
          {steps > 0 && <span className="muted">{steps} {plural(steps, "шаг", "шага", "шагов")}</span>}
          {running && <Running secs={tool.secs} />}
          {!running && STATE_WORD[state] && <span className="muted">{STATE_WORD[state]}</span>}
          {bg && state !== "bg" && <span className="muted">в фоне</span>}
        </button>
        {running && env.canAct && (isShell(tool) || isAgent(tool)) && (
          <span className="toolacts">
            <button type="button" className="linkbtn" onClick={() => env.act?.("tasks", [tool.id])}>В фон</button>
            {task && <button type="button" className="linkbtn" onClick={() => env.act?.("taskStop", [task.id])}>Стоп</button>}
          </span>
        )}
      </div>
      {tool.note && !open && <div className="toolnote muted">{tool.note}</div>}
      {open && <div className="tool-body"><ToolBody tool={tool} view={view} /></div>}
    </div>
  );
}

/** Подряд идущие вызовы — одной стопкой; длинная стопка свёрнута до последних трёх. */
function ToolStack({ ids, view }: { ids: string[]; view: View }) {
  const [all, setAll] = useState(false);
  const shown = all || ids.length <= 4 ? ids : ids.slice(-3);
  return (
    <div>
      {shown.length < ids.length && <button type="button" className="tool muted" onClick={() => setAll(true)}>ещё {nActions(ids.length - shown.length)}</button>}
      {shown.map((id) => view.tools[id] && <ToolLine key={id} tool={view.tools[id]} view={view} />)}
    </div>
  );
}

/** Размышление: одной строкой, раскрывается; пока идёт — «Размышляет…». */
function Think({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim() && !live) return null;
  return (
    <div>
      <button type="button" className="sysline think" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconBrain size={14} /> <span className="trunc">{live ? "Размышляет…" : text.split("\n")[0]}</span>
      </button>
      {open && <div className="think-body">{text}</div>}
    </div>
  );
}

function Reply({ parts, view }: { parts: Part[]; view: View }) {
  const out: ReactNode[] = [];
  let stack: string[] = [];
  const flush = () => {
    if (stack.length) out.push(<ToolStack key={"s" + out.length} ids={stack} view={view} />);
    stack = [];
  };
  for (const p of parts) {
    if (p.k === "tool") {
      stack.push(p.id);
      continue;
    }
    flush();
    if (p.k === "text") out.push(<div key={"t" + out.length} className={p.live ? "live" : undefined}><Md text={p.text} /></div>);
    else out.push(<Think key={"h" + out.length} text={p.text} live={p.live} />);
  }
  flush();
  // готовый ответ можно скопировать текстом
  const said = parts.filter((p): p is Extract<Part, { k: "text" }> => p.k === "text" && !p.live).map((p) => p.text).join("\n\n");
  const done = !!said && !parts.some((p) => p.k !== "tool" && p.live) && parts.at(-1)?.k === "text";
  return (
    <div className="reply" style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      {out}
      {done && <CopyButton value={said}>{({ copied, copy }) => <button type="button" className="linkbtn copy-reply" onClick={copy}>{copied ? "скопировано" : "копировать"}</button>}</CopyButton>}
    </div>
  );
}

const ME_NOTE: Partial<Record<MeState, string>> = { sending: "уходит…", queued: "в очереди, уйдёт после хода", taken: "доставлено", cancelled: "снято с очереди", lost: "не ушло" };

function Mine({ r }: { r: Extract<Row, { k: "me" }> }) {
  const env = useContext(Env);
  const state = r.state;
  const other = r.from && env.me && !r.from.endsWith(env.me) ? r.from : "";
  const dim = state === "queued" || state === "sending" || state === "cancelled" || state === "lost";
  return (
    <div className={`me${dim ? " queued" : ""}${state === "cancelled" ? " gone" : ""}`} data-state={state}>
      {other && <div className="me-from mono">{other.replace(/^.*~/, "")}</div>}
      <Long text={r.text} />
      <Pics pics={r.pics} />
      {r.files?.map((f) => <div key={f} className="me-file"><IconFile size={13} /> {f}</div>)}
      {state && ME_NOTE[state] && (
        <div className="me-note">
          {ME_NOTE[state]}
          {state === "queued" && r.uuid && env.cancel && <button type="button" className="linkbtn" onClick={() => env.cancel!(r.uuid!)}>Отменить</button>}
          {state === "lost" && r.uuid && env.resend && <button type="button" className="linkbtn" onClick={() => env.resend!(r.uuid!)}>Отправить ещё раз</button>}
          {state === "lost" && r.uuid && env.drop && <button type="button" className="linkbtn" onClick={() => env.drop!(r.uuid!)}>Убрать</button>}
        </div>
      )}
    </div>
  );
}

const VIA: Record<string, string> = { session: "сессия", agent: "субагент", owner: "вам", service: "служба" };

const RowView = memo(function RowView({ r, view }: { r: Item; view: View }) {
  const env = useContext(Env);
  switch (r.k) {
    case "steps":
      return <StepsRow title={r.title} rows={r.rows} view={view} />;
    case "me":
      return <Mine r={r} />;
    case "in":
      return (
        <div className={`peer via-${r.via}`}>
          <Text size="xs" className="muted"><span className="mono">{r.from ? (env.name?.(r.from) ?? r.from) : VIA[r.via]}</span>{r.from && r.via !== "session" ? ` · ${VIA[r.via]}` : ""}{r.tag ? ` · ${r.tag}` : ""}{r.at ? ` · ${r.at}` : ""}</Text>
          <Long text={r.text} />
        </div>
      );
    case "reply":
      return <Reply parts={r.parts} view={view} />;
    case "cmd":
      return <div className="sysline"><IconTerminal2 size={14} /><span className="mono">{r.name} {r.args}</span>{r.out && <span className="trunc">— {r.out}</span>}</div>;
    case "sys":
    case "line":
      return <div className="sysline"><Icon name={r.icon} size={14} /><span>{r.text}{"dim" in r && r.dim}</span></div>;
    case "task": {
      const t = view.tasks[r.id];
      return t ? <div className="sysline"><IconRobot size={14} /><span>{t.desc}{t.summary ? ` — ${t.summary}` : ""}{t.steps ? ` · ${t.steps} ${plural(t.steps, "шаг", "шага", "шагов")}` : ""}</span></div> : null;
    }
    case "ban":
      return (
        <div className={`ban${r.tone === "bad" ? " bad" : ""}`}>
          <Text fw={600} size="sm"><IconAlertTriangle size={14} style={{ verticalAlign: -2 }} /> {r.title}</Text>
          {r.body && <Text size="sm">{r.body}</Text>}
          {r.edit && env.edit && <button type="button" className="linkbtn" onClick={() => env.edit!(r.edit!)}>Изменить сообщение</button>}
        </div>
      );
    case "res":
      return <div className="turn-end">{r.bits.join(" · ")}</div>;
    case "end":
      return <div className="ban bad"><Text fw={600} size="sm">{r.text}</Text>{r.why && <Text size="sm">{r.why}</Text>}</div>;
    case "sum":
      return <Summary stats={r.stats} text={r.text} />;
  }
});

/** Сжатие контекста: строка с числами, сводка раскрывается. */
function Summary({ stats, text }: { stats: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="sysline think" aria-expanded={open} onClick={() => setOpen((o) => !o)}><IconArchive size={14} /><span>{stats}</span></button>
      {open && <div className="think-body">{text}</div>}
    </div>
  );
}

/** Шаги хода в режиме «Фокус»: одной строкой, раскрываются. */
function StepsRow({ title, rows, view }: { title: string; rows: Row[]; view: View }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="sysline think" aria-expanded={open} onClick={() => setOpen((o) => !o)}><IconChecklist size={14} /><span className="trunc">{title}</span></button>
      {open && <div className="steps-body"><Rows rows={rows} view={view} /></div>}
    </div>
  );
}

export function Rows({ rows, view }: { rows: Item[]; view: View }) {
  return <>{rows.map((r) => <RowView key={r.key} r={r} view={view} />)}</>;
}

/** Хвост ленты: что сессия делает прямо сейчас, пока в записи этого ещё нет. */
export function Tail({ view, compacting }: { view: View; compacting?: boolean }) {
  if (compacting || view.compacting) return <div className="sysline"><IconArchive size={14} /> Сжимаю контекст…</div>;
  if (view.thinking !== null) return <div className="sysline"><IconBrain size={14} /> Размышляет…</div>;
  return null;
}
