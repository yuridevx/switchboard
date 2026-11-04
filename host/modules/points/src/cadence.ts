// Когда снимать точку помеченной сессии: конец хода — если с прошлой прошло 2 мин; ход идёт 10 мин без точки — посреди хода.
// Рано — отметка на «2 мин после точки»: сессия свободна — точка сразу, занята — на конце её хода. Всё в памяти: после перезапуска Host считается заново.
import type { SessionState } from "@switchboard/host";

const GAP_MS = 2 * 60_000;
const LONG_MS = 10 * 60_000;

export class Cadence {
  private lastAt: number | undefined;
  private inTurn = false;
  private owed = false;
  private longTimer: ReturnType<typeof setTimeout> | undefined;
  private gapTimer: ReturnType<typeof setTimeout> | undefined;
  /** Повод снять точку; state — нынешнее состояние сессии. */
  private fire: () => void;
  private state: () => SessionState;

  constructor(fire: () => void, state: () => SessionState) {
    this.fire = fire;
    this.state = state;
  }

  /** Точка снята: отсчёт заново. */
  taken(): void {
    this.lastAt = Date.now();
  }

  /** Ход идёт — следим за долгим ходом, закончился — решаем про точку. */
  onState(st: SessionState): void {
    if (st === "busy" || st === "waiting") {
      this.inTurn = true;
      this.watchLongTurn();
      return;
    }
    this.stopLongTurn();
    // конец хода — idle после хода; idle после старта процесса — не повод
    if (st === "idle" && this.inTurn) this.turnEnded();
  }

  /** Сессия закрылась: долгого хода нет. */
  closed(): void {
    this.stopLongTurn();
  }

  dispose(): void {
    this.stopLongTurn();
    clearTimeout(this.gapTimer);
    this.gapTimer = undefined;
  }

  private watchLongTurn(): void {
    if (this.longTimer) return;
    this.longTimer = setTimeout(() => {
      this.longTimer = undefined;
      const st = this.state();
      if (st !== "busy" && st !== "waiting") return;
      this.fire();
      this.watchLongTurn();
    }, LONG_MS);
  }

  private stopLongTurn(): void {
    clearTimeout(this.longTimer);
    this.longTimer = undefined;
  }

  private turnEnded(): void {
    this.inTurn = false;
    const since = this.lastAt === undefined ? Infinity : Date.now() - this.lastAt;
    if (this.owed || since >= GAP_MS) {
      this.owed = false;
      clearTimeout(this.gapTimer);
      this.gapTimer = undefined;
      this.fire();
      return;
    }
    this.gapTimer ??= setTimeout(() => {
      this.gapTimer = undefined;
      if (this.state() === "idle") this.fire();
      else this.owed = true;
    }, GAP_MS - since);
  }
}
