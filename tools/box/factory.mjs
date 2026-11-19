// Определение фабрики проекта коробки: конвейер из трёх шагов с потолком два, пост-сторож и правила входа: два по времени — с тихой проверкой
// и с проверкой, которая всегда находит, — одно с адресом для событий снаружи и одно без входа: его зовёт по имени машина («ответила не та модель»). Его несёт репозиторий кусочков коробки (factory.json), применяет и гоняет живая проверка «конвейер»
// (tools/fleet/live-lines.ts). Шаг сессии — сценарий хода: вердикт с номером тикета. Второй конвейер — с шагом-ожиданием: сессия называет PR,
// слияние сообщает двойник GitHub коробки событием с подписью.
import { say, tool, turn } from "../fleet/turn.mjs";
import { REPO } from "./github.mjs";

/** Проект коробки, у которого применяется определение, имя его конвейера и поста. */
export const PROJECT = "box", LINE = "three", POST = "watch";
/** Правила входа: QUIET — проверка возвращает 0; FOUND — проверка возвращает 1 и печатает FOUND_OUT. Срок обоих — RULE_EVERY_S секунд. */
export const QUIET = "quiet", FOUND = "found", FOUND_OUT = "lost=4", RULE_EVERY_S = 10;
/** Правило с адресом для событий снаружи: сторож сдаёт его тикет заметкой DOOR_NOTE. */
export const DOOR = "door", DOOR_NOTE = "событие разобрано";
/** Правило без входа — то, которым машина сообщает «ответила не та модель»: сторож зовёт человека, тикет остаётся открытым. */
export const MODEL = "model";
/** Конвейер с шагом-ожиданием и PR, который называет его первый шаг: слияние приходит событием GitHub. */
export const MERGE = "merge", MERGE_PR = `${REPO}#7`;

/** Сторож зовёт человека: тикет встаёт и остаётся открытым — следующие события с тем же ключом ложатся в него заметками. */
const human = turn(tool("mcp__fleet__ticket_set", { ticket: "{id}", verdict: "stop", note: "нужен человек" }), say("передано человеку"));
const step = (note) => turn(tool("mcp__fleet__ticket_set", { ticket: "{id}", verdict: "done", note }), say("шаг сдан"));

/** Файл определения: папки сессий — в папке коробки, уходят вместе с ней. */
export function definition({ state, key, model, machines }) {
  const dir = state.replaceAll("\\", "/");
  const at = "@" + machines[0];
  return {
    project: PROJECT, limit: 2,
    posts: { [POST]: { title: "Сторож", at, cwd: dir + "/post", key, model, for: "5m" } },
    repos: { pieces: { repo: REPO } },
    lines: {
      [LINE]: {
        title: "Три шага", limit: 2, for: "10m", at: machines.map((m) => "@" + m), cwd: dir + "/line/{id}", key, model,
        steps: [
          { name: "сделать", session: "new", do: step("сделано") },
          { name: "довести", session: "same", do: step("доведено") },
          { name: "принять", session: "new", do: step("принято") },
        ],
      },
      [MERGE]: {
        title: "Слияние", limit: 1, for: "10m", at: [at], cwd: dir + "/line/{id}", key, model,
        steps: [
          { name: "открыть", session: "new", do: turn(tool("mcp__fleet__ticket_set", { ticket: "{id}", verdict: "done", note: "PR открыт", pr: MERGE_PR }), say("шаг сдан")) },
          { name: "слияние", wait: "pr.merged", for: "5m" },
        ],
      },
    },
    on: [
      { name: QUIET, every: RULE_EVERY_S + "s", to: POST, check: { at, run: 'node -e "process.exit(0)"', for: "30s" } },
      { name: FOUND, every: RULE_EVERY_S + "s", to: POST, title: "Находка сторожа", text: human, check: { at, run: `node -e "console.log('${FOUND_OUT}'); process.exit(1)"`, for: "30s" } },
      { name: DOOR, hook: true, to: POST, title: "Событие снаружи", text: step(DOOR_NOTE) },
      { name: MODEL, to: POST, title: "Ответила не та модель", text: human },
    ],
  };
}
