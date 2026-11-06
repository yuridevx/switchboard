// Привязки Worker'а, отказ словом и строка журнала.
import type { GateApi } from "@switchboard/gate";
import type { Frame } from "@switchboard/protocol";
import type { Word } from "../contract.ts";

export type Env = {
  BUCKET: R2Bucket;
  DB: D1Database;
  GATE: Pick<GateApi, "verify" | "list">;
  RELAY: { deliver(f: Frame): Promise<number> };
  LEDGER: { frame(f: Frame): Promise<Frame[]> };
  FLEET: string;
  CF_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  R2_LINK_KEY_ID: string;
  R2_LINK_SECRET: string;
};

export class Refusal extends Error {
  word: Word;
  /** только в журнал: в ответ не идёт */
  extra: Record<string, unknown>;
  constructor(word: Word, why: string, extra: Record<string, unknown> = {}) {
    super(why);
    this.word = word;
    this.extra = extra;
  }
}

export const refuse = (word: Word, why: string, extra?: Record<string, unknown>): never => {
  throw new Refusal(word, why, extra);
};

export const line = (record: Record<string, unknown>) => console.log(JSON.stringify(record));
