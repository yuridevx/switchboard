// Папка профиля в клоне: имя профиля и profile.yaml.

/** profile.yaml: строки «ключ: значение» и списки [a, b]. */
export function parseYaml(text: string): Record<string, unknown> {
  const unquote = (x: string) => x.trim().replace(/^["']|["']$/g, "");
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const value = m[2];
    out[m[1]] = value.startsWith("[") ? value.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean) : unquote(value);
  }
  return out;
}

/** «team/profiles/ops» → репозиторий и папка. */
export function splitId(id: string): { repo: string; folder: string } | null {
  const parts = id.split("/");
  if (parts.length < 3 || parts.some((p) => !p || p === "." || p === "..")) return null;
  return { repo: parts.slice(0, 2).join("/"), folder: parts.slice(2).join("/") };
}
