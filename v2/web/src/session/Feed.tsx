// Лента разговора: строки свёртки. Вызовы инструментов — одной строкой с сутью, раскрываются по клику.
import { Text } from "@mantine/core";
import {
  IconAlertTriangle, IconArchive, IconBook, IconBrain, IconChecklist, IconClipboardList, IconFilePencil, IconFilePlus, IconFileText, IconFolderSearch, IconInfoCircle,
  IconMessageQuestion, IconPlayerStop, IconRefresh, IconRobot, IconSearch, IconSparkles, IconTerminal2, IconTool, IconWorld,
} from "@tabler/icons-react";
import { lazy, memo, Suspense, useState, type ReactNode } from "react";
import type { Part, Row, Tool, View } from "../chat/fold.ts";
import { toolLook, toolState } from "../chat/tools.ts";
import { nActions } from "../lib/time.ts";

const Markdown = lazy(() => import("./Markdown.tsx"));
export const Md = ({ text }: { text: string }) => (
  <Suspense fallback={<div className="md" style={{ whiteSpace: "pre-wrap" }}>{text}</div>}>
    <Markdown text={text} />
  </Suspense>
);

const ICONS: Record<string, typeof IconTool> = {
  terminal: IconTerminal2, "file-pen": IconFilePencil, "file-plus": IconFilePlus, "file-text": IconFileText, search: IconSearch, "folder-search": IconFolderSearch, globe: IconWorld,
  "list-checks": IconChecklist, bot: IconRobot, sparkles: IconSparkles, "message-circle-question": IconMessageQuestion, "clipboard-list": IconClipboardList, square: IconPlayerStop,
  "refresh-cw": IconRefresh, archive: IconArchive, info: IconInfoCircle, "book-open": IconBook,
};
const Icon = ({ name, size = 15 }: { name?: string; size?: number }) => {
  const I = (name && ICONS[name]) || IconTool;
  return <I size={size} stroke={1.7} style={{ flex: "none" }} />;
};

function ToolBody({ tool, view }: { tool: Tool; view: View }) {
  const look = toolLook(tool);
  const input = tool.input ?? {};
  const out = tool.result?.text;
  if (look.body === "command") return <><pre>{String(input.command ?? "")}</pre>{out && <pre>{out}</pre>}</>;
  if (look.body === "diff") return <>{input.old_string != null && <pre className="diff-old">{String(input.old_string)}</pre>}<pre className="diff-new">{String(input.new_string ?? input.content ?? "")}</pre></>;
  if (look.body === "todos") return <TodoList todos={(input.todos as any[]) ?? []} />;
  if (look.body === "agent") return <>{input.prompt && <pre>{String(input.prompt)}</pre>}<Rows rows={tool.steps} view={view} />{out && <Md text={out} />}</>;
  if (look.body === "plan") return <Md text={String(input.plan ?? "")} />;
  return <>{look.body === "plain" && Object.keys(input).length > 0 && <pre>{JSON.stringify(input, null, 2)}</pre>}{out && <pre>{out}</pre>}</>;
}

export function TodoList({ todos }: { todos: Array<{ content: string; status: string; activeForm?: string }> }) {
  return (
    <div className="todos">
      {todos.map((t, i) => (
        <span key={i} className={t.status === "completed" ? "done" : ""} style={t.status === "in_progress" ? { fontWeight: 600 } : undefined}>
          {t.status === "completed" ? "✓ " : t.status === "in_progress" ? "▸ " : "○ "}{t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}
        </span>
      ))}
    </div>
  );
}

function ToolLine({ tool, view }: { tool: Tool; view: View }) {
  const look = toolLook(tool);
  const [open, setOpen] = useState(false);
  const state = toolState(tool, tool.task ? view.tasks[tool.task] : undefined, false);
  return (
    <div>
      <button type="button" className="tool" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`st ${state}`} />
        <Icon name={look.icon} />
        <span className="w">{look.word}</span>
        <span className="trunc muted mono">{look.sum}</span>
      </button>
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
    if (p.k === "text") out.push(<Md key={"t" + out.length} text={p.text} />);
    else if (p.text.trim()) out.push(<div key={"h" + out.length} className="sysline"><IconBrain size={14} /> <span className="trunc">{p.text.split("\n")[0]}</span></div>);
  }
  flush();
  return <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>{out}</div>;
}

const RowView = memo(function RowView({ r, view, onCancel }: { r: Row; view: View; onCancel?: (id: string) => void }) {
  switch (r.k) {
    case "me":
      return (
        <div className={`me${r.local === "queued" ? " queued" : ""}`}>
          {r.text}{r.pics.map((p, i) => <img key={i} src={p} alt="" style={{ display: "block", maxWidth: "100%", marginTop: 6, borderRadius: 6 }} />)}
          {r.local === "queued" && <div className="me-note">в очереди, уйдёт после хода{onCancel && r.uuid && <button type="button" className="linkbtn" onClick={() => onCancel(r.uuid!)}>Отменить</button>}</div>}
        </div>
      );
    case "in":
      return <div className="peer"><Text size="xs" className="muted mono">{r.from}{r.at ? ` · ${r.at}` : ""}</Text>{r.text}</div>;
    case "reply":
      return <Reply parts={r.parts} view={view} />;
    case "cmd":
      return <div className="sysline"><IconTerminal2 size={14} /><span className="mono">{r.name} {r.args}</span>{r.out && <span className="trunc">— {r.out}</span>}</div>;
    case "sys":
    case "line":
      return <div className="sysline"><Icon name={r.icon} size={14} /><span>{r.text}{"dim" in r && r.dim}</span></div>;
    case "task": {
      const t = view.tasks[r.id];
      return t ? <div className="sysline"><IconRobot size={14} /><span>{t.desc}{t.summary ? ` — ${t.summary}` : ""}</span></div> : null;
    }
    case "ban":
      return <div className={`ban${r.tone === "bad" ? " bad" : ""}`}><Text fw={600} size="sm"><IconAlertTriangle size={14} style={{ verticalAlign: -2 }} /> {r.title}</Text>{r.body && <Text size="sm">{r.body}</Text>}</div>;
    case "res":
      return <div className="turn-end">{r.bits.join(" · ")}</div>;
    case "end":
      return <div className="ban bad"><Text fw={600} size="sm">{r.text}</Text>{r.why && <Text size="sm">{r.why}</Text>}</div>;
    case "sum":
      return <div className="sysline"><IconArchive size={14} /><span>{r.stats}</span></div>;
  }
});

export function Rows({ rows, view, onCancel }: { rows: Row[]; view: View; onCancel?: (id: string) => void }) {
  return <>{rows.map((r) => <RowView key={r.key} r={r} view={view} onCancel={onCancel} />)}</>;
}
