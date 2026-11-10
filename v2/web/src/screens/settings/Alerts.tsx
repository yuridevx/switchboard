// «Настройки → Уведомления»: пуши на этом устройстве, бот Telegram флота, привязка своего чата, список устройств.
import { parsePass, reachBot, reachDevices, reachRemove, reachTelegram, type DeviceRow } from "@sb/protocol";
import { ActionIcon, Badge, Button, CopyButton, Group, Modal, PasswordInput, Stack, Text } from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { act, keyStore } from "../../api.ts";
import { confirmDanger, Failed, useCall } from "../../common.tsx";
import { disablePush, pushState, type PushState } from "../../lib/push.ts";
import { ago } from "../../lib/time.ts";
import { PUSH_WORD, turnOnPush } from "../../shell/PushBar.tsx";
import { useFleet } from "../../store/fleet.ts";

/** Подписки пушей этого устройства: записаны его пропуском. */
export const myPushDevices = (devices: DeviceRow[], kid: string) => devices.filter((d) => d.kind === "webpush" && !!kid && d.kid === kid);

/** Пуши на этом устройстве: состояние словами и одна кнопка. */
export function ThisDevicePush() {
  const qc = useQueryClient();
  const list = useCall(reachDevices, {});
  const [state, setState] = useState<PushState | null>(null);
  useEffect(() => void pushState().then(setState), []);
  const kid = parsePass(keyStore.get())?.kid ?? "";
  const refresh = () => qc.invalidateQueries({ queryKey: ["reach.devices"] });
  const off = async () => {
    await disablePush();
    for (const d of myPushDevices(list.data?.devices ?? [], kid)) await act(reachRemove, { device: d.id });
    setState(await pushState());
    await refresh();
  };
  return (
    <div className="card">
      <Group justify="space-between" wrap="wrap">
        <div style={{ minWidth: 0 }}>
          <Text fw={600}>Это устройство</Text>
          <Text size="sm" c={state === "denied" ? "red" : undefined}>{state ? PUSH_WORD[state] : "Проверяю…"}</Text>
        </div>
        {state === "off" && <Button onClick={async () => { setState(await turnOnPush()); await refresh(); }}>Включить уведомления</Button>}
        {state === "on" && <Button variant="default" onClick={() => void off()}>Выключить</Button>}
      </Group>
    </div>
  );
}

function Telegram() {
  const qc = useQueryClient();
  const admin = useFleet((f) => !!f.you?.admin);
  const bot = useCall(reachBot, admin ? {} : null);
  const [token, setToken] = useState("");
  const [tg, setTg] = useState<{ code: string; bot: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["reach.bot"] });
  return (
    <div className="card">
      <Group justify="space-between" wrap="wrap">
        <div style={{ minWidth: 0 }}>
          <Text fw={600}>Telegram</Text>
          {admin && <Text size="sm">{bot.data?.on ? <>Бот флота — <span className="mono">@{bot.data.bot}</span></> : bot.data ? "Бот флота не подключён" : bot.error ? "Состояние бота неизвестно" : "…"}</Text>}
        </div>
        <Button variant="default" onClick={async () => { const r = await act(reachTelegram, {}); if (r) setTg(r); }}>Привязать свой чат</Button>
      </Group>
      {admin && !bot.data?.on && (
        <Group align="end" gap="xs">
          <PasswordInput label="Токен бота от BotFather" value={token} onChange={(e) => setToken(e.currentTarget.value)} style={{ flex: "1 1 240px" }} />
          <Button disabled={!/^\d+:[\w-]{20,}$/.test(token.trim())} onClick={async () => { if (await act(reachBot, { token: token.trim() }, "Бот подключён")) { setToken(""); await refresh(); } }}>Подключить бота</Button>
        </Group>
      )}
      {admin && bot.data?.on && (
        <Button size="compact-xs" variant="subtle" color="red" w="fit-content" onClick={() => confirmDanger({ title: `Отключить бота @${bot.data?.bot}?`, body: "Чаты людей перестанут получать вопросы сессий, ответы из Telegram перестанут доходить.", confirm: "Отключить", onConfirm: async () => (await act(reachBot, { token: null }, "Бот отключён")) && refresh() })}>Отключить бота</Button>
      )}
      <Modal opened={!!tg} onClose={() => setTg(null)} title="Привязать чат Telegram">
        {tg && (
          <Stack gap="xs">
            <Text size="sm">Отправьте боту <a href={`https://t.me/${tg.bot}`} target="_blank" rel="noreferrer" className="mono">@{tg.bot}</a> этот код — личным сообщением или в группе с темами. Чат станет вашим устройством: вопросы сессий придут туда, ответы уйдут сессиям.</Text>
            <Group><Text size="xl" fw={700} className="mono">{tg.code}</Text><CopyButton value={tg.code}>{({ copied, copy }) => <Button size="xs" variant="default" onClick={copy}>{copied ? "Скопировано" : "Скопировать"}</Button>}</CopyButton></Group>
          </Stack>
        )}
      </Modal>
    </div>
  );
}

export function Alerts() {
  const qc = useQueryClient();
  const list = useCall(reachDevices, {});
  const kid = parsePass(keyStore.get())?.kid ?? "";
  const refresh = () => qc.invalidateQueries({ queryKey: ["reach.devices"] });
  return (
    <Stack>
      <ThisDevicePush />
      <Telegram />
      <div className="card">
        <Text fw={600}>Куда приходят уведомления</Text>
        {list.error && <Failed error={list.error} retry={list.refetch} />}
        {(list.data?.devices ?? []).map((d) => (
          <div key={d.id} className="line">
            <div className="grow">
              <Group gap={6}><Text size="sm">{d.label ?? (d.kind === "webpush" ? "Браузер" : "Чат Telegram")}</Text>{d.kind === "webpush" && d.kid === kid && <Badge color="teal">это устройство</Badge>}</Group>
              <Text size="xs" className="muted">{d.kind === "webpush" ? "пуш" : "Telegram"} · {ago(d.at)}</Text>
            </div>
            <ActionIcon variant="subtle" color="red" aria-label={`Убрать: ${d.label ?? d.kind}`} onClick={async () => (await act(reachRemove, { device: d.id }, "Убрано")) && refresh()}><IconTrash size={15} /></ActionIcon>
          </div>
        ))}
        {list.data && !list.data.devices.length && <Text size="sm" className="muted">Пока никуда: включите уведомления здесь или привяжите чат</Text>}
      </div>
    </Stack>
  );
}
