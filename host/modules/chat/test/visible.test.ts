// Что видно в журнале сверх лесов границы (чьё: код до сноса).
import { afterEach, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import { parts } from "./parts.ts";

const { module, standHost } = stand;
const stands: stand.Stand[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
});

it("режим без вопросов: разрешение уходит сразу, причина — в журнале", async () => {
  const st = await standHost({ modules: [module("host-manage", { fields: { mode: () => "bypassPermissions", parent: () => undefined } }, { provides: { "session.open": 1, "session.update": 1, "session.remove": 1 } }), ...(await parts())] });
  stands.push(st);
  const s = await st.open("site@laptop");
  s.input("задача", { from: "phone~owner@example.com" });
  const p = st.proc("site@laptop");
  expect(await p.ask("Bash", { command: "npm test" })).toMatchObject({ behavior: "allow" });
  expect(st.journal().find((l) => l.ev === "allow")).toMatchObject({ callsign: "site@laptop", tool: "Bash", why: "режим bypassPermissions" });
});
