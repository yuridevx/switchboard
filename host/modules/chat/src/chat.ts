// Модуль разговора с сессией: ввод, чтение, лента и вопросы одной сессии. Части делят только host и список зрителей.
import type { Host, Module } from "@switchboard/host";
import { makeFeed } from "./feed.ts";
import { makeInput } from "./input.ts";
import { makeQuestions } from "./questions.ts";
import { makeRead } from "./read.ts";


export function make(): Module {
  let current: Host;
  const host = () => current;
  const input = makeInput(host);
  const feed = makeFeed(host);
  const questions = makeQuestions(host, feed.viewers);
  return {
    // предложение следующего ввода и частичные сообщения: оба едут лентой
    session: () => ({ promptSuggestions: true, includePartialMessages: true }),
    requests: { ...input.requests, ...makeRead(host), ...feed.requests, ...questions.requests },
    frames: input.frames,
    decide: questions.decide,
    elicit: questions.elicit,
    on: feed.on,
    start(h) {
      current = h;
    },
    // ждущие вопросы не трогает: ответ при остановке был бы ответом за человека
    stop() {
      feed.flushAll();
    },
  };
}
