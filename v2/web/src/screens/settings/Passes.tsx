// «Настройки → Пропуска»: устройства людей и машины; выдать ссылку с QR, отозвать.
import { invite, passes, revoke, type PassRow } from "@sb/protocol";
import { Badge, Button, Group, Modal, SegmentedControl, Stack, Table, Text, TextInput } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { act } from "../../api.ts";
import { confirmDanger, Failed, personWord, useCall } from "../../common.tsx";
import { ago } from "../../lib/time.ts";
import { useFleet } from "../../store/fleet.ts";
import { InviteLink } from "./Invite.tsx";

const nameOf = (p: PassRow) => (p.addr.startsWith("@") ? p.addr.slice(1) : p.addr.split("~")[0]);
/** Кто пригласил — словами: человек или сессия. */
export const byWord = (by?: string) => (!by ? "" : by.includes("~") ? personWord(by.slice(by.indexOf("~"))) : by);

export function Passes() {
  const qc = useQueryClient();
  const list = useCall(passes, {}, { refetch: 20_000 });
  const me = useFleet((f) => f.you);
  const [kind, setKind] = useState("phone");
  const [name, setName] = useState("phone");
  const [made, setMade] = useState<{ invite: string; program: boolean } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["passes"] });
  if (list.error) return <Failed error={list.error} retry={list.refetch} />;
  const all = list.data?.passes ?? [];
  const drop = (p: PassRow) => confirmDanger({
    title: p.addr === me?.addr ? "Отозвать пропуск этого устройства?" : p.wait ? `Отозвать приглашение ${nameOf(p)}?` : p.addr.startsWith("@") ? `Отозвать пропуск машины ${nameOf(p)}?` : `Отозвать пропуск «${nameOf(p)}» — ${personWord(p.person)}?`,
    body: p.addr === me?.addr ? "Эта страница сразу выйдет из флота. Вернуться можно только новым приглашением с другого устройства." : p.wait ? "Ссылка перестанет приниматься." :p.addr.startsWith("@") ? "Машина уйдёт из флота: её Host и Keeper отключатся, сессии пропадут из картины. Вернуть — новым приглашением и установкой." : "Устройство сразу потеряет доступ, его соединения закроются. Вернуть — новой ссылкой.",
    confirm: p.addr === me?.addr ? "Отозвать это устройство" : "Отозвать", onConfirm: async () => (await act(revoke, { kid: p.kid }, `Отозвано: ${nameOf(p)}`)) && refresh(),
  });
  const group = (title: string, rows: PassRow[]) => rows.length > 0 && (
    <div>
      <p className="sect">{title}</p>
      <div className="table-wrap">
        <Table verticalSpacing={7} horizontalSpacing="md" className="stack">
          <Table.Tbody>
            {rows.map((p) => (
              <Table.Tr key={p.kid}>
                <Table.Td className="mono">
                  <Group gap={6} wrap="nowrap">{p.online && <span className="lamp idle" style={{ marginTop: 0 }} role="img" aria-label="на связи" />}{nameOf(p)}{p.addr === me?.addr && <Badge color="teal">это устройство</Badge>}</Group>
                </Table.Td>
                <Table.Td data-l="Чьё">{personWord(p.person)}</Table.Td>
                <Table.Td data-l="Пригласил" className="muted">{byWord(p.by)}</Table.Td>
                <Table.Td data-l="Последний раз" className="muted">{p.wait ? "приглашение не принято" : p.online ? "на связи" : p.seen ? ago(p.seen) : "—"}</Table.Td>
                <Table.Td data-l="Номер" className="mono muted">{p.kid}</Table.Td>
                <Table.Td ta="right"><Button size="compact-xs" variant="subtle" color="red" onClick={() => drop(p)}>Отозвать</Button></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </div>
  );
  const pick = (k: string) => (setKind(k), setName(k === "program" ? "ci" : k));
  return (
    <Stack>
      <Group align="end" gap="sm">
        <SegmentedControl value={kind} onChange={pick} data={[{ value: "phone", label: "Телефон" }, { value: "pult", label: "Пульт" }, { value: "program", label: "Программа" }]} aria-label="Что подключаем" />
        <TextInput label="Имя устройства" className="mono" value={name} onChange={(e) => setName(e.currentTarget.value.toLowerCase())} w={170} />
        <Button disabled={!/^[a-z0-9][a-z0-9_-]*$/.test(name)} onClick={async () => { const r = await act(invite, { addr: name + (me?.person ?? "") }); if (r) { await refresh(); setMade({ invite: r.invite, program: kind === "program" }); } }}>Выдать приглашение</Button>
      </Group>
      {group("Устройства людей", all.filter((p) => !p.addr.startsWith("@")))}
      {group("Машины", all.filter((p) => p.addr.startsWith("@")))}
      <Modal opened={!!made} onClose={() => setMade(null)} title={made?.program ? "Приглашение для программы" : "Ссылка для устройства"} size="lg">{made && <InviteLink invite={made.invite} program={made.program} />}</Modal>
    </Stack>
  );
}
