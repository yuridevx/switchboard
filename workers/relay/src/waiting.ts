// Ждущие запросы соединения: у каждого предел и адресат, чей уход из roster значит: ответа не будет.
import { fail, kindOf, machineOf, type Frame, type Reply } from "@switchboard/protocol";
import type { Roster } from "../contract.ts";

type Target = { machine: string; since?: number } | { name: string; present: boolean } | null;
type Pending = { settle(r: Reply): void; target: Target };

const sinceOf = (r: Roster | null, machine: string) => r?.machines.find((m) => m.machine === machine)?.since;
const listed = (r: Roster | null, name: string) => !!r && r.clients.includes(name);

/** Адресат запроса; часть машины и пользователь в roster не видны: ответ или offline даст relay. */
function targetOf(f: Frame, roster: Roster | null): Target {
  const onMachine = (machine: string) => ({ machine, since: sinceOf(roster, machine) });
  if (typeof f.to === "string") {
    const kind = kindOf(f.to);
    if (kind === "machine" || kind === "session") return onMachine(machineOf(f.to)!);
    return kind === "service" || kind === "device" ? { name: f.to, present: listed(roster, f.to) } : null;
  }
  if (f.to !== undefined) return null;
  if (typeof f.callsign === "string") {
    const machine = machineOf(f.callsign);
    return machine ? onMachine(machine) : null;
  }
  return typeof f.machine === "string" ? onMachine(f.machine) : null;
}

const gone = (t: Target, roster: Roster | null) => {
  if (!t) return false;
  return "machine" in t ? sinceOf(roster, t.machine) !== t.since : t.present && !listed(roster, t.name);
};

export class Waiting {
  private pending = new Map<string, Pending>();

  /** Запрос ждёт reply с id: нет ответа за ms — timeout. Поздний ответ take не находит: он уходит дальше как ответ без ждущего. */
  add(f: Frame & { id: string }, roster: Roster | null, ms: number): Promise<Reply> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(f.id, fail(f.id, "timeout")), ms);
      this.pending.set(f.id, {
        target: targetOf(f, roster),
        settle: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
    });
  }

  private settle(id: string, reply: Reply): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    p.settle(reply);
    return true;
  }

  /** Ответ на свой запрос; чужой — false. */
  answer(reply: Reply): boolean {
    return this.settle(reply.id, reply);
  }

  /** Правило отправителя: ушёл адресат — ответа не будет, ждущий получает disconnected сразу. */
  rosterChanged(roster: Roster): void {
    for (const [id, p] of [...this.pending]) if (gone(p.target, roster)) this.settle(id, fail(id, "disconnected"));
  }

  /** Связи больше нет: все ждущие — disconnected. */
  dropAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, fail(id, "disconnected"));
  }
}
