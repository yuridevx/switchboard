// Конверт кадра снесён: типы контракта остались, поведение пишется заново.
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
const gone = (): never => {
  throw new Error("снесено");
};
export const BAD_FRAME = "";
export const TOO_LARGE = "";
export const MAX_FRAME = 0;
export const CALL_MS = 0;
export const READ_MS = 0;
export const oversize = (_t: string): number | null => gone();
export const parseFrame = (_t: string): Frame | null => gone();
export const isReply = (_f: Frame): _f is Frame & Reply => gone();
export const ok = (_id: string, _r?: unknown): Reply => gone();
export const fail = (_id: string, _e: string): Reply => gone();
export const kindOf = (_a: unknown): AddressKind | null => gone();
export const machineOf = (_a: string): string | null => gone();
export const nameOf = (_a: string): string => gone();
export const hostOf = (_f: { to?: unknown; callsign?: unknown; machine?: unknown }): string | null | undefined => gone();
export const userOf = (_a: string): string | null => gone();
export const reaches = (_t: string, _d: string): boolean => gone();
export const accepts = (_f: { type: string; v?: unknown }, _p: Record<string, number>): { word: "unknown_request" | "contract_mismatch"; why: string } | null => gone();
export const serviceAddress = (_n: string): string => gone();
export const within = <T>(_p: T | Promise<T>, _w: string, _ms?: number): Promise<T> => gone();
export const withLimit = <T>(_p: Promise<T>, _ms: number, _late: () => T): Promise<T> => gone();
