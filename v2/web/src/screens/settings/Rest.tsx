// «Настройки»: GitHub, имена сессий и машин, это устройство.
import { githubApp, githubSetup, parsePass, prefsSet, whoami } from "@sb/protocol";
import { Badge, Button, Group, Stack, Table, Text, TextInput } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { act, isMock, keyStore } from "../../api.ts";
import { confirmDanger, Failed, personWord, useCall, useLabels } from "../../common.tsx";
import { wipeDevice } from "../../lib/local.ts";
import { useFleet } from "../../store/fleet.ts";
import { ThisDevicePush } from "./Alerts.tsx";

/** Куда GitHub вернёт человека после создания приложения: эта же страница, экран «GitHub». */
export const githubReturn = (at: { origin: string; pathname: string } = location) => `${at.origin}${at.pathname}?open=settings/github`;

/** Создание приложения GitHub идёт формой браузера: служба отдаёт адрес и манифест. */
function submitForm(form: { action: string; manifest: unknown }) {
  const f = document.createElement("form");
  f.method = "post";
  f.action = form.action;
  const i = document.createElement("input");
  i.type = "hidden";
  i.name = "manifest";
  i.value = JSON.stringify(form.manifest);
  f.appendChild(i);
  document.body.appendChild(f);
  f.submit();
}

export function GitHub() {
  const qc = useQueryClient();
  const admin = useFleet((f) => !!f.you?.admin);
  const app = useCall(githubApp, {});
  const [org, setOrg] = useState("");
  const done = useRef(false);
  // возврат с GitHub: в адресе код нового приложения — служба меняет его на ключи приложения
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get("code");
    if (!code || done.current) return;
    done.current = true;
    q.delete("code");
    q.delete("state");
    history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);
    void act(githubSetup, { code }, "Приложение GitHub сохранено").then(() => qc.invalidateQueries({ queryKey: ["github.app"] }));
  }, []);
  if (app.error) return <Failed error={app.error} retry={app.refetch} />;
  const create = async (replace: boolean) => {
    const r = await act(githubSetup, { redirect: githubReturn(), ...(org.trim() ? { org: org.trim() } : {}), ...(replace ? { replace: true } : {}) });
    if (r?.form) submitForm(r.form);
    else if (r?.url) window.open(r.url, "_blank");
  };
  return (
    <Stack>
      {app.data?.installed ? (
        <div className="card">
          <Text>Приложение <a href={app.data.url} target="_blank" rel="noreferrer">{app.data.name}</a> установлено.</Text>
          <Group gap={6}>{(app.data.repos ?? []).map((r) => <Badge key={r} variant="default" className="mono">{r}</Badge>)}{!app.data.repos?.length && <Text size="sm" className="muted">Репозиториев пока нет</Text>}</Group>
          <Group>
            {app.data.url && <Button component="a" href={`${app.data.url}/installations/new`} target="_blank" rel="noreferrer" size="xs" variant="default">Доступ на GitHub</Button>}
            {admin && <Button size="xs" variant="subtle" color="red" onClick={() => confirmDanger({ title: "Заменить приложение GitHub?", body: "Прежнее приложение перестанет выдавать токены: кусочки профилей не сведутся, пока новое не получит доступ к репозиториям.", confirm: "Заменить", onConfirm: () => create(true) })}>Заменить приложение</Button>}
          </Group>
        </div>
      ) : app.data?.name ? (
        <div className="card">
          <Text>Приложение <b>{app.data.name}</b> создано, но не установлено ни в один репозиторий.</Text>
          {app.data.url && <Button component="a" href={`${app.data.url}/installations/new`} target="_blank" rel="noreferrer" w="fit-content">Дать доступ к репозиториям</Button>}
        </div>
      ) : (
        <div className="card">
          <Text>Приложение GitHub даёт машинам токены на репозитории кусочков профилей.</Text>
          {admin ? (
            <Group align="end" gap="sm">
              <TextInput label="Организация" placeholder="пусто — в вашем аккаунте" className="mono" value={org} onChange={(e) => setOrg(e.currentTarget.value)} w={260} />
              <Button onClick={() => void create(false)}>Создать приложение GitHub</Button>
            </Group>
          ) : <Text size="sm">Создать его может админ флота.</Text>}
        </div>
      )}
    </Stack>
  );
}

/** Имена для людей: у сессий и у машин. Имя встаёт вместо адреса по всей странице. */
export function Names() {
  const qc = useQueryClient();
  const sessions = useFleet((f) => f.sessions);
  const machines = useFleet((f) => f.machines);
  const labels = useLabels();
  const save = async (key: string, v: string) => (await act(prefsSet, { scope: "fleet", name: "labels", patch: { [key]: v.trim() || null } })) && qc.invalidateQueries({ queryKey: ["prefs.get"] });
  const field = (key: string, what: string) => (
    <TextInput size="xs" aria-label={`Имя для ${what}`} defaultValue={labels[key] ?? ""} key={labels[key] ?? ""}
      onBlur={(e) => e.currentTarget.value !== (labels[key] ?? "") && save(key, e.currentTarget.value)}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.currentTarget.value = labels[key] ?? ""; e.currentTarget.blur(); } }} />
  );
  return (
    <Stack>
      <div className="table-wrap">
        <Table verticalSpacing={6} horizontalSpacing="md" className="stack">
          <Table.Thead><Table.Tr><Table.Th>Машина</Table.Th><Table.Th>Имя для людей</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{Object.keys(machines).sort().map((m) => <Table.Tr key={m}><Table.Td className="mono">{m}</Table.Td><Table.Td>{field("@" + m, m)}</Table.Td></Table.Tr>)}</Table.Tbody>
        </Table>
      </div>
      <div className="table-wrap">
        <Table verticalSpacing={6} horizontalSpacing="md" className="stack">
          <Table.Thead><Table.Tr><Table.Th>Сессия</Table.Th><Table.Th>Имя для людей</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{Object.keys(sessions).sort().map((c) => <Table.Tr key={c}><Table.Td className="mono">{c}</Table.Td><Table.Td>{field(c, c)}</Table.Td></Table.Tr>)}</Table.Tbody>
        </Table>
      </div>
    </Stack>
  );
}

/** Это устройство: кто оно во флоте, его пропуск, уведомления, стирание данных. */
export function Device() {
  const you = useFleet((f) => f.you);
  const me = useCall(whoami, {});
  const kid = isMock ? "k1a2b3" : parsePass(keyStore.get())?.kid ?? "—";
  return (
    <Stack>
      <div className="card">
        <dl className="kv" style={{ maxWidth: 420 }}>
          <dt>Устройство</dt><dd className="mono">{(you?.addr ?? "").split("~")[0]}</dd>
          <dt>Человек</dt><dd>{personWord(you?.person ?? "")}{you?.admin ? " · админ флота" : ""}</dd>
          <dt>Флот</dt><dd className="mono">{me.data?.fleet ?? "…"}</dd>
          <dt>Номер пропуска</dt><dd className="mono">{kid}</dd>
        </dl>
      </div>
      <ThisDevicePush />
      <div className="card">
        <Text fw={600}>Данные на устройстве</Text>
        <Text size="sm">Пропуск, вид списков, свёрнутые проекты и подписка на уведомления.</Text>
        <Button size="xs" variant="default" color="red" w="fit-content" onClick={() => confirmDanger({
          title: "Стереть данные Switchboard на этом устройстве?", confirm: "Стереть",
          body: "Страница забудет пропуск и попросит новое приглашение. Во флоте пропуск останется, пока его не отзовут в «Пропусках».",
          onConfirm: async () => { await wipeDevice(); location.replace(location.pathname + location.search); },
        })}>Стереть данные</Button>
      </div>
    </Stack>
  );
}
