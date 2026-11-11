// Объект флота: кто пришёл, люди, проекты, пропуска и картина флота.
import { Done, Empty, frame, Name, Person, request, z } from "../define.ts";
import { SessionRow } from "./session.ts";

export const PassRow = z.object({
  kid: z.string(),
  /** устройство `pult~a@b.c` или машина `@laptop` */
  addr: z.string(),
  /** человек, от чьего имени действует */
  person: Person,
  /** приглашение ещё не принято */
  wait: z.boolean(),
  at: z.number(),
  seen: z.number().optional(),
  /** кто пригласил: адрес предъявителя */
  by: z.string().optional(),
  /** открыто ли сейчас соединение этим пропуском (страница или машина на связи) */
  online: z.boolean().optional(),
});
export type PassRow = z.infer<typeof PassRow>;

/** Пригласить: своё устройство или машину — любой; чужого человека — админ. Приглашение живёт сутки.
 *  fresh — ждём нового человека: человек уже во флоте — отказ `exists`. */
export const invite = request("invite", {
  owner: "fleet", target: "fleet",
  tool: "Выдать приглашение на сутки: addr — устройство вида pult~a@b.c или машина вида @laptop; owner — владелец машины (по умолчанию вы).",
  input: z.object({ addr: z.string(), owner: Person.optional(), fresh: z.boolean().optional() }),
  output: z.object({ kid: z.string(), invite: z.string() }),
});
/** Принять приглашение: без пропуска; ответ — пропуск. У приглашения согласия OAuth — ещё verifier, client и back: без них оно не принимается. */
export const redeem = request("redeem", {
  owner: "fleet", target: "fleet", open: true,
  input: z.object({ invite: z.string(), verifier: z.string().optional(), client: z.string().optional(), back: z.string().optional() }),
  output: z.object({ key: z.string(), addr: z.string() }),
});
/** Согласие на вход внешнего клиента (OAuth): человек со страницы разрешает клиенту действовать от его имени.
 *  client — адрес описания клиента (client_id), back — адрес возврата (redirect_uri), challenge — code_challenge (S256).
 *  Ответ — код (приглашение устройства `<имя>~почта`): страница возвращает человека на back с ?code=…&state=…. Адреса возврата нет в описании клиента — отказ bad_client. */
export const consent = request("consent", {
  owner: "fleet", target: "fleet",
  input: z.object({ client: z.string(), back: z.string(), challenge: z.string().min(16), label: Name.optional() }),
  output: z.object({ code: z.string(), kid: z.string(), addr: z.string(), client: z.object({ name: z.string().optional(), uri: z.string().optional() }) }),
});
/** kind — только машины или только устройства; kids — только эти номера (отозванных в ответе нет). */
export const passes = request("passes", {
  owner: "fleet", target: "fleet", tool: "Пропуска флота: свои; у админа — все. kind — machine или device; kids — только эти номера.",
  input: z.object({ kind: z.enum(["machine", "device"]).optional(), kids: z.array(z.string()).optional() }), output: z.object({ passes: z.array(PassRow) }),
});
/** Отозвать пропуск или приглашение: свои — любой, чужие — админ. Соединения с ним закрываются. */
export const revoke = request("revoke", {
  owner: "fleet", target: "fleet", tool: "Отозвать пропуск или приглашение по номеру.",
  input: z.object({ kid: z.string() }), output: Done,
});
export const whoami = request("whoami", {
  owner: "fleet", target: "fleet",
  input: Empty,
  output: z.object({ addr: z.string(), person: Person, admin: z.boolean(), machines: z.array(z.string()), fleet: z.string() }),
});

export const PersonRow = z.object({
  person: Person, name: z.string().optional(), admin: z.boolean(), projects: z.array(z.string()), at: z.number(),
  /** открыта ли у человека страница */
  online: z.boolean().optional(),
  /** устройства и машины человека: на связи, ждёт входа (приглашение не принято) */
  devices: z.array(z.object({ kid: z.string(), addr: z.string(), wait: z.boolean(), online: z.boolean(), at: z.number(), seen: z.number().optional() })).optional(),
});
export type PersonRow = z.infer<typeof PersonRow>;
export const Project = z.object({ id: Name, name: z.string(), members: z.array(Person) });
export type Project = z.infer<typeof Project>;

export const peopleList = request("people.list", {
  owner: "fleet", target: "fleet", tool: "Люди флота и их проекты.",
  input: Empty, output: z.object({ people: z.array(PersonRow), projects: z.array(Project) }),
});
export const peopleSet = request("people.set", {
  owner: "fleet", target: "fleet", admin: true,
  input: z.object({ person: Person, name: z.string().optional(), admin: z.boolean().optional(), projects: z.array(z.string()).optional() }),
  output: Done,
});
export const peopleRemove = request("people.remove", {
  owner: "fleet", target: "fleet", admin: true,
  input: z.object({ person: Person }), output: Done,
});
export const projectSet = request("project.set", {
  owner: "fleet", target: "fleet", admin: true,
  /** project — номер проекта. Поле id здесь не работает: это имя занято конвертом кадра. */
  input: z.object({ id: z.string().optional(), project: Name, name: z.string(), members: z.array(Person).optional() }), output: Done,
});
export const projectRemove = request("project.remove", {
  owner: "fleet", target: "fleet", admin: true,
  input: z.object({ id: z.string().optional(), project: Name }), output: Done,
});

/* ===== Картина флота ===== */

export const MachineRow = z.object({
  name: Name,
  owner: Person,
  online: z.boolean(),
  /** с какого момента на связи или без связи */
  since: z.number(),
  build: z.number().optional(),
  sdk: z.string().optional(),
  os: z.string().optional(),
  keeper: z.boolean().optional(),
});
export type MachineRow = z.infer<typeof MachineRow>;

/** Картина флота одним ответом — для модели и скриптов: машины и сессии, до которых достаёт спросивший, и люди на связи. */
export const fleetList = request("fleet.list", {
  owner: "fleet", target: "fleet",
  tool: "Картина флота: машины (на связи или нет, с какого времени), сессии с состоянием и документом и люди на связи — только то, до чего вы достаёте. machine — только эта машина; project — сессии одного проекта доски; state — сессии в этом состоянии (idle, busy, waiting, stopped, failed).",
  input: z.object({ machine: Name.optional(), project: z.string().optional(), state: z.string().optional() }),
  output: z.object({ machines: z.array(MachineRow), sessions: z.array(SessionRow), people: z.array(z.object({ person: Person, name: z.string().optional(), devices: z.array(z.string()) })) }),
});

/** Снимок картины: приходит странице при подключении. В нём только машины, до которых человек достаёт. */
export const roster = frame("roster", {
  owner: "fleet",
  payload: z.object({
    rev: z.number(),
    you: z.object({ addr: z.string(), person: Person, admin: z.boolean() }),
    machines: z.array(MachineRow),
    sessions: z.array(SessionRow),
  }),
});
/** Изменения картины: строка машины, строка сессии (null — убрана). */
export const rosterDelta = frame("roster.delta", {
  owner: "fleet",
  payload: z.object({
    rev: z.number(),
    machines: z.array(MachineRow).optional(),
    gone: z.array(z.string()).optional(),
    sessions: z.array(z.object({ callsign: z.string(), row: SessionRow.nullable() })).optional(),
  }),
});

/** Первое сообщение соединения. role: page — к объекту флота; host, keeper, watch — к объекту машины. */
export const hello = frame("hello", {
  owner: "fleet",
  payload: z.object({ proto: z.number(), key: z.string(), role: z.enum(["page", "host", "keeper", "watch"]), as: z.string().optional() }),
});

/** Зритель ушёл: объект машины → Host, когда у адреса не осталось соединений с этой машиной. from — адрес зрителя. */
export const watcherGone = frame("watcher.gone", { owner: "platform", payload: z.object({}) });

/** Соединение с объектом машины принято: ответ на hello ролям host, keeper и watch. Странице ответом служит roster. */
export const helloOk = frame("hello.ok", { owner: "platform", payload: z.object({ addr: z.string() }) });
