// Машина: одно место, где видно всё, что о ней известно — связь, сборка, её сессии, события флота о ней и строки её журнала.
// Без связи — последнее известное. Сюда ведут строка «Вам», карточка «Флота» и палитра.
import { keeperState, ledgerRead, machineJournal } from "@sb/protocol";
import { ActionIcon, Badge, Button, Group, Stack, Text } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { useNavigate, useParams } from "react-router";
import { personWord, SessionLine, useCall, useUi } from "../common.tsx";
import { ago, day, hhmm } from "../lib/time.ts";
import { byUrgency, machineOfCall, useFleet } from "../store/fleet.ts";

const HOST: Record<string, string> = { running: "работает", stopped: "остановлен", failed: "сбой", updating: "обновляется" };

export function Machine() {
  const { name = "" } = useParams();
  const go = useNavigate();
  const ui = useUi();
  const m = useFleet((f) => f.machines[name]);
  const sessions = useFleet((f) => f.sessions);
  const keeper = useCall(keeperState, m?.online ? { to: ".keeper@" + name } : null);
  const events = useCall(ledgerRead, { machine: name, limit: 20 });
  const journal = useCall(machineJournal, m?.online ? { to: "@" + name, limit: 30 } : null);
  if (!m) return <div className="hole">Такой машины нет: <span className="mono">&nbsp;{name}</span></div>;
  const here = Object.values(sessions).filter((s) => machineOfCall(s.callsign) === name).sort(byUrgency);
  return (
    <div className="scroll">
      <div className="page">
        <Group gap="sm" mb="md" wrap="nowrap">
          <ActionIcon variant="subtle" aria-label="К машинам" onClick={() => go("/fleet/machines")}><IconArrowLeft size={18} /></ActionIcon>
          <span className={`lamp ${m.online ? "idle" : "off"}`} style={{ marginTop: 0 }} />
          <h1 style={{ fontSize: 20, margin: 0 }} className="mono">{m.name}</h1>
          <Text c={m.online ? undefined : "red"}>{m.online ? `на связи ${ago(m.since) === "сейчас" ? "только что" : ago(m.since)}` : `без связи с ${day(m.since)}, ${hhmm(m.since)}`}</Text>
          <div style={{ flex: 1 }} />
          {m.online && <Button size="xs" onClick={() => ui.set({ newOpen: true, newPreset: { machine: m.name } })}>Новая сессия</Button>}
        </Group>
        <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", alignItems: "start" }}>
          <div className="card">
            <Text fw={600}>{m.online ? "Сейчас" : "Последнее известное"}</Text>
            <dl className="kv">
              <dt>Владелец</dt><dd>{personWord(m.owner)}</dd>
              <dt>Сборка</dt><dd>{m.build ?? "—"}</dd>
              <dt>Система</dt><dd>{m.os ?? "—"}</dd>
              {m.sdk && <><dt>SDK</dt><dd className="mono">{m.sdk}</dd></>}
              {m.online && <><dt>Host</dt><dd>{keeper.data ? `${HOST[keeper.data.host.state] ?? keeper.data.host.state}${keeper.data.host.why ? `: ${keeper.data.host.why}` : ""}` : keeper.error ? "Keeper не отвечает" : "…"}</dd></>}
            </dl>
          </div>
          <div className="card" style={{ padding: "14px 0 6px" }}>
            <Text fw={600} px={14}>{m.online ? "Сессии" : "Что на ней стояло"}</Text>
            {here.map((s) => <SessionLine key={s.callsign} s={s} onPick={() => go(`/work/${s.callsign}`)} />)}
            {!here.length && <Text size="sm" className="muted" px={14} pb={8}>Сессий нет</Text>}
          </div>
          <div className="card">
            <Text fw={600}>События флота</Text>
            <Stack gap={6}>
              {(events.data?.events ?? []).map((e) => (
                <Group key={e.id} gap="sm" wrap="nowrap" align="start">
                  <Text size="xs" className="muted" style={{ whiteSpace: "nowrap", paddingTop: 2 }}>{day(e.at)}, {hhmm(e.at)}</Text>
                  <Text size="sm" style={{ minWidth: 0, overflowWrap: "anywhere" }}>{e.text}</Text>
                </Group>
              ))}
              {events.data && !events.data.events.length && <Text size="sm" className="muted">Событий нет</Text>}
            </Stack>
          </div>
          {m.online && (
            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <Group justify="space-between"><Text fw={600}>Журнал машины</Text><Button size="compact-xs" variant="subtle" onClick={() => go(`/observe/machine?m=${m.name}`)}>Весь журнал</Button></Group>
              <div>
                {(journal.data?.lines ?? []).map((l, i) => (
                  <Text key={i} size="xs" className="mono" c={l.level === "error" ? "red" : l.level === "warn" ? "orange" : undefined} style={{ overflowWrap: "anywhere", padding: "2px 0" }}>{hhmm(l.t)} {l.part} · {l.msg}</Text>
                ))}
              </div>
            </div>
          )}
          {!m.online && <div className="card off"><Badge color="red" w="fit-content">нет связи</Badge><Text size="sm">Журнал машины и управление её сессиями вернутся вместе со связью. Разговоры сессий есть в архиве до последней сохранённой точки.</Text><Button size="xs" variant="default" w="fit-content" onClick={() => go("/archive")}>Открыть архив</Button></div>}
        </div>
      </div>
    </div>
  );
}
