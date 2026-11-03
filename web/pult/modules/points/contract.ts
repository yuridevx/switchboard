// Контракт pult-points — точки сессий, перенос, копия, откат, смена папки и «пожар» (свой пакет пульта).
// Экраны: points (#points, раздел «Точки») — обзор реестра (points.list): сессии в R2, «только в R2»
// (удаление — points.delete после ввода имени, сразу и без отмены), «пожар» — машина хозяина не в roster
// (когда ушла — ledger.read), перенос её сессий по одной из последних точек; session.points — вкладка «Точки»
// в карточке сессии: пометка «в R2» (session.r2 у host-points), линия точек и ветки (points.list с sid,
// первые слова — points.get), «Сохранить точку», перенос, копия, смена папки и откат — шагами, каждый запрос
// после ответа предыдущего: points.save со стопом → points.raise → (смена папки) session.remove прежней.
// session.points встаёт в место card.tab карточки (card.tab@web-card в uses). Метка fire — сессии без машины.
import type { AppModule, Manifest } from "@switchboard/web-core";
import json from "./module.json" with { type: "json" };
import { createPoints } from "./src/module.tsx";

declare module "@switchboard/web-core" {
  interface Marks {
    fire(): number;
  }
}

export { createPoints };
export const manifest: Manifest = json;
export default createPoints() satisfies AppModule;
