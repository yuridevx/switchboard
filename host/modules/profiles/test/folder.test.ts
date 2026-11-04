// Папка профиля: разбор profile.yaml и имени профиля.
import { describe, expect, it } from "vitest";
import { parseYaml, splitId } from "../src/folder.ts";

describe("папка профиля", () => {
  it("profile.yaml: строки, кавычки, списки, комментарии", () => {
    expect(parseYaml("model: opus\nfallback_model: [sonnet, haiku]\n# x\neffort: 'high'\r\nabout: \"Текст\" # хвост")).toEqual({ model: "opus", fallback_model: ["sonnet", "haiku"], effort: "high", about: "Текст" });
  });

  it("имя профиля: репозиторий и папка; выход из папки и короткое имя — не профиль", () => {
    expect(splitId("team/profiles/ops")).toEqual({ repo: "team/profiles", folder: "ops" });
    expect(splitId("team/profiles/a/b")).toEqual({ repo: "team/profiles", folder: "a/b" });
    for (const bad of ["team/profiles", "team/profiles/..", "team//ops", "nosuch"]) expect(splitId(bad)).toBeNull();
  });
});
