# TEO Room Planner — Project Context

## What is this?
A web-based room planner for Norsk Gjenvinning (NG) where salespeople can draw waste rooms, place containers, and export a PDF quote for customers.

## Stack
- **Backend:** FastAPI + PostgreSQL (`app.py`), served via uvicorn
- **Frontend:** Vanilla JS, HTML, CSS — no bundler/framework
- **3D:** Three.js r128 with GLB models from Cloudflare R2
- **Deploy:** Render.com (`uvicorn app:app --host 0.0.0.0 --port $PORT`)

## File Structure
```
app.py                  ← FastAPI REST API + PostgreSQL + /r2/ proxy for Cloudflare R2
static/
  index.html
  css/style.css
  fonts/                ← Self-hosted fonts (served statically)
  js/
    data.js             ← DEFS, WALL_EL_DEFS, FRAKSJONER, SKILT_DEFS
    state.js            ← state object, getO(), getPPM(), calcPPM(), toJSON/fromJSON
    render2d.js         ← Canvas 2D renderer
    render3d.js         ← Three.js 3D, GLB-loader, buildSkilt3D, captureTopDown
    app.js              ← Events, UI, drag/rotate, poly-drawing, PDF export
    api.js              ← Save/load sketches to/from backend
    GLTFLoader.js
    three.min.js        ← Bundled Three.js r128
    jspdf.umd.min.js    ← Bundled jsPDF
```

## Coordinate System
- **Canvas 2D:** X right, Y down (standard canvas). Units = meters.
- **Three.js 3D:** canvas X → Three.js X, canvas Y → Three.js Z. Y is up.
- `getO()` returns `{ox, oy}` — pixel origin of the room on the canvas
- `getPPM()` — pixels per meter (including zoom)

## Room Shapes
- `state.roomMode = 'free'` (freehand, default) or `'rect'` (rectangle for testing)
- Freehand: points in `state.poly[]`, closed when `state.polyDone = true`
- `nearestWall(x, y)` → `{dist, wallX, wallY, nx, ny}` — works in both modes
- Inward normals: point into the room from the wall

## Containers and Signs
- Container snaps to wall during drag (`snapToWall`). Snap is edge-based: fires when the item's edge is within 0.25m of the wall (`SNAP_DIST = Math.max(hw, hd) + 0.25`). Not a fixed 0.5m threshold.
- On mouseup: `checkAutoSkilt(container)` → automatically adds a sorting sign if within 0.8m of a wall
- Sign size scales with container width: ~70% of bin width, clamped 0.25–0.65m
- Signs store `_wallNx/Ny/X/Y` for 3D placement
- Signs follow their container during drag (`_linkedTo: container.id`)

## Item Kinds
Every object in `state.items` has a `kind` field:
- `'container'` — Waste bin (140L–1000L, etc.)
- `'cage'` — EE-avfall cage / rollcage
- `'machine'` — Industrial equipment (Orwak, EnviroPac, APS800, etc.)
- `'compactor'` — Compactor machines (Balex, Orwak)
- `'wall'` — Wall element: door, door-double, window, pillar, exit
- `'skilt'` — Sorting sign (sortere.no PNG icon on white frame)
- `'note'` — Sticky note (yellow rect with text)
- `'exit'` — Emergency exit marker (green sign)
- `'innerwall'` — Interior partition wall drawn with the inner wall tool

## Keyboard Shortcuts
| Key | Action |
|-----|--------|
| Ctrl+Z | Undo: pop last poly point while drawing, or delete last placed item |
| Delete / Backspace | Delete selected item |
| R | Rotate selected item 90° |
| Escape | Cancel active action (poly/container/sign/innerwall), or deselect |
| Shift | Lock poly segment to 0° or 90° while drawing |
| Space | Hold to pan (grab-cursor mode) |
| Arrow keys (2D) | Trigger precise segment-length input while drawing poly |
| Arrow keys (3D) | Strafe / pan camera |
| +/- (3D) | Zoom in / out |

## State (important fields)
```js
state.view            // '2d' | '3d'
state.tool            // 'move' | etc.
state.roomMode        // 'free' | 'rect'
state.poly            // [{x,y}] — room corners in meters
state.polyDone        // true when room is closed
state.polyDraw        // true while drawing
state.items           // all objects: container | wall | skilt | note | exit
state.sel             // id of selected object
state.drag            // object being dragged (null if none)
state.rotat           // object being rotated (null if none)
state.pendingSkilt    // {id, def} — sign waiting for a container click
state.zoom / panX/Y   // camera
state.sketchId        // null or backend sketch ID
state.sketchName      // display name ('Ny skisse' default)
state.customer        // customer name for PDF
state.rooms           // [{id, name, data}] — multi-room array
state.activeRoom      // index into state.rooms
state._pdfExporting   // true only during PDF snapshot — suppresses UI overlays
state.readOnly        // true in share-link mode — blocks all edits, applyReadOnly() hides UI
state.nextId          // auto-increment counter; assigned to each new item; recalculated on fromJSON
state.innerWallStart  // {x, y} | null — start point while drawing an inner partition wall
state.innerWallHover  // {x, y} | null — current cursor target for innerwall preview line
```

## External Resources
All Cloudflare R2 assets are served through the local `/r2/<filename>` proxy in `app.py` — never fetched directly from R2 by the browser. This avoids CORS issues and keeps `canvas.toDataURL()` usable for PDF export.

- **R2 base:** `https://pub-27fd45166dba4be8a488b48df57742df.r2.dev/`
- **GLB models (bins):** 140L.glb, 240.glb, 360.glb, 660L.glb, 1000L.glb, Balex.glb
- **GLB models (machines):** Orwak_Multi_5070.glb, OW5070_combi_restavfall.glb, EnviroPac-Kjøler.glb, APS_800.glb
- **Sorting sign PNGs (sortere.no):** loaded via same `/r2/` proxy — filenames defined in `SKILT_DEFS` in `data.js`

## Known Ongoing Issues
- No touch support for 3D orbit
- `overlayFraksjonIcons()` is written but currently disabled in `generatePDF()` — coordinate mapping from 3D scene to top-down image pixels is not yet verified (comment in app.js line ~1434)

---

## Additional Features

### Autosave (localStorage)
Every change schedules a debounced save (`AUTOSAVE_KEY = 'roomtegner_draft'`, 800ms delay) to localStorage. On load, if a draft exists and no `?code=` URL param, a recovery banner appears so the user can restore or discard the previous session. Autosave is disabled in read-only share-link mode.

### SELLER_PIN / PIN overlay
If the `SELLER_PIN` env var is set in `app.py`, the frontend receives it as `window.SELLER_PIN`. On load, `checkPin()` shows a full-screen overlay prompting for the PIN. Auth is stored in `sessionStorage` (not persistent). Share-link visitors (`?code=`) bypass the PIN entirely — `app.py` injects an empty PIN for public routes.

### Inner Wall Tool (`kind: 'innerwall'`)
The inner wall tool (`state.tool = 'innerwall'`) lets users draw interior partition walls. Clicking sets `state.innerWallStart`; clicking again commits the segment. Snaps to 0.1m grid and 0.15m radius to existing inner wall endpoints. Inner walls participate in container wall-snap (`innerWallCandidates()` included in `nearestWall()`).

### Arrow-Key Precision Input
While drawing a freehand polygon, pressing an arrow key (←↑→↓) opens a floating input field near the last point (`showArrowInput()`). The user types an exact length in metres; the new point is placed in that direction. If the resulting point is within 0.2m of the start, the room closes automatically.

### 3D Camera Compass & Angle Presets
`render3d.setAngle(a)` supports 8 presets: `'iso-ne'`, `'iso-nw'`, `'iso-se'`, `'iso-sw'`, `'top'`, `'front'`, `'side-r'`, `'side-l'`. The compass widget (collapsed trigger, expands on hover) in the 3D view maps these to clickable buttons.

### Sign Nudging in 3D
When a sorting sign is selected in 3D mode, a control panel appears at the bottom with arrow buttons (◀▶▲▼). Each click calls `scene3d.nudgeSkilt(id, dir)` and adjusts the sign's wall offset or height by 0.05m. Height is displayed in metres.

### Share Code — Export & Read-Only Import
Sellers can export a sketch as a 6-character share code via the **Share** button (calls `POST /api/sketches/{id}/share`, auth required). This generates or retrieves the code, stored in the `share_code` DB column.

Anyone can view the sketch by entering the code in the **Import Code** dialog (`importByCode()`) or via a direct URL (`?code=XXXXXX`). The public endpoint (`GET /public/{code}`, no auth) returns the sketch data; the frontend loads it with `state.readOnly = true` + `applyReadOnly()`, which hides all edit UI and adds a fixed read-only banner. No edits, saves, or exports are possible for the viewer.

The share code persists indefinitely — there is no expiry or revocation currently.

---

## Development Rules (Quick Reference)
These patterns are derived from the Decision Log. The full context is there — this is the short version for day-to-day use.

| Rule | Where |
|------|-------|
| **Never call `scene3d.rebuild()` in `mousemove`** — only on `mouseup` or explicit action | `app.js` onMM |
| **All new `<canvas>` elements must apply `devicePixelRatio` scaling at init** | `render2d.js` reference |
| **Never access `state.rooms[n].data` directly** — always call `fromJSON()` first | `state.js` |
| **Never use `con.execute()` in Python** — always `cur = con.cursor(); cur.execute(...); con.commit(); cur.close(); con.close()` | `app.py` |
| **Never hard-code the R2 URL** — always use `/r2/<filename>` | `data.js`, `app.py` |
| **All new backend API routes must be under `/api/`** — they inherit the `X-API-Key` auth middleware automatically | `app.py` |
| **`nearestWall()` returns the polygon boundary = inner wall face** — do not add `WALL_THICK/2` when offsetting signs from `_wallX/_wallY` | `render3d.js buildSkilt3D` |
| **Thumbnails must use `image/jpeg` with a quality param** — the quality param is silently ignored for PNG | `app.js generatePDF` |

---

## Decision Log

> **Rule:** Add a new entry here whenever a significant architectural decision is made, a bug fix changes how a core system works, or a pattern is established that future code must follow.
> Format: Problem → Decision → Why → Pattern to follow.

---

### 3D rebuilt on mouseup, not per frame — 2025
**Problem:** Rebuilding Three.js meshes on every mousemove event caused garbage collection and noticeable lag.
**Decision:** 2D canvas handles real-time drag feedback. The 3D scene is fully rebuilt only on `mouseup`.
**Why:** Mesh teardown + rebuild is expensive. 2D is cheap to redraw per frame. The split gives responsive drag without 3D overhead.
**Pattern:** Never call `rebuild3D()` inside `mousemove` handlers. Only on `mouseup` or explicit user action.

---

### Wall geometry pushed outward — 2025-02 (commit 0b07aec)
**Problem:** Containers placed against the wall were clipping through it in 3D.
**Decision:** Wall mesh is offset outward by half the wall thickness so containers placed at the wall edge sit flush.
**Why:** Three.js geometry is centered on its position. Without the offset, half the wall would stick into the room and half outside.
**Pattern:** Wall mesh offset must match the container snap threshold (0.5m). If the threshold changes, update the offset accordingly.

---

### PDF export: 2D snapshot + optional 3D top-down capture — 2025-03 (commit 84ee214), updated 2026-03
**Problem:** WebGL readback for a 3D snapshot is unreliable across browsers and requires significant setup.
**Decision:** PDF primary layout uses a clean 2D canvas snapshot (no UI chrome), with auto-fit scaling and a grouped data table. A top-down 3D capture (`scene3d.captureTopDown()`) is also taken and included as a visual supplement.
**Why:** The 2D canvas is the authoritative source for room data. 3D capture is visual only — the quote data always comes from `state`.
**Pattern:** PDF data (container list, dimensions, quantities) must always come from `state`. The 3D scene may be used for visual snapshots only. `scene3d.init()` is idempotent and falls back to 1200×800 if the 3D container is hidden when PDF is triggered from 2D mode. `scene3d.rebuildSync()` guarantees the scene is current before capture.

---

### HiDPI/Retina canvas scaling — 2025-01 (commit 57e6519)
**Problem:** Canvas drawing was blurry on Retina and HiDPI screens.
**Decision:** Canvas `width`/`height` are multiplied by `devicePixelRatio`. CSS size stays unchanged. All canvas content is scaled by DPR in render functions.
**Why:** Without DPR correction, the browser stretches a low-resolution canvas to fill the screen.
**Pattern:** All new `<canvas>` elements must apply DPR scaling at init. See `render2d.js` for the reference implementation.

---

### Auto-signs linked to container via `_linkedTo` — 2025
**Problem:** Sorting signs needed to move with their associated container during drag.
**Decision:** Signs store `_linkedTo: container.id`. During container drag, all items with a matching `_linkedTo` are repositioned.
**Why:** Simple reference rather than a complex parent/child tree structure. Appropriate for the scale of this project.
**Pattern:** Any item that should "follow" another uses the `_linkedTo` pattern. The drag logic in `app.js` handles this automatically.

---

### Sign offset breaks when wall geometry changes — 2026-03 (wall fix 0b07aec, sign fix follows)
**Problem:** After pushing wall meshes outward by `WALL_THICK/2` so inner faces align with the polygon boundary, signs started floating inside/over containers instead of sitting on the wall.
**Root cause:** `buildSkilt3D` used `wallThick = WALL_THICK/2 + 0.025m`. The `WALL_THICK/2` component assumed `wi.wx/wz` (from `nearestWall()`) was the wall mesh center. After the wall-push fix it became the inner face, so the sign was pushed 0.06m too far into the room — into the container mesh.
**Decision:** Remove `WALL_THICK/2` from the offset. `wallThick = frame_half_depth + clearance = 0.025m` only.
**Pattern:** `nearestWall()` always returns a point on the polygon boundary. After commit 0b07aec, polygon boundary = inner wall face. Any code offsetting from `_wallX/_wallY` must NOT add `WALL_THICK/2` — that was only needed when the wall center was at the polygon boundary.

---

### Multi-room support via rooms[] array — 2026
**Problem:** Users needed to plan multiple waste rooms in the same sketch.
**Decision:** `state.rooms[]` holds `{id, name, data}` entries. `state.activeRoom` is the index of the currently displayed room. Switching rooms serialises the current room to `data` and deserialises the target room.
**Why:** Minimal change to the existing single-room state shape — `toJSON/fromJSON` still works per-room. The outer sketch format bumped to `version: 2` to distinguish multi-room saves from legacy single-room saves.
**Pattern:** Always read/write the active room through `toJSON/fromJSON`. Never access `state.rooms[n].data` directly to get geometry — call `fromJSON` first.

---

### PostgreSQL replaces SQLite — 2026
**Problem:** SQLite on Render free tier uses ephemeral disk storage — all data is lost on every deploy or instance restart. Free PostgreSQL tier also expires after 90 days.
**Decision:** Migrated to Render paid PostgreSQL (`DATABASE_URL` env var). All SQL uses `%s` placeholders (psycopg2) and explicit cursor objects — `con.execute()` is not valid in psycopg2. `init_db()` uses `ADD COLUMN IF NOT EXISTS` so it is safe to re-run on an existing database.
**Why:** Persistent storage is a hard requirement for a production sales tool. SQLite ephemeral disk means every Render deploy wipes all saved sketches.
**Pattern:** Never use `con.execute()` — always `cur = con.cursor(); cur.execute(...); con.commit(); cur.close(); con.close()`.

---

### Share-code feature — 2026
**Problem:** Sellers need to share a read-only view of a sketch with customers or colleagues without requiring an API key or account.
**Decision:** A 6-char uppercase alphanumeric code is generated on demand (POST `/api/sketches/{id}/share`, requires API key) and stored in the `share_code` column. The public read endpoint (`GET /public/{code}`, no auth) returns the sketch data. The frontend enforces read-only mode via `state.readOnly = true` + `applyReadOnly()`, which hides all edit UI and adds a fixed banner. The `onMD()` handler returns early if `state.readOnly`, so no drag/edit is possible even via keyboard or mouse.
**Why:** Backend enforcement would require a separate auth system. Frontend-only enforcement is sufficient here since the public endpoint only exposes the data — it cannot write. Customers see a clean view; sellers use the same app with full edit access.
**Pattern:** The `/public/{code}` endpoint is intentionally outside `/api/` (no auth middleware). Read-only mode must be set via `state.readOnly = true` before calling `applyReadOnly()` — the banner and hidden UI are permanent for the session.

---

### Thumbnail JPEG instead of PNG — 2026
**Problem:** `canvas.toDataURL('image/png', 0.4)` ignores the quality parameter — PNG is always lossless, making thumbnails 200–500 KB each (base64), which fills PostgreSQL 1 GB storage quickly.
**Decision:** Changed to `canvas.toDataURL('image/jpeg', 0.4)` — JPEG with 40% quality reduces thumbnails to ~20–50 KB each (~10× smaller).
**Why:** 1 GB PostgreSQL storage supports ~2,000 sketches at 500 KB/thumbnail (PNG) but ~20,000+ at 50 KB/thumbnail (JPEG). JPEG thumbnails are display-only and do not need to be lossless.
**Pattern:** Always use `image/jpeg` with a quality parameter for thumbnails. The quality parameter is silently ignored for PNG.

---

### All R2 assets proxied via /r2/ — 2026
**Problem:** Direct browser fetches from Cloudflare R2 trigger CORS errors, and taint the canvas making `toDataURL()` fail during PDF export.
**Decision:** `app.py` exposes `/r2/<filename>` which fetches from R2 server-side and streams the result to the browser. All GLBs and sign PNGs go through this proxy.
**Why:** Same-origin responses are never tainted. The proxy also caches responses in-memory (up to 200 entries) to avoid redundant R2 round-trips.
**Pattern:** Never add a hard-coded `https://pub-27fd45166dba4be8a488b48df57742df.r2.dev/` URL in frontend code. Always use `/r2/<filename>`.

---

### API key auth on all /api/ routes — 2025-01 (commit 087b680)
**Problem:** The backend was open without authentication.
**Decision:** Simple API key header check (`X-API-Key`) on all `/api/` endpoints via a FastAPI dependency.
**Why:** Simple and sufficient for internal use. Avoids the complexity of OAuth/JWT for this use case.
**Pattern:** All new API routes must go under `/api/` and will inherit the auth middleware automatically.

---

### 3D realism improvements — 2026
**Problem:** The room looked fake/toy-like when zoomed out: flat floor with no texture, narrow FOV, no atmospheric depth, sharp wall-floor joints, flat inner wall shading.
**Decision:** Six targeted changes to `render3d.js`, all avoiding extra render passes or shadow-map cost:
1. **FOV 45° → 58°** — matches what RoomSketcher/Planner 5D use; feels photographic.
2. **FogExp2** (density 0.018, matching background colour) — atmospheric depth at distance.
3. **Floor tile texture** — canvas-generated 512×512 texture (polished concrete, subtle grout lines) set to `RepeatWrapping` with `repeat=(W,D)` for 1 tile per metre. Cached as a module-level `_floorTex`; only the `repeat` vector is changed per rebuild (no GPU re-upload). Works in both rect (BoxGeometry UV) and free mode (ShapeGeometry UV from bounding box).
4. **Baseboard geometry** — 8cm tall, 2.5cm deep strip along every wall-floor junction. `receiveShadow=true`, `castShadow=false` — gets a shadow line at the base without costing a shadow-map draw call.
5. **Inner wall faces Lambert → MeshStandardMaterial** — the transparent outer wall shells stay Lambert (barely visible at 38% opacity; PBR cost not justified). Only the opaque inner face planes upgrade to Standard so directional lights produce a visible gradient across the wall surface.
6. **Blob contact shadows** — radial-gradient plane (128×128, cached as `_blobTex`) placed at y=0.002 under each container and cage. `depthWrite=false` blends with the floor. Zero shadow-map cost.
**Why:** SSAO was considered but rejected: it requires 4 render passes (G-buffer + SSAO + blur + composite), and transparent walls break the depth buffer causing halos. The blob shadow + baseboard shadow combo achieves a similar "grounded" look for near-zero GPU cost.
**Pattern:** `_floorTex` and `_blobTex` are module-level singletons — never recreate them in `_doRebuild`. Only set `.repeat` on `_floorTex` before applying it to the floor material.

---

## Live URL
https://roomtegner.onrender.com

## AI Role and Workflow
- Act as an experienced architect and senior developer.
- Write production-quality code appropriate to the project's scale — do not over-engineer.
- Avoid temporary solutions and shortcuts where they create technical debt.
- Code must be modular and easy to test.
- Always explain the performance characteristics of proposed solutions.
- State potential drawbacks of technical choices.
- Update this document when architecture or file structure changes (especially File Structure, Known Ongoing Issues, and Decision Log).
- Comment non-obvious decisions in code — explain *why*, not what. Include performance rationale (e.g. "2D only here — 3D rebuilds on mouseup to avoid per-frame mesh teardown"). Future engineers (and Claude) must be able to understand the reasoning without reading git history.
