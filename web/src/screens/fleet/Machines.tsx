// «Флот → Машины»: машины строками и приглашение новой машины с командой установки.
import { buildsKeeper, invite, keeperState, type MachineRow, type SessionRow } from "@sb/protocol";
import { Badge, Button, CopyButton, Group, SegmentedControl, Stack, Text, TextInput } from "@mantine/core";
import { Page } from "../../shell/Page.tsx";
import { useState } from "react";
import { useNavigate } from "react-router";
import { act, fleetBase } from "../../api.ts";
import { personWord, useCall, useMachineName } from "../../common.tsx";
import { newPath } from "../../shell/NewSession.tsx";
import { ago, nSessions } from "../../lib/time.ts";
import { machineOfCall, useFleet } from "../../store/fleet.ts";

export const HOST_WORD: Record<string, string> = { running: "работает", stopped: "остановлен", failed: "сбой", updating: "обновляется" };

/** Команда установки Keeper — служба ОС: приглашение уходит в stdin, не в аргументы; на Windows второй строкой stdin — пароль пользователя
 * службы, его спрашивает PowerShell. link — ссылка на файл Keeper сборки флота: тогда команда сама его скачивает. */
export function installCommand(os: "windows" | "linux", base: string, inviteText: string, link?: { url: string; file: string }): string {
  const file = link?.file ?? (os === "windows" ? "keeper-windows-amd64.exe" : "keeper-linux-amd64");
  const get = link ? (os === "windows" ? `curl.exe -L -o ${file} "${link.url}"\n` : `curl -L -o ${file} '${link.url}'\n`) : "";
  return os === "windows"
    ? `${get}$p = Read-Host "Пароль $env:USERNAME" -AsSecureString\n"${inviteText}\`n$([Net.NetworkCredential]::new('', $p).Password)" | .\\${file} install --base ${base}`
    : `${get}chmod +x ${file} && echo '${inviteText}' | ./${file} install --base ${base}`;
}

/** «Пожар»: сколько сессий машины без связи можно поднять на другой — тех, что сохраняли точки в архив. */
export function fireCount(m: Pick<MachineRow, "name" | "online">, sessions: SessionRow[]): number {
  return m.online ? 0 : sessions.filter((s) => machineOfCall(s.callsign) === m.name && s.spec.backup).length;
}


function AddMachine({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [made, setMade] = useState("");
  const [os, setOs] = useState<"windows" | "linux">("windows");
  const base = fleetBase || "https://fleet.example.com";
  // ссылка на файл Keeper сборки флота: есть — команда скачивает его сама, нет — файл кладут руками
  const link = useCall(buildsKeeper, made ? { os } : null);
  const cmd = installCommand(os, base, made, link.data);
  return (
    <Stack gap="sm">
      {!made ? (
        <>
          <TextInput label="Имя машины" placeholder="laptop" className="mono" value={name} onChange={(e) => setName(e.currentTarget.value.toLowerCase())} autoFocus />
          <Button disabled={!/^[a-z0-9][a-z0-9_-]*$/.test(name)} onClick={async () => { const r = await act(invite, { addr: "@" + name }); if (r) setMade(r.invite); }}>Выдать приглашение</Button>
        </>
      ) : (
        <>
          <SegmentedControl value={os} onChange={(v) => setOs(v as "windows" | "linux")} data={[{ value: "windows", label: "Windows" }, { value: "linux", label: "Linux" }]} aria-label="Система машины" />
          <Text size="sm">{link.data ? <>Выполните на машине <span className="mono">{name}</span>{os === "windows" && " в PowerShell от администратора"}: команда скачает Keeper сборки {link.data.build} и поставит его службой.</> : <>Положите файл Keeper из сборки флота на машину <span className="mono">{name}</span> и выполните рядом с ним{os === "windows" && " в PowerShell от администратора"}.</>} Приглашение действует сутки.</Text>
          <pre className="codebox">{cmd}</pre>
          <Group>
            <CopyButton value={cmd}>{({ copied, copy }) => <Button size="xs" variant="default" onClick={copy}>{copied ? "Скопировано" : "Скопировать команду"}</Button>}</CopyButton>
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
  const nameOf = useMachineName();
  const keeper = useCall(keeperState, m.online ? { to: ".keeper@" + m.name } : null);
  const here = Object.values(sessions).filter((s) => machineOfCall(s.callsign) === m.name);
  const k = keeper.data;
  const fire = fireCount(m, here);
  return (
    <div className={`card mline${m.online ? "" : " off"}`}>
      <Group gap={8} wrap="nowrap" style={{ minWidth: 0, flex: "0 1 190px" }}>
        <span className={`lamp ${m.online ? "idle" : "off"}`} style={{ marginTop: 0 }} />
        <Text fw={600} className="trunc" component="button" type="button" style={{ border: 0, background: "none", padding: 0, cursor: "pointer", color: "inherit", textDecoration: "underline dotted", textUnderlineOffset: 3 }} onClick={() => go(`/machine/${m.name}`)}>{nameOf(m.name)}</Text>
        {nameOf(m.name) !== m.name && <Text size="xs" className="mono muted">{m.name}</Text>}
      </Group>
      {!m.online && <Text size="sm" c="red" style={{ whiteSpace: "nowrap" }}>без связи {ago(m.since)}</Text>}
      <Text size="sm" className="muted" style={{ whiteSpace: "nowrap" }}>{personWord(m.owner)}</Text>
      <Text size="sm" style={{ overflowWrap: "anywhere" }}>Host {!m.online ? `сборка ${m.build ?? "—"}` : k ? `сборка ${k.host.build} · ${HOST_WORD[k.host.state] ?? k.host.state}${k.host.why ? `: ${k.host.why}` : ""}` : `сборка ${m.build ?? "—"}`}</Text>
      <Text size="sm" style={{ whiteSpace: "nowrap" }}>Keeper {!m.online ? (m.keeper === false ? "не на связи" : "—") : k ? `сборка ${k.build}` : keeper.error ? "не отвечает" : "…"}</Text>
      {m.os && <Text size="sm" className="muted" style={{ whiteSpace: "nowrap" }}>{m.os}</Text>}
      {fire > 0 && <Badge color="red" variant="light" w="fit-content">пожар: {nSessions(fire)} ждут на точках архива</Badge>}
      <Group gap={4} className="grow">{here.map((s) => <Badge key={s.callsign} size="sm" variant="default" className="mono" component="button" type="button" style={{ cursor: "pointer" }} onClick={() => go(`/work/${s.callsign}`)}>{s.spec.name}</Badge>)}</Group>
      <Group gap={6} wrap="nowrap">
        <Button size="compact-xs" variant="default" disabled={!m.online} onClick={() => go(newPath({ machine: m.name }))}>Новая сессия</Button>
        <Button size="compact-xs" variant="subtle" onClick={() => go(`/machine/${m.name}`)}>{m.online ? "Подробнее" : "Что известно"}</Button>
      </Group>
    </div>
  );
}

export function Machines() {
  const machines = useFleet((f) => f.machines);
  const [add, setAdd] = useState(false);
  return (
    <Stack>
      <Button w="fit-content" size="xs" onClick={() => setAdd(true)}>Добавить машину</Button>
      <div className="rows">{Object.values(machines).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)).map((m) => <MachineCard key={m.name} m={m} />)}</div>
      <Page name="add" opened={add} onClose={() => setAdd(false)} title="Добавить машину"><AddMachine onClose={() => setAdd(false)} /></Page>
    </Stack>
  );
}
