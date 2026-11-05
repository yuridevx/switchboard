// Снесено: вход Worker'а points отвечает отказом словом «снесено» до реализации.
import { WorkerEntrypoint } from "cloudflare:workers";
import { fail, type Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";

export default class Points extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return Response.json(fail("", "снесено"));
  }
  async frame(f: Frame): Promise<Frame[]> {
    return f.id ? [{ ...fail(f.id, "снесено"), to: f.from }] : [];
  }
  async scheduled(): Promise<void> {}
}
