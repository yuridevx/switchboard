// «Пожар»: машина без связи — её сессии поднимаются на другой машине из последних точек архива.
import { pointsList, pointsRaise, type ArchSession } from "@sb/protocol";
import { Button, Checkbox, Group, Select, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { api, sayError } from "../../api.ts";
import { Failed, useCall, useMachineName } from "../../common.tsx";
import { ago, nSessions } from "../../lib/time.ts";
import { useFleet } from "../../store/fleet.ts";

export type FireRow = { s: ArchSession; state: "wait" | "run" | "done" | "failed"; word?: string };

/** Что поднимать: сессии архива машины, которые стояли на ней, когда она ушла (есть в последней картине). */
export function fireList(archive: ArchSession[], stood: string[]): ArchSession[] {
  return archive.filter((a) => stood.includes(a.callsign)).sort((a, b) => b.last - a.last);
}

/** Поднять по одной: сбой одной сессии не останавливает остальные. */
export async function fireRun(list: ArchSession[], raise: (s: ArchSession) => Promise<string>, on: (rows: FireRow[]) => void): Promise<FireRow[]> {
  const rows: FireRow[] = list.map((s) => ({ s, state: "wait" }));
  for (const r of rows) {
    r.state = "run";
    on([...rows]);
    try {
      r.word = await raise(r.s);
      r.state = "done";
    } catch (e) {
      r.state = "failed";
      r.word = sayError(e);
    }
    on([...rows]);
  }
  return rows;
}

export function Fire({ machine, onClose }: { machine: string; onClose: () => void }) {
  const machines = useFleet((f) => f.machines);
  const sessions = useFleet((f) => f.sessions);
  const nameOf = useMachineName();
  const online = Object.values(machines).filter((m) => m.online).map((m) => m.name);
  const [target, setTarget] = useState<string | null>(online[0] ?? null);
  const arch = useCall(pointsList, { machine });
  const stood = Object.keys(sessions).filter((c) => c.endsWith("@" + machine));
  const list = fireList(arch.data?.sessions ?? [], stood);
  const [off, setOff] = useState<string[]>([]);
  const [rows, setRows] = useState<FireRow[] | null>(null);
  if (arch.error) return <Failed error={arch.error} retry={arch.refetch} />;
  const picked = list.filter((s) => !off.includes(s.sid));
  const lost = stood.filter((c) => !list.some((s) => s.callsign === c));
  if (rows) return (
    <Stack gap="sm">
      <div className="steps" role="status" aria-label="Ход подъёма">
        {rows.map((r) => (
          <div key={r.s.sid} className="step">
            <span className={`lamp ${r.state === "done" ? "idle" : r.state === "run" ? "busy" : r.state === "failed" ? "failed" : "off"}`} />
            <span style={{ minWidth: 0 }}><span className="mono">{r.s.callsign}</span>{r.state === "done" ? <> → <span className="mono">{r.word}</span></> : r.state === "failed" ? <Text size="sm" c="red">{r.word}</Text> : null}</span>
          </div>
        ))}
      </div>
      {rows.every((r) => r.state === "done" || r.state === "failed") && <Button w="fit-content" onClick={onClose}>Готово</Button>}
    </Stack>
  );
  return (
    <Stack gap="sm">
      <Text size="sm">Сессии <span className="mono">{machine}</span> продолжатся на другой машине с последней точки архива. Сделанное после точки осталось на {machine}; когда она вернётся, её сессии надо будет убрать руками.</Text>
      <Select label="Поднять на машине" data={online.map((m) => ({ value: m, label: nameOf(m) }))} value={target} onChange={setTarget} allowDeselect={false} error={!online.length ? "Машин на связи нет" : undefined} />
      {list.map((s) => (
        <Checkbox key={s.sid} checked={!off.includes(s.sid)} onChange={(e) => setOff(e.currentTarget.checked ? off.filter((x) => x !== s.sid) : [...off, s.sid])}
          label={<span><span className="mono">{s.callsign}</span> · {s.title} <span className="muted">· точка {ago(s.last)}</span></span>} />
      ))}
      {!list.length && arch.data && <Text size="sm" className="muted">В архиве нет точек сессий этой машины</Text>}
      {lost.length > 0 && <Text size="sm" c="orange">Без точек в архиве, поднять нечего: <span className="mono">{lost.join(", ")}</span></Text>}
      <Group>
        <Button color="red" disabled={!target || !picked.length} onClick={() => target && void fireRun(picked, async (s) => (await api.call(pointsRaise, { to: "@" + target, sid: s.sid, move: true })).callsign ?? "", setRows)}>Поднять {nSessions(picked.length)}</Button>
        <Button variant="default" onClick={onClose}>Отмена</Button>
      </Group>
    </Stack>
  );
}
