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
  const res = (r as { result?: { to?: string; restart?: boolean } }).result ?? {};
  // те же ядро и SDK — модули перезагружены в живом Host, соединение то же; иначе keeper подменяет Host — новый hello
  if (res.restart !== false)
    await wait("новый hello машины", () => {
      const m = l.roster?.machines.find((x) => x.machine === machine);
      return !!m && m.since !== before;
    }, 240000);
  const st = (await l.request({ type: "machine.state", v: 1, machine })) as { ok: boolean; result?: { host?: string } };
  console.log("machine.state:", JSON.stringify(st).slice(0, 400));
  if (st.result?.host !== res.to) throw new Error(`на машине Host ${st.result?.host}, ждали ${res.to}`);
  console.log(`upgrade: ok · ${res.restart === false ? "модули перезагружены в живом Host" : "Host подменён keeper"}`);
} catch (e) {
  console.log("upgrade: FAIL ·", (e as Error).message);
  process.exitCode = 1;
} finally {
  l.close(1000, "done");
}
