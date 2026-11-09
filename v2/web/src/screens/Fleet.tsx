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
import { Failed, personWord, useCall, useUi } from "../common.tsx";
import { ago, day, hhmm, LIMIT_NAMES } from "../lib/time.ts";
import { machineOfCall, useFleet } from "../store/fleet.ts";

export function TabsPage({ title, base, tabs }: { title: string; base: string; tabs: Array<[string, string, () => React.ReactNode]> }) {
  const { tab } = useParams();
  const go = useNavigate();
  const now = tabs.find(([id]) => id === tab) ?? tabs[0];
  return (
    <div className="scroll">
      <div className="page">
        <h1 style={{ fontSize: 20, margin: "0 0 10px" }}>{title}</h1>
        <Tabs value={now[0]} onChange={(v) => v && go(`${base}/${v}`)}>
          <Tabs.List mb="md" style={{ flexWrap: "nowrap", overflowX: "auto" }}>{tabs.map(([id, word]) => <Tabs.Tab key={id} value={id}>{word}</Tabs.Tab>)}</Tabs.List>
        </Tabs>
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
        <Group gap={8} wrap="nowrap"><span className={`lamp ${m.online ? "idle" : "off"}`} style={{ marginTop: 0 }} /><Text fw={600} className="mono">{m.name}</Text></Group>
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
        <Button size="compact-xs" variant="subtle" onClick={() => go(`/observe/machine?m=${m.name}`)}>Журнал</Button>
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

function Login({ machine, onDone }: { machine: string; onDone: () => void }) {
  const [step, setStep] = useState<{ login: string; url: string } | null>(null);
  const [code, setCode] = useState("");
  const qc = useQueryClient();
  if (!step) return <Button onClick={async () => { const r = await act(accountLogin, { to: "@" + machine }); if (r) setStep(r); }}>Получить ссылку входа</Button>;
  return (
    <Stack gap="sm">
      <Button component="a" href={step.url} target="_blank" rel="noreferrer" variant="default">Открыть страницу входа Claude</Button>
      <TextInput label="Код со страницы входа" className="mono" value={code} onChange={(e) => setCode(e.currentTarget.value)} autoFocus />
      <Button disabled={!code.trim()} onClick={async () => { if (await act(accountCode, { to: "@" + machine, login: step.login, code: code.trim() }, "Вход выполнен")) { await qc.invalidateQueries({ queryKey: ["account.list"] }); onDone(); } }}>Войти</Button>
    </Stack>
  );
}

function AccountsOf({ machine }: { machine: string }) {
  const qc = useQueryClient();
  const list = useCall(accountList, { to: "@" + machine });
  const [login, setLogin] = useState(false);
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
        <Group key={a.id} gap="sm" wrap="nowrap" align="center" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
          {a.kind === "claude" && <Stack gap={0}><ActionIcon size="xs" variant="subtle" aria-label="Выше в очереди" disabled={order.indexOf(a.id) === 0} onClick={() => shift(a, -1)}><IconArrowUp size={12} /></ActionIcon><ActionIcon size="xs" variant="subtle" aria-label="Ниже в очереди" disabled={order.indexOf(a.id) === order.length - 1} onClick={() => shift(a, 1)}><IconArrowDown size={12} /></ActionIcon></Stack>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <Group gap={6} wrap="nowrap"><Text size="sm" fw={500} className="trunc">{a.email ?? a.id}</Text>{a.kind === "key" ? <Badge variant="default">ключ флота</Badge> : <Text size="xs" className="muted">{a.plan}</Text>}</Group>
            {!a.ok && <Text size="xs" c="red">{a.why}</Text>}
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
              <Menu.Item color="red" onClick={async () => (await act(accountRemove, { to: "@" + machine, account: a.id }, "Аккаунт убран")) && refresh()}>Убрать с машины</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      ))}
      {!accounts.length && <Text size="sm" className="muted">Входов нет</Text>}
      <Modal opened={login} onClose={() => setLogin(false)} title={`Вход Claude на ${machine}`}><Login machine={machine} onDone={() => setLogin(false)} /></Modal>
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
          <Button size="compact-xs" variant="subtle" color="red" onClick={async () => (await act(keysRemove, { name: k.name }, "Ключ убран")) && refresh()}>Убрать</Button>
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
      <Text fw={600}>Что получит сессия с набором {picked.join(" + ") || "без кусочков"}</Text>
      <div className="table-wrap">
        <Table verticalSpacing={6} horizontalSpacing="md">
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
  if (b.error) return <Failed error={b.error} retry={b.refetch} />;
  const deploy = async (build: number | null, machine?: string) => (await act(buildsDeploy, { build, ...(machine ? { machine } : {}) }, machine ? (build === null ? `${machine} снова на сборке флота` : `${machine} закреплена на ${build}`) : `Сборка ${build} назначена флоту`)) && qc.invalidateQueries({ queryKey: ["builds.list"] });
  const stable = b.data?.stable;
  return (
    <Stack>
      <Group gap="xl" align="end">
        <div><Text size="xl" fw={700}>Сборка {stable ?? "—"}</Text><Text size="sm" className="muted">стоит на флоте</Text></div>
        <Group gap={6}>{Object.values(machines).map((m) => <Badge key={m.name} variant="default" color={m.build === (b.data?.pins[m.name] ?? stable) ? undefined : "orange"} className="mono">{m.name}: {m.build ?? "—"}{b.data?.pins[m.name] ? " · закреплена" : ""}</Badge>)}</Group>
      </Group>
      <div className="table-wrap">
        <Table verticalSpacing={8} horizontalSpacing="md">
          <Table.Thead><Table.Tr><Table.Th>Сборка</Table.Th><Table.Th>Что в ней</Table.Th><Table.Th>Собрана</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {(b.data?.builds ?? []).map((x) => (
              <Table.Tr key={x.build}>
                <Table.Td><Text fw={x.build === stable ? 700 : 400}>{x.build}</Text><Text size="xs" className="mono muted">{x.commit}</Text></Table.Td>
                <Table.Td>{x.note}</Table.Td>
                <Table.Td className="muted">{day(x.at)}, {hhmm(x.at)}</Table.Td>
                <Table.Td ta="right">
                  <Group gap={6} justify="flex-end" wrap="nowrap">
                    {x.build === stable ? <Badge color="teal">на флоте</Badge> : <Button size="compact-xs" variant={x.build > (stable ?? 0) ? "filled" : "default"} onClick={() => deploy(x.build)}>{x.build > (stable ?? 0) ? "Назначить флоту" : "Откатить флот сюда"}</Button>}
                    <Menu withinPortal position="bottom-end">
                      <Menu.Target><Button size="compact-xs" variant="subtle">Закрепить машину</Button></Menu.Target>
                      <Menu.Dropdown>{Object.keys(machines).map((m) => <Menu.Item key={m} className="mono" onClick={() => deploy(x.build, m)}>{m}</Menu.Item>)}</Menu.Dropdown>
                    </Menu>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {Object.keys(b.data?.pins ?? {}).length > 0 && <Group gap={6}>{Object.entries(b.data!.pins).map(([m, n]) => <Button key={m} size="compact-xs" variant="default" onClick={() => deploy(null, m)}>Снять закрепление {m} ({n})</Button>)}</Group>}
    </Stack>
  );
}

function IncidentsOf({ machine }: { machine: string }) {
  const go = useNavigate();
  const list = useCall(incidentList, { to: "@" + machine });
  const WORD = { pending: "ждёт", taken: "разбирается", done: "закрыто" } as const;
  return <>{(list.data?.incidents ?? []).map((x) => (
    <Table.Tr key={x.id}>
      <Table.Td>{x.text}</Table.Td><Table.Td className="mono">{machine}</Table.Td>
      <Table.Td><Badge color={x.state === "pending" ? "orange" : x.state === "taken" ? "blue" : "gray"}>{WORD[x.state]}</Badge></Table.Td>
      <Table.Td>{x.callsign && <Button size="compact-xs" variant="subtle" className="mono" onClick={() => go(`/work/${x.callsign}`)}>{x.callsign}</Button>}</Table.Td>
      <Table.Td className="muted" ta="right">{ago(x.at)}</Table.Td>
    </Table.Tr>
  ))}</>;
}
function Incidents() {
  const machines = useFleet((f) => f.machines);
  return (
    <div className="table-wrap">
      <Table verticalSpacing={8} horizontalSpacing="md">
        <Table.Thead><Table.Tr><Table.Th>Обращение</Table.Th><Table.Th>Машина</Table.Th><Table.Th>Состояние</Table.Th><Table.Th>Разбирает</Table.Th><Table.Th /></Table.Tr></Table.Thead>
        <Table.Tbody>{Object.values(machines).filter((m) => m.online).map((m) => <IncidentsOf key={m.name} machine={m.name} />)}</Table.Tbody>
      </Table>
    </div>
  );
}

export function Fleet() {
  return <TabsPage title="Флот" base="/fleet" tabs={[["machines", "Машины", () => <Machines />], ["accounts", "Аккаунты", () => <Accounts />], ["profiles", "Профили", () => <Profiles />], ["releases", "Выпуски", () => <Releases />], ["incidents", "Инциденты", () => <Incidents />]]} />;
}
