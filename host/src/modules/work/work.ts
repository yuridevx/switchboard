// «Дать работу»: служба «Фабрика» отдаёт сессии тикет. Сессии с таким именем нет — открыть по документу; остановлена — поднять;
// ввод — тегом вида ticket. Граница тикетов: служба сказала «заново» — перед тикетом разговор очищается командой Claude Code; не сказала,
// а разговор большой — сжимается; последний ход начал человек — разговор не трогаем.
// «В работе» значит, что сессия работает: любой её ход, который кончился, пока тикет у неё, — ни вердикта, ни сна, ни передачи, —
// возвращается один раз штатным хуком остановки Claude Code; кончился снова — тикету «стоп» с последними словами сессии. Ход не трогаем,
// пока жива фоновая работа, стоит побудка или его начал человек: это машина знает сама и служб не спрашивает.
// Проверка поста — скрипт из определения: машина запускает его перед вердиктом «сдал» штатным хуком перед вызовом инструмента;
// код не 0 — вердикт не уходит, тикету — возврат с выводом скрипта. Что проверять, знает тикет: машина спрашивает его в момент вердикта.
// Записей о тикетах модуль не держит: что тикет у сессии и чем он кончился, записано в тикете. В памяти — только ввод, который дан
// и ходом ещё не взят; после перезапуска Host восстанавливать нечего.
import { randomUUID } from "node:crypto";
import { checkOutcome, checkRun, FACTORY, type FileIn, Refusal, shellRun, type Spec, TICKET_SET_TOOL, ticketList, ticketSet } from "@sb/protocol";
import type { Ctx, HostApi, Module, SessionApi } from "../../core/contract.ts";
import type { AccountsApi } from "../accounts/contract.ts";
import { type ChatApi, envelope } from "../chat/contract.ts";
import type { FilesApi } from "../files/contract.ts";
import { RUN_MS } from "../shell/contract.ts";

/** Работу сессии даёт только служба «Фабрика». */
const FROM = FACTORY;
/** Инструмент вердикта у процесса сессии. */
const SET_TOOL = TICKET_SET_TOOL;
/** Предел хука проверки поста у Claude Code, секунды: сама проверка ограничена сроком из определения, он не больше предела запуска скрипта машины. */
const CHECK_HOOK_S = RUN_MS / 1000;
/** Предел хука конца хода, секунды: вопрос службам «какие тикеты в работе у сессии» и «стоп» тикету; службы не успели — ход кончается как есть. */
const STOP_HOOK_S = 30;
/** Сколько знаков последних слов сессии идёт в причину «стопа». */
const SAID = 300;
/** Что Claude Code говорит хуку конца хода. */
type Ended = { stop_hook_active?: boolean; background_tasks?: unknown[]; session_crons?: unknown[]; last_assistant_message?: string };

export function make(): Module {
  let host: HostApi;
  /** ввод, который дан и ещё не взят ходом: номер сообщения → чей и какой тикет */
  const given = new Map<string, { callsign: string; ticket: string }>();
  const word = (ticket: string) => `тикет ${ticket}`;
  const failed = (callsign: string, kind: string, what: string) => (e: unknown) =>
    host.log.warn("work", { callsign, kind, word: (e as Refusal).word ?? "offline", why: `${what} — ${(e as Error).message}` });

  /** Тикет, если он всё ещё у этой сессии: в работе и ведёт его она. Сдан, отложен, передан, встал или тикета нет — null.
   *  Службы не ответили — отказ тому, кто спросил. */
  async function own(callsign: string, ticket: string) {
    try {
      const t = (await host.call(ticketList, { ticket })).tickets?.[0];
      return t?.state === "work" && t.session === callsign ? t : null;
    } catch (e) {
      if ((e as Refusal).word === "no_ticket") return null;
      throw e;
    }
  }

  /** Тикеты в работе у сессии — так говорят службы; машина их не помнит. Тикет, чей ввод ход ещё не взял, не в счёт: он придёт следующим
   *  ходом. Сессия без проекта тикетов проекта не ведёт. */
  async function held(callsign: string, project: string | undefined): Promise<string[]> {
    if (!project) return [];
    const waits = new Set([...given.values()].filter((g) => g.callsign === callsign).map((g) => g.ticket));
    return (await host.call(ticketList, { project, session: callsign, state: "work" })).tickets.map((t) => t.id).filter((id) => !waits.has(id));
  }

  /** Процесса сессии больше нет, а тикеты у неё: каждому — «стоп» с причиной. Служба не ответила — строка журнала: тикет закроет его срок. */
  function lost(callsign: string, project: string | undefined, why: string): void {
    const waits = [...given].filter(([, g]) => g.callsign === callsign);
    for (const [uuid] of waits) given.delete(uuid);
    void (async () => {
      const ids = new Set(await held(callsign, project));
      // выданное, но не взятое: тикет уже мог уйти от сессии — спрашиваем его самого
      for (const [, g] of waits) if (await own(callsign, g.ticket)) ids.add(g.ticket);
      for (const id of ids) await host.call(ticketSet, { ticket: id, verdict: "stop", note: why }).catch(failed(callsign, "lost", `${word(id)}: «стоп» не записан`));
    })().catch(failed(callsign, "lost", "тикеты сессии не названы"));
  }

  return {
    name: "host-work",
    start(h) {
      host = h;
    },
    requests: {
      async "work.give"(i: { name: string; spec?: Spec; ticket: string; on?: string; key?: string; text: string; files?: FileIn[]; asker?: string; clear?: boolean }, ctx: Ctx) {
        if (ctx.from !== FROM) throw new Refusal("forbidden", "работу сессии даёт служба «Фабрика»: создайте тикет — ticket.new");
        const callsign = `${i.name}@${host.machine}`;
        let s = host.session(callsign);
        // у только что открытой сессии разговора ещё нет: на границе делать нечего
        const opened = !s;
        if (!s) {
          if (!i.spec) throw new Refusal("no_session", `сессии ${callsign} нет`);
          // папку сессии называет определение: её нет — создаётся
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
        // вопросы сессии по этому тикету идут тому, кто дал задачу тикетом, — как вопросы дочери идут родителю
        const chat = host.module<ChatApi>("host-chat");
        if (i.asker) chat?.asked(callsign, i.asker);
        // граница тикетов: «заново» — очистка разговора, иначе большой разговор сжимается; команда встаёт во ввод перед тикетом и,
        // как он, ждёт конца идущего хода. Разговор, который последним ходом вёл человек, не трогаем
        let edge = "";
        if (!opened && !chat?.human(callsign)) {
          if (i.clear) {
            s.input("/clear", { priority: "later" });
            edge = " · разговор заново";
          } else if (host.module<AccountsApi>("host-accounts")?.squeeze(s)) edge = " · разговор сжат";
        }
        const uuid = randomUUID();
        given.set(uuid, { callsign, ticket: i.ticket });
        // тикет — новым ходом: ввод ждёт конца идущего хода, а не вклинивается в него. Иначе следующий тикет той же сессии
        // приходил бы посреди хода, которым она сдаёт прошлый
        s.input(envelope(FROM, "ticket", text, { ticket: i.ticket, on: i.on, key: i.key }), { priority: "later", uuid });
        host.log.info("work", { callsign, kind: "given", why: word(i.ticket) + edge });
        return { callsign };
      },
    },
    compose(s) {
      /** Вердикт «сдал» не принят: причина — сессии. */
      const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
      return {
        hooks: {
          // «сдал» тикету поста с проверкой: сначала скрипт на этой машине, в папке сессии, с пределом из определения
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
                    const t = await own(s.callsign, id);
                    if (!t) return {};
                    check = t.check;
                  } catch (e) {
                    // службы не ответили — не ответят и вердикту: отказ словом, сессия сдаст позже
                    return deny(`Тикет не принят: не удалось узнать проверку поста — ${(e as Error).message}. Сдай ещё раз.`);
                  }
                  if (!check) return {};
                  // как запустить проверку и что считать её исходом — одно на пост и на правило входа: помощники договора
                  const o = checkOutcome(check, await host.call(shellRun, checkRun(check, "@" + host.machine, s.info.cwd)));
                  host.log.info("work", { callsign: s.callsign, kind: "checked", why: `тикет ${id}: ${o.good ? `проверка «${check.run}» прошла` : o.text.split("\n")[0]}` });
                  if (o.good) return {};
                  const note = o.text;
                  // возврат записывает машина: тикет остаётся у этой сессии, второй возврат ставит его в «стоп»
                  const set = await host.call(ticketSet, { ticket: id, verdict: "back", note }).catch((e: unknown) => {
                    failed(s.callsign, "checked", `тикет ${id}: возврат проверки не записан`)(e);
                    return undefined;
                  });
                  return deny(set?.state === "stop" ? `Тикет встал: ${note}\nЭто второй возврат — больше его не сдавай.` : `Тикет не принят: ${note}\nИсправь и сдай снова.`);
                },
              ],
            },
          ],
          // ход кончается, а тикет всё ещё в работе у сессии. Сначала то, что машина знает сама: жива фоновая работа или стоит побудка —
          // ход вернётся сам; ход начал человек — пост отвечает человеку и держит тикет дальше. Тогда служб не спрашиваем. Иначе —
          // вопрос службам; первый раз ход возвращается с напоминанием, второй подряд (о нём говорит сам хук) — тикету «стоп»
          Stop: [
            {
              timeout: STOP_HOOK_S,
              hooks: [
                async (input: Ended) => {
                  const cs = s.callsign;
                  if (input.background_tasks?.length || input.session_crons?.length || host.module<ChatApi>("host-chat")?.human(cs)) return {};
                  let open: string[];
                  try {
                    open = await held(cs, s.spec.project);
                  } catch (e) {
                    failed(cs, "held", "тикеты в работе не названы")(e);
                    return {};
                  }
                  if (!open.length) return {};
                  const ids = open.join(", ");
                  if (input.stop_hook_active) {
                    const said = (input.last_assistant_message ?? "").trim().slice(-SAID);
                    const why = `ход кончился без вердикта${said ? `: ${said}` : ""}`;
                    for (const id of open) await host.call(ticketSet, { ticket: id, verdict: "stop", note: why }).catch(failed(cs, "stopped", `${word(id)}: «стоп» не записан`));
                    host.log.info("work", { callsign: cs, kind: "stopped", why: `${ids}: ${why}` });
                    return {};
                  }
                  host.log.info("work", { callsign: cs, kind: "reminded", why: open.map(word).join(", ") });
                  return {
                    decision: "block",
                    reason: `Тикет не сдан: ${ids}. «В работе» значит, что ты работаешь. Сдай его инструментом ticket_set — verdict done (сделано), back (вернуть с замечанием) или stop (нужен человек), заметка — в note. Ждёшь чужого тикета — усыпи свой: after с его номером, он вернётся тебе с итогом. Ждёшь времени, ответа или свою дочернюю сессию — усыпи на срок: in (40m, 2h); в note — где работа и что дальше. Не твоё — передай: to. Кончишь ход ещё раз без этого — тикет встанет с твоими последними словами.`,
                  };
                },
              ],
            },
          ],
        },
      };
    },
    on: {
      event(_s, msg) {
        // ход взял сообщения: процесс называет их номера на ответах модели и на итоге хода
        const uuids: unknown[] = Array.isArray(msg?.user_message_uuids) ? msg.user_message_uuids : msg?.type === "user" && typeof msg.uuid === "string" ? [msg.uuid] : [];
        for (const u of uuids) given.delete(u as string);
      },
      state(s: SessionApi, state) {
        if (state === "failed") lost(s.callsign, s.spec.project, `сессия остановилась со сбоем${s.info.error ? `: ${s.info.error}` : ""}`);
        else if (state === "stopped") lost(s.callsign, s.spec.project, "сессия остановлена");
      },
      removed(callsign) {
        lost(callsign, undefined, "сессия убрана");
      },
    },
  };
}
