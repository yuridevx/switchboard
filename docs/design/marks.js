/* ===== Метки «прочитал» (устав): A — прочитал, Z — снять ===== */
(function(){
  let hovered = null, coll = null, ready = false;
  const queue = [];
  const blockOf = t => (t && t.closest) ? t.closest("[data-chg]") : null;
  document.addEventListener("pointerover", e => { const b = blockOf(e.target); if (b) hovered = b; });
  document.addEventListener("pointerdown", e => { const b = blockOf(e.target); if (b) hovered = b; });
  document.addEventListener("focusin", e => { const b = blockOf(e.target); if (b) hovered = b; });

  function paint(id, on){
    document.querySelectorAll('[data-chg="' + id + '"]').forEach(b => b.classList.toggle("read", on));
  }
  function idsOf(b){
    const ids = [b.getAttribute("data-chg")];
    b.querySelectorAll("[data-chg]").forEach(n => ids.push(n.getAttribute("data-chg")));
    return ids;
  }
  async function mark(ids, on){
    ids.forEach(id => paint(id, on));
    if (!coll) return;
    for (const id of ids){
      try { if (on) await coll.doc(id).set({read:true, at:Date.now()}); else await coll.doc(id).delete(); }
      catch (_) { banner("Метка не сохранилась — обновите страницу"); }
    }
  }
  function act(on){
    if (!hovered) return;
    const ids = idsOf(hovered);
    if (ready) mark(ids, on); else queue.push([ids, on]);
  }
  const A = new Set(["a","A","а","А"]), Z = new Set(["z","Z","я","Я"]);
  document.addEventListener("keydown", e => {
    const t = e.target;
    if (t && t.matches && t.matches("input:not([type=range]),textarea,select,[contenteditable],[contenteditable=true]")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (A.has(e.key) || e.code === "KeyA"){ e.preventDefault(); act(true); }
    else if (Z.has(e.key) || e.code === "KeyZ"){ e.preventDefault(); act(false); }
  });
  let bannerEl = null;
  function banner(text){
    if (!bannerEl){ bannerEl = document.createElement("div"); bannerEl.className = "mark-banner"; bannerEl.setAttribute("role","status"); document.body.appendChild(bannerEl); }
    bannerEl.textContent = text;
  }
  (async function init(){
    let db = null;
    try { db = (window.claude && window.claude.use) ? await window.claude.use("db") : null; } catch (_) { db = null; }
    if (db){
      try {
        coll = db.collection("accepted");
        coll.onSnapshot(snap => {
          const on = new Set();
          snap.docs.forEach(d => { const v = d.data(); if (v && v.read) on.add(d.id); });
          document.querySelectorAll("[data-chg]").forEach(b => { const id = b.getAttribute("data-chg"); b.classList.toggle("read", on.has(id)); });
        }, () => banner("Метки не загрузились — хранилище недоступно"));
      } catch (_) { coll = null; }
    }
    ready = true;
    if (!coll) banner("Метки «прочитал» не сохраняются — хранилище недоступно");
    while (queue.length){ const [ids, on] = queue.shift(); mark(ids, on); }
  })();
})();
