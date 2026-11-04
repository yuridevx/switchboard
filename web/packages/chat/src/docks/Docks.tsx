// Над полем ввода: вопросы сбоку, задачи Claude, идущие в фоне и вопрос сессии. Каждая полоса выбирает своё и перерисовывается одна.
import { useEffect, useState } from "react";
import { Btn, IconBtn, Markdown, TextBtn, useApp, useLoad } from "@switchboard/web-ui";
import { Bot, Layers, ListChecks, MessageSquareQuote, Square, Terminal, X } from "lucide-react";
import { useChat, useConv } from "../context.ts";
import { Todos } from "../cards/tools/Todos.tsx";
import type { Side } from "../state/chat.ts";
import type { Feed, Task } from "../state/types.ts";
import { Disclosure } from "../ui/Disclosure.tsx";

export type TaskOutput = { output: string; total_bytes: number; truncated: boolean };

/** Последний список задач Claude в ленте; весь выполнен — полосы нет. */
function todosOf(f: Feed) {
  const list = Object.values(f.tools)
    .filter((t) => t.name === "TodoWrite" && !t.parent)
    .at(-1)?.input.todos;
  return Array.isArray(list) && list.length && !list.every((t) => t.status === "completed") ? list : undefined;
}

export function TodoDock({ callsign }: { callsign: string }) {
  const todos = useConv(callsign, (c) => todosOf(c.feed));
  if (!todos) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const now = todos.find((t) => t.status === "in_progress");
  return (
    <Disclosure
      className="chat-todo"
      title={
        <>
          <ListChecks size={14} />
          <b>{`${done} из ${todos.length}`}</b>
          {now ? <span>{now.activeForm ?? now.content}</span> : null}
        </>
      }
    >
      <Todos todos={todos} />
    </Disclosure>
  );
}

/** Хвост вывода фоновой команды: файл или строка отказа. Что показать — считается из ответа. */
export function OutputView({ data, error }: { data?: TaskOutput; error?: string }) {
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

const OUTPUT_MS = 2000;

/** Вывод идущей команды: перечитывается раз в 2 с, пока открыт. */
function TaskOutputBox({ t, callsign }: { t: Task; callsign: string }) {
  const chat = useChat();
  const { data, error, reload } = useLoad<TaskOutput>(() => chat.ask<TaskOutput>(callsign, "getTaskOutput", [t.id]), [chat, callsign, t.id]);
  useEffect(() => {
    const h = setInterval(reload, OUTPUT_MS);
    return () => clearInterval(h);
  }, [reload]);
  return <OutputView data={data} error={error} />;
}

function BackgroundRow({ t, callsign }: { t: Task; callsign: string }) {
  const app = useApp();
  const chat = useChat();
  const canCall = app.use(() => chat.canCall(callsign));
  const [out, setOut] = useState(false);
  const shell = t.type === "local_bash" || t.type === "monitor";
  return (
    <div className="chat-bgw">
      <div className="chat-bgr">
        {t.type === "local_agent" ? <Bot size={14} /> : <Terminal size={14} />}
        <span title={t.description}>{t.description || t.id}</span>
        {t.summary ? <em>{t.summary}</em> : null}
        {canCall && shell ? (
          <Btn type="button" className="chat-mini" onClick={() => setOut(!out)}>
            {out ? "Скрыть" : "Вывод"}
          </Btn>
        ) : null}
        {canCall ? (
          <Btn type="button" className="chat-mini" onClick={() => void chat.call(callsign, "stopTask", [t.id])}>
            <Square size={11} />
            Стоп
          </Btn>
        ) : null}
      </div>
      {out && canCall && shell ? <TaskOutputBox t={t} callsign={callsign} /> : null}
    </div>
  );
}

/** Вопрос сбоку: вопрос и ответ; в разговор не попадают, закрываются крестиком. */
export function SideCard({ s, drop }: { s: Side; drop(): void }) {
  const state = s.err ? "bad" : s.a !== undefined ? "done" : "wait";
  return (
    <div className="chat-side" data-state={state}>
      <MessageSquareQuote size={14} />
      <div className="chat-side-b">
        <div className="chat-side-q">{s.q}</div>
        {s.err ? (
          <div className="chat-side-e">{s.err}</div>
        ) : s.a !== undefined ? (
          <div className="chat-side-a">
            <Markdown text={s.a} />
          </div>
        ) : (
          <div className="chat-side-w">думает…</div>
        )}
      </div>
      <IconBtn className="chat-side-x" aria-label="Закрыть" onClick={drop}>
        <X size={14} />
      </IconBtn>
    </div>
  );
}

export function SideDock({ callsign }: { callsign: string }) {
  const chat = useChat();
  const sides = useConv(callsign, (c) => c.sides);
  return (
    <>
      {sides.map((s) => (
        <SideCard key={s.id} s={s} drop={() => chat.dropSide(callsign, s.id)} />
      ))}
    </>
  );
}

export function BackgroundDock({ callsign }: { callsign: string }) {
  const tasks = useConv(callsign, (c) => Object.values(c.feed.tasks).filter((t) => t.background && t.status === "running"));
  if (!tasks.length) return null;
  return (
    <Disclosure
      className="chat-bg"
      title={
        <>
          <Layers size={14} />
          <b>{`В фоне: ${tasks.length}`}</b>
          <span>{tasks[0].description}</span>
        </>
      }
    >
      {tasks.map((t) => (
        <BackgroundRow key={t.id} t={t} callsign={callsign} />
      ))}
    </Disclosure>
  );
}

/** Вопрос сессии: узко — полоса, которая открывает экран вопроса; широко — экран ask в месте над вводом. */
export function AskDock({ callsign }: { callsign: string }) {
  const app = useApp();
  const chat = useChat();
  const asked = app.use(() => app.mark("asked", callsign));
  const waiting = app.use(() => chat.sessionOf(callsign)?.state === "waiting");
  // вопрос над вводом: открыт, пока открыт чат — ответ «принят» или «уже ответили» остаётся виден
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
