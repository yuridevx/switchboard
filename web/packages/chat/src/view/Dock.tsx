// Над вводом: вопросы сбоку, идущее в фоне, задачи Claude и вопрос сессии.
import { useEffect, useState } from "react";
import { Bot, Layers, ListChecks, MessageSquareQuote, Square, Terminal, X } from "lucide-react";
import { Btn, IconBtn, Markdown, sessionOf, TextBtn, useApp, useLoad, useModule } from "@switchboard/web-ui";
import type { Chat, Side } from "../state/chat.ts";
import type { Msg, Task, View } from "../state/fold.ts";
import { Dis, useEnv } from "./env.tsx";
import { Todos } from "./ToolCard.tsx";

const OUTPUT_MS = 2000;

type Output = { output: string; total_bytes: number; truncated: boolean };

/** Вопрос сессии: узко — полоса к экрану вопроса; широко — экран в месте над вводом. Открыт, пока открыт чат: ответ «принят» остаётся виден. */
function Asked({ callsign }: { callsign: string }) {
  const app = useApp();
  const asked = app.use(() => app.mark("asked", callsign));
  const waiting = app.use(() => sessionOf(app, callsign)?.state === "waiting");
  const [opened, setOpened] = useState(false);
  if ((asked || waiting) && !opened) setOpened(true);
  return (
    <div className="chat-ask">
      {app.wide ? (
        opened ? (
          <app.Slot screen="ask" params={{ callsign }} />
        ) : null
      ) : asked ? (
        <TextBtn className="chat-askbar" onClick={() => app.open("ask", { callsign })}>
          <b>?</b>
          <span>{asked}</span>
          <em>Ответить</em>
        </TextBtn>
      ) : null}
    </div>
  );
}

function SideCard({ side, callsign }: { side: Side; callsign: string }) {
  const chat = useModule<Chat>();
  return (
    <div className="chat-side" data-state={side.state}>
      <MessageSquareQuote size={14} />
      <div className="chat-side-b">
        <div className="chat-side-q">{side.question}</div>
        {side.state === "wait" ? <div className="chat-side-w">думает…</div> : null}
        {side.state === "done" ? (
          <div className="chat-side-a">
            <Markdown text={side.answer} />
          </div>
        ) : null}
        {side.state === "bad" ? <div className="chat-side-e">{side.answer}</div> : null}
      </div>
      <IconBtn className="chat-side-x" aria-label="Закрыть" onClick={() => chat.closeSide(callsign, side.id)}>
        <X size={14} />
      </IconBtn>
    </div>
  );
}

function TodoDock({ view }: { view: View }) {
  const tool = view.todo ? view.tools[view.todo] : undefined;
  const todos = tool?.input.todos as Msg[] | undefined;
  if (!Array.isArray(todos) || !todos.length || todos.every((t) => t.status === "completed")) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const now = todos.find((t) => t.status === "in_progress");
  return (
    <Dis
      className="chat-todo"
      head={
        <>
          <ListChecks size={14} />
          <b>{`${done} из ${todos.length}`}</b>
          {now ? <span>{String(now.activeForm ?? now.content)}</span> : null}
        </>
      }
    >
      <Todos todos={todos} />
    </Dis>
  );
}

/** Вывод идущей команды: перечитывается раз в 2 с, пока открыт. */
function TaskOutput({ id, callsign }: { id: string; callsign: string }) {
  const chat = useModule<Chat>();
  const { data, error, reload } = useLoad<Output>(() => chat.ask<Output>(callsign, "getTaskOutput", [id]), [chat, callsign, id]);
  useEffect(() => {
    const h = setInterval(reload, OUTPUT_MS);
    return () => clearInterval(h);
  }, [reload]);
  return (
    <div className="chat-out">
      {error ? (
        <div className="chat-out-e">{error}</div>
      ) : (
        <>
          {data?.truncated ? <div className="chat-out-h">{`последние 8 КБ из ${Math.round(data.total_bytes / 1024)} КБ`}</div> : null}
          <pre>{data ? data.output || "пока пусто" : "читаю…"}</pre>
        </>
      )}
    </div>
  );
}

function BgRow({ task, callsign }: { task: Task; callsign: string }) {
  const env = useEnv();
  const [show, setShow] = useState(false);
  const shell = task.type === "local_bash" || task.type === "monitor";
  return (
    <div className="chat-bgw">
      <div className="chat-bgr">
        {task.type === "local_agent" ? <Bot size={14} /> : <Terminal size={14} />}
        <span title={task.desc}>{task.desc || task.id}</span>
        {task.summary ? <em>{task.summary}</em> : null}
        {env.canCall && shell ? (
          <Btn type="button" className="chat-mini" onClick={() => setShow(!show)}>
            {show ? "Скрыть" : "Вывод"}
          </Btn>
        ) : null}
        {env.canCall ? (
          <Btn type="button" className="chat-mini" onClick={() => env.act("stopTask", [task.id])}>
            <Square size={11} />
            Стоп
          </Btn>
        ) : null}
      </div>
      {show && env.canCall && shell ? <TaskOutput id={task.id} callsign={callsign} /> : null}
    </div>
  );
}

function BgDock({ view, callsign }: { view: View; callsign: string }) {
  const tasks = Object.values(view.tasks).filter((t) => t.bg && !t.ended);
  if (!tasks.length) return null;
  return (
    <Dis
      className="chat-bg"
      head={
        <>
          <Layers size={14} />
          <b>{`В фоне: ${tasks.length}`}</b>
          <span>{tasks[0].desc}</span>
        </>
      }
    >
      {tasks.map((t) => (
        <BgRow key={t.id} task={t} callsign={callsign} />
      ))}
    </Dis>
  );
}

export function Dock({ callsign, view, sides }: { callsign: string; view: View; sides: Side[] }) {
  return (
    <div className="chat-dock">
      {sides.map((s) => (
        <SideCard key={s.id} side={s} callsign={callsign} />
      ))}
      <BgDock view={view} callsign={callsign} />
      <TodoDock view={view} />
      <Asked callsign={callsign} />
    </div>
  );
}
