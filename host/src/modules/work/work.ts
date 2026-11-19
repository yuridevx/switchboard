// «Дать работу»: служба «Фабрика» отдаёт сессии шаг тикета. Сессии с таким именем нет — открыть по документу; остановлена — поднять;
// ввод — тегом вида ticket. Ход, который взял шаг и кончается без вердикта, возвращается один раз — штатным хуком остановки Claude Code.
// Проверка шага — скрипт из определения: машина запускает его перед вердиктом «сдал» штатным хуком перед вызовом инструмента;
// код не 0 — вердикт не уходит, тикету — возврат с выводом скрипта. Что проверять, знает тикет: машина спрашивает его в момент вердикта.
// Записей о шагах модуль не держит: что шаг у сессии и что вердикт дан, записано в тикете. В памяти — только ввод, который дан,
// пока ход его не взял и не кончился; после перезапуска Host восстанавливать нечего.
import { randomUUID } from "node:crypto";
import { checkOutcome, checkRun, FACTORY, type FileIn, Refusal, shellRun, type Spec, TICKET_SET_TOOL, ticketList, ticketSet } from "@sb/protocol";
import type { Ctx, HostApi, Module } from "../../core/contract.ts";
import { type ChatApi, envelope } from "../chat/contract.ts";
import type { FilesApi } from "../files/contract.ts";
import { RUN_MS } from "../shell/contract.ts";

/** Работу сессии даёт только служба «Фабрика». */
const FROM = FACTORY;
/** Инструмент вердикта у процесса сессии. */
const SET_TOOL = TICKET_SET_TOOL;
/** Предел хука проверки шага у Claude Code, секунды: сама проверка ограничена сроком из определения, он не больше предела запуска скрипта машины. */
const CHECK_HOOK_S = RUN_MS / 1000;
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
      async "work.give"(i: { name: string; spec?: Spec; ticket: string; step?: string; on?: string; key?: string; text: string; files?: FileIn[]; asker?: string }, ctx: Ctx) {
        if (ctx.from !== FROM) throw new Refusal("forbidden", "работу сессии даёт служба «Фабрика»: создайте тикет — ticket.new");
        const callsign = `${i.name}@${host.machine}`;
        let s = host.session(callsign);
        if (!s) {
          if (!i.spec) throw new Refusal("no_session", `сессии ${callsign} нет`);
          // папку сессии называет определение — у свежей сессии она своя на тикет: её нет — создаётся
          s = await host.open(i.spec, { by: FROM, mkdir: true });
        } else if (s.state === "failed") throw new Refusal("failed", `${callsign}: ${s.info.error ?? "сессия остановилась со сбоем"}`);
        else if (s.state === "stopping") throw new Refusal("stopped", `${callsign} останавливается`);
        else if (s.state === "stopped") await s.start();
        // файлы тикета встают в папку сессии тем же шагом, что файлы сообщения: сессии — строка уведомления о них
        let text = i.text;
        if (i.files?.length) {
          const files = host.module<FilesApi>("host-files");
          if (!files) throw new Refusal("no_files", "модуля файлов нет в этом Host");
          text = await files.attach(s, i.text, i.files, host.signal);
        }
        // вопросы сессии по этому шагу идут тому, кто дал задачу тикетом, — как вопросы дочери идут родителю
        if (i.asker) host.module<ChatApi>("host-chat")?.asked(callsign, i.asker);
        const uuid = randomUUID();
        given.set(uuid, { callsign, ticket: i.ticket, ...(i.step ? { step: i.step } : {}) });
        // шаг — новым ходом: ввод ждёт конца идущего хода, а не вклинивается в него. Иначе следующий шаг той же сессии
        // приходил бы посреди хода, которым она сдаёт прошлый, и напоминание о вердикте относилось бы не к тому ходу
        s.input(envelope(FROM, "ticket", text, { ticket: i.ticket, step: i.step, on: i.on, key: i.key }), { priority: "later", uuid });
        host.log.info("work", { callsign, kind: "given", why: word(i) });
        return { callsign };
      },
    },
    compose(s) {
      /** Вердикт «сдал» не принят: причина — сессии. */
      const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
      return {
        hooks: {
          // «сдал» шагу с проверкой: сначала скрипт на этой машине, в папке сессии, с пределом из определения
          PreToolUse: [
            {
              matcher: SET_TOOL,
              timeout: CHECK_HOOK_S,
              hooks: [
                async (input: { tool_input?: { ticket?: string; verdict?: string } }) => {
                  const id = input.tool_input?.ticket;
                  if (input.tool_input?.verdict !== "done" || !id) return {};
                  let check;
                  try {
                    const t = (await host.call(ticketList, { ticket: id }, { from: s.callsign })).tickets[0];
                    if (t?.state !== "work" || t.session !== s.callsign) return {};
                    check = t.check;
                  } catch (e) {
                    // службы не ответили — не ответят и вердикту: отказ словом, сессия сдаст позже
                    return (e as Refusal).word === "no_ticket" ? {} : deny(`Шаг не принят: не удалось узнать проверку шага — ${(e as Error).message}. Сдай ещё раз.`);
                  }
                  if (!check) return {};
                  // как запустить проверку и что считать её исходом — одно на шаг и на правило входа: помощники договора
                  const o = checkOutcome(check, await host.call(shellRun, checkRun(check, "@" + host.machine, s.info.cwd)));
                  host.log.info("work", { callsign: s.callsign, kind: "checked", why: `тикет ${id}: ${o.good ? `проверка «${check.run}» прошла` : o.text.split("\n")[0]}` });
                  if (o.good) return {};
                  const note = o.text;
                  // возврат записывает машина: шаг остаётся у этой сессии, второй возврат ставит тикет в «стоп»
                  const set = await host.call(ticketSet, { ticket: id, verdict: "back", note }).catch((e: unknown) => {
                    host.log.warn("work", { callsign: s.callsign, kind: "checked", word: (e as Refusal).word ?? "offline", why: `тикет ${id}: возврат проверки не записан — ${(e as Error).message}` });
                    return undefined;
                  });
                  return deny(set?.state === "stop" ? `Шаг встал: ${note}\nЭто второй возврат на шаге — тикет ждёт человека. Больше его не сдавай.` : `Шаг не принят: ${note}\nИсправь и сдай снова.`);
                },
              ],
            },
          ],
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
