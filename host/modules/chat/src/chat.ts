// Снесено: вход контракта отвечает отказом словом.
import { refuse, type Module } from "@switchboard/host";

const gone = () => {
  throw refuse("снесено");
};

export const make = (): Module => ({
  requests: { "session.prompt": gone, message: gone, "session.history": gone, "session.files": gone, "session.watch": gone, "session.unwatch": gone, answer: gone, "question.list": gone },
});
export const wrap = (_from: string, _body: string) => "снесено";
export const task = wrap;
