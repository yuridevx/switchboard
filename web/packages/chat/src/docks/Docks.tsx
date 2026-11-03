// Над полем ввода: задачи Claude, идущие в фоне и вопрос сессии. Каждая полоса выбирает своё и перерисовывается одна.
import { useRef } from "react";
import { Bot, Layers, ListChecks, Square, Terminal } from "lucide-react";
import { useChat } from "../context.ts";
import { Todos } from "../cards/tools/Todos.tsx";
import type { Feed, Task } from "../state/types.ts";
import { Disclosure } from "../ui/Disclosure.tsx";

/** Последний список задач Claude в ленте; весь выполнен — полосы нет. */
function todosOf(f: Feed) {
  const list = Object.values(f.tools)
    .filter((t) => t.name === "TodoWrite" && !t.parent)
    .at(-1)?.input.todos;
  return Array.isArray(list) && list.length && !list.every((t) => t.status === "completed") ? list : undefined;
}

export function TodoDock({ callsign }: { callsign: string }) {
  const chat = useChat();
  const todos = chat.useConv(callsign, (c) => todosOf(c.feed));
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

function BackgroundRow({ t, callsign }: { t: Task; callsign: string }) {
  const chat = useChat();
  return (
    <div className="chat-bgr">
      {t.type === "local_agent" ? <Bot size={14} /> : <Terminal size={14} />}
      <span title={t.description}>{t.description || t.id}</span>
      {t.summary ? <em>{t.summary}</em> : null}
      <button type="button" className="chat-mini" onClick={() => void chat.call(callsign, "stopTask", [t.id])}>
        <Square size={11} />
        Стоп
      </button>
    </div>
  );
}

export function BackgroundDock({ callsign }: { callsign: string }) {
  const chat = useChat();
  const tasks = chat.useConv(callsign, (c) => Object.values(c.feed.tasks).filter((t) => t.background && t.status === "running"));
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
  const chat = useChat();
  const asked = chat.useApp(() => chat.asked(callsign));
  const waiting = chat.useApp(() => chat.sessionOf(callsign)?.state === "waiting");
  // вопрос над вводом: открыт, пока открыт чат — ответ «принят» или «уже ответили» остаётся виден
  const opened = useRef(false);
  if (asked || waiting) opened.current = true;
  const Slot = chat.Slot;
  return (
    <div className="chat-ask">
      {chat.wide ? (
        opened.current ? (
          <Slot screen="ask" params={{ callsign }} />
        ) : null
      ) : asked ? (
        <button type="button" className="chat-askbar" onClick={() => chat.open("ask", { callsign })}>
          <b>?</b>
          <span>{asked}</span>
          <em>Ответить</em>
        </button>
      ) : null}
    </div>
  );
}
