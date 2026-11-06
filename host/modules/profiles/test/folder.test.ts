import { describe, expect, it } from "vitest";
import { splitId } from "../src/folder.ts";

describe("имя кусочка", () => {
  it("репозиторий и папка; выход из папки и короткое имя — не кусочек", () => {
    expect(splitId("team/profiles/ops")).toEqual({ repo: "team/profiles", folder: "ops" });
    expect(splitId("team/profiles")).toBeNull();
    expect(splitId("team/profiles/../x")).toBeNull();
    expect(splitId("team//x")).toBeNull();
  });
});
