// Вопрос сессии человеку — карточками в ленте разговора: варианты кнопками, разрешение, план, форма, ссылка.
// Несколько вопросов — карточка на каждый, все видны сразу и прокручиваются вместе с лентой. Ответ уходит через несколько секунд: до этого его можно отменить.
import { answer, type Ask } from "@sb/protocol";
import { Button, Checkbox, Group, NumberInput, Select, Switch, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { act } from "../api.ts";
import { later, usePending } from "../common.tsx";
import { useFleet } from "../store/fleet.ts";
import { ACTION_WORD, type Action, actionAnswer, formAnswer, formFields, formReady, questionAnswer, questionSaid, questionsOf, seenWord } from "./answers.ts";
import { Md } from "./Feed.tsx";

const KIND: Record<Ask["kind"], string> = { question: "Вопрос", permission: "Разрешение", plan: "План", form: "Форма", url: "Ссылка" };

type Send = (value: unknown, said: string) => void;

/** Вопросы с вариантами: карточка на вопрос. Один вопрос с одним выбором уходит нажатием варианта; несколько — выбираются на местах и уходят вместе. */
function Questions({ ask, send, head, seen }: { ask: Ask; send: Send; head: string; seen: string }) {
  const qs = questionsOf(ask);
  const [picked, setPicked] = useState<string[][]>(() => qs.map(() => []));
  const [own, setOwn] = useState<string[]>(() => qs.map(() => ""));
  const one = qs.length === 1;
  const all = picked.map((p, i) => [...p, ...(own[i]!.trim() ? [own[i]!.trim()] : [])]);
  const answered = all.filter((a) => a.length).length;
  const finish = (a: string[][] = all) => send(questionAnswer(qs, a), questionSaid(a));
  const put = (i: number, list: string[]) => setPicked(picked.map((p, j) => (j === i ? list : p)));
  return (
    <>
      {qs.map((q, i) => {
        const mine = picked[i] ?? [];
        const done = all[i]!.length > 0;
        return (
          <div key={i} className="askcard" data-ask={ask.id} data-open={done ? undefined : ""} role="group" aria-label={one ? head : `Вопрос ${i + 1} из ${qs.length}`}>
            <Text size="xs" fw={600}>{one ? head : `Вопрос ${i + 1} из ${qs.length}${q.header ? ` · ${q.header}` : ""}`}</Text>
            <Md text={q.question} />
            <div className="ask-opts">
              {q.options.map((o) => q.multi ? (
                <Checkbox key={o.label} size="xs" label={o.label} description={o.about} checked={mine.includes(o.label)} onChange={(e) => put(i, e.currentTarget.checked ? [...mine, o.label] : mine.filter((x) => x !== o.label))} />
              ) : (
                <button key={o.label} type="button" className="ask-opt" aria-pressed={mine.includes(o.label)} aria-label={o.label}
                  onClick={() => (one ? finish([[o.label]]) : (put(i, mine.includes(o.label) ? [] : [o.label]), setOwn(own.map((x, j) => (j === i ? "" : x)))))}>
                  <b>{o.label}</b>{o.about && <span>{o.about}</span>}
                </button>
              ))}
            </div>
            <Group gap={6} wrap="nowrap">
              <TextInput size="xs" placeholder="Свой ответ" aria-label={one ? "Свой ответ" : `Свой ответ на вопрос ${i + 1}`} value={own[i]} style={{ flex: 1 }}
                onChange={(e) => (setOwn(own.map((x, j) => (j === i ? e.currentTarget.value : x))), !q.multi && e.currentTarget.value && put(i, []))}
                onKeyDown={(e) => e.key === "Enter" && one && all[0]!.length > 0 && finish()} />
              {one && (q.multi || own[0]!.trim()) && <Button size="xs" disabled={!all[0]!.length} onClick={() => finish()}>Ответить</Button>}
            </Group>
            {one && seen && <div className="ask-seen">{seen}</div>}
          </div>
        );
      })}
      {!one && (
        <div className="askcard askdone" data-ask={ask.id}>
          <Group gap="sm" justify="space-between" wrap="nowrap">
            <Text size="sm">Отвечено {answered} из {qs.length}</Text>
            <Button size="xs" disabled={answered < qs.length} onClick={() => finish()}>Ответить</Button>
          </Group>
          {seen && <div className="ask-seen">{seen}</div>}
        </div>
      )}
    </>
  );
}

/** Разрешение и план: три действия; отказ — с причиной, которую увидит модель. */
function Actions({ ask, send }: { ask: Ask; send: Send }) {
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
      <Button size="xs" variant="default" onClick={() => setDeny(true)}>{words.deny}</Button>
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

export function AskCard({ callsign, ask }: { callsign: string; ask: Ask }) {
  const [whole, setWhole] = useState(false);
  const key = "ask:" + ask.id;
  const sent = usePending((p) => p.items[key]);
  const me = useFleet((f) => f.you?.person);
  const seen = seenWord(ask, me);
  const send: Send = (value, said) => later({ key, label: `${callsign}: отвечено «${said}»`, run: () => act(answer, { to: callsign, ask: ask.id, answer: value }) });
  const head = ask.title && ask.title !== KIND[ask.kind] ? `${KIND[ask.kind]} · ${ask.title}` : KIND[ask.kind];
  if (sent) return <div className="askcard" data-ask={ask.id}><Text size="sm" className="muted">{sent.replace(/^[^:]*: /, "")} — уходит сессии</Text></div>;
  if (ask.kind === "question") return <Questions ask={ask} send={send} head={head} seen={seen} />;
  return (
    <div className="askcard" data-ask={ask.id} data-open="" role="group" aria-label={head}>
      <Text size="xs" fw={600}>{head}</Text>
      {ask.kind === "permission" ? (
        <div className="ask-in">
          <pre>{ask.text}</pre>
          {ask.notes && <Text size="sm">{ask.notes}</Text>}
          {ask.blocked && <Text size="sm">Путь: <span className="mono">{ask.blocked}</span></Text>}
          {ask.rule && <Text size="sm">«Разрешать всегда» запишет правило <span className="mono">{ask.rule}</span></Text>}
          {ask.input != null && <button type="button" className="linkbtn" aria-expanded={whole} onClick={() => setWhole((w) => !w)}>{whole ? "Скрыть ввод" : "Весь ввод"}</button>}
          {whole && <pre>{JSON.stringify(ask.input, null, 2)}</pre>}
        </div>
      ) : ask.kind === "plan" ? <Md text={ask.text} /> : <Text size="sm">{ask.text}</Text>}
      {ask.kind === "permission" || ask.kind === "plan" ? <Actions ask={ask} send={send} />
        : ask.kind === "form" ? <Form ask={ask} send={send} />
        : (
          <Group gap={6}>
            {ask.url && <Button component="a" href={ask.url} target="_blank" rel="noreferrer" size="xs" w="fit-content">Открыть ссылку</Button>}
            <Button size="xs" variant="default" onClick={() => send({ action: "accept" }, "готово")}>Готово</Button>
            <Button size="xs" variant="subtle" onClick={() => send({ action: "cancel" }, "закрыто")}>Закрыть</Button>
          </Group>
        )}
      {seen && <div className="ask-seen">{seen}</div>}
    </div>
  );
}
