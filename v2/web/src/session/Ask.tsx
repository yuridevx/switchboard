// Вопрос сессии человеку: варианты кнопками, разрешение, план, форма. Один компонент — в разговоре и прямо в строке «Вам».
import { answer, type Ask } from "@sb/protocol";
import { Button, Group, NumberInput, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { act } from "../api.ts";
import { Md } from "./Feed.tsx";

const KIND: Record<Ask["kind"], string> = { question: "Вопрос", permission: "Разрешение", plan: "План", form: "Форма", url: "Ссылка" };

export function AskCard({ callsign, ask, inline }: { callsign: string; ask: Ask; inline?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [own, setOwn] = useState("");
  const [form, setForm] = useState<Record<string, unknown>>(() => Object.fromEntries(Object.entries((ask.schema as any)?.properties ?? {}).map(([k, p]: [string, any]) => [k, p.default ?? ""])));
  const send = async (value: unknown) => {
    setBusy(true);
    await act(answer, { to: callsign, ask: ask.id, answer: value });
    setBusy(false);
  };
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const props = (ask.schema as any)?.properties as Record<string, { type: string; title?: string }> | undefined;
  const required: string[] = (ask.schema as any)?.required ?? [];
  return (
    <div className={`askcard${inline ? " inline" : ""}`} onClick={stop} onKeyDown={stop}>
      {!inline && <Text size="xs" fw={600}>{KIND[ask.kind]}{ask.title ? ` · ${ask.title}` : ""}</Text>}
      {ask.kind === "permission" ? <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{ask.text}</pre>
        : ask.kind === "plan" && !inline ? <Md text={ask.text} />
        : <Text size="sm" className={inline ? "clamp2" : undefined}>{ask.kind === "plan" ? ask.text.replace(/[#*`]/g, "").split("\n").filter(Boolean)[0] : ask.text}</Text>}
      {ask.kind === "form" && props && (
        <Group gap="xs" align="end">
          {Object.entries(props).map(([k, p]) => p.type === "number"
            ? <NumberInput key={k} size="xs" label={p.title ?? k} w={90} value={form[k] as number} onChange={(v) => setForm((f) => ({ ...f, [k]: v }))} />
            : <TextInput key={k} size="xs" label={p.title ?? k} required={required.includes(k)} value={String(form[k] ?? "")} onChange={(e) => setForm((f) => ({ ...f, [k]: e.currentTarget.value }))} style={{ flex: "1 1 140px" }} />)}
          <Button size="xs" loading={busy} disabled={required.some((k) => !form[k])} onClick={() => send(form)}>Отправить</Button>
        </Group>
      )}
      {ask.kind === "url" && ask.url && <Button component="a" href={ask.url} target="_blank" rel="noreferrer" size="xs" variant="default">Открыть ссылку</Button>}
      {ask.options && (
        <Group gap={6}>
          {ask.options.map((o, i) => (
            <Button key={o.label} size="xs" variant={i === 0 ? "filled" : "default"} loading={busy} title={o.about} onClick={() => send(o.label)}>{o.label}</Button>
          ))}
        </Group>
      )}
      {ask.kind === "question" && !inline && (
        <Group gap={6}>
          <TextInput size="xs" placeholder="Свой ответ" value={own} onChange={(e) => setOwn(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && own.trim() && send(own.trim())} style={{ flex: 1 }} />
          <Button size="xs" variant="default" disabled={!own.trim()} onClick={() => send(own.trim())}>Ответить</Button>
        </Group>
      )}
    </div>
  );
}
