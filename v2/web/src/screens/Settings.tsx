// «Настройки»: люди и проекты, пропуска, уведомления, правила прокси, GitHub, имена, вид.
import { githubApp, githubSetup, invite, passes, peopleList, peopleRemove, peopleSet, prefsGet, prefsSet, projectSet, reachDevices, reachRemove, reachSubscribe, reachTelegram, revoke, type PassRow, type PersonRow } from "@sb/protocol";
import { ActionIcon, Badge, Button, Checkbox, CopyButton, Group, Modal, Stack, Switch, Table, Text, TextInput } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { act } from "../api.ts";
import { confirmDanger, Failed, personWord, useCall } from "../common.tsx";
import { ago } from "../lib/time.ts";
import { useFleet } from "../store/fleet.ts";
import { TabsPage } from "./Fleet.tsx";

function InviteLink({ link }: { link: string }) {
  return (
    <Stack gap="xs">
      <Text size="sm">Ссылка действует сутки и принимается один раз.</Text>
      <pre className="mono" style={{ background: "var(--surface-2)", padding: 10, borderRadius: 6, margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{link}</pre>
      <CopyButton value={link}>{({ copied, copy }) => <Button size="xs" variant="default" w="fit-content" onClick={copy}>{copied ? "Скопировано" : "Скопировать ссылку"}</Button>}</CopyButton>
    </Stack>
  );
}
const linkOf = (inv: string) => `${location.origin}${location.pathname}${location.search}#invite=${encodeURIComponent(inv)}`;

function People() {
  const qc = useQueryClient();
  const list = useCall(peopleList, {});
  const admin = useFleet((f) => !!f.you?.admin);
  const me = useFleet((f) => f.you?.person);
  const machines = useFleet((f) => f.machines);
  const [mail, setMail] = useState("");
  const [project, setProject] = useState("");
  const [link, setLink] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["people.list"] });
  if (list.error) return <Failed error={list.error} retry={list.refetch} />;
  const projects = list.data?.projects ?? [];
  const everyone = list.data?.people ?? [];
  /** До каких машин человек достаёт: свои и машины тех, с кем у него общий проект; админ — до всех. */
  const reach = (p: PersonRow) => Object.values(machines).filter((m) => p.admin || m.owner === p.person || everyone.some((o) => o.person === m.owner && o.projects.some((x) => p.projects.includes(x)))).map((m) => m.name);
  return (
    <Stack>
      <div className="table-wrap">
        <Table verticalSpacing={8} horizontalSpacing="md" className="stack">
          <Table.Thead><Table.Tr><Table.Th>Человек</Table.Th>{projects.map((p) => <Table.Th key={p.id} ta="center">{p.name}</Table.Th>)}<Table.Th ta="center">Админ</Table.Th><Table.Th>Достаёт до машин</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {everyone.map((p) => (
              <Table.Tr key={p.person}>
                <Table.Td><Text fw={500}>{p.name ?? personWord(p.person)}</Text>{p.name && <Text size="xs" className="muted">{personWord(p.person)}</Text>}</Table.Td>
                {projects.map((pr) => (
                  <Table.Td key={pr.id} ta="center" data-l={pr.name}>
                    <Checkbox style={{ display: "inline-block" }} aria-label={`${p.name ?? p.person} в проекте ${pr.name}`} disabled={!admin} checked={p.projects.includes(pr.id)}
                      onChange={async (e) => (await act(peopleSet, { person: p.person, projects: e.currentTarget.checked ? [...p.projects, pr.id] : p.projects.filter((x) => x !== pr.id) })) && refresh()} />
                  </Table.Td>
                ))}
                <Table.Td ta="center" data-l="Админ"><Switch style={{ display: "inline-block" }} aria-label={`${p.name ?? p.person} — админ`} disabled={!admin} checked={p.admin} onChange={async (e) => (await act(peopleSet, { person: p.person, admin: e.currentTarget.checked })) && refresh()} /></Table.Td>
                <Table.Td data-l="Достаёт до машин"><Group gap={4}>{reach(p).map((m) => <Badge key={m} variant="default" className="mono">{m}</Badge>)}</Group></Table.Td>
                <Table.Td ta="right">{admin && p.person !== me && <Button size="compact-xs" variant="subtle" color="red" onClick={() => confirmDanger({ title: `Удалить ${p.name ?? personWord(p.person)} из флота?`, body: "Его пропуска будут отозваны, соединения закрыты. Машины, которыми он владеет, останутся во флоте.", confirm: "Удалить", onConfirm: async () => (await act(peopleRemove, { person: p.person }, "Человек удалён из флота")) && refresh() })}>Удалить</Button>}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {admin && (
        <Group align="end" gap="sm">
          <TextInput label="Пригласить человека" placeholder="почта" value={mail} onChange={(e) => setMail(e.currentTarget.value)} w={260} />
          <Button disabled={!/^\S+@\S+\.\S+$/.test(mail)} onClick={async () => { const r = await act(invite, { addr: "pult~" + mail }); if (r) { await act(peopleSet, { person: "~" + mail }); await refresh(); setLink(linkOf(r.invite)); setMail(""); } }}>Пригласить</Button>
          <TextInput label="Новый проект" placeholder="название" value={project} onChange={(e) => setProject(e.currentTarget.value)} w={220} />
          <Button variant="default" disabled={!project.trim()} onClick={async () => { const id = "p" + Date.now().toString(36); if (await act(projectSet, { project: id, name: project.trim() }, "Проект создан")) { await refresh(); setProject(""); } }}>Создать проект</Button>
        </Group>
      )}
      <Modal opened={!!link} onClose={() => setLink("")} title="Приглашение"><InviteLink link={link} /></Modal>
    </Stack>
  );
}

function Passes() {
  const qc = useQueryClient();
  const list = useCall(passes, {});
  const me = useFleet((f) => f.you);
  const [name, setName] = useState("phone");
  const [link, setLink] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["passes"] });
  if (list.error) return <Failed error={list.error} retry={list.refetch} />;
  const all = list.data?.passes ?? [];
  const nameOf = (p: PassRow) => (p.addr.startsWith("@") ? p.addr.slice(1) : p.addr.split("~")[0]);
  const drop = (p: PassRow) => confirmDanger({
    title: p.wait ? `Отозвать приглашение ${nameOf(p)}?` : p.addr.startsWith("@") ? `Отозвать пропуск машины ${nameOf(p)}?` : `Отозвать пропуск «${nameOf(p)}» — ${personWord(p.person)}?`,
    body: p.wait ? "Ссылка перестанет приниматься." : p.addr.startsWith("@") ? "Машина уйдёт из флота: её Host и Keeper отключатся, сессии пропадут из картины. Вернуть — новым приглашением и установкой." : "Устройство сразу потеряет доступ, его соединения закроются. Вернуть — новой ссылкой.",
    confirm: "Отозвать", onConfirm: async () => (await act(revoke, { kid: p.kid }, `Отозвано: ${nameOf(p)}`)) && refresh(),
  });
  const group = (title: string, rows: PassRow[]) => rows.length > 0 && (
    <div>
      <Text fw={600} mb={6}>{title}</Text>
      <div className="table-wrap">
        <Table verticalSpacing={7} horizontalSpacing="md" className="stack">
          <Table.Tbody>
            {rows.map((p) => (
              <Table.Tr key={p.kid}>
                <Table.Td className="mono">{nameOf(p)}{p.addr === me?.addr && <Badge ml={8} color="teal">это устройство</Badge>}</Table.Td>
                <Table.Td data-l="Чьё">{personWord(p.person)}</Table.Td>
                <Table.Td data-l="Последний раз" className="muted">{p.wait ? "приглашение не принято" : p.seen ? ago(p.seen) : "—"}</Table.Td>
                <Table.Td ta="right"><Button size="compact-xs" variant="subtle" color="red" disabled={p.addr === me?.addr} onClick={() => drop(p)}>Отозвать</Button></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </div>
  );
  return (
    <Stack>
      <Group align="end" gap="sm">
        <TextInput label="Новое устройство" className="mono" value={name} onChange={(e) => setName(e.currentTarget.value.toLowerCase())} w={200} />
        <Button disabled={!/^[a-z0-9][a-z0-9_-]*$/.test(name)} onClick={async () => { const r = await act(invite, { addr: name + (me?.person ?? "") }); if (r) { await refresh(); setLink(linkOf(r.invite)); } }}>Выдать ссылку</Button>
      </Group>
      {group("Устройства людей", all.filter((p) => !p.addr.startsWith("@")))}
      {group("Машины", all.filter((p) => p.addr.startsWith("@")))}
      <Modal opened={!!link} onClose={() => setLink("")} title="Ссылка для устройства"><InviteLink link={link} /></Modal>
    </Stack>
  );
}

function Alerts() {
  const qc = useQueryClient();
  const list = useCall(reachDevices, {});
  const [tg, setTg] = useState<{ code: string; bot: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["reach.devices"] });
  return (
    <Stack>
      <Group>
        <Button onClick={async () => (await act(reachSubscribe, { kind: "webpush", endpoint: "https://push.example/" + Date.now(), p256dh: "-", auth: "-", label: "Этот браузер" }, "Уведомления включены")) && refresh()}>Включить уведомления здесь</Button>
        <Button variant="default" onClick={async () => { const r = await act(reachTelegram, {}); if (r) setTg(r); }}>Подключить Telegram</Button>
      </Group>
      <div className="table-wrap">
        <Table verticalSpacing={7} horizontalSpacing="md" className="stack">
          <Table.Tbody>
            {(list.data?.devices ?? []).map((d) => (
              <Table.Tr key={d.id}>
                <Table.Td>{d.label}</Table.Td><Table.Td className="muted">{d.kind === "webpush" ? "пуш" : "Telegram"}</Table.Td><Table.Td className="muted">{ago(d.at)}</Table.Td>
                <Table.Td ta="right"><ActionIcon variant="subtle" color="red" aria-label="Убрать" onClick={async () => (await act(reachRemove, { device: d.id }, "Убрано")) && refresh()}><IconTrash size={15} /></ActionIcon></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      <Modal opened={!!tg} onClose={() => setTg(null)} title="Подключить Telegram">
        {tg && <Stack gap="xs"><Text size="sm">Отправьте боту <span className="mono">@{tg.bot}</span> этот код. Чат станет вашим устройством: вопросы сессий придут туда, ответы уйдут сессиям.</Text><Text size="xl" fw={700} className="mono">{tg.code}</Text></Stack>}
      </Modal>
    </Stack>
  );
}

type Rule = { name: string; match: string; replace: string; on: boolean };
function ProxyRules() {
  const qc = useQueryClient();
  const prefs = useCall(prefsGet, { scope: "fleet", prefix: "proxy." });
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [probe, setProbe] = useState("Счёт для ООО «Ромашка» лежит на internal.example.com");
  useEffect(() => { if (prefs.data && !rules) setRules((prefs.data.values["proxy.rules"] as Rule[] | undefined) ?? []); }, [prefs.data, rules]);
  if (prefs.error) return <Failed error={prefs.error} retry={prefs.refetch} />;
  const list = rules ?? [];
  const set = (i: number, p: Partial<Rule>) => setRules(list.map((r, j) => (j === i ? { ...r, ...p } : r)));
  let out = probe, broken = "";
  for (const r of list) if (r.on) try { out = out.replace(new RegExp(r.match, "g"), r.replace); } catch { broken = r.name; }
  return (
    <Stack>
      <div className="table-wrap">
        <Table verticalSpacing={6} horizontalSpacing="sm" className="stack">
          <Table.Thead><Table.Tr><Table.Th>Вкл</Table.Th><Table.Th>Правило</Table.Th><Table.Th>Что искать</Table.Th><Table.Th>На что заменить</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {list.map((r, i) => (
              <Table.Tr key={i}>
                <Table.Td><Switch aria-label={`Правило ${r.name}`} checked={r.on} onChange={(e) => set(i, { on: e.currentTarget.checked })} /></Table.Td>
                <Table.Td><TextInput size="xs" aria-label="Название" value={r.name} onChange={(e) => set(i, { name: e.currentTarget.value })} /></Table.Td>
                <Table.Td><TextInput size="xs" aria-label="Что искать" className="mono" value={r.match} onChange={(e) => set(i, { match: e.currentTarget.value })} error={broken === r.name ? "выражение не разобрано" : undefined} /></Table.Td>
                <Table.Td><TextInput size="xs" aria-label="На что заменить" className="mono" value={r.replace} onChange={(e) => set(i, { replace: e.currentTarget.value })} /></Table.Td>
                <Table.Td><ActionIcon variant="subtle" color="red" aria-label="Убрать правило" onClick={() => setRules(list.filter((_, j) => j !== i))}><IconTrash size={15} /></ActionIcon></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      <Group>
        <Button variant="default" size="xs" onClick={() => setRules([...list, { name: "Новое правило", match: "", replace: "", on: false }])}>Добавить правило</Button>
        <Button size="xs" disabled={!!broken} onClick={async () => (await act(prefsSet, { scope: "fleet", name: "proxy.rules", value: list }, "Правила сохранены, машины их перечитают")) && qc.invalidateQueries({ queryKey: ["prefs.get"] })}>Сохранить</Button>
      </Group>
      <TextInput label="Проверка на тексте" value={probe} onChange={(e) => setProbe(e.currentTarget.value)} />
      <Text size="sm">Модель увидит: <span className="mono">{out}</span></Text>
    </Stack>
  );
}

function GitHub() {
  const app = useCall(githubApp, {});
  if (app.error) return <Failed error={app.error} retry={app.refetch} />;
  return (
    <Stack>
      {app.data?.installed ? (
        <>
          <Text>Приложение <a href={app.data.url} target="_blank" rel="noreferrer">{app.data.name}</a> установлено. Доступны репозитории:</Text>
          <Group gap={6}>{(app.data.repos ?? []).map((r) => <Badge key={r} variant="default" className="mono">{r}</Badge>)}</Group>
        </>
      ) : <Button w="fit-content" onClick={async () => { const r = await act(githubSetup, {}); if (r?.url) window.open(r.url, "_blank"); }}>Создать приложение GitHub</Button>}
    </Stack>
  );
}

function Names() {
  const qc = useQueryClient();
  const sessions = useFleet((f) => f.sessions);
  const prefs = useCall(prefsGet, { scope: "fleet", prefix: "labels" });
  const labels = (prefs.data?.values.labels as Record<string, string> | undefined) ?? {};
  const save = async (c: string, v: string) => (await act(prefsSet, { scope: "fleet", name: "labels", patch: { [c]: v.trim() || null } })) && qc.invalidateQueries({ queryKey: ["prefs.get"] });
  return (
    <div className="table-wrap">
      <Table verticalSpacing={6} horizontalSpacing="md" className="stack">
        <Table.Thead><Table.Tr><Table.Th>Сессия</Table.Th><Table.Th>Имя для людей</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{Object.keys(sessions).sort().map((c) => <Table.Tr key={c}><Table.Td className="mono">{c}</Table.Td><Table.Td><TextInput size="xs" aria-label={`Имя для ${c}`} defaultValue={labels[c] ?? ""} key={labels[c] ?? ""} onBlur={(e) => e.currentTarget.value !== (labels[c] ?? "") && save(c, e.currentTarget.value)} /></Table.Td></Table.Tr>)}</Table.Tbody>
      </Table>
    </div>
  );
}

export function Settings() {
  return (
    <TabsPage title="Настройки" base="/settings" tabs={[
      ["people", "Люди и проекты", () => <People />], ["passes", "Пропуска", () => <Passes />], ["alerts", "Уведомления", () => <Alerts />],
      ["proxy", "Правила прокси", () => <ProxyRules />], ["github", "GitHub", () => <GitHub />], ["names", "Имена", () => <Names />],
    ]} />
  );
}
