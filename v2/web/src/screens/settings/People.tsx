// «Настройки → Люди и проекты»: кто в каких проектах, до каких машин достаёт, устройства человека; пригласить, назвать, удалить.
import { invite, peopleList, peopleRemove, peopleSet, projectSet, type PersonRow } from "@sb/protocol";
import { Badge, Button, Checkbox, Group, Menu, SegmentedControl, Stack, Switch, Table, Text, TextInput } from "@mantine/core";
import { Page } from "../../shell/Page.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { act } from "../../api.ts";
import { confirmDanger, Failed, personWord, useCall } from "../../common.tsx";
import { ago } from "../../lib/time.ts";
import { useFleet } from "../../store/fleet.ts";
import { InviteLink } from "./Invite.tsx";

const deviceName = (addr: string) => (addr.startsWith("@") ? addr.slice(1) : addr.split("~")[0]);
/** Приглашение из строки человека: его устройство (имя~почта) или его машина (@имя с владельцем). */
export function inviteFor(person: string, kind: "device" | "machine", name: string): { addr: string; owner?: string } {
  return kind === "machine" ? { addr: "@" + name, owner: person } : { addr: name + person };
}
/** До каких машин человек достаёт: свои и машины тех, с кем у него общий проект; админ — до всех. */
export function reachOf(p: PersonRow, everyone: PersonRow[], machines: Array<{ name: string; owner: string }>): string[] {
  return machines.filter((m) => p.admin || m.owner === p.person || everyone.some((o) => o.person === m.owner && o.projects.some((x) => p.projects.includes(x)))).map((m) => m.name);
}

export function People() {
  const qc = useQueryClient();
  const list = useCall(peopleList, {}, { refetch: 20_000 });
  const admin = useFleet((f) => !!f.you?.admin);
  const me = useFleet((f) => f.you?.person);
  const machines = useFleet((f) => f.machines);
  const [mail, setMail] = useState("");
  const [device, setDevice] = useState("pult");
  const [project, setProject] = useState("");
  const [made, setMade] = useState("");
  const [name, setName] = useState<{ person: string; name: string } | null>(null);
  const [more, setMore] = useState<{ person: string; kind: "device" | "machine"; name: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["people.list"] });
  if (list.error) return <Failed error={list.error} retry={list.refetch} />;
  const projects = list.data?.projects ?? [];
  const everyone = list.data?.people ?? [];
  const known = everyone.some((p) => p.person === "~" + mail.trim().toLowerCase());
  const inviteNew = async () => {
    // fresh: человек уже во флоте — отказ словом, а не второе приглашение
    const r = await act(invite, { addr: `${device}~${mail.trim().toLowerCase()}`, fresh: true });
    if (r) { await refresh(); setMade(r.invite); setMail(""); }
  };
  return (
    <Stack>
      <div className="table-wrap">
        <Table verticalSpacing={8} horizontalSpacing="md" className="stack">
          <Table.Thead><Table.Tr><Table.Th>Человек</Table.Th>{projects.map((p) => <Table.Th key={p.id} ta="center">{p.name}</Table.Th>)}<Table.Th ta="center">Админ</Table.Th><Table.Th>Достаёт до машин</Table.Th><Table.Th>Устройства</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {everyone.map((p) => (
              <Table.Tr key={p.person}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">{p.online && <span className="lamp idle" style={{ marginTop: 0 }} role="img" aria-label="на связи" />}<Text fw={500}>{p.name ?? personWord(p.person)}</Text></Group>
                  {p.name && <Text size="xs" className="muted">{personWord(p.person)}</Text>}
                </Table.Td>
                {projects.map((pr) => (
                  <Table.Td key={pr.id} ta="center" data-l={pr.name}>
                    <Checkbox style={{ display: "inline-block" }} aria-label={`${p.name ?? p.person} в проекте ${pr.name}`} disabled={!admin} checked={p.projects.includes(pr.id)}
                      onChange={async (e) => (await act(peopleSet, { person: p.person, projects: e.currentTarget.checked ? [...p.projects, pr.id] : p.projects.filter((x) => x !== pr.id) })) && refresh()} />
                  </Table.Td>
                ))}
                <Table.Td ta="center" data-l="Админ"><Switch style={{ display: "inline-block" }} aria-label={`${p.name ?? p.person} — админ`} disabled={!admin || p.person === me} checked={p.admin} onChange={async (e) => (await act(peopleSet, { person: p.person, admin: e.currentTarget.checked })) && refresh()} /></Table.Td>
                <Table.Td data-l="Достаёт до машин"><Group gap={4}>{reachOf(p, everyone, Object.values(machines)).map((m) => <Badge key={m} variant={machines[m]?.owner === p.person ? "light" : "default"} color={machines[m]?.owner === p.person ? "teal" : undefined} className="mono" title={machines[m]?.owner === p.person ? "его машина" : "через общий проект"}>{m}</Badge>)}</Group></Table.Td>
                <Table.Td data-l="Устройства">
                  <Group gap={4}>
                    {(p.devices ?? []).map((d) => (
                      <Badge key={d.kid} variant={d.wait ? "outline" : "default"} color={d.wait ? "orange" : undefined} className="mono" title={d.wait ? "приглашение не принято" : d.seen ? `был ${ago(d.seen)}` : undefined}
                        leftSection={d.online ? <span className="lamp idle" style={{ marginTop: 0, width: 7, height: 7 }} /> : undefined}>{deviceName(d.addr)}{d.wait ? " · ждёт входа" : ""}</Badge>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td ta="right">
                  {admin && (
                    <Menu withinPortal position="bottom-end">
                      <Menu.Target><Button size="compact-xs" variant="subtle" aria-label={`Действия: ${p.name ?? personWord(p.person)}`}>Ещё</Button></Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item onClick={() => setName({ person: p.person, name: p.name ?? "" })}>Назвать…</Menu.Item>
                        <Menu.Item onClick={() => setMore({ person: p.person, kind: "device", name: "phone" })}>Пригласить устройство или машину…</Menu.Item>
                        {p.person !== me && <Menu.Item color="red" onClick={() => confirmDanger({ title: `Удалить ${p.name ?? personWord(p.person)} из флота?`, body: "Его пропуска будут отозваны, соединения закрыты. Машины, которыми он владеет, уйдут из флота вместе с ним.", confirm: "Удалить", onConfirm: async () => (await act(peopleRemove, { person: p.person }, "Человек удалён из флота")) && refresh() })}>Удалить из флота…</Menu.Item>}
                      </Menu.Dropdown>
                    </Menu>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {admin && (
        <Group align="end" gap="sm">
          <TextInput label="Пригласить человека" placeholder="почта" value={mail} onChange={(e) => setMail(e.currentTarget.value)} w={240} error={known ? "Уже во флоте: выдайте ему ссылку в «Пропусках»" : undefined} />
          <TextInput label="Его устройство" className="mono" value={device} onChange={(e) => setDevice(e.currentTarget.value.toLowerCase())} w={120} />
          <Button disabled={!/^\S+@\S+\.\S+$/.test(mail.trim()) || known || !/^[a-z0-9][a-z0-9_-]*$/.test(device)} onClick={() => void inviteNew()}>Пригласить</Button>
          <TextInput label="Новый проект" placeholder="название" value={project} onChange={(e) => setProject(e.currentTarget.value)} w={200} />
          <Button variant="default" disabled={!project.trim()} onClick={async () => { const id = "p" + Date.now().toString(36); if (await act(projectSet, { project: id, name: project.trim() }, "Проект создан")) { await refresh(); setProject(""); } }}>Создать проект</Button>
        </Group>
      )}
      <Page opened={!!made} onClose={() => setMade("")} title="Приглашение" name="link"><InviteLink invite={made} /><Button mt="md" style={{ alignSelf: "flex-start" }} onClick={() => setMade("")}>Готово</Button></Page>
      <Page name="invite" opened={!!more} onClose={() => setMore(null)} title={`Приглашение для ${more ? personWord(more.person) : ""}`}>
        {more && (
          <Stack gap="sm">
            <SegmentedControl value={more.kind} onChange={(v) => setMore({ ...more, kind: v as "device" | "machine", name: v === "machine" ? "" : "phone" })} data={[{ value: "device", label: "Устройство" }, { value: "machine", label: "Машина" }]} aria-label="Что приглашаем" />
            <TextInput label={more.kind === "machine" ? "Имя машины" : "Имя устройства"} className="mono" value={more.name} onChange={(e) => setMore({ ...more, name: e.currentTarget.value.toLowerCase() })} autoFocus />
            <Button disabled={!/^[a-z0-9][a-z0-9_-]*$/.test(more.name)} onClick={async () => { const r = await act(invite, inviteFor(more.person, more.kind, more.name)); if (r) { await refresh(); setMade(r.invite); setMore(null); } }}>Выдать приглашение</Button>
          </Stack>
        )}
      </Page>
      <Page name="name" opened={!!name} onClose={() => setName(null)} title={`Имя для ${name ? personWord(name.person) : ""}`}>
        {name && (
          <Stack gap="sm">
            <TextInput aria-label="Имя" value={name.name} onChange={(e) => setName({ ...name, name: e.currentTarget.value })} autoFocus />
            <Button onClick={async () => { if (await act(peopleSet, { person: name.person, name: name.name.trim() }, "Имя сохранено")) { await refresh(); setName(null); } }}>Сохранить</Button>
          </Stack>
        )}
      </Page>
    </Stack>
  );
}
