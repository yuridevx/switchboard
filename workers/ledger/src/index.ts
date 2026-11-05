// Заглушка сноса: вход отвечает отказом словом.
import { WorkerEntrypoint } from "cloudflare:workers";
import { fail, type Frame } from "@switchboard/protocol";
import type { Env } from "./env.ts";

export class Participant extends WorkerEntrypoint<Env> {
  frame(f: Frame): Frame[] {
    return f.id ? [{ ...fail(f.id, "снесено"), to: f.from }] : [];
  }
}

export default {
  fetch: () => new Response("снесено", { status: 501 }),
} satisfies ExportedHandler<Env>;
