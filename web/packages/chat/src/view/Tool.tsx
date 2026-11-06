// Карточка инструмента: шапка из таблицы инструментов, тело по виду. Всё, что пришло от инструмента, — только текстом.
import { useState } from "react";
import { diffLines } from "diff";
import { Btn, DisclosureBtn, HtmlFrame, langOfPath, Markdown, useApp, useHighlighted, useNow } from "@switchboard/web-ui";
import type { Msg, Task, Todo, Tool } from "../fold.ts";
import { deniedWhy, isAgent, isDenied, isShell, startedInBackground, toolLook, toolState } from "../tools.ts";
import { useEnv } from "./env.ts";
import { Icon } from "./icons.tsx";
import { Dis, Rows } from "./Rows.tsx";

/** Общий кусок длиннее этого сворачивается: по две строки с каждой стороны. */
const SAME_MAX = 6;
type Line = { kind: "add" | "del" | "same"; text: string };

function diffOf(before: string, after: string): Line[] {
  const out: Line[] = [];
  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, "").split("\n");
    const kind: Line["kind"] = part.added ? "add" : part.removed ? "del" : "same";
    if (kind === "same" && lines.length > SAME_MAX) out.push(...lines.slice(0, 2).map((text) => ({ kind, text })), { kind, text: `⋯ ${lines.length - 4} без изменений` }, ...lines.slice(-2).map((text) => ({ kind, text })));
    else out.push(...lines.map((text) => ({ kind, text })));
  }
  return out;
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <div className="chat-diff">
      {diffOf(before, after).map((l, i) => (
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
  const lines = editsOf(input).flatMap((e) => diffOf(e.before, e.after));
  return { add: lines.filter((l) => l.kind === "add").length, del: lines.filter((l) => l.kind === "del").length };
}

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

/** Итог инструмента: отказ человека — его причиной. */
function Output({ tool }: { tool: Tool }) {
  if (!isDenied(tool)) return <Result tool={tool} />;
  const why = deniedWhy(tool);
  return why ? <pre className="tb-pre">{why}</pre> : null;
}

const ErrorText = ({ tool }: { tool: Tool }) => (tool.result?.error && !isDenied(tool) ? <pre className="tb-pre bad">{tool.result.text}</pre> : null);

function ReadBody({ tool }: { tool: Tool }) {
  const r = tool.result;
  const code = r?.text ?? "";
  const highlighted = useHighlighted(code, langOfPath(tool.input?.file_path));
  if (!r || r.error || !code) return <Result tool={tool} />;
  return (
    <pre className="tb-pre">
      <code className="hljs">{highlighted}</code>
    </pre>
  );
}

const STATUS_ICON: Record<string, string> = { completed: "circle-check", in_progress: "circle-dot" };

export function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="chat-todos">
      {todos.map((t, i) => (
        <li key={i} data-status={t.status}>
          <Icon name={STATUS_ICON[t.status] ?? "circle"} size={14} />
          <span>{t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}</span>
        </li>
      ))}
    </ul>
  );
}

function AskBody({ tool }: { tool: Tool }) {
  const input = tool.input ?? {};
  const answers = (input.answers ?? {}) as Record<string, string>;
  return (
    <>
      <div className="tb-md">
        {((input.questions ?? []) as Msg[]).map((q, i) => (
          <div key={i} className="tb-q">
            <b>{q.question}</b>
            <span>{answers[q.question] ?? ((q.options ?? []) as Msg[]).map((o) => o.label).join(" · ")}</span>
          </div>
        ))}
      </div>
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

function DiffBody({ tool }: { tool: Tool }) {
  const input = tool.input ?? {};
  const doc = typeof input.content === "string" && (/\.(html?|svg)$/i.test(String(input.file_path)) || /^\s*<!doctype html/i.test(input.content)) ? input.content : "";
  return (
    <>
      {input.replace_all ? <div className="tb-hint">все вхождения</div> : null}
      {input.cell_id ? <div className="tb-hint">{`ячейка ${input.cell_id}`}</div> : null}
      {doc ? <HtmlFrame html={doc} title={String(input.file_path ?? "Просмотр HTML")} /> : null}
      {editsOf(input).map((e, i) => (
        <Diff key={i} before={e.before} after={e.after} />
      ))}
      <ErrorText tool={tool} />
    </>
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
    case "diff":
      return <DiffBody tool={tool} />;
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

const WORDS: Record<string, [string, string]> = { error: ["ошибка", "bad"], denied: ["отклонено", ""], stopped: ["остановлено", "wait"], bg: ["в фоне", "run"] };

function Status({ state, tool }: { state: string; tool: Tool }) {
  if (state === "running")
    return (
      <em className="tc-st run">
        <Icon name="loader-circle" />
        {tool.secs ? `${Math.round(tool.secs)} с` : ""}
      </em>
    );
  if (state === "ok")
    return tool.name === "TodoWrite" ? null : (
      <em className="tc-st ok" aria-label="готово">
        <Icon name="check" size={14} />
      </em>
    );
  const [word, tone] = state === "wait" ? [tool.name === "ExitPlanMode" ? "ждёт одобрения" : "ждёт разрешения", "wait"] : WORDS[state];
  return (
    <em className={tone ? `tc-st ${tone}` : "tc-st"}>
      {state === "error" ? <Icon name="x" /> : state === "bg" ? <Icon name="loader-circle" /> : null}
      {word}
    </em>
  );
}

function TaskBar({ tool, task }: { tool: Tool; task?: Task }) {
  const env = useEnv();
  const running = !!task && !task.end;
  const now = useNow(running ? 1000 : 0);
  const toBg = (
    <Btn type="button" className="chat-mini" onClick={() => env.act("backgroundTasks", [tool.id])}>
      <Icon name="arrow-down-to-line" />В фон
    </Btn>
  );
  if (!running) {
    if (task || !isShell(tool) || tool.result || !env.canAct) return null;
    return (
      <div className="tc-bar">
        <span />
        {toBg}
      </div>
    );
  }
  const agent = isAgent(tool);
  const about = agent ? (task.summary ?? (task.last ? `сейчас: ${task.last}` : "")) : "";
  return (
    <div className="tc-bar">
      <span>
        {`идёт ${Math.max(0, Math.round((now - task.started) / 1000))} с`}
        {about ? ` · ${about}` : null}
        {agent && task.steps ? ` · шагов ${task.steps}` : null}
      </span>
      {env.canAct && !task.bg ? toBg : null}
      {env.canAct ? (
        <Btn type="button" className="chat-mini" onClick={() => env.act("stopTask", [task.id])}>
          <Icon name="square" />
          Стоп
        </Btn>
      ) : null}
    </div>
  );
}

export function ToolCard({ id }: { id: string }) {
  const env = useEnv();
  const app = useApp();
  const tool = env.view.tools[id];
  const [choice, setChoice] = useState<boolean | null>(null);
  const waiting = app.use(() => env.waiting(id));
  if (!tool) return null;
  const task = tool.task ? env.view.tasks[tool.task] : undefined;
  const look = toolLook(tool);
  const state = toolState(tool, task, waiting);
  const usual = look.body === "agent" ? !(task?.bg ? task.final : tool.result) : look.body === "plan" ? !waiting : look.open;
  const open = choice ?? usual;
  const counted = look.body === "diff" && tool.name !== "Write" && tool.name !== "NotebookEdit" ? changeCount(tool.input ?? {}) : null;
  return (
    <div className="chat-tool" data-tool={tool.name ?? ""} data-state={state}>
      <DisclosureBtn className="tc-h" open={!!open} onClick={() => setChoice(!open)}>
        <span className="tc-i">
          <Icon name={look.icon} size={15} />
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
        {startedInBackground(tool, task) ? <span className="tc-chip">в фоне</span> : null}
        {tool.input?.subagent_type ? <span className="tc-chip">{tool.input.subagent_type}</span> : null}
        <Status state={state} tool={tool} />
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
      </DisclosureBtn>
      {state === "wait" ? null : <TaskBar tool={tool} task={task} />}
      {tool.note ? <div className="tc-note">{tool.note}</div> : null}
      {open ? (
        <div className="tc-b">
          <Body tool={tool} task={task} kind={look.body} />
        </div>
      ) : null}
    </div>
  );
}
