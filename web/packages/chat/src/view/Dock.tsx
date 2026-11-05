// Над вводом: задачи в фоне с выводом, список задач Claude, вопросы сбоку и вопрос сессии.
import { useEffect, useState } from "react";
import { Btn, IconBtn, Markdown, TextBtn, useApp, useModule } from "@switchboard/web-ui";
import { MessageSquareQuote } from "lucide-react";
import type { Task } from "../fold.ts";
import type { Talks } from "../talk.ts";
import { refusal } from "../words.ts";
import { useEnv } from "./env.ts";
import { Icon } from "./icons.tsx";
import { Dis } from "./Rows.tsx";
import { Todos } from "./Tool.tsx";

const POLL_MS = 2000;
type Output = { output?: string; total_bytes?: number; truncated?: boolean };

function Out({ id }: { id: string }) {
  const env = useEnv();
  const talks = useModule<Talks>();
  const [r, setR] = useState<{ ok: true; result: Output } | { ok: false; error: string } | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => void talks.call<Output>(env.cs, "getTaskOutput", [id], true).then((x) => live && setR(x as never));
    read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="chat-out">
      {r && !r.ok ? (
        <div className="chat-out-e">{refusal(r.error)}</div>
      ) : (
        <>
          {r?.result.truncated && <div className="chat-out-h">{`последние 8 КБ из ${Math.round((r.result.total_bytes ?? 0) / 1024)} КБ`}</div>}
          <pre>{!r ? "читаю…" : r.result.output || "пока пусто"}</pre>
        </>
      )}
    </div>
  );
}

function Bg({ t }: { t: Task }) {
  const env = useEnv();
  const [out, setOut] = useState(false);
  const agent = t.type === "local_agent";
  return (
    <div className="chat-bgw">
      <div className="chat-bgr">
        <Icon name={agent ? "bot" : "terminal"} size={14} />
        <span title={t.description}>{t.description || t.id}</span>
        {t.summary && <em>{t.summary}</em>}
        {!agent && env.canAct && (
          <Btn className="chat-mini" onClick={() => setOut(!out)}>
            {out ? "Скрыть" : "Вывод"}
          </Btn>
        )}
        {env.canAct && (
          <Btn className="chat-mini" onClick={() => env.act("stopTask", [t.id])}>
            <Icon name="square" />
            Стоп
          </Btn>
        )}
      </div>
      {out && <Out id={t.id} />}
    </div>
  );
}

export function Dock() {
  const env = useEnv();
  const app = useApp();
  const talks = useModule<Talks>();
  const sides = app.use(() => talks.get(env.cs).sides);
  const asked = app.use(() => app.mark("asked", env.cs) as string | undefined);
  const bg = Object.values(env.view.tasks).filter((t) => t.bg && t.status === "running");
  const todos = env.view.todos ?? [];
  const done = todos.filter((t) => t.status === "completed").length;
  const doing = todos.find((t) => t.status === "in_progress");
  return (
    <div className="chat-dock">
      {bg.length > 0 && (
        <Dis
          className="chat-bg"
          head={
            <>
              <Icon name="layers" size={14} />
              <b>{`В фоне: ${bg.length}`}</b>
              <span>{bg[0].description || bg[0].id}</span>
            </>
          }
        >
          {bg.map((t) => (
            <Bg key={t.id} t={t} />
          ))}
        </Dis>
      )}
      {todos.length > 0 && done < todos.length && (
        <Dis
          className="chat-todo"
          head={
            <>
              <Icon name="list-checks" size={14} />
              <b>{`${done} из ${todos.length}`}</b>
              <span>{doing?.activeForm ?? doing?.content ?? ""}</span>
            </>
          }
        >
          <Todos todos={todos} />
        </Dis>
      )}
      {sides.map((s) => (
        <div key={s.id} className="chat-side" data-state={s.state}>
          <MessageSquareQuote size={14} aria-hidden="true" />
          <div className="chat-side-b">
            <div className="chat-side-q">{s.q}</div>
            {s.state === "wait" ? <div className="chat-side-w">думает…</div> : s.state === "bad" ? <div className="chat-side-e">{s.a}</div> : <div className="chat-side-a">{s.a ? <Markdown text={s.a} /> : "Claude не ответил"}</div>}
          </div>
          <IconBtn className="chat-side-x" aria-label="Закрыть" onClick={() => talks.edit(env.cs, (t) => void (t.sides = t.sides.filter((x) => x.id !== s.id)))}>
            <Icon name="x" size={14} />
          </IconBtn>
        </div>
      ))}
      <div className="chat-ask">
        {env.wide ? (
          <app.Slot screen="ask" params={{ callsign: env.cs }} />
        ) : (
          asked && (
            <TextBtn className="chat-askbar" onClick={() => app.open("ask", { callsign: env.cs })}>
              <b>?</b>
              <span>{asked}</span>
              <em>Ответить</em>
            </TextBtn>
          )
        )}
      </div>
    </div>
  );
}
