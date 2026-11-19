// Живая проверка «выкладка сборки»: node tools/fleet/live-roll.mjs [флот] [устройство] [машина] [вторая машина]
// Тем же шагом, которым выкладывает CI (tools/deploy/machines.mjs): новая сборка уходит в каталог флота, служба каждой машины
// скачивает её, сверяет, ставит и подменяет Host — сессии на месте; служба машины из новой сборки подменяет и саму себя.
// Идёт только на флоте в коробке и одна: подменяет Host на всех машинах флота. На живой флот сборку доводит CI, проверка её туда не несёт.
import { rollLine, rollMachines } from "../deploy/machines.mjs";
import { check, local } from "./harness.mjs";
import { say, turn } from "./turn.mjs";

await check(async (t) => {
  if (!local()) throw new Error("выкладка сборки проверяется только на флоте в коробке: на живой флот сборку доводит CI");
  const machines = [t.machine, t.second].filter(Boolean);
  const made = [];
  let was = 0;
  await t.step("сессии открыты на каждой машине и ответили", async () => {
    was = (await t.must("builds.list", {})).stable;
    for (const m of machines) {
      // сессия открыта с первой задачей: обвязка ждёт итог её первого хода
      const s = await t.session({ name: "roll", machine: m, prompt: turn(say("до")) });
      if (!s.first.text.includes("до")) throw new Error(`${s.callsign} ответила не «до»: ${s.first.text.slice(0, 60)}`);
      made.push(s);
    }
    return `${made.map((s) => s.callsign).join(", ")}; на флоте сборка ${was}`;
  });

  let build = 0;
  await t.step("новая сборка дошла до машин шагом выкладки: Host подменён, сессии на месте", async () => {
    const r = await rollMachines(t.fleet, t.device);
    build = r.build;
    if (r.build <= was) throw new Error(`номер сборки не вырос: ${was} → ${r.build}`);
    if (r.lost.length || r.failed.length) throw new Error(`пропало: ${r.lost.join(", ") || "—"}; упало: ${r.failed.join(", ") || "—"}`);
    // своя сессия — в картине флота: строка вернулась после подмены Host (упавшая сессия — отказ сразу)
    for (const s of made) await t.wait(`${s.callsign} в картине после подмены Host`, () => s.row());
    return rollLine(r);
  });

  await t.step("служба каждой машины — из новой сборки: подменила себя и держит новый Host", async () => {
    const seen = [];
    for (const m of machines) {
      let last = "ответа службы нет";
      const k = await t.wait(`${m}: служба машины сборки ${build} держит Host сборки ${build}`, async () => {
        // после подмены себя служба поднимается снова: пока её нет на связи, запрос к ней отказывает — это «ещё нет», а не сбой
        const r = await t.call("keeper.state", { to: `.keeper@${m}` });
        const x = r.ok ? r.result : null;
        last = x ? `служба сборки ${x.build}, Host сборки ${x.host?.build} (${x.host?.state})` : `служба не отвечает: ${r.error}`;
        return x?.build === build && x.host.build === build && x.host.state === "running" && x;
      }, () => last);
      seen.push(`${m}: служба ${k.build}, Host ${k.host.build}`);
    }
    return seen.join("; ");
  });

  await t.step("сессии после подмены отвечают на новый ход", async () => {
    for (const s of made) {
      const reply = await s.turn(turn(say("после")));
      if (!reply.text.includes("после")) throw new Error(`${s.callsign} ответила не «после»: ${reply.text.slice(0, 60)}`);
    }
    return `ответили ${made.length} из ${made.length}`;
  });
});
