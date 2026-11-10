// Согласие на вход внешнего клиента (OAuth): человек разрешает клиенту действовать от его имени и возвращается к нему с кодом.
// Адрес экрана — путь /consent?client_id=…&redirect_uri=…&code_challenge=…&state=…
import { consent } from "@sb/protocol";
import { Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { api, sayError } from "../api.ts";
import { personWord } from "../common.tsx";
import { useFleet } from "../store/fleet.ts";

export type ConsentAsk = { client: string; back: string; challenge: string; state: string };

/** Разобрать запрос согласия из адреса; чего-то нет — причина словами. */
export function consentOf(search: string): ConsentAsk | { error: string } {
  const q = new URLSearchParams(search);
  const client = q.get("client_id") ?? "", back = q.get("redirect_uri") ?? "", challenge = q.get("code_challenge") ?? "";
  if (!client || !back || !challenge) return { error: "В запросе клиента нет адреса клиента, адреса возврата или кода проверки." };
  if (q.get("code_challenge_method") && q.get("code_challenge_method") !== "S256") return { error: "Клиент просит проверку, которую флот не принимает: нужна S256." };
  try {
    new URL(back);
  } catch {
    return { error: "Адрес возврата клиента не разобран." };
  }
  return { client, back, challenge, state: q.get("state") ?? "" };
}

/** Адрес возврата к клиенту: с кодом или с отказом. */
export function backUrl(a: ConsentAsk, r: { code: string } | { error: string }): string {
  const u = new URL(a.back);
  if ("code" in r) u.searchParams.set("code", r.code);
  else u.searchParams.set("error", r.error);
  if (a.state) u.searchParams.set("state", a.state);
  return u.toString();
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function Consent() {
  const you = useFleet((f) => f.you);
  const ask = consentOf(location.search);
  const [label, setLabel] = useState("claude");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  if ("error" in ask) return <div className="hole" style={{ height: "100%" }}><Stack align="center" gap="xs" maw={440}><Text fw={700} size="lg">Вход клиента не начат</Text><Text ta="center">{ask.error}</Text></Stack></div>;
  const allow = async () => {
    setBusy(true);
    try {
      const r = await api.call(consent, { client: ask.client, back: ask.back, challenge: ask.challenge, label });
      location.replace(backUrl(ask, { code: r.code }));
    } catch (e) {
      setWhy(sayError(e));
      setBusy(false);
    }
  };
  return (
    <div className="hole" style={{ height: "100%" }}>
      <Stack gap="sm" maw={460} w="100%" style={{ textAlign: "left", color: "var(--mantine-color-text)" }}>
        <Text fw={700} size="lg">Разрешить клиенту вход во флот?</Text>
        <dl className="kv">
          <dt>Клиент</dt><dd className="mono">{hostOf(ask.client)}</dd>
          <dt>Вернётся на</dt><dd className="mono">{hostOf(ask.back)}</dd>
          <dt>От имени</dt><dd>{personWord(you?.person ?? "")}</dd>
        </dl>
        <Text size="sm">Клиент получит пропуск устройства и сможет всё, что можете вы: писать сессиям, открывать новые, запускать команды на ваших машинах. Отозвать — «Настройки → Пропуска».</Text>
        <TextInput label="Имя устройства клиента" className="mono" value={label} onChange={(e) => setLabel(e.currentTarget.value.toLowerCase())} error={/^[a-z0-9][a-z0-9_-]*$/.test(label) ? undefined : "латиница, цифры, дефис"} />
        {why && <Text c="red" size="sm">{why}</Text>}
        <Group>
          <Button loading={busy} disabled={!/^[a-z0-9][a-z0-9_-]*$/.test(label)} onClick={() => void allow()}>Разрешить</Button>
          <Button variant="default" onClick={() => location.replace(backUrl(ask, { error: "access_denied" }))}>Отказать</Button>
        </Group>
      </Stack>
    </div>
  );
}
