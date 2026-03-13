# TEO Romskisse — Prosjektkontekst

## Hva er dette?
En nettbasert romtegner for Norsk Gjenvinning (NG) der selgere kan tegne avfallsrom, plassere beholdere og eksportere en PDF-tilbud til kunder.

## Stack
- **Backend:** FastAPI + SQLite (`app.py`), kjører på port 8000
- **Frontend:** Vanilla JS, HTML, CSS — ingen bundler/framework
- **3D:** Three.js r128 med GLB-modeller fra Cloudflare R2
- **Deploy:** Render.com (`python app.py`)

## Filstruktur
```
app.py                  ← FastAPI REST API + SQLite
static/
  index.html
  css/style.css
  js/
    data.js             ← DEFS, WALL_EL_DEFS, FRAKSJONER, SKILT_DEFS
    state.js            ← state-objekt, getO(), getPPM(), calcPPM(), toJSON/fromJSON
    render2d.js         ← Canvas 2D renderer
    render3d.js         ← Three.js 3D, GLB-loader, buildSkilt3D
    app.js              ← Events, UI, drag/rotate, poly-tegning, PDF-eksport
    api.js              ← Lagre/last skisser mot backend
    GLTFLoader.js
```

## Koordinatsystem
- **Canvas 2D:** X høyre, Y ned (standard canvas). Enheter = meter.
- **Three.js 3D:** canvas X → Three.js X, canvas Y → Three.js Z. Y er opp.
- `getO()` returnerer `{ox, oy}` — piksel-origo for rommet på canvas
- `getPPM()` — piksler per meter (inkl. zoom)

## Romformer
- `state.roomMode = 'free'` (frihånd, standard) eller `'rect'` (rektangel for testing)
- Frihånd: punkter i `state.poly[]`, lukket når `state.polyDone = true`
- `nearestWall(x, y)` → `{dist, wallX, wallY, nx, ny}` — fungerer i begge modi
- Inward normals: peker inn i rommet fra veggen

## Beholdere og skilt
- Beholder snap til vegg under drag (`snapToWall`, threshold 0.5m)
- Ved mouseup: `checkAutoSkilt(container)` → legger til sorteringsskilt automatisk hvis innen 0.8m fra vegg
- Skilt lagrer `_wallNx/Ny/X/Y` for 3D-plassering
- Skilt følger beholder ved drag (`_linkedTo: container.id`)

## State (viktige felt)
```js
state.roomMode        // 'free' | 'rect'
state.poly            // [{x,y}] — romhjørner i meter
state.polyDone        // true når rom er lukket
state.polyDraw        // true mens man tegner
state.items           // alle objekter: container | wall | skilt | note | exit
state.sel             // id på valgt objekt
state.drag / rotat    // objekt under drag/rotasjon
state.pendingSkilt    // {id, def} — skilt som venter på beholder-klikk
state.zoom / panX/Y   // kamera
```

## Eksterne ressurser
- **GLB-modeller:** `https://pub-27fd45166dba4be8a488b48df57742df.r2.dev/`
  - 140L.glb, 240.glb, 360.glb, 660L.glb, 1000L.glb, Balex.glb
- **GPN-ikoner (SVG):** `https://www.grontpunkt.no/media/...`

## Kjente pågående problemer
- Skilt-plassering i 3D (posisjon og normal-retning) er under feilsøking
- Auto-rotering av beholder mot vegg (formel ikke verifisert)
- Ingen touch-støtte for 3D-orbit

## Live URL
https://roomtegner.onrender.com