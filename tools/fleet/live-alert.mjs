// Живая проверка оповещения о сбое: node tools/fleet/live-alert.mjs <флот> <устройство с пропуском админа>
// Настоящий Chrome подписывается на уведомления выложенной страницы; затем в журнал флота пишется сбой Host выдуманной машины —
// служба наблюдения должна позвать админа, и пуш должен показаться сервис-воркером. Подписка и приглашение в конце убираются;
// запись о сбое остаётся: журнал флота только дописывается.
import { check } from "./harness.mjs";

await check(async (t) => {
  let page, device = "";

  await t.step("браузер подписан на уведомления флота", async () => {
    // подписка на уведомления живёт только в окне настоящего Chrome со своим профилем
    page = await t.page({ width: 1280, height: 800, profile: true, permissions: ["notifications"] });
    // подписка браузера ключом флота — запросами договора, без кода страницы: проверяется служба, а не кнопка
    const sub = await page.evaluate(async () => {
      const key = localStorage.getItem("sb2.key");
      const ask = async (type, fields = {}) => {
        const r = await (await fetch("/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ type, id: "r" + Math.random().toString(36).slice(2), ...fields }) })).json();
        if (!r.ok) throw new Error(`${type}: ${r.error} ${r.why ?? ""}`);
        return r.result;
      };
      const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
      await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u((await ask("reach.key")).key) });
      return ask("reach.subscribe", { kind: "webpush", endpoint: s.endpoint, p256dh: b64u(s.getKey("p256dh")), auth: b64u(s.getKey("auth")), label: "живая проверка оповещения" });
    });
    device = sub.id;
    t.defer(`устройство уведомлений ${device}`, (go) => go("reach.remove", { device }));
    return device;
  });

  // сбой Host выдуманной машины: причина новая при каждом запуске — получасовое молчание об одной причине не мешает
  const text = "живая проверка оповещения " + t.tag;
  await t.step("сбой части записан в журнал флота", async () => {
    await t.must("ledger.add", { what: "host.failed", machine: "probe-" + t.tag, text });
  });

  await t.step("оповещение админу показано уведомлением", async () => {
    let shown = [];
    // уведомление показывает сервис-воркер, когда служба пушей браузера донесла его: перечитываем показанные
    const mine = await t.wait("уведомление с меткой проверки", async () => {
      shown = await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration("/")).getNotifications()).map((n) => n.title + " — " + n.body));
      return shown.find((n) => n.includes(t.tag));
    }, () => `уведомлений с меткой нет (всего ${shown.length})`);
    return mine;
  });
});
