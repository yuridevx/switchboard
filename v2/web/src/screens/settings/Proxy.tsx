// «Настройки → Правила прокси»: правила замены текста запросов к модели. Форма правила — та, что читает прокси Host (ProxyRule);
// проверка на тексте идёт запросом rules.test — движок на странице не повторяется.
import { pointsCall, pointsCalls, prefsGet, prefsSet, PROXY_RULES, ProxyRule, rulesTest, type OutputOf } from "@sb/protocol";
import { ActionIcon, Badge, Button, Chip, Group, SegmentedControl, Select, Stack, Switch, TagsInput, Text, Textarea, TextInput } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconGripVertical, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { act } from "../../api.ts";
import { confirmDanger, Failed, modelWord, useCall } from "../../common.tsx";
import { useRowDrag } from "../../lib/drag.ts";
import { day, hhmm } from "../../lib/time.ts";
import { reorder, shift } from "../../lib/work.ts";
import { useFleet } from "../../store/fleet.ts";

type Rule = ProxyRule;
type Tested = OutputOf<typeof rulesTest>;
const SCOPES: Array<[Rule["scopes"][number], string]> = [["system", "Промпт"], ["user", "Сообщения человека"], ["assistant", "Ответы модели"], ["tool_result", "Ответы инструментов"]];
const UNITS: Array<[Rule["unit"], string]> = [["match", "совпадение"], ["line", "строку"], ["paragraph", "абзац"], ["block", "весь блок"]];
export const newRule = (): Rule => ({ name: "Новое правило", on: false, scopes: ["user", "tool_result"], kind: "literal", unit: "match", action: "replace", pattern: "", replacement: "" });

/** Правило одной строкой: где ищет и что делает. */
export function ruleLine(r: Rule): string {
  const where = r.scopes.map((s) => SCOPES.find(([id]) => id === s)?.[1].toLowerCase() ?? s).join(", ");
  const what = r.action === "delete" ? `удаляет ${UNITS.find(([id]) => id === r.unit)?.[1]}` : `заменяет ${UNITS.find(([id]) => id === r.unit)?.[1]} на «${r.replacement ?? ""}»`;
  return `${r.kind === "regex" ? "выражение" : "текст"} «${r.pattern}» · ${where} · ${what}${r.models?.length ? ` · модели ${r.models.join(", ")}` : ""}`;
}
/** Части вызова модели для проверки: системный промпт и последние сообщения разговора до ответа; у каждой — где её ищут правила. */
export type CallPart = { id: string; word: string; scope: Rule["scopes"][number]; text: string };
export function callParts(c: { system: string; messages: Array<{ n: number; role: string; text: string }> } | undefined, last = 6): CallPart[] {
  if (!c) return [];
  const scopeOf = (role: string): Rule["scopes"][number] => (role === "assistant" ? "assistant" : role === "tool" || role === "tool_result" ? "tool_result" : "user");
  const word = (role: string) => (role === "assistant" ? "Модель" : role === "tool" || role === "tool_result" ? "Инструмент" : "Человек");
  return [
    ...(c.system ? [{ id: "system", word: "Промпт", scope: "system" as const, text: c.system }] : []),
    ...c.messages.filter((m) => m.text.trim()).slice(-last).map((m) => ({ id: "m" + m.n, word: `${word(m.role)} · ${m.n + 1}`, scope: scopeOf(m.role), text: m.text })),
  ];
}

/** Разница построчно: что правила убрали и что поставили. Одинаковые строки идут как есть. */
export function lineDiff(before: string, after: string): Array<{ kind: "same" | "del" | "add"; text: string }> {
  const a = before.split("\n"), b = after.split("\n");
  // длина общей подпоследовательности строк
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Array<{ kind: "same" | "del" | "add"; text: string }> = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: "del", text: a[i++]! });
    else out.push({ kind: "add", text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}

/** Вызов модели из архива, открытый параметром call=<сессия>/<вызов>: его текст встаёт в проверку правил. */
export function callRef(param: string | null): { sid: string; call: string } | null {
  const at = param?.lastIndexOf("/") ?? -1;
  return param && at > 0 && at < param.length - 1 ? { sid: param.slice(0, at), call: param.slice(at + 1) } : null;
}

/** Чего не хватает правилу, чтобы его записать; годное — пусто. */
export function ruleFlaw(r: Rule): string {
  const p = ProxyRule.safeParse(r);
  if (p.success) return "";
  const at = p.error.issues[0]?.path[0];
  return at === "pattern" ? "нечего искать" : at === "scopes" ? "не выбрано, где искать" : at === "name" ? "нет названия" : "правило не разобрано";
}

function Editor({ r, set }: { r: Rule; set: (p: Partial<Rule>) => void }) {
  return (
    <Stack gap="sm" py="sm">
      <TextInput label="Название" value={r.name} onChange={(e) => set({ name: e.currentTarget.value })} />
      <div>
        <Text size="sm" fw={500} mb={4}>Где искать</Text>
        <Chip.Group multiple value={r.scopes} onChange={(v) => set({ scopes: v as Rule["scopes"] })}><Group gap={6}>{SCOPES.map(([id, word]) => <Chip key={id} value={id} size="xs">{word}</Chip>)}</Group></Chip.Group>
      </div>
      <Group align="end" gap="sm">
        <SegmentedControl value={r.kind} onChange={(v) => set({ kind: v as Rule["kind"] })} data={[{ value: "literal", label: "Текст" }, { value: "regex", label: "Выражение RE2" }]} aria-label="Что искать" />
        <Switch label="Без учёта регистра" checked={!!r.icase} onChange={(e) => set({ icase: e.currentTarget.checked })} />
      </Group>
      <TextInput label="Что искать" className="mono" value={r.pattern} onChange={(e) => set({ pattern: e.currentTarget.value })} />
      <Group align="end" gap="sm">
        <Select label="Что править" data={UNITS.map(([value, label]) => ({ value, label }))} value={r.unit} onChange={(v) => v && set({ unit: v as Rule["unit"] })} allowDeselect={false} w={170} />
        <SegmentedControl value={r.action} onChange={(v) => set({ action: v as Rule["action"] })} data={[{ value: "replace", label: "Заменить" }, { value: "delete", label: "Удалить" }]} aria-label="Что сделать" />
      </Group>
      {r.action === "replace" && <TextInput label="На что заменить" className="mono" value={r.replacement ?? ""} onChange={(e) => set({ replacement: e.currentTarget.value })} />}
      <TagsInput label="Только для моделей" placeholder="claude-*  — пусто: для всех" className="mono" value={r.models ?? []} onChange={(v) => set({ models: v.length ? v : undefined })} />
    </Stack>
  );
}

export function ProxyRules() {
  const qc = useQueryClient();
  const admin = useFleet((f) => !!f.you?.admin);
  const machines = useFleet((f) => f.machines);
  const online = Object.values(machines).filter((m) => m.online).map((m) => m.name);
  const prefs = useCall(prefsGet, { scope: "fleet", prefix: "proxy." });
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [probe, setProbe] = useState("Счёт для ООО «Ромашка» лежит на internal.example.com");
  const [scope, setScope] = useState<Rule["scopes"][number]>("user");
  const [machine, setMachine] = useState<string | null>(online[0] ?? null);
  const [tested, setTested] = useState<Tested | null>(null);
  const [model, setModel] = useState("");
  useEffect(() => { if (prefs.data && !rules) setRules((prefs.data.values[PROXY_RULES] as Rule[] | undefined) ?? []); }, [prefs.data, rules]);
  // вызов модели из архива: его текст — в проверку
  const [sp] = useSearchParams();
  const ref = callRef(sp.get("call"));
  const calls = useCall(pointsCalls, ref ? { sid: ref.sid, ...(sp.get("point") ? { point: sp.get("point")! } : {}) } : null);
  const call = ref ? (calls.data?.calls.find((c) => c.call === ref.call) as (NonNullable<typeof calls.data>["calls"][number] & { text?: string; system?: string }) | undefined) : undefined;
  // текст вызова — у архива: системный промпт и сообщения до ответа; часть выбирается чипом
  const body = useCall(pointsCall, ref ? { sid: ref.sid, call: ref.call, ...(sp.get("point") ? { point: sp.get("point")! } : {}) } : null);
  const parts = callParts(body.data);
  const [part, setPart] = useState("");
  const take = (p: CallPart | undefined) => {
    setPart(p?.id ?? "");
    if (p) { setProbe(p.text); setScope(p.scope); }
    setTested(null);
  };
  useEffect(() => {
    if (!call) return;
    setModel(call.model);
    setTested(null);
  }, [call?.call]);
  // вызов открылся — в проверку идёт последнее сообщение человека, иначе промпт
  useEffect(() => {
    if (body.data) take([...parts].reverse().find((p) => p.scope === "user") ?? parts[0]);
  }, [body.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const box = useRef<HTMLDivElement>(null);
  const drag = useRowDrag({ box, enabled: admin, onDrop: ({ id, before }) => {
    const order = reorder((rules ?? []).map((_, i) => String(i)), id, before);
    setRules(order.map((i) => (rules ?? [])[Number(i)]!));
    setOpen(null);
    setTested(null);
  } });
  if (prefs.error) return <Failed error={prefs.error} retry={prefs.refetch} />;
  const list = rules ?? [];
  const saved = JSON.stringify(prefs.data?.values[PROXY_RULES] ?? []) === JSON.stringify(list);
  const set = (i: number, p: Partial<Rule>) => (setRules(list.map((r, j) => (j === i ? { ...r, ...p } : r))), setTested(null));
  const flaws = list.map(ruleFlaw);
  const test = async () => {
    if (!machine) return;
    const r = await act(rulesTest, { to: "@" + machine, text: probe, scope, ...(model ? { model } : {}), rules: list });
    if (r) setTested(r);
  };
  return (
    <Stack>
      <div className="card dragbox" ref={box} data-drop-group="rules">
        {drag.line !== null && <div className="dragline" style={{ top: drag.line }} />}
        {list.map((r, i) => {
          const flaw = flaws[i] || tested?.flaws[r.name];
          return (
            <div key={i} style={{ borderTop: i ? "1px solid var(--line)" : 0, touchAction: "pan-y" }} className={drag.dragging === String(i) ? "dragging" : undefined} data-drag-id={String(i)} data-drag-group="rules" onPointerDown={open === i ? undefined : drag.onPointerDown(String(i))}>
              <div className="line" style={{ borderTop: 0 }}>
                {admin && <span className="grip" role="button" tabIndex={0} aria-label={`Порядок: ${r.name}`} title="Перетащите; с клавиатуры — Alt и стрелки" onKeyDown={(e) => { if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return; e.preventDefault(); const j = i + (e.key === "ArrowUp" ? -1 : 1); if (j >= 0 && j < list.length) (setRules(shift(list, r, e.key === "ArrowUp" ? -1 : 1)), setOpen(null)); }}><IconGripVertical size={14} /></span>}
                <Switch aria-label={`Правило «${r.name}» включено`} checked={r.on !== false} disabled={!admin} onChange={(e) => set(i, { on: e.currentTarget.checked })} />
                <div className="grow">
                  <Group gap={6}><Text size="sm" fw={500}>{r.name}</Text>{flaw && <Badge color="red" variant="light">{flaw}</Badge>}{tested && !flaw && r.on !== false && <Badge variant="default">сработало: {tested.hits[r.name] ?? 0}</Badge>}</Group>
                  <Text size="xs" className="muted" style={{ overflowWrap: "anywhere" }}>{ruleLine(r)}</Text>
                </div>
                {admin && (
                  <Group gap={2} wrap="nowrap">
                    <Button size="compact-xs" variant="subtle" onClick={() => setOpen(open === i ? null : i)}>{open === i ? "Свернуть" : "Изменить"}</Button>
                    <ActionIcon variant="subtle" size="sm" color="red" aria-label={`Удалить правило ${r.name}`} onClick={() => confirmDanger({ title: `Удалить правило «${r.name}»?`, confirm: "Удалить", body: "Правило исчезнет после «Сохранить».", onConfirm: () => (setRules(list.filter((_, j) => j !== i)), setOpen(null)) })}><IconTrash size={14} /></ActionIcon>
                  </Group>
                )}
              </div>
              {open === i && <Editor r={r} set={(p) => set(i, p)} />}
            </div>
          );
        })}
        {!list.length && <Text size="sm" className="muted">Правил нет: запросы к модели идут как есть</Text>}
      </div>
      {admin && (
        <Group>
          <Button variant="default" size="xs" onClick={() => (setRules([...list, newRule()]), setOpen(list.length))}>Добавить правило</Button>
          <Button size="xs" disabled={saved || flaws.some(Boolean)} onClick={async () => (await act(prefsSet, { scope: "fleet", name: PROXY_RULES, value: list }, "Правила сохранены, машины их перечитают")) && qc.invalidateQueries({ queryKey: ["prefs.get"] })}>Сохранить</Button>
          {!saved && <Text size="sm" c="orange">Есть несохранённые правки</Text>}
        </Group>
      )}
      <div className="card">
        <Text fw={600}>Проверка на тексте</Text>
        {ref && (calls.error ? <Failed error={calls.error} retry={calls.refetch} /> : call
          ? <Text size="sm">Вызов модели из архива: {day(call.at)}, {hhmm(call.at)} · <span className="mono">{modelWord(call.model)}</span>{body.data && !parts.length ? " — текста этого вызова в архиве нет, вставьте свой" : ""} · <Link to={`/archive/${ref.sid}`}>к сессии</Link></Text>
          : calls.data ? <Text size="sm" c="orange">Такого вызова в архиве нет</Text> : null)}
        {parts.length > 0 && (
          <Chip.Group value={part} onChange={(id) => take(parts.find((p) => p.id === id))}>
            <Group gap={6} aria-label="Часть вызова">{parts.map((p) => <Chip key={p.id} value={p.id} size="xs">{p.word}</Chip>)}<Chip value="" size="xs">Свой текст</Chip></Group>
          </Chip.Group>
        )}
        <Textarea aria-label="Текст для проверки" autosize minRows={2} maxRows={14} value={probe} onChange={(e) => (setProbe(e.currentTarget.value), setPart(""), setTested(null))} />
        <Group align="end" gap="sm">
          <Select label="Где этот текст" data={SCOPES.map(([value, label]) => ({ value, label }))} value={scope} onChange={(v) => v && (setScope(v as typeof scope), setTested(null))} allowDeselect={false} w={220} />
          <Select label="Проверить на машине" className="mono" data={online} value={machine} onChange={setMachine} allowDeselect={false} w={180} />
          <Button variant="default" disabled={!machine || !probe.trim()} onClick={() => void test()}>Проверить</Button>
        </Group>
        {tested && (
          <>
            <Text size="sm" fw={500}>{tested.after === probe ? "Правила ничего не изменили" : "Модель увидит"}</Text>
            <div className="codebox diff" role="group" aria-label="Что изменили правила">
              {lineDiff(probe, tested.after).map((l, i) => <div key={i} className={l.kind}>{l.kind === "del" ? "− " : l.kind === "add" ? "+ " : "  "}{l.text || " "}</div>)}
            </div>
          </>
        )}
      </div>
    </Stack>
  );
}
