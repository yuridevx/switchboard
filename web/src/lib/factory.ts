// «Фабрика»: слова и отображение экрана. Правил здесь нет: сколько ждёт в очереди поста и что можно сделать с тикетом, отвечают службы
// (очереди — в load ответа factory.get, действия — в acts тикета, спрошенного по номеру).
import type { FactoryDef, RuleDef, Ticket, TicketState, Verdict } from "@sb/protocol";

export const VERDICT_WORD: Record<Verdict, string> = { done: "сдал", back: "вернул", stop: "стоп" };
export const STATE_WORD: Record<TicketState, string> = { ready: "в очереди", work: "в работе", wait: "спит", stop: "стоп", done: "закрыт" };
/** Состояние тикета словом: снятый без работы — «снят». */
export const stateWord = (t: Pick<Ticket, "state" | "dropped">): string => (t.dropped ? "снят" : STATE_WORD[t.state]);
/** Лампа плашки тикета — те же цвета, что у сессий: работает, ждёт, сбой. */
export const STATE_LAMP: Record<TicketState, string> = { ready: "off", work: "busy", wait: "waiting", stop: "failed", done: "idle" };

/** Тикет ждёт человека: встал — дальше его двигает только человек. */
export const needsHuman = (t: Pick<Ticket, "state">): boolean => t.state === "stop";
/** Номер тикета без проекта — для тесной плашки: «#12». */
const short = (id: string) => "#" + id.slice(id.lastIndexOf("-") + 1);
/** Чего ждёт спящий тикет: названных тикетов и (или) своего срока; left — слово срока, его считает экран. */
export const sleepWord = (t: Pick<Ticket, "after">, left?: string): string =>
  [t.after?.length ? `ждёт ${t.after.map(short).join(", ")}` : "", left ? (t.after?.length ? `не дольше ${left}` : `спит ещё ${left}`) : ""].filter(Boolean).join(" · ") || "спит";
/** Тикет, которым занята сессия поста помимо его очереди: отданный ей по позывному. */
export const postStep = (name: string, call: string, tickets: Ticket[]): Ticket | undefined => tickets.find((t) => t.state === "work" && t.session === call && t.to !== name);
/** Тикеты исполнителя в порядке показа: в работе — первыми, потом вставшие, за ними очередь так, как её раздают службы (срочные, потом старшие), спящие — последними. */
export function ofDoer(to: string, tickets: Ticket[]): Ticket[] {
  const rank = (t: Ticket) => (t.state === "work" ? 0 : t.state === "stop" ? 1 : t.state === "wait" ? 4 : t.first ? 2 : 3);
  return tickets.filter((t) => t.to === to && t.state !== "done").sort((a, b) => rank(a) - rank(b) || a.since - b.since);
}
/** Вход правила словами: срок или адрес с секретом; без входа правило зовут по имени. */
export const ruleWord = (r: RuleDef): string => (r.hook ? "адрес с секретом" : r.every ? `каждые ${r.every}` : r.cron ? `${r.cron}${r.tz ? ` · ${r.tz}` : ""}` : "по имени");
/** Куда можно назначить тикет с экрана: посты проекта. */
export const targetsOf = (def: FactoryDef): { value: string; label: string }[] => Object.entries(def.posts).map(([name, p]) => ({ value: name, label: p.title ?? name }));
