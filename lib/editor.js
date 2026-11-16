// All the editor logic. Runs only in the browser (called from components/PdfEditor.tsx).
export async function initEditor() {
  // Load the two PDF libraries only in the browser
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  const { PDFDocument, StandardFonts, rgb, degrees } = await import('pdf-lib');

  // Used to remove every window/document listener when the component unmounts
  const ac = new AbortController();
  const signal = ac.signal;

  // Per-font metrics so the exported baseline matches what you see on screen.
  const FONTS = {
    Helvetica: { css: 'Arial, "Liberation Sans", Helvetica, sans-serif', base: 0.9465,
      std: { '': 'Helvetica', b: 'HelveticaBold', i: 'HelveticaOblique', bi: 'HelveticaBoldOblique' } },
    Times: { css: '"Times New Roman", "Liberation Serif", Times, serif', base: 0.9375,
      std: { '': 'TimesRoman', b: 'TimesRomanBold', i: 'TimesRomanItalic', bi: 'TimesRomanBoldItalic' } },
    Courier: { css: '"Courier New", "Liberation Mono", Courier, monospace', base: 0.8665,
      std: { '': 'Courier', b: 'CourierBold', i: 'CourierOblique', bi: 'CourierBoldOblique' } },
  };
  const PAD = 2;       // text box padding, in PDF points
  const LH = 1.2;      // line height multiplier
  const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  const $ = id => document.getElementById(id);
  const viewer = $('viewer'), pagesEl = $('pages');

  let pdfBytes = null, pdfDoc = null, fileName = 'document.pdf';
  let pages = [];           // {index, vp1, rotate, wrap, el, overlay, renderedScale, visible, rendering}
  let objects = [];         // editable objects, coordinates in PDF points from page top-left
  const images = {};        // imgId -> {bytes, kind, url, ratio}
  let selectedId = null, tool = 'text', scale = 1;
  let history = [], future = [], lastSnap = '[]';
  let rebuilding = false;
  const defaults = { font: 'Helvetica', size: 14, bold: false, italic: false, color: '#000000' };
  let uid = 1;
  const newId = () => 'o' + Date.now().toString(36) + (uid++);


  // ---------- UI helpers ----------
  let toastT;
  function toast(msg, ms = 2600) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
  }
  const busy = on => $('busy').classList.toggle('show', on);

  // ---------- loading ----------
  async function loadPdf(bytes, name) {
    busy(true);
    try {
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      if (pdfDoc) pdfDoc.destroy();
      pdfDoc = doc; pdfBytes = bytes; fileName = name || 'document.pdf';
    } catch (e) {
      busy(false);
      toast(e && e.name === 'PasswordException' ? 'This PDF is password-protected and can’t be opened.' : 'Couldn’t open that file — is it a valid PDF?', 3500);
      return;
    }
    objects = []; history = []; future = []; lastSnap = '[]'; selectedId = null;
    pages = []; pagesEl.innerHTML = '';
    for (let i = 0; i < pdfDoc.numPages; i++) {
      const p = await pdfDoc.getPage(i + 1);
      const vp1 = p.getViewport({ scale: 1 });
      const wrap = document.createElement('div'); wrap.className = 'page-wrap';
      const el = document.createElement('div'); el.className = 'page'; el.dataset.index = i;
      const overlay = document.createElement('div'); overlay.className = 'overlay';
      el.appendChild(overlay);
      const label = document.createElement('div'); label.className = 'page-label';
      label.textContent = `Page ${i + 1} of ${pdfDoc.numPages}`;
      wrap.append(el, label); pagesEl.appendChild(wrap);
      const pg = { index: i, vp1, rotate: ((p.rotate % 360) + 360) % 360, wrap, el, overlay, renderedScale: null, visible: false, rendering: false };
      overlay.addEventListener('pointerdown', e => onOverlayDown(e, pg));
      pages.push(pg);
    }
    $('empty').classList.add('hidden');
    $('fname').textContent = fileName;
    $('saveBtn').disabled = false;
    scale = fitScale();
    layout();
    viewer.scrollTop = 0;
    updateUndo(); updateSelUI();
    busy(false);
  }

  function fitScale() {
    const avail = viewer.clientWidth - 56;
    const w = Math.max(...pages.map(p => p.vp1.width));
    return Math.max(0.5, Math.min(1.5, avail / w));
  }

  // ---------- page rendering (lazy) ----------
  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      const pg = pages[+en.target.dataset.index];
      if (!pg) continue;
      pg.visible = en.isIntersecting;
      if (pg.visible) renderPage(pg);
    }
  }, { root: viewer, rootMargin: '800px 0px' });

  function layout() {
    $('zoomLbl').textContent = Math.round(scale * 100) + '%';
    for (const pg of pages) {
      pg.el.style.width = pg.vp1.width * scale + 'px';
      pg.el.style.height = pg.vp1.height * scale + 'px';
      io.unobserve(pg.el); io.observe(pg.el);
      if (pg.visible) renderPage(pg);
    }
    renderObjects();
  }

  async function renderPage(pg) {
    if (pg.rendering || pg.renderedScale === scale) return;
    pg.rendering = true;
    const s = scale;
    try {
      const page = await pdfDoc.getPage(pg.index + 1);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: s * dpr });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const old = pg.el.querySelector('canvas');
      if (old) old.replaceWith(c); else pg.el.insertBefore(c, pg.overlay);
      pg.renderedScale = s;
    } catch (e) { console.error(e); }
    pg.rendering = false;
    if (pg.visible && pg.renderedScale !== scale) renderPage(pg);
  }

  function setZoom(z) {
    if (!pages.length) return;
    const ratio = (viewer.scrollTop + viewer.clientHeight / 2) / Math.max(1, viewer.scrollHeight);
    scale = z;
    layout();
    viewer.scrollTop = ratio * viewer.scrollHeight - viewer.clientHeight / 2;
  }
  $('zoomIn').onclick = () => { const n = ZOOMS.find(z => z > scale + 0.001); if (n) setZoom(n); };
  $('zoomOut').onclick = () => { const n = [...ZOOMS].reverse().find(z => z < scale - 0.001); if (n) setZoom(n); };

  // ---------- objects ----------
  const getObj = id => objects.find(o => o.id === id);
  const getSel = () => getObj(selectedId);
  const elFor = id => pagesEl.querySelector(`.obj[data-id="${id}"]`);
  const variant = o => (o.bold ? 'b' : '') + (o.italic ? 'i' : '');

  function renderObjects() {
    rebuilding = true;
    for (const pg of pages) pg.overlay.innerHTML = '';
    for (const o of objects) if (pages[o.page]) pages[o.page].overlay.appendChild(makeEl(o));
    rebuilding = false;
  }

  function position(o, el) {
    el.style.left = o.x * scale + 'px';
    el.style.top = o.y * scale + 'px';
    if (o.type !== 'text') { el.style.width = o.w * scale + 'px'; el.style.height = o.h * scale + 'px'; }
  }

  function styleText(o, tc) {
    tc.style.fontFamily = FONTS[o.font].css;
    tc.style.fontSize = o.size * scale + 'px';
    tc.style.fontWeight = o.bold ? '700' : '400';
    tc.style.fontStyle = o.italic ? 'italic' : 'normal';
    tc.style.color = o.color;
    tc.style.padding = PAD * scale + 'px';
  }

  const ICON_MOVE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/></svg>';
  const ICON_DEL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

  function makeEl(o) {
    const el = document.createElement('div');
    el.className = 'obj obj-' + o.type + (o.id === selectedId ? ' selected' : '');
    el.dataset.id = o.id;
    position(o, el);
    el.addEventListener('pointerdown', e => e.stopPropagation());

    const handles = document.createElement('div'); handles.className = 'handles';
    const bar = document.createElement('div'); bar.className = 'hbar';
    const del = document.createElement('div'); del.className = 'hbtn del'; del.title = 'Delete'; del.innerHTML = ICON_DEL;
    del.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); removeObj(o.id); });

    if (o.type === 'text') {
      const tc = document.createElement('div'); tc.className = 'tc';
      try { tc.contentEditable = 'plaintext-only'; } catch (_) { tc.contentEditable = 'true'; }
      if (tc.contentEditable !== 'plaintext-only') tc.contentEditable = 'true';
      tc.spellcheck = false;
      tc.textContent = o.text;
      styleText(o, tc);
      tc.addEventListener('focus', () => select(o.id));
      tc.addEventListener('input', () => { o.text = tc.innerText.replace(/\n$/, ''); });
      tc.addEventListener('paste', e => {
        e.preventDefault();
        const t = (e.clipboardData || window.clipboardData).getData('text/plain');
        document.execCommand('insertText', false, t);
      });
      tc.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); tc.blur(); } });
      tc.addEventListener('blur', () => {
        if (rebuilding) return;
        if (!o.text.trim()) {
          objects = objects.filter(x => x !== o);
          if (selectedId === o.id) selectedId = null;
          el.remove(); updateSelUI();
        }
        commit();
      });
      el.appendChild(tc);
      const mv = document.createElement('div'); mv.className = 'hbtn move'; mv.title = 'Drag to move'; mv.innerHTML = ICON_MOVE;
      mv.addEventListener('pointerdown', e => startDrag(e, o, 'move'));
      bar.append(mv, del);
      handles.appendChild(bar);
    } else {
      if (o.type === 'image') {
        const img = document.createElement('img'); img.src = images[o.imgId].url; img.draggable = false;
        el.appendChild(img);
      }
      el.addEventListener('pointerdown', e => {
        // In Text / Whiteout mode, clicking on a box creates on top of it (e.g. type over a whiteout)
        if (tool !== 'select' && e.target === el) {
          e.stopPropagation();
          return onOverlayDown(e, pages[o.page], true);
        }
        startDrag(e, o, 'move');
      });
      const rz = document.createElement('div'); rz.className = 'resize'; rz.title = 'Drag to resize';
      rz.addEventListener('pointerdown', e => startDrag(e, o, 'resize'));
      bar.append(del);
      handles.append(bar, rz);
    }
    el.appendChild(handles);
    return el;
  }

  function select(id) {
    if (selectedId === id) { updateSelUI(); return; }
    selectedId = id;
    pagesEl.querySelectorAll('.obj.selected').forEach(n => n.classList.remove('selected'));
    if (id) { const el = elFor(id); if (el) el.classList.add('selected'); }
    updateSelUI();
  }

  function updateSelUI() {
    const o = getSel();
    $('delBtn').disabled = !o;
    const src = o && o.type === 'text' ? o : defaults;
    $('fontSel').value = src.font;
    $('sizeIn').value = src.size;
    $('boldBtn').classList.toggle('on', !!src.bold);
    $('italBtn').classList.toggle('on', !!src.italic);
    $('colorIn').value = src.color;
  }

  function removeObj(id) {
    const el = elFor(id);
    objects = objects.filter(o => o.id !== id);
    if (selectedId === id) selectedId = null;
    rebuilding = true; if (el) el.remove(); rebuilding = false;
    updateSelUI(); commit();
  }

  function addText(pageIdx, x, y) {
    const o = { id: newId(), type: 'text', page: pageIdx, text: '',
      font: defaults.font, size: defaults.size, bold: defaults.bold, italic: defaults.italic, color: defaults.color };
    o.x = Math.max(0, x - PAD);
    o.y = Math.max(0, y - (o.size * LH) / 2 - PAD);
    objects.push(o);
    pages[pageIdx].overlay.appendChild(makeEl(o));
    select(o.id);
    const focusIt = () => { const tc = elFor(o.id)?.querySelector('.tc'); if (tc && document.activeElement !== tc) tc.focus(); };
    focusIt(); setTimeout(focusIt, 0);
  }

  // ---------- pointer interactions ----------
  function pagePoint(e, pg) {
    const r = pg.overlay.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  }

  function onOverlayDown(e, pg, fromObj) {
    if ((!fromObj && e.target !== pg.overlay) || e.button > 0) return;
    const p = pagePoint(e, pg);
    if (document.activeElement && document.activeElement.classList.contains('tc')) document.activeElement.blur();
    if (tool === 'text') { e.preventDefault(); addText(pg.index, p.x, p.y); }
    else if (tool === 'whiteout') { e.preventDefault(); drawRect(e, pg, p); }
    else select(null);
  }

  function drawRect(e, pg, start) {
    const o = { id: newId(), type: 'rect', page: pg.index, x: start.x, y: start.y, w: 0, h: 0 };
    const el = makeEl(o); pg.overlay.appendChild(el);
    const W = pg.vp1.width, H = pg.vp1.height;
    const move = ev => {
      const p = pagePoint(ev, pg);
      const cx = Math.min(Math.max(p.x, 0), W), cy = Math.min(Math.max(p.y, 0), H);
      o.x = Math.min(start.x, cx); o.y = Math.min(start.y, cy);
      o.w = Math.abs(cx - start.x); o.h = Math.abs(cy - start.y);
      position(o, el);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (o.w < 3 || o.h < 3) { el.remove(); return; }
      objects.push(o); select(o.id); commit();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  function startDrag(e, o, mode) {
    if (e.button > 0) return;
    e.preventDefault(); e.stopPropagation();
    if (document.activeElement && document.activeElement.classList.contains('tc') && mode !== 'move') document.activeElement.blur();
    select(o.id);
    const el = elFor(o.id);
    const sx = e.clientX, sy = e.clientY, orig = { x: o.x, y: o.y, w: o.w, h: o.h };
    const pg = pages[o.page];
    let moved = false;
    const move = ev => {
      const dx = (ev.clientX - sx) / scale, dy = (ev.clientY - sy) / scale;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true;
      if (mode === 'move') {
        o.x = Math.min(Math.max(orig.x + dx, -10), pg.vp1.width - 10);
        o.y = Math.min(Math.max(orig.y + dy, -10), pg.vp1.height - 10);
      } else {
        o.w = Math.max(6, orig.w + dx);
        o.h = o.type === 'image' ? o.w * images[o.imgId].ratio : Math.max(6, orig.h + dy);
      }
      position(o, el);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (moved) commit();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  // ---------- history ----------
  function commit() {
    const s = JSON.stringify(objects);
    if (s === lastSnap) return;
    history.push(lastSnap); if (history.length > 200) history.shift();
    lastSnap = s; future = []; updateUndo();
  }
  function restore(s) {
    objects = JSON.parse(s); lastSnap = s;
    if (!getSel()) selectedId = null;
    renderObjects(); updateSelUI(); updateUndo();
  }
  function undo() { if (!history.length) return; future.push(lastSnap); restore(history.pop()); }
  function redo() { if (!future.length) return; history.push(lastSnap); restore(future.pop()); }
  function updateUndo() { $('undoBtn').disabled = !history.length; $('redoBtn').disabled = !future.length; }
  $('undoBtn').onclick = undo; $('redoBtn').onclick = redo;

  // ---------- toolbar ----------
  const HINTS = {
    select: 'Click an item to select it, drag to move. Arrow keys nudge.',
    text: 'Click anywhere on a page to add text.',
    whiteout: 'Drag over content to cover it with a white box — then add new text on top.',
  };
  function setTool(t) {
    tool = t;
    document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    viewer.className = 'tool-' + t;
    $('hint').textContent = HINTS[t];
  }
  document.querySelectorAll('.tool[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));

  function applyStyle(patch) {
    Object.assign(defaults, patch);
    const o = getSel();
    if (o && o.type === 'text') {
      Object.assign(o, patch);
      const tc = elFor(o.id)?.querySelector('.tc');
      if (tc) styleText(o, tc);
      commit();
    }
    updateSelUI();
  }
  $('fontSel').onchange = e => applyStyle({ font: e.target.value });
  $('sizeIn').onchange = e => {
    const v = Math.min(200, Math.max(4, parseFloat(e.target.value) || defaults.size));
    applyStyle({ size: v });
  };
  ['boldBtn', 'italBtn'].forEach(id => $(id).addEventListener('mousedown', e => e.preventDefault()));
  $('boldBtn').onclick = () => { const s = getSel(); const cur = s && s.type === 'text' ? s.bold : defaults.bold; applyStyle({ bold: !cur }); };
  $('italBtn').onclick = () => { const s = getSel(); const cur = s && s.type === 'text' ? s.italic : defaults.italic; applyStyle({ italic: !cur }); };
  $('colorIn').oninput = e => {
    defaults.color = e.target.value;
    const o = getSel();
    if (o && o.type === 'text') { o.color = e.target.value; const tc = elFor(o.id)?.querySelector('.tc'); if (tc) tc.style.color = o.color; }
  };
  $('colorIn').onchange = () => commit();
  $('delBtn').addEventListener('mousedown', e => e.preventDefault());
  $('delBtn').onclick = () => { if (selectedId) removeObj(selectedId); };

  viewer.addEventListener('pointerdown', e => {
    if (e.target === viewer || e.target === pagesEl || e.target.classList.contains('page-wrap')) select(null);
  }, { signal });

  document.addEventListener('keydown', e => {
    const a = document.activeElement;
    const editing = a && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
    const mod = e.ctrlKey || e.metaKey;
    if (editing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    const o = getSel();
    if ((e.key === 'Delete' || e.key === 'Backspace') && o) { e.preventDefault(); removeObj(o.id); return; }
    if (e.key === 'Escape') { select(null); return; }
    if (o && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') o.x -= d; if (e.key === 'ArrowRight') o.x += d;
      if (e.key === 'ArrowUp') o.y -= d; if (e.key === 'ArrowDown') o.y += d;
      position(o, elFor(o.id)); commit(); return;
    }
    if (!pages.length) return;
    const k = e.key.toLowerCase();
    if (k === 'v') setTool('select'); else if (k === 't') setTool('text'); else if (k === 'w') setTool('whiteout');
  }, { signal });

  // ---------- images ----------
  $('imageTool').onclick = () => { if (!pages.length) return toast('Open a PDF first'); $('imgIn').click(); };
  $('imgIn').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      let blob = f, kind = f.type === 'image/png' ? 'png' : (f.type === 'image/jpeg' ? 'jpg' : null);
      const bmp = await createImageBitmap(f);
      if (!kind) {
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        blob = await new Promise(r => c.toBlob(r, 'image/png')); kind = 'png';
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const imgId = newId();
      images[imgId] = { bytes, kind, url: URL.createObjectURL(blob), ratio: bmp.height / bmp.width };
      const pg = mostVisiblePage();
      const w = Math.min(200, pg.vp1.width * 0.5), h = w * images[imgId].ratio;
      const r = pg.overlay.getBoundingClientRect(), vr = viewer.getBoundingClientRect();
      const visTop = Math.max(0, (vr.top - r.top) / scale), visBot = Math.min(pg.vp1.height, (vr.bottom - r.top) / scale);
      const o = { id: newId(), type: 'image', page: pg.index, imgId, w, h,
        x: (pg.vp1.width - w) / 2, y: Math.max(0, Math.min(pg.vp1.height - h, (visTop + visBot) / 2 - h / 2)) };
      objects.push(o);
      pg.overlay.appendChild(makeEl(o));
      select(o.id); setTool('select'); commit();
    } catch (err) { console.error(err); toast('Couldn’t read that image.'); }
  };
  function mostVisiblePage() {
    const vr = viewer.getBoundingClientRect(); let best = pages[0], bestA = -1;
    for (const pg of pages) {
      const r = pg.el.getBoundingClientRect();
      const a = Math.max(0, Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top));
      if (a > bestA) { bestA = a; best = pg; }
    }
    return best;
  }

  // ---------- export ----------
  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  async function buildPdf() {
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const outPages = doc.getPages();
    const fontCache = {}, charsets = {}, imgCache = {};
    let replaced = false;
    for (const o of objects) {
      const page = outPages[o.page], pg = pages[o.page];
      if (!page || !pg) continue;
      const rot = degrees(pg.rotate);
      const toPdf = (x, y) => { const [px, py] = pg.vp1.convertToPdfPoint(x, y); return { x: px, y: py }; };
      if (o.type === 'rect') {
        const p = toPdf(o.x, o.y + o.h);
        page.drawRectangle({ x: p.x, y: p.y, width: o.w, height: o.h, color: rgb(1, 1, 1), rotate: rot });
      } else if (o.type === 'image') {
        const im = images[o.imgId];
        if (!imgCache[o.imgId]) imgCache[o.imgId] = im.kind === 'png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
        const p = toPdf(o.x, o.y + o.h);
        page.drawImage(imgCache[o.imgId], { x: p.x, y: p.y, width: o.w, height: o.h, rotate: rot });
      } else if (o.type === 'text') {
        const key = FONTS[o.font].std[variant(o)];
        if (!fontCache[key]) { fontCache[key] = await doc.embedFont(StandardFonts[key]); charsets[key] = new Set(fontCache[key].getCharacterSet()); }
        const font = fontCache[key], cs = charsets[key];
        const lines = o.text.replace(/\t/g, '    ').split('\n');
        lines.forEach((raw, i) => {
          let line = '';
          for (const ch of raw) { if (cs.has(ch.codePointAt(0))) line += ch; else { line += '?'; replaced = true; } }
          if (!line.trim()) return;
          const baseY = o.y + PAD + i * o.size * LH + FONTS[o.font].base * o.size;
          const p = toPdf(o.x + PAD, baseY);
          page.drawText(line, { x: p.x, y: p.y, size: o.size, font, color: hexToRgb(o.color), rotate: rot });
        });
      }
    }
    return { bytes: await doc.save(), replaced };
  }

  $('saveBtn').onclick = async () => {
    if (!pdfBytes) return;
    if (document.activeElement && document.activeElement.classList.contains('tc')) document.activeElement.blur();
    busy(true);
    let result;
    try { result = await buildPdf(); }
    catch (e) { console.error(e); busy(false); return toast('Something went wrong building the PDF.', 3500); }
    busy(false);
    if (result.replaced) toast('Some characters aren’t supported by the standard PDF fonts and were replaced with “?”.', 4500);
    const name = fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
    const blob = new Blob([result.bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    if (!result.replaced) toast('Downloaded ' + name);
  };

  // ---------- open / drop ----------
  async function openFile(f) {
    if (!f) return;
    if (f.type && f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) return toast('Please choose a PDF file.');
    if (objects.length && !window.confirm('Open a new file? Your unsaved edits will be lost.')) return;
    await loadPdf(new Uint8Array(await f.arrayBuffer()), f.name);
  }
  $('uploadBtn').onclick = () => $('fileIn').click();
  $('openBtn').onclick = () => $('fileIn').click();
  $('fileIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; openFile(f); };
  $('blankBtn').onclick = async () => {
    const d = await PDFDocument.create(); d.addPage([595.28, 841.89]);
    await loadPdf(await d.save(), 'blank.pdf');
  };
  const drop = $('drop');
  window.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); }, { signal });
  window.addEventListener('dragleave', e => { if (!e.relatedTarget) drop.classList.remove('over'); }, { signal });
  window.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    const f = [...(e.dataTransfer?.files || [])].find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (f) openFile(f); else toast('Drop a PDF file to open it.');
  }, { signal });

  let rT; window.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(() => pages.forEach(p => p.visible && renderPage(p)), 150); }, { signal });
  setTool('text');

  // Cleanup: called when the React component unmounts
  return () => {
    ac.abort();
    io.disconnect();
    clearTimeout(rT); clearTimeout(toastT);
    if (pdfDoc) pdfDoc.destroy();
    Object.values(images).forEach(im => URL.revokeObjectURL(im.url));
  };
}