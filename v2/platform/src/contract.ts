// Договор платформы для служб: вход привязки (WorkerEntrypoint "Platform"). Службы знают платформу, платформа служб не знает.
import type { Frame, MachineRow, Reply, Who } from "@sb/protocol";

export const ENTRYPOINT = "Platform";

export interface PlatformApi {
  /** Кто пришёл. as — позывной сессии при пропуске машины: машина говорит за свои сессии. Отказ — словом. */
  who(key: string, as?: string): Promise<Who | { error: string; why?: string }>;
  /** Запрос объекту флота (invite, passes, revoke, whoami, people.*, project.*; redeem — who null, флот берётся из приглашения). */
  fleetCall(fleet: string, who: Who | null, frame: Frame): Promise<Reply>;
  /** Кадр сессии, машине или keeper: объект машины отдаёт его Host или Keeper. С id — ждёт ответ; без id — null. Машина не на связи — отказ offline. */
  deliver(fleet: string, frame: Frame): Promise<Reply | null>;
  /** Кадр каждой машине флота: Host (role host) или Keeper. Ответ — скольким отдано. */
  broadcast(fleet: string, frame: Frame, role: "host" | "keeper"): Promise<number>;
  /** Открыта ли у человека страница. */
  online(fleet: string, person: string): Promise<boolean>;
  /** Живые из названных номеров пропусков: отозванных в ответе нет. */
  alive(fleet: string, kids: string[]): Promise<string[]>;
  /** Проход соединений /f/<флот> и /m/<флот>/<машина> от служб как есть. */
  fetch(request: Request): Promise<Response>;
  /** Машины флота. */
  machines(fleet: string): Promise<MachineRow[]>;
}

/** Адреса соединений: /f/<флот> — страница к объекту флота; /m/<флот>/<машина> — Host, Keeper и зрители к объекту машины.
 *  POST /boot — завести флот: тело { fleet, person }, заголовок Authorization: Bearer <секрет BOOT>; ответ — приглашение первого устройства админа. */
export const ROUTES = { fleet: "/f/", machine: "/m/", boot: "/boot", health: "/health" } as const;
