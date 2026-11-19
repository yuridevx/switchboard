// Определение фабрики проекта коробки: конвейер из трёх шагов с потолком два, пост-сторож и два правила входа по времени — с тихой проверкой
// и с проверкой, которая всегда находит. Его несёт репозиторий кусочков коробки (factory.json), применяет и гоняет живая проверка «конвейер»
// (tools/fleet/live-lines.ts). Шаг сессии — сценарий хода: вердикт с номером тикета.
import { say, tool, turn } from "../fleet/turn.mjs";

/** Проект коробки, у которого применяется определение, имя его конвейера и поста. */
export const PROJECT = "box", LINE = "three", POST = "watch";
/** Правила входа: QUIET — проверка возвращает 0; FOUND — проверка возвращает 1 и печатает FOUND_OUT. Срок обоих — RULE_EVERY_S секунд. */
export const QUIET = "quiet", FOUND = "found", FOUND_OUT = "lost=4", RULE_EVERY_S = 10;

const step = (note) => turn(tool("mcp__fleet__ticket_set", { ticket: "{id}", verdict: "done", note }), say("шаг сдан"));

/** Файл определения: папки сессий — в папке коробки, уходят вместе с ней. */
export function definition({ state, key, model, machines }) {
  const dir = state.replaceAll("\\", "/");
  const at = "@" + machines[0];
  return {
    project: PROJECT, limit: 2,
    posts: { [POST]: { title: "Сторож", at, cwd: dir + "/post", key, model, for: "5m" } },
    lines: {
      [LINE]: {
        title: "Три шага", limit: 2, for: "10m", at: machines.map((m) => "@" + m), cwd: dir + "/line/{id}", key, model,
        steps: [
          { name: "сделать", session: "new", do: step("сделано") },
          { name: "довести", session: "same", do: step("доведено") },
          { name: "принять", session: "new", do: step("принято") },
        ],
      },
    },
    on: [
      { name: QUIET, every: RULE_EVERY_S + "s", to: POST, check: { at, run: 'node -e "process.exit(0)"', for: "30s" } },
      // сторож зовёт человека: тикет встаёт и остаётся открытым — следующие находки ложатся в него заметками
      {
        name: FOUND, every: RULE_EVERY_S + "s", to: POST, title: "Находка сторожа", check: { at, run: `node -e "console.log('${FOUND_OUT}'); process.exit(1)"`, for: "30s" },
        text: turn(tool("mcp__fleet__ticket_set", { ticket: "{id}", verdict: "stop", note: "нужен человек" }), say("передано человеку")),
      },
    ],
  };
}
