// Определение фабрики второго проекта коробки — «очередь»: пост на две сессии, пост на одну, пост «по предмету», пост-надзиратель и вход с адресом. Его несёт тот же репозиторий
// кусочков, в папке кусочка (queue/factory.json): один репозиторий ролей держит определения двух проектов. Применяет и гоняет живая проверка
// «очередь поста» (tools/fleet/live-queue.ts); она же на время одного шага уменьшает пост на две сессии до одной и возвращает как было.

import { say, tool, turn } from "../fleet/turn.mjs";

/** Проект, папка кусочка с его определением, пост на две сессии, пост на одну и правило входа с адресом. */
export const PROJECT = "queue", FOLDER = "queue", PAIR = "pair", DESK = "desk", GATE = "gate";
/** Пост «по предмету» и пост-надзиратель: ему правило stop отдаёт тикеты, вставшие от платформы. */
export const LANE = "lane", WATCH = "watch";
/** Постов в определении. */
export const POSTS = 4;
/** Сессий у поста PAIR. */
export const PAIR_SIZE = 2;

/** Файл определения: папки сессий — в папке коробки, уходят вместе с ней. Всё — на первой машине: проверка идёт на тихой дорожке. */
export function definition({ state, key, model, machines }) {
  const dir = state.replaceAll("\\", "/");
  const at = "@" + machines[0];
  return {
    project: PROJECT,
    posts: {
      [PAIR]: { title: "Двое", at, cwd: dir + "/pair", key, model, for: "5m", size: PAIR_SIZE },
      [DESK]: { title: "Стол", at, cwd: dir + "/desk", key, model, for: "5m" },
      [LANE]: { title: "Полоса", at, cwd: dir + "/lane", key, model, for: "5m", context: "thread" },
      [WATCH]: { title: "Надзиратель", at, cwd: dir + "/watch", key, model, for: "5m", context: "fresh" },
    },
    on: [
      { name: GATE, hook: true, to: DESK, title: "Событие проверки очереди" },
      // надзиратель коробки свой тикет сразу сдаёт: вставший возвращает проверка — от имени человека
      { name: "stop", to: WATCH, title: "Тикет встал", text: turn(tool("mcp__fleet__ticket_set", { ticket: "{id}", verdict: "done", note: "разобрано" }), say("разобрано")) },
    ],
  };
}
