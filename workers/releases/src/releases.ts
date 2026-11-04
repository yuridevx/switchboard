// Снесено: «Выпуски» пишутся заново. Запрос получает отказ словом.
import { fail, type Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";

export async function frame(_env: Env, f: Frame): Promise<Frame[]> {
  return f.id ? [{ ...fail(f.id, "снесено"), to: f.from ?? "" }] : [];
}
