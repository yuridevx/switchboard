// Над вводом: вопросы сбоку, задачи Claude, идущее в фоне и вопрос сессии (узко — полоса к экрану, широко — экран ask в месте).
import { useEffect, useState } from "react";
import { Btn, IconBtn, Markdown, TextBtn, useApp, useModule } from "@switchboard/web-ui";
import { backgrounded, taskIcon, type Task } from "../fold.ts";
import type { Talks } from "../talk.ts";
import { useEnv } from "./env.ts";
import { Icon } from "./icons.tsx";
import { Dis } from "./Rows.tsx";
import { TodoList } from "./Tool.tsx";

const OUTPUT_EVERY_MS = 2000;
/** Сколько вывода отдаёт SDK за раз. */
const OUTPUT_TAIL = "8 КБ";
type Output = { output?: string; total_bytes?: number; truncated?: boolean };

function TaskOutput({ id }: { id: string }) {
  const { cs } = useEnv();
  const talks = useModule<Talks>();
  const [got, setGot] = useState<Output | null>(null);
  const [word, setWord] = useState("");
  useEffect(() => {
    let live = true;
    const ask = () =>
      void talks.read<Output>(cs, "getTaskOutput", [id]).then((r) => {
        if (!live) return;
        if (r.ok) setGot(r.result);
        else setWord(r.error);
      });
    ask();
    const timer = setInterval(ask, OUTPUT_EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [cs, id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="chat-out">
      {got?.truncated ? <div className="chat-out-h">{`последние ${OUTPUT_TAIL} из ${Math.round((got.total_bytes ?? 0) / 1024)} КБ`}</div> : null}
      {word ? <div className="chat-out-e">{word}</div> : <pre>{got ? got.output || "пока пусто" : "читаю…"}</pre>}
    </div>
  );
}

function BgRow({ task }: { task: Task }) {
  const env = useEnv();
  const [output, setOutput] = useState(false);
  const withOutput = task.type === "local_bash" || task.type === "monitor";
  return (
    <div className="chat-bgw">
      <div className="chat-bgr">
        <Icon name={taskIcon(task.type)} size={14} />
        <span title={task.desc || task.id}>{task.desc || task.id}</span>
        {task.summary ? <em>{task.summary}</em> : null}
        {env.canAct && withOutput ? (
          <Btn type="button" className="chat-mini" onClick={() => setOutput(!output)}>
            {output ? "Скрыть" : "Вывод"}
          </Btn>
        ) : null}
        {env.canAct ? (
          <Btn type="button" className="chat-mini" onClick={() => env.act("stopTask", [task.id])}>
            <Icon name="square" />
            Стоп
          </Btn>
        ) : null}
      </div>
      {output ? <TaskOutput id={task.id} /> : null}
    </div>
  );
}

function AskPlace() {
  const { cs, wide } = useEnv();
  const app = useApp();
  const asked = app.use(() => app.mark("asked", cs) as string | undefined);
  // широко экран остаётся после ответа: на нём итог; пока вопроса не было — места нет
  const seen = app.use((was?: boolean) => !!was || !!app.mark("asked", cs));
  if (wide) return <div className="chat-ask">{seen ? <app.Slot screen="ask" params={{ callsign: cs }} /> : null}</div>;
  return (
    <div className="chat-ask">
      {asked ? (
        <TextBtn className="chat-askbar" onClick={() => app.open("ask", { callsign: cs })}>
          <b>?</b>
          <span>{asked}</span>
          <em>Ответить</em>
        </TextBtn>
      ) : null}
    </div>
  );
}

export function Dock() {
  const env = useEnv();
  const app = useApp();
  const talks = useModule<Talks>();
  const sides = app.use(() => talks.get(env.cs).sides);
  const tasks = backgrounded(env.view);
  const todos = env.view.todos;
  const left = todos?.filter((t) => t.status !== "completed") ?? [];
  const doing = todos?.find((t) => t.status === "in_progress");
  return (
    <div className="chat-dock">
      {sides.map((s) => (
        <div key={s.id} className="chat-side" data-state={s.state}>
          <Icon name="message-square-quote" size={14} />
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
          <IconBtn className="chat-side-x" aria-label="Закрыть" onClick={() => talks.edit(env.cs, (t) => void (t.sides = t.sides.filter((x) => x.id !== s.id)))}>
            <Icon name="x" size={14} />
          </IconBtn>
        </div>
      ))}
      {tasks.length ? (
        <Dis
          className="chat-bg"
          head={
            <>
              <Icon name="layers" size={14} />
              <b>{`В фоне: ${tasks.length}`}</b>
              <span>{tasks[0].desc || tasks[0].id}</span>
            </>
          }
        >
          {tasks.map((t) => (
            <BgRow key={t.id} task={t} />
          ))}
        </Dis>
      ) : null}
      {todos && left.length ? (
        <Dis
          className="chat-todo"
          head={
            <>
              <Icon name="list-checks" size={14} />
              <b>{`${todos.length - left.length} из ${todos.length}`}</b>
              <span>{doing?.activeForm ?? doing?.content ?? left[0].content}</span>
            </>
          }
        >
          <TodoList todos={todos} />
        </Dis>
      ) : null}
      <AskPlace />
    </div>
  );
}
