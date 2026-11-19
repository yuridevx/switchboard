// Определение фабрики проекта коробки: один конвейер из трёх шагов с потолком два. Его несёт репозиторий кусочков коробки (factory.json),
// применяет и гоняет живая проверка «конвейер» (tools/fleet/live-lines.ts). Шаг сессии — сценарий хода: вердикт «сдал» с номером тикета.
import { say, tool, turn } from "../fleet/turn.mjs";

/** Проект коробки, у которого применяется определение, и имя его конвейера. */
export const PROJECT = "box", LINE = "three";

const step = (note) => turn(tool("mcp__fleet__ticket_set", { ticket: "{id}", verdict: "done", note }), say("шаг сдан"));

/** Файл определения: папка сессий — в папке коробки, уходит вместе с ней. */
export function definition({ state, key, model, machines }) {
  return {
    project: PROJECT, limit: 2,
    lines: {
      [LINE]: {
        title: "Три шага", limit: 2, for: "10m", at: machines.map((m) => "@" + m), cwd: state.replaceAll("\\", "/") + "/line/{id}", key, model,
        steps: [
          { name: "сделать", session: "new", do: step("сделано") },
          { name: "довести", session: "same", do: step("доведено") },
          { name: "принять", session: "new", do: step("принято") },
        ],
      },
    },
  };
}
