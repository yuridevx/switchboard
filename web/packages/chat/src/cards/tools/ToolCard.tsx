// Карточка инструмента: шапка (значок, что, суть, состояние), полоса идущей задачи, тело по нажатию.
// Состояние выбирает сама: секунды и итог перерисовывают только её.
import { useState } from "react";
import { ArrowDownToLine, Check, ChevronDown, ChevronRight, Loader2, Square, X } from "lucide-react";
import { Btn, DisclosureBtn, useNow } from "@switchboard/web-ui";
import { useAsking, useCards, useFeed } from "../../context.ts";
import type { Task, Tool } from "../../state/types.ts";
import { DiffCount } from "./Diff.tsx";
import { isAgent, isRefused, isShell, kindOf } from "./kinds.tsx";
import type { RenderPart } from "./SubAgent.tsx";
import { ToolBody } from "./ToolBody.tsx";

/** Результат «ушла в фон» — и в истории, где задач claude уже нет. */
const BG_RESULT = /^(Async agent launched|Command running in background|Command was manually backgrounded)/;

type State = "wait" | "running" | "bg" | "stopped" | "ok" | "denied" | "error";

function stateOf(t: Tool, asking: boolean, task?: Task): State {
  if (asking && !t.result) return "wait";
  if (task?.status === "stopped" || task?.status === "killed") return "stopped";
  if (task?.background && task.status === "running") return "bg";
  if (!t.result) return "running";
  if (!t.result.isError) return "ok";
  return isRefused(t.result.text) ? "denied" : "error";
}

function StateMark({ st, secs, plan }: { st: State; secs?: number; plan: boolean }) {
  switch (st) {
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
function TaskBar({ task, t }: { task: Task; t: Tool }) {
  const v = useCards();
  const secs = Math.max(0, Math.round((useNow(1000) - task.startedAt) / 1000));
  const agent = task.type === "local_agent";
  return (
    <div className="tc-bar">
      <span>
        {`идёт ${secs} с`}
        {agent && (task.summary || task.lastTool) ? ` · ${task.summary ?? `сейчас: ${task.lastTool}`}` : ""}
        {agent && task.toolUses ? ` · шагов ${task.toolUses}` : ""}
      </span>
      {!task.background && v.background ? (
        <Btn type="button" className="chat-mini" onClick={() => v.background!(t.id)}>
          <ArrowDownToLine size={13} />В фон
        </Btn>
      ) : null}
      {v.stopTask ? (
        <Btn type="button" className="chat-mini" onClick={() => v.stopTask!(task.id)}>
          <Square size={11} />
          Стоп
        </Btn>
      ) : null}
    </div>
  );
}

export function ToolCard({ id, renderPart }: { id: string; renderPart: RenderPart }) {
  const v = useCards();
  const t = useFeed((f) => f.tools[id]);
  const task = useFeed((f) => Object.values(f.tasks).find((x) => x.toolUseId === id));
  const asking = useAsking(id);
  const [picked, setPicked] = useState<boolean | null>(null);
  if (!t) return null;
  const k = kindOf(t);
  const st = stateOf(t, asking, task);
  // план на одобрении уже развёрнут над вводом: второй раз в карточке он не нужен
  const open = picked ?? (!!k.open && !(asking && t.name === "ExitPlanMode"));
  const wentBg = (isShell(t) || isAgent(t)) && st !== "bg" && (t.input.run_in_background || task?.background || BG_RESULT.test(t.result?.text ?? ""));
  return (
    <div className="chat-tool" data-tool={t.name} data-state={st}>
      <DisclosureBtn className="tc-h" open={open} onClick={() => setPicked(!open)}>
        <span className="tc-i">{k.icon}</span>
        <b>{k.label}</b>
        <span className="tc-sum" title={k.summary}>
          {k.summary}
        </span>
        {t.name === "Edit" || t.name === "MultiEdit" ? <DiffCount t={t} /> : null}
        {wentBg ? <span className="tc-chip">в фоне</span> : null}
        {isAgent(t) && t.input.subagent_type ? <span className="tc-chip">{t.input.subagent_type}</span> : null}
        {t.name === "TodoWrite" && st === "ok" ? null : <StateMark st={st} secs={t.secs} plan={t.name === "ExitPlanMode"} />}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </DisclosureBtn>
      {task?.status === "running" ? <TaskBar task={task} t={t} /> : !task && st === "running" && isShell(t) && v.background ? (
        <div className="tc-bar">
          <span />
          <Btn type="button" className="chat-mini" onClick={() => v.background!(t.id)}>
            <ArrowDownToLine size={13} />В фон
          </Btn>
        </div>
      ) : null}
      {t.summary ? <div className="tc-note">{t.summary}</div> : null}
      {open ? (
        <div className="tc-b">
          <ToolBody t={t} task={task} renderPart={renderPart} />
        </div>
      ) : null}
    </div>
  );
}
