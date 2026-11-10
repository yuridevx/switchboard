// Вопрос сессии человеку: варианты кнопками, разрешение, план, форма. Один компонент — в разговоре и прямо в строке «Вам».
// Ответ уходит через несколько секунд: до этого его можно отменить.
import { answer, type Ask } from "@sb/protocol";
import { Button, Group, NumberInput, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { act } from "../api.ts";
import { later, usePending } from "../common.tsx";
import { Md } from "./Feed.tsx";

const KIND: Record<Ask["kind"], string> = { question: "Вопрос", permission: "Разрешение", plan: "План", form: "Форма", url: "Ссылка" };
const firstLine = (md: string) => md.replace(/[#*`]/g, "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";

export function AskCard({ callsign, ask, inline, quiet, sessionTitle, onOpen }: {
  callsign: string; ask: Ask;
  /** в строке «Вам»: коротко, форма свёрнута до кнопки */
  inline?: boolean;
  /** разговор открыт рядом: кнопки ответа не повторяются */
  quiet?: boolean;
  sessionTitle?: string;
  onOpen?: () => void;
}) {
  const [own, setOwn] = useState("");
  const [form, setForm] = useState<Record<string, unknown>>(() => Object.fromEntries(Object.entries((ask.schema as any)?.properties ?? {}).map(([k, p]: [string, any]) => [k, p.default ?? ""])));
  const key = "ask:" + ask.id;
  const sent = usePending((p) => p.items[key]);
  const send = (value: unknown, said: string) => later({ key, label: `${callsign}: отвечено «${said}»`, run: () => act(answer, { to: callsign, ask: ask.id, answer: value }) });
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const props = (ask.schema as any)?.properties as Record<string, { type: string; title?: string }> | undefined;
  const required: string[] = (ask.schema as any)?.required ?? [];
  const head = ask.title && ask.title !== KIND[ask.kind] ? `${KIND[ask.kind]} · ${ask.title}` : KIND[ask.kind];
  const planLine = ask.kind === "plan" ? firstLine(ask.text) : "";
  if (sent) return <div className={`askcard${inline ? " inline" : ""}`}><Text size="sm" className="muted">Отвечено, уходит сессии</Text></div>;
  return (
    <div className={`askcard${inline ? " inline" : ""}`} onClick={stop} onKeyDown={stop}>
      {!inline && <Text size="xs" fw={600}>{head}</Text>}
      {ask.kind === "permission" ? <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{ask.text}</pre>
        : ask.kind === "plan" && !inline ? <Md text={ask.text} />
        : ask.kind === "plan" ? (planLine && planLine !== sessionTitle ? <Text size="sm" className="clamp2">{planLine}</Text> : <Text size="sm">Ждёт решения по плану</Text>)
        : <Text size="sm" className={inline ? "clamp2" : undefined}>{ask.text}</Text>}
      {ask.kind === "form" && props && inline && !quiet && <Button size="xs" w="fit-content" onClick={onOpen}>Заполнить</Button>}
      {ask.kind === "form" && props && !inline && (
        <Group gap="xs" align="end">
          {Object.entries(props).map(([k, p]) => p.type === "number"
            ? <NumberInput key={k} size="xs" label={p.title ?? k} w={90} value={form[k] as number} onChange={(v) => setForm((f) => ({ ...f, [k]: v }))} />
            : <TextInput key={k} size="xs" label={p.title ?? k} required={required.includes(k)} value={String(form[k] ?? "")} onChange={(e) => setForm((f) => ({ ...f, [k]: e.currentTarget.value }))} style={{ flex: "1 1 140px" }} />)}
          <Button size="xs" disabled={required.some((k) => !form[k])} onClick={() => send({ action: "accept", content: form }, "форма заполнена")}>Отправить</Button>
        </Group>
      )}
      {ask.kind === "url" && ask.url && <Button component="a" href={ask.url} target="_blank" rel="noreferrer" size="xs" variant="default" w="fit-content">Открыть ссылку</Button>}
      {ask.options && !quiet && (
        <Group gap={6}>
          {ask.options.map((o, i) => (
            <Button key={o.label} size="xs" variant={i === 0 ? "filled" : "default"} title={o.about} onClick={() => send(o.label, o.label)}>{o.label}</Button>
          ))}
        </Group>
      )}
      {ask.kind === "question" && !inline && (
        <Group gap={6}>
          <TextInput size="xs" placeholder="Свой ответ" aria-label="Свой ответ" value={own} onChange={(e) => setOwn(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && own.trim() && send(own.trim(), own.trim())} style={{ flex: 1 }} />
          <Button size="xs" variant="default" disabled={!own.trim()} onClick={() => send(own.trim(), own.trim())}>Ответить</Button>
        </Group>
      )}
    </div>
  );
}
