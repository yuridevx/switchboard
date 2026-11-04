// Субагент: задание свёрнуто, внутри — его шаги (те же карточки) и итог.
import { Markdown } from "@switchboard/web-ui";
import type { Task, Tool } from "../../state/types.ts";
import { Disclosure } from "../../ui/Disclosure.tsx";
import { PartView } from "../PartView.tsx";

export function SubAgent({ t, task }: { t: Tool; task?: Task }) {
  // ушедший в фон субагент: результат инструмента — «запущен», итог — в его задаче
  const summary = task?.background ? (task.status !== "running" ? task.summary : undefined) : t.result?.text;
  return (
    <div className="tb-agent">
      {t.input.prompt ? (
        <Disclosure title="Задание">
          <div className="tb-prompt">{t.input.prompt}</div>
        </Disclosure>
      ) : null}
      {t.parts.length ? (
        <div className="tb-steps">
          {t.parts.map((p, i) => (
            <PartView key={i} p={p} />
          ))}
        </div>
      ) : null}
      {summary ? (
        <div className="tb-final">
          <Markdown text={summary} />
        </div>
      ) : null}
    </div>
  );
}
