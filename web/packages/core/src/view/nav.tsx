// Разделы: полоса значков широкого вида, вкладки и лента группы узкого.
import { useEffect, useRef, type ComponentProps } from "react";
import { Search } from "lucide-react";
import { Badge, RowBtn, TextBtn } from "@switchboard/web-ui";
import { ConnPill } from "./bar.tsx";
import { useCore } from "./place.tsx";
import type { Screen } from "../types.ts";

type Item = { name: string; label: string; icon?: Screen["icon"]; group?: string; narrow?: string; count: number };

/** Разделы со счётчиками и открытый раздел; до первого экрана и после остановки — ничего. */
function useSections() {
  const { page, mods } = useCore();
  return page.use<{ items: Item[]; on: string } | null>(() => {
    if (!page.current || page.stop) return null;
    const items = mods.sections.map((s) => {
      const n = s.def.mark ? mods.mark(s.def.mark, []) : 0;
      return { name: s.name, label: s.label, icon: s.def.icon, group: s.def.group, narrow: s.def.narrowGroup ?? s.def.group, count: typeof n === "number" ? n : 0 };
    });
    return { items, on: page.current.master ?? page.current.screen };
  });
}

/** Сначала разделы без группы, затем группы. */
function grouped(items: Item[], of: (x: Item) => string | undefined) {
  const groups = new Map<string, Item[]>();
  for (const x of items) if (of(x)) groups.set(of(x)!, [...(groups.get(of(x)!) ?? []), x]);
  return { alone: items.filter((x) => !of(x)), groups: [...groups] };
}

const Count = ({ n }: { n: number }) => (n > 0 ? <Badge wait className="dot" aria-label="есть новое" /> : null);

function Section({ x, on, rail }: { x: Item; on: boolean; rail?: boolean }) {
  const { route } = useCore();
  const self = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on) self.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [on]);
  return (
    <RowBtn ref={self} className="sb-nv" title={rail ? x.label : undefined} data-screen={x.name} aria-current={on ? "page" : undefined} onClick={() => route.open(x.name)}>
      {rail && x.icon ? <x.icon className="sb-ni" size={18} aria-hidden="true" /> : null}
      <span>{x.label}</span>
      <Count n={x.count} />
    </RowBtn>
  );
}

export function Column() {
  const { page } = useCore();
  const v = useSections();
  if (!page.wide || !v) return <nav className="sb-navcol" hidden />;
  const { alone, groups } = grouped(v.items, (x) => x.group);
  const brand = page.o.brand ?? "Switchboard";
  return (
    <nav className="sb-navcol">
      <div className="sb-brand" title={brand}>
        <span className="sb-logo">{brand[0]}</span>
        <ConnPill bare />
      </div>
      <TextBtn className="sb-goto" title="Перейти · Ctrl K" onClick={page.toggleSearch}>
        <Search className="sb-ni" size={18} aria-hidden="true" />
        <span>Перейти…</span>
      </TextBtn>
      {alone.map((x) => (
        <Section key={x.name} x={x} on={x.name === v.on} rail />
      ))}
      {groups.flatMap(([group, members]) => [
        <div key={group} className="sb-grp">
          {group}
        </div>,
        ...members.map((x) => <Section key={x.name} x={x} on={x.name === v.on} rail />),
      ])}
    </nav>
  );
}

/** Вкладки узкого вида: разделы без группы и по одной на группу. */
export function Tabs() {
  const { page, route } = useCore();
  const v = useSections();
  const { alone, groups } = grouped(v?.items ?? [], (x) => x.narrow);
  const shown = !page.wide && alone.length + groups.length > 1;
  return (
    <nav className="sb-tabs" aria-label="Разделы" hidden={!shown}>
      {shown && alone.map((x) => <Section key={x.name} x={x} on={x.name === v!.on} />)}
      {shown &&
        groups.map(([group, members]) => {
          const inside = members.some((x) => x.name === v!.on);
          return (
            <RowBtn key={group} className="sb-nv" data-group={group} aria-current={inside ? "page" : undefined} onClick={() => inside || route.open(members[0].name)}>
              <span>{group}</span>
              <Count n={members.reduce((n, x) => n + x.count, 0)} />
            </RowBtn>
          );
        })}
    </nav>
  );
}

/** Лента над экраном: соседи раздела открытой группы. */
export function Ribbon() {
  const { page } = useCore();
  const v = useSections();
  const group = v?.items.find((x) => x.name === v.on)?.narrow;
  const row: ComponentProps<typeof Section>["x"][] = page.wide || !group ? [] : v!.items.filter((x) => x.narrow === group);
  return (
    <nav className="sb-navrow" hidden={!row.length}>
      {row.map((x) => (
        <Section key={x.name} x={x} on={x.name === v!.on} />
      ))}
    </nav>
  );
}
