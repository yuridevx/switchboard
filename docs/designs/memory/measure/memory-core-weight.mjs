// только чтение: вес ядра памяти и кто из дочерних остался без памяти родителя; тексты не печатает
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
const data = path.join(os.homedir(), ".switchboard2", "prod", "host", "data");
const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const prof = path.join(data, "profiles");
const dirOf = (id) => { const [o, r, p] = id.split("/"); return path.join(prof, `${o}__${r}`, p); };
const size = (f) => { try { const t = fs.readFileSync(f, "utf8"); return { lines: t.split(/\r?\n/).length, kb: +(Buffer.byteLength(t) / 1024).toFixed(1) }; } catch { return null; } };
const rules = (d) => ls(d).flatMap((e) => e.isDirectory() ? rules(path.join(d, e.name)) : e.name.endsWith(".md") ? [path.join(d, e.name)] : []);
const pieces = {};
for (const c of ls(prof)) for (const p of ls(path.join(prof, c.name))) {
  if (!p.isDirectory() || p.name.startsWith(".")) continue;
  const dir = path.join(prof, c.name, p.name);
  const ins = [path.join(dir, "CLAUDE.md"), path.join(dir, ".claude", "CLAUDE.md"), ...rules(path.join(dir, ".claude", "rules"))].map(size).filter(Boolean);
  const idx = size(path.join(dir, "memory", "MEMORY.md"));
  const recs = ls(path.join(dir, "memory")).filter((e) => e.name.endsWith(".md") && e.name !== "MEMORY.md");
  let recKb = 0; for (const r of recs) recKb += fs.statSync(path.join(dir, "memory", r.name)).size / 1024;
  pieces[p.name] = { insLines: ins.reduce((a, x) => a + x.lines, 0), insKb: +ins.reduce((a, x) => a + x.kb, 0).toFixed(1), idxLines: idx?.lines ?? 0, idxKb: idx?.kb ?? 0, recs: recs.length, recKb: +recKb.toFixed(1) };
}
const core = JSON.parse(fs.readFileSync(path.join(data, "store", "core.json"), "utf8"));
const by = new Map(core.sessions.map((s) => [s.callsign, s]));
const hasMem = (s) => (s.spec.pieces ?? []).some((id) => fs.existsSync(path.join(dirOf(id), "memory")));
const kids = { all: 0, own: 0, gain: 0, parentElsewhere: 0, parentNoMem: 0, gainByModel: {} };
const weight = [];
for (const s of core.sessions) {
  const ps = (s.spec.pieces ?? []).map((id) => pieces[id.split("/").pop()]).filter(Boolean);
  if (ps.length) weight.push({ model: s.spec.model, n: ps.length, insKb: +ps.reduce((a, x) => a + x.insKb, 0).toFixed(1), idxKb: +ps.reduce((a, x) => a + x.idxKb, 0).toFixed(1), idxLines: ps.reduce((a, x) => a + x.idxLines, 0) });
  if (!s.spec.parent) continue;
  kids.all++;
  if (hasMem(s)) { kids.own++; continue; }
  const p = by.get(s.spec.parent);
  if (!p) kids.parentElsewhere++; else if (hasMem(p)) { kids.gain++; kids.gainByModel[s.spec.model] = (kids.gainByModel[s.spec.model] ?? 0) + 1; } else kids.parentNoMem++;
}
let dirs = 0, files = 0;
for (const p of ls(path.join(data, "claude", "projects"))) { const f = ls(path.join(data, "claude", "projects", p.name, "memory")).filter((e) => e.name.endsWith(".md")); if (f.length) { dirs++; files += f.length; } }
console.log(JSON.stringify({ sessions: core.sessions.length, pieces, kids, weight, local: { dirs, files } }));