// «Флот → Аккаунты»: аккаунты Claude — годовые токены, заведённые один раз на весь флот, столбцами на общей шкале; рядом — что система сделала с ними сама;
// ниже — провайдеры: ключи флота, каждый открывает каталог своих моделей.
import { accountList, CLAUDE, keyCheck, keysList, keysRemove, keysSet, logQuery, type KeyRow, type LogRow } from "@sb/protocol";
import { ActionIcon, Button, CopyButton, Group, JsonInput, Menu, PasswordInput, Select, Stack, Text, Textarea, TextInput, Tooltip } from "@mantine/core";
import { Page } from "../../shell/Page.tsx";
import { notifications } from "@mantine/notifications";
import { IconArrowsShuffle, IconCalendarWeek, IconCheck, IconCopy, IconDots, IconHourglass, IconKey, IconKeyOff, IconMail, IconPlugConnected, IconPlus, IconSparkles, IconUsers } from "@tabler/icons-react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { act, api } from "../../api.ts";
import { confirmDanger, Failed, useCall } from "../../common.tsx";
import { byReset, columns, limitTone, meterOf, type Column, type LimitRow } from "../../lib/accounts.ts";
import { ago, leftWord, nSessions } from "../../lib/time.ts";
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SETUP = "claude setup-token";
const dateWord = (ms: number) => new Date(ms).toLocaleDateString("ru", { day: "numeric", month: "short", year: "numeric" });
/** Токен живёт год: за месяц до конца срок виден цветом. */
const SOON_MS = 30 * 24 * 60 * 60_000;
const YEAR_MS = 365 * 24 * 60 * 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;
const pct = (x: number) => `${Math.max(0, Math.min(100, Math.round(x * 100)))}%`;

/** Сессии, что идут сейчас на аккаунте или провайдере: точка на сессию, цвет — её состояние; нажатие открывает разговор. */
function SessionDots({ on }: { on: (s: { account?: string; spec: { key?: string } }) => boolean }) {
  const sessions = useFleet((f) => f.sessions);
  const list = Object.values(sessions).filter((s) => on(s) && s.state !== "stopped" && s.state !== "failed");
  const MAX = 14;
  if (!list.length) return null;
  return (
    <span className="sdots" role="group" aria-label={nSessions(list.length)}>
      {list.slice(0, MAX).map((s) => <Link key={s.callsign} to={`/work/${s.callsign}`} className={`lamp ${s.state}`} title={s.callsign} aria-label={s.callsign} />)}
      {list.length > MAX && <span className="sdots-more">+{list.length - MAX}</span>}
    </span>
  );
}

/** Срок годового токена кольцом: дуга — сколько года осталось; за месяц до конца — цветом. Дата — в подсказке. */
function TokenRing({ expires }: { expires: number }) {
  const left = expires - Date.now();
  const r = 7, c = 2 * Math.PI * r;
  const word = left > 0 ? `Токен до ${dateWord(expires)}` : `Токен кончился ${dateWord(expires)}`;
  return (
    <span className={`cacheclock${left <= 0 ? " cold" : left < SOON_MS ? " soon" : ""}`} role="img" aria-label={word} title={word} data-token>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={r} className="track" />
        {left > 0 && <circle cx="9" cy="9" r={r} className="arc" strokeDasharray={`${c * Math.min(1, left / YEAR_MS)} ${c}`} transform="rotate(-90 9 9)" />}
      </svg>
    </span>
  );
}

/** Новый аккаунт или новый токен прежнего: почта и годовой токен, который печатает `claude setup-token`. Токен уходит ключом флота. */
function TokenForm({ email, onDone }: { email?: string; onDone: () => void }) {
  const [name, setName] = useState(email ?? "");
  const [token, setToken] = useState("");
  const ok = EMAIL.test(name.trim()) && token.trim().length > 20;
  const word = email ? "Заменить токен" : "Добавить аккаунт";
  return (
    <Stack gap="sm">
      <TextInput aria-label="Почта аккаунта" placeholder="почта" leftSection={<IconMail size={15} />} disabled={!!email} autoFocus={!email} value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <Group gap={6} wrap="nowrap">
        <Text size="sm" className="mono" style={{ background: "var(--surface-2)", borderRadius: 6, padding: "5px 10px" }}>{SETUP}</Text>
        <CopyButton value={SETUP}>{({ copied, copy }) => <Tooltip label="Копировать команду"><ActionIcon variant="subtle" color="gray" aria-label="Копировать команду" onClick={copy}>{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}</ActionIcon></Tooltip>}</CopyButton>
      </Group>
      <PasswordInput aria-label="Токен" placeholder="sk-ant-oat01-…" className="mono" leftSection={<IconKey size={15} />} autoFocus={!!email} value={token} onChange={(e) => setToken(e.currentTarget.value)} />
      <Tooltip label={word}><ActionIcon size="lg" variant="filled" aria-label={word} disabled={!ok} onClick={async () => (await act(keysSet, { name: name.trim().toLowerCase(), protocol: CLAUDE, value: token.trim() }, email ? "Токен заменён" : "Аккаунт добавлен")) && onDone()}><IconCheck size={18} /></ActionIcon></Tooltip>
    </Stack>
  );
}

/** Столбец аккаунта на общей шкале флота: два столбика — неделя и Fable. Заливка — сколько потрачено; черта поперёк — сколько недели прошло
 *  (заливка выше черты — аккаунт тратится быстрее, чем идёт неделя); штрих сверху — запас недели под Fable; под столбиками — через сколько сброс,
 *  точки сессий, флаг запаса, кольцо срока токена. Негодный токен — красный ключ вместо флага. */
function AccountColumn({ c, admin, onToken, onRemove, onKeep }: { c: Column; admin: boolean; onToken: () => void; onRemove: () => void; /** беречь ли запас недели под Fable */ onKeep: (keep: boolean) => void }) {
  const bad = c.why ?? "Claude не принял токен";
  const keepWord = c.keep ? "Запас недели под Fable бережётся" : "Запас под Fable не бережётся: неделя целиком — любым моделям";
  const { week, fable } = meterOf(c.limits);
  const now = Date.now();
  const reset = week?.resets ?? fable?.resets;
  const pace = reset && reset > now ? Math.max(0, Math.min(1, 1 - (reset - now) / WEEK_MS)) : undefined;
  const bar = (l: LimitRow | undefined, word: string, icon: React.ReactNode) => {
    const share = l?.fable ?? 0;
    return (
      <div className="vcol">
        <span className={`vbar ${l ? limitTone(l.used) : ""}`} role="img" aria-label={l ? `${word}: ${Math.round(l.used * 100)}%` : `${word}: замера нет`} data-limit={word}>
          {l && share > 0 && <i className="share" style={{ height: pct(share) }} />}
          {l && <i className="fill" style={{ height: pct(l.used - share) }} />}
          {l?.hold ? <i className="hold" style={{ height: pct(l.hold) }} /> : null}
          {pace !== undefined && <i className="pace" style={{ bottom: pct(pace) }} />}
        </span>
        <b className={l ? limitTone(l.used) : ""}>{l ? Math.round(l.used * 100) : "—"}</b>
        {icon}
      </div>
    );
  };
  return (
    <div className={`acol${c.ok ? "" : " bad"}`} data-account={c.name}>
      <div className="acol-bars" title={reset && reset > now ? `сброс через ${leftWord(reset, now)}` : undefined}>
        {bar(week, "неделя, все модели", <IconCalendarWeek size={12} aria-hidden />)}
        {bar(fable, "неделя Fable", <IconSparkles size={12} aria-hidden />)}
      </div>
      <div className="acol-name trunc" title={c.name}>{c.name.slice(0, c.name.indexOf("@"))}{c.full && <IconUsers size={12} className="acol-full" aria-label="Аккаунт полон: новые сессии идут на другие" />}</div>
      <div className="acol-left">{c.ok && reset && reset > now ? leftWord(reset, now) : " "}</div>
      <SessionDots on={(s) => s.account === c.name} />
      <div className="acol-foot">
        {c.ok
          ? <Tooltip label={keepWord}><ActionIcon variant={c.keep ? "light" : "subtle"} color="gray" size="sm" aria-label="Беречь запас Fable" aria-pressed={c.keep} disabled={!admin} onClick={() => onKeep(!c.keep)}><IconSparkles size={14} /></ActionIcon></Tooltip>
          : <Tooltip label={bad}><ActionIcon variant="light" color="red" size="sm" aria-label={`${bad}: заменить токен`} disabled={!admin} onClick={onToken}><IconKeyOff size={15} /></ActionIcon></Tooltip>}
        {c.ok && c.expires !== undefined && <TokenRing expires={c.expires} />}
        {admin && (
          <Menu withinPortal position="bottom-end">
            <Menu.Target><ActionIcon variant="subtle" size="sm" aria-label={`Действия: ${c.name}`}><IconDots size={16} /></ActionIcon></Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{c.name}</Menu.Label>
              <Menu.Item onClick={onToken}>Заменить токен</Menu.Item>
              <Menu.Item color="red" onClick={onRemove}>Удалить…</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </div>
    </div>
  );
}

/** Вид события аккаунта — по концу имени строки: moved — переход, full — полон, closed — окно закрыто, token — токен не годен. */
const MOVE_ICON: Record<string, React.ReactNode> = { moved: <IconArrowsShuffle size={14} />, full: <IconUsers size={14} />, closed: <IconHourglass size={14} />, token: <IconKeyOff size={14} /> };
const moveKind = (l: LogRow) => l.msg.slice(l.msg.indexOf(".") + 1);

/** Что система сделала с аккаунтами сама: переходы сессий, полные аккаунты, закрытые окна, негодные токены — строки истории флота. */
function Moves() {
  const q = useCall(logQuery, { msg: "account.", limit: 8 }, { refetch: 60_000 });
  const lines = q.data?.lines ?? [];
  if (!lines.length) return null;
  return (
    <div className="moves" data-card="moves">
      {lines.map((l, i) => (
        <div key={`${l.at}-${i}`} className="line move">
          <span className="move-at">{ago(l.at)}</span>
          <span className={`move-kind ${moveKind(l)}`} aria-hidden>{MOVE_ICON[moveKind(l)]}</span>
          <span className="grow" style={{ overflowWrap: "anywhere" }}>{l.text ?? [l.session, l.account].filter(Boolean).join(" · ")}</span>
          <span className="mono muted move-m">{l.machine}</span>
        </div>
      ))}
    </div>
  );
}

/** Адрес провайдера коротко: только имя узла. */
const hostOf = (base: string) => { try { return new URL(base).host; } catch { return base; } };

/** Виды API провайдера: anthropic — Messages API по адресу; meta — Meta. */
const PROTOCOLS = ["anthropic", "meta"];
type KeyForm = { name: string; protocol: string; value: string; base: string; settings: string; env: string; isNew: boolean };
const formOf = (k?: KeyRow): KeyForm => ({ name: k?.name ?? "", protocol: k?.protocol ?? PROTOCOLS[0]!, value: "", base: k?.base ?? "", settings: k?.settings ? JSON.stringify(k.settings, null, 2) : "", env: pairsText(k?.env), isNew: !k });

/** Поля формы провайдера → ввод keys.set. Значение не задано — правятся только свойства записанного ключа. */
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
  if (f.name.trim() === CLAUDE) return { ok: false, why: "Имя claude занято аккаунтами Claude" };
  if (f.isNew && !f.value) return { ok: false, why: "Нужно значение ключа" };
  const env = parsePairs(f.env);
  return { ok: true, input: { name: f.name.trim(), protocol: f.protocol, ...(f.value ? { value: f.value } : {}), ...(f.base ? { base: f.base } : {}), ...(settings ? { settings } : {}), ...(Object.keys(env).length ? { env } : {}) } };
}

/** Провайдеры: ключ флота открывает весь каталог моделей провайдера; модель выбирают в списке моделей сессии. */
function Providers({ keys, machines, refresh }: { keys: KeyRow[]; machines: string[]; refresh: () => unknown }) {
  const admin = useFleet((f) => !!f.you?.admin);
  const [f, setF] = useState<KeyForm | null>(null);
  const drop = async (k: KeyRow) => {
    // проба: что сейчас идёт на ключе — до удаления
    const probe = await act(keysRemove, { name: k.name, probe: true });
    if (!probe) return;
    const on = probe.sessions ?? [];
    confirmDanger({
      title: `Удалить провайдера ${k.name}?`, confirm: "Удалить",
      body: on.length ? <><span>На нём идёт {nSessions(on.length)}. Они не смогут обращаться к модели:</span><span className="mono">{on.join(", ")}</span></> : "На этом провайдере сейчас нет сессий.",
      onConfirm: async () => (await act(keysRemove, { name: k.name }, "Провайдер удалён")) && refresh(),
    });
  };
  const made = f ? keyInput(f) : null;
  return (
    <div className="card" data-card="providers">
      <Group justify="space-between" wrap="wrap">
        <Text fw={600}>Провайдеры</Text>
        {admin && <Tooltip label="Добавить провайдера"><ActionIcon variant="default" size="sm" aria-label="Добавить провайдера" onClick={() => setF(formOf())}><IconPlugConnected size={15} /></ActionIcon></Tooltip>}
      </Group>
      {keys.map((k) => (
        <div key={k.name} className="line" data-provider={k.name}>
          <div className="grow">
            <Group gap={10} wrap="wrap">
              <Text size="sm" fw={600} className="mono">{k.name}</Text>
              <SessionDots on={(s) => s.spec.key === k.name} />
              {k.base && <Text size="xs" className="muted mono trunc">{hostOf(k.base)}</Text>}
            </Group>
          </div>
          <Menu withinPortal position="bottom-end">
            <Menu.Target><ActionIcon variant="subtle" aria-label={`Действия: провайдер ${k.name}`}><IconDots size={16} /></ActionIcon></Menu.Target>
            <Menu.Dropdown>
              {machines.map((m) => <Menu.Item key={m} onClick={() => act(keyCheck, { to: "@" + m, name: k.name }).then((r) => r && notifications.show({ message: `${m}: ${r.word}`, color: r.ok ? "teal" : "red" }))}>Проверить на <span className="mono">{m}</span></Menu.Item>)}
              {admin && <Menu.Item onClick={() => setF(formOf(k))}>Изменить</Menu.Item>}
              {admin && <Menu.Item color="red" onClick={() => void drop(k)}>Удалить…</Menu.Item>}
            </Menu.Dropdown>
          </Menu>
        </div>
      ))}
      {!keys.length && <Text size="sm" className="muted">Провайдеров нет</Text>}
      <Page name="key" opened={!!f} onClose={() => setF(null)} title={f?.isNew ? "Новый провайдер" : `Провайдер ${f?.name}`}>
        {f && (
          <Stack gap="sm">
            <TextInput label="Имя" className="mono" disabled={!f.isNew} value={f.name} onChange={(e) => setF({ ...f, name: e.currentTarget.value })} />
            <Select label="Протокол" data={[...new Set([...PROTOCOLS, f.protocol])]} value={f.protocol} onChange={(v) => setF({ ...f, protocol: v ?? f.protocol })} allowDeselect={false} />
            <TextInput label="Адрес API" value={f.base} onChange={(e) => setF({ ...f, base: e.currentTarget.value })} />
            <JsonInput label="Настройки сессии" autosize minRows={2} value={f.settings} onChange={(v) => setF({ ...f, settings: v })} />
            <Textarea label="Окружение сессии" placeholder="ИМЯ = значение" autosize minRows={2} className="mono" value={f.env} onChange={(e) => setF({ ...f, env: e.currentTarget.value })} />
            <PasswordInput label={f.isNew ? "Ключ" : "Новый ключ"} value={f.value} onChange={(e) => setF({ ...f, value: e.currentTarget.value })} />
            {made && !made.ok && <Text size="sm" c="red">{made.why}</Text>}
            <Button disabled={!made?.ok} onClick={async () => { if (made?.ok && (await act(keysSet, made.input, "Провайдер сохранён"))) { await refresh(); setF(null); } }}>Сохранить</Button>
          </Stack>
        )}
      </Page>
    </div>
  );
}

export function Accounts() {
  const qc = useQueryClient();
  const admin = useFleet((f) => !!f.you?.admin);
  const machines = useFleet((f) => f.machines);
  const online = Object.values(machines).filter((m) => m.online).map((m) => m.name).sort();
  const keys = useCall(keysList, {});
  // числа аккаунта — общие для флота: их отдаёт одна машина, она же пробует аккаунт, о котором флот не знает свежего
  const list = useCall(accountList, online[0] ? { to: "@" + online[0] } : null);
  const failed = keys.error ?? list.error;
  const cols = byReset(columns(keys.data?.keys ?? [], list.data?.accounts ?? []));
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["keys.list"] }), qc.invalidateQueries({ queryKey: ["account.list"] }), qc.invalidateQueries({ queryKey: ["keys.models"] })]);
  const [form, setForm] = useState<{ email?: string } | null>(null);
  const drop = async (c: Column) => {
    // проба: что сейчас идёт на аккаунте — до удаления
    const probe = await act(keysRemove, { name: c.name, probe: true });
    if (!probe) return;
    const on = probe.sessions ?? [];
    confirmDanger({
      title: `Удалить аккаунт ${c.name}?`, confirm: "Удалить",
      body: on.length ? <><span>На нём идёт {nSessions(on.length)}. Они перейдут на другой аккаунт со следующего вызова модели:</span><span className="mono">{on.join(", ")}</span></> : "На этом аккаунте сейчас нет сессий.",
      onConfirm: async () => (await act(keysRemove, { name: c.name }, "Аккаунт удалён")) && refresh(),
    });
  };
  return (
    <Stack>
      {failed ? <Failed error={failed} retry={() => void refresh()} /> : null}
      <div className="card" data-card="claude">
        <Group justify="space-between" wrap="wrap">
          <Text fw={600}>Claude</Text>
          {admin && <Tooltip label="Добавить аккаунт"><ActionIcon variant="default" size="sm" aria-label="Добавить аккаунт" onClick={() => setForm({})}><IconPlus size={15} /></ActionIcon></Tooltip>}
        </Group>
        <div className="acct-split">
          <div className="acols">
            {cols.map((c) => <AccountColumn key={c.name} c={c} admin={admin} onToken={() => setForm({ email: c.name })} onRemove={() => void drop(c)} onKeep={async (keep) => (await act(keysSet, { name: c.name, protocol: CLAUDE, keep })) && refresh()} />)}
          </div>
          <Moves />
        </div>
        {keys.data && !cols.length && <Text size="sm" className="muted">Аккаунтов нет</Text>}
        <Page name="account" opened={!!form} onClose={() => setForm(null)} title={form?.email ? `Токен ${form.email}` : "Новый аккаунт Claude"}>{form && <TokenForm email={form.email} onDone={() => (setForm(null), void refresh())} />}</Page>
      </div>
      <Providers keys={(keys.data?.keys ?? []).filter((k) => k.protocol !== CLAUDE)} machines={online} refresh={refresh} />
    </Stack>
  );
}
