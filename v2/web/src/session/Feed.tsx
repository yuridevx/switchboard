// Лента разговора: строки свёртки. Вызовы инструментов — одной строкой с сутью, раскрываются по клику.
// Живой ответ идёт с кареткой, размышление сворачивается, своё сообщение показывает свой статус.
import { CopyButton, Text } from "@mantine/core";
import {
  IconAlertTriangle, IconAnchor, IconArchive, IconBell, IconBolt, IconBook, IconBrain, IconCalendarClock, IconChecklist, IconClipboardList, IconFile, IconFilePencil, IconFilePlus, IconFileText, IconFolderSearch,
  IconGitBranch, IconInfoCircle, IconMessageQuestion, IconMessages, IconNotebook, IconPlayerStop, IconRadar, IconRefresh, IconRobot, IconRotate, IconSearch, IconShieldOff, IconSparkles, IconTerminal2, IconTool, IconWorld, IconX,
} from "@tabler/icons-react";
import { createContext, lazy, memo, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import type { Item } from "../chat/focus.ts";
import { todoProgress, type MeState, type Part, type Row, type Task, type Todo, type Tool, type View } from "../chat/fold.ts";
import { agentSteps, deniedWhy, editStat, isAgent, isDenied, isShell, startedInBackground, toolLook, toolState } from "../chat/tools.ts";
import { kilo, nActions, plural } from "../lib/time.ts";
import { MODES } from "../common.tsx";
import { diffLines, editsOf } from "./diff.ts";
import { HtmlFrame, openPicture, previewKind, SvgView } from "./html.tsx";
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
  /** откатить разговор к этому сообщению человека */
  rewind?(uuid: string): void;
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
  "notebook-pen": IconNotebook, radar: IconRadar, "calendar-clock": IconCalendarClock, bell: IconBell, "git-branch": IconGitBranch, "shield-off": IconShieldOff, anchor: IconAnchor,
  "triangle-alert": IconAlertTriangle, zap: IconBolt, "rotate-ccw": IconRotate, "messages-square": IconMessages, x: IconX,
};
const Icon = ({ name, size = 15 }: { name?: string; size?: number }) => {
  const I = (name && ICONS[name]) || IconTool;
  return <I size={size} stroke={1.7} style={{ flex: "none" }} data-icon={name && ICONS[name] ? name : "tool"} />;
};

/** Картинки сообщения: по нажатию — целиком в новой вкладке. */
export const Pics = ({ pics }: { pics: string[] }) => <>{pics.map((p, i) => <button key={i} type="button" className="picbtn" aria-label="Открыть картинку в новой вкладке" onClick={() => openPicture(p)}><img className="pic" src={p} alt="" /></button>)}</>;

const mark = (k: string) => (k === "old" ? "− " : k === "new" ? "+ " : "  ");

/** Правка: было и стало одной лентой; общие куски свёрнуты до числа строк, нажатие раскрывает правку целиком. */
export function Diff({ before, after }: { before: string; after: string }) {
  const [whole, setWhole] = useState(false);
  const lines = diffLines(before, after, whole ? Number.MAX_SAFE_INTEGER : 2);
  return (
    <pre className="diff">
      {lines.map((l, i) => l.k === "fold"
        ? <button key={i} type="button" className="dl fold" onClick={() => setWhole(true)}>… {l.n} {plural(l.n, "строка", "строки", "строк")} без изменений</button>
        : <span key={i} className={`dl ${l.k}`}>{mark(l.k)}{l.text}{"\n"}</span>)}
    </pre>
  );
}

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
      {tool.result?.error && !isDenied(tool) ? null : tool.result ? <Text size="sm" fw={600}>{isDenied(tool) ? `отклонено${deniedWhy(tool) ? `: ${deniedWhy(tool)}` : ""}` : `отвечено: ${said.replace(/^User has answered your questions:\s*/, "").slice(0, 400)}`}</Text> : <Text size="sm" className="muted">ждёт ответа</Text>}
    </>
  );
}

/** Текст ошибки инструмента там, где тело показывает ввод, а не вывод; отказ человека — не ошибка. */
const ErrorText = ({ tool }: { tool: Tool }) => (tool.result?.error && !isDenied(tool) ? <pre className="tool-err">{tool.result.text}</pre> : null);
const Hint = ({ text }: { text: unknown }) => (text ? <div className="toolhint">{String(text)}</div> : null);

function ToolBody({ tool, view }: { tool: Tool; view: View }) {
  const look = toolLook(tool);
  const input = tool.input ?? {};
  const out = tool.result?.text;
  const pics = tool.result?.pics ?? [];
  const [html, setHtml] = useState(false);
  let body: ReactNode;
  if (look.body === "command") body = <><Hint text={input.description} /><pre>{tool.name === "PowerShell" ? "PS>" : "$"} {String(input.command ?? "")}</pre>{out && <pre>{out}</pre>}</>;
  else if (look.body === "diff") {
    const edits = editsOf(input);
    const text = edits.length === 1 ? edits[0]!.after : "";
    const path = String(input.file_path ?? "");
    const page = tool.name === "Write" ? previewKind(/\.html?$/i.test(path) ? "html" : /\.svg$/i.test(path) ? "svg" : "", text) : null;
    body = (
      <>
        {input.replace_all ? <Hint text="все вхождения" /> : null}
        {input.cell_id ? <Hint text={`ячейка ${input.cell_id}`} /> : null}
        {page && <button type="button" className="linkbtn" aria-pressed={html} onClick={() => setHtml((v) => !v)}>{html ? "Код" : "Просмотр"}</button>}
        {html && page === "svg" ? <SvgView code={text} title={path} /> : html ? <HtmlFrame html={text} title={path} />
          : edits.map((e, i) => (e.before != null ? <Diff key={i} before={e.before} after={e.after} /> : <pre key={i} className="diff-new">{e.after}</pre>))}
        <ErrorText tool={tool} />
      </>
    );
  } else if (look.body === "read") body = out ? <Md text={"```" + (/\.(\w+)$/.exec(String(input.file_path ?? ""))?.[1] ?? "") + "\n" + out.replace(/^\s*\d+[→\t]/gm, "") + "\n```"} /> : null;
  else if (look.body === "todos") body = <><TodoList todos={(input.todos as Todo[]) ?? []} /><ErrorText tool={tool} /></>;
  else if (look.body === "agent") body = <>{input.prompt && <pre>{String(input.prompt)}</pre>}<Rows rows={tool.steps} view={view} />{out && <Md text={out} />}</>;
  else if (look.body === "plan") body = <><Md text={String(input.plan ?? "")} /><ErrorText tool={tool} /></>;
  else if (look.body === "ask") body = <><Asked tool={tool} /><ErrorText tool={tool} /></>;
  else body = <>{look.body === "output" && <Hint text={input.prompt} />}{look.body === "plain" && Object.keys(input).length > 0 && <pre>{JSON.stringify(input, null, 2)}</pre>}{out && <pre>{out}</pre>}</>;
  return <>{isDenied(tool) && look.body !== "ask" && <Text size="sm" fw={600}>Отклонено{deniedWhy(tool) ? `: ${deniedWhy(tool)}` : ""}</Text>}{body}<Pics pics={pics} /></>;
}

/** Список дел. В доке над вводом он свёрнут до «N из M» и текущего дела и раскрывается списком. */
export function TodoList({ todos, fold }: { todos: Todo[]; fold?: boolean }) {
  const p = todoProgress(todos);
  const [open, setOpen] = useState(!fold);
  const now = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status !== "completed");
  if (fold && !open) {
    return (
      <button type="button" className="todos folded" aria-expanded={false} aria-label="Список дел" onClick={() => setOpen(true)}>
        <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{p.done} из {p.of}</span>
        {now && <span className="trunc" style={{ fontWeight: 600 }}>▸ {now.activeForm ?? now.content}</span>}
      </button>
    );
  }
  return (
    <div className="todos">
      {fold ? <button type="button" className="linkbtn" aria-expanded onClick={() => setOpen(false)} style={{ alignSelf: "flex-start", fontSize: 12 }}>{p.done} из {p.of} · свернуть</button> : <span className="muted" style={{ fontSize: 12 }}>{p.done} из {p.of}</span>}
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

const STATE_WORD: Record<string, string> = { denied: "отклонено", error: "ошибка", stopped: "остановлено", bg: "в фоне" };
/** Чего ждёт вызов от человека: план — одобрения, остальное — разрешения. */
const stateWord = (state: string, tool: Tool) => (state === "wait" ? (tool.name === "ExitPlanMode" ? "ждёт одобрения" : "ждёт разрешения") : STATE_WORD[state]);

function ToolLine({ tool, view }: { tool: Tool; view: View }) {
  const env = useContext(Env);
  const look = toolLook(tool);
  const [choice, setChoice] = useState<boolean | null>(null);
  const task: Task | undefined = tool.task ? view.tasks[tool.task] : undefined;
  const waiting = env.waiting === tool.id;
  const state = toolState(tool, task, waiting);
  // сам раскрыт: правка, список дел, вопрос; план — пока его не показывает карточка вопроса; шаги идущего субагента — в блоке «Идут сейчас» над полем ввода. Выбор человека главнее
  const usual = look.body === "agent" ? false : look.body === "plan" ? !waiting : look.open;
  const open = choice ?? usual;
  const kind = isAgent(tool) && typeof tool.input?.subagent_type === "string" ? tool.input.subagent_type : "";
  const now = isAgent(tool) && task && !task.end ? (task.summary ?? (task.last ? `сейчас: ${task.last}` : "")) : "";
  const stat = editStat(tool);
  const running = state === "running";
  const steps = isAgent(tool) ? agentSteps(tool, task) : 0;
  const bg = state === "bg" || startedInBackground(tool, task);
  return (
    <div>
      <div className="toolrow">
        <button type="button" className="tool" aria-expanded={open} onClick={() => setChoice(!open)}>
          <span className={`st ${state}`} />
          <Icon name={look.icon} />
          <span className="w">{look.word}</span>
          <span className="trunc muted mono">{look.sum}</span>
          {stat && (stat.plus > 0 || stat.minus > 0) && <span className="stat-pm"><b className="plus">+{stat.plus}</b> <b className="minus">−{stat.minus}</b></span>}
          {kind && <span className="toolchip">{kind}</span>}
          {steps > 0 && <span className="muted">{steps} {plural(steps, "шаг", "шага", "шагов")}</span>}
          {now && <span className="muted trunc">{now}</span>}
          {running && <Running secs={tool.secs} />}
          {!running && stateWord(state, tool) && <span className="muted">{stateWord(state, tool)}</span>}
          {bg && state !== "bg" && <span className="muted">в фоне</span>}
        </button>
        {running && !bg && env.canAct && (isShell(tool) || isAgent(tool)) && (
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
  // размышление без текста (модель его не отдала) — строкой без раскрытия
  if (!text.trim() && !live) return <div className="sysline"><IconBrain size={14} /> Размышлял</div>;
  return (
    <div>
      <button type="button" className="sysline think" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconBrain size={14} /> <span className="trunc">{live ? "Размышляет…" : text.split("\n")[0]}</span>
      </button>
      {open && <div className="think-body"><Md text={text} /></div>}
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
      {(!state || state === "sent") && r.uuid && env.rewind && env.canAct && <div className="me-note"><button type="button" className="linkbtn" onClick={() => env.rewind!(r.uuid!)}>Откатить сюда</button></div>}
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
/** Режим разрешений отправителя словами страницы: SDK зовёт режимы по-своему. */
const SDK_MODE: Record<string, string> = { bypassPermissions: "all", default: "ask", plan: "plan", acceptEdits: "edits", auto: "auto" };
const modeWord = (tag: string) => MODES.find(([m]) => m === (SDK_MODE[tag] ?? tag))?.[1] ?? tag;

/** Сообщение от сессии флота, субагента или службы: разметкой; длинное свёрнуто и сворачивается обратно. */
function Incoming({ r }: { r: Extract<Row, { k: "in" }> }) {
  const env = useContext(Env);
  const [whole, setWhole] = useState(false);
  const long = r.via !== "owner" && r.text.length > LONG;
  return (
    <div className={`peer via-${r.via}`}>
      <Text size="xs" className="muted peer-from">
        {r.via === "agent" ? <Icon name="bot" size={13} /> : r.via === "session" ? <Icon name="messages-square" size={13} /> : null}
        <span><span className="mono">{r.from ? (env.name?.(r.from) ?? r.from) : VIA[r.via]}</span>{r.from && r.via !== "session" ? ` · ${VIA[r.via]}` : ""}{r.tag ? ` · ${modeWord(r.tag)}` : ""}{r.at ? ` · ${r.at}` : ""}</span>
      </Text>
      <div className={long && !whole ? "peer-clamp" : undefined}><Md text={r.text} /></div>
      {long && <button type="button" className="linkbtn" aria-expanded={whole} onClick={() => setWhole((w) => !w)}>{whole ? "свернуть" : "показать всё"}</button>}
      {r.via === "session" && r.uuid && env.rewind && env.canAct && <div><button type="button" className="linkbtn" onClick={() => env.rewind!(r.uuid!)}>Откатить сюда</button></div>}
    </div>
  );
}

const RowView = memo(function RowView({ r, view }: { r: Item; view: View }) {
  const env = useContext(Env);
  switch (r.k) {
    case "steps":
      return <StepsRow title={r.title} rows={r.rows} view={view} />;
    case "me":
      return <Mine r={r} />;
    case "in":
      return <Incoming r={r} />;
    case "reply":
      return <Reply parts={r.parts} view={view} />;
    case "cmd":
      return <div className="sysline"><IconTerminal2 size={14} /><span className="mono">{r.name} {r.args}</span>{r.out && <span className="trunc">— {r.out}</span>}</div>;
    case "sys":
    case "line":
      return <div className={`sysline${r.tone ? ` tone-${r.tone}` : ""}`}><Icon name={r.icon} size={14} /><span>{r.text}{"dim" in r && r.dim}</span></div>;
    case "task": {
      // идущая задача стоит строкой в блоке «Идут сейчас» над полем ввода; в ленте — только законченная
      const t = view.tasks[r.id];
      return t?.end ? (
        <div className="sysline"><IconRobot size={14} /><span>{t.desc}{t.summary ? ` — ${t.summary}` : ""}{t.steps ? ` · ${t.steps} ${plural(t.steps, "шаг", "шага", "шагов")}` : ""}</span>
          {!t.end && env.canAct && <button type="button" className="linkbtn" onClick={() => env.act?.("taskStop", [t.id])}>Стоп</button>}
        </div>
      ) : null;
    }
    case "ban":
      return (
        <div className={`ban ${r.tone}`} {...(r.tone === "bad" ? { role: "alert" } : {})}>
          <Text fw={600} size="sm" className="ban-title"><Icon name={r.icon ?? (r.tone === "bad" ? "triangle-alert" : "info")} size={14} /> {r.title}</Text>
          {r.body && <Text size="sm">{r.body}</Text>}
          {r.edit && env.edit && <button type="button" className="linkbtn" onClick={() => env.edit!(r.edit!)}>Изменить сообщение</button>}
        </div>
      );
    case "res":
      return <div className="turn-end">{r.bits.join(" · ")}</div>;
    case "end":
      return <div className="ban bad" role="alert"><Text fw={600} size="sm" className="ban-title"><Icon name="x" size={14} /> {r.text}</Text>{r.why && <Text size="sm">{r.why}</Text>}</div>;
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
      {open && <div className="think-body"><Md text={text} /></div>}
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
  // пока модель думает, SDK называет оценку числа токенов размышления
  if (view.thinking !== null) return <div className="sysline"><IconBrain size={14} /> Размышляет…{view.thinking > 0 && <span className="muted"> {kilo(view.thinking)} токенов</span>}</div>;
  return null;
}
