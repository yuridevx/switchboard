// Список «Работы»: проекты или плоско; строка открытой сессии показывается, как только она есть. gen — поколение после перестановки: элементы строятся заново.
import { memo, useLayoutEffect, useRef } from "react";
import { useApp } from "@switchboard/web-ui";
import { useBoard } from "./store.ts";
import { NewProject, ProjectSection } from "./ProjectSection.tsx";
import { SessionRow } from "./SessionRow.tsx";
import { useHeld } from "./useHeld.ts";

export const ListView = memo(function ListView({ gen }: { gen: number }) {
  const app = useApp();
  const board = useBoard();
  const m = useHeld(board.listModel);
  const current = app.use(() => app.current()?.params.callsign);
  const lst = useRef<HTMLDivElement>(null);
  /** открытая сессия, которую список уже показал */
  const shown = useRef<string | undefined>(undefined);
  const ready = !!m;

  // список на экране: store запоминает первый показ проектов
  useLayoutEffect(() => {
    board.setListShown(true);
    return () => board.setListShown(false);
  }, [board]);

  // строка появляется, когда её проект развернулся: показать, как только она есть
  useLayoutEffect(() => {
    if (!ready || current === shown.current) return;
    if (!current) {
      shown.current = current;
      return;
    }
    const row = lst.current?.querySelector<HTMLElement>(`[data-callsign=${JSON.stringify(current)}]`);
    if (!row) return;
    shown.current = current;
    row.scrollIntoView?.({ block: "nearest" });
  }, [ready, m, current]);

  if (!m) return null;
  const empty = <div className="bd-empty">{m.empty}</div>;
  if (m.flat) {
    return (
      <div key={gen} ref={lst} className="lst flat">
        {m.flat.length ? m.flat.map((it) => <SessionRow key={it.callsign} callsign={it.callsign} depth={it.depth} noAt={it.noAt} project={it.project} />) : empty}
      </div>
    );
  }
  return (
    <div key={gen} ref={lst} className="lst">
      {m.sections.map((x) => (
        <ProjectSection key={`p:${x.id}`} x={x} />
      ))}
      {m.sections.length ? null : empty}
      <NewProject />
    </div>
  );
});
