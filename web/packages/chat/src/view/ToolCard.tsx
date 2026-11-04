// Карточка инструмента: шапка одной строкой, полоса задачи, тело по виду инструмента.
import { useMemo, useState } from "react";
import { ArrowDownToLine, Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, Loader2, Square, X } from "lucide-react";
import { diffLines } from "diff";
import { Btn, DisclosureBtn, HtmlFrame, langOfPath, Markdown, useHighlighted, useNow } from "@switchboard/web-ui";
import { isRefused, refusalReason, toolState, type Msg, type Task, type Tool, type ToolState } from "../state/fold.ts";
import { baseName } from "../state/words.ts";
import { Dis, useEnv } from "./env.tsx";
import { isAgent, isShell, kindOf } from "./kinds.tsx";
import { Rows } from "./Rows.tsx";

/** Результат «ушла в фон» — и в истории, где задач claude уже нет. */
const BG_RESULT = /^(Async agent launched|Command running in background|Command was manually backgrounded)/;
const HTML_NAME = /\.(html?|svg)$/i;
const HTML_DOC = /^\s*(<!doctype html|<html[\s>])/i;
/** Общий кусок длиннее стольких строк свёрнут до двух в начале и двух в конце. */
const FOLD = 6;

// ───────────── дифф ─────────────

type Hunk = { old?: string; new?: string };

/** Куски правки: Edit — один, MultiEdit — по правке, Write и ячейка блокнота — всё новое. */
function hunksOf(tool: Tool): Hunk[] {
  const i = tool.input;
  if (tool.name === "MultiEdit") return ((i.edits as Msg[] | undefined) ?? []).map((e) => ({ old: e.old_string as string, new: e.new_string as string }));
  if (tool.name === "Write") return [{ old: "", new: i.content as string }];
  if (tool.name === "NotebookEdit") return [{ old: "", new: i.new_source as string }];
  return [{ old: i.old_string as string, new: i.new_string as string }];
}

const changes = (h: Hunk) => diffLines(h.old ?? "", h.new ?? "");
const linesOf = (s: string) => s.replace(/\n$/, "").split("\n");

function HunkView({ h }: { h: Hunk }) {
  const cs = useMemo(() => changes(h), [h.old, h.new]);
  return (
    <div className="chat-diff">
      {cs.flatMap((c, j) => {
        const ls = linesOf(c.value);
        const shown = !c.added && !c.removed && ls.length > FOLD ? [...ls.slice(0, 2), `⋯ ${ls.length - 4} без изменений`, ...ls.slice(-2)] : ls;
        return shown.map((l, n) => (
          <div key={`${j}-${n}`} className={c.added ? "add" : c.removed ? "del" : "same"}>
            <i>{c.added ? "+" : c.removed ? "−" : " "}</i>
            <span>{l}</span>
          </div>
        ));
      })}
    </div>
  );
}

function Diff({ tool }: { tool: Tool }) {
  return (
    <>
      {hunksOf(tool).map((h, k) => (
        <HunkView key={k} h={h} />
      ))}
    </>
  );
}

/** «+3 −1»: добавлено и убрано строк. */
function DiffCount({ tool }: { tool: Tool }) {
  const [added, removed] = useMemo(() => {
    let a = 0;
    let r = 0;
    for (const c of hunksOf(tool).flatMap(changes)) {
      if (c.added) a += linesOf(c.value).length;
      if (c.removed) r += linesOf(c.value).length;
    }
    return [a, r];
  }, [tool]);
  return (
    <span className="chat-count">
      <b>{`+${added}`}</b> <s>{`−${removed}`}</s>
    </span>
  );
}

// ───────────── тело ─────────────

const Hint = ({ text }: { text: unknown }) => <div className="tb-hint">{String(text)}</div>;

function Pre({ text, tone }: { text: string; tone?: "bad" | "muted" }) {
  return <pre className={tone ? `tb-pre ${tone}` : "tb-pre"}>{text || "—"}</pre>;
}

/** Ошибка инструмента со своим телом: ошибки — словами; у отказа человека — только его причина. */
function Failed({ tool }: { tool: Tool }) {
  if (!tool.result?.isError) return null;
  if (!isRefused(tool.result.text)) return <Pre text={tool.result.text} tone="bad" />;
  const why = refusalReason(tool.result.text);
  return why ? <Pre text={why} /> : null;
}

/** Вывод инструмента; ошибка — красным; картинки — следом. */
function Result({ tool }: { tool: Tool }) {
  const env = useEnv();
  const asking = env.useWaiting(tool.id);
  const r = tool.result;
  if (!r) return asking ? null : <div className="tb-wait">ждём результата…</div>;
  return (
    <>
      {r.isError ? <Failed tool={tool} /> : r.text || !r.images.length ? <Pre text={r.text || "без вывода"} /> : null}
      {r.images.map((src, i) => (
        <img key={i} className="tb-img" src={src} alt={`картинка ${i + 1}`} />
      ))}
    </>
  );
}

/** Файл: код с подсветкой по расширению; строки с номерами Read показываются как есть. */
function FileResult({ tool }: { tool: Tool }) {
  const r = tool.result;
  const text = r?.text ?? "";
  const nodes = useHighlighted(text, r && !r.isError ? langOfPath(tool.input.file_path as string | undefined) : "");
  if (!r || r.isError || r.images.length || !text) return <Result tool={tool} />;
  return (
    <pre className="tb-pre">
      <code className="hljs">{nodes}</code>
    </pre>
  );
}

function Questions({ tool }: { tool: Tool }) {
  const answers = (tool.input.answers as Record<string, string> | undefined) ?? {};
  return (
    <div className="tb-md">
      {((tool.input.questions as Msg[] | undefined) ?? []).map((q) => (
        <div key={String(q.question)} className="tb-q">
          <b>{String(q.question)}</b>
          <span>{answers[String(q.question)] ?? ((q.options as Msg[] | undefined) ?? []).map((o) => String(o.label)).join(" · ")}</span>
        </div>
      ))}
    </div>
  );
}

export function Todos({ todos }: { todos: unknown }) {
  if (!Array.isArray(todos)) return null;
  return (
    <ul className="chat-todos">
      {(todos as Msg[]).map((t, i) => (
        <li key={i} data-status={String(t.status)}>
          {t.status === "completed" ? <CircleCheck size={14} /> : t.status === "in_progress" ? <CircleDot size={14} /> : <Circle size={14} />}
          <span>{String(t.status === "in_progress" && t.activeForm ? t.activeForm : t.content)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Субагент: задание свёрнуто, внутри — его шаги и итог; ушедший в фон — итог его задачи. */
function AgentBody({ tool, task }: { tool: Tool; task?: Task }) {
  const summary = task?.bg ? (task.ended ? task.summary : undefined) : tool.result?.text;
  return (
    <div className="tb-agent">
      {tool.input.prompt ? (
        <Dis head="Задание">
          <div className="tb-prompt">{String(tool.input.prompt)}</div>
        </Dis>
      ) : null}
      {tool.steps.length ? (
        <div className="tb-steps">
          <Rows rows={tool.steps} />
        </div>
      ) : null}
      {summary ? (
        <div className="tb-final">
          <Markdown text={summary} />
        </div>
      ) : null}
    </div>
  );
}

function Body({ tool, task }: { tool: Tool; task?: Task }) {
  const i = tool.input;
  switch (tool.name) {
    case "Bash":
    case "PowerShell":
      return (
        <>
          {i.description ? <Hint text={i.description} /> : null}
          <Pre text={`${tool.name === "Bash" ? "$" : "PS>"} ${String(i.command ?? "")}`} tone="muted" />
          <Result tool={tool} />
        </>
      );
    case "Edit":
    case "MultiEdit":
      return (
        <>
          {i.replace_all ? <Hint text="все вхождения" /> : null}
          <Diff tool={tool} />
          <Failed tool={tool} />
        </>
      );
    case "Write": {
      const content = String(i.content ?? "");
      const name = baseName(i.file_path as string | undefined);
      return (
        <>
          {HTML_NAME.test(name) || HTML_DOC.test(content) ? <HtmlFrame html={content} title={name} /> : null}
          <Diff tool={tool} />
          <Failed tool={tool} />
        </>
      );
    }
    case "NotebookEdit":
      return (
        <>
          {i.cell_id ? <Hint text={`ячейка ${String(i.cell_id)}`} /> : null}
          <Diff tool={tool} />
          <Failed tool={tool} />
        </>
      );
    case "Read":
      return <FileResult tool={tool} />;
    case "TodoWrite":
      return (
        <>
          <Todos todos={i.todos} />
          <Failed tool={tool} />
        </>
      );
    case "WebFetch":
      return (
        <>
          {i.prompt ? <Hint text={i.prompt} /> : null}
          <Result tool={tool} />
        </>
      );
    case "Task":
    case "Agent":
      return <AgentBody tool={tool} task={task} />;
    case "ExitPlanMode":
      return (
        <>
          <div className="tb-md">
            <Markdown text={String(i.plan ?? "")} />
          </div>
          <Failed tool={tool} />
        </>
      );
    case "AskUserQuestion":
      return (
        <>
          <Questions tool={tool} />
          <Failed tool={tool} />
        </>
      );
    case "Grep":
    case "Glob":
    case "WebSearch":
    case "Skill":
      return <Result tool={tool} />;
    default:
      return (
        <>
          <Pre text={JSON.stringify(i, null, 2)} tone="muted" />
          <Result tool={tool} />
        </>
      );
  }
}

// ───────────── шапка и полоса ─────────────

function StateMark({ state, secs, plan }: { state: ToolState; secs?: number; plan: boolean }) {
  switch (state) {
    case "wait":
      return <em className="tc-st wait">{plan ? "ждёт одобрения" : "ждёт разрешения"}</em>;
    case "running":
      return (
        <em className="tc-st run">
          <Loader2 size={13} />
          {secs !== undefined ? `${Math.round(secs)} с` : null}
        </em>
      );
    case "bg":
      return (
        <em className="tc-st run">
          <Loader2 size={13} />в фоне
        </em>
      );
    case "stopped":
      return <em className="tc-st wait">остановлено</em>;
    case "denied":
      return <em className="tc-st">отклонено</em>;
    case "error":
      return (
        <em className="tc-st bad">
          <X size={13} />
          ошибка
        </em>
      );
    case "ok":
      return (
        <em className="tc-st ok" aria-label="готово">
          <Check size={14} />
        </em>
      );
  }
}

/** Полоса идущей команды или субагента: сколько идёт, что делает, «В фон» и «Стоп». */
function TaskBar({ task, tool }: { task: Task; tool: Tool }) {
  const env = useEnv();
  const now = useNow(1000);
  const secs = task.startedAt ? Math.max(0, Math.round((now - task.startedAt) / 1000)) : 0;
  const agent = task.type === "local_agent";
  return (
    <div className="tc-bar">
      <span>
        {`идёт ${secs} с`}
        {agent && (task.summary || task.lastTool) ? ` · ${task.summary ?? `сейчас: ${task.lastTool}`}` : ""}
        {agent && task.uses ? ` · шагов ${task.uses}` : ""}
      </span>
      {!task.bg && env.canCall ? (
        <Btn type="button" className="chat-mini" onClick={() => env.act("backgroundTasks", [tool.id])}>
          <ArrowDownToLine size={13} />В фон
        </Btn>
      ) : null}
      {env.canCall ? (
        <Btn type="button" className="chat-mini" onClick={() => env.act("stopTask", [task.id])}>
          <Square size={11} />
          Стоп
        </Btn>
      ) : null}
    </div>
  );
}

export function ToolCard({ id }: { id: string }) {
  const env = useEnv();
  const tool = env.view.tools[id];
  const waiting = env.useWaiting(id);
  const task = tool?.task ? env.view.tasks[tool.task] : undefined;
  const [picked, setPicked] = useState<boolean | null>(null);
  if (!tool) return null;
  const k = kindOf(tool.name, tool.input, !!tool.result);
  const state = toolState(tool, task, waiting);
  const plan = tool.name === "ExitPlanMode";
  // план на одобрении уже развёрнут над вводом: второй раз в карточке он не нужен
  const open = picked ?? (!!k.open && !(waiting && plan));
  const shell = isShell(tool.name);
  const agent = isAgent(tool.name);
  const wentBg = (shell || agent) && state !== "bg" && !!(tool.input.run_in_background || task?.bg || BG_RESULT.test(tool.result?.text ?? ""));
  return (
    <div className="chat-tool" data-tool={tool.name} data-state={state}>
      <DisclosureBtn className="tc-h" open={open} onClick={() => setPicked(!open)}>
        <span className="tc-i">{k.icon}</span>
        <b>{k.label}</b>
        <span className="tc-sum" title={k.summary}>
          {k.summary}
        </span>
        {tool.name === "Edit" || tool.name === "MultiEdit" ? <DiffCount tool={tool} /> : null}
        {wentBg ? <span className="tc-chip">в фоне</span> : null}
        {agent && tool.input.subagent_type ? <span className="tc-chip">{String(tool.input.subagent_type)}</span> : null}
        {tool.name === "TodoWrite" && state === "ok" ? null : <StateMark state={state} secs={tool.secs} plan={plan} />}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </DisclosureBtn>
      {task && !task.ended ? (
        <TaskBar task={task} tool={tool} />
      ) : !task && state === "running" && shell && env.canCall ? (
        <div className="tc-bar">
          <span />
          <Btn type="button" className="chat-mini" onClick={() => env.act("backgroundTasks", [tool.id])}>
            <ArrowDownToLine size={13} />В фон
          </Btn>
        </div>
      ) : null}
      {tool.note ? <div className="tc-note">{tool.note}</div> : null}
      {open ? (
        <div className="tc-b">
          <Body tool={tool} task={task} />
        </div>
      ) : null}
    </div>
  );
}
