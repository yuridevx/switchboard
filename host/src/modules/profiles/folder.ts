// Имя кусочка: репозиторий и папка.

export type ProfileId = { repo: string; folder: string };

/** team/profiles/ops → репозиторий и папка; выход из папки и короткое имя — не кусочек. */
export function splitId(id: string): ProfileId | null {
  const parts = id.split("/");
  if (parts.length < 3 || parts.some((p) => !p || p === "." || p === "..")) return null;
  return { repo: parts.slice(0, 2).join("/"), folder: parts.slice(2).join("/") };
}
