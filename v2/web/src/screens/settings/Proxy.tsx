// «Настройки → Правила прокси»: правила замены текста запросов к модели. Форма правила — та, что читает прокси Host (ProxyRule);
// проверка на тексте идёт запросом rules.test — движок на странице не повторяется.
import { prefsGet, prefsSet, PROXY_RULES, ProxyRule, rulesTest, type OutputOf } from "@sb/protocol";
import { ActionIcon, Badge, Button, Chip, Group, SegmentedControl, Select, Stack, Switch, TagsInput, Text, Textarea, TextInput } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { act } from "../../api.ts";
import { confirmDanger, Failed, useCall } from "../../common.tsx";
import { shift } from "../../lib/work.ts";
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
  useEffect(() => { if (prefs.data && !rules) setRules((prefs.data.values[PROXY_RULES] as Rule[] | undefined) ?? []); }, [prefs.data, rules]);
  if (prefs.error) return <Failed error={prefs.error} retry={prefs.refetch} />;
  const list = rules ?? [];
  const saved = JSON.stringify(prefs.data?.values[PROXY_RULES] ?? []) === JSON.stringify(list);
  const set = (i: number, p: Partial<Rule>) => (setRules(list.map((r, j) => (j === i ? { ...r, ...p } : r))), setTested(null));
  const flaws = list.map(ruleFlaw);
  const test = async () => {
    if (!machine) return;
    const r = await act(rulesTest, { to: "@" + machine, text: probe, scope, rules: list });
    if (r) setTested(r);
  };
  return (
    <Stack>
      <div className="card">
        {list.map((r, i) => {
          const flaw = flaws[i] || tested?.flaws[r.name];
          return (
            <div key={i} style={{ borderTop: i ? "1px solid var(--line)" : 0 }}>
              <div className="line" style={{ borderTop: 0 }}>
                <Switch aria-label={`Правило «${r.name}» включено`} checked={r.on !== false} disabled={!admin} onChange={(e) => set(i, { on: e.currentTarget.checked })} />
                <div className="grow">
                  <Group gap={6}><Text size="sm" fw={500}>{r.name}</Text>{flaw && <Badge color="red" variant="light">{flaw}</Badge>}{tested && !flaw && r.on !== false && <Badge variant="default">сработало: {tested.hits[r.name] ?? 0}</Badge>}</Group>
                  <Text size="xs" className="muted" style={{ overflowWrap: "anywhere" }}>{ruleLine(r)}</Text>
                </div>
                {admin && (
                  <Group gap={2} wrap="nowrap">
                    <ActionIcon variant="subtle" size="sm" aria-label={`Выше: ${r.name}`} disabled={i === 0} onClick={() => (setRules(shift(list, r, -1)), setOpen(null))}><IconArrowUp size={14} /></ActionIcon>
                    <ActionIcon variant="subtle" size="sm" aria-label={`Ниже: ${r.name}`} disabled={i === list.length - 1} onClick={() => (setRules(shift(list, r, 1)), setOpen(null))}><IconArrowDown size={14} /></ActionIcon>
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
        <Textarea aria-label="Текст для проверки" autosize minRows={2} value={probe} onChange={(e) => (setProbe(e.currentTarget.value), setTested(null))} />
        <Group align="end" gap="sm">
          <Select label="Где этот текст" data={SCOPES.map(([value, label]) => ({ value, label }))} value={scope} onChange={(v) => v && (setScope(v as typeof scope), setTested(null))} allowDeselect={false} w={220} />
          <Select label="Проверить на машине" className="mono" data={online} value={machine} onChange={setMachine} allowDeselect={false} w={180} />
          <Button variant="default" disabled={!machine || !probe.trim()} onClick={() => void test()}>Проверить</Button>
        </Group>
        {tested && <><Text size="sm" fw={500}>Модель увидит</Text><pre className="codebox">{tested.after}</pre></>}
      </div>
    </Stack>
  );
}
