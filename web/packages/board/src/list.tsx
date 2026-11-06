// Экран «Работа»: ряд фильтров и проекты со строками. Один список для колонки пульта и экрана телефона.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { machineOf } from "@switchboard/protocol";
import { NONE } from "@switchboard/records";
import { Badge, Btn, DisclosureBtn, Dot, failText, IconBtn, incidentOf, lamp, machineLabel, profileNameOf, RowBtn, sessionLabel, stateLabel, TextBtn, useApp, useModule, type App } from "@switchboard/web-ui";
import { holdTouch, rowDrag, sorting, track } from "./drag.ts";
import { beforeOf, blockOf, byUrgency, tree, type Filter, type Line, type Section, type View } from "./model.ts";
import { FilterEditor, ViewPanel } from "./panel.tsx";
import type { BoardState } from "./state.ts";

type Shared = { host: () => HTMLElement; body: () => HTMLElement };
const words = (...list: unknown[]) => list.filter(Boolean).join(" ");
/** Ламп у свёрнутого проекта: больше не помещается. */
const LAMPS = 6;

/** Правка переставила элемент: вернуть фокус после перерисовки. */
function useRefocus(root: () => HTMLElement | null) {
  const wanted = useRef("");
  useLayoutEffect(() => {
    if (wanted.current) root()?.querySelector<HTMLElement>(wanted.current)?.focus();
    wanted.current = "";
  });
  return (selector: string) => void (wanted.current = selector);
}

const PIN = (
  <svg className="bd-pin" viewBox="0 0 16 16" role="img" aria-label="закреплена">
    <path d="M9.8 1.5 14.5 6.2l-2 .6-2.9 2.9-.3 3-1.4 1.4-2.3-3.2L2 14l3-3.6-3.2-2.3 1.4-1.4 3-.3 2.9-2.9z" />
  </svg>
);
const SLIDERS = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M2 4.5h7M13 4.5h1M2 11.5h1M7 11.5h7" />
    <circle cx="11" cy="4.5" r="2" />
    <circle cx="5" cy="11.5" r="2" />
  </svg>
);

/** Что показывает строка: данные выборки. */
function rowOf(app: App, s: BoardState, callsign: string, project: boolean) {
  const r = s.sessions().find((x) => x.callsign === callsign);
  const pinned = s.pins().includes(callsign);
  const owner = s.mine(callsign) ? null : s.owner(callsign);
  return {
    dot: r ? lamp(r) : "stop",
    title: stateLabel(r?.state).text,
    name: sessionLabel(app, callsign),
    at: machineLabel(app, machineOf(callsign)!),
    owner: owner && !pinned ? owner.slice(1).split("@")[0] : null,
    pinned,
    incident: incidentOf(r)?.type,
    project: project ? (s.records()?.find((p) => p.id === s.projectOf(callsign))?.name ?? null) : null,
    asked: app.mark("asked", callsign) as string | undefined,
    unread: app.mark("unread", callsign) as { count: number; text: string } | undefined,
    fail: r?.state === "failed" ? failText(r) : "",
    profile: profileNameOf(r),
    model: r?.model as string | undefined,
    current: app.current()?.screen !== "board" && app.current()?.params.callsign === callsign,
  };
}

/** Вторая строка: вопрос, сбой, непрочитанное; иначе профиль и модель. */
function second(r: ReturnType<typeof rowOf>, v: View): ReactNode {
  if (v.q && r.asked) return <span className="tx q">{`? ${r.asked}`}</span>;
  if (v.fail && r.fail) return <span className="tx f">{r.fail}</span>;
  if (v.unread && r.unread?.text) return <span className="tx">{r.unread.text}</span>;
  return (
    <>
      {v.prof && r.profile && <span className="bd-pill">{r.profile}</span>}
      {v.model && r.model && <span className="tx">{r.model}</span>}
    </>
  );
}

function Row({ line, v, flat, grouped, shared }: { line: Line; v: View; flat: boolean; grouped: boolean; shared: Shared }) {
  const app = useApp();
  const s = useModule<BoardState>();
  const { callsign, depth } = line;
  const r = app.use(() => rowOf(app, s, callsign, flat));
  const open = () => app.open(!app.wide && r.asked ? "ask" : "card", { callsign });
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (flat) return;
    const row = e.currentTarget;
    track(e, true, (from) => rowDrag({ host: shared.host(), scroller: shared.body(), row, block: blockOf(callsign, s.sessions()), done: s.drop }, from));
  };
  return (
    <RowBtn className={words("bd-row", depth > 0 && "kid")} style={depth > 0 ? { paddingLeft: `${10 + depth * 22}px` } : undefined} data-callsign={callsign} aria-current={r.current || undefined} onClick={open} onPointerDown={down}>
      {v.lamp && <Dot kind={r.dot} title={r.title} />}
      <span className="bd-rt">
        <span className="bd-t1">
          <b className={words("bd-cs", r.name.human && "hum")}>{r.name.text}</b>
          {v.pin && r.pinned && PIN}
          {v.owner && r.owner && <span className="bd-pill own">{r.owner}</span>}
          {v.inc && r.incident && <span className="bd-pill inc">{r.incident}</span>}
          {v.at && !grouped && <span className={words("bd-at", r.at.human && "hum")}>{r.at.text}</span>}
        </span>
        <span className="bd-t2">
          {r.project && <span className="prj">{r.project}</span>}
          {second(r, v)}
        </span>
      </span>
      {v.badge && r.asked && (
        <Badge wait aria-label="ждёт ответа">
          ?
        </Badge>
      )}
      {v.badge && !r.asked && !!r.unread?.count && <Badge>{r.unread.count}</Badge>}
    </RowBtn>
  );
}

/** Поле имени проекта: Enter и уход с поля сохраняют, Esc — нет. Значение читается из поля: печатать может и автозаполнение. */
function NameField({ value = "", save, close, ...input }: { value?: string; save(text: string): void; close(): void; className?: string; "data-f": string; "aria-label": string }) {
  const finish = (el: HTMLInputElement) => {
    const text = el.value.trim();
    if (text && text !== value) save(text);
    close();
  };
  return (
    <input
      {...input}
      autoFocus
      defaultValue={value}
      onBlur={(e) => finish(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget);
        if (e.key === "Escape") close();
      }}
    />
  );
}

function Project({ section, v, shared, menu, setMenu, order }: { section: Section; v: View; shared: Shared; menu: boolean; setMenu(open: boolean): void; order: string[] }) {
  const app = useApp();
  const s = useModule<BoardState>();
  const { id, name, callsigns } = section;
  const folded = app.use(() => s.device.get().collapsed[id] === true);
  const lamps = app.use(() => (folded ? byUrgency(s.sessions().filter((x) => callsigns.includes(x.callsign))).slice(0, LAMPS).map(lamp) : []));
  const refocus = useRefocus(shared.host);
  const parentOf = (c: string) => s.sessions().find((x) => x.callsign === c)?.parent;
  const lines = (list: string[]) => (v.tree ? tree(list, parentOf) : list.map((callsign) => ({ callsign, depth: 0 })));
  const groups = v.group ? [...new Set(callsigns.map((c) => machineOf(c)!))].sort() : [];

  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setMenu(!menu);
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const before = beforeOf(order, id, e.key === "ArrowUp" ? -1 : 1);
    if (before === undefined) return;
    refocus(`.grip[data-proj="${id}"]`);
    s.moveProject(id, before);
  };
  const down = (e: PointerEvent<HTMLElement>) => {
    const item = e.currentTarget.closest<HTMLElement>(".pjs")!;
    const list = item.parentElement!;
    const items = [...list.querySelectorAll<HTMLElement>(":scope > .pjs")];
    track(e, false, (from) =>
      sorting(
        {
          host: shared.host(),
          list,
          scroller: shared.body(),
          items,
          item,
          grabbed: item.querySelector<HTMLElement>(".pj")!,
          axis: "y",
          look: { on: "dnd-on", slot: ["dnd-slot", "dnd-folded"], card: "dnd-card", up: "up", land: "land" },
          done: (index) => s.moveProject(id, items.filter((x) => x !== item)[index]?.dataset.proj ?? null),
        },
        from,
      ),
    );
  };
  const add = () => {
    const top = s.sessions().find((x) => x.callsign === callsigns[0]);
    app.open("open", { ...(top ? { machine: machineOf(top.callsign)!, dir: String(top.dir ?? "~") } : {}), project: id });
  };

  return (
    <section className="pjs" data-proj={id}>
      <div className="pj">
        {v.grip && id !== NONE && (
          <span className="grip" role="button" tabIndex={0} data-proj={id} aria-label={`Проект ${name}: перетащить, стрелки или нажать — имя и удаление`} onClick={() => setMenu(!menu)} onKeyDown={keys} onPointerDown={down}>
            ⠿
          </span>
        )}
        <DisclosureBtn className="pj-t" data-proj={id} open={!folded} onClick={() => s.toggle(id, folded)}>
          <span className="car">▼</span>
          <span className="nm">{name}</span>
          {v.pjlamps && lamps.length > 0 && (
            <span className="lamps">
              {lamps.map((d, i) => (
                <Dot key={i} kind={d} />
              ))}
            </span>
          )}
        </DisclosureBtn>
        {v.add && (
          <IconBtn className="pj-add" data-proj={id} aria-label={`Новая сессия в ${name}`} onClick={add}>
            +
          </IconBtn>
        )}
      </div>
      {menu && (
        <div className="pj-menu" data-menu={id}>
          <NameField data-f="project-name" aria-label="Имя проекта" value={name} save={(text) => s.renameProject(id, text)} close={() => setMenu(false)} />
          <Btn bad data-act="project-remove" onPointerDown={(e) => e.preventDefault()} onClick={() => (setMenu(false), s.removeProject(id))}>
            Удалить
          </Btn>
        </div>
      )}
      {!folded && !v.group && lines(callsigns).map((line) => <Row key={line.callsign} line={line} v={v} flat={false} grouped={false} shared={shared} />)}
      {!folded &&
        groups.flatMap((m) => {
          const here = callsigns.filter((c) => machineOf(c) === m);
          return [
            <div key={`@${m}`} className="mgrp" data-group={m}>
              {machineLabel(app, m).text}
              <span className="n">{here.length}</span>
            </div>,
            ...lines(here).map((line) => <Row key={line.callsign} line={line} v={v} flat={false} grouped shared={shared} />),
          ];
        })}
    </section>
  );
}

function Lists({ filter, v, shared }: { filter: Filter; v: View; shared: Shared }) {
  const app = useApp();
  const s = useModule<BoardState>();
  const [menu, setMenu] = useState("");
  const [adding, setAdding] = useState(false);
  const sections = app.use(() => (s.drawn() ? s.shown(s.conditions(filter)) : []));
  const drawn = app.use(() => s.drawn());
  const box = useRef<HTMLDivElement>(null);
  const open = app.use(() => app.current()?.params.callsign);
  useEffect(() => {
    if (v.projects) s.firstShow(sections);
  });
  // открытая строка всегда видна, и когда только что появилась
  const shown = sections.some((x) => open && x.callsigns.includes(open));
  useEffect(() => {
    if (open) box.current?.querySelector(`.bd-row[data-callsign="${CSS.escape(open)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, shown]);
  if (!drawn) return <div className="lst" />;
  const empty = !sections.some((x) => x.callsigns.length) && <div className="bd-empty">{`в «${filter.name}» сессий нет`}</div>;
  if (!v.projects) {
    return (
      <div ref={box} className="lst flat">
        {sections.flatMap((x) => x.callsigns).map((callsign) => (
          <Row key={callsign} line={{ callsign, depth: 0 }} v={v} flat grouped={false} shared={shared} />
        ))}
        {empty}
      </div>
    );
  }
  const order = sections.map((x) => x.id);
  return (
    <div ref={box} className="lst">
      {sections.map((section) => (
        <Project key={section.id} section={section} v={v} shared={shared} menu={menu === section.id} setMenu={(open) => setMenu(open ? section.id : "")} order={order} />
      ))}
      {empty}
      {adding ? (
        <NameField className="pj-newin" data-f="project-new" aria-label="Имя нового проекта" save={s.addProject} close={() => setAdding(false)} />
      ) : (
        <TextBtn className="pj-new" data-act="project-new" onClick={() => setAdding(true)}>
          Новый проект
        </TextBtn>
      )}
    </div>
  );
}

function FilterRow({ v, panel, setPanel, edit, shared }: { v: View; panel: boolean; setPanel(open: boolean): void; edit(f: Filter | null): void; shared: Shared }) {
  const app = useApp();
  const s = useModule<BoardState>();
  const scroll = useRef<HTMLDivElement>(null);
  const refocus = useRefocus(() => scroll.current);
  const chips = app.use(() => s.chips().map((c) => ({ ...c, n: s.fitting(s.conditions(c as Filter)).length })));
  const selected = app.use(() => s.selected().id);
  const ids = chips.map((c) => c.id);
  const own = (id: string) => s.filters().find((f) => f.id === id);
  const put = (id: string, index: number) => {
    const rest = ids.filter((x) => x !== id);
    s.setRow([...rest.slice(0, index), id, ...rest.slice(index)]);
  };
  const keys = (e: KeyboardEvent, id: string) => {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const index = ids.indexOf(id) + (e.key === "ArrowLeft" ? -1 : 1);
    if (index < 0 || index >= ids.length) return;
    refocus(`[data-fid="${id}"]`);
    put(id, index);
  };
  const down = (e: PointerEvent<HTMLElement>, id: string) => {
    const item = e.currentTarget;
    const list = scroll.current!;
    track(e, true, (from) =>
      sorting({ host: shared.host(), list, scroller: list, items: [...list.querySelectorAll<HTMLElement>(":scope > .fc")], item, grabbed: item, axis: "x", look: { on: "fc-sorting", slot: ["fc-slot"], card: "fc-ghost", up: "lifted", land: "landing" }, done: (index) => put(id, index) }, from),
    );
  };
  return (
    <div className="fbar">
      <div className="fscroll" role="tablist" aria-label="Фильтры" ref={scroll}>
        {chips.map((c) => (
          <button key={c.id} type="button" role="tab" className="fc" data-fid={c.id} aria-selected={c.id === selected} onKeyDown={(e) => keys(e, c.id)} onPointerDown={(e) => down(e, c.id)} onClick={() => (c.id === selected && own(c.id) ? edit(own(c.id)!) : s.pick(c.id))}>
            {c.name}
            {v.fcount && <span className="n">{c.n}</span>}
            {c.id === selected && own(c.id) && (
              <span className="ed" aria-hidden="true">
                ✎
              </span>
            )}
          </button>
        ))}
      </div>
      <IconBtn className="fc add" aria-label="Новый фильтр" onClick={() => edit(null)}>
        +
      </IconBtn>
      <IconBtn className="fc vw" aria-label="Вид списка" aria-expanded={panel} onClick={() => setPanel(!panel)}>
        {SLIDERS}
      </IconBtn>
    </div>
  );
}

export function BoardScreen() {
  const app = useApp();
  const s = useModule<BoardState>();
  const host = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState(false);
  const [editing, setEditing] = useState<Filter | null | undefined>(undefined);
  const v = app.use(() => s.device.get().view);
  const filter = app.use(() => s.selected());
  const side = app.use(() => app.current()?.master === "board");
  const shared: Shared = { host: () => host.current!, body: () => body.current! };
  useEffect(() => holdTouch(host.current!), []);
  useLayoutEffect(() => {
    const el = body.current!;
    el.scrollTop = s.scroll.top;
    return () => void (s.scroll.top = el.scrollTop);
  }, [s]);
  return (
    <div className={words("bd", app.wide && "wide", side && "side")}>
      <div className={words("bd-list", v.dense && "dense")} ref={host}>
        {app.wide && (
          <div className="bd-lh">
            <b>Работа</b>
            <Btn pri data-new="1" onClick={() => app.open("open")}>
              Новая
            </Btn>
          </div>
        )}
        <FilterRow v={v} panel={panel} setPanel={setPanel} edit={setEditing} shared={shared} />
        <div className="bd-body" ref={body}>
          <Lists filter={filter} v={v} shared={shared} />
        </div>
        {panel && <ViewPanel v={v} close={() => setPanel(false)} />}
      </div>
      {app.wide && <div className="bd-pick" />}
      {editing !== undefined && <FilterEditor filter={editing} close={() => setEditing(undefined)} />}
    </div>
  );
}
