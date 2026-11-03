// Список задач Claude: кружок — ждёт, точка — в работе, галочка — готово.
import { Circle, CircleCheck, CircleDot } from "lucide-react";
import type { ToolInput } from "../../state/wire.ts";

export type Todo = NonNullable<ToolInput["todos"]>[number];

export function Todos({ todos }: { todos?: Todo[] }) {
  if (!Array.isArray(todos)) return null;
  return (
    <ul className="chat-todos">
      {todos.map((x, i) => (
        <li key={i} data-status={x.status}>
          {x.status === "completed" ? <CircleCheck size={14} /> : x.status === "in_progress" ? <CircleDot size={14} /> : <Circle size={14} />}
          <span>{x.status === "in_progress" && x.activeForm ? x.activeForm : x.content}</span>
        </li>
      ))}
    </ul>
  );
}
