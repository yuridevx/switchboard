// Запросы машине: аккаунты, профили, точки, скрипты, инциденты, сама машина, keeper.
import { Callsign, Done, frame, KeeperAddr, MachineAddr, request, z } from "../define.ts";

const toMachine = z.object({ to: MachineAddr });

/* ===== Аккаунты (host-accounts) ===== */

export const Limit = z.object({ name: z.string(), used: z.number(), resets: z.number().optional() });
export const Account = z.object({
  id: z.string(),
  /** claude — вход Claude; key — ключ флота */
  kind: z.enum(["claude", "key"]),
  email: z.string().optional(),
  plan: z.string().optional(),
  /** доля лимитов 0..1 по окнам */
  limits: z.array(Limit).optional(),
  /** место в очереди выбора auto; нет — не участвует */
  slot: z.number().optional(),
  ok: z.boolean(),
  why: z.string().optional(),
  sessions: z.number().optional(),
});
export type Account = z.infer<typeof Account>;

export const accountList = request("account.list", {
  owner: "host-accounts", target: "machine", tool: "Аккаунты машины: входы Claude с лимитами и ключи флота.",
  input: toMachine, output: z.object({ accounts: z.array(Account) }),
});
export const accountLogin = request("account.login", {
  owner: "host-accounts", target: "machine",
  input: toMachine, output: z.object({ login: z.string(), url: z.string() }),
});
export const accountCode = request("account.code", {
  owner: "host-accounts", target: "machine",
  input: z.object({ to: MachineAddr, login: z.string(), code: z.string() }), output: z.object({ account: Account }),
});
export const accountRemove = request("account.remove", {
  owner: "host-accounts", target: "machine",
  /** account — номер аккаунта из account.list. Поле id здесь не работает: это имя занято конвертом кадра. */
  input: z.object({ to: MachineAddr, id: z.string().optional(), account: z.string() }), output: Done,
});
/** Очередь выбора auto: порядок аккаунтов. */
export const slotSet = request("slot.set", {
  owner: "host-accounts", target: "machine",
  input: z.object({ to: MachineAddr, order: z.array(z.string()) }), output: Done,
});
export const keyCheck = request("key.check", {
  owner: "host-proxy", target: "machine",
  input: z.object({ to: MachineAddr, name: z.string() }), output: z.object({ ok: z.boolean(), word: z.string() }),
});

/* ===== Профили (host-profiles) ===== */

export const Piece = z.object({
  id: z.string(),
  repo: z.string(),
  title: z.string().optional(),
  about: z.string().optional(),
  /** что внутри: скилы, агенты, команды, хуки, серверы MCP, память, настройки */
  has: z.record(z.string(), z.number()).optional(),
  rev: z.string().optional(),
  ok: z.boolean(),
  why: z.string().optional(),
});
export type Piece = z.infer<typeof Piece>;

export const profileList = request("profile.list", {
  owner: "host-profiles", target: "machine", tool: "Кусочки профиля на машине: репозитории с плагинами, настройками и памятью.",
  input: toMachine, output: z.object({ pieces: z.array(Piece) }),
});
export const profileView = request("profile.view", {
  owner: "host-profiles", target: "machine", tool: "Что получится у сессии с этим набором кусочков: скилы, агенты, серверы, настройки.",
  input: z.object({ to: MachineAddr, pieces: z.array(z.string()) }),
  output: z.object({ items: z.array(z.object({ kind: z.string(), name: z.string(), piece: z.string(), path: z.string().optional(), about: z.string().optional() })) }),
});
export const profileFile = request("profile.file", {
  owner: "host-profiles", target: "machine",
  input: z.object({ to: MachineAddr, piece: z.string(), path: z.string() }), output: z.object({ text: z.string() }),
});

/* ===== Точки на машине (host-points) ===== */

export const pointsSave = request("points.save", {
  owner: "host-points", target: "session", tool: "Сохранить точку сессии в архив сейчас.",
  input: z.object({ to: Callsign, label: z.string().optional() }), output: z.object({ point: z.string() }),
});
export const pointsRaise = request("points.raise", {
  owner: "host-points", target: "machine",
  tool: "Поднять сессию из архива на машине: sid — сессия архива, point — точка (по умолчанию последняя), name — имя новой сессии, cwd — папка.",
  input: z.object({ to: MachineAddr, sid: z.string(), point: z.string().optional(), name: z.string().optional(), cwd: z.string().optional(), move: z.boolean().optional() }),
  output: z.object({ callsign: Callsign }),
});

/* ===== Скрипты (host-shell) ===== */

export const Run = z.object({
  run: z.string(), state: z.enum(["running", "done", "failed", "killed"]), code: z.number().optional(),
  out: z.string().optional(), started: z.number(), ended: z.number().optional(),
});
export const shellRun = request("shell.run", {
  owner: "host-shell", target: "machine",
  tool: "Выполнить скрипт на машине: script — текст, cwd — папка, wait — ждать конца до стольких секунд (иначе вернётся номер запуска).",
  input: z.object({ to: MachineAddr, script: z.string(), cwd: z.string().optional(), wait: z.number().optional(), shell: z.enum(["bash", "powershell", "node"]).optional() }),
  output: Run,
});
export const shellWait = request("shell.wait", {
  owner: "host-shell", target: "machine", tool: "Дождаться конца запуска скрипта.",
  input: z.object({ to: MachineAddr, run: z.string(), wait: z.number().optional() }), output: Run,
});
export const shellKill = request("shell.kill", {
  owner: "host-shell", target: "machine", tool: "Снять запуск скрипта.",
  input: z.object({ to: MachineAddr, run: z.string() }), output: Run,
});
export const shellInfo = request("shell.info", {
  owner: "host-shell", target: "machine", tool: "Что это за машина: ОС, оболочки, папка пользователя.",
  input: toMachine, output: z.object({ os: z.string(), shells: z.array(z.string()), home: z.string(), node: z.string().optional() }),
});

/* ===== Инциденты (host-incidents) ===== */

export const Incident = z.object({
  id: z.string(), kind: z.string(), key: z.string(), text: z.string(), at: z.number(),
  callsign: Callsign.optional(), state: z.enum(["pending", "taken", "done"]),
});
export type Incident = z.infer<typeof Incident>;
export const incidentList = request("incident.list", {
  owner: "host-incidents", target: "machine", tool: "Обращения служб компьютера и сессии, которые их разбирают.",
  input: toMachine, output: z.object({ incidents: z.array(Incident) }),
});
/** Обращение от службы компьютера: открывает сессию по виду обращения или пишет в уже открытую. */
export const incidentRaise = request("incident.raise", {
  owner: "host-incidents", target: "machine",
  input: z.object({ to: MachineAddr, kind: z.string(), key: z.string(), text: z.string() }), output: z.object({ id: z.string(), callsign: Callsign.optional() }),
});

/* ===== Машина (host-machine) ===== */

export const machineDirs = request("machine.dirs", {
  owner: "host-machine", target: "machine",
  input: z.object({ to: MachineAddr, path: z.string().optional() }),
  output: z.object({ path: z.string(), dirs: z.array(z.string()), recent: z.array(z.string()).optional(), git: z.boolean().optional() }),
});
export const JournalLine = z.object({ t: z.number(), part: z.string(), level: z.enum(["info", "warn", "error"]), msg: z.string() }).loose();
export const machineJournal = request("machine.journal", {
  owner: "host-machine", target: "machine", tool: "Журнал машины: строки Host, Keeper и держателей. part — чей, before — время, до которого читать.",
  input: z.object({ to: MachineAddr, part: z.string().optional(), level: z.enum(["info", "warn", "error"]).optional(), before: z.number().optional(), limit: z.number().optional(), /** только строки этого сквозного номера запроса; имя trace занято конвертом */ of: z.string().optional() }),
  output: z.object({ lines: z.array(JournalLine), more: z.boolean() }),
});

/* ===== Keeper ===== */

export const keeperState = request("keeper.state", {
  owner: "keeper", target: "keeper", tool: "Состояние Keeper машины: какая сборка Host стоит, работает ли он.",
  input: z.object({ to: KeeperAddr }),
  output: z.object({ build: z.number(), host: z.object({ build: z.number(), state: z.enum(["running", "stopped", "failed", "updating"]), why: z.string().optional(), since: z.number().optional() }), os: z.string() }),
});

/** «Спроси план»: служба выпусков → Keeper, без данных. */
export const planChanged = frame("plan.changed", { owner: "builds", payload: z.object({}) });
/** «Изменилось»: настройки флота или ключи — Host перечитывает названное. */
export const changed = frame("changed", { owner: "prefs", payload: z.object({ what: z.string() }) });
