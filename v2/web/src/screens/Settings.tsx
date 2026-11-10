// «Настройки»: люди и проекты, пропуска, уведомления, правила прокси, сбои и цены, GitHub, имена, это устройство. Вкладки — в папке settings/.
import { Alerts } from "./settings/Alerts.tsx";
import { Fleetwide } from "./settings/Fleetwide.tsx";
import { Passes } from "./settings/Passes.tsx";
import { People } from "./settings/People.tsx";
import { ProxyRules } from "./settings/Proxy.tsx";
import { Device, GitHub, Names } from "./settings/Rest.tsx";
import { TabsPage } from "./Fleet.tsx";

export function Settings() {
  return (
    <TabsPage title="Настройки" base="/settings" tabs={[
      ["people", "Люди и проекты", () => <People />], ["passes", "Пропуска", () => <Passes />], ["alerts", "Уведомления", () => <Alerts />],
      ["proxy", "Правила прокси", () => <ProxyRules />], ["fleet", "Сбои и цены", () => <Fleetwide />], ["github", "GitHub", () => <GitHub />],
      ["names", "Имена", () => <Names />], ["device", "Это устройство", () => <Device />],
    ]} />
  );
}
