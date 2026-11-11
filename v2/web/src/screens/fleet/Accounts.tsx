// «Флот → Аккаунты»: аккаунты Claude одной строкой на все машины с лимитами; машины строками, очереди аккаунтов машины — колонками; ключи флота.
import { accountCode, accountList, accountLogin, accountRemove, keyCheck, keysList, keysRemove, keysSet, slotSet, slotSwap, type Account, type KeyRow, type Lane, type Slot } from "@sb/protocol";
import { ActionIcon, Badge, Button, Checkbox, CopyButton, Group, JsonInput, Menu, NumberInput, PasswordInput, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { Page } from "../../shell/Page.tsx";
import { notifications } from "@mantine/notifications";
import { IconDots, IconGripVertical, IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { act, api } from "../../api.ts";
import { confirmDanger, Failed, useCall, useMachineName } from "../../common.tsx";
import { AccountView } from "../../lib/AccountView.tsx";
import { accountKey, diverge, dropFromQueues, machineOrder, mergeAccounts, otherMail, pollPlan, queueMove, type Merged } from "../../lib/accounts.ts";
import { useRowDrag } from "../../lib/drag.ts";
import { nudge } from "../../lib/Sortable.tsx";
import { ago, nSessions, resetWord } from "../../lib/time.ts";
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

/** Строка аккаунта на все машины: лимиты и где он вошёл. Нажатие на имя подсвечивает его во всех очередях. */
function MergedRow({ m, marked, onMark, picked, onPick, onLogin, onRemove }: { m: Merged; marked: boolean; onMark: () => void; picked: boolean; onPick: (on: boolean) => void; onLogin: (machine: string) => void; onRemove: (machine: string) => void }) {
  const nameOf = useMachineName();
  const [why, setWhy] = useState(false);
  const split = diverge(m);
  return (
    <div className={`line${marked ? " marked" : ""}`} style={{ padding: "5px 0" }}>
      <Checkbox aria-label={`Выбрать ${m.email ?? m.id}`} checked={picked} onChange={(e) => onPick(e.currentTarget.checked)} />
      <div className="grow">
        <AccountView full name={<button type="button" className="linklike" aria-pressed={marked} onClick={onMark}>{m.email ?? m.id}</button>} plan={m.plan} limits={m.limits}>
          {split.length > 0 && <button type="button" className="warnmark" aria-expanded={why} aria-label="Машины говорят разное" onClick={() => setWhy(!why)}>⚠</button>}
          <span className="seats">{m.seats.filter((s) => !s.account.ok).map((s) => <Badge key={s.machine} size="sm" variant="light" color="red">{nameOf(s.machine)} ⚠ {s.account.why ?? "вход не годен"}</Badge>)}</span>
          <span className="grow" />
          <Menu withinPortal position="bottom-end">
            <Menu.Target><ActionIcon variant="subtle" size="sm" aria-label={`Действия: ${m.email ?? m.id}`}><IconDots size={16} /></ActionIcon></Menu.Target>
            <Menu.Dropdown>
              {m.seats.map((s) => <Menu.Item key={"in" + s.machine} onClick={() => onLogin(s.machine)}>Войти заново на {nameOf(s.machine)}</Menu.Item>)}
              {m.seats.map((s) => <Menu.Item key={"rm" + s.machine} color="red" onClick={() => onRemove(s.machine)}>Убрать с {nameOf(s.machine)}</Menu.Item>)}
            </Menu.Dropdown>
          </Menu>
        </AccountView>
        {why && split.map((w) => <Text key={w} size="xs" c="orange" className="mono" style={{ overflowWrap: "anywhere" }}>{w}</Text>)}
      </div>
    </div>
  );
}

const rowId = (queue: string, mail: string) => queue + "|" + mail;
const partsOf = (id: string) => [id.slice(0, id.indexOf("|")), id.slice(id.indexOf("|") + 1)] as const;

/** Новая очередь: имя и входы по порядку — как их отметили. */
function NewQueue({ machine, logins, taken, onDone }: { machine: string; logins: Account[]; taken: string[]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [order, setOrder] = useState<string[]>([]);
  const clash = taken.includes(name);
  return (
    <Stack gap="sm">
      <TextInput label="Имя очереди" className="mono" autoFocus value={name} onChange={(e) => setName(e.currentTarget.value.toLowerCase())} error={clash ? "Такая очередь уже есть" : undefined} />
      <div>
        <Text size="sm" fw={500} mb={4}>Аккаунты по порядку выбора</Text>
        <Stack gap={6}>
          {logins.map((a) => (
            <Checkbox key={a.id} disabled={!a.ok} checked={order.includes(a.id)} onChange={(e) => setOrder(e.currentTarget.checked ? [...order, a.id] : order.filter((x) => x !== a.id))}
              label={<span>{order.includes(a.id) && <b className="mono">{order.indexOf(a.id) + 1} · </b>}{a.email ?? a.id}{a.ok ? "" : " — " + (a.why ?? "входа нет")}</span>} />
          ))}
        </Stack>
      </div>
      <Button style={{ alignSelf: "flex-start" }} disabled={!name || clash || !order.length} onClick={async () => (await act(slotSet, { to: "@" + machine, slot: name, order }, `Очередь ${name} заведена`)) && onDone()}>Завести очередь</Button>
    </Stack>
  );
}

/** Машина: её очереди аккаунтов и её входы. Строка аккаунта переносится внутри очереди, между очередями и из входов в очередь — мышью и пальцем. */
function MachineQueues({ machine, list, slots, refresh, marked }: { machine: string; list: Account[]; slots: Slot[]; refresh: () => void; marked: string }) {
  const nameOf = useMachineName();
  const [login, setLogin] = useState<{ expect?: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const logins = list.filter((a) => a.kind === "claude");
  const byId = Object.fromEntries(logins.map((a) => [a.id, a]));
  const apply = async (changes: Array<{ slot: string; order: string[] }>) => {
    for (const c of changes) if (!(await act(slotSet, { to: "@" + machine, ...c }))) break;
    refresh();
  };
  const drag = useRowDrag({ box, onDrop: ({ id, before, group }) => { const [from, mail] = partsOf(id); void apply(queueMove(slots, from || null, group, mail, before ? partsOf(before)[1] : null)); } });
  /** Поставить место очереди на этот аккаунт: лампа у полоски Fable — место Fable, у недели — место остальных моделей. */
  const swap = async (slot: string, lane: Lane, account: string) => {
    const r = await act(slotSwap, { to: "@" + machine, slot, lane, account });
    if (r) { notifications.show({ message: `${slot} на ${nameOf(machine)}: ${lane === "fable" ? "Fable" : "остальные модели"} — на ${r.account}`, color: "teal" }); refresh(); }
  };
  return (
    <div className="card mrow">
      <div className="mrow-head">
        <Text fw={600} className="trunc" maw="100%">{nameOf(machine)}</Text>
        <Group gap={6} wrap="nowrap">
          <Button size="compact-xs" variant="default" disabled={!logins.some((a) => a.ok)} onClick={() => setAdding(true)}>+ очередь</Button>
          <Button size="compact-xs" variant="default" onClick={() => setLogin({})}>Войти</Button>
        </Group>
      </div>
      <div ref={box} className="dragbox queues">
        {drag.line !== null && <div className="dragline" style={{ top: drag.line, ...(drag.span ? { left: drag.span.left, width: drag.span.width, right: "auto" } : {}) }} />}
        {slots.map((q) => {
          return (
            <div key={q.name} className="queue" data-drop-group={q.name} data-queue={q.name}>
              <div className="queue-head">
                <Text fw={600} className="mono">{q.name}</Text>
                {q.sessions > 0 && <Text size="xs" className="muted">{nSessions(q.sessions)}</Text>}
                {q.lanes.fable.wait !== undefined && <Badge size="sm" color="orange" variant="light" data-chip="fable-wait">Fable ждёт до {resetWord(q.lanes.fable.wait)}</Badge>}
                {q.lanes.other.wait !== undefined && <Badge size="sm" color="orange" variant="light" data-chip="other-wait">остальные ждут до {resetWord(q.lanes.other.wait)}</Badge>}
                {q.lanes.other.over && <Badge size="sm" color="orange" variant="light" data-chip="over">остальные — из запаса Fable</Badge>}
                <span className="grow" />
                {logins.some((x) => x.ok && !q.order.includes(x.id)) && (
                  <Menu withinPortal position="bottom-end">
                    <Menu.Target><ActionIcon variant="subtle" color="gray" size="sm" aria-label={`Добавить аккаунт в ${q.name}`} title="Добавить аккаунт"><IconPlus size={14} /></ActionIcon></Menu.Target>
                    <Menu.Dropdown>{logins.filter((x) => x.ok && !q.order.includes(x.id)).map((x) => <Menu.Item key={x.id} onClick={() => void apply(queueMove(slots, null, q.name, x.id, null))}>{x.email ?? x.id}</Menu.Item>)}</Menu.Dropdown>
                  </Menu>
                )}
                <ActionIcon variant="subtle" color="red" size="sm" disabled={q.sessions > 0} title={q.sessions > 0 ? "На очереди идут сессии" : "Удалить очередь"} aria-label={`Удалить очередь ${q.name}`}
                  onClick={() => confirmDanger({ title: `Удалить очередь ${q.name} на ${machine}?`, body: "Входы аккаунтов останутся на машине.", confirm: "Удалить", onConfirm: async () => (await act(slotSet, { to: "@" + machine, slot: q.name, order: [] }, "Очередь удалена")) && refresh() })}><IconTrash size={14} /></ActionIcon>
              </div>
              {q.order.map((mail) => {
                const a = byId[mail];
                const stands = { fable: q.lanes.fable.account === mail && q.lanes.fable.wait === undefined, other: q.lanes.other.account === mail && q.lanes.other.wait === undefined };
                return (
                  <div key={mail} className={`line${accountKey({ kind: "claude", id: mail, email: mail }) === marked ? " marked" : ""}${drag.dragging === rowId(q.name, mail) ? " dragging" : ""}`} data-drag-id={rowId(q.name, mail)} data-drag-group={q.name} onPointerDown={drag.onPointerDown(rowId(q.name, mail))} style={{ touchAction: "pan-y" }}>
                    <span className="grip" role="button" tabIndex={0} aria-label={`Порядок в ${q.name}: ${mail}`} title="Перетащите; с клавиатуры — Alt и стрелки" onKeyDown={(e) => { if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return; e.preventDefault(); void apply([{ slot: q.name, order: nudge(q.order, mail, e.key === "ArrowUp" ? -1 : 1) }]); }}><IconGripVertical size={14} /></span>
                    <div className="grow"><AccountView name={mail} stands={stands} onPut={a?.ok ? (lane) => void swap(q.name, lane, mail) : undefined} limits={a?.limits ?? []} bad={a && !a.ok ? a.why ?? "вход не годен" : undefined} /></div>
                    {a && !a.ok && <Button size="compact-xs" variant="default" onClick={() => setLogin({ expect: a.email })}>Войти</Button>}
                    <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`Убрать ${mail} из ${q.name}`} onClick={() => void apply([{ slot: q.name, order: q.order.filter((m) => m !== mail) }])}><IconX size={14} /></ActionIcon>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <Page name="login" opened={!!login} onClose={() => setLogin(null)} title={`Вход Claude на ${machine}`}>{login && <Login machine={machine} expect={login.expect} onDone={() => (setLogin(null), refresh())} />}</Page>
      <Page name="queue" opened={adding} onClose={() => setAdding(false)} title={`Новая очередь на ${machine}`}>{adding && <NewQueue machine={machine} logins={logins} taken={slots.map((q) => q.name)} onDone={() => (setAdding(false), refresh())} />}</Page>
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
      <Page name="key" opened={!!f} onClose={() => setF(null)} title={f?.isNew ? "Новый ключ флота" : `Ключ ${f?.name}`}>
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
      </Page>
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
  const slots = Object.fromEntries(online.map((m, i) => [m, lists[i]?.data?.slots ?? []]));
  const failed = lists.find((q) => q.error);
  const merged = mergeAccounts(byMachine).filter((m) => m.kind === "claude");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["account.list"] });
  /** подсвеченный аккаунт: виден во всех очередях машин */
  const [marked, setMarked] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [relogin, setRelogin] = useState<{ machine: string; expect?: string } | null>(null);
  const gone = Object.values(machines).filter((m) => !m.online).sort((a, b) => a.name.localeCompare(b.name));
  /** Выбранные аккаунты — из всех очередей на всех машинах. */
  const drop = async () => {
    const plan = dropFromQueues(slots, picked.map((k) => k.slice(k.indexOf(":") + 1)));
    for (const { machine, slot, order } of plan) if (!(await act(slotSet, { to: "@" + machine, slot, order }))) break;
    notifications.show({ message: plan.length ? `Убрано из очередей: ${plan.map((p) => `${p.slot}@${p.machine}`).join(", ")}` : "В очередях их и не было", color: "teal" });
    setPicked([]);
    refresh();
  };
  return (
    <Stack>
      {failed?.error ? <Failed error={failed.error} retry={refresh} /> : null}
      <div className="card">
        <Group justify="space-between" wrap="wrap">
          <Text fw={600}>Аккаунты Claude</Text>
          <Group gap={6} wrap="wrap">
            {picked.length > 0 && <Button size="compact-xs" variant="default" onClick={() => void drop()}>Убрать из очередей</Button>}
            <Button size="compact-xs" variant="subtle" onClick={() => {
              // один опрос на почту с устаревшим замером, на минимуме машин; свежее не трогаем
              const plan = pollPlan(byMachine);
              for (const m of plan.length ? plan : online) void qc.invalidateQueries({ queryKey: ["account.list", { to: "@" + m }] });
            }}>Опросить лимиты</Button>
          </Group>
        </Group>
        {merged.map((m) => { const key = accountKey(m); return <MergedRow key={key} m={m} marked={marked === key} onMark={() => setMarked(marked === key ? "" : key)} picked={picked.includes(key)} onPick={(on) => setPicked(on ? [...picked, key] : picked.filter((x) => x !== key))}
          onLogin={(machine) => setRelogin({ machine, expect: m.email })}
          onRemove={(machine) => confirmDanger({ title: `Убрать ${m.email ?? m.id} с ${machine}?`, body: "Аккаунт уйдёт из очередей этой машины; сессии на них перейдут на следующий аккаунт очереди.", confirm: "Убрать", onConfirm: async () => (await act(accountRemove, { to: "@" + machine, account: m.id }, "Аккаунт убран")) && refresh() })} />; })}
        <Page name="relogin" opened={!!relogin} onClose={() => setRelogin(null)} title={`Вход Claude на ${relogin?.machine}`}>{relogin && <Login machine={relogin.machine} expect={relogin.expect} onDone={() => (setRelogin(null), refresh())} />}</Page>
        {!merged.length && <Text size="sm" className="muted">Входов нет. Войдите в аккаунт на машине ниже.</Text>}
      </div>
      <div className="rows">
        {machineOrder(byMachine).map((m) => <MachineQueues key={m} machine={m} list={byMachine[m] ?? []} slots={slots[m] ?? []} refresh={refresh} marked={marked} />)}
        {gone.map((m) => <div key={m.name} className="card off mline"><Text fw={600} className="trunc">{m.name}</Text><Text size="sm" c="red" style={{ whiteSpace: "nowrap" }}>ушла {ago(m.since)}</Text><Text size="sm" className="muted">Очереди покажутся, когда машина вернётся</Text></div>)}
      </div>
      <FleetKeys machines={online} />
    </Stack>
  );
}
