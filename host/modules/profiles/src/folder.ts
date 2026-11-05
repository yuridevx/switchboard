// Папка профиля: имя и profile.yaml. Разбор — только та форма, что нужна профилю: строки и списки в одну строку.

export type ProfileId = { repo: string; folder: string };

/** team/profiles/ops → репозиторий и папка; выход из папки и короткое имя — не профиль. */
export function splitId(id: string): ProfileId | null {
  const parts = id.split("/");
  if (parts.length < 3 || parts.some((p) => !p || p === "." || p === "..")) return null;
  return { repo: parts.slice(0, 2).join("/"), folder: parts.slice(2).join("/") };
}

const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, "$2");

export function parseYaml(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/\s+#.*$/, "").trim();
    out[m[1]] = value.startsWith("[") ? value.slice(1, -1).split(",").map(unquote) : unquote(value);
  }
  return out;
}
