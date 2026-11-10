// Вход страницы: провод (мок или настоящий флот), вход по приглашению, картина флота, маршруты.
import { browserLacks } from "./lib/browser.ts";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/charts/styles.css";
import "./styles.css";
import "./screens/screens.css";
import { obsReport } from "@sb/protocol";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Navigate, RouterProvider } from "react-router";
import { api, isMock } from "./api.ts";
import { Boundary } from "./common.tsx";
import { onOpenFromPush } from "./lib/push.ts";
import { Inbox } from "./screens/Inbox.tsx";
import { Work } from "./screens/Work.tsx";
import { Consent } from "./shell/Consent.tsx";
import { Gate } from "./shell/Gate.tsx";
import { openFromQuery } from "./shell/open.ts";
import { Find, Keys, More } from "./shell/Find.tsx";
import { NewSession } from "./shell/NewSession.tsx";
import { Shell } from "./shell/Shell.tsx";
import { theme } from "./theme.ts";

// Редкие разделы — отдельными кусками сборки: графики и таблицы не грузятся, пока их не открыли.
const Archive = lazy(() => import("./screens/Archive.tsx").then((m) => ({ default: m.Archive })));
const Fleet = lazy(() => import("./screens/Fleet.tsx").then((m) => ({ default: m.Fleet })));
const Machine = lazy(() => import("./screens/Machine.tsx").then((m) => ({ default: m.Machine })));
const Observe = lazy(() => import("./screens/Observe.tsx").then((m) => ({ default: m.Observe })));
const Settings = lazy(() => import("./screens/Settings.tsx").then((m) => ({ default: m.Settings })));
const Spend = lazy(() => import("./screens/Spend.tsx").then((m) => ({ default: m.Spend })));
const late = (el: React.ReactNode) => <Suspense fallback={null}>{el}</Suspense>;

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } } });

const opened = openFromQuery(location.search, location.hash);
if (opened) history.replaceState(null, "", location.pathname + opened.search + opened.hash);

const router = createHashRouter([
  {
    path: "/", element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/inbox" replace /> },
      { path: "inbox/:callsign?", element: <Inbox /> },
      { path: "work/:callsign?", element: <Work /> },
      { path: "archive/:sid?", element: late(<Archive />) },
      { path: "spend", element: late(<Spend />) },
      { path: "fleet/:tab?", element: late(<Fleet />) },
      { path: "machine/:name", element: late(<Machine />) },
      { path: "observe/:tab?", element: late(<Observe />) },
      { path: "settings/:tab?", element: late(<Settings />) },
      { path: "new", element: <NewSession /> },
      { path: "find", element: <Find /> },
      { path: "more", element: <More /> },
      { path: "keys", element: <Keys /> },
      { path: "*", element: <Navigate to="/inbox" replace /> },
    ],
  },
]);

// клик по уведомлению при открытой странице: сервис-воркер просит перейти к сессии
onOpenFromPush((hashPath) => void router.navigate(hashPath));

// ошибки страницы вне экранов — в наблюдение; не чаще пяти в минуту, чтобы сбой не завалил флот отчётами
let sent = 0;
setInterval(() => (sent = 0), 60_000);
const report = (msg: string, stack?: string) => {
  if (sent++ >= 5 || !api) return;
  // где это случилось: экран, приложение с экрана «Домой» или вкладка, браузер — без этого ошибку с телефона не разобрать
  const where = `${location.hash.split("?")[0] || "#/"} · ${window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone ? "с экрана Домой" : "вкладка"} · ${navigator.userAgent.replace("Mozilla/5.0 ", "").slice(0, 110)}`;
  api.call(obsReport, { part: "web", level: "error", msg: `${msg.slice(0, 380)} · ${where}`, ...(stack ? { stack: stack.slice(0, 4000) } : {}) }).catch(() => {});
};
// у ошибки без текста сообщение события — голое «Uncaught»: тогда берём имя и текст самой ошибки
const errorText = (message: string, error?: { name?: string; message?: string }) => (error?.message ? `${error.name ?? "Error"}: ${error.message}` : message.replace(/^Uncaught\s*/, "") || "ошибка без текста");
// у ошибки без подробностей («Script error.») называем, откуда она: файл и строка отличают свой код от вставки браузера
window.addEventListener("error", (e) => report(errorText(e.message, e.error) + (e.error ? "" : ` · ${e.filename || "источник не назван"}:${e.lineno ?? 0}`), e.error?.stack));
window.addEventListener("unhandledrejection", (e) => report(String(e.reason?.message ?? e.reason), e.reason?.stack));

// тестовая выкладка: комментарии к элементам страницы (Ctrl+C), пачкой — в журнал флота
if (import.meta.env.VITE_COMMENTS && !isMock) void import("./lib/comments.ts").then((m) => m.startComments((def, input) => api.call(def, input)));

/** Экран согласия внешнего клиента живёт по пути /consent, а не в маршрутах после #. */
const isConsent = location.pathname.replace(/\/+$/, "") === "/consent";

const lacks = browserLacks();

// Ошибка отрисовки вне границ экранов: React отдаёт её сюда с местом в дереве; без этого браузер показывает безымянную «Script error.»
const said = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
createRoot(document.getElementById("root")!, {
  onUncaughtError: (e, info) => report("отрисовка: " + said(e), `${e instanceof Error ? e.stack : ""}
${info.componentStack ?? ""}`),
  onCaughtError: (e, info) => report("экран: " + said(e), `${e instanceof Error ? e.stack : ""}
${info.componentStack ?? ""}`),
}).render(
  lacks.length ? (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <div className="hole" role="alert" style={{ height: "100dvh", flexDirection: "column", gap: 8, padding: 24, textAlign: "center" }}>
        <b>Браузер устарел</b>
        <span>Странице не хватает: {lacks.join(", ")}. Обновите браузер или откройте страницу в другом.</span>
      </div>
    </MantineProvider>
  ) : (
  <MantineProvider theme={theme} defaultColorScheme="auto">
    <QueryClientProvider client={qc}>
        <Notifications position="bottom-right" />
        <Boundary name="Страница"><Gate>{isConsent ? <Consent /> : <RouterProvider router={router} />}</Gate></Boundary>
    </QueryClientProvider>
  </MantineProvider>
  ),
);
