// Разделы: колонка широкого вида, вкладки и лента группы узкого.
import { useEffect, useRef, type ComponentProps } from "react";
import { Badge, RowBtn, TextBtn } from "@switchboard/web-ui";
import type { Section } from "../modules.ts";
import { ConnPill } from "./bar.tsx";
import { useCore } from "./place.tsx";

type Item = { name: string; label: string; group?: string; count: number };

/** Разделы со счётчиками и открытый раздел; group — какая группа в этом виде. */
function useSections(group: (s: Section) => string | undefined) {
  const { page, mods } = useCore();
  const items = page.use<Item[]>(() =>
    mods.sections.map((s) => {
      const n = s.def.mark ? mods.mark(s.def.mark, []) : 0;
      return { name: s.name, label: s.label, group: group(s), count: typeof n === "number" ? n : 0 };
    }),
  );
  const on = page.use(() => (page.stop ? undefined : (page.current?.master ?? page.current?.screen)));
  return { items, on };
}

function NavBtn({ label, count, current, ...rest }: { label: string; count: number; current: boolean } & ComponentProps<typeof RowBtn>) {
  return (
    <RowBtn className="sb-nv" aria-current={current ? "page" : undefined} {...rest}>
      <span>{label}</span>
      {count > 0 && <Badge wait>{count}</Badge>}
    </RowBtn>
  );
}

export function Column() {
  const { page, route } = useCore();
  const { items, on } = useSections((s) => s.def.group);
  const stopped = page.use(() => !!page.stop);
  const open = useRef<HTMLButtonElement>(null);
  useEffect(() => open.current?.scrollIntoView({ block: "nearest", inline: "nearest" }), [on]);
  if (!page.wide) return <nav className="sb-navcol" hidden />;
  return (
    <nav className="sb-navcol" hidden={stopped}>
      <div className="sb-brand">
        <b>{page.o.brand ?? "Switchboard"}</b>
        <ConnPill bare />
      </div>
      <TextBtn className="sb-goto" onClick={() => ((page.search = true), page.changed())}>
        Перейти…<kbd>Ctrl K</kbd>
      </TextBtn>
      {items.map((x, i) => [
        x.group && x.group !== items[i - 1]?.group && (
          <div key={`g${x.group}`} className="sb-grp">
            {x.group}
          </div>
        ),
        <NavBtn key={x.name} ref={x.name === on ? open : undefined} data-screen={x.name} label={x.label} count={x.count} current={x.name === on} onClick={() => route.open(x.name)} />,
      ])}
    </nav>
  );
}

const narrow = (s: Section) => s.def.narrowGroup ?? s.def.group;

/** Лента соседей открытого раздела группы. */
export function GroupRow() {
  const { page, route } = useCore();
  const { items, on } = useSections(narrow);
  const group = items.find((x) => x.name === on)?.group;
  const row = page.wide || !group ? [] : items.filter((x) => x.group === group);
  return (
    <nav className="sb-navrow" hidden={!row.length}>
      {row.map((x) => (
        <NavBtn key={x.name} data-screen={x.name} label={x.label} count={x.count} current={x.name === on} onClick={() => route.open(x.name)} />
      ))}
    </nav>
  );
}

/** Вкладки: раздел без группы или одна вкладка на группу. */
export function Tabs() {
  const { page, route } = useCore();
  const { items, on } = useSections(narrow);
  const open = items.find((x) => x.name === on);
  const tabs = items.filter((x, i) => !x.group || items.findIndex((y) => y.group === x.group) === i);
  const shown = !page.wide && tabs.length > 1 && !!on;
  return (
    <nav className="sb-tabs" aria-label="Разделы" hidden={!shown}>
      {(shown ? tabs : []).map((x) => {
        if (!x.group) return <NavBtn key={x.name} data-screen={x.name} label={x.label} count={x.count} current={x.name === on} onClick={() => route.open(x.name)} />;
        const members = items.filter((y) => y.group === x.group);
        const inside = open?.group === x.group;
        const count = members.reduce((n, y) => n + y.count, 0);
        return <NavBtn key={x.group} data-group={x.group} label={x.group} count={count} current={inside} onClick={() => inside || route.open(x.name)} />;
      })}
    </nav>
  );
}
