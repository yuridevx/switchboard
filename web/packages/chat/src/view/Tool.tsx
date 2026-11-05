// Карточка инструмента: шапка с состоянием, полоса задачи, тело по виду инструмента.
import { useState, type ReactNode } from "react";
import { diffLines } from "diff";
import { Btn, DisclosureBtn, HtmlFrame, langOfPath, Markdown, useApp, useHighlighted, useNow } from "@switchboard/web-ui";
import { deniedWhy, fold, type Msg, type Tool } from "../fold.ts";
import { shapeOf } from "../words.ts";
import { EnvCtx, useEnv } from "./env.ts";
import { Icon } from "./icons.tsx";
import { Dis, Rows } from "./Rows.tsx";

const OPEN = new Set(["Edit", "MultiEdit", "TodoWrite", "AskUserQuestion", "ExitPlanMode"]);
const SHELLS: Record<string, string> = { Bash: "$", PowerShell: "PS>" };
const SEARCH = new Set(["Grep", "Glob", "WebSearch"]);
const AGENTS = new Set(["Agent", "Task"]);
const LAUNCHED = /^Async agent launched/;

const textOf = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : c == null ? "" : JSON.stringify(c));
const imagesOf = (c: unknown): string[] => (Array.isArray(c) ? c.filter((b) => b?.type === "image" && b.source?.data).map((b) => `data:${b.source.media_type};base64,${b.source.data}`) : []);
const isPage = (path: unknown, content: unknown) => /\.(html?|svg)$/i.test(String(path ?? "")) || /^\s*<!doctype html/i.test(String(content ?? ""));

type Line = { kind: "add" | "del" | "same"; text: string };
function linesOf(before: string, after: string): Line[] {
  return diffLines(before, after).flatMap((p) => p.value.replace(/\n$/, "").split("\n").map((text) => ({ kind: p.added ? "add" : p.removed ? "del" : "same", text }) as Line));
}
const countOf = (pairs: Array<[string, string]>) => pairs.flatMap(([a, b]) => linesOf(a, b)).reduce((n, l) => ({ add: n.add + (l.kind === "add" ? 1 : 0), del: n.del + (l.kind === "del" ? 1 : 0) }), { add: 0, del: 0 });

function Diff({ before, after }: { before: string; after: string }) {
  const out: Array<Line | { kind: "fold"; n: number }> = [];
  const lines = linesOf(before, after);
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && lines[j].kind === "same") j++;
    if (j - i > 6) {
      out.push(...lines.slice(i, i + 2), { kind: "fold", n: j - i - 4 }, ...lines.slice(j - 2, j));
      i = j;
    } else if (j > i) {
      out.push(...lines.slice(i, j));
      i = j;
    } else out.push(lines[i++]);
  }
  return (
    <div className="chat-diff">
      {out.map((l, i) =>
        l.kind === "fold" ? (
          <div key={i} className="same">
            <i> </i>
            <span>{`⋯ ${l.n} без изменений`}</span>
          </div>
        ) : (
          <div key={i} className={l.kind}>
            <i>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</i>
            <span>{l.text}</span>
          </div>
        ),
      )}
    </div>
  );
}

const editsOf = (t: Tool): Array<[string, string]> => {
  const i = t.input;
  if (t.name === "Edit") return [[String(i.old_string ?? ""), String(i.new_string ?? "")]];
  if (t.name === "MultiEdit") return ((i.edits ?? []) as Msg[]).map((e) => [String(e.old_string ?? ""), String(e.new_string ?? "")]);
  if (t.name === "Write") return [["", String(i.content ?? "")]];
  if (t.name === "NotebookEdit") return [["", String(i.new_source ?? "")]];
  return [];
};

function Highlighted({ code, path }: { code: string; path: unknown }) {
  const nodes = useHighlighted(code, langOfPath(String(path ?? "")));
  return (
    <pre className="tb-pre">
      <code className="hljs">{nodes}</code>
    </pre>
  );
}

/** Итог инструмента: ждём, ошибка, картинки, текст; Read — с подсветкой. */
function Out({ t, code }: { t: Tool; code?: boolean }) {
  if (!t.result) return <div className="tb-wait">ждём результата…</div>;
  const c = t.result.content;
  const denied = t.result.error ? deniedWhy(c) : null;
  if (denied !== null) return denied ? <pre className="tb-pre">{denied}</pre> : null;
  const text = textOf(c);
  const pics = imagesOf(c);
  if (t.result.error) return <pre className="tb-pre bad">{text}</pre>;
  return (
    <>
      {text ? code ? <Highlighted code={text} path={t.input.file_path} /> : <pre className="tb-pre">{text}</pre> : !pics.length && <pre className="tb-pre">без вывода</pre>}
      {pics.map((src, i) => (
        <img key={i} className="tb-img" src={src} alt={`картинка ${i + 1}`} />
      ))}
    </>
  );
}
const Bad = ({ t }: { t: Tool }) => (t.result?.error && deniedWhy(t.result.content) === null ? <pre className="tb-pre bad">{textOf(t.result.content)}</pre> : null);
const Hint = ({ children }: { children: ReactNode }) => (children ? <div className="tb-hint">{children}</div> : null);

export function Todos({ todos }: { todos: Msg[] }) {
  return (
    <ul className="chat-todos">
      {todos.map((x, i) => (
        <li key={i} data-status={x.status}>
          <Icon name={x.status === "completed" ? "circle-check" : x.status === "in_progress" ? "circle-dot" : "circle"} size={14} />
          <span>{x.status === "in_progress" ? (x.activeForm ?? x.content) : x.content}</span>
        </li>
      ))}
    </ul>
  );
}

function Agent({ t }: { t: Tool }) {
  const env = useEnv();
  const sub = fold(t.sub, true);
  const task = t.task ? env.view.tasks[t.task] : undefined;
  const result = t.result && !LAUNCHED.test(textOf(t.result.content)) ? textOf(t.result.content) : task && task.status !== "running" ? task.summary : undefined;
  return (
    <div className="tb-agent">
      {typeof t.input.prompt === "string" && (
        <Dis head="Задание">
          <div className="tb-prompt">{t.input.prompt}</div>
        </Dis>
      )}
      {sub.rows.length > 0 && (
        <div className="tb-steps">
          <EnvCtx.Provider value={{ ...env, view: { ...sub, tasks: env.view.tasks } }}>
            <Rows rows={sub.rows} />
          </EnvCtx.Provider>
        </div>
      )}
      {result && (
        <div className="tb-final">
          <Markdown text={result} />
        </div>
      )}
    </div>
  );
}

function Body({ t }: { t: Tool }) {
  const i = t.input;
  if (SHELLS[t.name])
    return (
      <>
        <Hint>{i.description as string}</Hint>
        <pre className="tb-pre muted">{`${SHELLS[t.name]} ${i.command ?? ""}`}</pre>
        <Out t={t} />
      </>
    );
  if (t.name === "Read") return <Out t={t} code />;
  if (SEARCH.has(t.name)) return <Out t={t} />;
  if (t.name === "WebFetch")
    return (
      <>
        <Hint>{i.prompt as string}</Hint>
        <Out t={t} />
      </>
    );
  if (editsOf(t).length || ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(t.name))
    return (
      <>
        <Hint>{t.name === "NotebookEdit" ? (i.cell_id ? `ячейка ${i.cell_id}` : "") : i.replace_all ? "все вхождения" : ""}</Hint>
        {t.name === "Write" && isPage(i.file_path, i.content) && <HtmlFrame html={String(i.content ?? "")} title={String(i.file_path ?? "").split(/[\\/]/).pop()} />}
        {editsOf(t).map(([a, b], n) => (
          <Diff key={n} before={a} after={b} />
        ))}
        <Bad t={t} />
      </>
    );
  if (t.name === "TodoWrite")
    return (
      <>
        <Todos todos={(i.todos ?? []) as Msg[]} />
        <Bad t={t} />
      </>
    );
  if (t.name === "AskUserQuestion") {
    const answers = (i.answers ?? {}) as Record<string, string>;
    return (
      <>
        <div className="tb-md">
          {((i.questions ?? []) as Msg[]).map((q, n) => (
            <div key={n} className="tb-q">
              <b>{q.question}</b>
              <span>{answers[q.question] ?? ((q.options ?? []) as Msg[]).map((o) => o.label).join(" · ")}</span>
            </div>
          ))}
        </div>
        <Bad t={t} />
      </>
    );
  }
  if (t.name === "ExitPlanMode")
    return (
      <>
        <div className="tb-md">
          <Markdown text={String(i.plan ?? "")} />
        </div>
        <Bad t={t} />
      </>
    );
  if (AGENTS.has(t.name)) return <Agent t={t} />;
  return (
    <>
      <pre className="tb-pre muted">{JSON.stringify(i, null, 2)}</pre>
      <Out t={t} />
    </>
  );
}

function Bar({ t }: { t: Tool }) {
  const env = useEnv();
  const now = useNow(1000);
  const task = t.task ? env.view.tasks[t.task] : undefined;
  const app = useApp();
  const can = app.use(() => env.canAct && !env.waiting(t.id));
  const bg = (
    <Btn type="button" className="chat-mini" onClick={() => env.act("backgroundTasks", [t.id])}>
      <Icon name="arrow-down-to-line" />В фон
    </Btn>
  );
  if (!task || task.status !== "running") return !task && !t.result && SHELLS[t.name] && can ? <div className="tc-bar">{bg}</div> : null;
  const agent = task.type === "local_agent" || AGENTS.has(t.name);
  const secs = Math.max(0, Math.round((now - task.since) / 1000));
  const about = agent ? [task.summary ?? (task.last ? `сейчас: ${task.last}` : ""), task.uses !== undefined ? `шагов ${task.uses}` : ""].filter(Boolean) : [];
  return (
    <div className="tc-bar">
      <span>{[`идёт ${secs} с`, ...about].join(" · ")}</span>
      {can && !task.bg && bg}
      {can && (
        <Btn type="button" className="chat-mini" onClick={() => env.act("stopTask", [task.id])}>
          <Icon name="square" />
          Стоп
        </Btn>
      )}
    </div>
  );
}

/** Состояние карточки: data-state и слово. */
function stateOf(t: Tool, waiting: boolean, taskStatus?: string, taskBg?: boolean): { state: string; st?: ReactNode; tone?: string; chip?: string } {
  const chip = t.bg || (taskBg && taskStatus !== "running") ? "в фоне" : undefined;
  if (waiting) return { state: "wait", st: t.name === "ExitPlanMode" ? "ждёт одобрения" : "ждёт разрешения", tone: "wait" };
  if (taskStatus === "stopped" || taskStatus === "killed") return { state: "stopped", st: "остановлено", tone: "wait", chip };
  if (t.result?.error) return deniedWhy(t.result.content) !== null ? { state: "denied", st: "отклонено" } : { state: "error", st: <><Icon name="x" />ошибка</>, tone: "bad", chip };
  if (taskStatus === "running" && (taskBg || (t.result && LAUNCHED.test(textOf(t.result.content))))) return { state: "bg", st: "в фоне", tone: "run" };
  if (t.result) return { state: "ok", st: t.name === "TodoWrite" ? undefined : <Icon name="check" size={14} />, tone: "ok", chip };
  return { state: "running", st: <><Icon name="loader-circle" />{t.elapsed ? `${t.elapsed} с` : ""}</>, tone: "run", chip };
}

export function ToolCard({ id }: { id: string }) {
  const env = useEnv();
  const app = useApp();
  const t = env.view.tools[id];
  const [toggled, setToggled] = useState<boolean | null>(null);
  const waiting = app.use(() => env.waiting(id));
  if (!t) return null;
  const task = t.task ? env.view.tasks[t.task] : undefined;
  const shape = shapeOf(t.name, t.input);
  const s = stateOf(t, waiting, task?.status, task?.bg);
  const chip = s.chip ?? (AGENTS.has(t.name) && typeof t.input.subagent_type === "string" ? t.input.subagent_type : undefined);
  const edits = editsOf(t);
  const count = edits.length ? countOf(edits) : null;
  const byDefault = (OPEN.has(t.name) && !(t.name === "ExitPlanMode" && waiting)) || (AGENTS.has(t.name) && !t.result);
  const open = toggled ?? byDefault;
  return (
    <div className="chat-tool" data-tool={t.name} data-state={s.state}>
      <DisclosureBtn className="tc-h" open={open} onClick={() => setToggled(!open)}>
        <span className="tc-i">
          <Icon name={shape.icon} size={15} />
        </span>
        <b>{shape.word}</b>
        <span className="tc-sum" title={shape.sum}>
          {shape.sum}
        </span>
        {chip && <span className="tc-chip">{chip}</span>}
        {count && (
          <span className="chat-count">
            <b>{`+${count.add}`}</b> <s>{`−${count.del}`}</s>
          </span>
        )}
        {s.st !== undefined && (
          <em className={["tc-st", s.tone].filter(Boolean).join(" ")} aria-label={s.state === "ok" ? "готово" : undefined}>
            {s.st}
          </em>
        )}
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
      </DisclosureBtn>
      <Bar t={t} />
      {t.note && <div className="tc-note">{t.note}</div>}
      {open && (
        <div className="tc-b">
          <Body t={t} />
        </div>
      )}
    </div>
  );
}
