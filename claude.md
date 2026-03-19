# TEO Room Planner — Project Context

## What is this?
A web-based room planner for Norsk Gjenvinning (NG) where salespeople can draw waste rooms, place containers, and export a PDF quote for customers.

## Stack
- **Backend:** FastAPI + SQLite (`app.py`), runs on port 8000
- **Frontend:** Vanilla JS, HTML, CSS — no bundler/framework
- **3D:** Three.js r128 with GLB models from Cloudflare R2
- **Deploy:** Render.com (`python app.py`)

## File Structure
```
app.py                  ← FastAPI REST API + SQLite
static/
  index.html
  css/style.css
  js/
    data.js             ← DEFS, WALL_EL_DEFS, FRAKSJONER, SKILT_DEFS
    state.js            ← state object, getO(), getPPM(), calcPPM(), toJSON/fromJSON
    render2d.js         ← Canvas 2D renderer
    render3d.js         ← Three.js 3D, GLB-loader, buildSkilt3D
    app.js              ← Events, UI, drag/rotate, poly-drawing, PDF export
    api.js              ← Save/load sketches to/from backend
    GLTFLoader.js
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
- Container snaps to wall during drag (`snapToWall`, threshold 0.5m)
- On mouseup: `checkAutoSkilt(container)` → automatically adds a sorting sign if within 0.8m of a wall
- Signs store `_wallNx/Ny/X/Y` for 3D placement
- Signs follow their container during drag (`_linkedTo: container.id`)

## State (important fields)
```js
state.roomMode        // 'free' | 'rect'
state.poly            // [{x,y}] — room corners in meters
state.polyDone        // true when room is closed
state.polyDraw        // true while drawing
state.items           // all objects: container | wall | skilt | note | exit
state.sel             // id of selected object
state.drag / rotat    // object being dragged/rotated
state.pendingSkilt    // {id, def} — sign waiting for a container click
state.zoom / panX/Y   // camera
```

## External Resources
- **GLB models:** `https://pub-27fd45166dba4be8a488b48df57742df.r2.dev/`
  - 140L.glb, 240.glb, 360.glb, 660L.glb, 1000L.glb, Balex.glb
- **GPN icons (SVG):** `https://www.grontpunkt.no/media/...`

## Known Ongoing Issues
- Sign placement in 3D (position and normal direction) is being debugged
- Auto-rotation of container toward wall (formula not verified)
- No touch support for 3D orbit

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

### PDF export uses 2D snapshot, not 3D — 2025-03 (commit 84ee214)
**Problem:** WebGL readback for a 3D snapshot is unreliable across browsers and requires significant setup.
**Decision:** PDF uses a clean 2D canvas snapshot (no UI chrome), with auto-fit scaling and a grouped data table.
**Why:** The 2D canvas contains all necessary room information. 3D is visualization only — the PDF is a quote, not a presentation.
**Pattern:** PDF export must always source data from 2D state / `state`. Never from the 3D scene.

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

### API key auth on all /api/ routes — 2025-01 (commit 087b680)
**Problem:** The backend was open without authentication.
**Decision:** Simple API key header check (`X-API-Key`) on all `/api/` endpoints via a FastAPI dependency.
**Why:** Simple and sufficient for internal use. Avoids the complexity of OAuth/JWT for this use case.
**Pattern:** All new API routes must go under `/api/` and will inherit the auth middleware automatically.

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
