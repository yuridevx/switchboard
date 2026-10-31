// Папка подъёма с пульта: «~» и «~/…» — от домашней папки машины, иначе — полный путь как есть.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function expandDir(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, ...p.slice(2).split("/"));
  return resolve(p);
}
