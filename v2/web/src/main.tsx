// Вход страницы: провод (мок или настоящий флот), картина флота, маршруты.
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/spotlight/styles.css";
import "@mantine/charts/styles.css";
import "./styles.css";
import { whoami } from "@sb/protocol";
import { Button, MantineProvider, Stack, Text } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Navigate, RouterProvider } from "react-router";
import { acceptInvite, api, connect, inviteInHash, isMock, keyStore, sayError } from "./api.ts";
import { Inbox } from "./screens/Inbox.tsx";
import { Work } from "./screens/Work.tsx";
import { Shell } from "./shell/Shell.tsx";
import { useFleet } from "./store/fleet.ts";
import { theme } from "./theme.ts";

// Редкие разделы — отдельными кусками сборки: графики и таблицы не грузятся, пока их не открыли.
const Archive = lazy(() => import("./screens/Archive.tsx").then((m) => ({ default: m.Archive })));
const Fleet = lazy(() => import("./screens/Fleet.tsx").then((m) => ({ default: m.Fleet })));
const Observe = lazy(() => import("./screens/Observe.tsx").then((m) => ({ default: m.Observe })));
const Settings = lazy(() => import("./screens/Settings.tsx").then((m) => ({ default: m.Settings })));
const Spend = lazy(() => import("./screens/Spend.tsx").then((m) => ({ default: m.Spend })));
const late = (el: React.ReactNode) => <Suspense fallback={null}>{el}</Suspense>;

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } } });

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
      { path: "observe/:tab?", element: late(<Observe />) },
      { path: "settings/:tab?", element: late(<Settings />) },
      { path: "*", element: <Navigate to="/inbox" replace /> },
    ],
  },
]);

type Gate = "starting" | "ready" | "need_invite" | "stopped";

/** Вход: приглашение из ссылки, затем соединение с картиной флота. */
function Entry() {
  const [gate, setGate] = useState<Gate>("starting");
  const [why, setWhy] = useState("");
  const link = useFleet((f) => f.link);
  useEffect(() => {
    let closeLink = () => {};
    (async () => {
      connect();
      const invite = inviteInHash();
      if (invite && !isMock) {
        try {
          await acceptInvite(invite);
        } catch (e) {
          setWhy(sayError(e));
          return setGate("need_invite");
        }
      }
      if (!isMock && !keyStore.get()) return setGate("need_invite");
      const l = api.transport.open("page", { onFrame: (f) => useFleet.getState().apply(f), onState: (s) => useFleet.getState().setLink(s) });
      closeLink = () => l.close();
      if (!isMock) api.call(whoami, {}).catch((e) => (setWhy(sayError(e)), setGate("stopped")));
      setGate("ready");
    })();
    return () => closeLink();
  }, []);
  if (gate === "ready" && link === "stopped") return <Stop title="Пропуск больше не действует" text="Его отозвали или он не подошёл. Попросите новую ссылку-приглашение." reset />;
  if (gate === "stopped") return <Stop title="Пропуск не принят" text={why} reset />;
  if (gate === "need_invite") return <Stop title="Нужна ссылка-приглашение" text={why || "Откройте ссылку, которую вам выдали в разделе «Пропуска», на этом устройстве."} />;
  if (gate === "starting") return null;
  return <RouterProvider router={router} />;
}

function Stop({ title, text, reset }: { title: string; text: string; reset?: boolean }) {
  return (
    <div className="hole" style={{ height: "100%" }}>
      <Stack align="center" gap="xs" maw={420}>
        <Text fw={700} size="lg">{title}</Text>
        <Text ta="center">{text}</Text>
        {reset && <Button variant="default" onClick={() => (keyStore.clear(), location.reload())}>Забыть пропуск на этом устройстве</Button>}
      </Stack>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="auto">
    <QueryClientProvider client={qc}>
      <ModalsProvider>
        <Notifications position="bottom-right" />
        <Entry />
      </ModalsProvider>
    </QueryClientProvider>
  </MantineProvider>,
);
