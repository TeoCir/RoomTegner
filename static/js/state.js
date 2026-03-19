const state = {
  view: '2d',
  tool: 'move',
  roomMode: 'free',
  roomW: 6, roomD: 4, roomH: 2.8,
  // Wall-builder mode (replaces freehand)
  poly: [], polyDone: false, polyDraw: false,
  polyOriginX: null, polyOriginY: null,
  items: [],
  nextId: 1,
  sel: null,
  ppm: 80,
  zoom: 1.0,           // zoom multiplier (scroll wheel)
  panX: 0, panY: 0,
  sketchId: null,
  sketchName: 'Ny skisse',
  customer: '',
  drag: null, dox: 0, doy: 0,
  rotat: null, rsa: 0, rsi: 0,
  pendingSkilt: null,
  hoverPoly: null,
  shiftDown: false,
  spaceDown: false,
  panning: false, panSX: 0, panSY: 0, panOX: 0, panOY: 0,
  _pdfExporting: false, // true only during PDF canvas snapshot — suppresses UI overlays
  // Multi-room support
  rooms: [{ id: 'room-1', name: 'Rom 1', data: null }],
  activeRoom: 0,
};

function getO() {
  const c = document.getElementById('canvas-2d');
  const dpr = window.devicePixelRatio || 1;
  const W = c.width / dpr, H = c.height / dpr;
  const ppm = state.ppm * state.zoom;
  if (state.roomMode === 'rect') {
    return {
      ox: (W - state.roomW * ppm) / 2 + state.panX,
      oy: (H - state.roomD * ppm) / 2 + state.panY,
    };
  }
  // Wall-builder / free mode
  if (!state.polyDone || state.poly.length === 0) {
    return { ox: state.polyOriginX || W/2, oy: state.polyOriginY || H/2 };
  }
  const xs = state.poly.map(p => p.x), ys = state.poly.map(p => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX, spanY = Math.max(...ys) - minY;
  return {
    ox: (W - spanX * ppm) / 2 - minX * ppm + state.panX,
    oy: (H - spanY * ppm) / 2 - minY * ppm + state.panY,
  };
}

// Returns pixels-per-metre accounting for zoom
function getPPM() { return state.ppm * state.zoom; }

function calcPPM() {
  const w = document.getElementById('cw');
  const aW = w.clientWidth - 80, aH = w.clientHeight - 100;
  if (state.roomMode === 'rect') {
    state.ppm = Math.min(aW / state.roomW, aH / state.roomD, 150);
  } else if (state.polyDone && state.poly.length > 2) {
    const xs = state.poly.map(p => p.x), ys = state.poly.map(p => p.y);
    const sx = Math.max(...xs) - Math.min(...xs), sy = Math.max(...ys) - Math.min(...ys);
    state.ppm = Math.min(aW / Math.max(sx,.1), aH / Math.max(sy,.1), 150);
  }
  state.zoom = 1.0;
  document.getElementById('rbar').style.width = getPPM() + 'px';
}

// ── Single-room serialisation (used internally) ────────────────────────────
function toJSON() {
  return {
    roomMode: state.roomMode, roomW: state.roomW, roomD: state.roomD, roomH: state.roomH,
    poly: state.poly, polyDone: state.polyDone, polyDraw: state.polyDraw,
    items: state.items.map(it => ({
      id: it.id, typeId: it.typeId, kind: it.kind,
      x: it.x, y: it.y, rot: it.rot, fraksjon: it.fraksjon || 'rest',
      text: it.text || null, wallSide: it.wallSide || null,
      size: it.size || null, wallH: it.wallH || null, wallOffset: it.wallOffset || null,
      _linkedTo: it._linkedTo || null,
      _wallNx: it._wallNx ?? null, _wallNy: it._wallNy ?? null,
      _wallX:  it._wallX  ?? null, _wallY:  it._wallY  ?? null,
    }))
  };
}

function fromJSON(d) {
  state.roomMode = d.roomMode || 'free';
  state.roomW = d.roomW || 6; state.roomD = d.roomD || 4; state.roomH = d.roomH || 2.8;
  state.poly = d.poly || []; state.polyDone = d.polyDone || false;
  state.polyDraw = d.polyDraw || false;
  state.items = (d.items || []).map(it => {
    let def = null;
    if (it.kind === 'container') def = DEFS.find(x => x.id === it.typeId);
    else if (it.kind === 'wall') def = WALL_EL_DEFS[it.typeId];
    else if (it.kind === 'skilt') def = SKILT_DEFS.find(x => x.id === it.typeId);
    return { ...it, def, fraksjon: it.fraksjon || 'rest' };
  });
  state.nextId = state.items.reduce((m, i) => Math.max(m, i.id + 1), 1);
  calcPPM();
}

// ── Multi-room / building serialisation ───────────────────────────────────
function toSketchJSON() {
  const rooms = state.rooms.map((r, i) => ({
    id: r.id,
    name: r.name,
    data: i === state.activeRoom ? toJSON() : (r.data || { roomMode: 'free', poly: [], polyDone: false, items: [] })
  }));
  return { version: 2, rooms, activeRoom: state.activeRoom };
}

function fromSketchJSON(d) {
  // Legacy single-room format (no rooms array)
  if (!d.rooms) {
    state.rooms = [{ id: 'room-1', name: 'Rom 1', data: d }];
    state.activeRoom = 0;
    fromJSON(d);
    return;
  }
  state.rooms = d.rooms;
  state.activeRoom = Math.min(d.activeRoom || 0, d.rooms.length - 1);
  const room = state.rooms[state.activeRoom];
  fromJSON(room.data || { roomMode: 'free', poly: [], polyDone: false, items: [] });
}

// ── localStorage auto-save ─────────────────────────────────────────────────
const AUTOSAVE_KEY = 'roomtegner_draft';
let _autosaveTimer = null;

function scheduleAutosave() {
  clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(autosave, 800);
}

function autosave() {
  try {
    const d = toSketchJSON();
    d.sketchName = state.sketchName;
    d.customer = state.customer;
    d.sketchId = state.sketchId;
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(d));
  } catch(e) {}
}

function clearAutosave() {
  localStorage.removeItem(AUTOSAVE_KEY);
}
