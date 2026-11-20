// «Фабрика»: слова и отображение экрана. Правил здесь нет: сколько шагов идёт, хватает ли места и что можно сделать с тикетом, отвечают службы
// (загрузка — в ответе factory.get, действия — в acts тикета, спрошенного по номеру).
import type { FactoryDef, RuleDef, StepDef, Ticket, TicketState, Verdict } from "@sb/protocol";

export type DoerKind = "new" | "same" | "post" | "human" | "event";
/** Кто исполняет шаг — по полям шага определения; у поста и события — ещё имя. */
export const doerOf = (s: StepDef): { kind: DoerKind; name?: string } =>
  s.session ? { kind: s.session } : s.post ? { kind: "post", name: s.post } : s.human ? { kind: "human" } : { kind: "event", name: s.wait };
export const DOER_WORD: Record<DoerKind, string> = { new: "свежая сессия", same: "та же сессия", post: "пост", human: "человек", event: "событие" };
const EVENT: Record<string, string> = { "pr.merged": "PR слит", "upstream.moved": "апстрим сдвинулся" };
export const eventWord = (kind: string): string => EVENT[kind] ?? kind;
export const VERDICT_WORD: Record<Verdict, string> = { done: "сдал", back: "вернул", stop: "стоп" };
export const STATE_WORD: Record<TicketState, string> = { ready: "в очереди", work: "в работе", wait: "ждёт", stop: "стоп", done: "закрыт" };
/** Состояние тикета словом: снятый без работы — «снят». */
export const stateWord = (t: Pick<Ticket, "state" | "dropped">): string => (t.dropped ? "снят" : STATE_WORD[t.state]);
/** Лампа плашки тикета — те же цвета, что у сессий: работает, ждёт, сбой. */
export const STATE_LAMP: Record<TicketState, string> = { ready: "off", work: "busy", wait: "waiting", stop: "failed", done: "idle" };

/** Шаг, на котором стоит тикет: у тикета поста, сессии и бэклога шагов нет. */
export const stepOf = (def: FactoryDef, t: Pick<Ticket, "to" | "step">): StepDef | undefined => (t.to ? def.lines[t.to]?.steps[t.step] : undefined);
/** Событие, которого ждёт тикет: шаг-ожидание; у шага человека его нет. */
export const waitsEvent = (def: FactoryDef, t: Pick<Ticket, "to" | "step" | "state">): string | undefined => (t.state === "wait" ? stepOf(def, t)?.wait : undefined);
/** Тикет ждёт человека: шаг человека или стоп — дальше его двигает только человек. */
export const needsHuman = (def: FactoryDef, t: Pick<Ticket, "to" | "step" | "state">): boolean => t.state === "stop" || (t.state === "wait" && !waitsEvent(def, t));
/** Чего ждёт тикет: человека или события; у события — его слово и номер PR. */
export function waitWord(def: FactoryDef, t: Ticket): string {
  const event = waitsEvent(def, t);
  return event ? `ждёт: ${eventWord(event)}${t.pr ? ` · ${t.pr.slice(t.pr.indexOf("#"))}` : ""}` : "ждёт человека";
}
/** Тикет, которым занят пост помимо своей очереди: шаг конвейера, который ведёт его сессия. */
export const postStep = (name: string, call: string, tickets: Ticket[]): Ticket | undefined => tickets.find((t) => t.state === "work" && t.session === call && t.to !== name);
/** Тикеты шага в порядке показа: идущие и ждущие — первыми, очередь — после них, старые раньше. */
export function atStep(line: string, step: number, tickets: Ticket[]): Ticket[] {
  const rank = (t: Ticket) => (t.state === "ready" ? 1 : 0);
  return tickets.filter((t) => t.to === line && t.step === step && t.state !== "done").sort((a, b) => rank(a) - rank(b) || a.since - b.since);
}
/** Вход правила словами: срок, адрес с секретом, GitHub; без входа правило зовут по имени. */
export const ruleWord = (r: RuleDef): string =>
  r.github ? `GitHub · ${eventWord(r.github)}${r.every ? ` · каждые ${r.every}` : ""}` : r.hook ? "адрес с секретом" : r.every ? `каждые ${r.every}` : r.cron ? `${r.cron}${r.tz ? ` · ${r.tz}` : ""}` : "по имени";
/** Позывной поста: имя и машина из определения. */
export const postCall = (name: string, at: string): string => `${name}${at}`;
/** Куда можно назначить тикет с экрана: конвейеры и посты проекта. */
export const targetsOf = (def: FactoryDef): { value: string; label: string }[] => [
  ...Object.entries(def.lines).map(([name, l]) => ({ value: name, label: l.title ?? name })),
  ...Object.entries(def.posts).map(([name, p]) => ({ value: name, label: p.title ?? name })),
];
