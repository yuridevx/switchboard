// Определение фабрики проекта коробки: пост-сторож, пост с проверкой «сдал» и правила входа: два по времени — с тихой проверкой и с проверкой,
// которая всегда находит, — одно с адресом для событий снаружи и одно без входа: его зовёт по имени машина («ответила не та модель»).
// Его несёт репозиторий кусочков коробки (factory.json), применяет и гоняет живая проверка «правила входа» (tools/fleet/live-rules.ts).
// Шаг сессии — сценарий хода: вердикт с номером тикета.
import { say, tool, turn } from "../fleet/turn.mjs";

/** Проект коробки, у которого применяется определение, его пост-сторож и пост с проверкой «сдал». */
export const PROJECT = "box", POST = "watch", STRICT = "strict";
/** Правила входа: QUIET — проверка возвращает 0; FOUND — проверка возвращает 1 и печатает FOUND_OUT. Срок обоих — RULE_EVERY_S секунд. */
export const QUIET = "quiet", FOUND = "found", FOUND_OUT = "lost=4", RULE_EVERY_S = 10;
/** Правило с адресом для событий снаружи: сторож сдаёт его тикет заметкой DOOR_NOTE. */
export const DOOR = "door", DOOR_NOTE = "событие разобрано";
/** Правило без входа — то, которым машина сообщает «ответила не та модель»: сторож зовёт человека, тикет остаётся открытым. */
export const MODEL = "model";
/** Что печатает проверка поста STRICT, когда не проходит: первый запуск по тикету — код 1, следующие — 0 (флажок тикета в папке сессии). */
export const STRICT_OUT = "флажка нет";

/** Сторож зовёт человека: тикет встаёт и остаётся открытым — следующие события с тем же ключом ложатся в него заметками. */
const human = turn(tool("mcp__fleet__ticket_set", { ticket: "{id}", verdict: "stop", note: "нужен человек" }), say("передано человеку"));
const step = (note) => turn(tool("mcp__fleet__ticket_set", { ticket: "{id}", verdict: "done", note }), say("шаг сдан"));

/** Файл определения: папки сессий — в папке коробки, уходят вместе с ней. Всё — на первой машине: проверка идёт на тихой дорожке,
 *  вторая машина отдана шумной (её Host перезапускают). */
export function definition({ state, key, model, machines }) {
  const dir = state.replaceAll("\\", "/");
  const at = "@" + machines[0];
  return {
    project: PROJECT,
    posts: {
      [POST]: { title: "Сторож", at, cwd: dir + "/post", key, model, for: "5m" },
      // проверка «сдал»: первый запуск по тикету кладёт флажок и не проходит, второй — проходит
      [STRICT]: { title: "Строгий", at, cwd: dir + "/strict", key, model, for: "5m", check: { run: `f=.check-{id}; [ -f "$f" ] && exit 0; touch "$f"; echo ${STRICT_OUT}; exit 1`, for: "30s" } },
    },
    on: [
      { name: QUIET, every: RULE_EVERY_S + "s", to: POST, check: { at, run: 'node -e "process.exit(0)"', for: "30s" } },
      { name: FOUND, every: RULE_EVERY_S + "s", to: POST, title: "Находка сторожа", text: human, check: { at, run: `node -e "console.log('${FOUND_OUT}'); process.exit(1)"`, for: "30s" } },
      { name: DOOR, hook: true, to: POST, title: "Событие снаружи", text: step(DOOR_NOTE) },
      { name: MODEL, to: POST, title: "Ответила не та модель", text: human },
    ],
  };
}
