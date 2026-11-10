// «Флот»: машины, аккаунты, профили, выпуски, инциденты.
import {
  accountCode, accountList, accountLogin, accountRemove, buildsDeploy, buildsList, incidentList, invite, keeperState, keyCheck, keysList, keysRemove, keysSet,
  profileList, profileView, slotSet, type Account, type MachineRow,
} from "@sb/protocol";
import { ActionIcon, Badge, Button, Checkbox, CopyButton, Group, Menu, Modal, PasswordInput, Progress, Select, Stack, Table, Tabs, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowDown, IconArrowUp, IconDots } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { act, fleetBase } from "../api.ts";
import { confirmDanger, Failed, personWord, useCall, useUi, useWide } from "../common.tsx";
import { ago, day, hhmm, LIMIT_NAMES, nMachines } from "../lib/time.ts";
import { machineOfCall, useFleet } from "../store/fleet.ts";

export function TabsPage({ title, base, tabs }: { title: string; base: string; tabs: Array<[string, string, () => React.ReactNode]> }) {
  const { tab } = useParams();
  const go = useNavigate();
  const now = tabs.find(([id]) => id === tab) ?? tabs[0];
  const wide = useWide();
  return (
    <div className="scroll">
      <div className="page">
        <h1 style={{ fontSize: 20, margin: "0 0 10px" }}>{title}</h1>
        {wide ? (
          <Tabs value={now[0]} onChange={(v) => v && go(`${base}/${v}`)}>
            <Tabs.List mb="md">{tabs.map(([id, word]) => <Tabs.Tab key={id} value={id}>{word}</Tabs.Tab>)}</Tabs.List>
          </Tabs>
        ) : (
          // на телефоне вкладки не помещаются в ряд: раздел выбирается из списка
          <Select mb="md" aria-label="Раздел" allowDeselect={false} data={tabs.map(([value, label]) => ({ value, label }))} value={now[0]} onChange={(v) => v && go(`${base}/${v}`)} />
        )}
        {now[2]()}
      </div>
    </div>
  );
}

function AddMachine({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [made, setMade] = useState("");
  const base = fleetBase || "https://fleet.example.com";
  const cmd = `keeper install --base ${base}`;
  return (
    <Stack gap="sm">
      {!made ? (
        <>
          <TextInput label="Имя машины" placeholder="laptop" className="mono" value={name} onChange={(e) => setName(e.currentTarget.value.toLowerCase())} autoFocus />
          <Button disabled={!/^[a-z0-9][a-z0-9_-]*$/.test(name)} onClick={async () => { const r = await act(invite, { addr: "@" + name }); if (r) setMade(r.invite); }}>Выдать приглашение</Button>
        </>
      ) : (
        <>
          <Text size="sm">На машине <span className="mono">{name}</span> выполните команду и вставьте приглашение, когда она попросит. Приглашение действует сутки.</Text>
          <pre className="mono" style={{ background: "var(--surface-2)", padding: 10, borderRadius: 6, margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{cmd}</pre>
          <pre className="mono" style={{ background: "var(--surface-2)", padding: 10, borderRadius: 6, margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{made}</pre>
          <Group>
            <CopyButton value={cmd}>{({ copied, copy }) => <Button size="xs" variant="default" onClick={copy}>{copied ? "Команда скопирована" : "Скопировать команду"}</Button>}</CopyButton>
            <CopyButton value={made}>{({ copied, copy }) => <Button size="xs" variant="default" onClick={copy}>{copied ? "Приглашение скопировано" : "Скопировать приглашение"}</Button>}</CopyButton>
            <Button size="xs" onClick={onClose}>Готово</Button>
          </Group>
        </>
      )}
    </Stack>
  );
}

function MachineCard({ m }: { m: MachineRow }) {
  const go = useNavigate();
  const sessions = useFleet((f) => f.sessions);
  const ui = useUi();
  const keeper = useCall(keeperState, m.online ? { to: ".keeper@" + m.name } : null);
  const here = Object.values(sessions).filter((s) => machineOfCall(s.callsign) === m.name);
  return (
    <div className={`card${m.online ? "" : " off"}`}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap={8} wrap="nowrap"><span className={`lamp ${m.online ? "idle" : "off"}`} style={{ marginTop: 0 }} /><Text fw={600} className="mono" component="button" type="button" style={{ border: 0, background: "none", padding: 0, cursor: "pointer", color: "inherit", textDecoration: "underline dotted", textUnderlineOffset: 3 }} onClick={() => go(`/machine/${m.name}`)}>{m.name}</Text></Group>
        <Text size="sm" c={m.online ? undefined : "red"}>{m.online ? "на связи" : `без связи ${ago(m.since)}`}</Text>
      </Group>
      <dl className="kv">
        <dt>Владелец</dt><dd>{personWord(m.owner)}</dd>
        <dt>Сборка</dt><dd>{m.build ?? "—"}</dd>
        <dt>Система</dt><dd>{m.os ?? "—"}</dd>
        <dt>Host</dt><dd>{!m.online ? "неизвестно" : keeper.data ? (keeper.data.host.state === "running" ? "работает" : keeper.data.host.state === "failed" ? `сбой: ${keeper.data.host.why ?? ""}` : keeper.data.host.state) : "…"}</dd>
      </dl>
      <Group gap={4}>{here.map((s) => <Badge key={s.callsign} variant="default" className="mono" component="button" type="button" style={{ cursor: "pointer" }} onClick={() => go(`/work/${s.callsign}`)}>{s.spec.name}</Badge>)}</Group>
      <Group gap={6} mt="auto">
        <Button size="compact-xs" variant="default" disabled={!m.online} onClick={() => ui.set({ newOpen: true, newPreset: { machine: m.name } })}>Новая сессия</Button>
        <Button size="compact-xs" variant="subtle" onClick={() => go(`/machine/${m.name}`)}>{m.online ? "Подробнее" : "Что известно"}</Button>
      </Group>
    </div>
  );
}

function Machines() {
  const machines = useFleet((f) => f.machines);
  const [add, setAdd] = useState(false);
  return (
    <Stack>
      <Button w="fit-content" size="xs" onClick={() => setAdd(true)}>Добавить машину</Button>
      <div className="cards">{Object.values(machines).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)).map((m) => <MachineCard key={m.name} m={m} />)}</div>
      <Modal opened={add} onClose={() => setAdd(false)} title="Добавить машину"><AddMachine onClose={() => setAdd(false)} /></Modal>
    </Stack>
  );
}

function Login({ machine, onDone }: { machine: string; onDone: (account?: string) => void }) {
  const [step, setStep] = useState<{ login: string; url: string } | null>(null);
  const [code, setCode] = useState("");
  const qc = useQueryClient();
  if (!step) return <Button onClick={async () => { const r = await act(accountLogin, { to: "@" + machine }); if (r) setStep(r); }}>Получить ссылку входа</Button>;
  return (
    <Stack gap="sm">
      <Button component="a" href={step.url} target="_blank" rel="noreferrer" variant="default">Открыть страницу входа Claude</Button>
      <TextInput label="Код со страницы входа" className="mono" value={code} onChange={(e) => setCode(e.currentTarget.value)} autoFocus />
      <Button disabled={!code.trim()} onClick={async () => { const r = await act(accountCode, { to: "@" + machine, login: step.login, code: code.trim() }); if (r) { notifications.show({ message: `Вход выполнен: ${r.account.email ?? r.account.id} на ${machine}`, color: "teal" }); await qc.invalidateQueries({ queryKey: ["account.list"] }); onDone(r.account.id); } }}>Войти</Button>
    </Stack>
  );
}

function AccountsOf({ machine }: { machine: string }) {
  const qc = useQueryClient();
  const list = useCall(accountList, { to: "@" + machine });
  const [login, setLogin] = useState(false);
  const [fresh, setFresh] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["account.list"] });
  if (list.error) return <Failed error={list.error} retry={list.refetch} />;
  const accounts = list.data?.accounts ?? [];
  const order = accounts.filter((a) => a.kind === "claude").map((a) => a.id);
  const shift = async (a: Account, d: number) => {
    const next = [...order], i = next.indexOf(a.id);
    [next[i], next[i + d]] = [next[i + d], next[i]];
    if (await act(slotSet, { to: "@" + machine, order: next })) refresh();
  };
  return (
    <div className="card">
      <Group justify="space-between"><Text fw={600} className="mono">{machine}</Text><Button size="compact-xs" variant="default" onClick={() => setLogin(true)}>Войти в аккаунт Claude</Button></Group>
      {accounts.map((a) => (
        <Group key={a.id} gap="sm" wrap="nowrap" align="center" className={a.id === fresh ? "fresh" : undefined} style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
          {a.kind === "claude" && <Stack gap={0}><ActionIcon size="xs" variant="subtle" aria-label="Выше в очереди" disabled={order.indexOf(a.id) === 0} onClick={() => shift(a, -1)}><IconArrowUp size={12} /></ActionIcon><ActionIcon size="xs" variant="subtle" aria-label="Ниже в очереди" disabled={order.indexOf(a.id) === order.length - 1} onClick={() => shift(a, 1)}><IconArrowDown size={12} /></ActionIcon></Stack>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <Group gap={6} wrap="nowrap"><Text size="sm" fw={500} className="trunc">{a.email ?? a.id}</Text>{a.kind === "key" ? <Badge variant="default">ключ флота</Badge> : <Text size="xs" className="muted">{a.plan}</Text>}</Group>
            {!a.ok && <Group gap={8}><Text size="xs" c="red">{a.why}</Text>{a.kind === "claude" && <Button size="compact-xs" variant="default" onClick={() => setLogin(true)}>Войти заново</Button>}</Group>}
            {a.limits?.map((l) => (
              <Group key={l.name} gap={8} wrap="nowrap" mt={3}>
                <Text size="xs" className="muted" w={58}>{LIMIT_NAMES[l.name] ?? l.name}</Text>
                <Progress value={l.used * 100} color={l.used > 0.9 ? "red" : l.used > 0.7 ? "orange" : "teal"} style={{ flex: 1 }} aria-label={`${LIMIT_NAMES[l.name] ?? l.name}: ${Math.round(l.used * 100)}%`} />
                <Text size="xs" w={92} ta="right">{Math.round(l.used * 100)}%{l.resets ? ` · до ${hhmm(l.resets)}` : ""}</Text>
              </Group>
            ))}
          </div>
          <Menu withinPortal position="bottom-end">
            <Menu.Target><ActionIcon variant="subtle" aria-label="Ещё"><IconDots size={16} /></ActionIcon></Menu.Target>
            <Menu.Dropdown>
              {a.kind === "key" && <Menu.Item onClick={() => act(keyCheck, { to: "@" + machine, name: a.id }).then((r) => r && notifications.show({ message: r.word, color: r.ok ? "teal" : "red" }))}>Проверить ключ</Menu.Item>}
              <Menu.Item color="red" onClick={() => confirmDanger({ title: `Убрать ${a.email ?? a.id} с ${machine}?`, body: a.sessions ? `На нём идут сессии: ${a.sessions}. Они перейдут на другой аккаунт очереди или остановятся.` : "Вход на этой машине будет стёрт.", confirm: "Убрать", onConfirm: async () => (await act(accountRemove, { to: "@" + machine, account: a.id }, "Аккаунт убран")) && refresh() })}>Убрать с машины</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      ))}
      {!accounts.length && <Text size="sm" className="muted">Входов нет</Text>}
      <Modal opened={login} onClose={() => setLogin(false)} title={`Вход Claude на ${machine}`}><Login machine={machine} onDone={(id) => (setLogin(false), setFresh(id ?? ""))} /></Modal>
    </div>
  );
}

function FleetKeys() {
  const qc = useQueryClient();
  const keys = useCall(keysList, {});
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ name: "", provider: "openai-compatible", value: "", base: "", model: "" });
  const refresh = () => qc.invalidateQueries({ queryKey: ["keys.list"] });
  return (
    <div className="card">
      <Group justify="space-between"><Text fw={600}>Ключи флота</Text><Button size="compact-xs" variant="default" onClick={() => setAdd(true)}>Добавить ключ</Button></Group>
      {(keys.data?.keys ?? []).map((k) => (
        <Group key={k.name} justify="space-between" wrap="nowrap" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
          <div style={{ minWidth: 0 }}><Text size="sm" fw={500} className="mono trunc">{k.name}</Text><Text size="xs" className="muted trunc">{k.provider}{k.model ? ` · ${k.model}` : ""} · {k.tail}</Text></div>
          <Button size="compact-xs" variant="subtle" color="red" onClick={() => confirmDanger({ title: `Убрать ключ ${k.name}?`, body: "Сессии на этом ключе не смогут обращаться к модели.", confirm: "Убрать", onConfirm: async () => (await act(keysRemove, { name: k.name }, "Ключ убран")) && refresh() })}>Убрать</Button>
        </Group>
      ))}
      <Modal opened={add} onClose={() => setAdd(false)} title="Ключ флота">
        <Stack gap="sm">
          <TextInput label="Имя" className="mono" value={f.name} onChange={(e) => setF({ ...f, name: e.currentTarget.value })} />
          <Select label="Провайдер" data={["anthropic", "openai-compatible", "meta"]} value={f.provider} onChange={(v) => setF({ ...f, provider: v ?? f.provider })} />
          <TextInput label="Адрес API" value={f.base} onChange={(e) => setF({ ...f, base: e.currentTarget.value })} />
          <TextInput label="Модель" value={f.model} onChange={(e) => setF({ ...f, model: e.currentTarget.value })} />
          <PasswordInput label="Ключ" value={f.value} onChange={(e) => setF({ ...f, value: e.currentTarget.value })} />
          <Button disabled={!f.name || !f.value} onClick={async () => { if (await act(keysSet, { name: f.name, provider: f.provider, value: f.value, ...(f.base ? { base: f.base } : {}), ...(f.model ? { model: f.model } : {}) }, "Ключ сохранён")) { await refresh(); setAdd(false); } }}>Сохранить</Button>
        </Stack>
      </Modal>
    </div>
  );
}

function Accounts() {
  const machines = useFleet((f) => f.machines);
  return <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>{Object.values(machines).filter((m) => m.online).map((m) => <AccountsOf key={m.name} machine={m.name} />)}<FleetKeys /></div>;
}

function Profiles() {
  const machines = useFleet((f) => f.machines);
  const online = Object.values(machines).filter((m) => m.online).map((m) => m.name);
  const [machine, setMachine] = useState<string | null>(online[0] ?? null);
  const [picked, setPicked] = useState<string[]>(["base"]);
  const list = useCall(profileList, machine ? { to: "@" + machine } : null);
  const view = useCall(profileView, machine ? { to: "@" + machine, pieces: picked } : null);
  if (list.error) return <Failed error={list.error} retry={list.refetch} />;
  return (
    <Stack>
      <Select size="xs" w={220} aria-label="Машина" data={online} value={machine} onChange={setMachine} className="mono" />
      <div className="cards">
        {(list.data?.pieces ?? []).map((p) => (
          <div key={p.id} className={`card${p.ok ? "" : " off"}`}>
            <Checkbox label={<Text fw={600}>{p.title ?? p.id}</Text>} disabled={!p.ok} checked={picked.includes(p.id)} onChange={(e) => setPicked((x) => (e.currentTarget.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} />
            <Text size="sm">{p.about}</Text>
            {!p.ok && <Text size="sm" c="red">{p.why}</Text>}
            <Text size="xs" className="mono muted trunc">{p.repo}{p.rev ? ` @ ${p.rev}` : ""}</Text>
            <Group gap={4}>{Object.entries(p.has ?? {}).map(([k, n]) => <Badge key={k} variant="default">{k}: {n}</Badge>)}</Group>
          </div>
        ))}
      </div>
      <Text fw={600}>Что получит сессия с набором: {picked.map((id) => list.data?.pieces.find((p) => p.id === id)?.title ?? id).join(" + ") || "пусто"}</Text>
      <div className="table-wrap">
        <Table verticalSpacing={6} horizontalSpacing="md" className="stack">
          <Table.Tbody>{(view.data?.items ?? []).map((i, n) => <Table.Tr key={n}><Table.Td w={110} className="muted">{i.kind}</Table.Td><Table.Td className="mono">{i.name}</Table.Td><Table.Td>{i.about}</Table.Td><Table.Td className="muted">{i.piece}</Table.Td></Table.Tr>)}</Table.Tbody>
        </Table>
      </div>
    </Stack>
  );
}

function Releases() {
  const qc = useQueryClient();
  const machines = useFleet((f) => f.machines);
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
  const left = rolling.filter((m) => m.online && m.build !== roll?.build).length;
  return (
    <Stack>
      <Group gap="xl" align="center">
        <Text size="xl" fw={700}>Сборка {stable ?? "—"}</Text>
        <Group gap={6}>{all.map((m) => <Badge key={m.name} variant="default" color={m.build === (pins[m.name] ?? stable) ? undefined : "orange"} className="mono">{m.name}: {m.build ?? "—"}{pins[m.name] ? " · закреплена" : ""}</Badge>)}</Group>
      </Group>
      {roll && (
        <div className="card" role="status" aria-label="Ход раскатки">
          <Group justify="space-between"><Text fw={600}>Раскатка сборки {roll.build}{left ? "" : " закончена"}</Text><Button size="compact-xs" variant="subtle" onClick={() => setRoll(null)}>Скрыть</Button></Group>
          {rolling.map((m) => (
            <Group key={m.name} gap="sm" wrap="nowrap">
              <span className={`lamp ${!m.online ? "off" : m.build === roll.build ? "idle" : "busy"}`} style={{ marginTop: 0 }} />
              <Text size="sm" className="mono" w={90}>{m.name}</Text>
              <Text size="sm">{!m.online ? "без связи — обновится, когда вернётся" : m.build === roll.build ? `на сборке ${roll.build}` : `сборка ${m.build ?? "—"}, Keeper ставит ${roll.build}`}</Text>
            </Group>
          ))}
        </div>
      )}
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
                    {x.build === stable ? <Badge color="teal">на флоте</Badge> : <Button size="compact-xs" variant={x.build > (stable ?? 0) ? "filled" : "default"} onClick={() => deploy(x.build)}>{x.build > (stable ?? 0) ? "Назначить флоту" : "Откатить флот сюда"}</Button>}
                    <Menu withinPortal position="bottom-end">
                      <Menu.Target><Button size="compact-xs" variant="subtle">Закрепить машину</Button></Menu.Target>
                      <Menu.Dropdown>{all.map((m) => <Menu.Item key={m.name} className="mono" onClick={() => deploy(x.build, m.name)}>{m.name}</Menu.Item>)}</Menu.Dropdown>
                    </Menu>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {Object.keys(pins).length > 0 && <Group gap={6}>{Object.entries(pins).map(([m, n]) => <Button key={m} size="compact-xs" variant="default" onClick={() => deploy(null, m)}>Снять закрепление {m} ({n})</Button>)}</Group>}
    </Stack>
  );
}

function IncidentsOf({ machine }: { machine: string }) {
  const go = useNavigate();
  const list = useCall(incidentList, { to: "@" + machine });
  const WORD = { pending: "ждёт", taken: "разбирается", done: "закрыто" } as const;
  return <>{(list.data?.incidents ?? []).map((x) => (
    <Table.Tr key={x.id}>
      <Table.Td data-l="Обращение">{x.text}</Table.Td><Table.Td data-l="Машина" className="mono">{machine}</Table.Td>
      <Table.Td data-l="Состояние"><Badge color={x.state === "pending" ? "orange" : x.state === "taken" ? "blue" : "gray"}>{WORD[x.state]}</Badge></Table.Td>
      <Table.Td data-l="Разбирает">{x.callsign && <Button size="compact-xs" variant="subtle" className="mono" onClick={() => go(`/work/${x.callsign}`)}>{x.callsign}</Button>}</Table.Td>
      <Table.Td data-l="Когда" className="muted" ta="right">{ago(x.at)}</Table.Td>
    </Table.Tr>
  ))}</>;
}
function Incidents() {
  const machines = useFleet((f) => f.machines);
  return (
    <div className="table-wrap">
      <Table verticalSpacing={8} horizontalSpacing="md" className="stack">
        <Table.Thead><Table.Tr><Table.Th>Обращение</Table.Th><Table.Th>Машина</Table.Th><Table.Th>Состояние</Table.Th><Table.Th>Разбирает</Table.Th><Table.Th /></Table.Tr></Table.Thead>
        <Table.Tbody>{Object.values(machines).filter((m) => m.online).map((m) => <IncidentsOf key={m.name} machine={m.name} />)}</Table.Tbody>
      </Table>
    </div>
  );
}

export function Fleet() {
  return <TabsPage title="Флот" base="/fleet" tabs={[["machines", "Машины", () => <Machines />], ["accounts", "Аккаунты", () => <Accounts />], ["profiles", "Профили", () => <Profiles />], ["releases", "Выпуски", () => <Releases />], ["incidents", "Инциденты", () => <Incidents />]]} />;
}
