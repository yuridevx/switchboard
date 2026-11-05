// Снесено: модуль пишется заново.
import { refuse, type Module } from "@switchboard/host";

const gone = (): never => {
  throw refuse("снесено");
};
export const make = (): Module => ({ requests: Object.fromEntries(["session.prompt", "message", "session.history", "session.files", "session.watch", "session.unwatch", "answer", "question.list"].map((n) => [n, gone])) });
export const task = (_from: string, _text: string): string => gone();
export const wrap = (_from: string, _text: string): string => gone();
