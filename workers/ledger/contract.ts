// Контракт ledger: журнал флота. Пишут кадром ledger.add (без id), читают запросом ledger.read.
// machine.left и machine.back — ledger.add от relay машины (from .relay) без текста: текст пишет ledger по прежним записям.

export const CONTRACT = { "ledger.add": 1, "ledger.read": 1 } as const;

/**
 * ledger.add — запись о машине или сессии. ev — имя из контракта пишущего; text — что случилось словами.
 * by — по чьей команде (from исходного запроса); machine — о какой машине (у записи сессии — её машина).
 * Ответа нет: отказ — строкой в журнале ledger.
 */
export type LedgerAdd = {
  type: "ledger.add";
  v?: 1;
  to: ".ledger";
  ev: string;
  text: string;
  by?: string;
  machine?: string;
  callsign?: string;
};

/** ledger.read — записи, новые сначала. before или after — id; фильтр machine. */
export type LedgerRead = {
  type: "ledger.read";
  id: string;
  v?: 1;
  to: ".ledger";
  limit: number;
  before?: number;
  after?: number;
  machine?: string;
};

export type LedgerEvent = {
  id: number;
  /** часы ledger в миг записи, мс UTC */
  t: number;
  ev: string;
  /** кто записал — адрес, который поставил relay */
  from: string;
  by?: string;
  machine?: string;
  callsign?: string;
  text: string;
};

/** Ответ на ledger.read: more — есть ли ещё записи в ту же сторону. */
export type LedgerReadResult = { events: LedgerEvent[]; more: boolean };
