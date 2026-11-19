// Сводка истории прогонов CI — чистая функция: по прогонам с их работами и строками журнала шагов считает
// красные работы по местам и плавающее: один и тот же код (дерево), одно место, один шаг — и зелёный, и красный исход.
// «Один код» — дерево, а не коммит: у прогона запроса на слияние и прогона main после слияния коммиты разные, дерево одно.

/** Место работы: части — тесты частей; коробка — флот на раннере; флот — живой список после выкладки. */
export function placeOf(workflow, job) {
  if (workflow === "deploy") return "флот";
  if (job === "проверка") return null; // сводная работа: своего исхода у неё нет
  if (/^коробка · windows/.test(job)) return "коробка windows";
  if (/^коробка/.test(job)) return "коробка linux";
  return "части";
}

const red = (c) => c === "failure" || c === "timed_out";
const done = (c) => c === "success" || red(c);

/** runs: [{ id, workflow, event, tree, conclusion, jobs: [{ name, conclusion }], steps: [строки журнала шагов] }] */
export function summarize(runs) {
  const places = {};
  const at = (name) => (places[name] ??= { jobs: 0, red: 0, steps: 0, redSteps: 0 });
  const seen = new Map(); // дерево · место · проверка · шаг → исходы
  const note = (key, ok, run, title) => {
    const s = seen.get(key) ?? seen.set(key, { title, ok: 0, bad: 0, runs: [] }).get(key);
    s[ok ? "ok" : "bad"]++;
    if (!s.runs.includes(run)) s.runs.push(run);
  };
  for (const r of runs) {
    for (const j of r.jobs) {
      const base = placeOf(r.workflow, j.name);
      if (!base || !done(j.conclusion)) continue;
      // у живого флота место называют строки шагов: «флот test», «флот prod»
      const place = base === "флот" ? (r.steps.find((s) => s.place?.startsWith("флот"))?.place ?? base) : base;
      const p = at(place);
      p.jobs++;
      if (red(j.conclusion)) p.red++;
      // работа частей — сама себе шаг: тест части шагов в журнал не пишет
      if (base === "части") note(`${r.tree} · части · ${j.name}`, !red(j.conclusion), r.id, `части · ${j.name}`);
    }
    for (const s of r.steps) {
      const p = at(s.place);
      p.steps++;
      if (!s.ok) p.redSteps++;
      note(`${r.tree} · ${s.place} · ${s.module} · ${s.msg}`, s.ok, r.id, `${s.place} · ${s.module} › ${s.msg}`);
    }
  }
  const flaky = [...seen.values()].filter((s) => s.ok && s.bad).sort((a, b) => b.bad - a.bad || a.title.localeCompare(b.title));
  // ворота слияния: красный прогон main на дереве, которое в запросе на слияние прошло зелёным
  const ci = runs.filter((r) => r.workflow === "ci" && done(r.conclusion));
  const greenPr = new Set(ci.filter((r) => r.event === "pull_request" && r.conclusion === "success").map((r) => r.tree));
  const main = ci.filter((r) => r.event === "push");
  const mainRed = main.filter((r) => red(r.conclusion));
  return { places, flaky, main: { runs: main.length, red: mainRed.length, redAfterGreen: mainRed.filter((r) => greenPr.has(r.tree)).length } };
}

/** Сводка словами: строка на место, строка ворот, плавающее — по строке. */
export function render(sum) {
  const order = ["части", "коробка linux", "коробка windows"];
  const names = [...order.filter((n) => sum.places[n]), ...Object.keys(sum.places).filter((n) => !order.includes(n)).sort()];
  const lines = names.map((n) => {
    const p = sum.places[n];
    return `${n} · работ ${p.jobs} · красных ${p.red}${p.steps ? ` · шагов ${p.steps} · красных шагов ${p.redSteps}` : ""}`;
  });
  lines.push(`main · прогонов ${sum.main.runs} · красных ${sum.main.red} · красных на дереве зелёного запроса ${sum.main.redAfterGreen}`);
  lines.push(`плавает — один код, одно место, два исхода: ${sum.flaky.length}`);
  for (const f of sum.flaky) lines.push(`  ${f.title} · зелёных ${f.ok}, красных ${f.bad} · прогоны ${f.runs.join(", ")}`);
  return lines.join("\n");
}
