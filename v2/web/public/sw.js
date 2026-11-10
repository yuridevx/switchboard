// Сервис-воркер Switchboard: показывает пуши флота и отвечает на вопрос сессии прямо из уведомления.
// Статику не кэширует: страница всегда свежая. Пропуск и адрес флота берёт из IndexedDB (их кладёт туда страница).
const DB = "sb2", STORE = "kv";

function kv(key) {
  return new Promise((res) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onerror = () => res(null);
    r.onsuccess = () => {
      const g = r.result.transaction(STORE).objectStore(STORE).get(key);
      g.onsuccess = () => (r.result.close(), res(g.result ?? null));
      g.onerror = () => (r.result.close(), res(null));
    };
  });
}

function kvPut(key, value) {
  return new Promise((res) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onerror = () => res();
    r.onsuccess = () => {
      const tx = r.result.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => (r.result.close(), res());
      tx.onerror = () => (r.result.close(), res());
    };
  });
}

const KEEP = 50;
/** Пуш пришёл, а страница не открыта: он сохраняется, и страница покажет его при открытии. */
async function keep(n) {
  const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (open.some((c) => new URL(c.url).origin === self.location.origin)) return;
  let was = [];
  try {
    was = JSON.parse((await kv("pushes")) || "[]");
  } catch {}
  was.push({ title: n.title, text: n.text, callsign: n.callsign, kind: n.kind, ask: n.ask, at: Date.now(), hash: route(n).slice(2) });
  await kvPut("pushes", JSON.stringify(was.slice(-KEEP)));
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/** Пуш флота: { title, text, callsign?, kind?, ask?, options? }. У вопроса — до двух вариантов кнопками. */
self.addEventListener("push", (e) => {
  let n = { title: "Switchboard", text: "" };
  try {
    n = { ...n, ...e.data.json() };
  } catch {
    if (e.data) n.text = e.data.text();
  }
  const actions = n.ask && Array.isArray(n.options) ? n.options.slice(0, 2).map((title, i) => ({ action: "answer:" + i, title: String(title).slice(0, 40) })) : [];
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(n.title, {
        body: n.text, tag: n.callsign ? n.callsign + ":" + (n.kind ?? "") : n.kind ?? "fleet", renotify: true, data: n, actions,
        icon: "/icon-192.png", badge: "/icon-192.png", requireInteraction: n.kind === "ask",
      }),
      keep(n),
    ]),
  );
});

function route(n) {
  // у вопроса адрес несёт его номер: приложение откроется сразу с вопросом и кнопками ответа поверх экрана
  return n.callsign ? "/#/inbox/" + n.callsign + (n.ask ? "?ask=" + encodeURIComponent(n.ask) : "") : n.kind === "alert" ? "/#/observe" : n.kind === "incident" ? "/#/fleet/incidents" : "/#/inbox";
}

async function show(n) {
  const url = route(n);
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const open = all.find((c) => new URL(c.url).origin === self.location.origin);
  if (open) {
    await open.focus();
    // страница сама переходит к сессии: адрес после # меняется без перезагрузки
    open.postMessage({ type: "open", hash: url.slice(2) });
    return;
  }
  await self.clients.openWindow(url);
}

async function answer(n, label) {
  const [key, base] = await Promise.all([kv("key"), kv("base")]);
  if (!key || !base) throw new Error("нет пропуска на этом устройстве");
  const id = "sw" + Date.now().toString(36);
  const res = await fetch(base + "/call", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ type: "answer", id, trace: "t" + id, to: n.callsign, ask: n.ask, answer: label, via: "push" }),
  });
  const r = await res.json();
  if (!r.ok) throw new Error(r.error === "already_answered" ? "на вопрос уже ответили" : r.why || r.error || "отказ");
}

self.addEventListener("notificationclick", (e) => {
  const n = e.notification.data ?? {};
  e.notification.close();
  const m = /^answer:(\d+)$/.exec(e.action ?? "");
  if (!m || !n.ask || !n.callsign) return void e.waitUntil(show(n));
  const label = n.options?.[Number(m[1])];
  e.waitUntil(
    answer(n, label).then(
      () => self.registration.showNotification(n.callsign + ": отвечено «" + label + "»", { tag: n.callsign + ":answered", icon: "/icon-192.png", data: { callsign: n.callsign } }),
      (err) => self.registration.showNotification("Ответ не ушёл: " + err.message, { body: "Откройте сессию и ответьте там.", tag: n.callsign + ":ask", icon: "/icon-192.png", data: n }),
    ),
  );
});
