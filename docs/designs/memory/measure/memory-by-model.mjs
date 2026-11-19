// только чтение: кто читает и пишет память — по моделям, за 7 дней; тексты не печатает
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import readline from "node:readline";
const data = path.join(os.homedir(), ".switchboard2", "prod", "host", "data");
const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const out = {};
const prof = path.join(data, "profiles");
const hasMem = (id) => { const [o, r, p] = id.split("/"); return fs.existsSync(path.join(prof, `${o}__${r}`, p, "memory")); };
const core = JSON.parse(fs.readFileSync(path.join(data, "store", "core.json"), "utf8"));
const sess = {};
for (const s of core.sessions) {
  const k = `${s.spec.key ?? "?"}:${s.spec.model ?? "?"}`; const x = (sess[k] ??= { all: 0, mem: 0, child: 0, childMem: 0 });
  const m = (s.spec.pieces ?? []).some(hasMem); x.all++; if (m) x.mem++; if (s.spec.parent) { x.child++; if (m) x.childMem++; }
}
out.sessions = sess;
const since = Date.now() - 7 * 864e5; const recent = []; const all = new Set();
const walk = (d) => { for (const e of ls(d)) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".jsonl")) { all.add(e.name.slice(0, -6)); if (fs.statSync(f).mtimeMs >= since) recent.push(f); } } };
walk(path.join(data, "claude", "projects"));
const by = {}; const cell = (m) => (by[m] ??= { convs: 0, sub: 0, wPiece: 0, wLocal: 0, rPiece: 0, rLocal: 0, convW: 0, convR: 0 });
let mb = 0;
for (const f of recent) {
  mb += fs.statSync(f).size / 1048576;
  const models = {}; const acts = [];
  for await (const line of readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity })) {
    if (!line.includes('"type":"assistant"')) continue;
    const mm = line.match(/"model":"([^"]+)"/); if (!mm || mm[1] === "<synthetic>") continue;
    models[mm[1]] = (models[mm[1]] ?? 0) + 1;
    if (!line.includes("memory")) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    for (const b of j.message?.content ?? []) {
      if (b.type !== "tool_use") continue;
      const p = String(b.input?.file_path ?? "").replaceAll("\\", "/");
      if (!/\/memory\/[^/]+\.md$/.test(p)) continue;
      const op = /^(Write|Edit|MultiEdit)$/.test(b.name) ? "w" : b.name === "Read" ? "r" : null;
      if (op) acts.push([j.message.model, op, p.includes("/profiles/") ? "Piece" : "Local"]);
    }
  }
  const top = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0]; if (!top) continue;
  const c = cell(top); if (f.includes("subagents")) c.sub++; else c.convs++;
  const w = new Set(), r = new Set();
  for (const [m, op, where] of acts) { cell(m)[op + where]++; (op === "w" ? w : r).add(m); }
  for (const m of w) cell(m).convW++; for (const m of r) cell(m).convR++;
}
out.week = { files: recent.length, mb: Math.round(mb), by };
const rec = { files: 0, origin: 0, rawHere: 0 };
for (const c of ls(prof)) for (const p of ls(path.join(prof, c.name))) {
  const dir = path.join(prof, c.name, p.name, "memory");
  for (const f of ls(dir)) { if (!f.name.endsWith(".md") || f.name === "MEMORY.md") continue; rec.files++; const id = (fs.readFileSync(path.join(dir, f.name), "utf8").match(/originSessionId:\s*([0-9a-f-]{36})/) ?? [])[1]; if (id) { rec.origin++; if (all.has(id)) rec.rawHere++; } }
}
out.records = rec; out.rawFiles = all.size;
console.log(JSON.stringify(out));