// Инспектор сессии: документ, контекст, файлы, точки, журнал.
import { machineJournal, peopleList, pointsList, pointsRaise, pointsSave, sessionCall, sessionUpdate, type SessionRow, type SpecPatch } from "@sb/protocol";
import { Badge, Button, Group, Progress, Select, Stack, Switch, Tabs, Text, TextInput } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { act } from "../api.ts";
import { Failed, personWord, useCall } from "../common.tsx";
import { ago, hhmm, kilo } from "../lib/time.ts";
import { machineOfCall, useFleet } from "../store/fleet.ts";

function Overview({ s }: { s: SessionRow }) {
  const people = useCall(peopleList, {});
  const sessions = useFleet((f) => f.sessions);
  const [cwd, setCwd] = useState(s.spec.cwd);
  const patch = (p: SpecPatch) => act(sessionUpdate, { to: s.callsign, patch: p });
  const mates = Object.keys(sessions).filter((c) => c !== s.callsign && machineOfCall(c) === machineOfCall(s.callsign));
  return (
    <Stack gap="sm" p="md">
      <TextInput label="Папка" className="mono" value={cwd} onChange={(e) => setCwd(e.currentTarget.value)} onBlur={() => cwd !== s.spec.cwd && patch({ cwd })} />
      <Select label="Проект" clearable data={(people.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} value={s.spec.project ?? null} onChange={(v) => patch({ project: v ?? undefined })} />
      <Select label="Ведомый пары" clearable data={mates} value={s.spec.wing ?? null} onChange={(v) => patch({ wing: v ?? undefined })} />
      <Switch label="Сохранять точки в архив" checked={!!s.spec.backup} onChange={(e) => patch({ backup: e.currentTarget.checked })} />
      <Switch label="Открыть в приложении Claude" checked={!!s.spec.remote} onChange={(e) => patch({ remote: e.currentTarget.checked })} />
      {s.remoteUrl && <Text size="sm" component="a" href={s.remoteUrl} target="_blank">{s.remoteUrl}</Text>}
      <dl className="kv">
        <dt>Открыл</dt><dd className="mono">{personWord(s.by)}</dd>
        <dt>Открыта</dt><dd>{ago(s.since)}</dd>
        <dt>Аккаунт</dt><dd>{s.account ?? "—"}</dd>
        {s.spec.parent && <><dt>Задачу дала</dt><dd className="mono">{s.spec.parent}</dd></>}
      </dl>
    </Stack>
  );
}

function Context({ s }: { s: SessionRow }) {
  const usage = useCall(sessionCall, { to: s.callsign, method: "contextUsage" }) as any;
  const mcp = useCall(sessionCall, { to: s.callsign, method: "mcpStatus" }) as any;
  const tasks = useCall(sessionCall, { to: s.callsign, method: "tasks" }, { refetch: 5000 }) as any;
  if (usage.error) return <Failed error={usage.error} retry={usage.refetch} />;
  const u = usage.data;
  return (
    <Stack gap="md" p="md">
      {u && (
        <div>
          <Group justify="space-between" mb={4}><Text size="sm" fw={600}>Контекст</Text><Text size="sm">{kilo(u.used)} из {kilo(u.max)}</Text></Group>
          <Progress value={(u.used / u.max) * 100} color={u.used / u.max > 0.8 ? "red" : "ink"} aria-label="Занятость контекста" />
          <dl className="kv" style={{ marginTop: 8 }}>{(u.parts ?? []).map((p: any) => <span key={p.name} style={{ display: "contents" }}><dt>{p.name}</dt><dd>{kilo(p.tokens)}</dd></span>)}</dl>
          <Button mt="xs" size="xs" variant="default" onClick={() => act(sessionCall, { to: s.callsign, method: "reload" }, "Инструменты перечитаны")}>Перечитать инструменты</Button>
        </div>
      )}
      <div>
        <Text size="sm" fw={600} mb={4}>Серверы MCP</Text>
        <Stack gap={4}>
          {(mcp.data?.servers ?? []).map((m: any) => (
            <Group key={m.name} justify="space-between" wrap="nowrap">
              <span className="mono trunc">{m.name}</span>
              {m.status === "connected" ? <Badge color="teal">{m.tools} инструментов</Badge> : <Group gap={6} wrap="nowrap"><Badge color="red">{m.error ?? m.status}</Badge><Button size="compact-xs" variant="default" onClick={() => act(sessionCall, { to: s.callsign, method: "mcpReconnect", args: { name: m.name } }, "Переподключаю")}>Переподключить</Button></Group>}
            </Group>
          ))}
        </Stack>
      </div>
      {(tasks.data?.tasks ?? []).length > 0 && (
        <div>
          <Text size="sm" fw={600} mb={4}>Фоновые задачи</Text>
          {tasks.data.tasks.map((t: any) => (
            <Group key={t.id} justify="space-between" wrap="nowrap"><span className="mono trunc">{t.desc}</span><Button size="compact-xs" variant="default" onClick={() => act(sessionCall, { to: s.callsign, method: "taskStop", args: { id: t.id } }, "Задача остановлена")}>Остановить</Button></Group>
          ))}
        </div>
      )}
    </Stack>
  );
}

function Files({ s }: { s: SessionRow }) {
  const files = useCall(sessionCall, { to: s.callsign, method: "rewindFiles" }) as any;
  if (files.error) return <Failed error={files.error} retry={files.refetch} />;
  return (
    <Stack gap="xs" p="md">
      {(files.data?.files ?? []).map((f: string) => <span key={f} className="mono trunc">{f}</span>)}
      {files.data?.files?.length > 0 && <Button size="xs" variant="default" onClick={() => act(sessionCall, { to: s.callsign, method: "rewindFiles", args: { apply: true } }, "Файлы возвращены к началу хода")}>Вернуть файлы к началу хода</Button>}
    </Stack>
  );
}

function Points({ s }: { s: SessionRow }) {
  const qc = useQueryClient();
  const list = useCall(pointsList, { machine: machineOfCall(s.callsign) });
  const mine = list.data?.sessions.find((a) => a.callsign === s.callsign);
  const points = useCall(pointsList, mine ? { sid: mine.sid } : null);
  if (list.error) return <Failed error={list.error} retry={list.refetch} />;
  return (
    <Stack gap="xs" p="md">
      <Button size="xs" variant="default" onClick={async () => (await act(pointsSave, { to: s.callsign }, "Точка сохранена")) && qc.invalidateQueries({ queryKey: ["points.list"] })}>Сохранить точку сейчас</Button>
      <div className="timeline">
        {[...(points.data?.points ?? [])].reverse().map((p) => (
          <div key={p.point} className="pt">
            <i />
            <span className="trunc">{hhmm(p.at)} · {p.turns} ходов{p.label ? ` · ${p.label}` : ""}</span>
            <Button size="compact-xs" variant="subtle" onClick={() => mine && act(pointsRaise, { to: "@" + machineOfCall(s.callsign), sid: mine.sid, point: p.point, name: s.spec.name + "-" + p.point }, "Сессия поднята из точки")}>Поднять</Button>
          </div>
        ))}
      </div>
    </Stack>
  );
}

function Journal({ s }: { s: SessionRow }) {
  const j = useCall(machineJournal, { to: "@" + machineOfCall(s.callsign), limit: 30 });
  if (j.error) return <Failed error={j.error} retry={j.refetch} />;
  return (
    <Stack gap={2} p="md">
      {(j.data?.lines ?? []).map((l, i) => (
        <Text key={i} size="xs" className="mono" c={l.level === "error" ? "red" : l.level === "warn" ? "orange" : undefined} style={{ overflowWrap: "anywhere" }}>{hhmm(l.t)} {l.part} · {l.msg}</Text>
      ))}
    </Stack>
  );
}

export function Inspector({ s }: { s: SessionRow }) {
  return (
    <Tabs defaultValue="doc" style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <Tabs.List px="xs">
        <Tabs.Tab value="doc">Обзор</Tabs.Tab>
        <Tabs.Tab value="ctx">Контекст</Tabs.Tab>
        <Tabs.Tab value="files">Файлы</Tabs.Tab>
        <Tabs.Tab value="points">Точки</Tabs.Tab>
        <Tabs.Tab value="log">Журнал</Tabs.Tab>
      </Tabs.List>
      <div className="scroll">
        <Tabs.Panel value="doc"><Overview key={s.callsign} s={s} /></Tabs.Panel>
        <Tabs.Panel value="ctx"><Context s={s} /></Tabs.Panel>
        <Tabs.Panel value="files"><Files s={s} /></Tabs.Panel>
        <Tabs.Panel value="points"><Points s={s} /></Tabs.Panel>
        <Tabs.Panel value="log"><Journal s={s} /></Tabs.Panel>
      </div>
    </Tabs>
  );
}
