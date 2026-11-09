// «Работа»: сессии по проектам. Список или доска по состояниям; свои или все; закрепление и свой порядок.
import { peopleList, prefsGet, prefsSet, type SessionRow } from "@sb/protocol";
import { ActionIcon, Chip, Group, SegmentedControl, Tooltip } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { IconChevronDown, IconChevronRight, IconPin, IconPinFilled } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api.ts";
import { Lamp, modelWord, SessionLine, useCall } from "../common.tsx";
import { ago } from "../lib/time.ts";
import { Conversation } from "../session/Conversation.tsx";
import { byUrgency, isMine, useFleet } from "../store/fleet.ts";

const GROUPS: Array<[string, string, SessionRow["state"][]]> = [["wait", "Ждут вас", ["waiting", "failed"]], ["run", "Работают", ["busy", "starting"]], ["idle", "Свободны", ["idle"]], ["down", "Стоят", ["stopped", "stopping"]]];

export function Work() {
  const { callsign } = useParams();
  const go = useNavigate();
  const qc = useQueryClient();
  const picture = useFleet();
  const projects = useCall(peopleList, {});
  const mine = useCall(prefsGet, { scope: "me" });
  const [who, setWho] = useState("mine");
  const [states, setStates] = useState<string[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const [drag, setDrag] = useState<string | null>(null);
  const pins = ((mine.data?.values.pins as string[] | undefined) ?? []);
  const order = ((mine.data?.values.order as string[] | undefined) ?? []);
  const view = ((mine.data?.values.view as { work?: string } | undefined)?.work ?? "list");
  const savePref = async (name: string, value: unknown) => {
    qc.setQueryData(["prefs.get", { scope: "me" }], (old: any) => ({ values: { ...(old?.values ?? {}), [name]: value } }));
    await api.call(prefsSet, { scope: "me", name, value }).catch(() => {});
  };
  const rows = useMemo(() => {
    const rank = (s: SessionRow) => (order.indexOf(s.callsign) + 1 || 1e6);
    return Object.values(picture.sessions)
      .filter((s) => who === "all" || isMine(picture, s))
      .filter((s) => !states.length || GROUPS.some(([id, , st]) => states.includes(id) && st.includes(s.state)))
      .sort((a, b) => Number(pins.includes(b.callsign)) - Number(pins.includes(a.callsign)) || rank(a) - rank(b) || byUrgency(a, b));
  }, [picture.sessions, picture.you, who, states, pins.join(), order.join()]);
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
    void savePref("order", next);
    setDrag(null);
  };
  const pin = (c: string) => savePref("pins", pins.includes(c) ? pins.filter((p) => p !== c) : [...pins, c]);

  return (
    <div className={`panes${callsign ? " has-detail" : ""}`} style={view === "board" && !callsign ? { gridTemplateColumns: "minmax(0,1fr)" } : undefined}>
      <section className="pane list" aria-label="Работа">
        <div className="pane-head">
          <h1>Работа</h1>
          <SegmentedControl size="xs" value={who} onChange={setWho} data={[{ value: "mine", label: "Мои" }, { value: "all", label: "Все" }]} aria-label="Чьи сессии" />
          <SegmentedControl size="xs" value={view} onChange={(v) => savePref("view", { work: v })} data={[{ value: "list", label: "Список" }, { value: "board", label: "Доска" }]} aria-label="Вид" />
          <Chip.Group multiple value={states} onChange={setStates}>
            <Group gap={5} w="100%">{GROUPS.map(([id, word]) => <Chip key={id} value={id} size="xs" variant="outline">{word}</Chip>)}</Group>
          </Chip.Group>
        </div>
        {view === "board" && !callsign ? (
          <div className="board scroll">
            {GROUPS.map(([id, word, st]) => (
              <div key={id} className="col" aria-label={word}>
                <div className="grp" style={{ padding: "4px 6px" }}>{word}</div>
                {rows.filter((s) => st.includes(s.state)).map((s) => (
                  <div key={s.callsign} className="tile" role="button" tabIndex={0} onClick={() => go(`/work/${s.callsign}`)} onKeyDown={(e) => e.key === "Enter" && go(`/work/${s.callsign}`)}>
                    <Group gap={8} wrap="nowrap" align="start"><Lamp state={s.state} /><div style={{ minWidth: 0 }}><div className="t trunc" style={{ fontWeight: 500 }}>{s.title ?? s.spec.name}</div><div className="sub trunc muted mono" style={{ fontSize: 12 }}>{s.callsign}</div></div></Group>
                    {(s.doing || s.ask) && <div className="clamp2 muted" style={{ fontSize: 12.5, marginTop: 4 }}>{s.ask ? (s.ask.kind === "plan" ? "ждёт решения по плану" : s.ask.text) : s.doing}</div>}
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{modelWord(s.spec.model)} · {ago(s.last ?? s.since)}</div>
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
                {!closed.includes(project) && list.map((s) => (
                  <div key={s.callsign} draggable onDragStart={() => setDrag(s.callsign)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(s.callsign)} style={{ position: "relative" }}>
                    <SessionLine s={s} selected={s.callsign === callsign} onPick={() => go(`/work/${s.callsign}`)} sub={<> · {s.ask ? (s.ask.kind === "plan" ? "ждёт решения по плану" : s.ask.text) : s.doing ?? modelWord(s.spec.model)}</>} />
                    <Tooltip label={pins.includes(s.callsign) ? "Открепить" : "Закрепить"}>
                      <ActionIcon size="xs" variant="subtle" aria-label={pins.includes(s.callsign) ? "Открепить" : "Закрепить"} style={{ position: "absolute", right: 10, bottom: 8, opacity: pins.includes(s.callsign) ? 1 : 0.35 }} onClick={() => pin(s.callsign)}>
                        {pins.includes(s.callsign) ? <IconPinFilled size={13} /> : <IconPin size={13} />}
                      </ActionIcon>
                    </Tooltip>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>
      {(view !== "board" || callsign) && (
        <section className="pane detail">
          {callsign ? <Conversation callsign={callsign} onBack={() => go("/work")} /> : <div className="hole wide-only">Выберите сессию слева</div>}
        </section>
      )}
    </div>
  );
}
