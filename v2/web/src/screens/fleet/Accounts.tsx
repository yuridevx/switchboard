// «Флот → Аккаунты»: аккаунты Claude одной строкой на все машины с лимитами; очередь выбора на каждой машине; ключи флота.
import { accountCode, accountList, accountLogin, accountRemove, keyCheck, keysList, keysRemove, keysSet, slotSet, slotSwap, type Account, type KeyRow } from "@sb/protocol";
import { ActionIcon, Badge, Button, CopyButton, Group, JsonInput, Menu, Modal, NumberInput, PasswordInput, Progress, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDots, IconGripVertical } from "@tabler/icons-react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { act, api } from "../../api.ts";
import { confirmDanger, Failed, useCall, useMachineName } from "../../common.tsx";
import { limitTone, limitWord, mergeAccounts, otherMail, queueOf, type Merged } from "../../lib/accounts.ts";
import { useRowDrag } from "../../lib/drag.ts";
import { hhmm, LIMIT_NAMES, nSessions } from "../../lib/time.ts";
import { reorder, shift } from "../../lib/work.ts";
import { useFleet } from "../../store/fleet.ts";

/** «a = b» построчно ⇄ запись. Пустые строки и строки без «=» пропускаются. */
export function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && line.slice(0, at).trim()) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}
export const pairsText = (r?: Record<string, string>) => Object.entries(r ?? {}).map(([k, v]) => `${k} = ${v}`).join("\n");

function Login({ machine, expect, onDone }: { machine: string; expect?: string; onDone: (account?: string) => void }) {
  const [step, setStep] = useState<{ login: string; url: string } | null>(null);
  const [code, setCode] = useState("");
  const [done, setDone] = useState<Account | null>(null);
  const qc = useQueryClient();
  if (done) return (
    <Stack gap="sm">
      <Text>Вход выполнен: <b>{done.email ?? done.id}</b>{done.plan ? ` · ${done.plan}` : ""} на <span className="mono">{machine}</span>.</Text>
      {otherMail(expect, done) && <Text c="orange" size="sm">Вошли под другой почтой: ждали {expect}. Прежний вход остался как был.</Text>}
      <Button onClick={() => onDone(done.id)}>Готово</Button>
    </Stack>
  );
  if (!step) return <Button onClick={async () => { const r = await act(accountLogin, { to: "@" + machine }); if (r) setStep(r); }}>Получить ссылку входа</Button>;
  return (
    <Stack gap="sm">
      <Group gap="xs">
        <Button component="a" href={step.url} target="_blank" rel="noreferrer" variant="default">Открыть страницу входа Claude</Button>
        <CopyButton value={step.url}>{({ copied, copy }) => <Button variant="subtle" onClick={copy}>{copied ? "Скопировано" : "Копировать ссылку"}</Button>}</CopyButton>
      </Group>
      {expect && <Text size="sm">Войдите как <b>{expect}</b>.</Text>}
      <TextInput label="Код со страницы входа" className="mono" value={code} onChange={(e) => setCode(e.currentTarget.value)} autoFocus />
      <Button disabled={!code.trim()} onClick={async () => { const r = await act(accountCode, { to: "@" + machine, login: step.login, code: code.trim() }); if (r) { await qc.invalidateQueries({ queryKey: ["account.list"] }); setDone(r.account); } }}>Войти</Button>
    </Stack>
  );
}

/** Строка аккаунта на все машины: лимиты и где он вошёл. */
function MergedRow({ m }: { m: Merged }) {
  const nameOf = useMachineName();
  return (
    <div className="line" style={{ alignItems: "start" }}>
      <div className="grow">
        <Group gap={6} wrap="wrap">
          <Text size="sm" fw={600} className="trunc">{m.email ?? m.id}</Text>
          {m.kind === "key" ? <Badge variant="default">ключ флота</Badge> : m.plan && <Text size="xs" className="muted">{m.plan}</Text>}
          {m.wait !== undefined && <Badge color="orange" variant="light">ждёт сброса до {hhmm(m.wait)}</Badge>}
          {m.sessions > 0 && <Text size="xs" className="muted">{nSessions(m.sessions)}</Text>}
        </Group>
        {m.limits.map((l) => (
          <Group key={l.name} gap={8} wrap="nowrap" mt={3}>
            <Text size="xs" className="muted" w={84}>{LIMIT_NAMES[l.name] ?? l.name}</Text>
            <Progress value={l.used * 100} color={limitTone(l.used)} style={{ flex: 1 }} aria-label={`${LIMIT_NAMES[l.name] ?? l.name}: ${limitWord(l)}`} />
            <Text size="xs" w={104} ta="right" c={limitTone(l.used) === "red" ? "red" : undefined}>{limitWord(l)}</Text>
          </Group>
        ))}
        <Group gap={4} mt={5}>
          {m.seats.map((s) => <Badge key={s.machine} variant={s.account.ok ? "default" : "light"} color={s.account.ok ? undefined : "red"} title={s.account.why}>{nameOf(s.machine)}{s.account.ok ? "" : " ⚠ " + (s.account.why ?? "вход не годен")}</Badge>)}
        </Group>
      </div>
    </div>
  );
}

/** Очередь выбора на машине: порядок перетаскиванием, смена сейчас, убрать из очереди и вернуть, вход. */
function Queue({ machine, list, refresh }: { machine: string; list: Account[]; refresh: () => void }) {
  const nameOf = useMachineName();
  const [login, setLogin] = useState<{ expect?: string } | null>(null);
  const [fresh, setFresh] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const { queue, out } = queueOf(list);
  const order = queue.map((a) => a.id);
  const setOrder = async (next: string[]) => (await act(slotSet, { to: "@" + machine, order: next })) && refresh();
  const drag = useRowDrag({ box, onDrop: ({ id, before }) => void setOrder(reorder(order, id, before)) });
  const swap = async (account?: string) => {
    const r = await act(slotSwap, { to: "@" + machine, ...(account ? { account } : {}) });
    if (r) { notifications.show({ message: `На ${nameOf(machine)} теперь ${r.account}`, color: "teal" }); refresh(); }
  };
  const row = (a: Account, inQueue: boolean) => (
    <div key={a.id} className={`line${a.id === fresh ? " fresh" : ""}${drag.dragging === a.id ? " dragging" : ""}`} {...(inQueue ? { "data-drag-id": a.id, "data-drag-group": "q", onPointerDown: drag.onPointerDown(a.id) } : {})} style={{ touchAction: "pan-y" }}>
      {inQueue && <IconGripVertical size={14} className="muted" style={{ flex: "none", cursor: "grab" }} aria-hidden />}
      <div className="grow">
        <Group gap={6} wrap="wrap">
          {a.current && <span className="lamp idle" style={{ marginTop: 0 }} role="img" aria-label="стоит сейчас" />}
          <Text size="sm" fw={a.current ? 600 : 400} className="trunc">{a.email ?? a.id}</Text>
          {a.wait !== undefined && <Text size="xs" c="orange">ждёт сброса до {hhmm(a.wait)}</Text>}
          {!inQueue && <Text size="xs" className="muted">вне очереди</Text>}
        </Group>
        {!a.ok && <Text size="xs" c="red">{a.why}</Text>}
      </div>
      {!a.ok && <Button size="compact-xs" variant="default" onClick={() => setLogin({ expect: a.email })}>Войти заново</Button>}
      <Menu withinPortal position="bottom-end">
        <Menu.Target><ActionIcon variant="subtle" aria-label={`Действия: ${a.email ?? a.id}`}><IconDots size={16} /></ActionIcon></Menu.Target>
        <Menu.Dropdown>
          {inQueue && !a.current && a.ok && <Menu.Item onClick={() => void swap(a.id)}>Поставить сейчас</Menu.Item>}
          {inQueue && <Menu.Item disabled={order.indexOf(a.id) === 0} onClick={() => void setOrder(shift(order, a.id, -1))}>Выше в очереди</Menu.Item>}
          {inQueue && <Menu.Item disabled={order.indexOf(a.id) === order.length - 1} onClick={() => void setOrder(shift(order, a.id, 1))}>Ниже в очереди</Menu.Item>}
          {inQueue ? <Menu.Item onClick={() => void setOrder(order.filter((x) => x !== a.id))}>Убрать из очереди</Menu.Item> : <Menu.Item onClick={() => void setOrder([...order, a.id])}>В очередь</Menu.Item>}
          <Menu.Item onClick={() => setLogin({ expect: a.email })}>Войти заново</Menu.Item>
          <Menu.Item color="red" onClick={() => confirmDanger({ title: `Убрать ${a.email ?? a.id} с ${machine}?`, body: a.sessions ? `На нём идёт ${nSessions(a.sessions)}. Они перейдут на другой аккаунт очереди или остановятся.` : "Вход на этой машине будет стёрт.", confirm: "Убрать", onConfirm: async () => (await act(accountRemove, { to: "@" + machine, account: a.id }, "Аккаунт убран")) && refresh() })}>Убрать с машины</Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </div>
  );
  return (
    <div className="card">
      <Group justify="space-between" wrap="nowrap">
        <Text fw={600} className="trunc">{nameOf(machine)}</Text>
        <Group gap={6} wrap="nowrap">
          {queue.length > 1 && <Button size="compact-xs" variant="subtle" onClick={() => void swap()}>Сменить на следующего</Button>}
          <Button size="compact-xs" variant="default" onClick={() => setLogin({})}>Войти</Button>
        </Group>
      </Group>
      <div ref={box} className="dragbox" data-drop-group="q">
        {drag.line !== null && <div className="dragline" style={{ top: drag.line }} />}
        {queue.map((a) => row(a, true))}
      </div>
      {out.length > 0 && <div>{out.map((a) => row(a, false))}</div>}
      {!queue.length && !out.length && <Text size="sm" className="muted">Входов Claude нет</Text>}
      <Modal opened={!!login} onClose={() => setLogin(null)} title={`Вход Claude на ${machine}`}>{login && <Login machine={machine} expect={login.expect} onDone={(id) => (setLogin(null), setFresh(id ?? ""), refresh())} />}</Modal>
    </div>
  );
}

type KeyForm = { name: string; provider: string; value: string; base: string; model: string; models: string; window: number | ""; settings: string; env: string; isNew: boolean };
const formOf = (k?: KeyRow): KeyForm => ({ name: k?.name ?? "", provider: k?.provider ?? "openai-compatible", value: "", base: k?.base ?? "", model: k?.model ?? "", models: pairsText(k?.models), window: k?.window ?? "", settings: k?.settings ? JSON.stringify(k.settings, null, 2) : "", env: pairsText(k?.env), isNew: !k });

/** Поля формы ключа → ввод keys.set. Значение не задано — правятся только свойства записанного ключа. */
export function keyInput(f: KeyForm): { ok: true; input: Parameters<typeof api.call<typeof keysSet>>[1] } | { ok: false; why: string } {
  let settings: Record<string, unknown> | undefined;
  if (f.settings.trim()) {
    try {
      settings = JSON.parse(f.settings);
    } catch {
      return { ok: false, why: "Настройки сессии — не JSON" };
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { ok: false, why: "Настройки сессии — объект JSON" };
  }
  if (!f.name.trim()) return { ok: false, why: "Нужно имя ключа" };
  if (f.isNew && !f.value) return { ok: false, why: "Нужно значение ключа" };
  const models = parsePairs(f.models), env = parsePairs(f.env);
  return { ok: true, input: {
    name: f.name.trim(), provider: f.provider, ...(f.value ? { value: f.value } : {}), ...(f.base ? { base: f.base } : {}), ...(f.model ? { model: f.model } : {}),
    ...(Object.keys(models).length ? { models } : {}), ...(f.window !== "" ? { window: Number(f.window) } : {}), ...(settings ? { settings } : {}), ...(Object.keys(env).length ? { env } : {}),
  } };
}

function FleetKeys({ machines }: { machines: string[] }) {
  const qc = useQueryClient();
  const admin = useFleet((f) => !!f.you?.admin);
  const keys = useCall(keysList, {});
  const [f, setF] = useState<KeyForm | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["keys.list"] });
  const drop = async (k: KeyRow) => {
    // проба: что сейчас идёт на ключе — до удаления
    const probe = await act(keysRemove, { name: k.name, probe: true });
    if (!probe) return;
    const on = probe.sessions ?? [];
    confirmDanger({
      title: `Удалить ключ ${k.name}?`, confirm: "Удалить",
      body: on.length ? <><span>На этом ключе идёт {nSessions(on.length)}. Они не смогут обращаться к модели:</span><span className="mono">{on.join(", ")}</span></> : "На этом ключе сейчас нет сессий.",
      onConfirm: async () => (await act(keysRemove, { name: k.name }, "Ключ удалён")) && refresh(),
    });
  };
  const made = f ? keyInput(f) : null;
  return (
    <div className="card">
      <Group justify="space-between"><Text fw={600}>Ключи флота</Text>{admin && <Button size="compact-xs" variant="default" onClick={() => setF(formOf())}>Добавить ключ</Button>}</Group>
      {keys.error && <Failed error={keys.error} retry={keys.refetch} />}
      {(keys.data?.keys ?? []).map((k) => (
        <div key={k.name} className="line">
          <div className="grow">
            <Group gap={6} wrap="wrap"><Text size="sm" fw={500} className="mono trunc">{k.name}</Text>{!!k.sessions && <Text size="xs" className="muted">{nSessions(k.sessions)}</Text>}</Group>
            <Text size="xs" className="muted" style={{ overflowWrap: "anywhere" }}>{k.provider}{k.model ? ` · ${k.model}` : ""}{k.base ? ` · ${k.base}` : ""} · {k.tail}</Text>
            {k.models && Object.keys(k.models).length > 0 && <Text size="xs" className="mono muted" style={{ overflowWrap: "anywhere" }}>{Object.entries(k.models).map(([a, b]) => `${a} → ${b}`).join(", ")}</Text>}
          </div>
          <Menu withinPortal position="bottom-end">
            <Menu.Target><ActionIcon variant="subtle" aria-label={`Действия: ключ ${k.name}`}><IconDots size={16} /></ActionIcon></Menu.Target>
            <Menu.Dropdown>
              {machines.map((m) => <Menu.Item key={m} onClick={() => act(keyCheck, { to: "@" + m, name: k.name }).then((r) => r && notifications.show({ message: `${m}: ${r.word}`, color: r.ok ? "teal" : "red" }))}>Проверить на <span className="mono">{m}</span></Menu.Item>)}
              {admin && <Menu.Item onClick={() => setF(formOf(k))}>Изменить</Menu.Item>}
              {admin && <Menu.Item color="red" onClick={() => void drop(k)}>Удалить…</Menu.Item>}
            </Menu.Dropdown>
          </Menu>
        </div>
      ))}
      {keys.data && !keys.data.keys.length && <Text size="sm" className="muted">Ключей нет</Text>}
      <Modal opened={!!f} onClose={() => setF(null)} title={f?.isNew ? "Новый ключ флота" : `Ключ ${f?.name}`}>
        {f && (
          <Stack gap="sm">
            <TextInput label="Имя" className="mono" disabled={!f.isNew} value={f.name} onChange={(e) => setF({ ...f, name: e.currentTarget.value })} />
            <Select label="Провайдер" data={["anthropic", "openai-compatible", "meta"]} value={f.provider} onChange={(v) => setF({ ...f, provider: v ?? f.provider })} allowDeselect={false} />
            <TextInput label="Адрес API" value={f.base} onChange={(e) => setF({ ...f, base: e.currentTarget.value })} />
            <TextInput label="Модель по умолчанию" className="mono" value={f.model} onChange={(e) => setF({ ...f, model: e.currentTarget.value })} />
            <Textarea label="Соответствие моделей" placeholder="claude-fable-5-2 = glm-5.3" autosize minRows={2} className="mono" value={f.models} onChange={(e) => setF({ ...f, models: e.currentTarget.value })} />
            <NumberInput label="Окно контекста, токены" value={f.window} onChange={(v) => setF({ ...f, window: v === "" ? "" : Number(v) })} min={1000} step={1000} />
            <JsonInput label="Настройки сессии на этом ключе" autosize minRows={2} value={f.settings} onChange={(v) => setF({ ...f, settings: v })} />
            <Textarea label="Окружение сессии" placeholder="ИМЯ = значение" autosize minRows={2} className="mono" value={f.env} onChange={(e) => setF({ ...f, env: e.currentTarget.value })} />
            <PasswordInput label={f.isNew ? "Ключ" : "Новое значение ключа"} placeholder={f.isNew ? undefined : "оставьте пустым, чтобы не менять"} value={f.value} onChange={(e) => setF({ ...f, value: e.currentTarget.value })} />
            {made && !made.ok && <Text size="sm" c="red">{made.why}</Text>}
            <Button disabled={!made?.ok} onClick={async () => { if (made?.ok && (await act(keysSet, made.input, "Ключ сохранён"))) { await refresh(); setF(null); } }}>Сохранить</Button>
          </Stack>
        )}
      </Modal>
    </div>
  );
}

export function Accounts() {
  const qc = useQueryClient();
  const machines = useFleet((f) => f.machines);
  const online = Object.values(machines).filter((m) => m.online).map((m) => m.name).sort();
  // один опрос на машину: и строки аккаунтов, и очереди берут из него
  const lists = useQueries({ queries: online.map((m) => ({ queryKey: ["account.list", { to: "@" + m }], queryFn: () => api.call(accountList, { to: "@" + m }), retry: false })) });
  const byMachine = Object.fromEntries(online.map((m, i) => [m, lists[i]?.data?.accounts ?? []]));
  const failed = lists.find((q) => q.error);
  const merged = mergeAccounts(byMachine).filter((m) => m.kind === "claude");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["account.list"] });
  return (
    <Stack>
      {failed?.error ? <Failed error={failed.error} retry={refresh} /> : null}
      <div className="card">
        <Text fw={600}>Аккаунты Claude</Text>
        {merged.map((m) => <MergedRow key={m.id} m={m} />)}
        {!merged.length && <Text size="sm" className="muted">Входов нет. Войдите в аккаунт на машине ниже.</Text>}
      </div>
      <p className="sect">Очередь выбора на машинах</p>
      <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
        {online.map((m) => <Queue key={m} machine={m} list={byMachine[m] ?? []} refresh={refresh} />)}
      </div>
      <FleetKeys machines={online} />
    </Stack>
  );
}
