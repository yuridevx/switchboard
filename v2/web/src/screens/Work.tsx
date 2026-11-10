// «Работа»: сессии по проектам. Свои фильтры, список или доска, закрепление, свой порядок; строка переносится в другой проект мышью и пальцем.
import { peopleList, projectRemove, projectSet, sessionUpdate, type SessionRow } from "@sb/protocol";
import { ActionIcon, Button, Chip, Group, Menu, Modal, MultiSelect, Popover, SegmentedControl, Stack, Switch, Text, TextInput, Tooltip } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { IconAdjustmentsHorizontal, IconArrowDown, IconArrowUp, IconCheck, IconChevronDown, IconChevronRight, IconDots, IconFilter, IconPencil, IconPin, IconPinFilled, IconPlus, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { act } from "../api.ts";
import { confirmDanger, Lamp, personWord, SessionLine, useCall, useMachineName, useMyPrefs, useUi, useWide } from "../common.tsx";
import { useRowDrag } from "../lib/drag.ts";
import { getLocal, useLocal } from "../lib/local.ts";
import { ago } from "../lib/time.ts";
import { BUILTIN, type Filter, groupsByMachine, groupsOf, NO_PROJECT, projectOf, reorder, rowsOf, shift, STATE_GROUPS, treeOf, whyMine } from "../lib/work.ts";
import { Conversation, pairKey, type Side } from "../session/Conversation.tsx";
import { isMine, machineOfCall, useFleet } from "../store/fleet.ts";

const askLine = (s: SessionRow) => (s.ask ? (s.ask.kind === "plan" ? "ждёт решения по плану" : s.ask.text) : s.wait ? `ждёт сброса лимита до ${new Date(s.wait).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : s.doing);
const blank = (): Filter => ({ id: "f" + Date.now().toString(36), name: "", who: "all", states: [], projects: [], machines: [], pieces: [] });

/** Свои фильтры: создать, править, порядок, удалить. Лежат в настройках человека и видны на всех его устройствах. */
function Filters({ filters, save, onClose }: { filters: Filter[]; save: (next: Filter[]) => void; onClose: () => void }) {
  const machines = useFleet((f) => f.machines);
  const sessions = useFleet((f) => f.sessions);
  const projects = useCall(peopleList, {});
  const [edit, setEdit] = useState<Filter | null>(null);
  // кусочки — те, что стоят у сессий флота: чаще встречающиеся раньше
  const pieces = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of Object.values(sessions)) for (const p of s.spec.pieces ?? []) n.set(p, (n.get(p) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }, [sessions]);
  if (edit) {
    const set = (p: Partial<Filter>) => setEdit({ ...edit, ...p });
    return (
      <Stack gap="sm">
        <TextInput label="Название" value={edit.name} onChange={(e) => set({ name: e.currentTarget.value })} autoFocus />
        <SegmentedControl value={edit.who} onChange={(who) => set({ who: who as Filter["who"] })} data={[{ value: "mine", label: "Мои" }, { value: "all", label: "Все" }]} aria-label="Чьи сессии" />
        <Chip.Group multiple value={edit.states ?? []} onChange={(states) => set({ states })}>
          <Group gap={6}>{STATE_GROUPS.map(([id, word]) => <Chip key={id} value={id} size="xs">{word}</Chip>)}</Group>
        </Chip.Group>
        <MultiSelect label="Проекты" searchable data={(projects.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} value={edit.projects ?? []} onChange={(v) => set({ projects: v })} clearable />
        <MultiSelect label="Машины" searchable data={Object.keys(machines)} value={edit.machines ?? []} onChange={(v) => set({ machines: v })} clearable />
        <MultiSelect label="Кусочки" searchable data={pieces} value={edit.pieces ?? []} onChange={(v) => set({ pieces: v })} clearable />
        <Group>
          <Button disabled={!edit.name.trim()} onClick={() => { save(filters.some((f) => f.id === edit.id) ? filters.map((f) => (f.id === edit.id ? edit : f)) : [...filters, edit]); setEdit(null); }}>Сохранить</Button>
          <Button variant="default" onClick={() => setEdit(null)}>Назад</Button>
        </Group>
      </Stack>
    );
  }
  return (
    <Stack gap="xs">
      {filters.map((f, i) => (
        <div key={f.id} className="line">
          <span className="grow trunc">{f.name}</span>
          <ActionIcon variant="subtle" size="sm" aria-label={`Выше: ${f.name}`} disabled={i === 0} onClick={() => save(shift(filters, f, -1))}><IconArrowUp size={14} /></ActionIcon>
          <ActionIcon variant="subtle" size="sm" aria-label={`Ниже: ${f.name}`} disabled={i === filters.length - 1} onClick={() => save(shift(filters, f, 1))}><IconArrowDown size={14} /></ActionIcon>
          <ActionIcon variant="subtle" size="sm" aria-label={`Изменить: ${f.name}`} onClick={() => setEdit(f)}><IconPencil size={14} /></ActionIcon>
          <ActionIcon variant="subtle" size="sm" color="red" aria-label={`Удалить: ${f.name}`} onClick={() => save(filters.filter((x) => x.id !== f.id))}><IconTrash size={14} /></ActionIcon>
        </div>
      ))}
      <Group><Button size="xs" onClick={() => setEdit(blank())}>Новый фильтр</Button><Button size="xs" variant="default" onClick={onClose}>Готово</Button></Group>
    </Stack>
  );
}

export function Work() {
  const { callsign } = useParams();
  const go = useNavigate();
  const wide = useWide();
  const qc = useQueryClient();
  const picture = useFleet();
  const ui = useUi();
  const people = useCall(peopleList, {});
  const prefs = useMyPrefs();
  // вид, выбранный фильтр и свёрнутые проекты помнит это устройство; фильтры, закрепление и порядок — настройки человека
  const [view, setView] = useLocal<"list" | "board">("work.view", "list");
  const [filterId, setFilterId] = useLocal("work.filter", "mine");
  const [closed, setClosed] = useLocal<string[]>("work.closed", []);
  // «Вид списка»: по чему группировать и ставить ли дочерние под родителем — помнит устройство
  const [groupBy, setGroupBy] = useLocal<"project" | "machine">("work.group", "project");
  const [nested, setNested] = useLocal("work.nested", true);
  const machineName = useMachineName();
  const [editFilters, setEditFilters] = useState(false);
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pins = (prefs.values.pins as string[] | undefined) ?? [];
  const order = (prefs.values.order as string[] | undefined) ?? [];
  const custom = (prefs.values.filters as Filter[] | undefined) ?? [];
  const projectOrder = (prefs.values.projects as string[] | undefined) ?? [];
  const filters = [...BUILTIN, ...custom];
  const filter = filters.find((f) => f.id === filterId) ?? BUILTIN[0]!;
  // доска — вид широкого экрана: на телефоне те же сессии идут списком
  const board = wide && !callsign && view === "board";
  const rows = useMemo(() => rowsOf(picture, filter, pins, order), [picture.sessions, picture.you, filter, pins.join(), order.join()]);
  const names = Object.fromEntries((people.data?.projects ?? []).map((p) => [p.id, p.name]));
  const groups = useMemo(() => (groupBy === "machine" ? groupsByMachine(rows, machineName) : groupsOf(picture, rows, projectOrder, names)), [rows, projectOrder.join(), people.data, groupBy]); // eslint-disable-line react-hooks/exhaustive-deps
  // строки группы деревом: пара — одной строкой, дочерние — под родителем
  const trees = useMemo(() => new Map(groups.map((g) => [g.project, treeOf(picture, g.rows, nested)])), [groups, nested]); // eslint-disable-line react-hooks/exhaustive-deps
  const flat = groups.flatMap((g) => (closed.includes(g.project) ? [] : trees.get(g.project)!.map((r) => r.s.callsign)));
  // пара открывается той стороной, которую человек смотрел последней
  const open = (c: string) => {
    const wing = picture.sessions[c]?.spec.wing;
    go(`/work/${wing && picture.sessions[wing] && getLocal<Side>(pairKey(c), "lead") === "wing" ? wing : c}`);
  };
  // на широком экране вход на «Работу» открывает первую сессию списка
  const entered = useRef(false);
  useEffect(() => {
    if (entered.current || !picture.rev) return;
    entered.current = true;
    // сама открывается только прочитанная: открытие снимает пометку «непрочитано», а итоги человек разбирает в «Вам»
    const me = picture.you?.person ?? "";
    const first = flat.find((c) => !picture.sessions[c]?.unread?.includes(me));
    if (wide && !callsign && view === "list" && first) open(first);
  }, [picture.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const move = (d: number) => {
    // открытый ведомый стоит в строке своего ведущего
    const at = callsign ? flat.indexOf(picture.sessions[callsign]?.lead && !flat.includes(callsign) ? picture.sessions[callsign]!.lead! : callsign) : -1;
    const next = flat[Math.max(0, Math.min(flat.length - 1, at + d))];
    if (next) open(next);
  };
  useHotkeys([["j", () => move(1)], ["k", () => move(-1)]]);
  // открытая сессия видна в списке: прокрутка к её строке
  useEffect(() => {
    if (callsign) box.current?.querySelector(`[data-call="${CSS.escape(callsign)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [callsign]);

  const drag = useRowDrag({
    box,
    onDrop: ({ id, before, group }) => {
      const s = picture.sessions[id];
      if (!s) return;
      void prefs.save("order", reorder(rows.map((r) => r.callsign), id, before));
      // строка упала в другой проект — меняется документ сессии
      if (projectOf(picture, s) !== group) void act(sessionUpdate, { to: id, patch: { project: group } }, `${id} → ${names[group] ?? (group || "без проекта")}`);
    },
  });
  const pin = (c: string) => prefs.save("pins", pins.includes(c) ? pins.filter((p) => p !== c) : [...pins, c]);
  const toggle = (project: string) => setClosed(closed.includes(project) ? closed.filter((x) => x !== project) : [...closed, project]);
  const moveProject = (id: string, d: -1 | 1) => prefs.save("projects", shift(groups.map((g) => g.project).filter((p) => p !== NO_PROJECT), id, d));
  const admin = !!picture.you?.admin;
  const offline = (s: SessionRow) => picture.machines[machineOfCall(s.callsign)]?.online === false;

  return (
    <div className={`panes${callsign ? " has-detail" : " solo"}`}>
      <section className="pane list" aria-label="Работа">
        <div className="pane-head" style={{ flexWrap: "nowrap" }}>
          <h1>Работа</h1>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target><Button size="compact-sm" variant="default" leftSection={<IconFilter size={14} />} aria-label="Фильтр списка">{filter.name}</Button></Menu.Target>
            <Menu.Dropdown>
              {filters.map((f) => <Menu.Item key={f.id} onClick={() => setFilterId(f.id)} leftSection={f.id === filter.id ? <IconCheck size={14} /> : <span style={{ width: 14, display: "inline-block" }} />}>{f.name}</Menu.Item>)}
              <Menu.Divider />
              <Menu.Item onClick={() => setEditFilters(true)}>Свои фильтры…</Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Popover position="bottom-end" withinPortal>
            <Popover.Target><Tooltip label="Вид списка"><ActionIcon variant="default" size="md" aria-label="Вид списка"><IconAdjustmentsHorizontal size={15} /></ActionIcon></Tooltip></Popover.Target>
            <Popover.Dropdown>
              <Stack gap="xs">
                {wide && <SegmentedControl size="xs" fullWidth value={view} onChange={(v) => (setView(v as "list" | "board"), callsign && v === "board" && go("/work"))} data={[{ value: "list", label: "Список" }, { value: "board", label: "Доска" }]} aria-label="Вид" />}
                <SegmentedControl size="xs" fullWidth value={groupBy} onChange={(v) => setGroupBy(v as "project" | "machine")} data={[{ value: "project", label: "По проектам" }, { value: "machine", label: "По машинам" }]} aria-label="Группы" />
                <Switch size="xs" label="Дочерние под родителем" checked={nested} onChange={(e) => setNested(e.currentTarget.checked)} />
              </Stack>
            </Popover.Dropdown>
          </Popover>
        </div>
        {board ? (
          <div className="board scroll">
            {STATE_GROUPS.map(([id, word, st]) => (
              <div key={id} className="col" aria-label={word}>
                <div className="grp" style={{ padding: "4px 6px" }}>{word}</div>
                {rows.filter((s) => st.includes(s.state)).map((s) => (
                  <div key={s.callsign} className="tile" role="button" tabIndex={0} onClick={() => go(`/work/${s.callsign}`)} onKeyDown={(e) => e.key === "Enter" && go(`/work/${s.callsign}`)}>
                    <Group gap={8} wrap="nowrap" align="start">
                      <Lamp state={s.state} offline={offline(s)} />
                      <div style={{ minWidth: 0, flex: 1 }}><div className="t trunc" style={{ fontWeight: 500 }}>{s.title ?? s.spec.name}</div><div className="sub trunc muted mono" style={{ fontSize: 12 }}>{s.callsign}</div></div>
                      <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{ago(s.last ?? s.since)}</span>
                    </Group>
                    {askLine(s) && <div className="clamp2 muted" style={{ fontSize: 12.5, marginTop: 4 }}>{askLine(s)}</div>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="scroll dragbox" ref={box}>
            {!rows.length && <div className="hole" style={{ height: "60%" }}>Сессий нет. Клавиша N открывает новую.</div>}
            {drag.line !== null && <div className="dragline" style={{ top: drag.line }} />}
            {groups.map((g, gi) => {
              const shut = closed.includes(g.project);
              const real = g.project !== NO_PROJECT && groupBy === "project";
              return (
                <div key={g.project} data-drop-group={g.project}>
                  <div className="grp">
                    <button type="button" className="grp-name" aria-expanded={!shut} onClick={() => toggle(g.project)}>
                      {shut ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}<span className="trunc">{g.name}</span>
                    </button>
                    {/* свёрнутый проект показывает лампами, что в нём ждёт человека */}
                    {shut && <span className="lamps">{g.rows.filter((s) => s.state === "waiting" || s.state === "failed" || s.state === "busy").slice(0, 8).map((s) => <Lamp key={s.callsign} state={s.state} offline={offline(s)} />)}</span>}
                    <span className="grp-acts">
                      <Tooltip label={groupBy === "machine" ? "Новая сессия на машине" : "Новая сессия в проекте"}><ActionIcon size="xs" variant="subtle" aria-label={`Новая сессия: ${g.name}`} onClick={() => ui.set({ newOpen: true, newPreset: groupBy === "machine" ? { machine: g.project.slice(1) } : real ? { project: g.project } : null })}><IconPlus size={13} /></ActionIcon></Tooltip>
                      {real && (
                        <Menu withinPortal position="bottom-end">
                          <Menu.Target><ActionIcon size="xs" variant="subtle" aria-label={`Действия с проектом ${g.name}`}><IconDots size={13} /></ActionIcon></Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item disabled={gi === 0} onClick={() => moveProject(g.project, -1)}>Выше</Menu.Item>
                            <Menu.Item disabled={gi >= groups.filter((x) => x.project !== NO_PROJECT).length - 1} onClick={() => moveProject(g.project, 1)}>Ниже</Menu.Item>
                            {admin && <Menu.Item onClick={() => setRename({ id: g.project, name: g.name })}>Переименовать</Menu.Item>}
                            {admin && <Menu.Item color="red" onClick={() => confirmDanger({
                              title: `Удалить проект «${g.name}»?`, confirm: "Удалить",
                              body: "Люди проекта перестанут доставать до машин друг друга через него. Сессии останутся и встанут в «Без проекта».",
                              onConfirm: async () => (await act(projectRemove, { project: g.project }, "Проект удалён")) && qc.invalidateQueries({ queryKey: ["people.list"] }),
                            })}>Удалить</Menu.Item>}
                          </Menu.Dropdown>
                        </Menu>
                      )}
                    </span>
                  </div>
                  {!shut && trees.get(g.project)!.map(({ s, depth, wing }) => {
                    const pinned = pins.includes(s.callsign);
                    const mine = isMine(picture, s);
                    return (
                      <div key={s.callsign} className={`rowwrap${drag.dragging === s.callsign ? " dragging" : ""}`} data-drag-id={s.callsign} data-drag-group={g.project} onPointerDown={groupBy === "project" ? drag.onPointerDown(s.callsign) : undefined}>
                        <SessionLine s={s} depth={depth} wing={wing} why={whyMine(picture, s, pins)} selected={s.callsign === callsign || (!!wing && wing.callsign === callsign)} onPick={() => open(s.callsign)} sub={<>
                          {askLine(s) ? <> · {askLine(s)}</> : s.state === "failed" ? <> · {s.error ?? "сбой"}</> : null}
                          {!mine && <> <span className="chip">{personWord(s.by.includes("~") ? s.by.slice(s.by.indexOf("~")) : s.by)}</span></>}
                          {s.incident && <> <span className="chip warn">обращение: {s.incident.kind}</span></>}
                          {(s.spec.pieces?.length ?? 0) > 1 && <> <span className="chip mono">{s.spec.pieces!.join(" + ")}</span></>}
                        </>} />
                        {/* закрепление: по наведению; на телефоне — в меню разговора, закреплённая помечена значком */}
                        {(wide || pinned) && (
                          <Tooltip label={pinned ? "Открепить" : "Закрепить"}>
                            <ActionIcon size="xs" variant="subtle" className={`pinbtn${pinned ? " on" : ""}`} aria-label={pinned ? "Открепить" : "Закрепить"} onClick={() => pin(s.callsign)}>
                              {pinned ? <IconPinFilled size={13} /> : <IconPin size={13} />}
                            </ActionIcon>
                          </Tooltip>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </section>
      {callsign && (
        <section className="pane detail">
          <Conversation callsign={callsign} onBack={() => go("/work")} />
        </section>
      )}
      <Modal opened={editFilters} onClose={() => setEditFilters(false)} title="Свои фильтры"><Filters filters={custom} save={(next) => void prefs.save("filters", next)} onClose={() => setEditFilters(false)} /></Modal>
      <Modal opened={!!rename} onClose={() => setRename(null)} title="Переименовать проект">
        {rename && (
          <Stack gap="sm">
            <TextInput aria-label="Название проекта" value={rename.name} onChange={(e) => setRename({ ...rename, name: e.currentTarget.value })} autoFocus
              onKeyDown={(e) => e.key === "Enter" && rename.name.trim() && void act(projectSet, { project: rename.id, name: rename.name.trim() }, "Проект переименован").then((r) => r && (qc.invalidateQueries({ queryKey: ["people.list"] }), setRename(null)))} />
            <Button disabled={!rename.name.trim()} onClick={async () => { if (await act(projectSet, { project: rename.id, name: rename.name.trim() }, "Проект переименован")) { await qc.invalidateQueries({ queryKey: ["people.list"] }); setRename(null); } }}>Сохранить</Button>
          </Stack>
        )}
      </Modal>
    </div>
  );
}
