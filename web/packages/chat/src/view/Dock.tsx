// Над вводом: вопросы сбоку, задачи Claude, идущее в фоне и вопрос сессии (узко — полоса к экрану, широко — экран ask в месте).
import { useEffect, useState } from "react";
import { Bot, Layers, ListChecks, MessageSquareQuote, Square, Terminal, X } from "lucide-react";
import { Btn, IconBtn, Markdown, TextBtn, useApp, useModule } from "@switchboard/web-ui";
import { backgrounded, type Task } from "../fold.ts";
import type { Chats } from "../store.ts";
import { Dis } from "./Rows.tsx";
import { TodoList } from "./Tool.tsx";

const OUTPUT_EVERY_MS = 2000;
/** Сколько вывода отдаёт SDK за раз. */
const OUTPUT_TAIL = "8 КБ";

type Output = { output?: string; total_bytes?: number; truncated?: boolean };

function TaskOutput({ callsign, id }: { callsign: string; id: string }) {
  const chats = useModule<Chats>();
  const [got, setGot] = useState<Output | null>(null);
  const [word, setWord] = useState("");
  useEffect(() => {
    const ask = () =>
      void chats.read<Output>(callsign, "getTaskOutput", [id]).then((r) => {
        if (r.ok) setGot(r.result);
        else setWord(r.error);
      });
    ask();
    const timer = setInterval(ask, OUTPUT_EVERY_MS);
    return () => clearInterval(timer);
  }, [callsign, id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="chat-out">
      {got?.truncated ? <div className="chat-out-h">{`последние ${OUTPUT_TAIL} из ${Math.round((got.total_bytes ?? 0) / 1024)} КБ`}</div> : null}
      {word ? <div className="chat-out-e">{word}</div> : <pre>{got ? got.output || "пока пусто" : "читаю…"}</pre>}
    </div>
  );
}

function BgRow({ callsign, task }: { callsign: string; task: Task }) {
  const chats = useModule<Chats>();
  const canAct = useApp().use(() => chats.canAct(callsign));
  const [output, setOutput] = useState(false);
  const agent = task.type === "local_agent";
  const withOutput = task.type === "local_bash" || task.type === "monitor";
  return (
    <div className="chat-bgw">
      <div className="chat-bgr">
        {agent ? <Bot size={14} /> : <Terminal size={14} />}
        <span title={task.desc || task.id}>{task.desc || task.id}</span>
        {task.summary ? <em>{task.summary}</em> : null}
        {canAct && withOutput ? (
          <Btn type="button" className="chat-mini" onClick={() => setOutput(!output)}>
            {output ? "Скрыть" : "Вывод"}
          </Btn>
        ) : null}
        {canAct ? (
          <Btn type="button" className="chat-mini" onClick={() => void chats.act(callsign, "stopTask", [task.id])}>
            <Square size={11} />
            Стоп
          </Btn>
        ) : null}
      </div>
      {output ? <TaskOutput callsign={callsign} id={task.id} /> : null}
    </div>
  );
}

function AskPlace({ callsign }: { callsign: string }) {
  const app = useApp();
  const asked = app.use(() => app.mark("asked", callsign));
  // широко экран остаётся после ответа: на нём итог; пока вопроса не было — места нет
  const seen = app.use((was?: boolean) => !!was || !!app.mark("asked", callsign));
  if (app.wide) return <div className="chat-ask">{seen ? <app.Slot screen="ask" params={{ callsign }} /> : null}</div>;
  return (
    <div className="chat-ask">
      {asked ? (
        <TextBtn className="chat-askbar" onClick={() => app.open("ask", { callsign })}>
          <b>?</b>
          <span>{asked}</span>
          <em>Ответить</em>
        </TextBtn>
      ) : null}
    </div>
  );
}

export function Dock({ callsign }: { callsign: string }) {
  const app = useApp();
  const chats = useModule<Chats>();
  const sides = app.use(() => chats.conv(callsign).sides);
  const todos = app.use(() => chats.conv(callsign).view.todos);
  const tasks = app.use(() => backgrounded(chats.conv(callsign).view));
  const left = todos?.filter((t) => t.status !== "completed") ?? [];
  const doing = todos?.find((t) => t.status === "in_progress");
  return (
    <div className="chat-dock">
      {sides.map((s) => (
        <div key={s.id} className="chat-side" data-state={s.state}>
          <MessageSquareQuote size={14} />
          <div className="chat-side-b">
            <div className="chat-side-q">{s.q}</div>
            {s.state === "wait" ? <div className="chat-side-w">думает…</div> : null}
            {s.state === "done" ? (
              <div className="chat-side-a">
                <Markdown text={s.a} />
              </div>
            ) : null}
            {s.state === "bad" ? <div className="chat-side-e">{s.a}</div> : null}
          </div>
          <IconBtn className="chat-side-x" aria-label="Закрыть" onClick={() => chats.closeSide(callsign, s.id)}>
            <X size={14} />
          </IconBtn>
        </div>
      ))}
      {tasks.length ? (
        <Dis
          className="chat-bg"
          head={
            <>
              <Layers size={14} />
              <b>{`В фоне: ${tasks.length}`}</b>
              <span>{tasks[0].desc || tasks[0].id}</span>
            </>
          }
        >
          {tasks.map((t) => (
            <BgRow key={t.id} callsign={callsign} task={t} />
          ))}
        </Dis>
      ) : null}
      {todos && left.length ? (
        <Dis
          className="chat-todo"
          head={
            <>
              <ListChecks size={14} />
              <b>{`${todos.length - left.length} из ${todos.length}`}</b>
              <span>{doing?.activeForm ?? doing?.content ?? left[0].content}</span>
            </>
          }
        >
          <TodoList todos={todos} />
        </Dis>
      ) : null}
      <AskPlace callsign={callsign} />
    </div>
  );
}
