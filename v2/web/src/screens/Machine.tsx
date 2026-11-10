// Машина: одно место, где видно всё, что о ней известно — связь, сборки Host и Keeper, её сессии, события флота о ней и строки её журнала.
// Без связи — последнее известное и «пожар»: поднять её сессии на другой машине. Сюда ведут строка «Вам», карточка «Флота» и палитра.
import { keeperState, ledgerRead, machineJournal, machineMetrics } from "@sb/protocol";
import { ActionIcon, Badge, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { partWord, personWord, SessionLine, useCall, useMachineName, useUi } from "../common.tsx";
import { HostNumbers, HostSeries } from "../lib/metrics.tsx";
import { ago, day, hhmm, nSessions } from "../lib/time.ts";
import { byUrgency, machineOfCall, useFleet } from "../store/fleet.ts";
import { Fire } from "./archive/Fire.tsx";
import { fireCount, HOST_WORD } from "./fleet/Machines.tsx";
import { journalWord } from "./Observe.tsx";

export function Machine() {
  const { name = "" } = useParams();
  const go = useNavigate();
  const ui = useUi();
  const nameOf = useMachineName();
  const m = useFleet((f) => f.machines[name]);
  const sessions = useFleet((f) => f.sessions);
  const others = useFleet((f) => Object.values(f.machines).some((x) => x.online && x.name !== name));
  const [fire, setFire] = useState(false);
  const keeper = useCall(keeperState, m?.online ? { to: ".keeper@" + name } : null, { refetch: 15_000 });
  const events = useCall(ledgerRead, { machine: name, limit: 20 });
  const journal = useCall(machineJournal, m?.online ? { to: "@" + name, limit: 30 } : null);
  // числа Host: последнее окно — у самой машины; машина на старой сборке запроса не знает — блока нет
  const metrics = useCall(machineMetrics, m?.online ? { to: "@" + name } : null, { refetch: 60_000 });
  if (!m) return <div className="hole">Такой машины нет: <span className="mono">&nbsp;{name}</span></div>;
  const here = Object.values(sessions).filter((s) => machineOfCall(s.callsign) === name).sort(byUrgency);
  const k = keeper.data;
  const burning = fireCount(m, here);
  return (
    <div className="scroll">
      <div className="page">
        <Group gap="sm" mb="md" wrap="wrap">
          <ActionIcon variant="subtle" aria-label="К машинам" onClick={() => go("/fleet/machines")}><IconArrowLeft size={18} /></ActionIcon>
          <span className={`lamp ${m.online ? "idle" : "off"}`} style={{ marginTop: 0 }} />
          <h1 style={{ fontSize: 20, margin: 0 }}>{nameOf(m.name)}</h1>
          {nameOf(m.name) !== m.name && <Text className="mono muted">{m.name}</Text>}
          <Text c={m.online ? undefined : "red"}>{m.online ? `на связи ${ago(m.since) === "сейчас" ? "только что" : ago(m.since)}` : `без связи с ${day(m.since)}, ${hhmm(m.since)}`}</Text>
          <div style={{ flex: 1 }} />
          {m.online && <Button size="xs" onClick={() => ui.set({ newOpen: true, newPreset: { machine: m.name } })}>Новая сессия</Button>}
          {burning > 0 && <Badge color="red" variant="light">пожар: {nSessions(burning)} ждут на точках архива</Badge>}
          {!m.online && here.length > 0 && others && <Button size="xs" color="red" variant="light" onClick={() => setFire(true)}>Поднять её сессии на другой машине</Button>}
        </Group>
        <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", alignItems: "start" }}>
          <div className="card">
            <Text fw={600}>{m.online ? "Сейчас" : "Последнее известное"}</Text>
            <dl className="kv">
              <dt>Владелец</dt><dd>{personWord(m.owner)}</dd>
              <dt>Host</dt><dd>{m.online && k ? `сборка ${k.host.build} · ${HOST_WORD[k.host.state] ?? k.host.state}${k.host.why ? `: ${k.host.why}` : ""}${k.host.since ? ` · с ${hhmm(k.host.since)}` : ""}` : `сборка ${m.build ?? "—"}`}</dd>
              <dt>Keeper</dt><dd>{!m.online ? (m.keeper === false ? "не на связи" : "—") : k ? `сборка ${k.build}` : keeper.error ? "не отвечает" : "…"}</dd>
              {m.online && k?.host.pid !== undefined && <><dt>Процесс Host</dt><dd className="mono">pid {k.host.pid}</dd></>}
              {m.online && k?.pid !== undefined && <><dt>Процесс Keeper</dt><dd className="mono">pid {k.pid}</dd></>}
              {m.online && k?.plan !== undefined && <><dt>План</dt><dd>сборка {k.plan}{k.plan !== k.host.build ? " — ещё не исполнен" : ""}</dd></>}
              <dt>Система</dt><dd>{k?.os ?? m.os ?? "—"}</dd>
              {m.sdk && <><dt>SDK</dt><dd className="mono">{m.sdk}</dd></>}
            </dl>
            <Button size="compact-xs" variant="subtle" w="fit-content" onClick={() => go("/fleet/releases")}>План в «Выпусках»</Button>
          </div>
          {m.online && metrics.data && (
            <div className="card">
              <Text fw={600}>Числа Host</Text>
              <HostNumbers m={metrics.data} />
            </div>
          )}
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
          <div style={{ gridColumn: "1 / -1" }}><HostSeries machine={m.name} /></div>
          {m.online && (
            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <Group justify="space-between"><Text fw={600}>Журнал машины</Text><Button size="compact-xs" variant="subtle" onClick={() => go(`/observe/machine?m=${m.name}`)}>Весь журнал</Button></Group>
              <div>
                {(journal.data?.lines ?? []).map((l, i) => (
                  <Text key={i} size="xs" className="mono" c={l.level === "error" ? "red" : l.level === "warn" ? "orange" : undefined} style={{ overflowWrap: "anywhere", padding: "2px 0" }}>{hhmm(l.t)} {partWord(l.part)} · {journalWord(l)}</Text>
                ))}
              </div>
            </div>
          )}
          {!m.online && <div className="card off"><Badge color="red" w="fit-content">нет связи</Badge><Text size="sm">Журнал машины и управление её сессиями вернутся вместе со связью. Разговоры сессий есть в архиве до последней сохранённой точки.</Text><Button size="xs" variant="default" w="fit-content" onClick={() => go("/archive")}>Открыть архив</Button></div>}
        </div>
      </div>
      <Modal opened={fire} onClose={() => setFire(false)} title={`Поднять сессии ${m.name} на другой машине`} size="lg"><Fire machine={m.name} onClose={() => setFire(false)} /></Modal>
    </div>
  );
}
