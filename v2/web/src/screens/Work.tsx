// «Работа»: сессии по проектам. Список или доска по состояниям; свои или все; закрепление и свой порядок.
import { peopleList, type SessionRow } from "@sb/protocol";
import { ActionIcon, Group, Menu, SegmentedControl, Tooltip } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { IconCheck, IconChevronDown, IconChevronRight, IconFilter, IconPin, IconPinFilled } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Lamp, SessionLine, useCall, useMyPrefs, useWide } from "../common.tsx";
import { ago } from "../lib/time.ts";
import { Conversation } from "../session/Conversation.tsx";
import { byUrgency, isMine, useFleet } from "../store/fleet.ts";

const GROUPS: Array<[string, string, SessionRow["state"][]]> = [["wait", "Ждут вас", ["waiting", "failed"]], ["run", "Работают", ["busy", "starting"]], ["idle", "Свободны", ["idle"]], ["down", "Стоят", ["stopped", "stopping"]]];
const askLine = (s: SessionRow) => (s.ask ? (s.ask.kind === "plan" ? "ждёт решения по плану" : s.ask.text) : s.doing);

export function Work() {
  const { callsign } = useParams();
  const go = useNavigate();
  const wide = useWide();
  const picture = useFleet();
  const projects = useCall(peopleList, {});
  const prefs = useMyPrefs();
  const [who, setWho] = useState("mine");
  const [states, setStates] = useState<string[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const [drag, setDrag] = useState<string | null>(null);
  const pins = (prefs.values.pins as string[] | undefined) ?? [];
  const order = (prefs.values.order as string[] | undefined) ?? [];
  // доска — вид широкого экрана: на телефоне те же сессии идут списком
  const board = wide && !callsign && ((prefs.values.view as { work?: string } | undefined)?.work ?? "list") === "board";
  const rows = useMemo(() => {
    const rank = (s: SessionRow) => (order.indexOf(s.callsign) + 1 || 1e6);
    return Object.values(picture.sessions)
      .filter((s) => who === "all" || isMine(picture, s))
      .filter((s) => board || !states.length || GROUPS.some(([id, , st]) => states.includes(id) && st.includes(s.state)))
      .sort((a, b) => Number(pins.includes(b.callsign)) - Number(pins.includes(a.callsign)) || rank(a) - rank(b) || byUrgency(a, b));
  }, [picture.sessions, picture.you, who, states, board, pins.join(), order.join()]);
  const flat = rows.map((s) => s.callsign);
  const move = (d: number) => {
    const next = flat[Math.max(0, Math.min(flat.length - 1, (callsign ? flat.indexOf(callsign) : -1) + d))];
    if (next) go(`/work/${next}`);
  };
  useHotkeys([["j", () => move(1)], ["k", () => move(-1)]]);
  const names = Object.fromEntries((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
  const byProject = new Map<string, SessionRow[]>();
  for (const s of rows) (byProject.get(s.spec.project ?? "") ?? (byProject.set(s.spec.project ?? "", []), byProject.get(s.spec.project ?? "")!)).push(s);
  const drop = (target: string) => {
    if (!drag || drag === target) return;
    const next = flat.filter((c) => c !== drag);
    next.splice(next.indexOf(target), 0, drag);
    void prefs.save("order", next);
    setDrag(null);
  };
  const pin = (c: string) => prefs.save("pins", pins.includes(c) ? pins.filter((p) => p !== c) : [...pins, c]);
  const toggle = (id: string) => setStates((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className={`panes${callsign ? " has-detail" : " solo"}`}>
      <section className="pane list" aria-label="Работа">
        <div className="pane-head" style={{ flexWrap: "nowrap" }}>
          <h1>Работа</h1>
          <SegmentedControl size="xs" value={who} onChange={setWho} data={[{ value: "mine", label: "Мои" }, { value: "all", label: "Все" }]} aria-label="Чьи сессии" />
          {wide && !callsign && <SegmentedControl size="xs" value={board ? "board" : "list"} onChange={(v) => prefs.save("view", { work: v })} data={[{ value: "list", label: "Список" }, { value: "board", label: "Доска" }]} aria-label="Вид" />}
          {!board && (
            <Menu position="bottom-end" withinPortal closeOnItemClick={false}>
              <Menu.Target><Tooltip label="Состояние"><ActionIcon variant={states.length ? "light" : "subtle"} aria-label="Фильтр по состоянию"><IconFilter size={16} /></ActionIcon></Tooltip></Menu.Target>
              <Menu.Dropdown>{GROUPS.map(([id, word]) => <Menu.Item key={id} onClick={() => toggle(id)} leftSection={states.includes(id) ? <IconCheck size={14} /> : <span style={{ width: 14, display: "inline-block" }} />}>{word}</Menu.Item>)}</Menu.Dropdown>
            </Menu>
          )}
        </div>
        {board ? (
          <div className="board scroll">
            {GROUPS.map(([id, word, st]) => (
              <div key={id} className="col" aria-label={word}>
                <div className="grp" style={{ padding: "4px 6px" }}>{word}</div>
                {rows.filter((s) => st.includes(s.state)).map((s) => (
                  <div key={s.callsign} className="tile" role="button" tabIndex={0} onClick={() => go(`/work/${s.callsign}`)} onKeyDown={(e) => e.key === "Enter" && go(`/work/${s.callsign}`)}>
                    <Group gap={8} wrap="nowrap" align="start">
                      <Lamp state={s.state} offline={picture.machines[s.callsign.slice(s.callsign.indexOf("@") + 1)]?.online === false} />
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
          <div className="scroll">
            {!rows.length && <div className="hole" style={{ height: "60%" }}>Сессий нет. Клавиша N открывает новую.</div>}
            {[...byProject].map(([project, list]) => (
              <div key={project}>
                <button type="button" className="grp" style={{ border: 0, background: "none", cursor: "pointer", width: "100%", fontFamily: "inherit" }} aria-expanded={!closed.includes(project)} onClick={() => setClosed((c) => (c.includes(project) ? c.filter((x) => x !== project) : [...c, project]))}>
                  {closed.includes(project) ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}{names[project] ?? (project || "Без проекта")}
                </button>
                {!closed.includes(project) && list.map((s) => {
                  const pinned = pins.includes(s.callsign);
                  return (
                    <div key={s.callsign} className="rowwrap" draggable={wide} onDragStart={() => setDrag(s.callsign)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(s.callsign)}>
                      <SessionLine s={s} selected={s.callsign === callsign} onPick={() => go(`/work/${s.callsign}`)} sub={askLine(s) ? <> · {askLine(s)}</> : s.state === "failed" ? <> · {s.error ?? "сбой"}</> : <></>} />
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
            ))}
          </div>
        )}
      </section>
      {callsign && (
        <section className="pane detail">
          <Conversation callsign={callsign} onBack={() => go("/work")} />
        </section>
      )}
    </div>
  );
}
