const scene3d = (() => {
  let renderer, scene, camera;
  let meshes = [];
  let initialized = false;

  // Single source of truth for 3D wall thickness (metres).
  // Walls are shifted outward by WALL_THICK/2 so their inner faces align exactly
  // with the room boundary coordinates (0→W, 0→D) used by the 2D snap system.
  // Changing this value automatically propagates to all wall geometry and comments.
  const WALL_THICK = 0.12;
  const FLOOR_OUTLINE_OFFSET = 2; // metres outward from room boundary for pedestal edge
  const STEP_H = 0.30;            // height of the pedestal step (30cm)

  // GLB model cache: typeId → THREE.Group (cloned per instance)
  const glbCache = {};
  let gltfLoader = null;

  function getGLTFLoader() {
    if (gltfLoader) return gltfLoader;
    if (!THREE.GLTFLoader) return null;
    gltfLoader = new THREE.GLTFLoader();
    return gltfLoader;
  }

  // preRotY:       optional Y-rotation applied BEFORE bbox measurement (for axis-misaligned GLBs).
  // hideMeshNames: optional string[] — meshes matching by name are hidden before bbox measurement
  //                and stay hidden permanently. Use this to exclude open doors/hatches that inflate
  //                the bounding box beyond the machine's closed physical footprint.
  // Cache key includes both params so variants are stored separately.
  function loadGLB(url, targetW, targetH, targetD, preRotY, callback, hideMeshNames) {
    const loader = getGLTFLoader();
    if (!loader) { callback(null); return; }
    const hideKey = hideMeshNames && hideMeshNames.length ? hideMeshNames.join(',') : '';
    const cacheKey = [url, preRotY || 0, hideKey].join('|');
    if (glbCache[cacheKey]) { callback(glbCache[cacheKey].clone()); return; }
    loader.load(url, (gltf) => {
      const model = gltf.scene;
      if (preRotY) { model.rotation.y = preRotY; }
      // Hide meshes before bbox so protruding parts (open door etc.) don't inflate the scale
      if (hideMeshNames && hideMeshNames.length) {
        model.traverse(c => { if (c.isMesh && hideMeshNames.includes(c.name)) c.visible = false; });
      }
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      // Scale to exact NG dimensions
      model.scale.set(targetW / size.x, targetH / size.y, targetD / size.z);
      model.updateMatrixWorld(true);
      // Store at origin — position applied per instance
      model.position.set(0, 0, 0);
      glbCache[cacheKey] = model;
      callback(model.clone());
    }, undefined, (err) => {
      console.warn('GLB load failed, using fallback:', err);
      callback(null);
    });
  }

  // Orbit state
  let orbit = { active: false, lastX: 0, lastY: 0, theta: Math.PI*0.35, phi: Math.PI*0.3, radius: 0, target: new THREE.Vector3() };

  // Walk mode state — ephemeral, never serialised (same pattern as orbit above)
  const walk = {
    active: false,
    yaw: 0,           // horizontal look angle (radians, around Y axis)
    pitch: 0,         // vertical look angle (radians, clamped ±70° = ±1.22 rad)
    x: 0,             // camera position Three.js X
    z: 0,             // camera position Three.js Z
    EYE_H: 1.6,       // eye height in metres
    SPEED: 2.0,       // movement speed m/s
    keysHeld: {},     // {key: true} while held — cleared on exit
    lastTime: 0,      // ms timestamp for delta-time movement
  };

  let _skiltMeshMap = []; // maps mesh → item id for raycasting

  function initOrbit() {
    const el = renderer.domElement;
    let didDrag = false;
    el.addEventListener('mousedown', e => {
      if (walk.active) return; // walk mode owns the canvas — don't activate orbit drag
      if (e.button === 0) {
        orbit.active = true; orbit.lastX = e.clientX; orbit.lastY = e.clientY;
        el.style.cursor = 'grabbing'; didDrag = false;
      }
    });
    el.addEventListener('mouseup', e => {
      orbit.active = false; el.style.cursor = 'grab';
      if (!didDrag) trySelectSkilt(e);
    });
    el.addEventListener('mouseleave', () => { orbit.active = false; el.style.cursor = 'grab'; });
    el.addEventListener('mousemove', e => {
      if (!orbit.active) return;
      const dx = e.clientX - orbit.lastX, dy = e.clientY - orbit.lastY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
      orbit.lastX = e.clientX; orbit.lastY = e.clientY;
      orbit.theta -= dx * 0.008;
      orbit.phi = Math.max(0.08, Math.min(Math.PI * 0.48, orbit.phi - dy * 0.008));
      updateOrbitCamera();
    });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      orbit.radius = Math.max(2, Math.min(40, orbit.radius + e.deltaY * 0.01));
      updateOrbitCamera();
    }, { passive: false });
    el.style.cursor = 'grab';

    // Keyboard pan — arrows move camera like a drone (strafe left/right, up/down)
    document.addEventListener('keydown', e => {
      if (state.view !== '3d' || state.walkMode) return; // walk mode owns arrow keys
      const step = 0.25;
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const dir = e.key === 'ArrowLeft' ? -1 : 1;
          orbit.target.x += Math.cos(orbit.theta) * step * dir;
          orbit.target.z -= Math.sin(orbit.theta) * step * dir;
          updateOrbitCamera();
          break;
        }
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault();
          const dir = e.key === 'ArrowUp' ? 1 : -1;
          orbit.target.y += step * dir;
          updateOrbitCamera();
          break;
        }
        case '+': case '=': e.preventDefault(); orbit.radius = Math.max(2, orbit.radius - 0.8); updateOrbitCamera(); break;
        case '-': e.preventDefault(); orbit.radius = Math.min(40, orbit.radius + 0.8); updateOrbitCamera(); break;
      }
    });
  }

  // ── Walk mode input setup ─────────────────────────────────────────────────
  // Called once from init(). Sets up Pointer Lock + mouse-look + key-held tracking.
  // All handlers guard on walk.active so they are silent outside walk mode.
  function initWalk() {
    const el = renderer.domElement;

    // Pointer Lock lifecycle
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === el) {
        // Lock acquired — walk is now fully active
        walk.active = true;
        state.walkMode = true;
        const hud = document.getElementById('walk-hud');
        if (hud) {
          hud.textContent = 'WASD / Piltaster = beveg  ·  Mus = se rundt  ·  Esc = avslutt';
          hud.style.pointerEvents = 'none';
          hud.style.cursor = '';
        }
      } else {
        // Lock lost (Escape or document.exitPointerLock()) — exit walk cleanly
        _exitWalkMode();
      }
    });

    document.addEventListener('pointerlockerror', () => {
      console.warn('Pointer lock request failed');
      _exitWalkMode();
    });

    // Mouse look — movementX/Y only available while pointer is locked
    el.addEventListener('mousemove', e => {
      if (!walk.active) return;
      const SENS = 0.002;
      walk.yaw  -= e.movementX * SENS;
      walk.pitch = Math.max(-1.22, Math.min(1.22, walk.pitch - e.movementY * SENS));
    });

    // Key-held tracking for smooth WASD movement
    document.addEventListener('keydown', e => {
      if (!walk.active) return;
      walk.keysHeld[e.key] = true;
      const moveKeys = ['w','a','s','d','W','A','S','D','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
      if (moveKeys.includes(e.key)) e.preventDefault();
    });

    document.addEventListener('keyup', e => {
      if (!walk.active) return;
      walk.keysHeld[e.key] = false;
    });
  }

  // ── Walk mode helpers ─────────────────────────────────────────────────────

  function _getRoomBounds() {
    if (state.roomMode === 'rect')
      return { minX: 0, maxX: state.roomW, minZ: 0, maxZ: state.roomD };
    const xs = state.poly.map(p => p.x), zs = state.poly.map(p => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs),
             minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  }

  // Per-frame camera update — only called when walk.active (from animate())
  function _walkUpdateCamera() {
    const now = performance.now();
    // Cap dt at 100ms to prevent teleport-jump when tab regains focus
    const dt = Math.min((now - walk.lastTime) / 1000, 0.1);
    walk.lastTime = now;

    // Movement vectors derived from yaw only — pitch doesn't tilt the walk plane
    const sinY = Math.sin(walk.yaw), cosY = Math.cos(walk.yaw);
    const fwdX = sinY, fwdZ = cosY;
    const rgtX = cosY, rgtZ = -sinY;

    let moveX = 0, moveZ = 0;
    const k = walk.keysHeld;
    if (k['w'] || k['W'] || k['ArrowUp'])    { moveX -= fwdX; moveZ -= fwdZ; }
    if (k['s'] || k['S'] || k['ArrowDown'])  { moveX += fwdX; moveZ += fwdZ; }
    if (k['a'] || k['A'] || k['ArrowLeft'])  { moveX -= rgtX; moveZ -= rgtZ; }
    if (k['d'] || k['D'] || k['ArrowRight']) { moveX += rgtX; moveZ += rgtZ; }

    const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (len > 0) {
      const dist = walk.SPEED * dt;
      const nx = walk.x + (moveX / len) * dist;
      const nz = walk.z + (moveZ / len) * dist;
      // Bounding-box collision: 0.2m margin from each wall
      // Correct for rectangular rooms; safe approximation for L/T-shaped free rooms
      const MARGIN = 0.2;
      const b = _getRoomBounds();
      walk.x = Math.max(b.minX + MARGIN, Math.min(b.maxX - MARGIN, nx));
      walk.z = Math.max(b.minZ + MARGIN, Math.min(b.maxZ - MARGIN, nz));
    }

    camera.position.set(walk.x, walk.EYE_H, walk.z);
    // YXZ Euler order = standard FPS convention: yaw applied in world space first,
    // then pitch in local space — avoids gimbal lock at vertical look extremes.
    camera.rotation.order = 'YXZ';
    camera.rotation.y = walk.yaw;
    camera.rotation.x = walk.pitch;
    camera.rotation.z = 0;
  }

  function _showWalkHUD(visible) {
    const hud = document.getElementById('walk-hud');
    if (!hud) return;
    if (!visible) { hud.style.display = 'none'; return; }
    hud.style.display = 'block';
    hud.style.pointerEvents = 'auto';
    hud.style.cursor = 'pointer';
    hud.textContent = 'Klikk for å aktivere musekontroll...';
    hud.onclick = () => renderer.domElement.requestPointerLock();
  }

  // Public entry point — called from Walk button in index.html
  function enterWalkMode() {
    if (!initialized) return;
    const { cx, cz } = getRoomOrbitParams();
    walk.x = cx;
    walk.z = cz;
    walk.yaw = 0;
    walk.pitch = 0;
    walk.lastTime = performance.now();
    // Orbit state is intentionally NOT modified — returning to orbit restores exact pre-walk view
    _showWalkHUD(true); // show "click to activate" immediately
    renderer.domElement.requestPointerLock(); // pointerlockchange handler activates walk fully
  }

  function _exitWalkMode() {
    if (!walk.active && !state.walkMode) return; // already exited
    walk.active = false;
    walk.keysHeld = {};
    state.walkMode = false;
    _showWalkHUD(false);
    // Restore orbit camera (orbit state was never touched by walk mode)
    if (camera) updateOrbitCamera();
  }

  function trySelectSkilt(e) {
    const el = renderer.domElement;
    const rect = el.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    const targets = _skiltMeshMap.map(s => s.mesh);
    const hits = raycaster.intersectObjects(targets, true);
    if (hits.length > 0) {
      // Find which skilt was hit
      const hitObj = hits[0].object;
      const entry = _skiltMeshMap.find(s => {
        let o = hitObj;
        while (o) { if (o === s.mesh) return true; o = o.parent; }
        return false;
      });
      if (entry) {
        state.sel = entry.id;
        if (typeof updateDP === 'function') updateDP();
        if (typeof updateSkilt3dCtrl === 'function') updateSkilt3dCtrl();
        return;
      }
    }
    // Clicked empty space — deselect skilt control
    const selItem = state.items.find(i => i.id === state.sel);
    if (selItem && selItem.kind === 'skilt') {
      state.sel = null;
      if (typeof updateSkilt3dCtrl === 'function') updateSkilt3dCtrl();
    }
  }

  function updateOrbitCamera() {
    const r = orbit.radius;
    camera.position.set(
      orbit.target.x + r * Math.sin(orbit.phi) * Math.sin(orbit.theta),
      orbit.target.y + r * Math.cos(orbit.phi),
      orbit.target.z + r * Math.sin(orbit.phi) * Math.cos(orbit.theta)
    );
    camera.lookAt(orbit.target);
  }

  // Computes orbit center and radius from the current room shape.
  // Uses polygon centroid/bounds for free mode, rect dimensions for rect mode.
  // Called once on init() and also by setAngle() for camera presets.
  // Radius formula: dim * 1.2 + 2  — keeps the room comfortably close (~2–3m
  // outside the front wall at the default isometric angle). The +2 constant
  // prevents being too close on tiny rooms (e.g. 3×3m).
  // Previously 2.2× which made every room look like a dollhouse from far away.
  function getRoomOrbitParams() {
    const H = state.roomH;
    if (state.roomMode === 'free' && state.poly && state.poly.length > 0) {
      const poly = state.poly;
      const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
      const cz = poly.reduce((s, p) => s + p.y, 0) / poly.length;
      const xs = poly.map(p => p.x), zs = poly.map(p => p.y);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
      return { cx, cz: cz, radius: span * 1.2 + 2, H };
    }
    const rW = state.roomW, rD = state.roomD;
    return { cx: rW / 2, cz: rD / 2, radius: Math.max(rW, rD) * 1.2 + 2, H };
  }

  function resetOrbit() {
    const { cx, cz, radius, H } = getRoomOrbitParams();
    // Target at H*0.22 (vs 0.35) keeps all 4 walls balanced in the isometric frame
    // and avoids clipping the front-bottom corner on first load.
    orbit.target.set(cx, H * 0.22, cz);
    orbit.radius = radius;
    orbit.theta = Math.PI * 0.35;
    // phi 0.32 (slightly more elevated than 0.30) shows more floor, better room overview
    orbit.phi = Math.PI * 0.32;
    updateOrbitCamera();
  }

  function init() {
    if (initialized) return; // safe to call multiple times (e.g. from PDF export before 3D tab opened)
    const container = document.getElementById('canvas-3d');
    // Use fallback size when container is hidden (display:none) during PDF export from 2D mode.
    // clientWidth/clientHeight return 0 for hidden elements — a 0×0 renderer is useless.
    const W = container.clientWidth  || 1200;
    const H = container.clientHeight || 800;

    scene = new THREE.Scene();
    // Medium-dark neutral gray — sits between the original flat gray and pitch black.
    // Avoids the harsh bright-room vs. black-void contrast that makes equipment hard to read.
    scene.background = new THREE.Color(0x5a6068);
    // FogExp2 colour matches background so distant objects fade into the sky seamlessly.
    // Density 0.018 starts to show at ~15m — enough for large rooms but not intrusive.
    scene.fog = new THREE.FogExp2(0x5a6068, 0.018);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // ACESFilmic tone mapping + sRGB output give a photographic, non-flat look
    // without changing any geometry or materials — pure renderer-level quality upgrade.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    // Camera
    // 58° matches what RoomSketcher / Planner 5D use — wider than the original 45°
    // so the room feels photographic rather than toy-like.
    camera = new THREE.PerspectiveCamera(58, W / H, 0.1, 200);
    resetOrbit();
    initOrbit();

    // Lights — indoor industrial feel.
    // Ambient at 0.35 — lower than before to avoid flat wash; contrast comes from sun + PointLight.
    const ambient = new THREE.AmbientLight(0xdde4ea, 0.35);
    scene.add(ambient);
    // Sun raised to 1.1 and shadow map bumped to 2048 for crisper contrast and shadow edges.
    const sun = new THREE.DirectionalLight(0xfff6d8, 1.1);
    sun.position.set(8, 16, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 60;
    sun.shadow.camera.left = -16;
    sun.shadow.camera.right = 16;
    sun.shadow.camera.top = 16;
    sun.shadow.camera.bottom = -16;
    sun.shadow.bias = -0.001;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xb0c8e0, 0.5);
    fill.position.set(-8, 6, -8);
    scene.add(fill);
    // Overhead fill removed — the ambient light covers this adequately and
    // the extra DirectionalLight added per-fragment shader cost for every mesh.

    initWalk();
    initialized = true;
    animate();
    rebuild();
  }

  let _dirty = false;
  function markDirty() { _dirty = true; }

  function animate() {
    requestAnimationFrame(animate);
    if (_dirty) { _doRebuild(); _dirty = false; }
    if (walk.active) _walkUpdateCamera(); // FPS camera update — only runs in walk mode
    renderer.render(scene, camera);
  }

  function setAngle(a) {
    if (!camera) return;
    const { cx, cz, radius, H } = getRoomOrbitParams();

    // Per-angle radius: side/front views use the perpendicular room dimension so
    // narrow rooms (e.g. 2m × 10m) get a tight framing instead of zooming out to max(W,D).
    // Same formula as getRoomOrbitParams: dim * 1.2 + 2.
    let r = radius;
    if (state.roomMode === 'rect') {
      const rW = state.roomW, rD = state.roomD;
      if (a === 'side-l' || a === 'side-r') r = rW * 1.2 + 2;
      else if (a === 'front')               r = rD * 1.2 + 2;
    } else if (state.poly && state.poly.length > 0) {
      const xs = state.poly.map(p => p.x), zs = state.poly.map(p => p.y);
      const xSpan = Math.max(...xs) - Math.min(...xs);
      const zSpan = Math.max(...zs) - Math.min(...zs);
      if (a === 'side-l' || a === 'side-r') r = xSpan * 1.2 + 2;
      else if (a === 'front')               r = zSpan * 1.2 + 2;
    }

    orbit.target.set(cx, H * 0.35, cz);
    orbit.radius = r;
    const angles = {
      'iso-ne': [Math.PI*0.35, Math.PI*0.30],
      'iso-nw': [-Math.PI*0.35, Math.PI*0.30],
      'iso-se': [Math.PI*0.65, Math.PI*0.30],
      'iso-sw': [-Math.PI*0.65, Math.PI*0.30],
      'top':    [Math.PI*0.35, 0.08],
      'front':  [0, Math.PI*0.38],
      'side-r': [Math.PI*0.5, Math.PI*0.35],
      'side-l': [-Math.PI*0.5, Math.PI*0.35],
    };
    const [th, ph] = angles[a] || angles['iso-ne'];
    orbit.theta = th; orbit.phi = ph;
    updateOrbitCamera();
  }

  function rebuild() {
    if (!initialized) { markDirty(); return; }
    markDirty();
  }

  // Synchronous rebuild — bypasses the _dirty flag and animation-loop delay.
  // Used by PDF export after preloadItemGLBs() has guaranteed all GLBs are in glbCache.
  // Since glbCache hits are synchronous (clone only), _doRebuild(false) is safe here.
  function rebuildSync() {
    if (!initialized) return;
    _doRebuild(false);
    _dirty = false;
  }

  // Ensures all GLB models for the current state.items are loaded into glbCache.
  // glbCache hits are synchronous, so once this calls onDone(), rebuildSync() can
  // render GLB models without any async gaps.
  function preloadItemGLBs(onDone) {
    const R2 = '/r2';
    const GLB_V = '?v=3';
    const GLB_MODELS = {
      '140L':  `${R2}/140L.glb${GLB_V}`,
      '240L':  `${R2}/240.glb${GLB_V}`,
      '360L':  `${R2}/360.glb${GLB_V}`,
      '360LG': `${R2}/360.glb${GLB_V}`,
      '660L':  `${R2}/660L.glb${GLB_V}`,
      '660LG': `${R2}/660L.glb${GLB_V}`,
      '1000L': `${R2}/1000L.glb${GLB_V}`,
      'BALEX':     `${R2}/Balex.glb${GLB_V}`,
      'BALEX10':   `${R2}/Balex.glb${GLB_V}`,
      'ORWAK3420': `${R2}/orwak_3420.glb?v=2`,
      'KOMP400L':  `${R2}/400L_komp.glb`,
      'ORWAK5070':   `${R2}/Orwak_Multi_5070.glb`,
      'OW5070COMBI': `${R2}/OW5070_combi_restavfall.glb?v=9`,
      'ENVIROPAC':   `${R2}/EnviroPac-Kjøler.glb`,
      'APS800':      `${R2}/APS_800.glb`,
      '800LSTATIV':  `${R2}/800l-stativ.glb`,
      '60LFAT':      `${R2}/60L_fat.glb`,
      '200LFAT':     `${R2}/200L-Fat.glb`,
      '200LSEKKE':   `${R2}/200L_sekkestativ.glb`,
      'PALL':        `${R2}/pall.glb`,
    };
    const containers = state.items.filter(it => it.kind === 'container' && GLB_MODELS[it.def.id]);
    // Deduplicate by glbCache key so we don't fire multiple loads for the same file
    const seen = new Set();
    const unique = containers.filter(it => {
      const def = it.def;
      const preRotY = def.glbModelRotY || 0;
      const hideKey = (def.glbHideMeshNames || []).join(',');
      const key = [GLB_MODELS[def.id], preRotY, hideKey].join('|');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    if (unique.length === 0) { onDone(); return; }
    let done = 0;
    unique.forEach(it => {
      const def = it.def;
      const W = def.W / 1000, D = def.D / 1000, H = def.H / 1000;
      const [glbW, glbD] = def.glbSwapWD ? [D, W] : [W, D];
      const glb3dD = def.glb3dD || glbD;
      loadGLB(GLB_MODELS[def.id], glbW, H, glb3dD, def.glbModelRotY || 0, () => {
        done++;
        if (done === unique.length) onDone();
      }, def.glbHideMeshNames || []);
    });
  }

  function _doRebuild(forceSkipGLB = false) {
    meshes.forEach(m => scene.remove(m));
    meshes = [];
    _skiltMeshMap = [];

    buildRoom();
    state.items.forEach(it => {
      if (it.kind === 'container') buildContainer(it, forceSkipGLB);
      else if (it.kind === 'wall') buildWallEl(it);
      else if (it.kind === 'skilt') buildSkilt3D(it);
    });
    // Note: camera NOT reset here — only on init/setAngle
  }

  function mat(color, opts = {}) {
    return new THREE.MeshLambertMaterial({ color, ...opts });
  }

  function box(w, h, d, color, opts) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, mat(color, opts));
    return mesh;
  }

  // Shorthand: set mesh position and return it, for inline use inside group.add()
  function placed(mesh, x, y, z) { mesh.position.set(x, y, z); return mesh; }

  function setShadow(obj, cast = true, receive = true) {
    obj.traverse(child => {
      if (child.isMesh) { child.castShadow = cast; child.receiveShadow = receive; }
    });
  }

  function addMesh(m) { scene.add(m); meshes.push(m); return m; }

  // ── Floor tile texture ──────────────────────────────────────────────────
  // Created once at first use and cached for the lifetime of the page.
  // Reusing the same THREE.CanvasTexture object across rebuilds avoids VRAM
  // churn — only the repeat vector changes per-rebuild (no GPU re-upload needed).
  // Design: warm concrete base with barely-visible grout lines at tile edges.
  // The existing LineSegments grid sits at y=0.005 and provides crisp 1m joints;
  // the texture adds surface quality (polished concrete) without doubling the lines.
  let _floorTex = null;
  function getFloorTex() {
    if (_floorTex) return _floorTex;
    const SZ = 512, GW = 2; // canvas size, grout line width (px)
    const c = document.createElement('canvas');
    c.width = SZ; c.height = SZ;
    const ctx = c.getContext('2d');
    // Tile surface — same warm concrete as the existing floor colour
    ctx.fillStyle = '#dedad5';
    ctx.fillRect(0, 0, SZ, SZ);
    // Subtle radial highlight: slightly brighter centre, slightly darker edges —
    // reads as a polished/sealed concrete tile under overhead lighting.
    const grad = ctx.createRadialGradient(SZ/2, SZ/2, SZ*0.1, SZ/2, SZ/2, SZ*0.7);
    grad.addColorStop(0, 'rgba(255,255,255,0.05)');
    grad.addColorStop(1, 'rgba(0,0,0,0.07)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SZ, SZ);
    // Very faint grout lines at tile edges — complement (not duplicate) the
    // LineSegments grid that floats 5mm above the floor.
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(0, 0, SZ, GW); ctx.fillRect(0, SZ-GW, SZ, GW); // top/bottom
    ctx.fillRect(0, 0, GW, SZ); ctx.fillRect(SZ-GW, 0, GW, SZ); // left/right
    _floorTex = new THREE.CanvasTexture(c);
    _floorTex.wrapS = THREE.RepeatWrapping;
    _floorTex.wrapT = THREE.RepeatWrapping;
    return _floorTex;
  }

  // ── Blob contact shadow ─────────────────────────────────────────────────
  // Cheap alternative to per-object shadow casting. A radial-gradient plane
  // placed just above the floor under each container/cage. depthWrite=false
  // so it blends correctly with the floor without writing to the depth buffer.
  // No shadow-map involvement — zero additional GPU shadow-pass cost.
  let _blobTex = null;
  function getBlobTex() {
    if (_blobTex) return _blobTex;
    const SZ = 128;
    const c = document.createElement('canvas');
    c.width = SZ; c.height = SZ;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(SZ/2, SZ/2, 0, SZ/2, SZ/2, SZ/2);
    g.addColorStop(0,    'rgba(0,0,0,0.38)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.16)');
    g.addColorStop(1,    'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, SZ, SZ);
    _blobTex = new THREE.CanvasTexture(c);
    return _blobTex;
  }

  function addBlobShadow(cx, cz, W, D) {
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(W * 1.15, D * 1.15),
      new THREE.MeshBasicMaterial({ map: getBlobTex(), transparent: true, depthWrite: false })
    );
    blob.rotation.x = -Math.PI / 2;
    // y=0.002: above floor (top at y=0) so the blob shows; below the LineSegments
    // grid (y=0.005) so grout lines read through. depthWrite=false means the blob
    // never occludes geometry drawn after it in the transparent pass.
    blob.position.set(cx, 0.002, cz);
    addMesh(blob);
  }

  function buildRoom() {
    const H = state.roomH;
    // Lambert for walls — cheaper shader, no PBR cost. Tone mapping still improves
    // the look vs. the original. MeshStandardMaterial + clone-per-wall was too costly.
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xc8c4be, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x706c66 });

    // Solid inner-face plane — only visible from the room side because FrontSide
    // culls the face when the camera is on the outside (normal points away from camera).
    // px/pz: inner wall face position (polygon boundary). rotY: makes normal face inward.
    function addInnerWallFace(px, pz, w, rotY) {
      const p = new THREE.Mesh(
        new THREE.PlaneGeometry(w, H),
        // MeshStandardMaterial: directional lights produce a visible gradient across
        // the wall surface — Lambert was flat because it ignores roughness/metalness.
        new THREE.MeshStandardMaterial({ color: 0xd4d0cb, roughness: 0.85 })
      );
      p.position.set(px, H / 2, pz);
      p.rotation.y = rotY;
      p.receiveShadow = true;
      addMesh(p);
    }

    // Ground plane — large surface extending beyond room walls so the room feels
    // grounded rather than floating. Same warm-gray tone as the interior floor at
    // ~85% brightness — visually continuous but subtly darker to mark the boundary.
    const groundSize = 80;
    let gcx = 0, gcz = 0;
    if (state.roomMode === 'rect') {
      gcx = state.roomW / 2; gcz = state.roomD / 2;
    } else if (state.poly && state.poly.length > 0) {
      gcx = state.poly.reduce((s, p) => s + p.x, 0) / state.poly.length;
      gcz = state.poly.reduce((s, p) => s + p.y, 0) / state.poly.length;
    }
    // Bounding box of the room — works for both rect and free mode.
    let bbMinX = 0, bbMaxX = 0, bbMinZ = 0, bbMaxZ = 0;
    if (state.roomMode === 'rect') {
      bbMinX = 0; bbMaxX = state.roomW; bbMinZ = 0; bbMaxZ = state.roomD;
    } else if (state.poly && state.poly.length > 0) {
      bbMinX = Math.min(...state.poly.map(p => p.x));
      bbMaxX = Math.max(...state.poly.map(p => p.x));
      bbMinZ = Math.min(...state.poly.map(p => p.y));
      bbMaxZ = Math.max(...state.poly.map(p => p.y));
    }
    const f = FLOOR_OUTLINE_OFFSET;
    const slabW = bbMaxX - bbMinX + f*2;
    const slabD = bbMaxZ - bbMinZ + f*2;
    const slabCX = (bbMinX + bbMaxX) / 2;
    const slabCZ = (bbMinZ + bbMaxZ) / 2;

    // Pedestal slab — rectangular box always larger than the room by FLOOR_OUTLINE_OFFSET.
    // Top surface sits at y=-WALL_THICK (room floor level); sides are the visible step faces.
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(slabW, STEP_H, slabD),
      new THREE.MeshStandardMaterial({ color: 0x6e6b67, roughness: 0.9, metalness: 0 })
    );
    slab.position.set(slabCX, -WALL_THICK - STEP_H/2, slabCZ);
    slab.castShadow = true;
    slab.receiveShadow = true;
    addMesh(slab);

    // Slab edge curb — a low wall (20cm tall, 8cm thick) running along all 4 edges of the slab top.
    // Sits proud of the slab face by the curb thickness, so it's visible from outside.
    // Reads as a concrete kerb / room boundary marker.
    { const curbH = 0.20, curbT = 0.08;
      const curbMat = new THREE.MeshStandardMaterial({ color: 0x5a5855, roughness: 0.9, metalness: 0 });
      const slabTop = -WALL_THICK;
      const x0 = slabCX - slabW/2, x1 = slabCX + slabW/2;
      const z0 = slabCZ - slabD/2, z1 = slabCZ + slabD/2;
      // [boxW, boxD, cx, cz]  — all sit at y = slabTop + curbH/2
      [
        [slabW + curbT*2, curbT, slabCX, z0 - curbT/2],  // north
        [slabW + curbT*2, curbT, slabCX, z1 + curbT/2],  // south
        [curbT, slabD,           x0 - curbT/2, slabCZ],  // west
        [curbT, slabD,           x1 + curbT/2, slabCZ],  // east
      ].forEach(([bw, bd, cx, cz]) => {
        const c = new THREE.Mesh(new THREE.BoxGeometry(bw, curbH, bd), curbMat);
        c.position.set(cx, slabTop + curbH/2, cz);
        c.castShadow = true;
        c.receiveShadow = true;
        addMesh(c);
      }); }

    // Outer ground — sits STEP_H below the top of the pedestal slab.
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x615f5c, roughness: 0.9, metalness: 0 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(gcx, -WALL_THICK - STEP_H, gcz);
    ground.receiveShadow = true;
    addMesh(ground);

    // Faint 1m grid on outer ground — gives spatial scale, reads as an architectural site plan.
    { const groundY = -WALL_THICK - STEP_H;
      const gRange = 20;
      const gx0 = Math.floor(slabCX - gRange), gx1 = Math.ceil(slabCX + gRange);
      const gz0 = Math.floor(slabCZ - gRange), gz1 = Math.ceil(slabCZ + gRange);
      const ogp = [];
      for (let x = gx0; x <= gx1; x++) ogp.push(x, groundY+0.005, gz0,  x, groundY+0.005, gz1);
      for (let z = gz0; z <= gz1; z++) ogp.push(gx0, groundY+0.005, z,  gx1, groundY+0.005, z);
      const ogg = new THREE.BufferGeometry();
      ogg.setAttribute('position', new THREE.Float32BufferAttribute(ogp, 3));
      addMesh(new THREE.LineSegments(ogg, new THREE.LineBasicMaterial({ color: 0x6a6764 }))); }

    // Crisp border line at base of slab — architectural edge definition.
    { const groundY = -WALL_THICK - STEP_H;
      const x0 = slabCX - slabW/2, x1 = slabCX + slabW/2;
      const z0 = slabCZ - slabD/2, z1 = slabCZ + slabD/2;
      const by = groundY + 0.005;
      const bp = [x0,by,z0, x1,by,z0, x1,by,z1, x0,by,z1, x0,by,z0];
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
      addMesh(new THREE.Line(bg, new THREE.LineBasicMaterial({ color: 0x4e4c4a }))); }

    // Studio backdrop walls — sit at the grid boundary (20m from slab center), one on each side.
    // MeshBasicMaterial matches scene background exactly so wall blends into sky seamlessly.
    // Tall enough (25m) to fill the view at any camera angle. DoubleSide so orbit inside the
    // perimeter still shows the wall face.
    // Backdrop walls placed well beyond the camera's max orbit radius (roomMax * 2.2).
    // 38m covers any room up to ~17m wide. Slightly lighter than sky so they read as
    // a surface rather than being invisible.
    { const bdRange = 38;
      const wallH = 30;
      const wallSpan = bdRange * 2;
      const groundY = -WALL_THICK - STEP_H;
      const wallMidY = groundY + wallH / 2;
      const bdMat = new THREE.MeshBasicMaterial({ color: 0xd8d4ce, side: THREE.DoubleSide });
      [
        [slabCX,           slabCZ - bdRange,  0          ], // north
        [slabCX,           slabCZ + bdRange,  Math.PI    ], // south
        [slabCX - bdRange, slabCZ,            Math.PI/2  ], // west
        [slabCX + bdRange, slabCZ,           -Math.PI/2  ], // east
      ].forEach(([cx, cz, ry]) => {
        const bw = new THREE.Mesh(new THREE.PlaneGeometry(wallSpan, wallH), bdMat);
        bw.position.set(cx, wallMidY, cz);
        bw.rotation.y = ry;
        addMesh(bw);
      }); }

    // Ceiling industrial light — warm point light simulating overhead strip fixtures.
    // No castShadow to avoid a second expensive shadow pass. Tracked via addMesh() so
    // it is torn down and recreated with the room geometry on each rebuild.
    const ptLight = new THREE.PointLight(0xfff0d0, 0.45, 25);
    ptLight.position.set(gcx, H - 0.3, gcz);
    addMesh(ptLight);

    if (state.roomMode === 'rect') {
      const W = state.roomW, D = state.roomD;

      // Floor — sealed/epoxy concrete. Sits just below y=0 so containers rest on y=0.
      // Tile texture repeat = (W, D) gives exactly 1 tile per metre — BoxGeometry top-face
      // UV spans [0,1]×[0,1] across width×depth, so repeat drives the tile count directly.
      // roughness reduced to 0.65 (from 0.75) to give a slight polished-concrete sheen.
      { const ft = getFloorTex(); ft.repeat.set(W, D); }
      const floorMesh = new THREE.Mesh(
        new THREE.BoxGeometry(W, WALL_THICK, D),
        new THREE.MeshStandardMaterial({ color: 0xdedad5, roughness: 0.65, metalness: 0, map: getFloorTex() })
      );
      floorMesh.position.set(W/2, -WALL_THICK/2, D/2);
      floorMesh.receiveShadow = true;
      addMesh(floorMesh);

      // Floor expansion joints (1m grid, darker lines)
      const gpts = [];
      for (let i = 0; i <= Math.ceil(W); i++) { gpts.push(i,0.005,0, i,0.005,D); }
      for (let i = 0; i <= Math.ceil(D); i++) { gpts.push(0,0.005,i, W,0.005,i); }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute(gpts, 3));
      addMesh(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0xc4c0bc })));

      // 4 walls — each shifted outward by WALL_THICK/2 so the inner face aligns
      // exactly with the room boundary (0→W, 0→D). This matches the 2D snap system
      // which places container edges at those boundary coordinates.
      const half = WALL_THICK / 2;
      [
        [W,          H, WALL_THICK, W/2,       H/2, -half   ], // north: inner face at z=0
        [WALL_THICK, H, D,          -half,      H/2, D/2     ], // west:  inner face at x=0
        [WALL_THICK, H, D,          W + half,   H/2, D/2     ], // east:  inner face at x=W
        [W,          H, WALL_THICK, W/2,        H/2, D + half], // south: inner face at z=D
      ].forEach(([w,h,d,px,py,pz]) => {
          const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), wallMat.clone());
          m.position.set(px,py,pz);
          m.receiveShadow = true;
          addMesh(m);
        });


      // Inner wall faces — solid planes visible only from inside the room.
      // After rotation.y=angle a PlaneGeometry normal points (sin(angle),0,cos(angle)).
      addInnerWallFace(W/2, 0,   W, 0);            // north: normal +Z
      addInnerWallFace(W/2, D,   W, Math.PI);      // south: normal -Z
      addInnerWallFace(0,   D/2, D, Math.PI/2);    // west:  normal +X
      addInnerWallFace(W,   D/2, D, -Math.PI/2);   // east:  normal -X

      // Baseboards — 8cm tall strip at each wall-floor junction.
      // receiveShadow=true so the sun casts a shadow line at the base of each wall,
      // grounding the room visually. castShadow=false — no shadow-map cost.
      { const bH = 0.08, bD = 0.025;
        const bMat = new THREE.MeshStandardMaterial({ color: 0xb0aba4, roughness: 0.8 });
        [
          [W,    bH, bD,    W/2,       bH/2, bD/2      ], // north (inner face z=0)
          [W,    bH, bD,    W/2,       bH/2, D - bD/2  ], // south (inner face z=D)
          [bD,   bH, D,     bD/2,      bH/2, D/2       ], // west  (inner face x=0)
          [bD,   bH, D,     W - bD/2,  bH/2, D/2       ], // east  (inner face x=W)
        ].forEach(([bw, bh, bd, bx, by, bz]) => {
          const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), bMat);
          b.position.set(bx, by, bz);
          b.receiveShadow = true;
          addMesh(b);
        }); }

      // Edge lines
      [[[0,0,0],[W,0,0],[W,H,0],[0,H,0],[0,0,0]],
       [[0,0,D],[W,0,D],[W,H,D],[0,H,D],[0,0,D]],
       [[0,0,0],[0,0,D],[0,H,D],[0,H,0]],
       [[W,0,0],[W,0,D],[W,H,D],[W,H,0]],
       [[0,H,0],[W,H,0],[W,H,D],[0,H,D],[0,H,0]]
      ].forEach(ps => {
        const geo = new THREE.BufferGeometry();
        const arr = []; ps.forEach(([x,y,z]) => arr.push(x,y,z));
        geo.setAttribute('position', new THREE.Float32BufferAttribute(arr,3));
        addMesh(new THREE.Line(geo, edgeMat));
      });

    } else if (state.roomMode === 'free' && state.polyDone && state.poly.length > 2) {
      const poly = state.poly;
      const shape = new THREE.Shape();
      shape.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i].x, poly[i].y);
      shape.closePath();

      // Floor via ShapeGeometry (XZ plane)
      const floorShape = new THREE.ShapeGeometry(shape);
      const posAttr = floorShape.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i), y = posAttr.getY(i);
        posAttr.setXYZ(i, x, 0, y);
      }
      floorShape.attributes.position.needsUpdate = true;
      floorShape.computeVertexNormals();
      // ShapeGeometry UVs span [0,1]×[0,1] across the shape bounding box.
      // repeat = (roomWidth, roomDepth) gives exactly 1 tile per metre.
      // Bounding box is computed inline here — minX/maxX are declared later for the
      // grid clipping functions, so we avoid a forward-reference error.
      { const ft = getFloorTex();
        const _xs = poly.map(p => p.x), _zs = poly.map(p => p.y);
        ft.repeat.set(Math.max(..._xs) - Math.min(..._xs), Math.max(..._zs) - Math.min(..._zs)); }
      const floorMesh = new THREE.Mesh(floorShape, new THREE.MeshStandardMaterial({ color: 0xdedad5, roughness: 0.65, metalness: 0, side: THREE.DoubleSide, map: getFloorTex() }));
      floorMesh.receiveShadow = true;
      addMesh(floorMesh);

      // Floor expansion joints — same 1m tile grid as rect mode, clipped to the
      // polygon so lines only appear inside the room (handles L-shapes, T-shapes, etc.).
      // Each grid line is intersected against polygon edges; only interior segments drawn.
      const xs2d = poly.map(p => p.x), zs2d = poly.map(p => p.y);
      const minX = Math.min(...xs2d), maxX = Math.max(...xs2d);
      const minZ = Math.min(...zs2d), maxZ = Math.max(...zs2d);

      // Returns sorted X intercepts of a horizontal line at z=zVal with the polygon.
      // Each pair of intercepts [x0,x1] delimits an interior segment.
      function clipHLine(zVal) {
        const hits = [];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i+1) % poly.length];
          if ((a.y <= zVal && b.y > zVal) || (b.y <= zVal && a.y > zVal)) {
            const t = (zVal - a.y) / (b.y - a.y);
            hits.push(a.x + t * (b.x - a.x));
          }
        }
        return hits.sort((a, b) => a - b);
      }
      // Returns sorted Z intercepts of a vertical line at x=xVal with the polygon.
      function clipVLine(xVal) {
        const hits = [];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i+1) % poly.length];
          if ((a.x <= xVal && b.x > xVal) || (b.x <= xVal && a.x > xVal)) {
            const t = (xVal - a.x) / (b.x - a.x);
            hits.push(a.y + t * (b.y - a.y));
          }
        }
        return hits.sort((a, b) => a - b);
      }

      const gpts = [];
      // Horizontal lines (constant z)
      for (let z = Math.ceil(minZ); z <= Math.floor(maxZ); z++) {
        const hits = clipHLine(z);
        for (let j = 0; j + 1 < hits.length; j += 2)
          gpts.push(hits[j], 0.005, z, hits[j+1], 0.005, z);
      }
      // Vertical lines (constant x)
      for (let x = Math.ceil(minX); x <= Math.floor(maxX); x++) {
        const hits = clipVLine(x);
        for (let j = 0; j + 1 < hits.length; j += 2)
          gpts.push(x, 0.005, hits[j], x, 0.005, hits[j+1]);
      }
      if (gpts.length) {
        const gg = new THREE.BufferGeometry();
        gg.setAttribute('position', new THREE.Float32BufferAttribute(gpts, 3));
        addMesh(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0xc4c0bc })));
      }

      // Walls — one per polygon edge, shifted outward by WALL_THICK/2 so inner
      // faces align with the polygon boundary (same coords as the 2D snap system).
      // Outward normal uses the same shoelace winding logic as nearestWall() in app.js.
      const shoelace = poly.reduce((sum, p, i) => {
        const q = poly[(i + 1) % poly.length];
        return sum + p.x * q.y - q.x * p.y;
      }, 0);
      const windSign = shoelace > 0 ? 1 : -1;

      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i+1) % poly.length];
        const dx = b.x - a.x, dz = b.y - a.y;
        const len = Math.sqrt(dx*dx + dz*dz);
        // Outward normal in 3D (canvas x→x, canvas y→z).
        // Inward normal = (windSign*-dz/len, windSign*dx/len); outward = negated.
        const outNx = windSign * dz / len;
        const outNz = -windSign * dx / len;
        const wallGeo = new THREE.BoxGeometry(len, H, WALL_THICK);
        const wall = new THREE.Mesh(wallGeo, wallMat.clone());
        wall.position.set(
          (a.x + b.x) / 2 + outNx * WALL_THICK / 2,
          H / 2,
          (a.y + b.y) / 2 + outNz * WALL_THICK / 2
        );
        wall.rotation.y = -Math.atan2(dz, dx);
        addMesh(wall);
        // Inner face at the polygon boundary (no outward offset). For windSign=1 the
        // wall's rotation already makes the plane normal point inward; flip π for CW.
        addInnerWallFace(
          (a.x + b.x) / 2,
          (a.y + b.y) / 2,
          len,
          -Math.atan2(dz, dx) + (windSign < 0 ? Math.PI : 0)
        );

        // Baseboard along the inner face of this wall segment.
        // Placed at the polygon boundary (inward side), same rotation as the wall.
        // castShadow=false — no shadow-map cost; receiveShadow=true for depth.
        { const bH = 0.08, bD = 0.025;
          const inNx = -outNx, inNz = -outNz;
          const board = new THREE.Mesh(
            new THREE.BoxGeometry(len, bH, bD),
            new THREE.MeshStandardMaterial({ color: 0xb0aba4, roughness: 0.8 })
          );
          board.position.set(
            (a.x + b.x) / 2 + inNx * bD / 2,
            bH / 2,
            (a.y + b.y) / 2 + inNz * bD / 2
          );
          board.rotation.y = -Math.atan2(dz, dx);
          board.receiveShadow = true;
          addMesh(board); }

        // Edge lines for this wall
        const ep = [[a.x,0,a.y],[b.x,0,b.y],[b.x,H,b.y],[a.x,H,a.y],[a.x,0,a.y]];
        const eg = new THREE.BufferGeometry();
        const ea = []; ep.forEach(([x,y,z]) => ea.push(x,y,z));
        eg.setAttribute('position', new THREE.Float32BufferAttribute(ea,3));
        addMesh(new THREE.Line(eg, edgeMat));
      }

      // Corner caps — a WALL_THICK×H×WALL_THICK cube at each vertex fills the gap
      // (or overlap) between adjacent rotated wall boxes. Works at any angle; no
      // rotation needed since the cap is square in XZ. Same wallMat as the walls.
      for (const p of poly) {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(WALL_THICK, H, WALL_THICK), wallMat.clone());
        cap.position.set(p.x, H / 2, p.y);
        addMesh(cap);
      }

      // Orbit is initialized in resetOrbit() / setAngle() — not here.
      // Modifying orbit inside buildRoom() resets the camera on every rebuild
      // (e.g. nudgeSkilt), which would undo any user camera positioning.
    }

    // Inner partition walls — drawn by the user with the 'innerwall' tool.
    // Runs after both rect and free blocks so it works in either room mode.
    // Stored as absolute room coords (x1,y1)→(x2,y2) in metres (canvas XY → Three XZ).
    // Same thickness as outer walls so junctions look consistent.
    state.items.filter(i => i.kind === 'innerwall').forEach(iw => {
      const ax = iw.x1, az = iw.y1, bx = iw.x2, bz = iw.y2;
      const dx = bx - ax, dz = bz - az;
      const len = Math.sqrt(dx*dx + dz*dz);
      if (len < 0.01) return;
      const geo = new THREE.BoxGeometry(len, H, WALL_THICK);
      const wall = new THREE.Mesh(geo, wallMat.clone());
      wall.position.set((ax + bx) / 2, H / 2, (az + bz) / 2);
      wall.rotation.y = -Math.atan2(dz, dx);
      addMesh(wall);
    });
  }

  // ── Skilt (sorteringsmerke) ───────────────────────────────────────────
  const _skilt3dTexCache = {};

  // Offisielle sortere.no PNG-ikoner lastet via R2-proxy
  const SKILT_STYLE = {
    'sk-rest':       { label: 'Restavfall',                r2: 'Restavfall_web.png'             },
    'sk-mat':        { label: 'Matavfall',                 r2: 'Matavfall_web.png'              },
    'sk-glass':      { label: 'Glass og metallemballasje', r2: 'Glass_metallemballasje_web.png' },
    'sk-papir':      { label: 'Papp og Papir',             r2: 'Papp_og_papir_web.png'          },
    'sk-papp':       { label: 'Papp',                      r2: 'Papp_web.png'                   },
    'sk-plast':      { label: 'Plastemballasje',           r2: 'Plastemballasje_web.png'        },
    'sk-plastfolie': { label: 'Plastfolie',                r2: 'Plastfolie_web.png'             },
    'sk-metall':     { label: 'Metall',                    r2: 'Jern_og_metaller_web.png'       },
    'sk-eps':        { label: 'EPS',                       r2: 'EPS_web.png'                    },
    'sk-farlig':     { label: 'Farlig avfall',             r2: 'Farlig_avfall_web.png'          },
    'sk-ee':         { label: 'EE-avfall',                 r2: 'Elektronikk_web.png'            },
    'sk-batterier':    { label: 'Batterier',               r2: 'Batterier_web.png'              },
    'sk-lysstoffror':  { label: 'Lysstoffrør',             r2: 'Lysstoffror_web.png'            },
    'sk-tonerkassett': { label: 'Tonerkassett',            r2: 'Tonerkassett_web.png'           },
    'sk-frityrolje':   { label: 'Frityrolje',              r2: 'Frityrolje_web.png'             },
    'sk-porselen':     { label: 'Porselen',                r2: 'Porselen_web.png'               },
    'sk-lysparer':     { label: 'Lyspærer',                r2: 'Lysparer_web.png'               },
    'sk-spraybokser':  { label: 'Spraybokser',             r2: 'Spraybokser_web.png'            },
    'sk-papir2':       { label: 'Papir',                   r2: 'Papir_web.png'                  },
  };

  function makeSkiltTexture(typeId) {
    const S = SKILT_STYLE[typeId] || { label: typeId, iconUrl: null };
    const SZ = 512;
    const ICON_H = Math.round(SZ * 0.75);
    const LABEL_H = SZ - ICON_H;

    const c = document.createElement('canvas');
    c.width = SZ; c.height = SZ;
    const ctx = c.getContext('2d');
    const tex = new THREE.CanvasTexture(c);

    function drawLabel() {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, ICON_H, SZ, LABEL_H);
      ctx.fillStyle = '#1a1a1a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const words = S.label.split(' ');
      if (words.length > 1 && ctx.measureText(S.label).width > SZ * 0.88) {
        ctx.font = `bold ${Math.round(LABEL_H * 0.37)}px Arial, sans-serif`;
        ctx.fillText(words[0], SZ/2, ICON_H + LABEL_H * 0.28);
        ctx.fillText(words.slice(1).join(' '), SZ/2, ICON_H + LABEL_H * 0.70);
      } else {
        ctx.font = `bold ${Math.round(LABEL_H * 0.42)}px Arial, sans-serif`;
        ctx.fillText(S.label, SZ/2, ICON_H + LABEL_H * 0.5);
      }
      tex.needsUpdate = true;
    }

    // Option 1: inline canvas drawing (ee, blandet etc)
    if (S.drawIcon) {
      ctx.fillStyle = S.bg || '#444';
      ctx.fillRect(0, 0, SZ, ICON_H);
      S.drawIcon(ctx, SZ, ICON_H);
      drawLabel();
      return tex;
    }

    // Option 2: R2 full-image PNG (sortere.no offisielle skilt) — tegnes over hele canvas
    if (S.r2) {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, SZ, SZ); tex.needsUpdate = true; };
      img.onerror = () => { ctx.fillStyle = '#555'; ctx.fillRect(0, 0, SZ, SZ); drawLabel(); };
      img.src = `/r2/${S.r2}`;
      return tex;
    }

    // Option 3: URL — GPN SVG-ikoner direkte
    const url = S.iconUrl || null;
    if (url) {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, SZ, ICON_H); drawLabel(); };
      img.onerror = () => { ctx.fillStyle = S.bg || '#555'; ctx.fillRect(0, 0, SZ, ICON_H); drawLabel(); };
      img.src = url;
    } else {
      ctx.fillStyle = S.bg || '#555';
      ctx.fillRect(0, 0, SZ, ICON_H);
    }
    drawLabel();
    return tex;
  }

  /**
   * Legacy fallback — only called for sketches saved before wall info was stored.
   * Prefer using _wallNx/_wallNy/_wallX/_wallY stored on the item at placement time.
   */
  function getSkiltWallInfo(it) {
    const cx = it.x, cz = it.y;
    const offset = it.wallOffset || 0;
    if (state.roomMode === 'rect') {
      const W = state.roomW, D = state.roomD;
      // nx/nz = inward normals (into the room), wx/wz = point on wall surface
      const dists = [
        { nx:0,  nz:1,  wx: cx, wz: 0,      d: cz   },  // north wall, inward = +Z
        { nx:0,  nz:-1, wx: cx, wz: D,      d: D-cz },  // south wall, inward = -Z
        { nx:1,  nz:0,  wx: 0,  wz: cz,     d: cx   },  // west wall,  inward = +X
        { nx:-1, nz:0,  wx: W,  wz: cz,     d: W-cx },  // east wall,  inward = -X
      ];
      return dists.reduce((a,b) => a.d < b.d ? a : b);
    }
    // Free mode: compute from polygon at runtime
    const pts = state.poly;
    if (pts && pts.length > 2) {
      // Use winding order to determine inward normals — avoids centroid-based flipping
      // which fails for concave rooms (L/U/T-shapes) where the centroid can fall outside
      // the polygon. For a CW polygon on a Y-down canvas (shoelace > 0), the default
      // left-perpendicular (-ey, ex) already points INWARD, so sign = +1. For CCW
      // (shoelace < 0) it points outward, so we flip with sign = -1.
      const shoelace = pts.reduce((sum, p, i) => {
        const q = pts[(i + 1) % pts.length];
        return sum + p.x * q.y - q.x * p.y;
      }, 0);
      const sign = shoelace > 0 ? 1 : -1;
      let best = null;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i+1)%pts.length];
        const ex = b.x-a.x, ey = b.y-a.y, len2 = ex*ex+ey*ey;
        if (len2 < 1e-9) continue;
        const t = Math.max(0, Math.min(1, ((cx-a.x)*ex+(cz-a.y)*ey)/len2));
        const wx = a.x+t*ex, wy = a.y+t*ey;
        const dist = Math.hypot(cx-wx, cz-wy);
        const len = Math.sqrt(len2);
        const nx = sign * (-ey/len), ny = sign * (ex/len);
        if (!best || dist < best.dist) best = { dist, wx, wy, nx, ny };
      }
      if (best) return { nx: best.nx, nz: best.ny, wx: best.wx + offset * Math.abs(best.ny), wz: best.wy + offset * Math.abs(best.nx) };
    }
    return { nx:0, nz:-1, wx: cx, wz: 0.03 };
  }

  function buildSkilt3D(it) {
    if (!it.def) return;
    const sz = it.size || 0.65;
    let mountH = it.wallH;
    if (mountH === undefined) {
      // Fallback: standard 1.6m center height, raised if linked container top overlaps sign bottom
      const linked = it._linkedTo !== undefined
        ? state.items.find(c => c.kind === 'container' && c.id === it._linkedTo)
        : null;
      if (linked) {
        const binH = linked.def.H / 1000;
        mountH = binH > (1.6 - sz / 2) ? binH + sz / 2 + 0.05 : 1.6;
      } else {
        mountH = 1.6;
      }
    }
    // Prefer wall info stored at placement time over live recomputation.
    // _wallNy (canvas Y, down) maps to Three.js Z — stored as nz here.
    // Recomputing via getSkiltWallInfo() can disagree with placement-time values
    // if the container was later moved or the polygon edited.
    let wi;
    if (it._wallNx !== undefined) {
      wi = { nx: it._wallNx, nz: it._wallNy, wx: it._wallX, wz: it._wallY };
    } else {
      wi = getSkiltWallInfo(it); // legacy fallback
    }

    // Validate that the normal points INWARD (from wall surface toward the container).
    // Stored normals from before the winding-order fix pointed outward, which placed
    // the sign on the outside of the wall. Flipping when dot < 0 self-heals stale data.
    const deltaX = it.x - wi.wx;
    const deltaZ = it.y - wi.wz;
    if (wi.nx * deltaX + wi.nz * deltaZ < 0) {
      wi.nx = -wi.nx;
      wi.nz = -wi.nz;
    }

    const key = it.typeId;
    if (!_skilt3dTexCache[key]) {
      _skilt3dTexCache[key] = makeSkiltTexture(it.typeId, it.def.name || it.typeId);
    }
    const texture = _skilt3dTexCache[key];

    // Mounting plate frame — MeshStandardMaterial responds to directional lighting (Lambert
    // was flat). roughness 0.3 + metalness 0.1 reads as semi-gloss plastic/aluminium bracket.
    // castShadow = true so the frame casts a visible shadow on the wall, giving depth.
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(sz + 0.04, sz + 0.04, 0.014),
      new THREE.MeshStandardMaterial({ color: 0xefefef, roughness: 0.3, metalness: 0.1 })
    );

    // Sign icon/texture — floats in front of frame face to avoid z-fighting
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(sz, sz),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide })
    );
    face.position.z = 0.009;

    // Back face — same texture, rotated 180° so it appears correct (not mirrored) from behind
    const backFace = new THREE.Mesh(
      new THREE.PlaneGeometry(sz, sz),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide })
    );
    backFace.position.z = -0.009;
    backFace.rotation.y = Math.PI;

    const group = new THREE.Group();
    group.add(frame);
    group.add(face);
    group.add(backFace);

    // Place sign on inner wall surface.
    // wi.wx/wz is on the polygon boundary = inner wall face (walls are pushed outward by WALL_THICK/2
    // so their inner faces align with the polygon boundary). We only need frame half-depth + clearance.
    // WALL_THICK/2 was here before the wall-push fix (commit 0b07aec) when wi.wx/wz was the wall center.
    const wallThick = 0.007 + 0.028; // frame half-depth (0.007) + 28mm clearance = 35mm proud of wall, casts shadow
    // wallOffset slides the sign left/right along the wall surface (tangent = perpendicular to normal).
    // Tangent of (nx, nz) is (-nz, nx). wallOffset is stored in metres.
    const sideOffset = it.wallOffset || 0;
    const posX = wi.wx + wi.nx * wallThick + sideOffset * (-wi.nz);
    const posZ = wi.wz + wi.nz * wallThick + sideOffset * wi.nx;
    group.position.set(posX, mountH, posZ);
    group.lookAt(posX + wi.nx, mountH, posZ + wi.nz);

    addMesh(group);
    _skiltMeshMap.push({ mesh: group, id: it.id });
  }

  function buildContainer(it, skipGLB = false) {
    const def = it.def;
    const W = def.W / 1000, D = def.D / 1000, H = def.H / 1000;
    const cx = it.x, cz = it.y;
    const rot = it.rot || 0;

    if (def.type === 'cage' || def.type === 'rollcage') {
      buildCage3D(W, D, H, cx, cz, rot);
      return;
    }

    // Blob contact shadow — placed before the GLB branch so it appears regardless
    // of whether the async GLB load succeeds or falls back to procedural geometry.
    addBlobShadow(cx, cz, W, D);

    // ── GLB models — proxied via local server to avoid CORS ──────────
    // v=2: cache-bust so Cloudflare R2 CDN and the Python proxy both serve fresh files
    const R2 = '/r2';
    const GLB_V = '?v=3';
    const GLB_MODELS = {
      '140L':  `${R2}/140L.glb${GLB_V}`,
      '240L':  `${R2}/240.glb${GLB_V}`,
      '360L':  `${R2}/360.glb${GLB_V}`,
      '360LG': `${R2}/360.glb${GLB_V}`,
      '660L':  `${R2}/660L.glb${GLB_V}`,
      '660LG': `${R2}/660L.glb${GLB_V}`,
      '1000L': `${R2}/1000L.glb${GLB_V}`,
      'BALEX':     `${R2}/Balex.glb${GLB_V}`,
      'BALEX10':   `${R2}/Balex.glb${GLB_V}`,
      'ORWAK3420': `${R2}/orwak_3420.glb?v=2`,
      'KOMP400L':  `${R2}/400L_komp.glb`,
      // Machines — GLBs with baked textures (no material replacement; see texture-preserve branch below)
      'ORWAK5070':   `${R2}/Orwak_Multi_5070.glb`,
      'OW5070COMBI': `${R2}/OW5070_combi_restavfall.glb?v=9`,
      'ENVIROPAC':   `${R2}/EnviroPac-Kjøler.glb`,
      'APS800':      `${R2}/APS_800.glb`,
      '800LSTATIV':  `${R2}/800l-stativ.glb`,
      '60LFAT':      `${R2}/60L_fat.glb`,
      '200LFAT':     `${R2}/200L-Fat.glb`,
      '200LSEKKE':   `${R2}/200L_sekkestativ.glb`,
      'PALL':        `${R2}/pall.glb`,
    };

    if (!skipGLB && GLB_MODELS[def.id]) {
      // glbSwapWD: some GLBs have their width/depth axes transposed relative to our
      // convention (Three.js X = room width, Z = room depth). Swapping here fixes 3D
      // scaling without touching the 2D footprint which uses the DEFS values directly.
      const [glbW, glbD] = def.glbSwapWD ? [D, W] : [W, D];
      // glb3dD: overrides targetD for loadGLB only — used when the GLB bounding box
      // in Z is larger than D (e.g. door baked open inflates depth). Setting glb3dD to
      // the raw GLB Z extent gives scale.z=1 (no compression), so the machine body
      // renders at correct depth. 2D footprint still uses D from DEFS unchanged.
      const glb3dD = def.glb3dD || glbD;
      loadGLB(GLB_MODELS[def.id], glbW, H, glb3dD, def.glbModelRotY || 0, (model) => {
        if (!model) {
          buildContainerFallback(it); return;
        }
        // glbDebug: logs all mesh names to console — use temporarily to identify mesh names
        // for glbHideMeshNames (e.g. open door parts that inflate the bounding box)
        if (def.glbDebug) {
          console.group('GLB mesh names for ' + def.id);
          model.traverse(c => { if (c.isMesh) console.log(c.name); });
          console.groupEnd();
        }

        if (def.type === 'compactor' || def.type === 'machine' || def.glbKeepMat) {
          // GLBs with baked textures — preserve albedo map (map) so the texture shows,
          // but strip metalness/roughness maps and force fully matte PBR values.
          // metalnessMap/roughnessMap in the GLB override scalar values and cause
          // the metallic sheen even when metalness=0 — clearing them is the only fix.
          model.traverse(child => {
            if (!child.isMesh) return;
            child.material = child.material.clone();
            child.material.metalness     = 0;
            child.material.roughness     = 0.9;   // force matte — ignore GLB roughness
            child.material.metalnessMap  = null;  // PBR maps override scalars; must clear
            child.material.roughnessMap  = null;
            child.material.envMapIntensity = 0;
            child.material.needsUpdate   = true;
          });
        } else {
          // Regular containers: clone the GLB's own MeshStandardMaterial and force it to
          // render as flat dark anthracite. Keeping MeshStandardMaterial (rather than
          // replacing with MeshPhongMaterial) avoids normal/shading conflicts with the
          // new low-poly GLB geometry. metalness=0 + roughness=0.85 gives correct matte
          // plastic look under directional lights without an environment map.
          model.traverse(child => {
            if (!child.isMesh) return;
            child.material = child.material.clone();
            child.material.color.setHex(0x23272B); // dark anthracite — matches NG containers
            child.material.map      = null;         // clear any baked texture
            child.material.metalness = 0;           // metalness > 0 appears black without envmap
            child.material.roughness = 0.85;        // near-matte plastic
            child.material.envMapIntensity = 0;
          });

          if (def.type.includes('glass')) {
            // Override lid parts with glass blue regardless of fraksjon
            model.traverse(child => {
              if (child.isMesh) {
                const b = new THREE.Box3().setFromObject(child);
                if (b.min.y > H * 0.65) {
                  child.material = child.material.clone();
                  child.material.color.setHex(0x1a55aa);
                }
              }
            });
          }
        }
        // Center model at origin, bottom at y=0, then wrap for positioning/rotation
        model.position.set(0, 0, 0);
        model.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(model);
        const bCx = (b.min.x + b.max.x) / 2;
        const bCz = (b.min.z + b.max.z) / 2;
        model.position.set(-bCx, -b.min.y, -bCz);
        const wrapper = new THREE.Group();
        wrapper.add(model);
        wrapper.position.set(cx, 0, cz);
        // glbExtraWrapperRot: per-model offset to compensate GLB axis orientation mismatches (e.g. OW5070COMBI)
        wrapper.rotation.y = Math.PI - rot + (def.glbExtraWrapperRot || 0);
        setShadow(wrapper, false, false);
        addMesh(wrapper);
      }, def.glbHideMeshNames || []);
      return;
    }

    const isGlass  = def.type.includes('glass');
    const is4wheel = def.wheels === 4;
    const group    = new THREE.Group();

    const NG_ORANGE = 0xe8521a;
    // All containers use the same body color in 3D regardless of fraksjon.
    const BODY_COL  = 0x23272B;
    const LID_COL   = isGlass ? 0x1a55aa : 0x23272B;
    const m = (c, s=40) => new THREE.MeshPhongMaterial({ color:c, shininess:s, specular:0x222222 });

    // ── Dimensions ───────────────────────────────────────────────────
    // Wheel radius — sits on Y=0 ground
    const wr = is4wheel ? 0.060 : 0.075;
    const wt = is4wheel ? 0.042 : 0.038; // tyre thickness
    // Bin body starts above wheels
    const floorY  = wr * 2;          // bottom of body
    const bodyH   = H - floorY - H * 0.10;  // leave room for lid
    const topY    = floorY + bodyH;

    // Body is a simple box — no taper to avoid geometry bugs
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, bodyH, D), m(BODY_COL, 30));
    body.position.set(0, floorY + bodyH/2, 0);
    group.add(body);

    // Collar ring at top of body
    const collar = new THREE.Mesh(new THREE.BoxGeometry(W+0.012, 0.025, D+0.012), m(0x111111, 20));
    collar.position.set(0, topY - 0.012, 0);
    group.add(collar);

    // ── LID ──────────────────────────────────────────────────────────
    const lidH = H * 0.09;
    const lid1 = new THREE.Mesh(new THREE.BoxGeometry(W+0.020, lidH*0.35, D+0.020), m(LID_COL, 80));
    lid1.position.set(0, topY + lidH*0.175, 0);
    group.add(lid1);

    const lid2 = new THREE.Mesh(new THREE.BoxGeometry(W+0.006, lidH*0.45, D+0.006), m(LID_COL, 80));
    lid2.position.set(0, topY + lidH*0.35 + lidH*0.225, 0);
    group.add(lid2);

    const lid3 = new THREE.Mesh(new THREE.BoxGeometry(W*0.90, lidH*0.25, D*0.90), m(LID_COL, 80));
    lid3.position.set(0, topY + lidH*0.80 + lidH*0.125, 0);
    group.add(lid3);

    const lidTop = topY + lidH;

    // ── LID HANDLE ───────────────────────────────────────────────────
    const hm = m(0x0d0d0d, 60);
    if (is4wheel) {
      // Two side handles
      [-W*0.28, W*0.28].forEach(hx => {
        const lA = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.042, 0.018), hm);
        lA.position.set(hx, lidTop + 0.021, -0.020); group.add(lA);
        const lB = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.042, 0.018), hm);
        lB.position.set(hx, lidTop + 0.021,  0.020); group.add(lB);
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.050), hm);
        bar.position.set(hx, lidTop + 0.040, 0); group.add(bar);
      });
    } else {
      // Single top handle
      const hW = W * 0.26;
      const lA = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.038, 0.020), hm);
      lA.position.set(-hW/2, lidTop + 0.019, 0); group.add(lA);
      const lB = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.038, 0.020), hm);
      lB.position.set( hW/2, lidTop + 0.019, 0); group.add(lB);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(hW, 0.020, 0.020), hm);
      bar.position.set(0, lidTop + 0.036, 0); group.add(bar);
    }

    // ── NG LOGO ───────────────────────────────────────────────────────
    const ls = Math.min(W*0.22, 0.13);
    const logo = new THREE.Mesh(new THREE.BoxGeometry(ls, ls, 0.015), m(NG_ORANGE, 60));
    logo.position.set(0, floorY + bodyH*0.52, -D/2 - 0.009);
    group.add(logo);

    // ── BASE PLATE ────────────────────────────────────────────────────
    const base = new THREE.Mesh(new THREE.BoxGeometry(W - 0.02, floorY, D - 0.02), m(0x111111, 10));
    base.position.set(0, floorY/2, 0);
    group.add(base);

    // ── WHEELS ────────────────────────────────────────────────────────
    if (is4wheel) {
      const GOLD = 0xaa8010;
      const positions = [
        [-W/2+0.08, -D/2+0.08], [ W/2-0.08, -D/2+0.08],
        [-W/2+0.08,  D/2-0.08], [ W/2-0.08,  D/2-0.08],
      ];
      positions.forEach(([wx, wz]) => {
        const wg = new THREE.Group();
        // Castor housing
        const fork = new THREE.Mesh(new THREE.BoxGeometry(wt*1.1, wr*0.7, wr*0.5), m(GOLD, 70));
        fork.position.set(0, wr*0.55, 0); wg.add(fork);
        // Tyre
        const tyre = new THREE.Mesh(new THREE.CylinderGeometry(wr, wr, wt, 16), m(0x111111, 5));
        tyre.rotation.z = Math.PI/2; wg.add(tyre);
        // Hub
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(wr*0.35, wr*0.35, wt*1.1, 10), m(GOLD, 90));
        hub.rotation.z = Math.PI/2; wg.add(hub);
        wg.position.set(wx, wr, wz);
        group.add(wg);
      });

    } else {
      // 2-wheel bins: large wheels at REAR (+Z), small glide foot at front (-Z)
      const axleZ = D/2 - wr * 0.5;
      [-W/2 + 0.045, W/2 - 0.045].forEach(wx => {
        const wg = new THREE.Group();
        const tyre = new THREE.Mesh(new THREE.CylinderGeometry(wr, wr, wt, 18), m(0x111111, 5));
        tyre.rotation.z = Math.PI/2; wg.add(tyre);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(wr*0.35, wr*0.35, wt*1.1, 10), m(0x888888, 80));
        hub.rotation.z = Math.PI/2; wg.add(hub);
        // 4 spokes
        for (let s = 0; s < 4; s++) {
          const spk = new THREE.Mesh(new THREE.BoxGeometry(wr*0.08, wr*0.58, wt*0.2), m(0x666666, 40));
          spk.rotation.z = s * Math.PI/4; wg.add(spk);
        }
        wg.position.set(wx, wr, axleZ);
        group.add(wg);
      });
      // Axle rod
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, W*0.52, 8), m(0x777777, 60));
      axle.rotation.z = Math.PI/2;
      axle.position.set(0, wr, axleZ);
      group.add(axle);
      // Push bar at rear (+Z)
      const pbZ = D/2 + 0.010;
      const pbm = m(0x111111, 50);
      [-W*0.22, W*0.22].forEach(px => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.080, 0.022), pbm);
        leg.position.set(px, topY - 0.040, pbZ); group.add(leg);
      });
      const pbBar = new THREE.Mesh(new THREE.BoxGeometry(W*0.46, 0.024, 0.036), pbm);
      pbBar.position.set(0, topY - 0.002, pbZ); group.add(pbBar);
      // Glide foot at front (-Z)
      const foot = new THREE.Mesh(new THREE.BoxGeometry(W*0.28, 0.020, 0.050), m(0x222222, 15));
      foot.position.set(0, 0.010, -D/2 + 0.030);
      group.add(foot);
    }

    group.position.set(cx, 0, cz);
    group.rotation.y = -rot;
    setShadow(group, false, false);
    addMesh(group);
  }

  // Alias so GLB path can fall back to hand-coded version
  function buildContainerFallback(it) { buildContainer(it, true); }

  function buildCage3D(W, D, H, cx, cz, rot) {
    addBlobShadow(cx, cz, W, D);
    const group = new THREE.Group();
    const barR = 0.015; // bar radius
    const barMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
    const postMat = new THREE.MeshLambertMaterial({ color: 0x555555 });

    // Floor plate
    const floor = box(W, 0.04, D, 0x999999);
    floor.position.set(0, 0.02, 0);
    group.add(floor);

    // Corner posts
    const postH = H;
    [[W/2, D/2],[-W/2, D/2],[W/2,-D/2],[-W/2,-D/2]].forEach(([px,pz]) => {
      const postGeo = new THREE.CylinderGeometry(0.03, 0.03, postH, 6);
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(px, postH/2, pz);
      group.add(post);
    });

    // Horizontal rails on each face (4 faces, 3 rails each)
    const railH = [H*0.25, H*0.55, H*0.88];
    railH.forEach(ry => {
      // front/back rails (along X)
      [-D/2, D/2].forEach(pz => {
        const rGeo = new THREE.CylinderGeometry(barR, barR, W, 4);
        const r = new THREE.Mesh(rGeo, barMat);
        r.rotation.z = Math.PI/2;
        r.position.set(0, ry, pz);
        group.add(r);
      });
      // side rails (along Z)
      [-W/2, W/2].forEach(px => {
        const rGeo = new THREE.CylinderGeometry(barR, barR, D, 4);
        const r = new THREE.Mesh(rGeo, barMat);
        r.rotation.x = Math.PI/2;
        r.position.set(px, ry, 0);
        group.add(r);
      });
    });

    // Vertical bars on front and back faces
    const vCols = Math.max(3, Math.round(W / 0.25));
    for (let i = 1; i < vCols; i++) {
      const px = -W/2 + (W / vCols) * i;
      [-D/2, D/2].forEach(pz => {
        const vGeo = new THREE.CylinderGeometry(barR*0.8, barR*0.8, H*0.88, 4);
        const v = new THREE.Mesh(vGeo, barMat);
        v.position.set(px, H*0.44, pz);
        group.add(v);
      });
    }
    // Vertical bars on side faces
    const sCols = Math.max(2, Math.round(D / 0.25));
    for (let i = 1; i < sCols; i++) {
      const pz = -D/2 + (D / sCols) * i;
      [-W/2, W/2].forEach(px => {
        const vGeo = new THREE.CylinderGeometry(barR*0.8, barR*0.8, H*0.88, 4);
        const v = new THREE.Mesh(vGeo, barMat);
        v.position.set(px, H*0.44, pz);
        group.add(v);
      });
    }

    // Top frame
    const topMat = new THREE.MeshLambertMaterial({ color: 0x666666 });
    [[-W/2, D/2],[W/2,-D/2]].forEach(([px,pz]) => {
      const tGeo = new THREE.CylinderGeometry(barR*1.2, barR*1.2, W, 4);
      const t = new THREE.Mesh(tGeo, topMat);
      t.rotation.z = Math.PI/2; t.position.set(0, H, pz); group.add(t);
      const t2 = new THREE.Mesh(new THREE.CylinderGeometry(barR*1.2, barR*1.2, D, 4), topMat);
      t2.rotation.x = Math.PI/2; t2.position.set(px, H, 0); group.add(t2);
    });

    // EE warning label (orange plate on front)
    const badge = box(W*0.3, H*0.06, 0.01, 0xe8521a);
    badge.position.set(0, H*0.65, D/2 + 0.01);
    group.add(badge);

    // Wheels
    const wr = 0.055;
    [[W/2-wr, D/2-wr],[-W/2+wr, D/2-wr],[W/2-wr,-D/2+wr],[-W/2+wr,-D/2+wr]].forEach(([wx,wz]) => {
      const wGeo = new THREE.CylinderGeometry(wr, wr, 0.04, 10);
      const wheel = new THREE.Mesh(wGeo, new THREE.MeshLambertMaterial({color: 0x111111}));
      wheel.rotation.x = Math.PI/2; wheel.position.set(wx, wr, wz);
      group.add(wheel);
    });

    group.position.set(cx, 0, cz);
    group.rotation.y = -rot;
    setShadow(group, false, false);
    addMesh(group);
  }

  function buildWallEl(it) {
    const def = it.def;
    const W = def.W / 1000, D = def.D / 1000;
    const cx = it.x, cz = it.y;
    const rot = it.rot || 0;

    if (def.type === 'door' || def.type === 'window') {
      const isDoor = def.type === 'door';
      const frameH = isDoor ? 2.1 : 1.1;
      const floorY = isDoor ? 0 : 0.9;
      const g = new THREE.Group();

      // All geometry uses WALL_THICK as depth so elements span the full wall.
      // DoubleSide makes them visible from inside and outside the room.
      // _outNx/_outNy (stored on mouseup) lets us offset the group to the wall center.
      // Door frame matches wall color — architectural opening style, no brown.
      // The door reads as a void/gap in the wall, which is cleaner than a coloured frame
      // and consistent with how CAD/planning tools represent door openings.
      const frameSide = new THREE.MeshLambertMaterial({ color: 0xb8b4ae, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
      const openMat   = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.04, side: THREE.DoubleSide, depthWrite: false });

      if (isDoor) {
        const FRAME_W = 0.06;
        const halves  = def.double ? 2 : 1;
        const leafW   = (W - FRAME_W * (halves + 1)) / halves;
        const leafH   = frameH - FRAME_W;

        // Frame: top rail + side stiles (+ centre stile for double door) — wall-coloured
        g.add(placed(new THREE.Mesh(new THREE.BoxGeometry(W,            FRAME_W, WALL_THICK), frameSide.clone()), 0,                    frameH - FRAME_W / 2, 0));
        g.add(placed(new THREE.Mesh(new THREE.BoxGeometry(FRAME_W,      frameH,  WALL_THICK), frameSide.clone()), -W / 2 + FRAME_W / 2, frameH / 2,           0));
        g.add(placed(new THREE.Mesh(new THREE.BoxGeometry(FRAME_W,      frameH,  WALL_THICK), frameSide.clone()),  W / 2 - FRAME_W / 2, frameH / 2,           0));
        if (def.double) g.add(placed(new THREE.Mesh(new THREE.BoxGeometry(FRAME_W, frameH, WALL_THICK), frameSide.clone()), 0, frameH / 2, 0));

        // Opening — near-invisible panel, just enough to occlude geometry behind the gap
        const knobMat = new THREE.MeshPhongMaterial({ color: 0xaaaaaa, shininess: 80, specular: 0x444444 });
        for (let i = 0; i < halves; i++) {
          const lx = -W / 2 + FRAME_W + leafW / 2 + i * (leafW + FRAME_W);
          g.add(placed(new THREE.Mesh(new THREE.BoxGeometry(leafW, leafH, WALL_THICK), openMat.clone()), lx, leafH / 2, 0));
          // Door knob — on the latch side at 1.0m height.
          // Single door: latch on the right. Double door: both leaves latch toward centre
          // so the knobs meet in the middle (leaf 0 right, leaf 1 left).
          const latchDir = def.double ? (i === 0 ? 1 : -1) : 1;
          const latchX = lx + latchDir * (leafW / 2 - FRAME_W - 0.04);
          g.add(placed(new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), knobMat), latchX, 1.0,  WALL_THICK / 2 + 0.01));
          g.add(placed(new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), knobMat), latchX, 1.0, -WALL_THICK / 2 - 0.01));
        }
      } else {
        // Window: blue frame spanning full wall thickness, transparent glass inset
        const winFrame = new THREE.MeshLambertMaterial({ color: 0x4a7fa8, side: THREE.DoubleSide });
        const winGlass = new THREE.MeshLambertMaterial({ color: 0xd4eaf7, transparent: true, opacity: 0.40, side: THREE.DoubleSide, depthWrite: false });
        g.add(placed(new THREE.Mesh(new THREE.BoxGeometry(W,        frameH,        WALL_THICK),        winFrame), 0, floorY + frameH / 2, 0));
        // Glass pane slightly thicker than frame to avoid z-fighting on faces
        g.add(placed(new THREE.Mesh(new THREE.BoxGeometry(W * 0.88, frameH * 0.82, WALL_THICK + 0.01), winGlass), 0, floorY + frameH / 2, 0));
      }

      // Center element in wall thickness using outward normal stored on drag.
      // Falls back to inner-face placement for existing saves without _outNx/_outNy.
      const outNx = it._outNx || 0, outNz = it._outNy || 0;
      g.position.set(cx + outNx * WALL_THICK / 2, 0, cz + outNz * WALL_THICK / 2);
      g.rotation.y = -rot;
      addMesh(g);
    } else if (def.type === 'pillar') {
      const pillar = box(W, state.roomH, D, 0x888888);
      pillar.position.set(cx, state.roomH / 2, cz);
      addMesh(pillar);
    }
  }

  function resize() {
    if (!initialized) return;
    const container = document.getElementById('canvas-3d');
    const W = container.clientWidth, H = container.clientHeight;
    renderer.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  }

  function nudgeSkilt(id, dir) {
    const it = state.items.find(i => i.id === id && i.kind === 'skilt');
    if (!it) return;
    const step = 0.05;
    if (it.wallH === undefined) it.wallH = 1.6;
    if (it.wallOffset === undefined) it.wallOffset = 0;
    if (dir === 'up')    it.wallH      += step;
    if (dir === 'down')  it.wallH      = Math.max(0.05, it.wallH - step);
    if (dir === 'left')  it.wallOffset -= step;
    if (dir === 'right') it.wallOffset += step;
    rebuild();
    // Update height label in overlay
    const lbl = document.getElementById('skilt3d-h-lbl');
    if (lbl) lbl.textContent = it.wallH.toFixed(2) + 'm';
  }

  // Renders the scene from directly overhead using an OrthographicCamera and returns
  // a PNG data URL for use in PDF export. OrthographicCamera removes perspective
  // distortion so the top-down view matches the 2D canvas coordinate system exactly.
  // The frustum is auto-sized to frame the room with 0.5m padding on each side.
  // Uses the existing renderer canvas — no new WebGL context needed.
  function captureTopDown() {
    if (!initialized) return null;

    // Room bounding box in 3D XZ (canvas X→Three X, canvas Y→Three Z)
    let minX, maxX, minZ, maxZ;
    if (state.roomMode === 'rect') {
      minX = 0; maxX = state.roomW; minZ = 0; maxZ = state.roomD;
    } else {
      const xs = state.poly.map(p => p.x), zs = state.poly.map(p => p.y);
      minX = Math.min(...xs); maxX = Math.max(...xs);
      minZ = Math.min(...zs); maxZ = Math.max(...zs);
    }

    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const PAD = 0.5; // metres of padding around room
    const hw = (maxX - minX) / 2 + PAD;
    const hd = (maxZ - minZ) / 2 + PAD;

    // Capture at fixed 1200×800 regardless of current viewport size — keeps PDF resolution
    // consistent whether or not the user has opened the 3D view. Restore after capture.
    const CAPTURE_W = 1200, CAPTURE_H = 800;
    const dpr = window.devicePixelRatio || 1;
    const prevW = renderer.domElement.width  / dpr;
    const prevH = renderer.domElement.height / dpr;
    renderer.setSize(CAPTURE_W, CAPTURE_H);

    const aspect = CAPTURE_W / CAPTURE_H;
    const hh = Math.max(hw / aspect, hd);
    const hw2 = hh * aspect;

    const cam = new THREE.OrthographicCamera(-hw2, hw2, hh, -hh, 0.1, 500);
    cam.position.set(cx, 200, cz); // 200m above room (room is at y=0)
    cam.lookAt(cx, 0, cz);
    // up=(0,0,-1) so low-Z (top of 2D canvas) maps to top of image
    cam.up.set(0, 0, -1);

    renderer.render(scene, cam);
    const dataUrl = renderer.domElement.toDataURL('image/png');

    // Restore renderer to previous size so the live 3D view is unaffected
    renderer.setSize(prevW, prevH);

    // Return frustum params alongside the image so the PDF compositing step
    // can map container room coordinates to pixel positions without re-computing.
    return { dataUrl, cx, cz, hw2, hh };
  }

  // Preload all unique GLB files into the browser HTTP cache using fetch().
  // Deliberately does NOT use loadGLB/glbCache — loadGLB caches models post-scaling,
  // so preloading with dummy dimensions would corrupt the cache for real placements.
  // fetch() just warms the browser cache; when loadGLB runs later it reads from disk
  // (fast) and scales correctly with the real dimensions from DEFS.
  function preloadAll(onProgress, onDone) {
    const R2 = '/r2';
    const GLB_V = '?v=3';
    // Unique GLB file URLs only — skip duplicates (e.g. 360LG reuses 360.glb)
    const urls = [
      `${R2}/140L.glb${GLB_V}`,
      `${R2}/240.glb${GLB_V}`,
      `${R2}/360.glb${GLB_V}`,
      `${R2}/660L.glb${GLB_V}`,
      `${R2}/1000L.glb${GLB_V}`,
      `${R2}/Balex.glb${GLB_V}`,
      `${R2}/Orwak_Multi_5070.glb`,
      `${R2}/OW5070_combi_restavfall.glb?v=9`,
      `${R2}/EnviroPac-Kjøler.glb`,
      `${R2}/APS_800.glb`,
      `${R2}/800l-stativ.glb`,
      `${R2}/200L-Fat.glb`,
      `${R2}/pall.glb`,
      `${R2}/60L_fat.glb`,
      `${R2}/200L_sekkestativ.glb`,
      `${R2}/orwak_3420.glb?v=2`,
    ];
    const total = urls.length;
    let loaded = 0;
    urls.forEach(url => {
      fetch(url)
        .then(r => { if (!r.ok) console.warn('GLB preload failed:', url, r.status); })
        .catch(err => console.warn('GLB preload error:', url, err))
        .finally(() => {
          loaded++;
          if (onProgress) onProgress(loaded, total);
          if (loaded === total && onDone) onDone();
        });
    });
  }

  return { init, rebuild, rebuildSync, preloadItemGLBs, setAngle, resize, markDirty, nudgeSkilt, captureTopDown, preloadAll, enterWalkMode, exitWalkMode: _exitWalkMode, get _initialized() { return initialized; } };
})();
