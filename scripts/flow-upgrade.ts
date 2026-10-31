// Живое обновление Host: клиент шлёт machine.upgrade, ждёт, пока машина вернётся в roster с новым hello.
// env: FLOW_CLIENT_KEY, FLOW_MACHINE, FLOW_VERSION (по умолчанию latest).
import { link } from "@switchboard/relay";

const l = link({ url: process.env.SWITCHBOARD_URL ?? "wss://switchboard.yuridevx1608.workers.dev", key: process.env.FLOW_CLIENT_KEY! });
const machine = process.env.FLOW_MACHINE!;
const wait = async (what: string, ok: () => boolean, ms: number) => {
  for (const t0 = Date.now(); !ok(); ) {
    if (Date.now() - t0 > ms) throw new Error("не дождался: " + what);
    await new Promise((r) => setTimeout(r, 200));
  }
};
try {
  await wait("связь", () => l.state === "open", 15000);
  const before = l.roster?.machines.find((m) => m.machine === machine)?.since;
  const r = await l.request({ type: "machine.upgrade", v: 1, machine, version: process.env.FLOW_VERSION ?? "latest" });
  console.log("machine.upgrade:", JSON.stringify(r).slice(0, 300));
  if (!r.ok) process.exit(1);
  await wait("новый hello машины", () => {
    const m = l.roster?.machines.find((x) => x.machine === machine);
    return !!m && m.since !== before;
  }, 240000);
  const st = await l.request({ type: "machine.state", v: 1, machine });
  console.log("machine.state:", JSON.stringify(st).slice(0, 400));
  console.log("upgrade: ok");
} catch (e) {
  console.log("upgrade: FAIL ·", (e as Error).message);
  process.exitCode = 1;
} finally {
  l.close(1000, "done");
}
