// Вход прототипа: настоящие модули приложения из дерева, где запущен сервер; связь с продом через шов ядра (seam); мок дизайна; комментарии.
import { startApp } from "../../web/packages/core/contract.ts";
import { options, parts } from "@proto/app";
import mock from "@proto/mock";
import { startComments } from "./comments.ts";
import { protoSeam } from "./seam.ts";

declare const __PROTO__: { app: string; workers: Record<string, string> };

const CSS = `.proto-notice{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;max-width:min(720px,calc(100% - 32px));background:#A85A05;color:#fff;font:500 13px/1.4 "JetBrains Mono",monospace;padding:9px 14px;border-radius:10px;z-index:9998;opacity:0;pointer-events:none;transition:opacity .15s;overflow-wrap:anywhere}
.proto-notice.on{opacity:1}
`;

const style = document.createElement("style");
style.textContent = CSS;
document.head.appendChild(style);
const box = document.createElement("div");
box.className = "proto-notice";
box.setAttribute("role", "status");
document.body.append(box);
let hideTimer: ReturnType<typeof setTimeout> | undefined;
function notice(text: string) {
  box.textContent = text;
  box.classList.add("on");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => box.classList.remove("on"), 7000);
}
async function data<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`/api/data/${encodeURIComponent(name)}?p=${encodeURIComponent(JSON.stringify(params))}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `data ${name}: ${r.status}`);
  return j as T;
}

void (async () => {
  const state = mock.state?.();
  await mock.init?.({ data, notice, state });
  const run = startApp({
    root: document.getElementById("app")!,
    workers: { ...__PROTO__.workers, ...mock.workers },
    parts: parts(),
    seam: protoSeam({ mock, state, notice, data }),
    ...options,
  });
  startComments();
  Object.assign(window, { run });
})();
