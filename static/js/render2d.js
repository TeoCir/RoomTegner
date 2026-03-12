function render2D() {
  const canvas = document.getElementById('canvas-2d');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const { ox, oy } = getO();

  // ── Floor fill ──────────────────────────────────────────────────────
  floorPath(ctx);
  ctx.fillStyle = '#fafaf8';
  ctx.fill();

  // ── Grid (kun i vegg-bygger modus) ──────────────────────────────────
  if (state.roomMode === 'free') {
    const ppm = getPPM();
    const startX = ((ox % ppm) + ppm) % ppm;
    const startY = ((oy % ppm) + ppm) % ppm;
    // 1m linjer — veldig subtile
    ctx.strokeStyle = 'rgba(180,175,168,0.35)'; ctx.lineWidth = 0.5;
    for (let x = startX; x <= W; x += ppm) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = startY; y <= H; y += ppm) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    // 5m linjer — litt mer synlige
    const ppm5 = ppm * 5;
    const startX5 = ((ox % ppm5) + ppm5) % ppm5;
    const startY5 = ((oy % ppm5) + ppm5) % ppm5;
    ctx.strokeStyle = 'rgba(150,144,136,0.5)'; ctx.lineWidth = 0.8;
    for (let x = startX5; x <= W; x += ppm5) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = startY5; y <= H; y += ppm5) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }

  // ── Walls ────────────────────────────────────────────────────────────
  const wallT = Math.max(6, getPPM() * 0.06);
  ctx.save(); floorPath(ctx); ctx.clip();
  ctx.strokeStyle = '#d0cdc8'; ctx.lineWidth = wallT * 2;
  floorPath(ctx); ctx.stroke();
  ctx.restore();

  // Wall border (outer)
  floorPath(ctx); ctx.strokeStyle = '#1c1a18'; ctx.lineWidth = 2.5; ctx.stroke();

  // ── Poly draw nodes ──────────────────────────────────────────────────
  if (state.roomMode === 'free') {
    // Draw completed segments with length labels
    for (let i = 0; i < state.poly.length; i++) {
      const a = state.poly[i], b = state.poly[(i+1) % state.poly.length];
      if (i < state.poly.length - 1 || state.polyDone) {
        const ax = ox + a.x * getPPM(), ay = oy + a.y * getPPM();
        const bx = ox + b.x * getPPM(), by = oy + b.y * getPPM();
        ctx.save(); ctx.strokeStyle = '#555'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        // Segment length label
        const len = Math.sqrt((b.x-a.x)**2 + (b.y-a.y)**2);
        const mx2 = (ax+bx)/2, my2 = (ay+by)/2;
        const angle = Math.atan2(by-ay, bx-ax);
        ctx.translate(mx2, my2); ctx.rotate(angle);
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(-18, -9, 36, 14, 3); ctx.fill();
        ctx.fillStyle = '#333'; ctx.font = 'bold 9px Inter,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(len.toFixed(1)+'m', 0, -2);
        ctx.restore();
      }
    }

    // Hover line with live distance + snap cursor
    if (state.polyDraw && state.hoverPoly) {
      const hx = state.hoverPoly.x, hy = state.hoverPoly.y;

      if (state.poly.length > 0) {
        const last = state.poly[state.poly.length - 1];
        const lx = ox + last.x * getPPM(), ly = oy + last.y * getPPM();

        // ── Extension lines (uendelige) fra siste punkt gjennom cursor ──
        ctx.save();
        ctx.strokeStyle = 'rgba(100,140,200,0.25)'; ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        // Horisontal linje gjennom siste punkt
        ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(W, ly); ctx.stroke();
        // Vertikal linje gjennom siste punkt
        ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, H); ctx.stroke();
        // Horisontal linje gjennom cursor (blå hvis nær alignment)
        const snapY = Math.abs(hy - ly) < 12;
        const snapX = Math.abs(hx - lx) < 12;
        ctx.strokeStyle = snapY ? 'rgba(232,82,26,0.5)' : 'rgba(100,140,200,0.18)';
        ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke();
        ctx.strokeStyle = snapX ? 'rgba(232,82,26,0.5)' : 'rgba(100,140,200,0.18)';
        ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Dashed line to cursor
        ctx.save(); ctx.strokeStyle = state.shiftDown ? NG_ORANGE : '#888';
        ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(hx, hy); ctx.stroke(); ctx.setLineDash([]);
        // Distance label
        const dx = (hx - ox) / getPPM() - last.x, dy = (hy - oy) / getPPM() - last.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist > 0.05) {
          const angle = Math.atan2(hy - ly, hx - lx);
          ctx.translate((lx+hx)/2, (ly+hy)/2); ctx.rotate(angle);
          ctx.fillStyle = state.shiftDown ? NG_ORANGE : '#555';
          ctx.beginPath(); ctx.roundRect(-18, -9, 36, 14, 3); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = 'bold 9px Inter,sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(dist.toFixed(2)+'m', 0, -2);
        }
        ctx.restore();
      }

      // Snap crosshair cursor
      ctx.save();
      ctx.strokeStyle = state.shiftDown ? NG_ORANGE : '#666';
      ctx.lineWidth = 1;
      const cs = 8;
      ctx.beginPath(); ctx.moveTo(hx-cs, hy); ctx.lineTo(hx+cs, hy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hx, hy-cs); ctx.lineTo(hx, hy+cs); ctx.stroke();
      ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI*2);
      ctx.fillStyle = state.shiftDown ? NG_ORANGE : '#555'; ctx.fill();
      ctx.restore();
    }
    // Points
    state.poly.forEach((p, i) => {
      const x = ox + p.x * getPPM(), y = oy + p.y * getPPM();
      ctx.beginPath(); ctx.arc(x, y, i === 0 ? 7 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? NG_ORANGE : '#555'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    });
  }

  // ── Dimensions ──────────────────────────────────────────────────────
  if (state.roomMode === 'rect') {
    const rW = state.roomW * getPPM(), rD = state.roomD * getPPM();
    const off = 32; // offset from wall

    // Extension lines
    ctx.strokeStyle = '#aab0ba'; ctx.lineWidth = 0.8; ctx.setLineDash([2,2]);
    // top
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - off); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ox + rW, oy); ctx.lineTo(ox + rW, oy - off); ctx.stroke();
    // left
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox - off, oy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ox, oy + rD); ctx.lineTo(ox - off, oy + rD); ctx.stroke();
    ctx.setLineDash([]);

    // Dimension lines
    drawDimLine(ctx, ox, oy - off + 6, ox + rW, oy - off + 6, state.roomW.toFixed(1) + ' m');
    // Rotate left dim manually
    ctx.save();
    ctx.translate(ox - off + 6, oy + rD/2);
    ctx.rotate(-Math.PI/2);
    const lbl2 = state.roomD.toFixed(1) + ' m';
    const tw2 = ctx.measureText(lbl2).width + 10;
    ctx.strokeStyle = '#5a6a7a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-rD/2, 0); ctx.lineTo(rD/2, 0); ctx.stroke();
    [[-rD/2,0],[rD/2,0]].forEach(([tx]) => {
      ctx.beginPath(); ctx.moveTo(tx-3, -3); ctx.lineTo(tx+3, 3); ctx.stroke();
    });
    ctx.fillStyle = '#f8f7f5'; ctx.beginPath(); ctx.roundRect(-tw2/2, -9, tw2, 14, 3); ctx.fill();
    ctx.fillStyle = '#2c3e50'; ctx.font = 'bold 10px Inter,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(lbl2, 0, -1);
    ctx.restore();

    // Area label bottom-right
    const area = (state.roomW * state.roomD).toFixed(1);
    ctx.fillStyle = 'rgba(92,106,122,0.85)';
    ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${area} m²`, ox + rW - 4, oy + rD - 4);

  } else if (state.roomMode === 'free' && state.polyDone && state.poly.length > 2) {
    // Show total perimeter and area for free-form room
    let perim = 0, area = 0;
    const n = state.poly.length;
    for (let i = 0; i < n; i++) {
      const a = state.poly[i], b = state.poly[(i+1)%n];
      perim += Math.sqrt((b.x-a.x)**2 + (b.y-a.y)**2);
      area += a.x * b.y - b.x * a.y;
    }
    area = Math.abs(area) / 2;
    ctx.fillStyle = 'rgba(92,106,122,0.85)';
    ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const cx2 = state.poly.reduce((s,p)=>s+p.x,0)/n * getPPM() + ox;
    const cy2 = state.poly.reduce((s,p)=>s+p.y,0)/n * getPPM() + oy;
    ctx.fillText(`${area.toFixed(1)} m²`, cx2, cy2);
  }

  // ── Items ─────────────────────────────────────────────────────────────
  state.items.forEach(it => {
    const px = ox + it.x * getPPM(), py = oy + it.y * getPPM();
    const isSel = it.id === state.sel;
    ctx.save(); ctx.translate(px, py); ctx.rotate(it.rot || 0);

    if (it.kind === 'container') {
      const bw = (it.def.W / 1000) * getPPM(), bd = (it.def.D / 1000) * getPPM();
      if (it.def.type === 'cage') drawCage2D(ctx, bw, bd, isSel, false);
      else if (it.def.type === 'rollcage') drawCage2D(ctx, bw, bd, isSel, true);
      else if (it.def.type === 'compactor') drawCompactor2D(ctx, bw, bd, isSel, it.def);
      else drawBin2D(ctx, bw, bd, isSel, it.def, it.fraksjon);
      // Pending skilt hover highlight
      if (state.pendingSkilt && state._skiltHoverId === it.id) {
        ctx.strokeStyle = '#00cc66'; ctx.lineWidth = 3; ctx.setLineDash([5, 3]);
        ctx.beginPath(); ctx.roundRect(-bw/2 - 6, -bd/2 - 6, bw + 12, bd + 12, 5);
        ctx.stroke(); ctx.setLineDash([]);
      }
    } else if (it.kind === 'wall') {
      const bw = (it.def.W / 1000) * getPPM(), bd = (it.def.D / 1000) * getPPM();
      drawWallEl2D(ctx, bw, bd, isSel, it);
    } else if (it.kind === 'note') {
      drawNote2D(ctx, isSel, it.text);
    } else if (it.kind === 'exit') {
      drawExit2D(ctx, isSel);
    } else if (it.kind === 'skilt') {
      // Skilt vises kun i 3D — ingen markering i 2D
    }
    ctx.restore();
  });

  // ── Stykkliste (live) ────────────────────────────────────────────────
  const containers = state.items.filter(i => i.kind === 'container');
  if (containers.length > 0) {
    const counts = {};
    containers.forEach(it => {
      const fr = getFraksjon(it.fraksjon || 'rest');
      const key = it.def.name + '|' + (it.fraksjon || 'rest');
      if (!counts[key]) counts[key] = { name: it.def.name, fr, n: 0 };
      counts[key].n++;
    });
    const entries = Object.values(counts);
    const lineH = 18, padX = 10, padY = 8;
    const listW = 160, listH = entries.length * lineH + padY * 2 + 16;
    const lx = W - listW - 12, ly = H - listH - 12;

    // Panel background
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(lx, ly, listW, listH, 6); ctx.fill(); ctx.stroke();

    // Header
    ctx.fillStyle = '#1c1a18';
    ctx.font = 'bold 10px Inter,sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(`Beholdere (${containers.length} stk)`, lx + padX, ly + padY);

    // Divider
    ctx.strokeStyle = '#e0ddd8'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(lx + padX, ly + padY + 14); ctx.lineTo(lx + listW - padX, ly + padY + 14); ctx.stroke();

    entries.forEach((e, i) => {
      const ey = ly + padY + 18 + i * lineH;
      // Colour dot
      ctx.fillStyle = e.fr.color;
      ctx.beginPath(); ctx.arc(lx + padX + 5, ey + 6, 5, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.arc(lx + padX + 5, ey + 6, 5, 0, Math.PI*2); ctx.stroke();
      // Text
      ctx.fillStyle = '#2c2a28';
      ctx.font = '9.5px Inter,sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const label = `${e.n}× ${e.name}`;
      ctx.fillText(label, lx + padX + 15, ey + 1);
      // Fraction name (muted)
      ctx.fillStyle = '#888';
      ctx.font = '8px Inter,sans-serif';
      ctx.fillText(e.fr.label, lx + padX + 15, ey + 10);
    });
  }

  // ── Scale bar ────────────────────────────────────────────────────────
  const scBarPpm = getPPM();
  let scaleM = 1;
  if (scBarPpm < 30) scaleM = 5;
  else if (scBarPpm < 60) scaleM = 2;
  const barPx = scaleM * scBarPpm;
  const sx = 16, sy = H - 28;
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.beginPath(); ctx.roundRect(sx - 4, sy - 6, barPx + 40, 22, 4); ctx.fill();
  // Bar
  ctx.strokeStyle = '#444'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(sx, sy + 8); ctx.lineTo(sx + barPx, sy + 8); ctx.stroke();
  // End ticks
  [[sx, sy+2],[sx + barPx, sy+2]].forEach(([tx, ty]) => {
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx, ty+12); ctx.stroke();
  });
  // Mid tick
  ctx.lineWidth = 1; ctx.strokeStyle = '#888';
  ctx.beginPath(); ctx.moveTo(sx + barPx/2, sy+4); ctx.lineTo(sx + barPx/2, sy+12); ctx.stroke();
  // Label
  ctx.fillStyle = '#1c1a18'; ctx.font = 'bold 9px Inter,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText(`${scaleM} m`, sx + barPx/2, sy + 2);
}

function floorPath(ctx) {
  const { ox, oy } = getO();
  ctx.beginPath();
  if (state.roomMode === 'rect') {
    ctx.rect(ox, oy, state.roomW * getPPM(), state.roomD * getPPM());
  } else if (state.poly.length > 0) {
    state.poly.forEach((p, i) => { i === 0 ? ctx.moveTo(ox + p.x * getPPM(), oy + p.y * getPPM()) : ctx.lineTo(ox + p.x * getPPM(), oy + p.y * getPPM()); });
    if (state.polyDone) ctx.closePath();
  }
}

// Proper architectural dimension line with tick marks and arrows
function drawDimLine(ctx, x1, y1, x2, y2, lbl) {
  ctx.save();
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx*dx + dy*dy);
  const nx = -dy/len, ny = dx/len; // normal (perpendicular)
  const tickLen = 6;

  ctx.strokeStyle = '#5a6a7a'; ctx.fillStyle = '#5a6a7a'; ctx.lineWidth = 1;

  // Main dimension line
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

  // Tick marks at each end (45° cross)
  [[x1,y1],[x2,y2]].forEach(([tx,ty]) => {
    ctx.beginPath();
    ctx.moveTo(tx - nx*tickLen*0.5 + dx/len*tickLen*0.5, ty - ny*tickLen*0.5 + dy/len*tickLen*0.5);
    ctx.lineTo(tx + nx*tickLen*0.5 - dx/len*tickLen*0.5, ty + ny*tickLen*0.5 - dy/len*tickLen*0.5);
    ctx.stroke();
  });

  // Extension lines from room edge to dim line
  const extGap = 4, extOver = 3;
  ctx.strokeStyle = '#aab0ba'; ctx.lineWidth = 0.8; ctx.setLineDash([2,2]);
  // (extension lines are already handled by offset in call site)
  ctx.setLineDash([]);

  // Label background + text
  const mx = (x1+x2)/2, my = (y1+y2)/2;
  const angle = Math.atan2(dy, dx);
  ctx.translate(mx, my); ctx.rotate(angle);
  const tw = ctx.measureText(lbl).width + 10;
  ctx.fillStyle = '#f8f7f5';
  ctx.beginPath(); ctx.roundRect(-tw/2, -9, tw, 14, 3); ctx.fill();
  ctx.fillStyle = '#2c3e50';
  ctx.font = 'bold 10px Inter,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(lbl, 0, -1);
  ctx.restore();
}

// Legacy compat
function drawDim(ctx, x1, y1, x2, y2, lbl, vert = false) {
  drawDimLine(ctx, x1, y1, x2, y2, lbl);
}

function drawBin2D(ctx, bw, bd, isSel, def, fraksjon) {
  const fr = getFraksjon(fraksjon || 'rest');
  const r = Math.max(3, bw * 0.07);

  // Shadow
  ctx.shadowColor = 'rgba(0,0,0,.18)';
  ctx.shadowBlur = isSel ? 16 : 7;
  ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 3;

  // Body — fraction color
  ctx.fillStyle = fr.color;
  ctx.beginPath(); ctx.roundRect(-bw/2, -bd/2, bw, bd, r); ctx.fill();
  ctx.shadowColor = 'transparent';

  // Lid strip — darker shade of fraction color
  const lidH = bd * 0.20;
  ctx.fillStyle = fr.lidColor;
  ctx.beginPath(); ctx.roundRect(-bw/2, -bd/2, bw, lidH, [r, r, 0, 0]); ctx.fill();

  // Lid handle
  const hW = bw * 0.28, hH = lidH * 0.28;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.roundRect(-hW/2, -bd/2 + lidH * 0.62, hW, hH, 2); ctx.fill();

  // Subtle body gradient
  const grad = ctx.createLinearGradient(-bw/2, 0, bw/2, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.10)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.15)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.roundRect(-bw/2, -bd/2 + lidH, bw, bd - lidH, [0, 0, r, r]); ctx.fill();

  // NG badge
  const bW = Math.min(bw * 0.50, 36), bH = Math.min(bd * 0.13, 11);
  const bY = -bd/2 + lidH + (bd - lidH) * 0.15;
  ctx.fillStyle = NG_ORANGE;
  ctx.beginPath(); ctx.roundRect(-bW/2, bY, bW, bH, 3); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.max(6, Math.min(9, bW/3.5))}px Inter,sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('NG', 0, bY + bH/2);

  // Fraction label — most important info
  const frFs = Math.max(6, Math.min(9, bw / 8));
  ctx.fillStyle = 'rgba(255,255,255,0.90)';
  ctx.font = `bold ${frFs}px Inter,sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // Truncate if needed
  const frLabel = fr.label.length > 14 ? fr.label.slice(0, 13) + '…' : fr.label;
  ctx.fillText(frLabel, 0, bY + bH + frFs * 1.4);

  // Size label (smaller, below fraction)
  const szFs = Math.max(5, Math.min(7, bw/11));
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = `${szFs}px Inter,sans-serif`;
  ctx.fillText(def.name, 0, bY + bH + frFs * 1.4 + frFs + 2);

  // Wheels
  const wr = Math.max(2.5, Math.min(5, bw/14));
  const wheelPos = def.wheels === 4
    ? [[bw/2-wr*1.6, bd/2-wr*1.4], [-bw/2+wr*1.6, bd/2-wr*1.4], [bw/2-wr*1.6, -bd/2+wr*1.4], [-bw/2+wr*1.6, -bd/2+wr*1.4]]
    : [[bw/2-wr*1.6, bd/2-wr*1.4], [-bw/2+wr*1.6, bd/2-wr*1.4]];
  wheelPos.forEach(([wx, wy]) => {
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath(); ctx.arc(wx, wy, wr+1, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(wx, wy, wr, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#555';
    ctx.beginPath(); ctx.arc(wx, wy, wr*0.42, 0, Math.PI*2); ctx.fill();
  });

  // Outline
  ctx.strokeStyle = isSel ? NG_ORANGE : 'rgba(255,255,255,0.15)';
  ctx.lineWidth = isSel ? 2.5 : 1;
  ctx.beginPath(); ctx.roundRect(-bw/2, -bd/2, bw, bd, r); ctx.stroke();

  // Selection dashes + dims
  if (isSel) {
    ctx.strokeStyle = NG_ORANGE; ctx.lineWidth = 1.5; ctx.setLineDash([4,3]);
    ctx.beginPath(); ctx.roundRect(-bw/2-7, -bd/2-7, bw+14, bd+14, r+4); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = NG_ORANGE; ctx.font = 'bold 9px Inter,sans-serif';
    ctx.fillText(def.W+'mm', 0, -bd/2-14);
    ctx.save(); ctx.rotate(-Math.PI/2); ctx.fillText(def.D+'mm', 0, bw/2+14); ctx.restore();
  }
}

function drawCage2D(ctx, bw, bd, isSel, isRoll) {
  // Shadow
  ctx.shadowColor = 'rgba(0,0,0,.12)'; ctx.shadowBlur = isSel ? 12 : 4; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;

  // Floor/base plate
  ctx.fillStyle = '#c8c4be';
  ctx.beginPath(); ctx.rect(-bw/2, -bd/2, bw, bd); ctx.fill();
  ctx.shadowColor = 'transparent';

  // Interior lighter
  ctx.fillStyle = '#dedad4';
  ctx.beginPath(); ctx.rect(-bw/2 + 4, -bd/2 + 4, bw - 8, bd - 8); ctx.fill();

  // Grid lines horizontal
  ctx.strokeStyle = '#888'; ctx.lineWidth = 1.2;
  const rowH = bd / 4;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(-bw/2, -bd/2 + i * rowH);
    ctx.lineTo( bw/2, -bd/2 + i * rowH);
    ctx.stroke();
  }

  // Grid lines vertical
  const cols = Math.max(3, Math.round(bw / 20));
  const colW = bw / cols;
  for (let i = 1; i < cols; i++) {
    ctx.beginPath();
    ctx.moveTo(-bw/2 + i * colW, -bd/2);
    ctx.lineTo(-bw/2 + i * colW,  bd/2);
    ctx.stroke();
  }

  // Outer frame thick
  ctx.strokeStyle = isSel ? NG_ORANGE : '#555';
  ctx.lineWidth = isSel ? 2.5 : 2;
  ctx.beginPath(); ctx.rect(-bw/2, -bd/2, bw, bd); ctx.stroke();

  // Corner posts
  const cp = Math.max(3, bw * 0.04);
  [[-bw/2, -bd/2],[bw/2 - cp, -bd/2],[-bw/2, bd/2 - cp],[bw/2 - cp, bd/2 - cp]].forEach(([x,y]) => {
    ctx.fillStyle = '#666'; ctx.beginPath(); ctx.rect(x, y, cp, cp); ctx.fill();
  });

  // EE label
  const lbl = isRoll ? 'POSTBUR' : 'BUR EE';
  const fs = Math.max(7, Math.min(11, bw / 9));
  ctx.fillStyle = '#333'; ctx.font = `bold ${fs}px Inter,sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(lbl, 0, 0);

  // EE symbol - lightning bolt
  const lx = 0, ly = -bd * 0.22, lh = bd * 0.16;
  ctx.fillStyle = NG_ORANGE;
  ctx.beginPath();
  ctx.moveTo(lx + lh*0.3, ly);
  ctx.lineTo(lx - lh*0.1, ly + lh*0.45);
  ctx.lineTo(lx + lh*0.08, ly + lh*0.45);
  ctx.lineTo(lx - lh*0.3, ly + lh);
  ctx.lineTo(lx + lh*0.1, ly + lh*0.5);
  ctx.lineTo(lx - lh*0.08, ly + lh*0.5);
  ctx.closePath(); ctx.fill();

  // Wheels (4 corners)
  const wr = Math.max(2.5, Math.min(5, bw / 14));
  [[bw/2 - wr*1.8, bd/2 - wr*1.5], [-bw/2 + wr*1.8, bd/2 - wr*1.5],
   [bw/2 - wr*1.8, -bd/2 + wr*1.5], [-bw/2 + wr*1.8, -bd/2 + wr*1.5]].forEach(([wx,wy]) => {
    ctx.beginPath(); ctx.arc(wx, wy, wr, 0, Math.PI*2); ctx.fillStyle = '#111'; ctx.fill();
    ctx.beginPath(); ctx.arc(wx, wy, wr*.45, 0, Math.PI*2); ctx.fillStyle = '#666'; ctx.fill();
  });
}

function drawWallEl2D(ctx, bw, bd, isSel, it) {
  const def = it.def;
  ctx.shadowColor = 'rgba(0,0,0,.08)'; ctx.shadowBlur = isSel ? 8 : 3; ctx.shadowOffsetX = 1; ctx.shadowOffsetY = 1;

  if (def.type === 'door') {
    const swing = Math.min(bw, (def.swingR / 1000) * getPPM());
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.rect(-bw / 2, -bd / 2, bw, bd); ctx.fill();
    ctx.strokeStyle = '#333'; ctx.lineWidth = isSel ? 2.5 : 2;
    ctx.beginPath(); ctx.rect(-bw / 2, -bd / 2, bw, bd); ctx.stroke();
    ctx.strokeStyle = '#555'; ctx.lineWidth = 1; ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.arc(-bw / 2, -bd / 2, swing, 0, Math.PI / 2); ctx.stroke();
    ctx.setLineDash([]);
    if (def.double) { ctx.beginPath(); ctx.arc(bw / 2, -bd / 2, swing, Math.PI / 2, Math.PI); ctx.stroke(); }
    ctx.strokeStyle = '#999'; ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(-bw / 2, -bd / 2); ctx.lineTo(-bw / 2 + swing, -bd / 2); ctx.stroke();
  } else if (def.type === 'window') {
    ctx.fillStyle = '#d4eaf7'; ctx.beginPath(); ctx.rect(-bw / 2, -bd / 2, bw, bd); ctx.fill();
    ctx.strokeStyle = isSel ? NG_ORANGE : '#4a7fa8'; ctx.lineWidth = isSel ? 2 : 1.5;
    ctx.beginPath(); ctx.rect(-bw / 2, -bd / 2, bw, bd); ctx.stroke();
    ctx.strokeStyle = '#7ab8d8'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, -bd / 2); ctx.lineTo(0, bd / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-bw / 2, 0); ctx.lineTo(bw / 2, 0); ctx.stroke();
  } else if (def.type === 'pillar') {
    ctx.fillStyle = '#888'; ctx.beginPath(); ctx.rect(-bw / 2, -bd / 2, bw, bd); ctx.fill();
    ctx.strokeStyle = isSel ? NG_ORANGE : '#444'; ctx.lineWidth = isSel ? 2 : 1.5;
    ctx.beginPath(); ctx.rect(-bw / 2, -bd / 2, bw, bd); ctx.stroke();
    ctx.strokeStyle = '#aaa'; ctx.lineWidth = .8;
    ctx.beginPath(); ctx.moveTo(-bw / 2, -bd / 2); ctx.lineTo(bw / 2, bd / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bw / 2, -bd / 2); ctx.lineTo(-bw / 2, bd / 2); ctx.stroke();
  }
  ctx.shadowColor = 'transparent';
}

function drawCompactor2D(ctx, bw, bd, isSel, def) {
  ctx.shadowColor = 'rgba(0,0,0,.15)'; ctx.shadowBlur = isSel ? 12 : 5;
  ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2;

  // Body — steel grey
  ctx.fillStyle = '#707880';
  ctx.beginPath(); ctx.rect(-bw/2, -bd/2, bw, bd); ctx.fill();
  ctx.shadowColor = 'transparent';

  // Front panel (darker)
  ctx.fillStyle = '#555d64';
  ctx.beginPath(); ctx.rect(-bw/2, -bd/2, bw, bd * 0.35); ctx.fill();

  // Compactor opening slot
  ctx.fillStyle = '#2a2a2a';
  ctx.beginPath(); ctx.rect(-bw/2 + bw*0.1, -bd/2 + bd*0.08, bw*0.8, bd*0.18); ctx.fill();

  // Control panel
  ctx.fillStyle = '#3a4048';
  ctx.beginPath(); ctx.roundRect(bw*0.1, -bd/2 + bd*0.05, bw*0.35, bd*0.22, 3); ctx.fill();
  // LED indicators
  [[0,0,'#00cc44'],[0,1,'#ffaa00'],[0,2,'#cc2200']].forEach(([,i,c]) => {
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(bw*0.2, -bd/2 + bd*0.10 + i * bd*0.06, 3, 0, Math.PI*2); ctx.fill();
  });

  // NG badge
  const bW = Math.min(bw*0.4, 36), bH = 11;
  const bY = -bd/2 + bd*0.45;
  ctx.fillStyle = '#E8521A';
  ctx.beginPath(); ctx.roundRect(-bW/2, bY, bW, bH, 3); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(6,Math.min(9,bW/3.5))}px Inter,sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('NG', 0, bY + bH/2);

  // Label
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = `bold ${Math.max(6, Math.min(9, bw/10))}px Inter,sans-serif`;
  ctx.fillText('BALEX', 0, bY + bH + 10);

  // Outline
  ctx.strokeStyle = isSel ? '#E8521A' : 'rgba(255,255,255,0.2)';
  ctx.lineWidth = isSel ? 2.5 : 1;
  ctx.beginPath(); ctx.rect(-bw/2, -bd/2, bw, bd); ctx.stroke();

  if (isSel) {
    ctx.strokeStyle = '#E8521A'; ctx.lineWidth = 1.5; ctx.setLineDash([4,3]);
    ctx.beginPath(); ctx.rect(-bw/2-7, -bd/2-7, bw+14, bd+14); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#E8521A'; ctx.font = 'bold 9px Inter,sans-serif';
    ctx.fillText(def.W+'mm', 0, -bd/2-14);
    ctx.save(); ctx.rotate(-Math.PI/2); ctx.fillText(def.D+'mm', 0, bw/2+14); ctx.restore();
  }
}

// ── Skilt image cache ─────────────────────────────────────────────────────
const _skiltImgCache = {};
function getSkiltImg(url, cb) {
  if (_skiltImgCache[url]) { if (_skiltImgCache[url].complete) cb(_skiltImgCache[url]); return; }
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = () => { _skiltImgCache[url] = img; cb(img); };
  img.onerror = () => { _skiltImgCache[url] = null; };
  _skiltImgCache[url] = img;
  img.src = url;
}

function drawSkilt2D(ctx, isSel, it) {
  const sz = (it.size || 0.4) * getPPM();
  // White backing square
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = isSel ? NG_ORANGE : 'rgba(0,0,0,0.15)';
  ctx.lineWidth = isSel ? 2 : 1;
  ctx.beginPath(); ctx.roundRect(-sz/2, -sz/2, sz, sz, 4); ctx.fill(); ctx.stroke();

  // Draw image if cached, otherwise trigger load + re-render
  const url = it.def && it.def.url;
  if (url) {
    if (_skiltImgCache[url] && _skiltImgCache[url].complete) {
      ctx.drawImage(_skiltImgCache[url], -sz/2 + 4, -sz/2 + 4, sz - 8, sz - 8);
    } else {
      getSkiltImg(url, () => render());
      // Placeholder spinner
      ctx.fillStyle = '#eee'; ctx.font = `${sz*0.4}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⏳', 0, 0);
    }
  }

  if (isSel) {
    ctx.strokeStyle = NG_ORANGE; ctx.lineWidth = 1.5; ctx.setLineDash([4,3]);
    ctx.beginPath(); ctx.rect(-sz/2-6, -sz/2-6, sz+12, sz+12); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawNote2D(ctx, isSel, text) {
  const pad = 8, maxW = 120;
  ctx.font = '11px Inter,sans-serif';
  const tw = Math.min(ctx.measureText(text).width + pad * 2, maxW);
  const th = 28;
  ctx.fillStyle = '#fffbe6'; ctx.strokeStyle = isSel ? NG_ORANGE : '#d4a800'; ctx.lineWidth = isSel ? 2 : 1;
  ctx.beginPath(); ctx.roundRect(-tw / 2, -th / 2, tw, th, 4); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#7a6800'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text.length > 16 ? text.slice(0, 14) + '…' : text, 0, 0);
}

function drawExit2D(ctx, isSel) {
  const sz = getPPM() * 0.5;
  ctx.fillStyle = '#00aa44'; ctx.globalAlpha = .25;
  ctx.beginPath(); ctx.rect(-sz / 2, -sz / 2, sz, sz); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = isSel ? NG_ORANGE : '#00aa44'; ctx.lineWidth = isSel ? 2 : 1.5;
  ctx.beginPath(); ctx.rect(-sz / 2, -sz / 2, sz, sz); ctx.stroke();
  ctx.fillStyle = '#007733'; ctx.font = `bold ${Math.max(9, sz * 0.22)}px Inter,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('EXIT', 0, 0);
}

function drawSelOverlay(ctx, bw, bd, def) {
  ctx.strokeStyle = NG_ORANGE; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.rect(-bw / 2 - 7, -bd / 2 - 7, bw + 14, bd + 14); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = NG_ORANGE; ctx.font = `bold 9px Inter,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(def.W + 'mm', 0, -bd / 2 - 14);
  ctx.save(); ctx.rotate(-Math.PI / 2); ctx.fillText(def.D + 'mm', 0, bw / 2 + 14); ctx.restore();
}

function hitTest(it, mx, my) {
  const { ox, oy } = getO();
  let hw, hd;
  if (it.kind === 'note' || it.kind === 'exit') { hw = 60; hd = 20; }
  else if (it.kind === 'skilt') { const h = Math.max(30, (it.size || 0.4) * getPPM() / 2); hw = h; hd = h; }
  else if (it.def) { hw = (it.def.W / 1000) * getPPM() / 2; hd = (it.def.D / 1000) * getPPM() / 2; }
  else return false;
  const px = ox + it.x * getPPM(), py = oy + it.y * getPPM();
  const dx = mx - px, dy = my - py;
  const c = Math.cos(-(it.rot || 0)), s = Math.sin(-(it.rot || 0));
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return Math.abs(lx) <= hw && Math.abs(ly) <= hd;
}
