// Субагент: задание свёрнуто, внутри — его шаги (те же карточки) и итог.
import type { ReactNode } from "react";
import { Markdown } from "@switchboard/web-ui";
import type { Part, Task, Tool } from "../../state/types.ts";
import { Disclosure } from "../../ui/Disclosure.tsx";

/** Как нарисовать шаг субагента: его даёт тот, кто рисует части. */
export type RenderPart = (p: Part, key: number) => ReactNode;

export function SubAgent({ t, task, renderPart }: { t: Tool; task?: Task; renderPart: RenderPart }) {
  // ушедший в фон субагент: результат инструмента — «запущен», итог — в его задаче
  const summary = task?.background ? (task.status !== "running" ? task.summary : undefined) : t.result?.text;
  return (
    <div className="tb-agent">
      {t.input.prompt ? (
        <Disclosure title="Задание">
          <div className="tb-prompt">{t.input.prompt}</div>
        </Disclosure>
      ) : null}
      {t.parts.length ? <div className="tb-steps">{t.parts.map(renderPart)}</div> : null}
      {summary ? (
        <div className="tb-final">
          <Markdown text={summary} />
        </div>
      ) : null}
    </div>
  );
}
