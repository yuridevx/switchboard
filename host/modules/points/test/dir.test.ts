import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { expandDir } from "../src/dir.ts";

describe("папка подъёма", () => {
  it("~ и ~/… — от домашней папки, не от рабочей папки Host", () => {
    const home = resolve("/home/u");
    expect(expandDir("~", home)).toBe(home);
    expect(expandDir("~/sb-copy", home)).toBe(join(home, "sb-copy"));
    expect(expandDir("~/a/b", home)).toBe(join(home, "a", "b"));
  });
  it("полный путь — как есть", () => {
    expect(expandDir(resolve("/srv/x"))).toBe(resolve("/srv/x"));
  });
});
