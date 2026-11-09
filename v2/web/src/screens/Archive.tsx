// «Архив»: каталог сессий с поиском по словам; сессия архива — разговор и линия точек; поднять, копия, удалить.
import { peopleList, pointsDelete, pointsHistory, pointsList, pointsRaise, type ArchSession } from "@sb/protocol";
import { ActionIcon, Button, Group, Loader, Menu, Select, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { IconArrowLeft, IconSearch } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { act } from "../api.ts";
import { fold, type Msg } from "../chat/fold.ts";
import { Failed, modelWord, useCall } from "../common.tsx";
import { ago, day, hhmm, kilo } from "../lib/time.ts";
import { Rows } from "../session/Feed.tsx";
import { useFleet } from "../store/fleet.ts";

/** Найденное слово — подсветкой в строке. */
export function Hit({ text, q }: { text: string; q: string }) {
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
}

function Detail({ s, onBack }: { s: ArchSession; onBack: () => void }) {
  const go = useNavigate();
  const qc = useQueryClient();
  const machines = useFleet((f) => f.machines);
  const points = useCall(pointsList, { sid: s.sid });
  const [point, setPoint] = useState<string | undefined>(undefined);
  const hist = useCall(pointsHistory, { sid: s.sid, ...(point ? { point } : {}) });
  const view = useMemo(() => fold((hist.data?.events ?? []) as Msg[]), [hist.data]);
  const raise = async (machine: string, copy: boolean) => {
    const r = await act(pointsRaise, { to: "@" + machine, sid: s.sid, ...(point ? { point } : {}), ...(copy ? { name: s.callsign.split("@")[0] + "-copy" } : {}) }, "Сессия поднята");
    if (r) go(`/work/${r.callsign}`);
  };
  const online = Object.values(machines).filter((m) => m.online);
  return (
    <>
      <div className="pane-head">
        <ActionIcon variant="subtle" className="narrow-only" aria-label="Назад" onClick={onBack}><IconArrowLeft size={18} /></ActionIcon>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div className="trunc" style={{ fontWeight: 600 }}>{s.title}</div>
          <div className="trunc muted" style={{ fontSize: 12.5 }}><span className="mono">{s.callsign}</span> · {modelWord(s.model)} · {kilo(s.tokens ?? 0)} токенов</div>
        </div>
        <Menu withinPortal position="bottom-end">
          <Menu.Target><Button size="xs">Поднять</Button></Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>На машине</Menu.Label>
            {online.map((m) => <Menu.Item key={m.name} onClick={() => raise(m.name, false)}><span className="mono">{m.name}</span>{m.name === s.machine ? " · здесь" : ""}</Menu.Item>)}
          </Menu.Dropdown>
        </Menu>
        <Menu withinPortal position="bottom-end">
          <Menu.Target><Button size="xs" variant="default">Копия</Button></Menu.Target>
          <Menu.Dropdown>{online.map((m) => <Menu.Item key={m.name} onClick={() => raise(m.name, true)}><span className="mono">{m.name}</span></Menu.Item>)}</Menu.Dropdown>
        </Menu>
        <Button size="xs" variant="subtle" color="red" onClick={() => modals.openConfirmModal({ title: "Удалить сессию из архива?", children: <Text size="sm">Все её точки будут удалены. Вернуть нельзя.</Text>, labels: { confirm: "Удалить", cancel: "Оставить" }, confirmProps: { color: "red" }, onConfirm: async () => { if (await act(pointsDelete, { sid: s.sid }, "Удалено")) { await qc.invalidateQueries({ queryKey: ["points.list"] }); onBack(); } } })}>Удалить</Button>
      </div>
      <div className="talk with-insp" style={{ flex: 1 }}>
        <div className="feed"><div className="feed-in">{hist.isLoading ? <Loader size="sm" style={{ alignSelf: "center" }} /> : hist.error ? <Failed error={hist.error} retry={hist.refetch} /> : <Rows rows={view.rows} view={view} />}</div></div>
        <aside className="insp" aria-label="Точки">
          <div className="grp">Точки</div>
          <div className="timeline scroll" style={{ padding: "0 8px 12px" }}>
            {[...(points.data?.points ?? [])].reverse().map((p, i) => (
              <div key={p.point} className={`pt${(point ?? points.data?.points?.at(-1)?.point) === p.point ? " sel" : ""}`} role="button" tabIndex={0} onClick={() => setPoint(i === 0 ? undefined : p.point)} onKeyDown={(e) => e.key === "Enter" && setPoint(i === 0 ? undefined : p.point)}>
                <i />
                <span className="trunc">{day(p.at)}, {hhmm(p.at)}{p.label ? ` · ${p.label}` : ""}</span>
                <span className="muted">{p.turns} ходов</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}

export function Archive() {
  const { sid } = useParams();
  const go = useNavigate();
  const machines = useFleet((f) => f.machines);
  const projects = useCall(peopleList, {});
  const [q, setQ] = useState("");
  const [machine, setMachine] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [term] = useDebouncedValue(q.trim(), 250);
  const list = useCall(pointsList, { ...(term ? { q: term } : {}), ...(machine ? { machine } : {}) });
  const rows = (list.data?.sessions ?? []).filter((s) => !project || s.project === project);
  const picked = rows.find((s) => s.sid === sid) ?? list.data?.sessions.find((s) => s.sid === sid);
  return (
    <div className={`panes${sid ? " has-detail" : ""}`}>
      <section className="pane list" aria-label="Архив">
        <div className="pane-head">
          <h1>Архив</h1>
          <TextInput w="100%" size="sm" leftSection={<IconSearch size={15} />} placeholder="Слова из разговора" aria-label="Поиск по архиву" value={q} onChange={(e) => setQ(e.currentTarget.value)} autoFocus={!sid} />
          <Group gap={6} w="100%" wrap="nowrap">
            <Select size="xs" clearable placeholder="Машина" aria-label="Машина" data={Object.keys(machines)} value={machine} onChange={setMachine} style={{ flex: 1 }} />
            <Select size="xs" clearable placeholder="Проект" aria-label="Проект" data={(projects.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} value={project} onChange={setProject} style={{ flex: 1 }} />
          </Group>
        </div>
        <div className="scroll">
          {list.error ? <Failed error={list.error} retry={list.refetch} /> : !rows.length && !list.isLoading ? <div className="hole" style={{ height: "50%" }}>{term ? `Ничего не нашлось по «${term}»` : "В архиве пусто"}</div> : null}
          {rows.map((s) => (
            <div key={s.sid} className={`row${s.sid === sid ? " sel" : ""}`} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }} role="button" tabIndex={0} onClick={() => go(`/archive/${s.sid}`)} onKeyDown={(e) => e.key === "Enter" && go(`/archive/${s.sid}`)}>
              <div style={{ minWidth: 0 }}>
                <div className="t trunc"><Hit text={s.title ?? s.callsign} q={term} /></div>
                <div className="sub trunc"><span className="mono">{s.callsign}</span> · {s.points} точек</div>
                {s.hit && s.hit !== s.title && <div className="sub clamp2" style={{ marginTop: 3, color: "var(--mantine-color-text)" }}><Hit text={s.hit} q={term} /></div>}
              </div>
              <span className="when">{ago(s.last)}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="pane detail">
        {picked ? <Detail key={picked.sid} s={picked} onBack={() => go("/archive")} /> : <div className="hole wide-only">Выберите сессию архива</div>}
      </section>
    </div>
  );
}
