// «Флот»: аккаунты, машины, профили, выпуски, инциденты. Сами вкладки — в папке fleet/.
import { Select, Tabs } from "@mantine/core";
import { useNavigate, useParams } from "react-router";
import { useWide } from "../common.tsx";
import { Accounts } from "./fleet/Accounts.tsx";
import { Incidents } from "./fleet/Incidents.tsx";
import { Machines } from "./fleet/Machines.tsx";
import { Profiles } from "./fleet/Profiles.tsx";
import { Releases } from "./fleet/Releases.tsx";

export function TabsPage({ title, base, tabs }: { title: string; base: string; tabs: Array<[string, string, () => React.ReactNode]> }) {
  const { tab } = useParams();
  const go = useNavigate();
  const now = tabs.find(([id]) => id === tab) ?? tabs[0];
  const wide = useWide();
  return (
    <div className="scroll">
      <div className="page">
        <h1 style={{ fontSize: 20, margin: "0 0 10px" }}>{title}</h1>
        {wide ? (
          <Tabs value={now[0]} onChange={(v) => v && go(`${base}/${v}`)}>
            <Tabs.List mb="md">{tabs.map(([id, word]) => <Tabs.Tab key={id} value={id}>{word}</Tabs.Tab>)}</Tabs.List>
          </Tabs>
        ) : (
          // на телефоне вкладки не помещаются в ряд: раздел выбирается из списка
          <Select mb="md" aria-label="Раздел" allowDeselect={false} data={tabs.map(([value, label]) => ({ value, label }))} value={now[0]} onChange={(v) => v && go(`${base}/${v}`)} />
        )}
        {now[2]()}
      </div>
    </div>
  );
}

export function Fleet() {
  return <TabsPage title="Флот" base="/fleet" tabs={[["accounts", "Аккаунты", () => <Accounts />], ["machines", "Машины", () => <Machines />], ["profiles", "Профили", () => <Profiles />], ["releases", "Выпуски", () => <Releases />], ["incidents", "Инциденты", () => <Incidents />]]} />;
}
