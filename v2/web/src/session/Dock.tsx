// Над вводом: вопросы сбоку и то, что идёт сейчас, — субагенты и фоновые задачи с шагами, выводом и остановкой.
import { sessionCall } from "@sb/protocol";
import { IconRobot, IconTerminal2, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { act, api, sayError } from "../api.ts";
import { taskIcon, type Task, type Tool, type View } from "../chat/fold.ts";
import { agentSteps, isAgent } from "../chat/tools.ts";
import { duration, plural } from "../lib/time.ts";
import { Md, Rows } from "./Feed.tsx";
import type { Aside } from "./talk.ts";

const OUTPUT_EVERY_MS = 2000;
type Output = { output?: string; total_bytes?: number; truncated?: boolean };

/** Вывод фоновой задачи: перечитывается, пока открыт. */
function TaskOutput({ callsign, id }: { callsign: string; id: string }) {
  const [got, setGot] = useState<Output | null>(null);
  const [word, setWord] = useState("");
  useEffect(() => {
    let alive = true;
    const ask = () => api.call(sessionCall, { to: callsign, method: "taskOutput", args: [id] }).then((r) => alive && setGot((r ?? {}) as Output), (e) => alive && setWord(sayError(e)));
    void ask();
    const timer = setInterval(ask, OUTPUT_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [callsign, id]);
  return (
    <div className="bg-out">
      {got?.truncated && <div className="muted" style={{ padding: "4px 10px 0", fontSize: 12 }}>конец вывода, всего {Math.round((got.total_bytes ?? 0) / 1024)} КБ</div>}
      <pre>{word || (got ? got.output || "пока пусто" : "читаю…")}</pre>
    </div>
  );
}

export type Run = { id: string; task?: Task; tool?: Tool };
/** Что идёт сейчас у сессии: незаконченные задачи (субагенты и фоновые команды) и субагенты, о которых SDK ещё не прислал задачу. */
export function runningOf(v: View): Run[] {
  const tasks: Run[] = Object.values(v.tasks).filter((t) => !t.end).map((t) => ({ id: t.id, task: t, tool: t.tool ? v.tools[t.tool] : undefined }));
  const bare: Run[] = Object.values(v.tools).filter((t) => isAgent(t) && !t.result && !t.task).map((t) => ({ id: t.id, tool: t }));
  // субагенты — раньше команд; внутри — по времени запуска
  const agent = (r: Run) => (r.tool ? isAgent(r.tool) : taskIcon(r.task?.type) === "bot");
  return [...tasks, ...bare].sort((x, y) => Number(agent(y)) - Number(agent(x)) || (x.task?.started ?? 0) - (y.task?.started ?? 0));
}

function RunRow({ callsign, run, view, now }: { callsign: string; run: Run; view: View; now: number }) {
  const [open, setOpen] = useState(false);
  const { task, tool } = run;
  const agent = tool ? isAgent(tool) : taskIcon(task?.type) === "bot";
  const kind = agent ? (typeof tool?.input?.subagent_type === "string" ? tool.input.subagent_type : "субагент") : task?.type === "monitor" ? "монитор" : "команда";
  const desc = task?.desc || (typeof tool?.input?.description === "string" ? tool.input.description : "") || run.id;
  const doing = task?.summary ?? (task?.last ? `сейчас: ${task.last}` : "");
  const steps = tool && agent ? agentSteps(tool, task) : (task?.steps ?? 0);
  const act1 = (method: "tasks" | "taskStop", id: string, said: string) => act(sessionCall, { to: callsign, method, args: [id] }, said);
  return (
    <>
      <div className="run-row" data-run={run.id}>
        <button type="button" className="run-main" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="st running" />
          {agent ? <IconRobot size={14} /> : <IconTerminal2 size={14} />}
          <span className="toolchip">{kind}</span>
          <span className={`trunc${agent ? "" : " mono"}`} title={desc}>{desc}</span>
          {doing && <span className="trunc muted run-now">{doing}</span>}
        </button>
        <span className="muted run-n steps">{steps > 0 ? `${steps} ${plural(steps, "шаг", "шага", "шагов")}` : ""}</span>
        <span className="muted run-n time">{task ? duration(Math.max(0, now - task.started)) : ""}</span>
        {task?.bg ? <span className="muted run-n bgw">в фоне</span> : tool ? <button type="button" className="linkbtn bgw" onClick={() => act1("tasks", tool.id, "Ушло в фон")}>в фон</button> : <span className="bgw" />}
        {task && <button type="button" className="linkbtn" onClick={() => act1("taskStop", task.id, "Остановлено")}>стоп</button>}
      </div>
      {open && (agent
        ? <div className="run-steps">{tool?.input?.prompt && <pre>{String(tool.input.prompt)}</pre>}{tool?.steps.length ? <Rows rows={tool.steps} view={view} /> : <span className="muted">шагов пока нет</span>}</div>
        : task && <TaskOutput callsign={callsign} id={task.id} />)}
    </>
  );
}

/** «Идут сейчас»: по строке на работающего субагента и фоновую задачу; нажатие раскрывает шаги или вывод на месте. Законченное остаётся карточкой в ленте. */
export function Running({ callsign, view }: { callsign: string; view: View }) {
  const runs = runningOf(view);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!runs.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [runs.length]);
  if (!runs.length) return null;
  return <div className="runs" role="group" aria-label="Идут сейчас">{runs.map((r) => <RunRow key={r.id} callsign={callsign} run={r} view={view} now={now} />)}</div>;
}

/** Вопросы сбоку: ответ Claude мимо разговора; закрываются крестиком. */
export function Asides({ asides, drop }: { asides: Aside[]; drop(id: string): void }) {
  return (
    <>
      {asides.map((a) => (
        <div key={a.id} className="aside">
          <div style={{ display: "flex", gap: 8, alignItems: "start" }}>
            <span style={{ flex: 1, fontWeight: 500, overflowWrap: "anywhere" }}>{a.q}</span>
            <button type="button" className="linkbtn" aria-label="Закрыть вопрос сбоку" onClick={() => drop(a.id)}><IconX size={14} /></button>
          </div>
          {a.state === "wait" ? <span className="muted">Claude отвечает…</span> : a.state === "bad" ? <span style={{ color: "var(--st-failed)" }}>{a.a}</span> : <Md text={a.a ?? ""} />}
        </div>
      ))}
    </>
  );
}
