// Определение фабрики второго проекта коробки — «очередь»: пост на две сессии, пост на одну и вход с адресом. Его несёт тот же репозиторий
// кусочков, в папке кусочка (queue/factory.json): один репозиторий ролей держит определения двух проектов. Применяет и гоняет живая проверка
// «очередь поста» (tools/fleet/live-queue.ts); она же на время одного шага уменьшает пост на две сессии до одной и возвращает как было.

/** Проект, папка кусочка с его определением, пост на две сессии, пост на одну и правило входа с адресом. */
export const PROJECT = "queue", FOLDER = "queue", PAIR = "pair", DESK = "desk", GATE = "gate";
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
    },
    on: [{ name: GATE, hook: true, to: DESK, title: "Событие проверки очереди" }],
  };
}
