/// <reference types="node" />
// Сервис-воркер в поддельной среде для тестов: что показал, куда ответил, что записал в хранилище устройства.
import fs from "node:fs";
import path from "node:path";

export function worker(kv: Record<string, string>, windows: Array<{ url: string }> = []) {
  const shown: Array<{ title: string; o: any }> = [], calls: Array<{ url: string; init: any }> = [], on: Record<string, (e: any) => void> = {};
  const store = {
    get: (k: string) => { const g: any = {}; queueMicrotask(() => { g.result = kv[k]; g.onsuccess?.(); }); return g; },
    put: (v: string, k: string) => void (kv[k] = v),
    delete: (k: string) => void delete kv[k],
  };
  const idb = {
    open: () => {
      const r: any = {};
      queueMicrotask(() => {
        r.result = { close() {}, createObjectStore() {}, transaction: () => { const tx: any = { objectStore: () => store }; queueMicrotask(() => tx.oncomplete?.()); return tx; } };
        r.onsuccess?.();
      });
      return r;
    },
  };
  const self = {
    addEventListener: (t: string, fn: (e: any) => void) => (on[t] = fn), skipWaiting() {}, location: { origin: "https://fleet.example" },
    clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (u: string) => void calls.push({ url: "open:" + u, init: null }) },
    registration: { showNotification: async (title: string, o: any) => void shown.push({ title, o }) },
  };
  let reply: any = { ok: true };
  const fetch = async (url: string, init: any) => (calls.push({ url, init }), { json: async () => reply });
  new Function("self", "indexedDB", "fetch", fs.readFileSync(path.resolve(process.cwd(), "public/sw.js"), "utf8"))(self, idb, fetch);
  const fire = async (t: string, e: any) => { let p: Promise<unknown> | undefined; on[t]!({ ...e, waitUntil: (x: Promise<unknown>) => (p = x) }); await p; };
  return { shown, calls, fire, kv, setReply: (r: any) => (reply = r) };
}
