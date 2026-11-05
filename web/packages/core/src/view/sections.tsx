// Разделы: колонка широкого вида, лента и вкладки узкого. Раскладка считается из разделов и текущего экрана.
import { useEffect, useRef } from "react";
import { Badge, Pill, RowBtn, TextBtn } from "@switchboard/web-ui";
import { connPill, useCore } from "./context.ts";

/** Раскладка разделов — имена: без группы, группы с их разделами, разделы открытой группы, видны ли вкладки, открытые. */
export type Layout = { solo: string[]; groups: Array<{ name: string; items: string[] }>; openGroup: string[]; tabsShown: boolean; active: string[] };

/** Выборка раскладки: перерисовка — когда раскладка изменилась. */
export function useLayout(): Layout {
  const { snap, sections, wide } = useCore();
  return snap.use(() => {
    const { roster, current, master } = snap.get();
    const all = roster ? sections.all() : [];
    const active = [current?.screen, master].filter((n): n is string => !!n);
    const groupNames = [...new Set(all.map(([, s]) => sections.groupOf(s.def)).filter((g): g is string => !!g))];
    const groups = groupNames.map((name) => ({ name, items: all.filter(([, s]) => sections.groupOf(s.def) === name).map(([n]) => n) }));
    const solo = all.filter(([, s]) => !sections.groupOf(s.def)).map(([n]) => n);
    return { solo, groups, openGroup: groups.find((g) => g.items.some((n) => active.includes(n)))?.items ?? [], tabsShown: !wide && !!roster && solo.length + groups.length >= 2, active };
  });
}

/** Кнопка раздела со счётчиком. */
function Item({ name, layout }: { name: string; layout: Layout }) {
  const { snap, sections, modules, address } = useCore();
  const entry = modules.screens.get(name)!;
  const count = snap.use(() => sections.countOf(entry));
  const on = layout.active.includes(name);
  const self = useRef<HTMLButtonElement>(null);
  // лента разделов прокручивается: открытый раздел всегда виден
  useEffect(() => {
    if (on) self.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [on]);
  return (
    <RowBtn ref={self} className="sb-nv" aria-current={on ? "page" : undefined} data-screen={name} onClick={() => address.go(name, {})}>
      <span>{entry.def.nav}</span>
      {count !== null ? <Badge wait>{count}</Badge> : null}
    </RowBtn>
  );
}

/** Колонка разделов широкого вида. */
export function NavColumn({ layout, openSearch }: { layout: Layout; openSearch(): void }) {
  const { snap, wide, brand } = useCore();
  const { conn, shown, stopped } = snap.use(() => {
    const st = snap.get();
    return { conn: st.conn, shown: !!st.roster, stopped: !!st.full };
  });
  const pill = connPill(conn);
  return (
    <nav className="sb-navcol" hidden={!wide || stopped}>
      {wide && shown ? (
        <>
          <div className="sb-brand">
            <b>{brand ?? "Switchboard"}</b>
            <Pill conn tone={pill.tone} title={pill.text} aria-label={pill.text} />
          </div>
          <TextBtn className="sb-goto" onClick={openSearch}>
            <span>Перейти…</span>
            <kbd>Ctrl K</kbd>
          </TextBtn>
          {layout.solo.map((n) => (
            <Item key={n} name={n} layout={layout} />
          ))}
          {layout.groups.flatMap((g) => [
            <div key={`g:${g.name}`} className="sb-grp">
              {g.name}
            </div>,
            ...g.items.map((n) => <Item key={n} name={n} layout={layout} />),
          ])}
        </>
      ) : null}
    </nav>
  );
}

/** Лента разделов открытой группы над экраном: узкий вид. */
export function GroupRow({ layout, ready }: { layout: Layout; ready: boolean }) {
  const { wide } = useCore();
  return (
    <nav className="sb-navrow" hidden={wide || !ready || layout.openGroup.length === 0}>
      {!wide && ready ? layout.openGroup.map((n) => <Item key={n} name={n} layout={layout} />) : null}
    </nav>
  );
}

/** Вкладка группы: одна на группу, открывает первый её раздел; счётчик — сумма разделов. */
function GroupTab({ name, items, active }: { name: string; items: string[]; active: string[] }) {
  const { snap, sections, modules, address } = useCore();
  const isOpen = items.some((n) => active.includes(n));
  const count = snap.use(() => items.reduce((sum, n) => sum + (sections.countOf(modules.screens.get(n)!) ?? 0), 0));
  return (
    <RowBtn className="sb-nv" aria-current={isOpen ? "page" : undefined} data-group={name} onClick={() => (isOpen ? null : address.go(items[0], {}))}>
      <span>{name}</span>
      {count ? <Badge wait>{count}</Badge> : null}
    </RowBtn>
  );
}

/** Вкладки внизу: узкий вид. */
export function Tabs({ layout }: { layout: Layout }) {
  return (
    <nav className="sb-tabs" aria-label="Разделы" hidden={!layout.tabsShown}>
      {layout.tabsShown ? (
        <>
          {layout.solo.map((n) => (
            <Item key={n} name={n} layout={layout} />
          ))}
          {layout.groups.map((g) => (
            <GroupTab key={`g:${g.name}`} name={g.name} items={g.items} active={layout.active} />
          ))}
        </>
      ) : null}
    </nav>
  );
}
