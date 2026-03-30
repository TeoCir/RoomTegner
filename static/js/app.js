// ── Init ────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  buildContainerList();
  resizeAll();
  window.addEventListener('resize', () => { resizeAll(); render(); });
  setupEvents();
  setToday();
  loadSavedList();
  updateDP();
  // Restore last session from localStorage
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      fromSketchJSON(data);
      state.sketchName = data.sketchName || 'Ny skisse';
      state.customer   = data.customer   || '';
      state.sketchId   = data.sketchId   || null;
      document.getElementById('sketchLabel').textContent = state.sketchName;
      const banner = document.getElementById('autosave-banner');
      const lbl = document.getElementById('autosave-banner-text');
      if (banner) {
        const rooms = state.rooms.length;
        lbl.textContent = `Gjenopprettet "${state.sketchName}" (${rooms} rom)`;
        banner.style.display = 'flex';
        setTimeout(() => { banner.style.display = 'none'; }, 8000);
      }
    }
  } catch(e) {}
  renderRoomTabs();
  requestAnimationFrame(() => { resizeAll(); setRoomMode(state.roomMode); render(); });

  // Preload all GLB models in the background so 3D view is instant when the user first opens it.
  // The overlay is shown during this load and fades out when done.
  const overlay   = document.getElementById('loading-overlay');
  const bar       = document.getElementById('loading-bar');
  const countEl   = document.getElementById('loading-count');
  scene3d.preloadAll(
    (loaded, total) => {
      const pct = Math.round((loaded / total) * 100);
      if (bar)     bar.style.width = pct + '%';
      if (countEl) countEl.textContent = `${loaded} / ${total}`;
    },
    () => {
      // Initialise 3D scene eagerly now that all GLBs are in browser cache.
      // Doing this here (rather than lazily on first 3D tab click or PDF export)
      // guarantees the WebGL context is ready before the user can trigger PDF export,
      // which avoids a race where init() is called on a hidden canvas and may fail
      // to produce a valid context in time for captureTopDown().
      if (!scene3d._initialized) scene3d.init();

      if (!overlay) return;
      overlay.classList.add('fade-out');
      // Remove from DOM after fade so it has zero impact on layout/events
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    }
  );
});

function resizeAll() {
  const dpr = window.devicePixelRatio || 1;
  const wrap = document.getElementById('cw');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const c = document.getElementById('canvas-2d');
  c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  c.style.width = W + 'px'; c.style.height = H + 'px';
  calcPPM();
  if (state.view === '3d') scene3d.resize();
}

// Use render2D() directly during drag/pan/rotate — those paths run on every
// mousemove and must stay cheap. scene3d.rebuild() marks the 3D scene dirty,
// which causes _doRebuild() to tear down and recreate ALL Three.js meshes on
// the next requestAnimationFrame. Calling it during drag would rebuild every
// frame while the user is moving an object. The 3D scene is synced on mouseup
// instead (see mouseup listener). Call render() (this function) for all other
// state changes: button clicks, item placement, view switches, etc.
function render() {
  render2D();
  if (scene3d._initialized) scene3d.rebuild();
  scheduleAutosave();
}

// Throttle 2D repaints during high-frequency events (drag, pan, rotate).
// Instead of painting synchronously on every mousemove, schedule a single
// paint on the next animation frame — capped at 60fps regardless of mouse rate.
// Other code paths (mouseup, button clicks) call render2D() directly since they
// are not high-frequency and must paint immediately.
let _render2dScheduled = false;
function scheduleRender2D() {
  if (_render2dScheduled) return;
  _render2dScheduled = true;
  requestAnimationFrame(() => {
    _render2dScheduled = false;
    render2D();
  });
}

// ── Sidebar tabs ─────────────────────────────────────────────────────────
function setSbTab(tab, btn) {
  ['room', 'containers', 'utstyr', 'wall', 'skilt', 'saved'].forEach(t => {
    document.getElementById('tab-' + t).style.display = t === tab ? '' : 'none';
  });
  document.querySelectorAll('.sb-tab').forEach(b => b.classList.remove('act'));
  btn.classList.add('act');
  if (tab === 'saved') loadSavedList();
  if (tab === 'skilt') buildSkiltList();
  if (tab === 'utstyr') buildUtstyrList();
}

// ── Skilt list ────────────────────────────────────────────────────────────
function buildSkiltList() {
  const el = document.getElementById('skilt-list'); el.innerHTML = '';
  SKILT_DEFS.forEach(s => {
    const div = document.createElement('div'); div.className = 'skilt-item';
    div.innerHTML = `
      <img src="${s.url}" alt="${s.name}" onerror="this.style.opacity=0.3">
      <div class="skilt-item-info">
        <div class="skilt-item-name">${s.name}</div>
        <div class="skilt-item-desc">Klikk for å plassere i rom</div>
      </div>
      <button class="skilt-add" onclick="addSkilt('${s.id}')">+</button>`;
    el.appendChild(div);
  });
}

// ── Skilt plassering — klikk skilt → klikk beholder ──────────────────────
// state.pendingSkilt = { id, def } mens vi venter på beholder-klikk
function addSkilt(id) {
  const def = SKILT_DEFS.find(s => s.id === id); if (!def) return;
  state.pendingSkilt = { id, def };
  const c = document.getElementById('canvas-2d');
  c.style.cursor = 'crosshair';
  setInfo(`🏷 Klikk på en beholder for å feste «${def.name}»  ·  Esc = avbryt`);
  render();
}

function _restoreCursor() {
  const c = document.getElementById('canvas-2d');
  c.style.cursor = (state.roomMode === 'free' && state.polyDraw && !state.polyDone) || state.tool === 'innerwall' ? 'crosshair' : '';
}

function cancelPendingSkilt() {
  state.pendingSkilt = null;
  _restoreCursor();
  setInfo('');
  render();
}

function placePendingSkiltOnContainer(container) {
  const ps = state.pendingSkilt; if (!ps) return;
  const w = nearestWall(container.x, container.y);
  const binH = container.def.H / 1000;
  // Remove any existing linked skilt for this container
  state.items = state.items.filter(s => !(s.kind === 'skilt' && s._linkedTo === container.id));
  const skiltSizeM = Math.min(Math.max((container.def.W / 1000) * 0.70, 0.25), 0.65);
  state.items.push({
    id: state.nextId++, typeId: ps.id, kind: 'skilt',
    def: ps.def, x: container.x, y: container.y, rot: 0, size: skiltSizeM,
    wallH: binH + 0.35, wallOffset: 0,
    _linkedTo: container.id,
    _wallNx: w ? w.nx : 0, _wallNy: w ? w.ny : -1,
    _wallX:  w ? w.wallX : container.x, _wallY: w ? w.wallY : container.y,
  });
  state.pendingSkilt = null;
  _restoreCursor();
  setInfo('');
  render();
  if (state.view === '3d' && scene3d._initialized) scene3d.rebuild();
}


// ── Fraksjon picker ───────────────────────────────────────────────────────
// Renders a compact strip of fraction color buttons above the container list.
// The active selection persists in state.activeFraksjon so every new bin
// inherits it without the user re-selecting per add.
function buildFraksjonPicker() {
  const el = document.getElementById('fraksjon-picker');
  if (!el) return;
  const active = state.activeFraksjon || 'rest';
  el.innerHTML = `
    <div class="fraksjon-label">Fraksjon</div>
    <div class="fraksjon-chips">
      ${FRAKSJONER.map(f => `
        <button class="fraksjon-chip${f.id === active ? ' active' : ''}"
                style="--chip-color:${f.color}"
                title="${f.label}"
                onclick="setActiveFraksjon('${f.id}')">
          <span class="chip-dot" style="background:${f.color}"></span>
          <span class="chip-label">${f.label}</span>
        </button>`).join('')}
    </div>`;
}

function setActiveFraksjon(id) {
  state.activeFraksjon = id;
  buildFraksjonPicker(); // re-render picker to update active highlight
}

// ── Container list ────────────────────────────────────────────────────────
function buildContainerList() {
  buildFraksjonPicker();
  const el = document.getElementById('clist'); el.innerHTML = '';
  // Beholdere tab: L-bins only
  DEFS.filter(d => d.type === 'bin' || d.type === 'bin-large' || d.type === 'bin-xl')
    .forEach(d => {
      const div = document.createElement('div'); div.className = 'ci';
      div.onclick = () => addContainer(d.id);
      div.innerHTML = `
        <svg class="ci-icon" viewBox="0 0 34 42">${svgIcon(d)}</svg>
        <div class="ci-info"><div class="ci-name">${d.name}</div><div class="ci-dims">${d.W}×${d.D}×${d.H}mm</div></div>
        <div class="ci-add">+</div>`;
      el.appendChild(div);
    });
}

function buildUtstyrList() {
  const el = document.getElementById('ulist'); el.innerHTML = '';
  // Utstyr tab: everything that is not an L-bin (compactors, cages, machines)
  DEFS.filter(d => d.type !== 'bin' && d.type !== 'bin-large' && d.type !== 'bin-xl')
    .forEach(d => {
      const div = document.createElement('div'); div.className = 'ci';
      div.onclick = () => addContainer(d.id);
      div.innerHTML = `
        <svg class="ci-icon" viewBox="0 0 34 42">${svgIcon(d)}</svg>
        <div class="ci-info"><div class="ci-name">${d.name}</div><div class="ci-dims">${d.W}×${d.D}×${d.H}mm</div></div>
        <div class="ci-add">+</div>`;
      el.appendChild(div);
    });
}

function svgIcon(d) {
  if (d.type === 'cage' || d.type === 'rollcage') {
    return `<rect x="3" y="5" width="28" height="32" rx="1" fill="none" stroke="#888" stroke-width="1.5"/>
    <line x1="3" y1="9" x2="31" y2="9" stroke="#aaa" stroke-width=".8"/>
    <line x1="3" y1="14" x2="31" y2="14" stroke="#aaa" stroke-width=".8"/>
    <line x1="3" y1="19" x2="31" y2="19" stroke="#aaa" stroke-width=".8"/>
    <line x1="3" y1="24" x2="31" y2="24" stroke="#aaa" stroke-width=".8"/>
    <line x1="3" y1="29" x2="31" y2="29" stroke="#aaa" stroke-width=".8"/>
    <line x1="9" y1="5" x2="9" y2="37" stroke="#aaa" stroke-width=".8"/>
    <line x1="17" y1="5" x2="17" y2="37" stroke="#aaa" stroke-width=".8"/>
    <line x1="25" y1="5" x2="25" y2="37" stroke="#aaa" stroke-width=".8"/>
    <circle cx="9" cy="39" r="2" fill="#777"/>
    <circle cx="25" cy="39" r="2" fill="#777"/>`;
  }
  if (d.type === 'machine') {
    return `
    <rect x="3" y="4" width="28" height="34" rx="2" fill="#3a3a3a"/>
    <rect x="3" y="4" width="28" height="9" rx="2" fill="#2a2a2a"/>
    <rect x="7" y="7" width="8" height="3" rx="1" fill="#555"/>
    <rect x="19" y="7" width="8" height="3" rx="1" fill="#555"/>
    <rect x="8" y="16" width="18" height="12" rx="1" fill="#4a4a4a"/>
    <rect x="11" y="30" width="12" height="4" rx="1" fill="#E8521A"/>`;
  }
  if (d.type === 'compactor') {
    return `
    <!-- Main body -->
    <rect x="3" y="4" width="28" height="34" rx="2" fill="#606870"/>
    <!-- Top dark panel -->
    <rect x="3" y="4" width="28" height="12" rx="2" fill="#454d54"/>
    <!-- Feed opening slot -->
    <rect x="6" y="7" width="22" height="5" rx="1" fill="#1a1a1a"/>
    <!-- Arrow into slot -->
    <polygon points="17,6 20,9 17,8.5 14,9" fill="#E8521A" opacity=".9"/>
    <!-- Control panel box -->
    <rect x="18" y="8" width="10" height="7" rx="1" fill="#2e353c"/>
    <!-- LEDs -->
    <circle cx="21" cy="10.5" r="1.2" fill="#00cc55"/>
    <circle cx="24" cy="10.5" r="1.2" fill="#ffaa00"/>
    <circle cx="27" cy="10.5" r="1.2" fill="#cc2200"/>
    <!-- Button -->
    <rect x="20" y="12.5" width="7" height="1.8" rx="0.9" fill="#555"/>
    <!-- NG badge -->
    <rect x="8" y="20" width="12" height="6" rx="1.5" fill="#E8521A"/>
    <text x="14" y="24.2" text-anchor="middle" fill="#fff" font-size="4.2" font-weight="800">NG</text>
    <!-- Side vents -->
    <line x1="5" y1="28" x2="5" y2="32" stroke="#505860" stroke-width="1.5"/>
    <line x1="7" y1="28" x2="7" y2="32" stroke="#505860" stroke-width="1.5"/>
    <!-- Bottom feet -->
    <rect x="5" y="36" width="6" height="2" rx="1" fill="#333"/>
    <rect x="23" y="36" width="6" height="2" rx="1" fill="#333"/>`;
  }
  const isGlass = d.type.includes('glass');
  const lid = isGlass ? '#4a7fa8' : '#555';
  return `
  <rect x="9" y="1" width="16" height="3" rx="1.5" fill="${lid}" opacity=".85"/>
  <rect x="5" y="3.5" width="24" height="3" rx="1.5" fill="${lid}"/>
  <rect x="6" y="6" width="22" height="29" rx="2" fill="#3c3c3c"/>
  <rect x="6" y="6" width="22" height="6" rx="2" fill="#4a4a4a"/>
  <rect x="8" y="7.5" width="18" height="2" rx="1" fill="#666" opacity=".5"/>
  ${isGlass ? `<text x="17" y="11.5" text-anchor="middle" fill="${lid}" font-size="3.5" font-weight="700">GLASS</text>` : ''}
  <rect x="9" y="14" width="10" height="5" rx="1.5" fill="#E8521A"/>
  <text x="14" y="18.2" text-anchor="middle" fill="#fff" font-size="4.2" font-weight="800">NG</text>
  <rect x="9" y="21" width="16" height="2" rx="1" fill="#303030"/>
  <rect x="9" y="25" width="12" height="2" rx="1" fill="#303030"/>
  <rect x="9" y="29" width="14" height="2" rx="1" fill="#303030"/>
  <circle cx="10" cy="38" r="2.5" fill="#1a1a1a"/><circle cx="10" cy="38" r="1.2" fill="#555"/>
  <circle cx="24" cy="38" r="2.5" fill="#1a1a1a"/><circle cx="24" cy="38" r="1.2" fill="#555"/>`;
}

// ── Room mode ─────────────────────────────────────────────────────────────
function setRoomMode(m) {
  state.roomMode = m;
  document.getElementById('mrect').classList.toggle('act', m === 'rect');
  document.getElementById('mwall').classList.toggle('act', m === 'free');
  document.getElementById('rect-inputs').style.display = m === 'rect' ? '' : 'none';
  document.getElementById('free-inputs').style.display = m === 'free' ? '' : 'none';
  if (m === 'free' && state.poly.length === 0) {
    state.polyDraw = true;
    const c = document.getElementById('canvas-2d');
    c.style.cursor = 'crosshair';
    state.polyOriginX = c.clientWidth / 2;
    state.polyOriginY = c.clientHeight / 2;
    showCancelBtn(true);
    setInfo('Klikk for første hjørnepunkt · Shift=90° · Ctrl+Z / Esc=angre punkt · Scroll=zoom · Dbl-klikk=lukk rom');
  }
  render();
}

function updateRect() {
  state.roomW = +document.getElementById('rW').value || 6;
  state.roomD = +document.getElementById('rD').value || 4;
  state.roomH = +document.getElementById('rH').value || 2.8;
  calcPPM(); render();
}

function resetPoly() {
  state.poly = []; state.polyDone = false; state.polyDraw = true;
  document.getElementById('canvas-2d').style.cursor = 'crosshair';
  showCancelBtn(true); render();
}

function cancelPoly() {
  state.poly = []; state.polyDone = false; state.polyDraw = false;
  state.hoverPoly = null; state.polyOriginX = null; state.polyOriginY = null;
  showCancelBtn(false);
  setInfo('Frihånd-tegning avbrutt — trykk «Tegn nytt rom» for å starte igjen');
  render();
}

function showCancelBtn(show) {
  const btn = document.getElementById('cancel-poly-btn');
  if (btn) btn.style.display = show ? '' : 'none';
}

// ── Items ──────────────────────────────────────────────────────────────────
function addContainer(defId) {
  const def = DEFS.find(x => x.id === defId); if (!def) return;
  // Enter floating placement mode — container follows the mouse until the user clicks.
  // Left click = place once and exit; right click = place and keep floating for rapid placement.
  state.pendingContainer = { defId, def };
  state._pendingContainerPos = null;
  document.getElementById('canvas-2d').style.cursor = 'crosshair';
  setInfo('Venstreklikk = plasser · Høyreklikk = plasser og fortsett · Esc = avbryt');
  render();
}

// Places the floating container at the current ghost position.
// keepActive=true keeps the mode alive for right-click continuous placing.
function _placePendingContainer(keepActive) {
  const pc = state.pendingContainer;
  if (!pc) return;
  // If the mouse hasn't moved over the canvas yet there is no ghost position.
  // Exit the mode rather than silently doing nothing (which left users stuck).
  const pos = state._pendingContainerPos;
  if (!pos) {
    if (!keepActive) { state.pendingContainer = null; _restoreCursor(); setInfo(''); }
    return;
  }
  const it = {
    id: state.nextId++, kind: 'container', typeId: pc.defId, def: pc.def,
    x: pos.x, y: pos.y, rot: pos.rot || pc.def.defaultRot || 0, fraksjon: state.activeFraksjon || 'rest'
  };
  state.items.push(it);
  state.sel = it.id;
  checkAutoSkilt(it);
  updateDP();
  if (!keepActive) {
    state.pendingContainer = null;
    state._pendingContainerPos = null;
    _restoreCursor();
    setInfo('');
  }
  render();
  if (state.view === '3d' && scene3d._initialized) scene3d.rebuild();
}

function addWallEl(typeId) {
  const def = WALL_EL_DEFS[typeId]; if (!def) return;
  const kind = typeId === 'exit' ? 'exit' : 'wall';
  const cx = state.roomMode === 'rect' ? state.roomW / 2 : centroid('x');
  const cy = state.roomMode === 'rect' ? state.roomD / 2 : centroid('y');
  const it = { id: state.nextId++, kind, typeId, def, x: cx, y: cy, rot: 0 };
  state.items.push(it); state.sel = it.id;
  updateDP(); render();
}

function addNote() {
  const text = document.getElementById('noteText').value.trim();
  if (!text) return;
  const cx = state.roomMode === 'rect' ? state.roomW / 2 : centroid('x');
  const cy = state.roomMode === 'rect' ? state.roomD / 2 : centroid('y');
  const it = { id: state.nextId++, kind: 'note', typeId: 'note', def: null, x: cx, y: cy, rot: 0, text };
  state.items.push(it); state.sel = it.id;
  document.getElementById('noteText').value = '';
  updateDP(); render();
}

function centroid(axis) {
  if (state.poly.length === 0) return 3;
  return state.poly.reduce((s, p) => s + p[axis], 0) / state.poly.length;
}

function delSel() {
  if (!state.sel) return;
  state.items = state.items.filter(i => i.id !== state.sel);
  state.sel = null; updateDP(); render();
}

function rot90() {
  const it = state.items.find(i => i.id === state.sel);
  if (it) {
    it.rot = ((it.rot || 0) + Math.PI / 2) % (Math.PI * 2);
    if (it.kind === 'container') updateLinkedSkiltWall(it); "funksjon så skilt følger riktig vegg ved 90* roter"
    updateDP(); render();
  }
}

function setTool(t) {
  // Cancel any in-progress inner-wall drawing when switching tools
  if (t !== 'innerwall') { state.innerWallStart = null; state.innerWallHover = null; }
  state.tool = t;
  document.querySelectorAll('.ct').forEach(b => b.classList.remove('act'));
  const el = document.getElementById('t' + t);
  if (el) el.classList.add('act');
  _restoreCursor();
}

function discardAutosave() {
  document.getElementById('autosave-banner').style.display = 'none';
  newSketch();
}

function newSketch() {
  state.items = []; state.sel = null; state.poly = []; state.polyDone = false; state.polyDraw = false;
  state.sketchId = null; state.sketchName = 'Ny skisse'; state.customer = '';
  state.hoverPoly = null; state.polyOriginX = null; state.polyOriginY = null;
  state.rooms = [{ id: 'room-' + Date.now(), name: 'Rom 1', data: null }];
  state.activeRoom = 0;
  document.getElementById('sketchLabel').textContent = 'Ny skisse';
  setRoomMode('free');
  calcPPM(); updateDP(); render();
  renderRoomTabs();
  clearAutosave();
}

function resetRoom() {
  showConfirm('Fjerne alle beholdere?\nRomtegningen beholdes.', () => {
    state.items = []; state.sel = null;
    updateDP(); render();
  }, { icon: '🗑️', yesLabel: 'Tøm rom' });
}

function resetAll() {
  showConfirm('Slette hele skissen inkludert rom og alle beholdere?\nDenne handlingen kan ikke angres.', () => {
    newSketch();
  }, { icon: '⚠️', yesLabel: 'Nullstill alt' });
}

function exportSketch() {
  const data = toSketchJSON();
  data.sketchName = state.sketchName || 'Ny skisse';
  data.customer   = state.customer  || '';
  data.exportedAt = new Date().toISOString();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safe = (data.sketchName || 'skisse').replace(/[^a-zA-Z0-9æøåÆØÅ _-]/g, '');
  a.download = safe + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importSketch(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      fromSketchJSON(data);
      state.sketchName = data.sketchName || file.name.replace('.json','');
      state.customer   = data.customer   || '';
      state.sketchId   = null;
      document.getElementById('sketchLabel').textContent = state.sketchName;
      if (state.roomMode === 'rect') {
        document.getElementById('rW').value = state.roomW;
        document.getElementById('rD').value = state.roomD;
      }
      setRoomMode(state.roomMode);
      renderRoomTabs();
      updateDP(); render();
    } catch {
      showAlert('Kunne ikke lese filen.\nSjekk at det er en gyldig romskisse-fil (.json).', { icon: '❌' });
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // reset so same file can be re-imported
}

// ── Events ────────────────────────────────────────────────────────────────
function setupEvents() {
  const c = document.getElementById('canvas-2d');
  c.addEventListener('mousedown', onMD);
  c.addEventListener('mousemove', onMM);
  document.addEventListener('mouseup', () => {
    const dragged = state.drag;
    const rotated = state.rotat; // save before clearing
    state.drag = null; state.rotat = null; state.panning = false;
    // Restore correct cursor
    if (state.spaceDown) {
      c.style.cursor = 'grab';
    } else {
      _restoreCursor();
    }
    if (dragged && dragged.kind === 'container') {
      // Auto-rotate to face nearest wall (front faces inward)
      const w = nearestWall(dragged.x, dragged.y);
      if (w && w.dist < 0.8) {
        dragged.rot = Math.atan2(w.nx, -w.ny);
      }
      // Move any linked skilt with the container and sync wall info.
      // Wall info is updated here unconditionally (not only in checkAutoSkilt)
      // so that stale _wallNx/Ny from a previous position never survives a drag.
      state.items.forEach(s => {
        if (s.kind === 'skilt' && s._linkedTo === dragged.id) {
          s.x = dragged.x; s.y = dragged.y;
          if (w) {
            s._wallNx = w.nx; s._wallNy = w.ny;
            s._wallX  = w.wallX; s._wallY  = w.wallY;
          }
        }
      });
      checkAutoSkilt(dragged);
      updateDP(); render();
    }
    if (rotated && rotated.kind === 'container') {
      updateLinkedSkiltWall(rotated);
      render();
    }
  });
  c.addEventListener('dblclick', onDbl);
  document.addEventListener('keydown', onKey);
  c.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  c.addEventListener('contextmenu', e => e.preventDefault());
  c.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', e => {
    if (e.key === 'Shift') state.shiftDown = true;
    if (e.key === ' ') { state.spaceDown = true; c.style.cursor = 'grab'; e.preventDefault(); }
  });
  document.addEventListener('keyup', e => {
    if (e.key === 'Shift') state.shiftDown = false;
    if (e.key === ' ') { state.spaceDown = false; if (!state.panning) c.style.cursor = ''; }
  });
}

function onWheel(e) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1/1.12;
  const newZoom = Math.min(Math.max(state.zoom * factor, 0.15), 8.0);
  // Zoom centred on mouse position
  const mx = e.offsetX, my = e.offsetY;
  const { ox, oy } = getO();
  const oldPPM = getPPM();
  state.zoom = newZoom;
  const newPPM = getPPM();
  // Adjust pan so the point under cursor stays fixed
  state.panX += (mx - ox) * (1 - newPPM / oldPPM);
  state.panY += (my - oy) * (1 - newPPM / oldPPM);
  document.getElementById('rbar').style.width = getPPM() + 'px';
  render();
}

function zoomBtn(dir) {
  const factor = dir > 0 ? 1.25 : 1/1.25;
  state.zoom = Math.min(Math.max(state.zoom * factor, 0.15), 8.0);
  document.getElementById('rbar').style.width = getPPM() + 'px';
  render();
}

function resetZoom() {
  state.zoom = 1.0; state.panX = 0; state.panY = 0;
  document.getElementById('rbar').style.width = getPPM() + 'px';
  render();
}

function c2r(ex, ey) { const { ox, oy } = getO(); const ppm = getPPM(); return { rx: (ex - ox) / ppm, ry: (ey - oy) / ppm }; }

// Snap a raw room-coord point for inner-wall drawing.
// Priority: 1) existing innerwall endpoints, 2) poly corners, 3) outer wall boundary,
//           4) auto-ortho from anchor (within ±15°), 5) 0.1m grid.
// Returns {x, y, snapped} — snapped is truthy when locked to an existing point or wall.
function snapInnerWallPoint(rx, ry) {
  const SNAP = 0.3; // metres — snap radius for endpoint/wall attraction

  // 1. Existing innerwall endpoints (allows walls to chain flush)
  for (const iw of state.items.filter(i => i.kind === 'innerwall')) {
    for (const [ex, ey] of [[iw.x1, iw.y1], [iw.x2, iw.y2]]) {
      if (Math.hypot(rx - ex, ry - ey) < SNAP) return { x: ex, y: ey, snapped: true };
    }
  }

  // 2. Room polygon corners (attach to room boundary corners)
  for (const p of (state.poly || [])) {
    if (Math.hypot(rx - p.x, ry - p.y) < SNAP) return { x: p.x, y: p.y, snapped: true };
  }

  // 3. Outer wall boundary — snap to nearest point ON the wall segment so walls
  //    start/end flush with the room boundary even mid-segment.
  if (state.roomMode === 'rect') {
    const W = state.roomW, D = state.roomD;
    const wallSnaps = [
      { x: rx, y: 0,  dist: Math.abs(ry)     },
      { x: rx, y: D,  dist: Math.abs(ry - D)  },
      { x: 0,  y: ry, dist: Math.abs(rx)      },
      { x: W,  y: ry, dist: Math.abs(rx - W)  },
    ];
    const best = wallSnaps.reduce((a, b) => a.dist < b.dist ? a : b);
    if (best.dist < SNAP) return { x: best.x, y: best.y, snapped: true };
  } else if (state.poly && state.poly.length > 0) {
    const pts = state.poly;
    let bestDist = SNAP, bestX = null, bestY = null;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ex = b.x - a.x, ey = b.y - a.y, len2 = ex*ex + ey*ey;
      if (len2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((rx - a.x)*ex + (ry - a.y)*ey) / len2));
      const wx = a.x + t*ex, wy = a.y + t*ey;
      const dist = Math.hypot(rx - wx, ry - wy);
      if (dist < bestDist) { bestDist = dist; bestX = wx; bestY = wy; }
    }
    if (bestX !== null) return { x: bestX, y: bestY, snapped: true };
  }

  // 4. Grid snap then direction lock
  let gx = Math.round(rx * 10) / 10, gy = Math.round(ry * 10) / 10;
  if (state.innerWallStart) {
    const dx = gx - state.innerWallStart.x, dy = gy - state.innerWallStart.y;
    if (state.shiftDown) {
      // Shift = hard 90° lock
      if (Math.abs(dx) >= Math.abs(dy)) gy = state.innerWallStart.y;
      else gx = state.innerWallStart.x;
    } else {
      // Auto-ortho: within ±15° of horizontal or vertical → lock automatically
      const AUTO_ORTHO = Math.PI / 12;
      const angle = Math.atan2(Math.abs(dy), Math.abs(dx));
      if (angle < AUTO_ORTHO) gy = state.innerWallStart.y;
      else if (angle > Math.PI / 2 - AUTO_ORTHO) gx = state.innerWallStart.x;
    }
    gx = Math.round(gx * 10) / 10; gy = Math.round(gy * 10) / 10;
  }
  return { x: gx, y: gy, snapped: false };
}

function onMD(e) {
  if (state.view !== '2d') return;
  const mx = e.offsetX, my = e.offsetY;

  // Floating container placement — left click places+stops, right click places+continues.
  // Exception: left-clicking an EXISTING item exits placement mode and selects that item,
  // so the user can naturally "click out" of placement to inspect/edit a placed container.
  if (state.pendingContainer) {
    if (e.button === 0) {
      const existingHit = [...state.items].reverse().find(it => it.kind !== 'skilt' && hitTest(it, mx, my));
      if (existingHit) {
        // Exit placement mode and select the clicked item
        state.pendingContainer = null; state._pendingContainerPos = null;
        _restoreCursor(); setInfo('');
        state.sel = existingHit.id; updateDP(); render(); return;
      }
      _placePendingContainer(false); return;
    }
    if (e.button === 2) { e.preventDefault(); _placePendingContainer(true); return; }
    return;
  }

  // Pending skilt placement — klikk på beholder for å feste
  if (state.pendingSkilt && e.button === 0) {
    const { ox, oy } = getO(); const ppm = getPPM();
    const rx = (mx - ox) / ppm, ry = (my - oy) / ppm;
    const hit = [...state.items].reverse().find(it => {
      if (it.kind !== 'container') return false;
      const hw = (it.def.W / 1000) / 2, hd = (it.def.D / 1000) / 2;
      return Math.abs(rx - it.x) < hw + 0.1 && Math.abs(ry - it.y) < hd + 0.1;
    });
    if (hit) { placePendingSkiltOnContainer(hit); return; }
    // Klikk utenfor beholder = avbryt
    cancelPendingSkilt(); return;
  }

  // Right-click, middle mouse or space+drag = pan
  if (e.button === 2 || e.button === 1 || state.spaceDown) {
    state.panning = true; state.panSX = mx; state.panSY = my;
    state.panOX = state.panX; state.panOY = state.panY;
    document.getElementById('canvas-2d').style.cursor = 'grabbing';
    e.preventDefault(); return;
  }
  // ── Inner wall tool ───────────────────────────────────────────────────
  // Continuous chain like freehand: each click extends the line from the previous
  // endpoint. Esc stops drawing. polyDone check skipped for rect rooms.
  if (state.tool === 'innerwall' && (state.polyDone || state.roomMode === 'rect')) {
    if (e.button !== 0) return;
    const { rx, ry } = c2r(mx, my);
    const pt = snapInnerWallPoint(rx, ry);
    if (!state.innerWallStart) {
      // First click: anchor the chain start
      state.innerWallStart = { x: pt.x, y: pt.y };
      state.innerWallHover = null;
      setInfo('Klikk for neste punkt · Shift=90° · Esc=ferdig');
    } else {
      const x1 = state.innerWallStart.x, y1 = state.innerWallStart.y;
      if (Math.hypot(pt.x - x1, pt.y - y1) >= 0.05) {
        state.items.push({
          id: state.nextId++, kind: 'innerwall',
          x1, y1, x2: pt.x, y2: pt.y,
          x: (x1 + pt.x) / 2, y: (y1 + pt.y) / 2, // midpoint for item loop compat
          rot: 0
        });
        // Chain: next segment starts from where this one ended
        state.innerWallStart = { x: pt.x, y: pt.y };
        state.innerWallHover = null;
        render();
      }
    }
    return;
  }

  if (state.roomMode === 'free' && state.polyDraw && !state.polyDone) {
    const { rx, ry } = c2r(mx, my);
    if (state.poly.length > 2) {
      const { ox, oy } = getO();
      const fp = state.poly[0];
      if (Math.hypot(mx - ox - fp.x * getPPM(), my - oy - fp.y * getPPM()) < 14) {
        state.polyDone = true; state.polyDraw = false; document.getElementById("canvas-2d").style.cursor = ""; calcPPM();
        setInfo('Rom tegnet! Legg til beholdere fra listen.'); render(); return;
      }
    }
    let sx = rx, sy = ry;
    // Grid snap: nearest 0.1m (10cm)
    sx = Math.round(sx * 10) / 10;
    sy = Math.round(sy * 10) / 10;
    // Shift = lock to 0° or 90° from last point
    if (state.shiftDown && state.poly.length > 0) {
      const last = state.poly[state.poly.length - 1];
      const dx = sx - last.x, dy = sy - last.y;
      if (Math.abs(dx) >= Math.abs(dy)) {
        sy = last.y;   // horizontal
      } else {
        sx = last.x;   // vertical
      }
      sx = Math.round(sx * 10) / 10;
      sy = Math.round(sy * 10) / 10;
    }
    // On first point: lock origin to click position
    if (state.poly.length === 0) {
      const { ox: ox0, oy: oy0 } = getO();
      const ppm0 = getPPM();
      state.polyOriginX = ox0 + sx * ppm0;
      state.polyOriginY = oy0 + sy * ppm0;
      state.poly.push({ x: 0, y: 0 });
    } else {
      state.poly.push({ x: sx, y: sy });
    }
    state.hoverPoly = null; render(); return;
  }
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i];
    if (it.kind === 'skilt') continue; // skilt er usynlig i 2D — ikke blokkér drag
    if (hitTest(it, mx, my)) {
      state.sel = it.id;
      // Innerwalls have two endpoints, not a center — drag/rotate would corrupt them.
      // Select only: user can then press Slett/Delete to remove.
      if (it.kind === 'innerwall') { updateDP(); render(); return; }
      const { ox, oy } = getO();
      if (state.tool === 'rotate') {
        state.rotat = it;
        const ppmR = getPPM();
        state.rsa = Math.atan2(my - oy - it.y * ppmR, mx - ox - it.x * ppmR);
        state.rsi = it.rot || 0;
      } else {
        state.drag = it;
        const ppmD = getPPM();
        state.dox = mx - ox - it.x * ppmD;
        state.doy = my - oy - it.y * ppmD;
      }
      updateDP(); render(); return;
    }
  }
  state.sel = null; updateDP(); render();
}

function onMM(e) {
  const mx = e.offsetX, my = e.offsetY;
  if (state.panning) {
    state.panX = state.panOX + (mx - state.panSX);
    state.panY = state.panOY + (my - state.panSY);
    // 2D only during pan — 3D rebuilds on mouseup (see mouseup listener)
    scheduleRender2D(); return;
  }
  if (state.drag) {
    const { ox, oy } = getO();
    const ppm = getPPM();
    state.drag.x = (mx - state.dox - ox) / ppm;
    state.drag.y = (my - state.doy - oy) / ppm;
    if (state.roomMode === 'rect') {
      let hw, hd;
      if (state.drag.kind === 'skilt') {
        hw = hd = (state.drag.size || 0.4) / 2;
      } else if (state.drag.def && state.drag.def.W) {
        const W2 = state.drag.def.W / 1000 / 2;
        const D2 = state.drag.def.D / 1000 / 2;
        const rot = state.drag.rot || 0;
        const cos = Math.abs(Math.cos(rot)), sin = Math.abs(Math.sin(rot));
        hw = W2 * cos + D2 * sin;
        hd = W2 * sin + D2 * cos;
      } else {
        hw = hd = 0.3;
      }
      let x = state.drag.x, y = state.drag.y;
      x = Math.max(hw, Math.min(state.roomW - hw, x));
      y = Math.max(hd, Math.min(state.roomD - hd, y));
      if (state.drag.kind !== 'skilt') {
        const snapped = snapToWall(x, y, hw, hd);
        x = snapped.x; y = snapped.y;
      }
      state.drag.x = x; state.drag.y = y;
    }
    // Freehand: snap to nearest polygon wall segment
    if (state.roomMode === 'free' && state.drag.kind !== 'skilt' && state.polyDone) {
      let hw = 0.3, hd = 0.3;
      if (state.drag.def && state.drag.def.W) {
        const W2 = state.drag.def.W / 1000 / 2;
        const D2 = state.drag.def.D / 1000 / 2;
        const rot = state.drag.rot || 0;
        const cos = Math.abs(Math.cos(rot)), sin = Math.abs(Math.sin(rot));
        hw = W2 * cos + D2 * sin;
        hd = W2 * sin + D2 * cos;
      }
      const snapped = snapToWall(state.drag.x, state.drag.y, hw, hd);
      state.drag.x = snapped.x; state.drag.y = snapped.y;
    }
    scheduleRender2D(); // 2D only during drag — 3D rebuilds on mouseup; updateDP() runs on mouseup
  }
  if (state.rotat) {
    const { ox, oy } = getO();
    const ppm = getPPM();
    const a = Math.atan2(my - oy - state.rotat.y * ppm, mx - ox - state.rotat.x * ppm);
    state.rotat.rot = state.rsi + (a - state.rsa);
    scheduleRender2D(); // 2D only during rotate — 3D rebuilds on mouseup; updateDP() runs on mouseup
  }
  // Floating container: track snapped position + auto-rotation for ghost rendering.
  // Order matters: rotation must be determined BEFORE snap so that the snap offset
  // uses the rotation-corrected half-extents (depth faces the wall after auto-rotate).
  // Using unrotated hw/hd for snap would place the container too far from the wall.
  if (state.pendingContainer) {
    const { rx, ry } = c2r(mx, my);
    const def = state.pendingContainer.def;
    const W2 = def.W / 2000, D2 = def.D / 2000;
    // Step 1: find nearest wall to determine auto-rotation — cached once per mousemove
    // so snapToWall() below can reuse the result instead of calling nearestWall() again.
    const w = nearestWall(rx, ry);
    const rot = (w && w.dist < 0.8) ? Math.atan2(w.nx, -w.ny) : 0;
    // Step 2: rotation-corrected effective half-extents for the snap offset
    const cos = Math.abs(Math.cos(rot)), sin = Math.abs(Math.sin(rot));
    const hw = W2 * cos + D2 * sin;
    const hd = W2 * sin + D2 * cos;
    // Step 3: snap position using precomputed wall result to avoid a second nearestWall() call
    const SNAP_DIST = Math.max(hw, hd) + 0.25;
    let pos = { x: rx, y: ry };
    if (w && w.dist < SNAP_DIST) {
      pos = { x: w.wallX + w.nx * hw, y: w.wallY + w.ny * hd };
    }
    if (state.roomMode === 'rect') {
      pos = { x: Math.max(hw, Math.min(state.roomW - hw, pos.x)),
              y: Math.max(hd, Math.min(state.roomD - hd, pos.y)) };
    }
    state._pendingContainerPos = { x: pos.x, y: pos.y, rot };
    scheduleRender2D(); return;
  }
  // Pending skilt: highlight hovered container
  if (state.pendingSkilt) {
    const { ox, oy } = getO(); const ppm = getPPM();
    const rx = (mx - ox) / ppm, ry = (my - oy) / ppm;
    state._skiltHoverId = null;
    state.items.forEach(it => {
      if (it.kind !== 'container') return;
      const hw = (it.def.W / 1000) / 2, hd = (it.def.D / 1000) / 2;
      if (Math.abs(rx - it.x) < hw + 0.1 && Math.abs(ry - it.y) < hd + 0.1)
        state._skiltHoverId = it.id;
    });
    scheduleRender2D(); return;
  }
  // Inner wall preview: snap and repaint on every mouse move
  if (state.tool === 'innerwall' && state.innerWallStart) {
    const { rx, ry } = c2r(mx, my);
    const pt = snapInnerWallPoint(rx, ry);
    state.innerWallHover = pt;
    const len = Math.hypot(pt.x - state.innerWallStart.x, pt.y - state.innerWallStart.y);
    const hint = pt.snapped ? ' · <b>Snappet</b>' : ' · Shift=90°';
    setInfo(`<b>${len.toFixed(2)} m</b>${hint} · Klikk for neste punkt · Esc=ferdig`);
    scheduleRender2D(); return;
  }

  if (state.roomMode === 'free' && state.polyDraw) {
    const { ox, oy } = getO();
    const ppm = getPPM();
    let rx2 = (mx - ox) / ppm, ry2 = (my - oy) / ppm;
    // Grid snap to 0.1m
    rx2 = Math.round(rx2 * 10) / 10;
    ry2 = Math.round(ry2 * 10) / 10;
    // Shift = orthogonal snap
    if (state.shiftDown && state.poly.length > 0) {
      const last = state.poly[state.poly.length - 1];
      const dx2 = rx2 - last.x, dy2 = ry2 - last.y;
      if (Math.abs(dx2) >= Math.abs(dy2)) ry2 = last.y;
      else rx2 = last.x;
      rx2 = Math.round(rx2 * 10) / 10;
      ry2 = Math.round(ry2 * 10) / 10;
    }
    const hx = ox + rx2 * ppm, hy = oy + ry2 * ppm;
    state.hoverPoly = { x: hx, y: hy };
    if (state.poly.length > 0) {
      const last = state.poly[state.poly.length - 1];
      const dx3 = rx2 - last.x, dy3 = ry2 - last.y;
      const dist3 = Math.sqrt(dx3*dx3 + dy3*dy3);
      const hint = state.shiftDown ? ' · <b>Shift: 90° aktiv</b>' : ' · Shift=90°';
      setInfo(`<b>${dist3.toFixed(2)} m</b>${hint} · Scroll=zoom · Dbl-klikk=lukk`);
    } else {
      setInfo('Klikk for første hjørnepunkt · Shift=90° · Scroll=zoom');
    }
    scheduleRender2D();
  }
}

function onDbl(e) {
  if (state.roomMode === 'free' && state.polyDraw && state.poly.length > 2) {
    state.polyDone = true; state.polyDraw = false; document.getElementById("canvas-2d").style.cursor = ""; calcPPM();
    setInfo('Rom tegnet!'); render();
  }
}

function onKey(e) {
  if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') return;
  // Ctrl+Z = undo last poly point (in wall-builder) or undo last placed item
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    if (state.roomMode === 'free' && state.polyDraw && state.poly.length > 0) {
      state.poly.pop();
      if (state.poly.length === 0) { state.polyOriginX = null; state.polyOriginY = null; }
      render(); return;
    }
    if (state.items.length > 0) {
      state.items.pop(); state.sel = null; updateDP(); render();
    }
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.sel) delSel();
  if (e.key === 'r' || e.key === 'R') rot90();
  if (e.key === 'Escape') {
    if (state.pendingContainer) {
      state.pendingContainer = null; state._pendingContainerPos = null;
      _restoreCursor(); setInfo(''); render(); return;
    }
    if (state.tool === 'innerwall' && state.innerWallStart) {
      state.innerWallStart = null; state.innerWallHover = null;
      setInfo('Tegning avbrutt'); render(); return;
    }
    if (state.pendingSkilt) {
      cancelPendingSkilt();
    } else if (state.roomMode === 'free' && state.polyDraw && !state.polyDone) {
      // Angre siste punkt hvis noen er lagt
      if (state.poly.length > 0) {
        state.poly.pop();
        if (state.poly.length === 0) { state.polyOriginX = null; state.polyOriginY = null; }
        setInfo('Punkt angret — fortsett å tegne, eller trykk Esc igjen for å avbryte');
        render();
      } else {
        // Tom poly — avbryt tegning
        cancelPoly();
      }
    } else {
      state.sel = null; updateDP(); render();
    }
  }
}

// ── View ──────────────────────────────────────────────────────────────────
function setView(v, btn) {
  state.view = v;
  document.querySelectorAll('.vb').forEach(b => {
    b.classList.toggle('act', btn ? b === btn : b.textContent.trim() === v.toUpperCase());
  });
  document.getElementById('canvas-2d').style.display = v === '2d' ? 'block' : 'none';
  document.getElementById('canvas-3d').style.display = v === '3d' ? 'block' : 'none';
  document.getElementById('bgGrid').style.display = v === '2d' ? 'block' : 'none';
  document.getElementById('tb2d').style.display = v === '2d' ? 'flex' : 'none';
  if (v === '3d') {
    if (!scene3d._initialized) scene3d.init();
    else scene3d.rebuild();
  }
  updateSkilt3dCtrl();
  render();
}

function updateSkilt3dCtrl() {
  const ctrl = document.getElementById('skilt3d-ctrl');
  if (!ctrl) return;
  const it = state.items.find(i => i.id === state.sel && i.kind === 'skilt');
  const show = state.view === '3d' && !!it;
  ctrl.style.display = show ? 'flex' : 'none';
  if (show) {
    const lbl = document.getElementById('skilt3d-h-lbl');
    if (lbl) lbl.textContent = ((it.wallH !== undefined ? it.wallH : 1.6)).toFixed(2) + 'm';
  }
}

// ── Detail panel ─────────────────────────────────────────────────────────
function updateDP() {
  const p = document.getElementById('dp');
  const it = state.items.find(i => i.id === state.sel);
  updateSkilt3dCtrl();
  if (!it) { p.innerHTML = '<div class="em">Velg et element</div>'; return; }
  const d = it.def;
  // Guard: if the def is missing (e.g. corrupted save or unknown typeId), show a
  // safe fallback rather than crashing the entire panel on d.name / d.sap etc.
  if ((it.kind === 'container' || it.kind === 'wall') && !d) {
    p.innerHTML = `<div class="em">Ukjent type (${it.typeId})</div>
      <button class="rpb rpbd" onclick="delSel()">Slett</button>`;
    return;
  }
  const rd = Math.round((it.rot || 0) * 180 / Math.PI) % 360;

  let fraksjonHtml = '';
  if (it.kind === 'container') {
    const opts = FRAKSJONER.map(f =>
      `<option value="${f.id}" ${(it.fraksjon||'rest') === f.id ? 'selected' : ''}>${f.label}</option>`
    ).join('');
    fraksjonHtml = `
    <div class="pr" style="flex-direction:column;align-items:flex-start;gap:4px">
      <span class="pk">Fraksjon</span>
      <select style="width:100%;font-size:11px;padding:4px 6px;border:1px solid #ddd;border-radius:4px;background:#fff"
        onchange="setFraksjon(${it.id}, this.value)">${opts}</select>
    </div>`;
  }

  const rows = it.kind === 'container' || it.kind === 'wall' ? `
    <div class="pr"><span class="pk">Type</span><span class="pv">${d.name}</span></div>
    ${it.kind === 'container' ? `
    <div class="pr"><span class="pk">SAP</span><span class="pv">${d.sap}</span></div>
    <div class="pr"><span class="pk">B×D×H</span><span class="pv">${d.W}×${d.D}×${d.H}mm</span></div>
    ${fraksjonHtml}` : ''}
    <div class="pr"><span class="pk">Rot.</span><span class="pv">${rd}°</span></div>` :
  it.kind === 'skilt' ? `
    <div class="pr"><span class="pk">Skilt</span><span class="pv">${it.def ? it.def.name : ''}</span></div>
    <div class="pr" style="flex-direction:column;align-items:flex-start;gap:4px">
      <span class="pk">Størrelse (m)</span>
      <input type="range" min="0.1" max="1.5" step="0.05" value="${it.size||0.4}"
        style="width:100%" oninput="setSkiltSize(${it.id}, +this.value)">
      <span style="font-size:10px;color:var(--muted)" id="skilt-size-lbl">${(it.size||0.4).toFixed(2)}m × ${(it.size||0.4).toFixed(2)}m</span>
    </div>
    <div class="pr"><span class="pk">Rot.</span><span class="pv">${rd}°</span></div>` : `
    <div class="pr"><span class="pk">Notat</span><span class="pv" id="dp-note-text"></span></div>`;

  p.innerHTML = rows +
    `<button class="rpb rpbg" onclick="rot90()">↻ Roter 90°</button>
     <button class="rpb rpbd" onclick="delSel()">Slett</button>`;
  // Set note text safely to avoid XSS
  if (it.kind === 'note') {
    const noteEl = p.querySelector('#dp-note-text');
    if (noteEl) noteEl.textContent = it.text || '';
  }
}

// Returns wall candidates from inner partition walls for point (x, y).
// Normals are bidirectional — always oriented toward the query point so containers
// on either side of an inner wall snap and receive signs correctly.
function innerWallCandidates(x, y) {
  const results = [];
  for (const iw of state.items.filter(i => i.kind === 'innerwall')) {
    const ax = iw.x1, ay = iw.y1, bx = iw.x2, by = iw.y2;
    const ex = bx - ax, ey = by - ay, len2 = ex*ex + ey*ey;
    if (len2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((x - ax)*ex + (y - ay)*ey) / len2));
    const wallX = ax + t*ex, wallY = ay + t*ey;
    const dist = Math.hypot(x - wallX, y - wallY);
    const len = Math.sqrt(len2);
    // Left-perpendicular, then flip toward query point
    let nx = -(ey / len), ny = ex / len;
    if (nx * (x - wallX) + ny * (y - wallY) < 0) { nx = -nx; ny = -ny; }
    results.push({ dist, wallX, wallY, nx, ny });
  }
  return results;
}

// Returns info about the nearest wall to point (x,y): { dist, wallX, wallY, nx, ny }
// Works for both rect and free mode, and includes inner partition walls.
function nearestWall(x, y) {
  let best = null;
  if (state.roomMode === 'rect') {
    const W = state.roomW, D = state.roomD;
    const sides = [
      { dist: y,     wallX: x, wallY: 0,   nx: 0,  ny: 1  }, // north
      { dist: D - y, wallX: x, wallY: D,   nx: 0,  ny: -1 }, // south
      { dist: x,     wallX: 0, wallY: y,   nx: 1,  ny: 0  }, // west
      { dist: W - x, wallX: W, wallY: y,   nx: -1, ny: 0  }, // east
    ];
    best = sides.reduce((a, b) => a.dist < b.dist ? a : b);
  } else {
    // Free mode — find closest poly segment.
    // Use winding order to determine inward normals — avoids centroid-based flipping
    // which fails for concave rooms (L/U/T-shapes) where the centroid can fall outside
    // the polygon. For a CW polygon on a Y-down canvas (shoelace > 0), the default
    // left-perpendicular (-ey, ex) already points INWARD, so sign = +1. For CCW
    // (shoelace < 0) it points outward, so we flip with sign = -1.
    const pts = state.poly;
    if (!pts || pts.length < 3) return null;
    const shoelace = pts.reduce((sum, p, i) => {
      const q = pts[(i + 1) % pts.length];
      return sum + p.x * q.y - q.x * p.y;
    }, 0);
    const sign = shoelace > 0 ? 1 : -1;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ex = b.x - a.x, ey = b.y - a.y;
      const len2 = ex*ex + ey*ey;
      if (len2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x)*ex + (y - a.y)*ey) / len2));
      const wx = a.x + t*ex, wy = a.y + t*ey;
      const dist = Math.hypot(x - wx, y - wy);
      const len = Math.sqrt(len2);
      const nx = sign * (-ey / len), ny = sign * (ex / len);
      if (!best || dist < best.dist) best = { dist, wallX: wx, wallY: wy, nx, ny };
    }
  }
  // Include inner partition walls — bidirectional, so containers on either side snap correctly
  for (const c of innerWallCandidates(x, y)) {
    if (!best || c.dist < best.dist) best = c;
  }
  return best;
}

// Scores all candidate walls against a desired direction and returns the best match.
// Each wall is scored by alignment × proximity so that a well-aligned but slightly
// farther wall beats a poorly-aligned but nearer wall — critical in corners where
// two walls are equidistant and only rotation distinguishes which one to use.
function bestWallByDirection(candidates, dirNx, dirNy, maxDist) {
  let best = null, bestScore = -Infinity;
  for (const c of candidates) {
    if (c.dist > maxDist) continue;
    const dot = c.nx * dirNx + c.ny * dirNy;
    if (dot <= 0) continue; // wall is in front of or beside container — skip
    const score = dot * (1 - c.dist / maxDist);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// Finds the wall that best matches the given direction (dirNx, dirNy) within maxDist.
// Uses bestWallByDirection() on all polygon edges or rect sides depending on roomMode.
// Unlike nearestWall(), this picks by directional alignment, not pure proximity.
// Also considers inner partition walls (bidirectional normals).
function findWallByDirection(x, y, dirNx, dirNy, maxDist) {
  let candidates = [];
  if (state.roomMode === 'rect') {
    const W = state.roomW, D = state.roomD;
    candidates = [
      { dist: y,     wallX: x, wallY: 0, nx: 0,  ny: 1  },
      { dist: D - y, wallX: x, wallY: D, nx: 0,  ny: -1 },
      { dist: x,     wallX: 0, wallY: y, nx: 1,  ny: 0  },
      { dist: W - x, wallX: W, wallY: y, nx: -1, ny: 0  },
    ];
  } else {
    const pts = state.poly;
    if (pts && pts.length >= 3) {
      const shoelace = pts.reduce((sum, p, i) => {
        const q = pts[(i + 1) % pts.length];
        return sum + p.x * q.y - q.x * p.y;
      }, 0);
      const sign = shoelace > 0 ? 1 : -1;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const ex = b.x - a.x, ey = b.y - a.y, len2 = ex*ex + ey*ey;
        if (len2 < 1e-9) continue;
        const t = Math.max(0, Math.min(1, ((x - a.x)*ex + (y - a.y)*ey) / len2));
        const wallX = a.x + t*ex, wallY = a.y + t*ey;
        const dist = Math.hypot(x - wallX, y - wallY);
        const len = Math.sqrt(len2);
        candidates.push({ dist, wallX, wallY, nx: sign * (-ey / len), ny: sign * (ex / len) });
      }
    }
  }
  // Inner partition walls contribute bidirectional candidates
  candidates.push(...innerWallCandidates(x, y));
  return bestWallByDirection(candidates, dirNx, dirNy, maxDist);
}

// Returns all walls within maxDist of (x, y) with their distance and inward normals.
// Used by updateLinkedSkiltWall() to detect corner situations (2+ walls nearby).
function allNearbyWalls(x, y, maxDist) {
  const results = [];
  if (state.roomMode === 'rect') {
    const W = state.roomW, D = state.roomD;
    const sides = [
      { dist: y,     wallX: x, wallY: 0, nx: 0,  ny: 1  },
      { dist: D - y, wallX: x, wallY: D, nx: 0,  ny: -1 },
      { dist: x,     wallX: 0, wallY: y, nx: 1,  ny: 0  },
      { dist: W - x, wallX: W, wallY: y, nx: -1, ny: 0  },
    ];
    for (const s of sides) { if (s.dist <= maxDist) results.push(s); }
    return results;
  }
  const pts = state.poly;
  if (!pts || pts.length < 3) return results;
  const shoelace = pts.reduce((sum, p, i) => {
    const q = pts[(i + 1) % pts.length];
    return sum + p.x * q.y - q.x * p.y;
  }, 0);
  const sign = shoelace > 0 ? 1 : -1;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ex = b.x - a.x, ey = b.y - a.y, len2 = ex*ex + ey*ey;
    if (len2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x)*ex + (y - a.y)*ey) / len2));
    const wallX = a.x + t*ex, wallY = a.y + t*ey;
    const dist = Math.hypot(x - wallX, y - wallY);
    if (dist > maxDist) continue;
    const len = Math.sqrt(len2);
    results.push({ dist, wallX, wallY, nx: sign * (-ey / len), ny: sign * (ex / len) });
  }
  // Include inner partition walls — bidirectional candidates within maxDist
  for (const c of innerWallCandidates(x, y)) {
    if (c.dist <= maxDist) results.push(c);
  }
  return results;
}

// Updates the linked sign's wall info based on corner detection and rotation.
// Logic:
//   - If only ONE wall is within CORNER_DIST → container is along a single wall.
//     Sign stays on that wall regardless of container rotation.
//   - If TWO or more walls are within CORNER_DIST → container is in a corner.
//     Use the back direction (derived from rotation) to pick the correct wall.
// This prevents the sign from "flying off" to a far wall when a non-corner
// container is rotated so its back faces the room interior.
const CORNER_DIST = 1.2; // metres — threshold for "is in a corner"
function updateLinkedSkiltWall(container) {
  const skilt = state.items.find(s => s.kind === 'skilt' && s._linkedTo === container.id);
  if (!skilt) return;

  const nearby = allNearbyWalls(container.x, container.y, CORNER_DIST);
  if (nearby.length === 0) return; // container not near any wall — leave sign unchanged

  let w;
  if (nearby.length >= 2) {
    // Corner: pick the wall the back of the container faces
    const rot = container.rot || 0;
    const backNx =  Math.sin(rot);
    const backNy = -Math.cos(rot);
    w = bestWallByDirection(nearby, backNx, backNy, CORNER_DIST);
    if (!w) w = nearby.reduce((a, b) => a.dist < b.dist ? a : b); // fallback to nearest
  } else {
    // Single wall nearby — always use it, ignore rotation
    w = nearby[0];
  }

  skilt._wallNx = w.nx;
  skilt._wallNy = w.ny;
  skilt._wallX  = w.wallX;
  skilt._wallY  = w.wallY;
  skilt.x = container.x;
  skilt.y = container.y;
}

function isNearAnyWall(it) {
  const w = nearestWall(it.x, it.y);
  return w && w.dist < 0.8;
}

// Snap item centre to nearest wall — works in both rect and free mode.
// SNAP_DIST is edge-based: snap fires when the item's edge is within 0.25m of the wall.
// max(hw,hd) is the half-dimension toward the wall; adding 0.25m gives a consistent
// snap reach regardless of item size — fixes Balex/Orwak which have hw > 0.5m.
function snapToWall(x, y, hw, hd) {
  const SNAP_DIST = Math.max(hw, hd) + 0.25;
  const w = nearestWall(x, y);
  if (!w || w.dist > SNAP_DIST) return { x, y };
  const offset = Math.abs(w.nx) > Math.abs(w.ny) ? hw : hd;
  return { x: w.wallX + w.nx * offset, y: w.wallY + w.ny * offset };
}

function checkAutoSkilt(it) {
  if (it.kind !== 'container') return;
  const w = nearestWall(it.x, it.y);
  if (!w || w.dist > 0.8) return;
  const fraksjonToSkilt = {
    rest: 'sk-rest', mat: 'sk-mat', papir: 'sk-papir', papp: 'sk-papp',
    plast: 'sk-plast', plastfolie: 'sk-plastfolie', glass: 'sk-glass',
    metall: 'sk-metall', eps: 'sk-eps', farlig: 'sk-farlig', ee: 'sk-ee',
  };
  const skiltId = fraksjonToSkilt[it.fraksjon || 'rest'];
  if (!skiltId) return;
  const already = state.items.find(s => s.kind === 'skilt' && s._linkedTo === it.id);
  if (already) {
    // Update position and wall info when container moves
    already.x = it.x; already.y = it.y;
    already._wallNx = w.nx; already._wallNy = w.ny;
    already._wallX  = w.wallX; already._wallY = w.wallY;
    return;
  }
  const def = SKILT_DEFS.find(s => s.id === skiltId);
  if (!def) return;
  const binH = it.def.H / 1000;
  // Sign size scales with container width: ~70% of bin width, clamped 0.25–0.65m.
  // Small bins (140L=480mm → 0.34m sign) get smaller labels so they don't dwarf the container.
  const skiltSize = Math.min(Math.max((it.def.W / 1000) * 0.70, 0.25), 0.65);
  state.items.push({
    id: state.nextId++, typeId: skiltId, kind: 'skilt',
    def, x: it.x, y: it.y, rot: 0, size: skiltSize,
    wallH: binH + 0.4, wallOffset: 0,
    _linkedTo: it.id,
    _wallNx: w.nx, _wallNy: w.ny,
    _wallX: w.wallX, _wallY: w.wallY,
  });
  render();
}

function setFraksjon(id, fraksjon) {
  const it = state.items.find(i => i.id === id);
  if (!it) return;
  it.fraksjon = fraksjon;

  // Update or create nearby skilt
  if (it.kind === 'container') {
    const nearWall = isNearAnyWall(it);
    const fraksjonToSkilt = {
      rest: 'sk-rest', mat: 'sk-mat', papir: 'sk-papir', papp: 'sk-papp',
      plast: 'sk-plast', plastfolie: 'sk-plastfolie', glass: 'sk-glass',
      metall: 'sk-metall', eps: 'sk-eps', farlig: 'sk-farlig', ee: 'sk-ee',
    };
    const skiltId = fraksjonToSkilt[fraksjon];
    // Use _linkedTo (not proximity) so we always update the correct skilt when
    // multiple containers with the same fraksjon are placed close together.
    // Proximity-based find() returns the first skilt within range regardless of
    // which container owns it — this broke sign updates beyond ~3 equal fraksjoner.
    const existing = state.items.find(s =>
      s.kind === 'skilt' && s._linkedTo === it.id
    );
    if (existing && skiltId) {
      const def = SKILT_DEFS.find(s => s.id === skiltId);
      if (def) { existing.typeId = skiltId; existing.def = def; }
    } else if (!existing && nearWall && skiltId) {
      checkAutoSkilt(it);
    }
  }

  render();
  if (state.view === '3d' && scene3d._initialized) scene3d.rebuild();
}

function setSkiltSize(id, size) {
  const it = state.items.find(i => i.id === id); if (!it) return;
  it.size = size;
  const lbl = document.getElementById('skilt-size-lbl');
  if (lbl) lbl.textContent = `${size.toFixed(2)}m × ${size.toFixed(2)}m`;
  render();
}

function setInfo(t) { document.getElementById('ib').innerHTML = t; }

// ── In-app dialog (replaces browser confirm/alert) ────────────────────────
let _dialogCb = null;
function dialogResolve(yes) {
  const inp = document.getElementById('dialogInput');
  const val = inp.value;
  inp.style.display = 'none'; inp.value = '';
  document.getElementById('dialogModal').classList.remove('open');
  const cb = _dialogCb; _dialogCb = null;
  if (cb) cb(yes, val);
}
function showConfirm(msg, onYes, { icon = '⚠️', yesLabel = 'OK', danger = true } = {}) {
  document.getElementById('dialogIcon').textContent = icon;
  document.getElementById('dialogMsg').textContent = msg;
  const okBtn = document.getElementById('dialogOk');
  okBtn.textContent = yesLabel;
  okBtn.className = 'btn' + (danger ? ' btn-danger danger' : ' btn-ng');
  document.getElementById('dialogCancel').style.display = '';
  document.getElementById('dialogInput').style.display = 'none';
  _dialogCb = yes => { if (yes) onYes(); };
  document.getElementById('dialogModal').classList.add('open');
}
function showAlert(msg, { icon = 'ℹ️' } = {}) {
  document.getElementById('dialogIcon').textContent = icon;
  document.getElementById('dialogMsg').textContent = msg;
  const okBtn = document.getElementById('dialogOk');
  okBtn.textContent = 'OK'; okBtn.className = 'btn btn-ng';
  document.getElementById('dialogCancel').style.display = 'none';
  document.getElementById('dialogInput').style.display = 'none';
  _dialogCb = null;
  document.getElementById('dialogModal').classList.add('open');
}
function showPrompt(msg, defaultVal, onConfirm, { icon = '✏️', yesLabel = 'Lagre' } = {}) {
  document.getElementById('dialogIcon').textContent = icon;
  document.getElementById('dialogMsg').textContent = msg;
  const okBtn = document.getElementById('dialogOk');
  okBtn.textContent = yesLabel; okBtn.className = 'btn btn-ng';
  document.getElementById('dialogCancel').style.display = '';
  const inp = document.getElementById('dialogInput');
  inp.style.display = 'block'; inp.value = defaultVal || '';
  _dialogCb = (yes, val) => { if (yes && val && val.trim()) onConfirm(val.trim()); };
  document.getElementById('dialogModal').classList.add('open');
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
}

// ── Multi-room management ────────────────────────────────────────────────
function switchRoom(idx) {
  if (idx === state.activeRoom) return;
  state.rooms[state.activeRoom].data = toJSON();
  state.activeRoom = idx;
  state.sel = null;
  const room = state.rooms[idx];
  fromJSON(room.data || { roomMode: 'free', poly: [], polyDone: false, items: [] });
  document.getElementById('rW').value = state.roomW;
  document.getElementById('rD').value = state.roomD;
  document.getElementById('rHF').value = state.roomH;
  showCancelBtn(state.polyDraw && !state.polyDone);
  calcPPM(); setRoomMode(state.roomMode); updateDP();
  renderRoomTabs();
}

function addRoom() {
  state.rooms[state.activeRoom].data = toJSON();
  const n = state.rooms.length + 1;
  state.rooms.push({ id: 'room-' + Date.now(), name: 'Rom ' + n, data: null });
  if (state.view === '3d') setView('2d');
  switchRoom(state.rooms.length - 1);
}

function deleteRoom(idx) {
  if (state.rooms.length <= 1) { toast('Kan ikke slette siste rom'); return; }
  const roomName = state.rooms[idx].name;
  showConfirm(`Slett rommet «${roomName}»?\nDette kan ikke angres.`, () => {
    state.rooms.splice(idx, 1);
    const newIdx = Math.min(idx < state.activeRoom ? state.activeRoom - 1 : Math.min(state.activeRoom, state.rooms.length - 1), state.rooms.length - 1);
    state.activeRoom = -1;
    state.activeRoom = newIdx;
    state.sel = null;
    const room = state.rooms[newIdx];
    fromJSON(room.data || { roomMode: 'free', poly: [], polyDone: false, items: [] });
    document.getElementById('rW').value = state.roomW;
    document.getElementById('rD').value = state.roomD;
    document.getElementById('rHF').value = state.roomH;
    calcPPM(); setRoomMode(state.roomMode); updateDP();
    renderRoomTabs();
  }, { icon: '🗑️', yesLabel: 'Slett rom' });
}

function renameRoom(idx) {
  showPrompt('Nytt navn på rommet:', state.rooms[idx].name, name => {
    state.rooms[idx].name = name;
    renderRoomTabs();
    scheduleAutosave();
  }, { icon: '✏️', yesLabel: 'Lagre' });
}

function renderRoomTabs() {
  const bar = document.getElementById('room-tabs');
  if (!bar) return;
  bar.innerHTML = '';
  state.rooms.forEach((r, i) => {
    const tab = document.createElement('button');
    tab.className = 'room-tab' + (i === state.activeRoom ? ' act' : '');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = r.name;
    tab.appendChild(nameSpan);
    tab.onclick = () => switchRoom(i);
    tab.ondblclick = () => renameRoom(i);
    if (state.rooms.length > 1) {
      const del = document.createElement('span');
      del.className = 'room-tab-del';
      del.textContent = '×';
      del.onclick = e => { e.stopPropagation(); deleteRoom(i); };
      tab.appendChild(del);
    }
    bar.appendChild(tab);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'room-tab-add';
  addBtn.textContent = '+ Rom';
  addBtn.onclick = addRoom;
  bar.appendChild(addBtn);
  renderRoomList();
}

function renderRoomList() {
  const el = document.getElementById('room-list-items');
  if (!el) return;
  el.innerHTML = '';
  state.rooms.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'room-list-item' + (i === state.activeRoom ? ' act' : '');

    const dot = document.createElement('span');
    dot.className = 'room-list-dot';
    row.appendChild(dot);

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = r.name;
    inp.className = 'room-list-name';
    inp.onclick = () => { if (i !== state.activeRoom) switchRoom(i); };
    inp.onblur = () => {
      const v = inp.value.trim();
      if (v && v !== r.name) { r.name = v; renderRoomTabs(); scheduleAutosave(); }
      else inp.value = r.name;
    };
    inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = r.name; inp.blur(); } };
    row.appendChild(inp);

    if (state.rooms.length > 1) {
      const del = document.createElement('button');
      del.className = 'btn-icon danger';
      del.textContent = '✕';
      del.title = 'Slett rom';
      del.onclick = () => deleteRoom(i);
      row.appendChild(del);
    }
    el.appendChild(row);
  });
}

// ── Save / Load ──────────────────────────────────────────────────────────
function openSaveModal() {
  document.getElementById('saveName').value = state.sketchName;
  document.getElementById('saveCustomer').value = state.customer;
  document.getElementById('saveModal').classList.add('open');
}
function closeSaveModal() { document.getElementById('saveModal').classList.remove('open'); }

async function saveSketch() {
  const name = document.getElementById('saveName').value.trim() || 'Uten navn';
  const customer = document.getElementById('saveCustomer').value.trim();
  state.sketchName = name; state.customer = customer;
  document.getElementById('sketchLabel').textContent = name;
  const data = toSketchJSON();
  const thumb = document.getElementById('canvas-2d').toDataURL('image/png', 0.4);
  if (state.sketchId) {
    await api.update(state.sketchId, { name, customer, data, thumbnail: thumb });
  } else {
    const res = await api.create(name, customer, data, thumb);
    state.sketchId = res.id;
  }
  closeSaveModal();
  autosave();
  toast('Lagret ✓');
}

async function loadSavedList() {
  const list = document.getElementById('sk-list');
  const sketches = await api.list();
  if (sketches.length === 0) { list.innerHTML = '<div class="sk-empty">Ingen lagrede skisser</div>'; return; }
  list.innerHTML = '';
  sketches.forEach(s => {
    const div = document.createElement('div'); div.className = 'sk-item';
    const date = s.updated_at ? s.updated_at.slice(0, 10) : '';

    const nameDiv = document.createElement('div'); nameDiv.className = 'sk-item-name';
    nameDiv.textContent = s.name;

    const metaDiv = document.createElement('div'); metaDiv.className = 'sk-item-meta';
    metaDiv.textContent = (s.customer || '—') + ' · ' + date;

    const actionsDiv = document.createElement('div'); actionsDiv.className = 'sk-item-actions';
    const loadBtn = document.createElement('button'); loadBtn.className = 'btn btn-ng btn-sm';
    loadBtn.textContent = 'Åpne'; loadBtn.onclick = () => loadSketch(s.id);
    const delBtn = document.createElement('button'); delBtn.className = 'btn btn-gh btn-sm';
    delBtn.textContent = 'Slett'; delBtn.onclick = function() { deleteSketch(s.id, this); };
    actionsDiv.appendChild(loadBtn); actionsDiv.appendChild(delBtn);

    div.appendChild(nameDiv); div.appendChild(metaDiv); div.appendChild(actionsDiv);
    list.appendChild(div);
  });
}

async function loadSketch(id) {
  const sk = await api.get(id);
  fromSketchJSON(sk.data);
  state.sketchId = sk.id; state.sketchName = sk.name; state.customer = sk.customer;
  document.getElementById('sketchLabel').textContent = sk.name;
  if (state.roomMode === 'rect') {
    document.getElementById('rW').value = state.roomW;
    document.getElementById('rD').value = state.roomD;
    document.getElementById('rH').value = state.roomH;
  }
  calcPPM(); updateDP(); render();
  renderRoomTabs();
  autosave();
  toast('Lastet: ' + sk.name);
}

async function deleteSketch(id, btn) {
  await api.delete(id);
  btn.closest('.sk-item').remove();
  toast('Slettet');
}

// ── PDF Export ────────────────────────────────────────────────────────────
function exportPDF() {
  document.getElementById('pdfCustomer').value = state.customer;
  document.getElementById('pdfModal').classList.add('open');
}

function setToday() {
  const d = new Date(); const s = d.toISOString().slice(0, 10);
  document.getElementById('pdfDate').value = s;
}

// Composites Cloudflare R2 fraksjon icons (same PNGs used for wall signs) onto the
// captured top-down 3D image. Called only during PDF export — zero impact on live views.
// Icons are loaded via the local /r2/ proxy (same path as GLB models) so that the canvas
// is never cross-origin tainted — toDataURL() requires same-origin pixel access.
async function overlayFraksjonIcons({ dataUrl, cx, cz, hw2, hh }) {
  const W = 1200, H = 800;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Draw 3D scene as background
  const bg = await new Promise(res => {
    const img = new Image(); img.onload = () => res(img); img.src = dataUrl;
  });
  ctx.drawImage(bg, 0, 0);

  // Room metres → image pixels.
  // Camera up=(0,0,-1): lower Z maps to top of image, so py increases with wz.
  const toPixel = (wx, wz) => ({
    px: ((wx - cx) / hw2 + 1) / 2 * W,
    py: (wz - (cz - hh)) / (2 * hh) * H,
  });

  // Collect containers that have a fraksjon (machines have baked textures — skip them)
  const containers = state.items.filter(it =>
    it.kind === 'container' && it.fraksjon && it.def.type !== 'machine'
  );

  // Pre-load each unique fraksjon icon via /r2/ proxy — no crossOrigin needed because
  // the proxy serves from the same origin, so the canvas stays untainted for toDataURL().
  const iconCache = {};
  await Promise.all([...new Set(containers.map(it => it.fraksjon))].map(frakId => {
    const skilt = SKILT_DEFS.find(s => s.id === 'sk-' + frakId);
    if (!skilt) return Promise.resolve();
    // Extract filename from R2 URL and route through local proxy (same pattern as GLBs)
    const filename = skilt.url.split('/').pop();
    return new Promise(res => {
      const img = new Image();
      img.onload  = () => { iconCache[frakId] = img; res(); };
      img.onerror = res; // skip silently if icon is unavailable
      img.src = '/r2/' + filename;
    });
  }));

  // Draw icon centered on each container position
  for (const it of containers) {
    const icon = iconCache[it.fraksjon];
    if (!icon) continue;
    const { px, py } = toPixel(it.x, it.y);
    // Size: smaller of pixel-width / pixel-depth × 0.80, clamped 28–80px
    const cPxW = (it.def.W / 1000) / (2 * hw2) * W;
    const cPxD = (it.def.D / 1000) / (2 * hh) * H;
    const size = Math.min(Math.max(Math.min(cPxW, cPxD) * 0.80, 28), 80);
    const r = size / 2;
    // Thin white border so icons pop off the dark container body
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(px - r - 2, py - r - 2, size + 4, size + 4);
    // Crop source: full width, top 75% of height — removes the text label row
    // that the R2 PNGs include at the bottom, keeping only the coloured icon graphic.
    ctx.drawImage(icon, 0, 0, icon.naturalWidth, icon.naturalHeight * 0.75,
                  px - r, py - r, size, size);
  }

  return canvas.toDataURL('image/png');
}

async function generatePDF() {
  const { jsPDF } = window.jspdf;
  const customer = document.getElementById('pdfCustomer').value || '—';
  const location = document.getElementById('pdfLocation').value || '—';
  const seller   = document.getElementById('pdfSeller').value || '';
  const date = document.getElementById('pdfDate').value || new Date().toISOString().slice(0, 10);
  const dateNO = date ? date.split('-').reverse().join('.') : new Date().toLocaleDateString('nb-NO');
  const roomName = state.rooms[state.activeRoom]?.name || '';

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const PW = 297, PH = 210;
  const NG = [232, 82, 26], DARK = [30, 26, 24], MUTED = [120, 115, 110], LIGHT = [245, 243, 240], WHITE = [255,255,255];

  // ── SIDE 1: Romtegning ────────────────────────────────────────────────────

  // Header
  doc.setFillColor(...NG);
  doc.rect(0, 0, PW, 16, 'F');
  doc.setTextColor(...WHITE);
  doc.setFontSize(11); doc.setFont('helvetica', 'bold');
  doc.text('Norsk Gjenvinning', 10, 11);
  doc.setFontSize(8); doc.setFont('helvetica', 'normal');
  doc.text('Romskisse – Avfallsløsning', 62, 11);
  if (roomName) doc.text(`· ${roomName}`, 103, 11);
  // Right side of header — customer, location, seller, date
  doc.setFontSize(8);
  doc.text(`${customer}  ·  ${location}`, PW - 10, 7, { align: 'right' });
  const sellerLine = seller ? `Selger: ${seller}  ·  ${dateNO}` : dateNO;
  doc.text(sellerLine, PW - 10, 12, { align: 'right' });

  // Room map image — 3D orthographic top-down render.
  // init() + rebuildSync() ensure the scene is current even if user never opened 3D view.
  // Icon overlay (overlayFraksjonIcons) is disabled — coordinate mapping breaks on
  // large/irregular rooms. Revisit with a better approach.
  if (!scene3d._initialized) scene3d.init();
  // Ensure all GLB models for current items are in glbCache before rebuilding.
  // glbCache hits are synchronous, so rebuildSync() can use real GLB models
  // rather than plain box fallbacks — giving a proper 3D top-down PDF image.
  await new Promise(resolve => scene3d.preloadItemGLBs(resolve));
  scene3d.rebuildSync();
  const captured = scene3d.captureTopDown(); // { dataUrl, cx, cz, hw2, hh } or null
  // Restore real GLB scene after rebuildSync() snapshot
  scene3d.markDirty();
  let imgData;
  if (captured) {
    imgData = captured.dataUrl;
  } else {
    // Fallback: clean 2D snapshot if 3D renderer failed (e.g. very small viewport)
    const canvas = document.getElementById('canvas-2d');
    const savedPpm = state.ppm, savedZoom = state.zoom, savedPanX = state.panX, savedPanY = state.panY;
    calcPPM(); state.panX = 0; state.panY = 0;
    state._pdfExporting = true; render2D();
    imgData = canvas.toDataURL('image/png');
    state._pdfExporting = false;
    state.ppm = savedPpm; state.zoom = savedZoom; state.panX = savedPanX; state.panY = savedPanY;
    render2D();
  }
  const tableW = 68;
  const mapX = 8, mapY = 20, mapW = PW - tableW - 18, mapH = PH - 30;
  doc.addImage(imgData, 'PNG', mapX, mapY, mapW, mapH);
  // Border around map
  doc.setDrawColor(210, 205, 200); doc.setLineWidth(0.3);
  doc.rect(mapX, mapY, mapW, mapH);

  // ── Right panel: stykkliste ───────────────────────────────────────────────
  const containers = state.items.filter(i => i.kind === 'container');
  const tx = mapX + mapW + 6, ty = mapY;

  // Panel background
  doc.setFillColor(...LIGHT);
  doc.rect(tx - 2, ty, tableW, mapH, 'F');

  // Panel header — 10mm tall matches page 2 table header height
  doc.setFillColor(...DARK);
  doc.rect(tx - 2, ty, tableW, 10, 'F');
  doc.setTextColor(...WHITE); doc.setFontSize(7.5); doc.setFont('helvetica', 'bold');
  doc.text('STYKKLISTE', tx + tableW/2 - 2, ty + 6.5, { align: 'center' });

  // Group by type + fraksjon
  const grouped = {};
  containers.forEach(it => {
    const key = it.def.name + '|' + (it.fraksjon || 'rest');
    if (!grouped[key]) grouped[key] = { def: it.def, fraksjon: it.fraksjon || 'rest', count: 0 };
    grouped[key].count++;
  });

  let row = 0;
  const rowH = 9, startY = ty + 14;
  doc.setFontSize(7); doc.setFont('helvetica', 'normal');

  Object.values(grouped).forEach((g, idx) => {
    const ry = startY + row * rowH;
    if (ry + rowH > ty + mapH - 4) return; // clip if too many rows

    // Alternating row bg
    if (idx % 2 === 0) {
      doc.setFillColor(238, 235, 232);
      doc.rect(tx - 2, ry - 5, tableW, rowH, 'F');
    }

    const fr = getFraksjon(g.fraksjon);
    const [r, gC, b] = hexToRgb(fr.color);

    // Fraksjon color dot
    doc.setFillColor(r, gC, b);
    doc.circle(tx + 2, ry - 1, 2, 'F');

    doc.setTextColor(...DARK); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5);
    doc.text(`${g.count}×  ${g.def.name}`, tx + 7, ry);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...MUTED);
    doc.text(fr.label, tx + 7, ry + 3.5);
    if (g.def.sap) doc.text(`SAP: ${g.def.sap}`, tx + tableW - 5, ry, { align: 'right' });
    row++;
  });

  // Total
  const totalY = startY + row * rowH + 2;
  if (totalY < ty + mapH - 6) {
    doc.setDrawColor(...MUTED); doc.setLineWidth(0.2);
    doc.line(tx, totalY - 2, tx + tableW - 4, totalY - 2);
    doc.setTextColor(...DARK); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5);
    doc.text(`Totalt: ${containers.length} beholdere`, tx, totalY + 3);
  }

  // Room dimensions (if free mode + polyDone)
  if (state.roomMode === 'free' && state.polyDone && state.poly.length > 2) {
    const xs = state.poly.map(p => p.x), ys = state.poly.map(p => p.y);
    const rW = (Math.max(...xs) - Math.min(...xs)).toFixed(1);
    const rD = (Math.max(...ys) - Math.min(...ys)).toFixed(1);
    const dimY = ty + mapH - 14;
    doc.setFillColor(255, 248, 240);
    doc.rect(tx - 2, dimY, tableW, 13, 'F');
    doc.setTextColor(...MUTED); doc.setFontSize(6.5); doc.setFont('helvetica', 'bold');
    doc.text('ROMSTØRRELSE', tx, dimY + 5);
    doc.setTextColor(...DARK); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
    doc.text(`ca. ${rW} × ${rD} m`, tx, dimY + 10);
  }

  // Footer
  doc.setFillColor(...LIGHT);
  doc.rect(0, PH - 8, PW, 8, 'F');
  doc.setDrawColor(210, 205, 200); doc.line(0, PH - 8, PW, PH - 8);
  doc.setTextColor(...MUTED); doc.setFontSize(6.5); doc.setFont('helvetica', 'normal');
  doc.text('Norsk Gjenvinning AS  ·  norskgjenvinning.no', 10, PH - 3);
  doc.text(`Side 1 av 2  ·  Generert ${new Date().toLocaleDateString('nb-NO')}`, PW - 10, PH - 3, { align: 'right' });

  // ── SIDE 2: Komplett stykkliste ───────────────────────────────────────────
  doc.addPage();

  // Header
  doc.setFillColor(...NG);
  doc.rect(0, 0, PW, 16, 'F');
  doc.setTextColor(...WHITE);
  doc.setFontSize(11); doc.setFont('helvetica', 'bold');
  doc.text('Norsk Gjenvinning', 10, 11);
  doc.setFontSize(8); doc.setFont('helvetica', 'normal');
  doc.text('Stykkliste og avfallsoversikt', 62, 11);
  if (roomName) doc.text(`· ${roomName}`, 120, 11);
  doc.text(`${customer}  ·  ${location}`, PW - 10, 7, { align: 'right' });
  doc.text(sellerLine, PW - 10, 12, { align: 'right' });

  // Table header — 10mm tall so text has clear vertical padding on both sides
  const cols = { nr: 10, type: 22, fraksjon: 80, sap: 148, dim: 192, antall: 248 };
  const tY = 24;
  const HDR_H = 10;
  doc.setFillColor(...DARK);
  doc.rect(8, tY, PW - 16, HDR_H, 'F');
  doc.setTextColor(...WHITE); doc.setFontSize(7); doc.setFont('helvetica', 'bold');
  doc.text('#',           cols.nr,      tY + 6.5);
  doc.text('Beholder',   cols.type,     tY + 6.5);
  doc.text('Fraksjon',   cols.fraksjon, tY + 6.5);
  doc.text('SAP-nr',     cols.sap,      tY + 6.5);
  doc.text('B×D×H (mm)', cols.dim,      tY + 6.5);
  doc.text('Ant.',        cols.antall,   tY + 6.5);

  // Group by type + fraksjon with quantity — reuses the same grouped object from page 1.
  // One row per unique combination rather than one row per individual container,
  // so 10× 240L Matavfall = 1 row with Ant.=10. Much more readable for a customer offer.
  const groupedRows = Object.values(grouped).sort((a, b) => a.def.name.localeCompare(b.def.name));
  let r2 = 0;
  groupedRows.forEach((g, idx) => {
    const ry2 = tY + HDR_H + 2 + r2 * 8;
    if (ry2 > PH - 16) return;
    if (r2 % 2 === 0) { doc.setFillColor(...LIGHT); doc.rect(8, ry2 - 5, PW - 16, 8, 'F'); }

    const fr = getFraksjon(g.fraksjon);
    const [r, gC, b] = hexToRgb(fr.color);
    doc.setFillColor(r, gC, b);
    doc.circle(cols.nr + 2, ry2 - 0.5, 2, 'F');

    doc.setTextColor(...DARK); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
    doc.text(String(idx + 1),                           cols.nr + 6,   ry2);
    doc.text(g.def.name,                                cols.type,     ry2);
    doc.text(fr.label,                                  cols.fraksjon, ry2);
    doc.text(g.def.sap || '—',                          cols.sap,      ry2);
    doc.text(`${g.def.W}×${g.def.D}×${g.def.H}`,       cols.dim,      ry2);
    doc.setFont('helvetica', 'bold');
    doc.text(String(g.count),                           cols.antall,   ry2);
    r2++;
  });

  // Summary box
  const sumY = tY + HDR_H + 2 + r2 * 8 + 6;
  if (sumY < PH - 20) {
    doc.setFillColor(255, 248, 240);
    doc.setDrawColor(...NG); doc.setLineWidth(0.4);
    doc.rect(8, sumY, 120, 18, 'FD');
    doc.setTextColor(...DARK); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.text('Oppsummering', 13, sumY + 7);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
    doc.text(`${containers.length} beholdere totalt  ·  ${groupedRows.length} ulike typer/fraksjoner`, 13, sumY + 13);
  }

  // Footer side 2
  doc.setFillColor(...LIGHT);
  doc.rect(0, PH - 8, PW, 8, 'F');
  doc.setDrawColor(210, 205, 200); doc.line(0, PH - 8, PW, PH - 8);
  doc.setTextColor(...MUTED); doc.setFontSize(6.5); doc.setFont('helvetica', 'normal');
  doc.text('Norsk Gjenvinning AS  ·  norskgjenvinning.no', 10, PH - 3);
  doc.text(`Side 2 av 2  ·  Generert ${new Date().toLocaleDateString('nb-NO')}`, PW - 10, PH - 3, { align: 'right' });

  document.getElementById('pdfModal').classList.remove('open');
  doc.save(`romskisse-${customer.replace(/\s+/g, '-')}-${date}.pdf`);
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return [r, g, b];
}

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}
