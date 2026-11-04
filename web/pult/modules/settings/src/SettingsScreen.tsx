// Экран настроек: заголовок с вкладками и содержимое вкладки. Новые параметры адреса — экран начат заново.
import { useEffect } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { Btn, Page, PageHead, useApp } from "@switchboard/web-ui";
import { useSettings } from "./store.ts";
import { Device, Github } from "./General.tsx";
import { Passes } from "./Passes.tsx";
import { Releases } from "./ReleasesTab.tsx";

type Tab = "releases" | "passes" | "general";

function TabButton({ tab, k, label }: { tab: Tab; k: Tab; label: string }) {
  const app = useApp();
  return (
    <Btn role="tab" aria-selected={tab === k ? "true" : "false"} aria-pressed={tab === k ? "true" : "false"} data-tab={k} onClick={() => app.open("settings", { tab: k })}>
      {label}
    </Btn>
  );
}

function Tabs({ tab }: { tab: Tab }) {
  return (
    <div className="st-tabs" role="tablist">
      <TabButton tab={tab} k="releases" label="Выпуски" />
      <TabButton tab={tab} k="passes" label="Пропуска" />
      <TabButton tab={tab} k="general" label="GitHub и устройство" />
    </div>
  );
}

export function SettingsScreen({ params }: ScreenProps) {
  const app = useApp();
  const settings = useSettings();
  const tab: Tab = !app.wide ? "general" : params.tab === "passes" || params.tab === "general" ? params.tab : "releases";

  // при открытии — ответы владельцев своей вкладки
  useEffect(() => settings.openTab(tab), [settings, tab]);

  return (
    <Page>
      {app.wide ? <PageHead title="Настройки"><Tabs tab={tab} /></PageHead> : null}
      {tab === "releases" ? (
        <Releases machine={params.machine} />
      ) : tab === "passes" ? (
        <Passes />
      ) : (
        <>
          {app.wide ? <Github /> : null}
          <Device />
        </>
      )}
    </Page>
  );
}
