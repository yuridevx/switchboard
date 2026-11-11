// Порядок перетаскиванием — один жест на всю страницу: строка берётся за ручку мышью или пальцем (после удержания), место показывает линия,
// Esc отменяет, у края список прокручивается. С клавиатуры: ручка в фокусе, Alt+↑ и Alt+↓ двигают строку.
import { IconGripVertical } from "@tabler/icons-react";
import { type ReactNode, useRef } from "react";
import { useRowDrag } from "./drag.ts";
import { reorder } from "./work.ts";

const ONE = "_";

/** Сдвиг строки с клавиатуры: на одно место вверх или вниз; у края — тот же порядок. */
export function nudge(ids: string[], id: string, d: -1 | 1): string[] {
  const i = ids.indexOf(id), j = i + d;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const next = [...ids];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export function Sortable({ ids, onOrder, row, label, gap = 4 }: {
  ids: string[];
  onOrder: (next: string[]) => void;
  /** строка: её содержимое; ручку ставит сам список */
  row: (id: string, index: number) => ReactNode;
  /** имя строки для ручки: «Порядок: <имя>» */
  label: (id: string) => string;
  gap?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRowDrag({ box, onDrop: ({ id, before }) => onOrder(reorder(ids, id, before)) });
  return (
    <div ref={box} className="dragbox sortable" data-drop-group={ONE} style={{ display: "flex", flexDirection: "column", gap, position: "relative" }}>
      {drag.line !== null && <div className="dragline" style={{ top: drag.line }} />}
      {ids.map((id, i) => (
        <div key={id} className={`sortrow${drag.dragging === id ? " dragging" : ""}`} data-drag-id={id} data-drag-group={ONE}>
          <span className="grip" role="button" tabIndex={0} aria-label={`Порядок: ${label(id)}`} title="Перетащите; с клавиатуры — Alt и стрелки"
            onPointerDown={drag.onPointerDown(id)}
            onKeyDown={(e) => {
              if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
              e.preventDefault();
              const next = nudge(ids, id, e.key === "ArrowUp" ? -1 : 1);
              if (next !== ids) onOrder(next);
            }}>
            <IconGripVertical size={14} />
          </span>
          <div className="sortbody">{row(id, i)}</div>
        </div>
      ))}
    </div>
  );
}
