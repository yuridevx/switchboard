// «Дать работу»: служба «Фабрика» отдаёт сессии шаг тикета. Сессии с таким именем нет — открыть по документу; остановлена — поднять;
// ввод — тегом вида ticket. Ход, который взял шаг и кончается без вердикта, возвращается один раз — штатным хуком остановки Claude Code.
// Записей о шагах модуль не держит: что шаг у сессии и что вердикт дан, записано в тикете. В памяти — только ввод, который дан,
// пока ход его не взял и не кончился; после перезапуска Host восстанавливать нечего.
import { randomUUID } from "node:crypto";
import { Refusal, type Spec, ticketSet } from "@sb/protocol";
import type { Ctx, HostApi, Module } from "../../core/contract.ts";
import { envelope } from "../chat/contract.ts";

/** Адрес службы «Фабрика»: работу сессии даёт только она. */
const FROM = ".factory";
/** Инструмент вердикта у процесса сессии: сервер fleet, запрос ticket.set. */
const SET_TOOL = "mcp__fleet__ticket_set";
/** Шаг на руках у сессии: set — вердикт по нему в этом ходе уже ушёл. */
type Step = { ticket: string; step?: string; set?: boolean };

export function make(): Module {
  let host: HostApi;
  /** ввод, который дан и ещё не взят ходом: номер сообщения → чей и какой шаг */
  const given = new Map<string, Step & { callsign: string }>();
  /** шаги, которые взял идущий ход сессии */
  const taken = new Map<string, Step[]>();
  const word = (t: Step) => `тикет ${t.ticket}${t.step ? ` · шаг ${t.step}` : ""}`;

  /** Процесса сессии больше нет, а шаг у неё: тикету — «стоп» с причиной. Служба не ответила — строка журнала: шаг закроет его срок. */
  function lost(callsign: string, why: string): void {
    const steps = [...(taken.get(callsign) ?? []).filter((t) => !t.set), ...[...given.values()].filter((g) => g.callsign === callsign)];
    taken.delete(callsign);
    for (const [uuid, g] of given) if (g.callsign === callsign) given.delete(uuid);
    for (const t of steps)
      void host.call(ticketSet, { ticket: t.ticket, verdict: "stop", note: why }).catch((e: unknown) => host.log.warn("work", { callsign, kind: "lost", word: (e as Refusal).word ?? "offline", why: `${word(t)}: «стоп» не записан — ${(e as Error).message}` }));
  }

  return {
    name: "host-work",
    start(h) {
      host = h;
    },
    requests: {
      async "work.give"(i: { name: string; spec?: Spec; ticket: string; step?: string; on?: string; key?: string; text: string }, ctx: Ctx) {
        if (ctx.from !== FROM) throw new Refusal("forbidden", "работу сессии даёт служба «Фабрика»: создайте тикет — ticket.new");
        const callsign = `${i.name}@${host.machine}`;
        let s = host.session(callsign);
        if (!s) {
          if (!i.spec) throw new Refusal("no_session", `сессии ${callsign} нет`);
          s = await host.open(i.spec, { by: FROM });
        } else if (s.state === "failed") throw new Refusal("failed", `${callsign}: ${s.info.error ?? "сессия остановилась со сбоем"}`);
        else if (s.state === "stopping") throw new Refusal("stopped", `${callsign} останавливается`);
        else if (s.state === "stopped") await s.start();
        const uuid = randomUUID();
        given.set(uuid, { callsign, ticket: i.ticket, ...(i.step ? { step: i.step } : {}) });
        s.input(envelope(FROM, "ticket", i.text, { ticket: i.ticket, step: i.step, on: i.on, key: i.key }), { priority: "next", uuid });
        host.log.info("work", { callsign, kind: "given", why: word(i) });
        return { callsign };
      },
    },
    compose(s) {
      return {
        hooks: {
          // вердикт ушёл — шаг сдан: этому ходу напоминать не о чем
          PostToolUse: [
            {
              matcher: SET_TOOL,
              hooks: [
                async (input: { tool_input?: { ticket?: string } }) => {
                  for (const t of taken.get(s.callsign) ?? []) if (t.ticket === input.tool_input?.ticket) t.set = true;
                  return {};
                },
              ],
            },
          ],
          // ход, взявший шаг, кончается без вердикта: вернуть один раз. Что возврат уже был, говорит сам хук; идёт фоновая работа — ход ещё вернётся сам
          Stop: [
            {
              hooks: [
                async (input: { stop_hook_active?: boolean; background_tasks?: unknown[] }) => {
                  const open = (taken.get(s.callsign) ?? []).filter((t) => !t.set);
                  if (!open.length || input.stop_hook_active || input.background_tasks?.length) return {};
                  host.log.info("work", { callsign: s.callsign, kind: "reminded", why: open.map(word).join(", ") });
                  const ids = open.map((t) => t.ticket).join(", ");
                  return { decision: "block", reason: `Шаг не сдан: ${ids}. Сдай его инструментом ticket_set — verdict done (сделано), back (вернуть с замечанием) или stop (нужен человек), заметка — в note. Ждёшь свою дочернюю сессию — просто ответь, когда дождёшься.` };
                },
              ],
            },
          ],
        },
      };
    },
    on: {
      event(s, msg) {
        const cs = s.callsign;
        // ход взял сообщения: процесс называет их номера на ответах модели и на итоге хода
        const uuids: unknown[] = Array.isArray(msg?.user_message_uuids) ? msg.user_message_uuids : msg?.type === "user" && typeof msg.uuid === "string" ? [msg.uuid] : [];
        for (const u of uuids) {
          const g = given.get(u as string);
          if (!g) continue;
          given.delete(u as string);
          taken.set(cs, [...(taken.get(cs) ?? []), { ticket: g.ticket, ...(g.step ? { step: g.step } : {}) }]);
        }
        if (msg?.type === "result") taken.delete(cs);
      },
      state(s, state) {
        if (state === "failed") lost(s.callsign, `сессия остановилась со сбоем${s.info.error ? `: ${s.info.error}` : ""}`);
        else if (state === "stopped") lost(s.callsign, "сессия остановлена");
      },
      removed(callsign) {
        lost(callsign, "сессия убрана");
      },
    },
  };
}
