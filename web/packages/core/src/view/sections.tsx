// Разделы: колонка широкого вида, лента и вкладки узкого; модель раскладки считается из разделов и текущего экрана.
import { useEffect, useRef } from "react";
import { Badge, Pill } from "@switchboard/web-ui";
import { connPill, useCore } from "./core.ts";

/** Раскладка разделов — имена: без группы, группы с их разделами, разделы открытой группы, видны ли вкладки, открытые. */
export type SectionsModel = { solo: string[]; groups: Array<{ name: string; items: string[] }>; inOpen: string[]; tabsShown: boolean; active: string[] };

/** Выборка раскладки: перерисовка — когда раскладка изменилась. */
export function useSections(): SectionsModel {
  const core = useCore();
  return core.use(() => {
    const { roster, current, master } = core.state();
    const navs = roster ? core.sections() : [];
    const active = [current?.screen, master].filter((n): n is string => !!n);
    const groupNames = [...new Set(navs.map(([, s]) => core.groupOf(s.def)).filter((g): g is string => !!g))];
    const groups = groupNames.map((name) => ({ name, items: navs.filter(([, s]) => core.groupOf(s.def) === name).map(([n]) => n) }));
    // узкий вид: вкладки внизу, группа — одной вкладкой, её разделы — лентой над экраном
    const solo = navs.filter(([, s]) => !core.groupOf(s.def)).map(([n]) => n);
    const inOpen = groups.find((g) => g.items.some((n) => active.includes(n)))?.items ?? [];
    return { solo, groups, inOpen, tabsShown: !core.wide && !!roster && solo.length + groups.length >= 2, active };
  });
}

/** Кнопка раздела с меткой-счётчиком. */
function Item({ n, model }: { n: string; model: SectionsModel }) {
  const core = useCore();
  const s = core.lookup(n)!;
  const count = core.use(() => core.countOf(s));
  const on = model.active.includes(n);
  const self = useRef<HTMLButtonElement>(null);
  // лента разделов прокручивается: открытый раздел всегда виден
  useEffect(() => {
    if (on) self.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [on]);
  return (
    <button ref={self} className="sb-nv" aria-current={on ? "page" : undefined} data-screen={n} onClick={() => core.go(n, {})}>
      <span>{s.def.nav}</span>
      {count !== null ? <Badge wait>{count}</Badge> : null}
    </button>
  );
}

/** Колонка разделов широкого вида. */
export function NavColumn({ model, openPal }: { model: SectionsModel; openPal(): void }) {
  const core = useCore();
  const { conn, shown, stopped } = core.use(() => {
    const st = core.state();
    return { conn: st.conn, shown: !!st.roster, stopped: !!st.full };
  });
  const cp = connPill(conn);
  return (
    <nav className="sb-navcol" hidden={!core.wide || stopped}>
      {core.wide && shown ? (
        <>
          <div className="sb-brand">
            <b>{core.brand ?? "Switchboard"}</b>
            <Pill conn tone={cp.tone} title={cp.text} aria-label={cp.text} />
          </div>
          <button className="sb-goto" onClick={openPal}>
            <span>Перейти…</span>
            <kbd>Ctrl K</kbd>
          </button>
          {model.solo.map((n) => (
            <Item key={n} n={n} model={model} />
          ))}
          {model.groups.flatMap((g) => [
            <div key={`g:${g.name}`} className="sb-grp">
              {g.name}
            </div>,
            ...g.items.map((n) => <Item key={n} n={n} model={model} />),
          ])}
        </>
      ) : null}
    </nav>
  );
}

/** Лента разделов открытой группы над экраном: узкий вид. */
export function GroupRow({ model, ready }: { model: SectionsModel; ready: boolean }) {
  const core = useCore();
  return (
    <nav className="sb-navrow" hidden={core.wide || !ready || model.inOpen.length === 0}>
      {!core.wide && ready ? model.inOpen.map((n) => <Item key={n} n={n} model={model} />) : null}
    </nav>
  );
}

/** Вкладка группы: одна на группу, открывает первый её раздел. */
function GroupTab({ name, items, active }: { name: string; items: string[]; active: string[] }) {
  const core = useCore();
  const cur = items.some((n) => active.includes(n));
  const count = core.use(() => items.reduce((acc, n) => acc + (core.countOf(core.lookup(n)!) ?? 0), 0));
  return (
    <button key={`g:${name}`} className="sb-nv" aria-current={cur ? "page" : undefined} data-group={name} onClick={() => (cur ? null : core.go(items[0], {}))}>
      <span>{name}</span>
      {count ? <Badge wait>{count}</Badge> : null}
    </button>
  );
}

/** Вкладки внизу: узкий вид. */
export function Tabs({ model }: { model: SectionsModel }) {
  return (
    <nav className="sb-tabs" aria-label="Разделы" hidden={!model.tabsShown}>
      {model.tabsShown ? (
        <>
          {model.solo.map((n) => (
            <Item key={n} n={n} model={model} />
          ))}
          {model.groups.map((g) => (
            <GroupTab key={`g:${g.name}`} name={g.name} items={g.items} active={model.active} />
          ))}
        </>
      ) : null}
    </nav>
  );
}
