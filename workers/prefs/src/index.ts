// Снесено: вход отвечает отказом словом, пока не написан новый.
import { entrance, type GateApi } from "@switchboard/gate";
import { fail } from "@switchboard/protocol";

export default {
  fetch(req: Request, env: { GATE: GateApi }): Promise<Response> {
    return entrance(req, env.GATE, (f) => (f.id ? [{ ...fail(f.id, "снесено"), to: f.from }] : []));
  },
};
