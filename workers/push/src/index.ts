// Снесено: заглушка на время сноса.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";
export default class extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return new Response("снесено", { status: 500 });
  }
  async frame(_f: Frame): Promise<Frame[]> {
    throw new Error("снесено");
  }
}
