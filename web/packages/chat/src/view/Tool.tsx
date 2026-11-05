// Карточка инструмента: шапка из таблицы инструментов, тело по виду. Всё, что пришло от инструмента, — только текстом.
import { useState } from "react";
import { diffLines } from "diff";
import { ArrowDownToLine, Bell, Bot, CalendarClock, Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, ClipboardList, FilePen, FilePlus, FileText, FolderSearch, GitBranch, Globe, ListChecks, Loader2, MessageCircleQuestion, NotebookPen, Radar, Search, Sparkles, Square, Terminal, Wrench } from "lucide-react";
import { HtmlFrame, langOfPath, Markdown, useApp, useHighlighted, useNow } from "@switchboard/web-ui";
import type { Msg, Task, Todo, Tool } from "../fold.ts";
import { deniedWhy, isAgent, isDenied, isShell, startedInBackground, toolLook, toolState } from "../tools.ts";
import { Dis, Rows, useEnv } from "./Rows.tsx";

const ICONS: Record<string, typeof Wrench> = { radar: Radar, bell: Bell, "notebook-pen": NotebookPen, bot: Bot, "message-circle-question": MessageCircleQuestion, "clipboard-list": ClipboardList, "calendar-clock": CalendarClock, "file-pen": FilePen, "file-plus": FilePlus, "file-text": FileText, "folder-search": FolderSearch, "git-branch": GitBranch, globe: Globe, "list-checks": ListChecks, search: Search, sparkles: Sparkles, square: Square, terminal: Terminal, wrench: Wrench };

type Line = { kind: "add" | "del" | "same"; text: string };
/** Общий кусок длиннее этого сворачивается: по две строки с каждой стороны. */
const SAME_MAX = 6;

function diffOf(before: string, after: string): Line[] {
  const out: Line[] = [];
  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    const kind: Line["kind"] = part.added ? "add" : part.removed ? "del" : "same";
    if (kind === "same" && lines.length > SAME_MAX) {
      const hidden = lines.length - 4;
      out.push(...lines.slice(0, 2).map((text) => ({ kind, text })), { kind, text: `⋯ ${hidden} без изменений` }, ...lines.slice(-2).map((text) => ({ kind, text })));
    } else out.push(...lines.map((text) => ({ kind, text })));
  }
  return out;
}

function Diff({ before = "", after = "" }: { before?: string; after?: string }) {
  const lines = diffOf(before, after);
  return (
    <div className="chat-diff">
      {lines.map((l, i) => (
        <div key={i} className={l.kind}>
          <i>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</i>
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}

const editsOf = (input: Msg): Array<{ before: string; after: string }> => {
  if (Array.isArray(input.edits)) return (input.edits as Msg[]).map((e) => ({ before: String(e.old_string ?? ""), after: String(e.new_string ?? "") }));
  if (typeof input.old_string === "string" || typeof input.new_string === "string") return [{ before: String(input.old_string ?? ""), after: String(input.new_string ?? "") }];
  if (typeof input.new_source === "string") return [{ before: "", after: input.new_source }];
  if (typeof input.content === "string") return [{ before: "", after: input.content }];
  return [];
};

function changeCount(input: Msg) {
  let add = 0;
  let del = 0;
  for (const e of editsOf(input)) {
    for (const l of diffOf(e.before, e.after)) {
      if (l.kind === "add") add++;
      if (l.kind === "del") del++;
    }
  }
  return { add, del };
}

const NEEDS_FRAME = /\.(html?|svg)$/i;
const IS_DOC = /^\s*<!doctype html/i;

function Result({ tool }: { tool: Tool }) {
  const r = tool.result;
  if (!r) return <div className="tb-wait">ждём результата…</div>;
  return (
    <>
      {r.text || !r.pics.length ? <pre className={r.error ? "tb-pre bad" : "tb-pre"}>{r.text || "без вывода"}</pre> : null}
      {r.pics.map((src, i) => (
        <img key={i} className="tb-img" src={src} alt={`картинка ${i + 1}`} />
      ))}
    </>
  );
}

function ErrorText({ tool }: { tool: Tool }) {
  return tool.result?.error && !isDenied(tool) ? <pre className="tb-pre bad">{tool.result.text}</pre> : null;
}

function ReadBody({ tool }: { tool: Tool }) {
  const r = tool.result;
  const code = r?.text ?? "";
  const highlighted = useHighlighted(code, langOfPath(tool.input?.file_path));
  if (!r || r.error || !code) return <Result tool={tool} />;
  return (
    <>
      <pre className="tb-pre">
        <code className="hljs">{highlighted}</code>
      </pre>
      {r.pics.map((src, i) => (
        <img key={i} className="tb-img" src={src} alt={`картинка ${i + 1}`} />
      ))}
    </>
  );
}

const STATUS_ICON: Record<string, typeof Circle> = { completed: CircleCheck, in_progress: CircleDot };

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="chat-todos">
      {todos.map((t, i) => {
        const I = STATUS_ICON[t.status] ?? Circle;
        return (
          <li key={i} data-status={t.status}>
            <I size={13} />
            {t.content}
          </li>
        );
      })}
    </ul>
  );
}

function AskBody({ tool }: { tool: Tool }) {
  const input = tool.input ?? {};
  const answers = (input.answers ?? {}) as Record<string, string>;
  return (
    <>
      {((input.questions ?? []) as Msg[]).map((q, i) => (
        <div key={i} className="tb-q tb-md">
          <div>{q.question}</div>
          <span>{answers[q.question] ?? ((q.options ?? []) as Msg[]).map((o) => o.label).join(" · ")}</span>
        </div>
      ))}
      <ErrorText tool={tool} />
    </>
  );
}

function AgentBody({ tool, task }: { tool: Tool; task?: Task }) {
  const input = tool.input ?? {};
  // ушедший в фон: итог — итог задачи; иначе — результат инструмента
  const final = task?.bg ? task.final : tool.result?.text;
  return (
    <div className="tb-agent">
      {input.prompt ? (
        <Dis head="Задание">
          <div className="tb-prompt">{input.prompt}</div>
        </Dis>
      ) : null}
      {tool.steps.length ? (
        <div className="tb-steps">
          <Rows rows={tool.steps} />
        </div>
      ) : null}
      {final ? (
        <div className="tb-final">
          <Markdown text={final} />
        </div>
      ) : null}
    </div>
  );
}

function Body({ tool, task, kind }: { tool: Tool; task?: Task; kind: string }) {
  const input = tool.input ?? {};
  switch (kind) {
    case "command":
      return (
        <>
          {input.description ? <div className="tb-hint">{input.description}</div> : null}
          <pre className="tb-pre muted">{`${tool.name === "PowerShell" ? "PS>" : "$"} ${input.command ?? ""}`}</pre>
          <Output tool={tool} />
        </>
      );
    case "diff": {
      const doc = typeof input.content === "string" && (NEEDS_FRAME.test(String(input.file_path)) || IS_DOC.test(input.content)) ? input.content : "";
      return (
        <>
          {input.replace_all ? <div className="tb-hint">все вхождения</div> : null}
          {input.cell_id ? <div className="tb-hint">{`ячейка ${input.cell_id}`}</div> : null}
          {doc ? <HtmlFrame html={doc} /> : null}
          {editsOf(input).map((e, i) => (
            <Diff key={i} before={e.before} after={e.after} />
          ))}
          <ErrorText tool={tool} />
        </>
      );
    }
    case "read":
      return <ReadBody tool={tool} />;
    case "todos":
      return (
        <>
          <TodoList todos={(input.todos ?? []) as Todo[]} />
          <ErrorText tool={tool} />
        </>
      );
    case "ask":
      return <AskBody tool={tool} />;
    case "plan":
      return (
        <>
          <div className="tb-md">
            <Markdown text={String(input.plan ?? "")} />
          </div>
          <ErrorText tool={tool} />
        </>
      );
    case "agent":
      return <AgentBody tool={tool} task={task} />;
    case "output":
      return (
        <>
          {input.prompt ? <div className="tb-hint">{input.prompt}</div> : null}
          <Output tool={tool} />
        </>
      );
    default:
      return (
        <>
          <pre className="tb-pre muted">{JSON.stringify(input, null, 2)}</pre>
          <Output tool={tool} />
        </>
      );
  }
}

/** Итог инструмента: отказ человека — его причиной. */
function Output({ tool }: { tool: Tool }) {
  if (isDenied(tool)) {
    const why = deniedWhy(tool);
    return why ? <pre className="tb-pre">{why}</pre> : null;
  }
  return <Result tool={tool} />;
}

const stateWord = (state: string, name?: string): [string, string] | null => {
  if (state === "wait") return [name === "ExitPlanMode" ? "ждёт одобрения" : "ждёт разрешения", "wait"];
  if (state === "error") return ["ошибка", "bad"];
  if (state === "denied") return ["отклонено", ""];
  if (state === "stopped") return ["остановлено", ""];
  if (state === "bg") return ["в фоне", "run"];
  return null;
};

function Status({ state, tool }: { state: string; tool: Tool }) {
  if (state === "running") {
    return (
      <em className="tc-st run">
        <Loader2 size={12} />
        {tool.secs ? `${Math.round(tool.secs)} с` : ""}
      </em>
    );
  }
  if (state === "ok") {
    return tool.name === "TodoWrite" ? null : (
      <em className="tc-st ok" aria-label="готово">
        <Check size={13} />
      </em>
    );
  }
  const w = stateWord(state, tool.name);
  return w ? <em className={w[1] ? `tc-st ${w[1]}` : "tc-st"}>{w[0]}</em> : null;
}

function TaskBar({ tool, task }: { tool: Tool; task?: Task }) {
  const app = useApp();
  const env = useEnv();
  const canAct = app.use(() => env.canAct());
  const now = useNow(task && !task.end ? 1000 : 0);
  if (task && !task.end) {
    const agent = isAgent(tool);
    const secs = Math.max(0, Math.round((now - task.started) / 1000));
    const about = agent ? [task.summary ?? (task.last ? `сейчас: ${task.last}` : ""), task.steps ? `шагов ${task.steps}` : ""] : [];
    return (
      <div className="tc-bar">
        <span>{[`идёт ${secs} с`, ...about].filter(Boolean).join(" · ")}</span>
        {canAct ? (
          <button type="button" className="chat-mini" onClick={() => env.act("stopTask", [task.id])}>
            Стоп
          </button>
        ) : null}
      </div>
    );
  }
  if (!task && isShell(tool) && !tool.result && canAct) {
    return (
      <div className="tc-bar">
        <button type="button" className="chat-mini" onClick={() => env.act("backgroundTasks", [tool.id])}>
          <ArrowDownToLine size={12} />
          В фон
        </button>
      </div>
    );
  }
  return null;
}

export function ToolCard({ id }: { id: string }) {
  const app = useApp();
  const env = useEnv();
  const tool = app.use(() => env.view().tools[id]);
  const task = app.use(() => (tool?.task ? env.view().tasks[tool.task] : undefined));
  const waiting = app.use(() => env.waiting(id));
  const [choice, setChoice] = useState<boolean | null>(null);
  if (!tool) return null;
  const look = toolLook(tool);
  const state = toolState(tool, task, waiting);
  const usual = look.body === "agent" ? !(task?.bg ? task.final : tool.result) : look.body === "plan" ? !waiting : look.open;
  const open = choice ?? usual;
  const Icon = ICONS[look.icon] ?? Wrench;
  const counted = look.body === "diff" && tool.name !== "Write" && tool.name !== "NotebookEdit" ? changeCount(tool.input ?? {}) : null;
  return (
    <div className="chat-tool" data-tool={tool.name} data-state={state}>
      <button type="button" className="tc-h" aria-expanded={!!open} onClick={() => setChoice(!open)}>
        <span className="tc-i">
          <Icon size={14} />
        </span>
        <b>{look.word}</b>
        <span className="tc-sum" title={look.sum}>
          {look.sum}
        </span>
        {counted ? (
          <span className="chat-count">
            <b>{`+${counted.add}`}</b> <s>{`−${counted.del}`}</s>
          </span>
        ) : null}
        {startedInBackground(tool) ? <span className="tc-chip">в фоне</span> : null}
        <Status state={state} tool={tool} />
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {tool.note ? <div className="tc-note">{tool.note}</div> : null}
      {state === "wait" ? null : <TaskBar tool={tool} task={task} />}
      {open ? (
        <div className="tc-b">
          <Body tool={tool} task={task} kind={look.body} />
        </div>
      ) : null}
    </div>
  );
}
