// Разделы: колонка широкого вида, лента и вкладки узкого; модель раскладки считается из разделов и текущего экрана.
import { Badge, Pill } from "@switchboard/web-ui";
import type { ScreenEntry } from "../mod.ts";
import { useCore, type Core } from "./core.ts";

type NavEntry = [string, ScreenEntry];

/** Раскладка разделов: без группы, группы, разделы открытой группы, видны ли вкладки. */
export type SectionsModel = { navs: NavEntry[]; solo: NavEntry[]; groups: string[]; inOpen: NavEntry[]; tabsShown: boolean; on(n: string): boolean };

export function sectionsModel(core: Core): SectionsModel {
  const { roster, current, master } = core.state();
  const navs = roster ? core.sections() : [];
  const on = (n: string) => current?.screen === n || master === n;
  const groups = [...new Set(navs.map(([, s]) => core.groupOf(s.def)).filter((g): g is string => !!g))];
  // узкий вид: вкладки внизу, группа — одной вкладкой, её разделы — лентой над экраном
  const solo = navs.filter(([, s]) => !core.groupOf(s.def));
  const openGroup = groups.find((g) => navs.some(([n, s]) => core.groupOf(s.def) === g && on(n)));
  const inOpen = openGroup ? navs.filter(([, s]) => core.groupOf(s.def) === openGroup) : [];
  return { navs, solo, groups, inOpen, tabsShown: !core.wide && !!roster && solo.length + groups.length >= 2, on };
}

/** Кнопка раздела с меткой-счётчиком. */
function Item({ n, s, on }: { n: string; s: ScreenEntry; on: boolean }) {
  const core = useCore();
  const count = core.countOf(s);
  return (
    <button className="sb-nv" aria-current={on ? "page" : undefined} data-screen={n} onClick={() => core.go(n, {})}>
      <span>{s.def.nav}</span>
      {count !== null ? <Badge wait>{count}</Badge> : null}
    </button>
  );
}

/** Колонка разделов широкого вида. */
export function NavColumn({ model, openPal }: { model: SectionsModel; openPal(): void }) {
  const core = useCore();
  const { conn, roster, full } = core.state();
  const { navs, solo, groups, on } = model;
  const cp = conn === "open" ? { text: "на связи", tone: "ok" as const } : conn === "closed" ? { text: "нет связи", tone: "bad" as const } : { text: "подключаюсь", tone: "wait" as const };
  return (
    <nav className="sb-navcol" hidden={!core.wide || !!full}>
      {core.wide && roster ? (
        <>
          <div className="sb-brand">
            <b>{core.brand ?? "Switchboard"}</b>
            <Pill conn tone={cp.tone} title={cp.text} aria-label={cp.text} />
          </div>
          <button className="sb-goto" onClick={openPal}>
            <span>Перейти…</span>
            <kbd>Ctrl K</kbd>
          </button>
          {solo.map(([n, s]) => (
            <Item key={n} n={n} s={s} on={on(n)} />
          ))}
          {groups.flatMap((g) => [
            <div key={`g:${g}`} className="sb-grp">
              {g}
            </div>,
            ...navs.filter(([, s]) => core.groupOf(s.def) === g).map(([n, s]) => <Item key={n} n={n} s={s} on={on(n)} />),
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
      {!core.wide && ready ? model.inOpen.map(([n, s]) => <Item key={n} n={n} s={s} on={model.on(n)} />) : null}
    </nav>
  );
}

/** Вкладки внизу: узкий вид. */
export function Tabs({ model }: { model: SectionsModel }) {
  const core = useCore();
  const { navs, solo, groups, tabsShown, on } = model;
  return (
    <nav className="sb-tabs" aria-label="Разделы" hidden={!tabsShown}>
      {tabsShown ? (
        <>
          {solo.map(([n, s]) => (
            <Item key={n} n={n} s={s} on={on(n)} />
          ))}
          {groups.map((g) => {
            const inG = navs.filter(([, s]) => core.groupOf(s.def) === g);
            const cur = inG.some(([n]) => on(n));
            const count = inG.reduce((acc, [, s]) => acc + (core.countOf(s) ?? 0), 0);
            return (
              <button key={`g:${g}`} className="sb-nv" aria-current={cur ? "page" : undefined} data-group={g} onClick={() => (cur ? null : core.go(inG[0][0], {}))}>
                <span>{g}</span>
                {count ? <Badge wait>{count}</Badge> : null}
              </button>
            );
          })}
        </>
      ) : null}
    </nav>
  );
}
