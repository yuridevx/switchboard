// Снесено: новый конверт пишется заново.
const gone = (): never => {
  throw new Error("снесено");
};

export type Frame = {
  type: string;
  id?: string;
  v?: number;
  to?: string | string[];
  callsign?: string;
  machine?: string;
  from?: string;
  [field: string]: unknown;
};

export type Reply =
  | { type: "reply"; id: string; ok: true; result?: unknown; from?: string; to?: string | string[] }
  | { type: "reply"; id: string; ok: false; error: string; from?: string; to?: string | string[] };

export type AddressKind = "service" | "part" | "machine" | "session" | "user" | "device";

export const BAD_FRAME = "снесено";
export const TOO_LARGE = "снесено";
export const MAX_FRAME = 0;
export const CALL_MS = 0;
export const READ_MS = 0;
export const oversize = (_text: string): number | null => gone();
export const parseFrame = (_text: string): Frame | null => gone();
export const isReply = (_f: Frame): _f is Frame & Reply => gone();
export const ok = (_id: string, _result?: unknown): Reply => gone();
export const fail = (_id: string, _error: string): Reply => gone();
export const accepts = (_f: { type: string; v?: unknown }, _provides: Record<string, number>): { word: "unknown_request" | "contract_mismatch"; why: string } | null => gone();
export const kindOf = (_address: unknown): AddressKind | null => gone();
export const machineOf = (_address: string): string | null => gone();
export const nameOf = (_address: string): string => gone();
export const userOf = (_address: string): string | null => gone();
export const reaches = (_to: string, _device: string): boolean => gone();
export const hostOf = (_f: { to?: unknown; callsign?: unknown; machine?: unknown }): string | null | undefined => gone();
export const serviceAddress = (_name: string): string => gone();
export const withLimit = <T>(_p: T | Promise<T>, _ms: number, _late: () => T): Promise<T> => gone();
export const within = <T>(_p: T | Promise<T>, _why: string, _ms?: number): Promise<T> => gone();
