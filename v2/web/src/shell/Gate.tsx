// Вход страницы: приглашение, замена пропуска, подключение, остановки связи. Экран выбирает чистое правило gateOf.
import { CallError, parsePass, whoami } from "@sb/protocol";
import { Button, Group, Stack, Text, Textarea } from "@mantine/core";
import { useEffect, useState, type ReactNode } from "react";
import { acceptInvite, api, connect, inviteFrom, inviteInHash, isMock, keyStore, sayError } from "../api.ts";
import { confirmDanger } from "../common.tsx";
import { getLocal, setLocal, wipeDevice } from "../lib/local.ts";
import { isIos } from "../lib/push.ts";
import { sayWord } from "../lib/words.ts";
import { useFleet } from "../store/fleet.ts";
import { closePage, openPage, useLink } from "./link.ts";

export type GateView =
  | { screen: "connecting" } | { screen: "ready" } | { screen: "install" }
  | { screen: "invite"; why?: string }
  | { screen: "replace"; invite: string; kid: string }
  | { screen: "offline"; why: string }
  | { screen: "revoked"; kid: string; why?: string }
  | { screen: "outdated" }
  | { screen: "stopped"; why: string };

/** Какой экран остановки показать по слову закрытия или отказа. */
export function stopOf(word: string | undefined, kid: string): GateView {
  if (word === "proto") return { screen: "outdated" };
  if (word === "revoked" || word === "bad_key") return { screen: "revoked", kid, why: sayWord(word) };
  return { screen: "stopped", why: sayWord(word) || "соединение закрыто" };
}

/** Что делать при входе: по тому, есть ли пропуск, приглашение в ссылке и что ответил флот. */
export function gateOf(o: { mock: boolean; key: string; invite: string; ios: boolean; standalone: boolean; skippedInstall: boolean }): GateView {
  if (o.ios && !o.standalone && !o.skippedInstall) return { screen: "install" };
  if (o.mock) return { screen: "connecting" };
  if (o.invite && o.key) return { screen: "replace", invite: o.invite, kid: parsePass(o.key)?.kid ?? "" };
  if (!o.invite && !o.key) return { screen: "invite" };
  return { screen: "connecting" };
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="hole" style={{ height: "100%" }}>
      <Stack align="center" gap="sm" maw={440} w="100%">
        <Text fw={700} size="lg" ta="center">{title}</Text>
        {children}
      </Stack>
    </div>
  );
}

function Wipe() {
  return (
    <Button variant="subtle" color="red" size="xs" onClick={() => confirmDanger({
      title: "Стереть данные Switchboard на этом устройстве?", confirm: "Стереть",
      body: "Пропуск, настройки вида и подписка на уведомления будут удалены с этого устройства. Во флоте пропуск останется, пока его не отзовут.",
      onConfirm: async () => { await wipeDevice(); location.replace(location.pathname + location.search); },
    })}>Стереть данные</Button>
  );
}

/** Поле «вставить приглашение»: принимает само приглашение или ссылку с ним. */
function Paste({ onInvite }: { onInvite: (invite: string) => void }) {
  const [text, setText] = useState("");
  const invite = inviteFrom(text);
  return (
    <Stack gap="xs" w="100%">
      <Textarea aria-label="Приглашение" placeholder="Вставьте ссылку-приглашение или само приглашение" autosize minRows={2} className="mono" value={text} onChange={(e) => setText(e.currentTarget.value)} error={text.trim() && !invite ? "Это не похоже на приглашение" : undefined} />
      <Button disabled={!invite} onClick={() => onInvite(invite)}>Войти</Button>
    </Stack>
  );
}

const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** Вход: держит экран, пока страница не готова; готова — показывает детей. */
export function Gate({ children }: { children: ReactNode }) {
  const [view, setView] = useState<GateView>({ screen: "connecting" });
  const link = useLink();
  const rev = useFleet((f) => f.rev);

  const enter = async (invite?: string) => {
    setView({ screen: "connecting" });
    connect();
    if (invite) {
      try {
        await acceptInvite(invite);
      } catch (e) {
        return setView({ screen: "invite", why: sayError(e) });
      }
    }
    if (!isMock) {
      // пропуск проверяется одним запросом: отказ виден сразу, а не через пустой экран
      try {
        await api.call(whoami, {});
      } catch (e) {
        const word = e instanceof CallError ? e.word : "offline";
        if (word === "offline" || word === "timeout") return setView({ screen: "offline", why: sayError(e) });
        return setView(stopOf(word, parsePass(keyStore.get())?.kid ?? ""));
      }
      // пропуск, принятый до появления сервис-воркера, тоже должен быть ему виден
      keyStore.set(keyStore.get());
    }
    openPage();
    setView({ screen: "ready" });
  };

  const start = () => {
    const invite = isMock ? "" : inviteInHash();
    const first = gateOf({ mock: isMock, key: keyStore.get(), invite, ios: isIos(navigator.userAgent), standalone: standalone(), skippedInstall: getLocal("skipInstall", false) });
    if (first.screen === "connecting") void enter(invite ? decodeURIComponent(invite) : undefined);
    else setView(first);
  };
  useEffect(() => {
    start();
    return () => closePage();
  }, []);

  const kid = parsePass(keyStore.get())?.kid ?? "";
  // соединение остановлено уже после входа: пропуск отозван, приложение устарело, соединение вытеснено
  const shown: GateView = view.screen === "ready" && link.state === "stopped" ? stopOf(link.why, kid) : view;

  if (shown.screen === "ready") return rev > 0 || isMock ? <>{children}</> : <Frame title="Подключаюсь к флоту"><span className="lamp busy" role="img" aria-label="подключаюсь" /></Frame>;
  if (shown.screen === "connecting") return <Frame title="Подключаюсь к флоту"><span className="lamp busy" role="img" aria-label="подключаюсь" /></Frame>;
  if (shown.screen === "install") return (
    <Frame title="Добавьте Switchboard на экран «Домой»">
      <Text ta="center">На iPhone уведомления приходят только приложению с экрана «Домой». Нажмите «Поделиться» в Safari, затем «На экран „Домой“», и откройте Switchboard оттуда.</Text>
      <Button variant="default" onClick={() => (setLocal("skipInstall", true), start())}>Продолжить в браузере без уведомлений</Button>
    </Frame>
  );
  if (shown.screen === "invite") return (
    <Frame title="Нужно приглашение">
      {shown.why && <Text c="red" ta="center">{shown.why}</Text>}
      <Paste onInvite={(i) => void enter(i)} />
      <Wipe />
    </Frame>
  );
  if (shown.screen === "replace") return (
    <Frame title="На этом устройстве уже есть пропуск">
      <Text ta="center">Пропуск <span className="mono">{shown.kid}</span> будет заменён пропуском из ссылки. Прежний останется во флоте, пока его не отзовут.</Text>
      <Group>
        <Button onClick={() => void enter(decodeURIComponent(shown.invite))}>Заменить пропуск</Button>
        <Button variant="default" onClick={() => { history.replaceState(null, "", location.pathname + location.search); void enter(); }}>Оставить прежний</Button>
      </Group>
    </Frame>
  );
  if (shown.screen === "offline") return (
    <Frame title="Нет связи с флотом">
      <Text ta="center">{shown.why}</Text>
      <Button onClick={() => void enter()}>Повторить</Button>
    </Frame>
  );
  if (shown.screen === "revoked") return (
    <Frame title="Пропуск больше не действует">
      <Text ta="center">Пропуск <span className="mono">{shown.kid}</span> отозван или не принят. Новый выдаёт любой человек флота в разделе «Настройки → Пропуска».</Text>
      <Paste onInvite={(i) => void enter(i)} />
      <Wipe />
    </Frame>
  );
  if (shown.screen === "outdated") return (
    <Frame title="Приложение устарело">
      <Text ta="center">Флот обновился, эта страница — прежней версии.</Text>
      <Button onClick={() => location.reload()}>Перезагрузить</Button>
    </Frame>
  );
  return (
    <Frame title="Связь остановлена">
      <Text ta="center">{shown.why}</Text>
      <Group><Button onClick={() => location.reload()}>Перезагрузить</Button><Wipe /></Group>
    </Frame>
  );
}
