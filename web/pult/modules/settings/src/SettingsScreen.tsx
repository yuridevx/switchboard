// Экран настроек: заголовок с вкладками и содержимое вкладки. Новые параметры адреса — экран начат заново.
import type { ScreenProps } from "@switchboard/web-core";
import { Btn, Page, PageHead, useApp, Tabs } from "@switchboard/web-ui";
import { Device, Github } from "./General.tsx";
import { Passes } from "./Passes.tsx";
import { Releases } from "./ReleasesTab.tsx";

type Tab = "releases" | "passes" | "general";

const TABS = [
  ["releases", "Выпуски"],
  ["passes", "Пропуска"],
  ["general", "GitHub и устройство"],
] as const;

export function SettingsScreen({ params }: ScreenProps) {
  const app = useApp();
  const tab: Tab = !app.wide ? "general" : params.tab === "passes" || params.tab === "general" ? params.tab : "releases";

  return (
    <Page>
      {app.wide ? <PageHead title="Настройки"><Tabs className="st-tabs" tabs={TABS} cur={tab} pick={(k) => app.open("settings", { tab: k })} /></PageHead> : null}
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
