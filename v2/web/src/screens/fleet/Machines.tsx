// «Флот → Машины»: карточки машин и приглашение новой машины с командой установки.
import { invite, keeperState, type MachineRow } from "@sb/protocol";
import { Badge, Button, CopyButton, Group, Modal, SegmentedControl, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useNavigate } from "react-router";
import { act, fleetBase } from "../../api.ts";
import { personWord, useCall, useMachineName, useUi } from "../../common.tsx";
import { ago } from "../../lib/time.ts";
import { machineOfCall, useFleet } from "../../store/fleet.ts";

export const HOST_WORD: Record<string, string> = { running: "работает", stopped: "остановлен", failed: "сбой", updating: "обновляется" };

/** Команда установки Keeper: приглашение уходит в stdin, не в аргументы. */
export function installCommand(os: "windows" | "linux", base: string, inviteText: string): string {
  return os === "windows"
    ? `"${inviteText}" | .\\keeper-windows-amd64.exe install --base ${base} --logon`
    : `chmod +x keeper-linux-amd64 && echo '${inviteText}' | ./keeper-linux-amd64 install --base ${base}`;
}

function AddMachine({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [made, setMade] = useState("");
  const [os, setOs] = useState<"windows" | "linux">("windows");
  const base = fleetBase || "https://fleet.example.com";
  const cmd = installCommand(os, base, made);
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
          <Text size="sm">Положите файл Keeper из сборки флота на машину <span className="mono">{name}</span> и выполните рядом с ним. Приглашение действует сутки.</Text>
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
  const ui = useUi();
  const nameOf = useMachineName();
  const keeper = useCall(keeperState, m.online ? { to: ".keeper@" + m.name } : null);
  const here = Object.values(sessions).filter((s) => machineOfCall(s.callsign) === m.name);
  const k = keeper.data;
  return (
    <div className={`card${m.online ? "" : " off"}`}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <span className={`lamp ${m.online ? "idle" : "off"}`} style={{ marginTop: 0 }} />
          <Text fw={600} className="trunc" component="button" type="button" style={{ border: 0, background: "none", padding: 0, cursor: "pointer", color: "inherit", textDecoration: "underline dotted", textUnderlineOffset: 3 }} onClick={() => go(`/machine/${m.name}`)}>{nameOf(m.name)}</Text>
          {nameOf(m.name) !== m.name && <Text size="xs" className="mono muted">{m.name}</Text>}
        </Group>
        <Text size="sm" c={m.online ? undefined : "red"} style={{ whiteSpace: "nowrap" }}>{m.online ? "на связи" : `без связи ${ago(m.since)}`}</Text>
      </Group>
      <dl className="kv">
        <dt>Владелец</dt><dd>{personWord(m.owner)}</dd>
        <dt>Host</dt><dd>{!m.online ? `сборка ${m.build ?? "—"}` : k ? `сборка ${k.host.build} · ${HOST_WORD[k.host.state] ?? k.host.state}${k.host.why ? `: ${k.host.why}` : ""}` : `сборка ${m.build ?? "—"}`}</dd>
        <dt>Keeper</dt><dd>{!m.online ? (m.keeper === false ? "не на связи" : "—") : k ? `сборка ${k.build}` : keeper.error ? "не отвечает" : "…"}</dd>
        <dt>Система</dt><dd>{m.os ?? "—"}</dd>
      </dl>
      <Group gap={4}>{here.map((s) => <Badge key={s.callsign} variant="default" className="mono" component="button" type="button" style={{ cursor: "pointer" }} onClick={() => go(`/work/${s.callsign}`)}>{s.spec.name}</Badge>)}</Group>
      <Group gap={6} mt="auto">
        <Button size="compact-xs" variant="default" disabled={!m.online} onClick={() => ui.set({ newOpen: true, newPreset: { machine: m.name } })}>Новая сессия</Button>
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
      <div className="cards">{Object.values(machines).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)).map((m) => <MachineCard key={m.name} m={m} />)}</div>
      <Modal opened={add} onClose={() => setAdd(false)} title="Добавить машину"><AddMachine onClose={() => setAdd(false)} /></Modal>
    </Stack>
  );
}
