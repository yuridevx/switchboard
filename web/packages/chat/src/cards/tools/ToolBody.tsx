// Тело карточки инструмента: что делалось и что вышло — по виду инструмента.
import type { ReactNode } from "react";
import { isHtmlDocument } from "../../state/parse.ts";
import type { Task, Tool } from "../../state/types.ts";
import { langOfPath, useHighlighted } from "../../ui/highlight.tsx";
import { HtmlFrame } from "../../ui/HtmlFrame.tsx";
import { Markdown } from "../../ui/Markdown.tsx";
import { baseName } from "../format.ts";
import { Diff } from "./Diff.tsx";
import { SubAgent } from "./SubAgent.tsx";
import { Todos } from "./Todos.tsx";

const Hint = ({ children }: { children: ReactNode }) => <div className="tb-hint">{children}</div>;

function Pre({ text, tone }: { text: string; tone?: "bad" | "muted" }) {
  return <pre className={tone ? `tb-pre ${tone}` : "tb-pre"}>{text || "—"}</pre>;
}

/** Вывод инструмента; ошибка — красным; картинки — следом. */
function Result({ t }: { t: Tool }) {
  if (!t.result) return <div className="tb-wait">ждём результата…</div>;
  return (
    <>
      {t.result.text || !t.result.images.length ? <Pre text={t.result.text || "без вывода"} tone={t.result.isError ? "bad" : undefined} /> : null}
      {t.result.images.map((u, i) => (
        <img key={i} className="tb-img" src={u} alt={`картинка ${i + 1}`} />
      ))}
    </>
  );
}

/** Файл: код с подсветкой по расширению; строки с номерами Read показываются как есть. */
function FileResult({ t }: { t: Tool }) {
  const text = t.result?.text ?? "";
  const nodes = useHighlighted(text, t.result && !t.result.isError ? langOfPath(t.input.file_path) : "");
  if (!t.result || t.result.isError || t.result.images.length || !text) return <Result t={t} />;
  return (
    <pre className="tb-pre">
      <code className="hljs">{nodes}</code>
    </pre>
  );
}

/** Запись файла: HTML и SVG видно страницей, рядом — код. */
function WriteBody({ t }: { t: Tool }) {
  const html = /\.(html?|svg)$/i.test(baseName(t.input.file_path)) || isHtmlDocument(t.input.content ?? "");
  return (
    <>
      {html ? <HtmlFrame html={t.input.content ?? ""} title={baseName(t.input.file_path)} /> : null}
      <Diff t={t} />
      {t.result?.isError ? <Pre text={t.result.text} tone="bad" /> : null}
    </>
  );
}

export function ToolBody({ t, task }: { t: Tool; task?: Task }) {
  const i = t.input;
  switch (t.name) {
    case "Bash":
    case "PowerShell":
      return (
        <>
          {i.description ? <Hint>{i.description}</Hint> : null}
          <Pre text={`${t.name === "Bash" ? "$" : "PS>"} ${i.command ?? ""}`} tone="muted" />
          <Result t={t} />
        </>
      );
    case "Edit":
    case "MultiEdit":
      return (
        <>
          {i.replace_all ? <Hint>все вхождения</Hint> : null}
          <Diff t={t} />
          {t.result?.isError ? <Pre text={t.result.text} tone="bad" /> : null}
        </>
      );
    case "Write":
      return <WriteBody t={t} />;
    case "NotebookEdit":
      return (
        <>
          {i.cell_id ? <Hint>{`ячейка ${i.cell_id}`}</Hint> : null}
          <Diff t={t} />
        </>
      );
    case "Read":
      return <FileResult t={t} />;
    case "TodoWrite":
      return <Todos todos={i.todos} />;
    case "WebFetch":
      return (
        <>
          {i.prompt ? <Hint>{i.prompt}</Hint> : null}
          <Result t={t} />
        </>
      );
    case "Task":
    case "Agent":
      return <SubAgent t={t} task={task} />;
    case "ExitPlanMode":
      return (
        <div className="tb-md">
          <Markdown text={i.plan ?? ""} />
        </div>
      );
    case "AskUserQuestion":
      return (
        <div className="tb-md">
          {(i.questions ?? []).map((q) => (
            <div key={q.question} className="tb-q">
              <b>{q.question}</b>
              <span>{i.answers?.[q.question] ?? (q.options ?? []).map((o) => o.label).join(" · ")}</span>
            </div>
          ))}
        </div>
      );
    case "Grep":
    case "Glob":
    case "WebSearch":
    case "Skill":
      return <Result t={t} />;
    default:
      return (
        <>
          <Pre text={JSON.stringify(i, null, 2)} tone="muted" />
          <Result t={t} />
        </>
      );
  }
}
