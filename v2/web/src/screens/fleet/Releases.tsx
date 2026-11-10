// «Флот → Выпуски»: какая сборка стоит, назначить или откатить, закрепить машину; ход раскатки по машинам.
import { buildsDeploy, buildsList, keeperState, type MachineRow, type OutputOf } from "@sb/protocol";
import { Badge, Button, Group, Menu, Stack, Table, Text } from "@mantine/core";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { act, api } from "../../api.ts";
import { confirmDanger, Failed, useCall } from "../../common.tsx";
import { day, hhmm, nMachines } from "../../lib/time.ts";
import { useFleet } from "../../store/fleet.ts";

type Keeper = OutputOf<typeof keeperState>;
export type RollState = { lamp: "idle" | "busy" | "failed" | "off"; word: string; done: boolean };

/** Состояние машины в раскатке: по её строке картины и ответу Keeper. */
export function rollState(m: Pick<MachineRow, "online" | "build">, target: number, keeper?: Keeper): RollState {
  if (!m.online) return { lamp: "off", word: "без связи — обновится, когда вернётся", done: false };
  if (keeper?.host.state === "failed") return { lamp: "failed", word: `сбой: ${keeper.host.why ?? "Host не запустился"} · Keeper на связи, стоит сборка ${keeper.host.build}`, done: false };
  if ((keeper?.host.build ?? m.build) === target && keeper?.host.state !== "updating") return { lamp: "idle", word: `на сборке ${target}`, done: true };
  if (keeper?.host.state === "updating") return { lamp: "busy", word: `обновляется: Keeper ставит ${target}`, done: false };
  return { lamp: "busy", word: `сборка ${m.build ?? "—"}, ждёт план ${target}`, done: false };
}

function Rollout({ build, machines, onHide }: { build: number; machines: MachineRow[]; onHide: () => void }) {
  // пока раскатка идёт, Keeper каждой машины опрашивается раз в три секунды
  const states = useQueries({ queries: machines.map((m) => ({ queryKey: ["keeper.state", { to: ".keeper@" + m.name }], queryFn: () => api.call(keeperState, { to: ".keeper@" + m.name }), enabled: m.online, refetchInterval: 3000, retry: false })) });
  const rows = machines.map((m, i) => ({ m, s: rollState(m, build, states[i]?.data) }));
  const left = rows.filter((r) => !r.s.done && r.m.online).length;
  const failed = rows.filter((r) => r.s.lamp === "failed").length;
  return (
    <div className="card" role="status" aria-label="Ход раскатки">
      <Group justify="space-between"><Text fw={600}>Раскатка сборки {build}{failed ? ` — сбой на ${nMachines(failed)}` : left ? "" : " закончена"}</Text><Button size="compact-xs" variant="subtle" onClick={onHide}>Скрыть</Button></Group>
      {rows.map(({ m, s }) => (
        <Group key={m.name} gap="sm" wrap="nowrap" align="start">
          <span className={`lamp ${s.lamp}`} />
          <Text size="sm" className="mono" w={90} style={{ flex: "none" }}>{m.name}</Text>
          <Text size="sm" c={s.lamp === "failed" ? "red" : undefined} style={{ minWidth: 0, overflowWrap: "anywhere" }}>{s.word}</Text>
        </Group>
      ))}
    </div>
  );
}

export function Releases() {
  const qc = useQueryClient();
  const machines = useFleet((f) => f.machines);
  const admin = useFleet((f) => !!f.you?.admin);
  const b = useCall(buildsList, {});
  /** идущая раскатка: какая сборка назначена и кому */
  const [roll, setRoll] = useState<{ build: number; machine?: string } | null>(null);
  if (b.error) return <Failed error={b.error} retry={b.refetch} />;
  const stable = b.data?.stable ?? null;
  const pins = b.data?.pins ?? {};
  const all = Object.values(machines).sort((x, y) => x.name.localeCompare(y.name));
  const send = async (build: number | null, machine?: string) => {
    if (!(await act(buildsDeploy, { build, ...(machine ? { machine } : {}) }))) return;
    await qc.invalidateQueries({ queryKey: ["builds.list"] });
    const target = build ?? stable;
    if (target !== null) setRoll({ build: target, ...(machine ? { machine } : {}) });
  };
  /** Назначение и откат сборки — только после подтверждения со списком машин, которых оно коснётся. */
  const deploy = (build: number | null, machine?: string) => {
    const touched = machine ? all.filter((m) => m.name === machine) : all.filter((m) => !(m.name in pins));
    const kept = machine ? [] : all.filter((m) => m.name in pins);
    const down = build !== null && stable !== null && build < stable;
    confirmDanger({
      title: machine ? (build === null ? `Вернуть ${machine} на сборку флота?` : `Закрепить ${machine} на сборке ${build}?`) : `${down ? "Откатить" : "Перевести"} флот на сборку ${build}?`,
      confirm: machine ? (build === null ? "Вернуть" : "Закрепить") : down ? "Откатить флот" : "Назначить флоту",
      body: (
        <>
          <span>Host обновится на {nMachines(touched.length)}; сессии не останавливаются.</span>
          <Stack gap={2}>{touched.map((m) => <span key={m.name}><span className="mono">{m.name}</span> · {m.build ?? "—"} → {build ?? stable ?? "—"}{m.online ? "" : " · без связи, обновится, когда вернётся"}</span>)}</Stack>
          {kept.length > 0 && <span className="muted">Не меняются, закреплены: {kept.map((m) => `${m.name} на ${pins[m.name]}`).join(", ")}</span>}
        </>
      ),
      onConfirm: () => send(build, machine),
    });
  };
  const rolling = roll ? all.filter((m) => (roll.machine ? m.name === roll.machine : !(m.name in pins))) : [];
  return (
    <Stack>
      <Group gap="xl" align="center">
        <Text size="xl" fw={700}>Сборка {stable ?? "—"}</Text>
        <Group gap={6}>{all.map((m) => <Badge key={m.name} variant="default" color={m.build === (pins[m.name] ?? stable) ? undefined : "orange"} className="mono">{m.name}: {m.build ?? "—"}{pins[m.name] ? " · закреплена" : ""}</Badge>)}</Group>
      </Group>
      {roll && <Rollout build={roll.build} machines={rolling} onHide={() => setRoll(null)} />}
      <div className="table-wrap">
        <Table verticalSpacing={8} horizontalSpacing="md" className="stack">
          <Table.Thead><Table.Tr><Table.Th>Сборка</Table.Th><Table.Th>Что в ней</Table.Th><Table.Th>Собрана</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {(b.data?.builds ?? []).map((x) => (
              <Table.Tr key={x.build}>
                <Table.Td data-l="Сборка"><Text fw={x.build === stable ? 700 : 400} span>{x.build}</Text> <Text size="xs" className="mono muted" span>{x.commit}</Text></Table.Td>
                <Table.Td data-l="Что в ней">{x.note}</Table.Td>
                <Table.Td data-l="Собрана" className="muted">{day(x.at)}, {hhmm(x.at)}</Table.Td>
                <Table.Td ta="right">
                  <Group gap={6} justify="flex-end" wrap="wrap">
                    {x.build === stable ? <Badge color="teal">на флоте</Badge> : admin && <Button size="compact-xs" variant={x.build > (stable ?? 0) ? "filled" : "default"} onClick={() => deploy(x.build)}>{x.build > (stable ?? 0) ? "Назначить флоту" : "Откатить флот сюда"}</Button>}
                    {admin && (
                      <Menu withinPortal position="bottom-end">
                        <Menu.Target><Button size="compact-xs" variant="subtle">Закрепить машину</Button></Menu.Target>
                        <Menu.Dropdown>{all.map((m) => <Menu.Item key={m.name} className="mono" onClick={() => deploy(x.build, m.name)}>{m.name}</Menu.Item>)}</Menu.Dropdown>
                      </Menu>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {admin && Object.keys(pins).length > 0 && <Group gap={6}>{Object.entries(pins).map(([m, n]) => <Button key={m} size="compact-xs" variant="default" onClick={() => deploy(null, m)}>Снять закрепление {m} ({n})</Button>)}</Group>}
    </Stack>
  );
}
