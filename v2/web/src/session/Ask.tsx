// Вопрос сессии человеку: варианты кнопками, несколько вопросов по одному, разрешение, план, форма, ссылка.
// Один компонент — в разговоре и прямо в строке «Вам». Ответ уходит через несколько секунд: до этого его можно отменить.
import { answer, type Ask } from "@sb/protocol";
import { Button, Checkbox, Group, NumberInput, Select, Switch, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { act } from "../api.ts";
import { later, usePending } from "../common.tsx";
import { ACTION_WORD, type Action, actionAnswer, answeredAll, formAnswer, formFields, formReady, questionAnswer, questionSaid, questionsOf } from "./answers.ts";
import { Md } from "./Feed.tsx";

const KIND: Record<Ask["kind"], string> = { question: "Вопрос", permission: "Разрешение", plan: "План", form: "Форма", url: "Ссылка" };
const firstLine = (md: string) => md.replace(/[#*`]/g, "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";

type Send = (value: unknown, said: string) => void;

/** Вопросы с вариантами: по одному; у выбора нескольких — флажки; свой ответ — полем. */
function Questions({ ask, send, inline }: { ask: Ask; send: Send; inline?: boolean }) {
  const qs = questionsOf(ask);
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<string[][]>(() => qs.map(() => []));
  const [own, setOwn] = useState("");
  const q = qs[at]!;
  const last = at === qs.length - 1;
  const put = (list: string[]) => picked.map((p, i) => (i === at ? list : p));
  const finish = (all: string[][]) => send(questionAnswer(qs, all), questionSaid(all));
  const next = (all: string[][]) => (last ? finish(all) : (setPicked(all), setOwn(""), setAt(at + 1)));
  const mine = picked[at] ?? [];
  return (
    <div className="ask-q">
      {qs.length > 1 && <Text size="xs" className="muted">{at + 1} из {qs.length}{q.header ? ` · ${q.header}` : ""}</Text>}
      {(qs.length > 1 || !inline) && qs.length > 1 && <Text size="sm">{q.question}</Text>}
      {q.multi ? (
        <>
          {q.options.map((o) => (
            <Checkbox key={o.label} size="xs" label={o.label} description={o.about} checked={mine.includes(o.label)}
              onChange={(e) => setPicked(put(e.currentTarget.checked ? [...mine, o.label] : mine.filter((x) => x !== o.label)))} />
          ))}
          <Group gap={6}>
            <Button size="xs" disabled={!mine.length && !own.trim()} onClick={() => next(put([...mine, ...(own.trim() ? [own.trim()] : [])]))}>{last ? "Ответить" : "Дальше"}</Button>
            {at > 0 && <Button size="xs" variant="default" onClick={() => setAt(at - 1)}>Назад</Button>}
          </Group>
        </>
      ) : (
        <Group gap={6}>
          {q.options.map((o, i) => <Button key={o.label} size="xs" variant={i === 0 ? "filled" : "default"} title={o.about} onClick={() => next(put([o.label]))}>{o.label}</Button>)}
          {at > 0 && <Button size="xs" variant="subtle" onClick={() => setAt(at - 1)}>Назад</Button>}
        </Group>
      )}
      {!inline && (
        <Group gap={6}>
          <TextInput size="xs" placeholder="Свой ответ" aria-label="Свой ответ" value={own} onChange={(e) => setOwn(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && !q.multi && own.trim() && next(put([own.trim()]))} style={{ flex: 1 }} />
          {!q.multi && <Button size="xs" variant="default" disabled={!own.trim()} onClick={() => next(put([own.trim()]))}>{last ? "Ответить" : "Дальше"}</Button>}
        </Group>
      )}
      {qs.length > 1 && answeredAll(qs.slice(0, at), picked) && at > 0 && <Text size="xs" className="muted">уже выбрано: {questionSaid(picked.slice(0, at))}</Text>}
    </div>
  );
}

/** Разрешение и план: три действия; отказ — с причиной, которую увидит модель. */
function Actions({ ask, send, inline }: { ask: Ask; send: Send; inline?: boolean }) {
  const words = ACTION_WORD[ask.kind === "plan" ? "plan" : "permission"];
  const [deny, setDeny] = useState(false);
  const [why, setWhy] = useState("");
  const go = (a: Action) => send(actionAnswer(a, why), a === "deny" && why.trim() ? `${words[a]}: ${why.trim()}` : words[a]);
  if (deny) {
    return (
      <Group gap={6}>
        <TextInput autoFocus size="xs" placeholder={ask.kind === "plan" ? "Что доработать" : "Почему нельзя"} aria-label="Причина" value={why} onChange={(e) => setWhy(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && go("deny")} style={{ flex: 1 }} />
        <Button size="xs" color="red" onClick={() => go("deny")}>{words.deny}</Button>
        <Button size="xs" variant="subtle" onClick={() => setDeny(false)}>Назад</Button>
      </Group>
    );
  }
  return (
    <Group gap={6}>
      <Button size="xs" onClick={() => go("allow")}>{words.allow}</Button>
      <Button size="xs" variant="default" onClick={() => go("allow_always")}>{words.allow_always}</Button>
      <Button size="xs" variant="default" onClick={() => (inline ? go("deny") : setDeny(true))}>{words.deny}</Button>
    </Group>
  );
}

function Form({ ask, send }: { ask: Ask; send: Send }) {
  const fields = formFields(ask.schema);
  const [v, setV] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.key, f.initial])));
  const set = (k: string, x: unknown) => setV((o) => ({ ...o, [k]: x }));
  return (
    <Group gap="xs" align="end">
      {fields.map((f) =>
        f.type === "number" ? <NumberInput key={f.key} size="xs" label={f.title} description={f.about} required={f.required} w={110} value={v[f.key] as number} onChange={(x) => set(f.key, x)} />
        : f.type === "boolean" ? <Switch key={f.key} size="xs" label={f.title} description={f.about} checked={!!v[f.key]} onChange={(e) => set(f.key, e.currentTarget.checked)} />
        : f.type === "enum" ? <Select key={f.key} size="xs" label={f.title} description={f.about} required={f.required} data={f.options} value={(v[f.key] as string) || null} onChange={(x) => set(f.key, x ?? "")} style={{ flex: "1 1 140px" }} />
        : <TextInput key={f.key} size="xs" label={f.title} description={f.about} required={f.required} value={String(v[f.key] ?? "")} onChange={(e) => set(f.key, e.currentTarget.value)} style={{ flex: "1 1 140px" }} />)}
      <Button size="xs" disabled={!formReady(fields, v)} onClick={() => send(formAnswer(fields, v), "форма заполнена")}>Отправить</Button>
      <Button size="xs" variant="default" onClick={() => send({ action: "decline" }, "форма отклонена")}>Отказаться</Button>
    </Group>
  );
}

export function AskCard({ callsign, ask, inline, quiet, sessionTitle, onOpen }: {
  callsign: string; ask: Ask;
  /** в строке «Вам»: коротко; сложный вопрос свёрнут до кнопки */
  inline?: boolean;
  /** разговор открыт рядом: кнопки ответа не повторяются */
  quiet?: boolean;
  sessionTitle?: string;
  onOpen?: () => void;
}) {
  const [whole, setWhole] = useState(false);
  const key = "ask:" + ask.id;
  const sent = usePending((p) => p.items[key]);
  const send: Send = (value, said) => later({ key, label: `${callsign}: отвечено «${said}»`, run: () => act(answer, { to: callsign, ask: ask.id, answer: value }) });
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const qs = ask.kind === "question" ? questionsOf(ask) : [];
  const complex = qs.length > 1 || qs.some((q) => q.multi);
  const head = ask.title && ask.title !== KIND[ask.kind] ? `${KIND[ask.kind]} · ${ask.title}` : KIND[ask.kind];
  const planLine = ask.kind === "plan" ? firstLine(ask.text) : "";
  if (sent) return <div className={`askcard${inline ? " inline" : ""}`}><Text size="sm" className="muted">{sent.replace(/^[^:]*: /, "")} — уходит сессии</Text></div>;
  return (
    <div className={`askcard${inline ? " inline" : ""}`} onClick={stop} onKeyDown={stop}>
      {!inline && <Text size="xs" fw={600}>{head}</Text>}
      {ask.kind === "permission" ? (
        <div className="ask-in">
          <pre>{ask.text}</pre>
          {!inline && ask.input != null && <button type="button" className="linkbtn" aria-expanded={whole} onClick={() => setWhole((w) => !w)}>{whole ? "Скрыть ввод" : "Весь ввод"}</button>}
          {whole && <pre>{JSON.stringify(ask.input, null, 2)}</pre>}
        </div>
      )
        : ask.kind === "plan" && !inline ? <Md text={ask.text} />
        : ask.kind === "plan" ? (planLine && planLine !== sessionTitle ? <Text size="sm" className="clamp2">{planLine}</Text> : <Text size="sm">Ждёт решения по плану</Text>)
        : (qs.length <= 1 || inline) && <Text size="sm" className={inline ? "clamp2" : undefined}>{ask.text}</Text>}
      {quiet ? null
        : ask.kind === "question" ? (inline && complex ? <Button size="xs" w="fit-content" onClick={onOpen}>Ответить</Button> : <Questions ask={ask} send={send} inline={inline} />)
        : ask.kind === "permission" || ask.kind === "plan" ? <Actions ask={ask} send={send} inline={inline} />
        : ask.kind === "form" ? (inline ? <Button size="xs" w="fit-content" onClick={onOpen}>Заполнить</Button> : <Form ask={ask} send={send} />)
        : (
          <Group gap={6}>
            {ask.url && <Button component="a" href={ask.url} target="_blank" rel="noreferrer" size="xs" w="fit-content">Открыть ссылку</Button>}
            <Button size="xs" variant="default" onClick={() => send({ action: "accept" }, "готово")}>Готово</Button>
            <Button size="xs" variant="subtle" onClick={() => send({ action: "cancel" }, "закрыто")}>Закрыть</Button>
          </Group>
        )}
    </div>
  );
}
