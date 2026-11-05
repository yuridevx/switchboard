// Разделы: колонка широкого вида, вкладки и лента узкого.
import { useEffect, useRef } from "react";
import { Badge, Pill, RowBtn, TextBtn } from "@switchboard/web-ui";
import type { Modules } from "../modules.ts";
import type { Page } from "./shell.tsx";

type Row = { name: string; nav: string; group?: string; narrow?: string; count: number };

/** Разделы с метками: выборка вида. */
export function sectionRows(m: Modules): Row[] {
  return m.sections().map((name) => {
    const [e, s] = m.screenOf(name)!;
    const n = s.mark && Object.hasOwn(e.def.marks ?? {}, s.mark) ? m.markOf(e, s.mark) : 0;
    return { name, nav: s.nav!, group: s.group, narrow: s.narrowGroup ?? s.group, count: typeof n === "number" ? n : 0 };
  });
}

/** Сначала разделы без группы, затем группы: [имя группы или null, разделы]. */
function grouped(rows: Row[], of: (r: Row) => string | undefined): Array<[string | null, Row[]]> {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const g = of(r);
    if (g) groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  return [[null, rows.filter((r) => !of(r))], ...groups];
}

const Count = ({ n }: { n: number }) => (n > 0 ? <Badge wait>{n}</Badge> : null);

function Item({ page, row, on }: { page: Page; row: Row; on: boolean }) {
  const self = useRef<HTMLButtonElement>(null);
  // открытый раздел виден в прокрутке ленты и колонки
  useEffect(() => {
    if (on) self.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [on]);
  return (
    <RowBtn ref={self} className="sb-nv" data-screen={row.name} aria-current={on ? "page" : undefined} onClick={() => page.open(row.name)}>
      <span>{row.nav}</span>
      <Count n={row.count} />
    </RowBtn>
  );
}

/** Слова связи для пилюли: одна подпись на шапку и колонку. */
export const linkPill = (link: string) => (link === "open" ? { tone: "ok" as const, text: "на связи" } : link === "closed" ? { tone: "bad" as const, text: "нет связи" } : { tone: "wait" as const, text: "подключаюсь" });

/** Колонка разделов широкого вида. */
export function Column({ page }: { page: Page }) {
  const { core, bus, modules, wide } = page;
  const view = bus.use(() => (wide && core.current ? { rows: sectionRows(modules), on: core.current.master ?? core.current.screen, link: core.link } : null));
  const hidden = bus.use(() => !wide || core.stopped !== null);
  const pill = view && linkPill(view.link);
  return (
    <nav className="sb-navcol" hidden={hidden}>
      {view && pill && (
        <>
          <div className="sb-brand">
            <b>{page.brand ?? "Switchboard"}</b>
            <Pill tone={pill.tone} conn title={pill.text} aria-label={pill.text} />
          </div>
          <TextBtn className="sb-goto" onClick={page.search}>
            <span>Перейти…</span>
            <kbd>Ctrl K</kbd>
          </TextBtn>
          {grouped(view.rows, (r) => r.group).map(([group, rows]) => (
            <GroupRows key={group ?? ""} page={page} group={group} rows={rows} on={view.on} />
          ))}
        </>
      )}
    </nav>
  );
}

function GroupRows({ page, group, rows, on }: { page: Page; group: string | null; rows: Row[]; on: string }) {
  return (
    <>
      {group && <div className="sb-grp">{group}</div>}
      {rows.map((r) => (
        <Item key={r.name} page={page} row={r} on={r.name === on} />
      ))}
    </>
  );
}

/** Вкладки узкого вида: разделы без группы и по одной на группу. */
export function Tabs({ page }: { page: Page }) {
  const { core, bus, modules, wide } = page;
  const view = bus.use(() => (!wide && core.current ? { rows: sectionRows(modules), on: core.current.screen } : null));
  const tabs: Array<[string | null, Row[]]> = view ? grouped(view.rows, (r) => r.narrow).flatMap(([group, rows]): Array<[string | null, Row[]]> => (group ? [[group, rows]] : rows.map((r) => [null, [r]]))) : [];
  return (
    <nav className="sb-tabs" aria-label="Разделы" hidden={tabs.length < 2}>
      {tabs.length >= 2 &&
        tabs.map(([group, rows]) =>
          group ? (
            <RowBtn key={group} className="sb-nv" data-group={group} aria-current={rows.some((r) => r.name === view!.on) ? "page" : undefined} onClick={() => !rows.some((r) => r.name === view!.on) && page.open(rows[0].name)}>
              <span>{group}</span>
              <Count n={rows.reduce((sum, r) => sum + r.count, 0)} />
            </RowBtn>
          ) : (
            <Item key={rows[0].name} page={page} row={rows[0]} on={rows[0].name === view!.on} />
          ),
        )}
    </nav>
  );
}

/** Лента над экраном: соседи раздела открытой группы. */
export function Ribbon({ page }: { page: Page }) {
  const { core, bus, modules, wide } = page;
  const view = bus.use(() => {
    if (wide || !core.current) return null;
    const rows = sectionRows(modules);
    const group = rows.find((r) => r.name === core.current!.screen)?.narrow;
    return group ? { rows: rows.filter((r) => r.narrow === group), on: core.current.screen } : null;
  });
  return (
    <nav className="sb-navrow" hidden={!view}>
      {view?.rows.map((r) => (
        <Item key={r.name} page={page} row={r} on={r.name === view.on} />
      ))}
    </nav>
  );
}
