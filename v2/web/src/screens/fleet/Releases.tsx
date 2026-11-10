// «Флот → Выпуски»: два вида — «По машинам» (что где стоит, выбор галочками и закрепление пачкой, перезапуск Host) и «Сборки»
// (назначить или откатить флот, закрепить машину); ход раскатки по машинам.
import { buildsDeploy, buildsList, hostRestart, keeperState, type MachineRow, type OutputOf } from "@sb/protocol";
import { Badge, Button, Checkbox, Group, Menu, SegmentedControl, Stack, Table, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { act, api } from "../../api.ts";
import { confirmDanger, Failed, useCall, useMachineName } from "../../common.tsx";
import { useLocal } from "../../lib/local.ts";
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

/** Что изменит закрепление пачкой: по каждой выбранной машине — было и станет. build null — снять закрепление, машина вернётся к сборке флота. */
export function bulkPlan(selected: string[], machines: Array<Pick<MachineRow, "name" | "build" | "online">>, pins: Record<string, number>, stable: number | null, build: number | null) {
  return machines
    .filter((m) => selected.includes(m.name))
    .map((m) => ({ machine: m.name, online: m.online, from: m.build ?? null, to: build ?? stable, pinned: build !== null }))
    // снимать нечего там, где закрепления нет; закреплять незачем там, где оно уже такое
    .filter((x) => (build === null ? x.machine in pins : pins[x.machine] !== build));
}

/** Опрос Keeper машин на связи: пока кто-то обновляется — раз в три секунды, иначе раз в пятнадцать. */
function useKeepers(machines: MachineRow[], fast: boolean) {
  const states = useQueries({ queries: machines.map((m) => ({ queryKey: ["keeper.state", { to: ".keeper@" + m.name }], queryFn: () => api.call(keeperState, { to: ".keeper@" + m.name }), enabled: m.online, refetchInterval: fast ? 3000 : 15_000, retry: false })) });
  return Object.fromEntries(machines.map((m, i) => [m.name, states[i]?.data])) as Record<string, Keeper | undefined>;
}

function Rollout({ build, machines, onHide }: { build: number; machines: MachineRow[]; onHide: () => void }) {
  const keepers = useKeepers(machines, true);
  const rows = machines.map((m) => ({ m, s: rollState(m, build, keepers[m.name]) }));
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
  const go = useNavigate();
  const nameOf = useMachineName();
  const machines = useFleet((f) => f.machines);
  const admin = useFleet((f) => !!f.you?.admin);
  const me = useFleet((f) => f.you?.person);
  const b = useCall(buildsList, {});
  const [view, setView] = useLocal<"machines" | "builds">("releases.view", "machines");
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState("");
  /** идущая раскатка: какая сборка назначена и кому */
  const [roll, setRoll] = useState<{ build: number; machines?: string[] } | null>(null);
  const all = Object.values(machines).sort((x, y) => x.name.localeCompare(y.name));
  const keepers = useKeepers(view === "machines" ? all : [], false);
  if (b.error) return <Failed error={b.error} retry={b.refetch} />;
  const stable = b.data?.stable ?? null;
  const pins = b.data?.pins ?? {};
  const builds = b.data?.builds ?? [];
  const send = async (build: number | null, names?: string[]) => {
    if (names) {
      for (const machine of names) if (!(await act(buildsDeploy, { build, machine }))) break;
    } else if (!(await act(buildsDeploy, { build }))) return;
    await qc.invalidateQueries({ queryKey: ["builds.list"] });
    const target = build ?? stable;
    if (target !== null) setRoll({ build: target, ...(names ? { machines: names } : {}) });
    setPicked([]);
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
      onConfirm: () => send(build, machine ? [machine] : undefined),
    });
  };
  /** Закрепление пачкой выбранных машин. */
  const bulk = (build: number | null) => {
    const plan = bulkPlan(picked, all, pins, stable, build);
    if (!plan.length) return void setPicked([]);
    confirmDanger({
      title: build === null ? `Вернуть ${nMachines(plan.length)} на сборку флота?` : `Закрепить ${nMachines(plan.length)} на сборке ${build}?`,
      confirm: build === null ? "Вернуть" : "Закрепить",
      body: (
        <>
          <span>Host обновится на этих машинах; сессии не останавливаются.</span>
          <Stack gap={2}>{plan.map((x) => <span key={x.machine}><span className="mono">{x.machine}</span> · {x.from ?? "—"} → {x.to ?? "—"}{x.online ? "" : " · без связи, обновится, когда вернётся"}</span>)}</Stack>
        </>
      ),
      onConfirm: () => send(build, plan.map((x) => x.machine)),
    });
  };
  const restart = (m: MachineRow) => confirmDanger({
    title: `Перезапустить Host на ${m.name}?`, confirm: "Перезапустить",
    body: "Keeper остановит Host и запустит его снова на той же сборке. Сессии не останавливаются: их процессы ждут в держателях.",
    onConfirm: async () => { if (await act(hostRestart, { to: ".keeper@" + m.name }, `Host на ${m.name} перезапускается`)) await qc.invalidateQueries({ queryKey: ["keeper.state"] }); },
  });
  const rolling = roll ? all.filter((m) => (roll.machines ? roll.machines.includes(m.name) : !(m.name in pins))) : [];
  const shown = all.filter((m) => !q || m.name.includes(q.toLowerCase()) || nameOf(m.name).toLowerCase().includes(q.toLowerCase()));
  const recent = builds.slice(0, 3);
  const mine = (m: MachineRow) => admin || m.owner === me;
  return (
    <Stack>
      <Group gap="md" align="center" wrap="wrap">
        <Text size="xl" fw={700}>Сборка {stable ?? "—"}</Text>
        <SegmentedControl size="xs" value={view} onChange={(v) => setView(v as "machines" | "builds")} data={[{ value: "machines", label: "По машинам" }, { value: "builds", label: "Сборки" }]} aria-label="Вид выпусков" />
      </Group>
      {roll && <Rollout build={roll.build} machines={rolling} onHide={() => setRoll(null)} />}
      {view === "machines" ? (
        <>
          <Group gap="xs" wrap="wrap">
            <TextInput size="xs" w={200} leftSection={<IconSearch size={14} />} placeholder="Машина" aria-label="Поиск машины" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
            {admin && picked.length > 0 && (
              <>
                <Menu withinPortal>
                  <Menu.Target><Button size="xs">Закрепить выбранные…</Button></Menu.Target>
                  <Menu.Dropdown>{recent.map((x) => <Menu.Item key={x.build} onClick={() => bulk(x.build)}>на сборке {x.build}{x.build === stable ? " — как у флота" : ""}</Menu.Item>)}</Menu.Dropdown>
                </Menu>
                <Button size="xs" variant="default" onClick={() => bulk(null)}>К сборке флота</Button>
                <Button size="xs" variant="subtle" onClick={() => setPicked([])}>Снять выбор</Button>
              </>
            )}
          </Group>
          <div className="table-wrap">
            <Table verticalSpacing={8} horizontalSpacing="md" className="stack">
              <Table.Thead><Table.Tr>
                <Table.Th w={36}>{admin && <Checkbox aria-label="Выбрать все машины" checked={shown.length > 0 && shown.every((m) => picked.includes(m.name))} indeterminate={picked.length > 0 && !shown.every((m) => picked.includes(m.name))} onChange={(e) => setPicked(e.currentTarget.checked ? shown.map((m) => m.name) : [])} />}</Table.Th>
                <Table.Th>Машина</Table.Th><Table.Th>Host</Table.Th><Table.Th>Keeper</Table.Th><Table.Th>Состояние</Table.Th><Table.Th />
              </Table.Tr></Table.Thead>
              <Table.Tbody>
                {shown.map((m) => {
                  const k = keepers[m.name];
                  const target = pins[m.name] ?? stable;
                  const s = target === null ? { lamp: m.online ? "idle" : "off", word: m.online ? "сборка не назначена" : "без связи", done: true } as RollState : rollState(m, target, k);
                  return (
                    <Table.Tr key={m.name}>
                      <Table.Td>{admin && <Checkbox aria-label={`Выбрать ${m.name}`} checked={picked.includes(m.name)} onChange={(e) => setPicked(e.currentTarget.checked ? [...picked, m.name] : picked.filter((x) => x !== m.name))} />}</Table.Td>
                      <Table.Td data-l="Машина"><Text span fw={600} component="button" type="button" className="linklike" onClick={() => go(`/machine/${m.name}`)}>{nameOf(m.name)}</Text></Table.Td>
                      <Table.Td data-l="Host">{k?.host.build ?? m.build ?? "—"}{pins[m.name] !== undefined && <Badge ml={6} size="xs" variant="light" color="orange">закреплена на {pins[m.name]}</Badge>}</Table.Td>
                      <Table.Td data-l="Keeper">{k?.build ?? "—"}</Table.Td>
                      <Table.Td data-l="Состояние"><Group gap={6} wrap="nowrap" align="start" justify="flex-end" style={{ justifyContent: "inherit" }}><span className={`lamp ${s.lamp}`} /><Text size="sm" c={s.lamp === "failed" ? "red" : undefined} style={{ minWidth: 0, overflowWrap: "anywhere" }}>{s.word}</Text></Group></Table.Td>
                      <Table.Td ta="right">
                        <Group gap={6} justify="flex-end" wrap="wrap">
                          {m.online && mine(m) && <Button size="compact-xs" variant={k?.host.state === "failed" ? "filled" : "subtle"} onClick={() => restart(m)}>Перезапустить Host</Button>}
                          {admin && pins[m.name] !== undefined && <Button size="compact-xs" variant="default" onClick={() => deploy(null, m.name)}>Снять закрепление</Button>}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </div>
        </>
      ) : (
        <div className="table-wrap">
          <Table verticalSpacing={8} horizontalSpacing="md" className="stack">
            <Table.Thead><Table.Tr><Table.Th>Сборка</Table.Th><Table.Th>Что в ней</Table.Th><Table.Th>Собрана</Table.Th><Table.Th>Где стоит</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>
              {builds.map((x) => {
                const on = all.filter((m) => m.build === x.build);
                return (
                  <Table.Tr key={x.build}>
                    <Table.Td data-l="Сборка"><Text fw={x.build === stable ? 700 : 400} span>{x.build}</Text> <Text size="xs" className="mono muted" span>{x.commit}</Text></Table.Td>
                    <Table.Td data-l="Что в ней">{x.note}</Table.Td>
                    <Table.Td data-l="Собрана" className="muted">{day(x.at)}, {hhmm(x.at)}</Table.Td>
                    <Table.Td data-l="Где стоит" className="mono" style={{ overflowWrap: "anywhere" }}>{on.map((m) => m.name).join(", ")}</Table.Td>
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
                );
              })}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </Stack>
  );
}
