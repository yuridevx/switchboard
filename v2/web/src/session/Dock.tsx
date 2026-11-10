// Над вводом: вопросы сбоку и то, что идёт в фоне, — с выводом задачи и остановкой.
import { sessionCall } from "@sb/protocol";
import { IconRobot, IconTerminal2, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { act, api, sayError } from "../api.ts";
import { backgrounded, taskIcon, type Task, type View } from "../chat/fold.ts";
import { plural } from "../lib/time.ts";
import { Md } from "./Feed.tsx";
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

function BgRow({ callsign, task }: { callsign: string; task: Task }) {
  const [open, setOpen] = useState(false);
  const withOutput = task.type === "local_bash" || task.type === "monitor";
  return (
    <>
      <div className="bg-row">
        {taskIcon(task.type) === "bot" ? <IconRobot size={14} /> : <IconTerminal2 size={14} />}
        <span className="trunc mono" style={{ flex: 1 }} title={task.desc || task.id}>{task.desc || task.id}</span>
        {task.summary && <span className="trunc muted">{task.summary}</span>}
        {!!task.steps && <span className="muted" style={{ whiteSpace: "nowrap" }}>{task.steps} {plural(task.steps, "шаг", "шага", "шагов")}</span>}
        {withOutput && <button type="button" className="linkbtn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Скрыть" : "Вывод"}</button>}
        <button type="button" className="linkbtn" onClick={() => act(sessionCall, { to: callsign, method: "taskStop", args: [task.id] }, "Задача остановлена")}>Стоп</button>
      </div>
      {open && <TaskOutput callsign={callsign} id={task.id} />}
    </>
  );
}

/** Что идёт в фоне у сессии. */
export function Background({ callsign, view }: { callsign: string; view: View }) {
  const tasks = backgrounded(view);
  if (!tasks.length) return null;
  return <div className="bg" aria-label="В фоне">{tasks.map((t) => <BgRow key={t.id} callsign={callsign} task={t} />)}</div>;
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
