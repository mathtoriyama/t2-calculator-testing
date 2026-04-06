/**
 * T₂ Calculator — Frontend Application
 * Supports 3D, 2D, and Heterostructure (2D×3D) modes.
 */

// ── Configuration ─────────────────────────────────────────────────────────────
const CONFIG = {
  API_BASE: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8000'
    : 'https://t2-calculator-testing-1.onrender.com',
  MAX_FILE_SIZE_MB: 10,
  ALLOWED_EXT: '.cif',
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// Shared controls
const computeBtn       = $('computeBtn');
const loadingState     = $('loadingState');
const loadingStep      = $('loadingStep');
const errorMsg         = $('errorMsg');
const errorText        = $('errorText');
const resultsPanel     = $('resultsPanel');
const multiResultsCont = $('multiResultsContainer');
const resetBtn         = $('resetBtn');
const rawToggle        = $('rawToggle');
const rawContent       = $('rawContent');
const rawJson          = $('rawJson');

// ── State ─────────────────────────────────────────────────────────────────────
let selectedDim   = '3D';
let singleFiles   = [];   // used in 3D / 2D modes
let heteroFiles2D = [];   // used in HETERO mode — 2D materials
let heteroFiles3D = [];   // used in HETERO mode — 3D materials

// ── Lattice Canvas ────────────────────────────────────────────────────────────
(function initLattice() {
  const canvas = $('latticeCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
  resize();
  window.addEventListener('resize', () => { resize(); draw(); });
  function draw() {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const sp = 48;
    const cols = Math.ceil(w / sp) + 2, rows = Math.ceil(h / sp) + 2;
    ctx.strokeStyle = 'rgba(0,212,170,0.07)'; ctx.lineWidth = 0.5;
    ctx.fillStyle   = 'rgba(0,212,170,0.18)';
    for (let i = 0; i < cols; i++) { ctx.beginPath(); ctx.moveTo(i*sp,0); ctx.lineTo(i*sp,h); ctx.stroke(); }
    for (let j = 0; j < rows; j++) { ctx.beginPath(); ctx.moveTo(0,j*sp); ctx.lineTo(w,j*sp); ctx.stroke(); }
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      if ((i+j)%3===0) { ctx.beginPath(); ctx.arc(i*sp,j*sp,1.5,0,Math.PI*2); ctx.fill(); }
    }
  }
  draw();
})();

// ── Dimensionality selector ───────────────────────────────────────────────────
function selectDim(dim) {
  selectedDim = dim;
  ['3D','2D','HETERO'].forEach(d => {
    const el = $({ '3D':'pill3D', '2D':'pill2D', 'HETERO':'pillHetero' }[d]);
    el.classList.toggle('selected', d === dim);
    el.setAttribute('aria-pressed', String(d === dim));
  });

  const isHetero = dim === 'HETERO';
  $('dropZone').hidden   = isHetero;
  $('heteroZones').hidden = !isHetero;

  // Clear all files when switching mode
  resetSingleFiles();
  resetHeteroFiles();
  clearError();
  refreshComputeBtn();
}

// ── Drop zone wiring ──────────────────────────────────────────────────────────
// Wire the single drop zone (3D / 2D modes)
wireDropZone({
  zone:    $('dropZone'),
  input:   $('fileInput'),
  clearBtn: $('removeFile'),
  onDrop:  files => {
    singleFiles = mergeFiles(singleFiles, validateFiles(files));
    renderList(singleFiles, $('fileList'), $('dropContent'), $('fileReady'), 's');
    refreshComputeBtn();
    resultsPanel.hidden = true;
  },
  onClear: () => { resetSingleFiles(); refreshComputeBtn(); },
});

// Wire the 2D hetero drop zone
wireDropZone({
  zone:    $('dropZone2D'),
  input:   $('fileInput2D'),
  clearBtn: $('removeFile2D'),
  onDrop:  files => {
    heteroFiles2D = mergeFiles(heteroFiles2D, validateFiles(files));
    renderList(heteroFiles2D, $('fileList2D'), $('dropContent2D'), $('fileReady2D'), 'h2d');
    refreshComputeBtn();
  },
  onClear: () => { resetHeteroFiles('2D'); refreshComputeBtn(); },
});

// Wire the 3D hetero drop zone
wireDropZone({
  zone:    $('dropZone3D'),
  input:   $('fileInput3D'),
  clearBtn: $('removeFile3D'),
  onDrop:  files => {
    heteroFiles3D = mergeFiles(heteroFiles3D, validateFiles(files));
    renderList(heteroFiles3D, $('fileList3D'), $('dropContent3D'), $('fileReady3D'), 'h3d');
    refreshComputeBtn();
  },
  onClear: () => { resetHeteroFiles('3D'); refreshComputeBtn(); },
});

// ── Generic drop-zone wiring ──────────────────────────────────────────────────
function wireDropZone({ zone, input, clearBtn, onDrop, onClear }) {
  ['dragenter','dragover'].forEach(e => zone.addEventListener(e, ev => {
    ev.preventDefault(); zone.classList.add('drag-over');
  }));
  ['dragleave','drop'].forEach(e => zone.addEventListener(e, ev => {
    ev.preventDefault(); zone.classList.remove('drag-over');
  }));
  zone.addEventListener('drop', ev => {
    const files = ev.dataTransfer?.files;
    if (files?.length) onDrop(Array.from(files));
  });
  zone.addEventListener('click', ev => {
    if (clearBtn && (ev.target === clearBtn || clearBtn.contains(ev.target))) return;
    input.click();
  });
  zone.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); input.click(); }
  });
  input.addEventListener('change', ev => {
    if (ev.target.files?.length) onDrop(Array.from(ev.target.files));
  });
  if (clearBtn) clearBtn.addEventListener('click', ev => { ev.stopPropagation(); onClear(); });
}

// ── File helpers ──────────────────────────────────────────────────────────────
function validateFiles(files) {
  clearError();
  const valid = [], errors = [];
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith(CONFIG.ALLOWED_EXT)) {
      errors.push(`"${f.name}" is not a .cif file.`); continue;
    }
    const mb = f.size / (1024*1024);
    if (mb > CONFIG.MAX_FILE_SIZE_MB) {
      errors.push(`"${f.name}" is too large (${mb.toFixed(1)} MB, max ${CONFIG.MAX_FILE_SIZE_MB} MB).`); continue;
    }
    valid.push(f);
  }
  if (errors.length) showError(errors.join(' '));
  return valid;
}

function mergeFiles(existing, incoming) {
  const names = new Set(existing.map(f => f.name));
  return [...existing, ...incoming.filter(f => !names.has(f.name))];
}

function renderList(files, listEl, contentEl, readyEl, prefix) {
  if (!files.length) {
    contentEl.hidden = false; readyEl.hidden = true; listEl.innerHTML = ''; return;
  }
  contentEl.hidden = true; readyEl.hidden = false;
  listEl.innerHTML = files.map((f, i) => `
    <div class="file-list-item" id="file-item-${prefix}-${i}">
      <svg class="file-list-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <div class="file-list-info">
        <div class="file-list-name" title="${f.name}">${f.name}</div>
        <div class="file-list-size">${formatBytes(f.size)}</div>
      </div>
      <span class="file-list-status pending" id="status-${prefix}-${i}">pending</span>
    </div>`).join('');
}

function resetSingleFiles() {
  singleFiles = [];
  const inp = $('fileInput'); if (inp) inp.value = '';
  $('dropContent').hidden = false;
  $('fileReady').hidden   = true;
  $('fileList').innerHTML = '';
}

function resetHeteroFiles(which) {
  if (!which || which === '2D') {
    heteroFiles2D = [];
    const inp = $('fileInput2D'); if (inp) inp.value = '';
    $('dropContent2D').hidden = false;
    $('fileReady2D').hidden   = true;
    $('fileList2D').innerHTML = '';
  }
  if (!which || which === '3D') {
    heteroFiles3D = [];
    const inp = $('fileInput3D'); if (inp) inp.value = '';
    $('dropContent3D').hidden = false;
    $('fileReady3D').hidden   = true;
    $('fileList3D').innerHTML = '';
  }
}

function refreshComputeBtn() {
  computeBtn.disabled = selectedDim === 'HETERO'
    ? !(heteroFiles2D.length > 0 && heteroFiles3D.length > 0)
    : singleFiles.length === 0;
}

// ── Compute ───────────────────────────────────────────────────────────────────
computeBtn.addEventListener('click', async () => {
  setLoading(true);
  clearError();
  resultsPanel.hidden = true;
  multiResultsCont.innerHTML = '';

  const steps = [
    // 'Parsing CIF file…','Extracting lattice parameters…', 'Identifying atomic sites…','Computing T₂ coherence time…','Finalizing results…',
    'Computing T₂ coherence time…',
  ];
  let si = 0;
  loadingStep.textContent = steps[0];
  const ticker = setInterval(() => { loadingStep.textContent = steps[++si % steps.length]; }, 1200);

  const results = selectedDim === 'HETERO'
    ? await runHetero()
    : await runSingle();

  clearInterval(ticker);
  setLoading(false);
  if (results.length) renderAllResults(results);
});

// Single-mode (3D or 2D)
async function runSingle() {
  const out = [];
  for (let i = 0; i < singleFiles.length; i++) {
    const file = singleFiles[i];
    const statusEl = $(`status-s-${i}`);
    if (statusEl) { statusEl.textContent = 'processing…'; statusEl.className = 'file-list-status loading'; }
    loadingStep.textContent = `Processing ${file.name}…`;
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('dimensionality', selectedDim);
      const res = await fetch(`${CONFIG.API_BASE}/compute`, { method:'POST', body:fd });
      if (!res.ok) {
        let detail = `Server error (HTTP ${res.status})`;
        try { const e = await res.json(); detail = e.detail || detail; } catch {}
        throw new Error(detail);
      }
      const data = await res.json();
      data._filename = file.name;
      out.push({ ok:true, data, filename:file.name, mode:selectedDim });
      if (statusEl) { statusEl.textContent = 'done'; statusEl.className = 'file-list-status done'; }
    } catch (err) {
      const msg = (err instanceof TypeError && err.message.includes('fetch'))
        ? 'Cannot reach backend server.' : err.message;
      out.push({ ok:false, error:msg, filename:file.name });
      if (statusEl) { statusEl.textContent = 'error'; statusEl.className = 'file-list-status error'; }
    }
  }
  return out;
}

// Heterostructure mode — every combination of 2D × 3D
async function runHetero() {
  const out = [];
  let pairNum = 0;
  const total = heteroFiles2D.length * heteroFiles3D.length;
  for (let i = 0; i < heteroFiles2D.length; i++) {
    for (let j = 0; j < heteroFiles3D.length; j++) {
      pairNum++;
      const f2D = heteroFiles2D[i], f3D = heteroFiles3D[j];
      const s2D = $(`status-h2d-${i}`), s3D = $(`status-h3d-${j}`);
      loadingStep.textContent = `Pair ${pairNum}/${total}: ${f2D.name} + ${f3D.name}…`;
      if (s2D) { s2D.textContent = 'processing…'; s2D.className = 'file-list-status loading'; }
      if (s3D) { s3D.textContent = 'processing…'; s3D.className = 'file-list-status loading'; }
      try {
        const fd = new FormData();
        fd.append('file_2d', f2D);
        fd.append('file_3d', f3D);
        const res = await fetch(`${CONFIG.API_BASE}/compute_heterostructure`, { method:'POST', body:fd });
        if (!res.ok) {
          let detail = `Server error (HTTP ${res.status})`;
          try { const e = await res.json(); detail = e.detail || detail; } catch {}
          throw new Error(detail);
        }
        const data = await res.json();
        // (3) Pull 3D formula fields out of the response (returned by backend as
        //     chemical_formula_3d / reduced_formula_3d).  Fall back to the top-level
        //     fields when the backend hasn't yet been updated to separate them.
        out.push({
          ok: true, data,
          file2D: f2D.name,
          file3D: f3D.name,
          // Header labels (reduced formulas, populated after render once data arrives)
          label2D: data.reduced_formula_2d ?? data.reduced_formula ?? f2D.name,
          label3D: data.reduced_formula_3d ?? f3D.name,
          mode: 'HETERO',
          // convenience: keep the full filename pair for error cards
          filename: `${f2D.name} + ${f3D.name}`,
        });
        if (s2D) { s2D.textContent = 'done'; s2D.className = 'file-list-status done'; }
        if (s3D) { s3D.textContent = 'done'; s3D.className = 'file-list-status done'; }
      } catch (err) {
        const msg = (err instanceof TypeError && err.message.includes('fetch'))
          ? 'Cannot reach backend server.' : err.message;
        out.push({ ok:false, error:msg, filename:`${f2D.name} + ${f3D.name}`, file2D:f2D.name, file3D:f3D.name, mode:'HETERO' });
        if (s2D) { s2D.textContent = 'error'; s2D.className = 'file-list-status error'; }
        if (s3D) { s3D.textContent = 'error'; s3D.className = 'file-list-status error'; }
      }
    }
  }
  return out;
}

// ── Render results ────────────────────────────────────────────────────────────
// Keeps a module-level reference to the last result set for downloads
let _lastResults = [];

function renderAllResults(results) {
  _lastResults = results;
  multiResultsCont.innerHTML = '';

  // ── Build raw JSON ────────────────────────────────────────────────────────
  const isHetero = results.some(r => r.mode === 'HETERO');
  let rawPayload;
  if (isHetero) {
    rawPayload = results.filter(r => r.ok).map(r => ({
      file_2d:             r.file2D,
      file_3d:             r.file3D,
      // (3) Use fields returned by backend; label2D/label3D are set from those same fields
      chemical_formula_2d: r.data.chemical_formula_2d ?? r.data.chemical_formula ?? null,
      reduced_formula_2d:  r.data.reduced_formula_2d  ?? r.data.reduced_formula  ?? null,
      chemical_formula_3d: r.data.chemical_formula_3d ?? null,
      reduced_formula_3d:  r.data.reduced_formula_3d  ?? null,
      T2:                  r.data.T2,
      T2_unit:             r.data.T2_unit,
    }));
  } else {
    const allData = results.filter(r => r.ok).map(r => r.data);
    rawPayload = allData.length === 1 ? allData[0] : allData;
  }
  rawJson.textContent = JSON.stringify(rawPayload, null, 2);

  // ── Render one card per result ────────────────────────────────────────────
  results.forEach((result, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.style.animationDelay = `${idx * 0.07}s`;

    if (!result.ok) {
      // Error card — always show filename in header
      card.innerHTML = `
        <div class="result-card-header">
          <span class="result-card-filename">${result.filename}</span>
          <span class="result-card-index">${idx+1} / ${results.length}</span>
        </div>
        <div class="result-card-body">
          <div class="error-msg" style="margin:0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
              <circle cx="12" cy="16" r="0.5" fill="currentColor"/>
            </svg>
            ${result.error}
          </div>
        </div>`;

    } else if (result.mode === 'HETERO') {
      // ── Hetero card: header = reduced formula 2D + reduced formula 3D ──────
      const d = result.data;
      const { t2_value, t2_unit } = formatT2(d.T2);
      // (2) Use reduced formula labels (set in runHetero from backend response)
      const label2D = result.label2D;
      const label3D = result.label3D;
      const headerLabel = `${label2D} + ${label3D}`;
      card.innerHTML = `
        <div class="result-card-header">
          <span class="result-card-filename">${headerLabel}</span>
          <span class="result-card-index">${idx+1} / ${results.length}</span>
        </div>
        <div class="result-card-body">
          <div style="display:flex;gap:0.4rem;margin-bottom:0.75rem;flex-wrap:wrap;">
            <span style="font-family:var(--font-mono);font-size:0.7rem;padding:0.15em 0.55em;border-radius:4px;
                  background:var(--accent-dim);color:var(--accent);border:1px solid var(--border)">
              2D: ${label2D}
            </span>
            <span style="font-family:var(--font-mono);font-size:0.7rem;padding:0.15em 0.55em;border-radius:4px;
                  background:var(--accent2-dim);color:var(--accent2);border:1px solid rgba(59,143,255,0.2)">
              3D: ${label3D}
            </span>
          </div>
          <div class="t2-hero">
            <div class="t2-label">Coherence Time</div>
            <div class="t2-value-wrap">
              <span class="t2-value">${t2_value}</span>
              <span class="t2-unit">${t2_unit}</span>
            </div>
            <div class="t2-desc">Computed spin coherence time T₂</div>
          </div>
        </div>`;

    } else {
      // ── Standard 3D / 2D card: header = reduced formula ───────────────────
      const d = result.data;
      const { t2_value, t2_unit } = formatT2(d.T2);
      const lp = d.lattice_parameters ?? {};
      // (2) Use reduced formula as the card header label
      const headerLabel = d.reduced_formula ?? result.filename;
      card.innerHTML = `
        <div class="result-card-header">
          <span class="result-card-filename">${headerLabel}</span>
          <span class="result-card-index">${idx+1} / ${results.length}</span>
        </div>
        <div class="result-card-body">
          <div class="t2-hero">
            <div class="t2-label">Coherence Time</div>
            <div class="t2-value-wrap">
              <span class="t2-value">${t2_value}</span>
              <span class="t2-unit">${t2_unit}</span>
            </div>
            <div class="t2-desc">Computed spin coherence time T₂</div>
          </div>
          <div class="info-grid">
            <div class="info-card"><div class="info-card-label">Chemical Formula</div><div class="info-card-value formula-value">${d.reduced_formula ?? '—'}</div></div>
            <div class="info-card"><div class="info-card-label">Number of Atoms</div><div class="info-card-value">${d.num_atoms ?? '—'}</div></div>
            <div class="info-card"><div class="info-card-label">Crystal System</div><div class="info-card-value">${d.crystal_system ?? '—'}</div></div>
            <div class="info-card"><div class="info-card-label">Space Group</div><div class="info-card-value">${d.space_group ?? '—'}</div></div>
          </div>
          <div class="lattice-section">
            <h3 class="section-subtitle">Lattice Parameters</h3>
            <div class="lattice-grid">
              ${[['a','a','Å'],['b','b','Å'],['c','c','Å'],['α','alpha','°'],['β','beta','°'],['γ','gamma','°']]
                .map(([sym,key,unit]) => `
                  <div class="lattice-card">
                    <span class="lattice-sym">${sym}</span>
                    <span class="lattice-val">${fmt(lp[key])}</span>
                    <span class="lattice-unit">${unit}</span>
                  </div>`).join('')}
            </div>
          </div>
        </div>`;
    }
    multiResultsCont.appendChild(card);
  });

  resultsPanel.hidden = false;
  resultsPanel.scrollIntoView({ behavior:'smooth', block:'start' });
}

// ── Download handlers ─────────────────────────────────────────────────────────
$('downloadJson').addEventListener('click', () => {
  const blob = new Blob([rawJson.textContent], { type: 'application/json' });
  triggerDownload(blob, 't2_results.json');
});

$('downloadExcel').addEventListener('click', () => {
  const isHetero = _lastResults.some(r => r.mode === 'HETERO');
  let rows;

  if (isHetero) {
    // (3) Use label2D/label3D (from reduced_formula backend fields) and chemical_formula_3d
    rows = _lastResults.filter(r => r.ok).map(r => ({
      'Reduced Formula 2D':  r.label2D,
      'Reduced Formula 3D':  r.label3D,
      'File 2D':             r.file2D,
      'File 3D':             r.file3D,
      'Chemical Formula 2D': r.data.chemical_formula_2d ?? r.data.chemical_formula ?? '',
      'Chemical Formula 3D': r.data.chemical_formula_3d ?? '',
      'T2 (ms)':             r.data.T2,
    }));
  } else {
    rows = _lastResults.filter(r => r.ok).map(r => {
      const d = r.data;
      const lp = d.lattice_parameters ?? {};
      return {
        'Reduced Formula':  d.reduced_formula  ?? '',
        'Chemical Formula': d.chemical_formula ?? '',
        'File':             r.filename,
        'Num Atoms':        d.num_atoms        ?? '',
        'Crystal System':   d.crystal_system   ?? '',
        'Space Group':      d.space_group      ?? '',
        'a (Å)':            lp.a     ?? '',
        'b (Å)':            lp.b     ?? '',
        'c (Å)':            lp.c     ?? '',
        'α (°)':            lp.alpha ?? '',
        'β (°)':            lp.beta  ?? '',
        'γ (°)':            lp.gamma ?? '',
        'T2 (ms)':          d.T2,
      };
    });
  }

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'T2 Results');
  XLSX.writeFile(wb, 't2_results.xlsx');
});

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Reset ─────────────────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  resetSingleFiles();
  resetHeteroFiles();
  refreshComputeBtn();
  resultsPanel.hidden = true;
  multiResultsCont.innerHTML = '';
  rawContent.hidden = true;
  rawToggle.setAttribute('aria-expanded', 'false');
  $('uploadSection').scrollIntoView({ behavior:'smooth' });
});

// ── Raw toggle ────────────────────────────────────────────────────────────────
rawToggle.addEventListener('click', () => {
  const exp = rawToggle.getAttribute('aria-expanded') === 'true';
  rawToggle.setAttribute('aria-expanded', String(!exp));
  rawContent.hidden = exp;
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function setLoading(on) {
  loadingState.hidden = !on;
  computeBtn.style.display = on ? 'none' : '';
}
function showError(msg) { errorText.textContent = msg; errorMsg.hidden = false; }
function clearError()   { errorMsg.hidden = true; errorText.textContent = ''; }

function formatBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024*1024) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/(1024*1024)).toFixed(2)} MB`;
}
function fmt(val, d=4) {
  if (val === undefined || val === null) return '—';
  return Number(val).toFixed(d);
}
function formatT2(t2) {
  if (t2 === undefined || t2 === null) return { t2_value:'—', t2_unit:'' };
  const v = Number(t2);
  if (isNaN(v)) return { t2_value:String(t2), t2_unit:'' };
  if (v >= 1000)  return { t2_value:(v/1000).toPrecision(4),  t2_unit:'s'  };
  if (v >= 1)     return { t2_value:v.toPrecision(4),          t2_unit:'ms' };
  if (v >= 1e-3)  return { t2_value:(v*1e3).toPrecision(4),   t2_unit:'μs' };
  return               { t2_value:(v*1e6).toPrecision(4),   t2_unit:'ns' };
}

// ═══════════════════════════════════════════════════════════════
//  DATABASE EXPLORER
// ═══════════════════════════════════════════════════════════════

// ── Periodic table layout ──────────────────────────────────────
// Each entry: [symbol, atomic_number, col, row, category]
const PT_ELEMENTS = [
  ['H',1,1,1,'nonmetal'],['He',2,18,1,'noble'],
  ['Li',3,1,2,'alkali'],['Be',4,2,2,'alkaline'],['B',5,13,2,'metalloid'],['C',6,14,2,'nonmetal'],['N',7,15,2,'nonmetal'],['O',8,16,2,'nonmetal'],['F',9,17,2,'halogen'],['Ne',10,18,2,'noble'],
  ['Na',11,1,3,'alkali'],['Mg',12,2,3,'alkaline'],['Al',13,13,3,'post'],['Si',14,14,3,'metalloid'],['P',15,15,3,'nonmetal'],['S',16,16,3,'nonmetal'],['Cl',17,17,3,'halogen'],['Ar',18,18,3,'noble'],
  ['K',19,1,4,'alkali'],['Ca',20,2,4,'alkaline'],['Sc',21,3,4,'transition'],['Ti',22,4,4,'transition'],['V',23,5,4,'transition'],['Cr',24,6,4,'transition'],['Mn',25,7,4,'transition'],['Fe',26,8,4,'transition'],['Co',27,9,4,'transition'],['Ni',28,10,4,'transition'],['Cu',29,11,4,'transition'],['Zn',30,12,4,'transition'],['Ga',31,13,4,'post'],['Ge',32,14,4,'metalloid'],['As',33,15,4,'metalloid'],['Se',34,16,4,'nonmetal'],['Br',35,17,4,'halogen'],['Kr',36,18,4,'noble'],
  ['Rb',37,1,5,'alkali'],['Sr',38,2,5,'alkaline'],['Y',39,3,5,'transition'],['Zr',40,4,5,'transition'],['Nb',41,5,5,'transition'],['Mo',42,6,5,'transition'],['Tc',43,7,5,'transition'],['Ru',44,8,5,'transition'],['Rh',45,9,5,'transition'],['Pd',46,10,5,'transition'],['Ag',47,11,5,'transition'],['Cd',48,12,5,'transition'],['In',49,13,5,'post'],['Sn',50,14,5,'post'],['Sb',51,15,5,'metalloid'],['Te',52,16,5,'metalloid'],['I',53,17,5,'halogen'],['Xe',54,18,5,'noble'],
  ['Cs',55,1,6,'alkali'],['Ba',56,2,6,'alkaline'],['La',57,3,6,'lanthanide'],['Hf',72,4,6,'transition'],['Ta',73,5,6,'transition'],['W',74,6,6,'transition'],['Re',75,7,6,'transition'],['Os',76,8,6,'transition'],['Ir',77,9,6,'transition'],['Pt',78,10,6,'transition'],['Au',79,11,6,'transition'],['Hg',80,12,6,'transition'],['Tl',81,13,6,'post'],['Pb',82,14,6,'post'],['Bi',83,15,6,'post'],['Po',84,16,6,'metalloid'],['At',85,17,6,'halogen'],['Rn',86,18,6,'noble'],
  ['Fr',87,1,7,'alkali'],['Ra',88,2,7,'alkaline'],['Ac',89,3,7,'actinide'],['Rf',104,4,7,'transition'],['Db',105,5,7,'transition'],['Sg',106,6,7,'transition'],['Bh',107,7,7,'transition'],['Hs',108,8,7,'transition'],['Mt',109,9,7,'transition'],['Ds',110,10,7,'transition'],['Rg',111,11,7,'transition'],['Cn',112,12,7,'transition'],['Nh',113,13,7,'post'],['Fl',114,14,7,'post'],['Mc',115,15,7,'post'],['Lv',116,16,7,'post'],['Ts',117,17,7,'halogen'],['Og',118,18,7,'noble'],
  // Lanthanides row 9 (visual row)
  ['Ce',58,4,9,'lanthanide'],['Pr',59,5,9,'lanthanide'],['Nd',60,6,9,'lanthanide'],['Pm',61,7,9,'lanthanide'],['Sm',62,8,9,'lanthanide'],['Eu',63,9,9,'lanthanide'],['Gd',64,10,9,'lanthanide'],['Tb',65,11,9,'lanthanide'],['Dy',66,12,9,'lanthanide'],['Ho',67,13,9,'lanthanide'],['Er',68,14,9,'lanthanide'],['Tm',69,15,9,'lanthanide'],['Yb',70,16,9,'lanthanide'],['Lu',71,17,9,'lanthanide'],
  // Actinides row 10
  ['Th',90,4,10,'actinide'],['Pa',91,5,10,'actinide'],['U',92,6,10,'actinide'],['Np',93,7,10,'actinide'],['Pu',94,8,10,'actinide'],['Am',95,9,10,'actinide'],['Cm',96,10,10,'actinide'],['Bk',97,11,10,'actinide'],['Cf',98,12,10,'actinide'],['Es',99,13,10,'actinide'],['Fm',100,14,10,'actinide'],['Md',101,15,10,'actinide'],['No',102,16,10,'actinide'],['Lr',103,17,10,'actinide'],
];

// ── State ─────────────────────────────────────────────────────
let DB_DATA       = [];   // full dataset loaded from db.json
let db_selected   = new Set();   // selected element symbols
let db_filtered   = [];  // current filtered+sorted array
let db_page       = 1;
const DB_PER_PAGE = 50;
let db_sort       = 'desc';
let db_search     = '';
let db_filter_mode = 'at-least'; // 'at-least' | 'only'

// ── Build periodic table DOM ───────────────────────────────────
function buildPeriodicTable() {
  const ptable = document.getElementById('ptable');
  if (!ptable) return;

  // Find which elements actually appear in our dataset
  const available = new Set();
  DB_DATA.forEach(r => r.el.forEach(e => available.add(e)));

  // Build a grid map: 'row-col' -> element
  const cellMap = {};
  PT_ELEMENTS.forEach(([sym, num, col, row, cat]) => {
    cellMap[`${row}-${col}`] = { sym, num, col, row, cat };
  });

  // We need 10 rows (1-7 main, 8=spacer, 9=lanthanide, 10=actinide)
  const maxRow = 10;
  const maxCol = 18;

  for (let r = 1; r <= maxRow; r++) {
    for (let c = 1; c <= maxCol; c++) {
      const key = `${r}-${c}`;
      const el = cellMap[key];
      const div = document.createElement('div');

      if (r === 8) {
        // Spacer row
        div.className = 'pt-cell placeholder';
        ptable.appendChild(div);
        continue;
      }

      if (!el) {
        div.className = 'pt-cell placeholder';
        ptable.appendChild(div);
        continue;
      }

      const isAvail = available.has(el.sym);
      div.className = `pt-cell pt-${el.cat}${isAvail ? '' : ' unavailable'}`;
      div.dataset.sym = el.sym;
      div.innerHTML = `<span class="pt-sym">${el.sym}</span><span class="pt-num">${el.num}</span>`;
      div.title = el.sym;

      if (isAvail) {
        div.addEventListener('click', () => toggleElement(el.sym));
      }
      ptable.appendChild(div);
    }
  }
}

function toggleElement(sym) {
  if (db_selected.has(sym)) {
    db_selected.delete(sym);
  } else {
    db_selected.add(sym);
  }
  // Update visual state
  document.querySelectorAll('.pt-cell[data-sym]').forEach(cell => {
    if (db_selected.has(cell.dataset.sym)) {
      cell.classList.add('selected');
    } else {
      cell.classList.remove('selected');
    }
  });
  updateHint();
  applyFilters();
}

function updateHint() {
  const hint = document.getElementById('ptableHint');
  if (!hint) return;
  if (db_selected.size === 0) {
    hint.textContent = 'No elements selected — showing all materials';
  } else {
    const modeLabel = db_filter_mode === 'only' ? 'only' : 'at least';
    hint.textContent = `Selected (${modeLabel}): ${[...db_selected].join(', ')}`;
  }
}

// ── Filtering & rendering ──────────────────────────────────────
function applyFilters() {
  const selArr = [...db_selected];
  const q = db_search.trim().toLowerCase();

  db_filtered = DB_DATA.filter(row => {
    // Element filter
    if (selArr.length > 0) {
      const hasAll = selArr.every(e => row.el.includes(e));
      if (!hasAll) return false;
      // 'only' mode: material must not contain any elements outside the selection
      if (db_filter_mode === 'only' && row.el.some(e => !selArr.includes(e))) return false;
    }
    // Text search filter
    if (q && !row.m.toLowerCase().includes(q) && !row.id.toLowerCase().includes(q)) return false;
    return true;
  });

  // Sort by T2
  db_filtered.sort((a, b) => db_sort === 'desc' ? b.t2 - a.t2 : a.t2 - b.t2);

  db_page = 1;
  renderTable();
  renderPagination();
  updateMeta();
}

function formatT2Raw(v) {
  // Format raw T2 value in seconds for the table
  if (v >= 1) return v.toPrecision(4) + ' s';
  if (v >= 1e-3) return (v * 1e3).toPrecision(4) + ' ms';
  if (v >= 1e-6) return (v * 1e6).toPrecision(4) + ' μs';
  if (v >= 1e-9) return (v * 1e9).toPrecision(4) + ' ns';
  return v.toExponential(3) + ' s';
}

function renderTable() {
  const tbody = document.getElementById('dbTbody');
  if (!tbody) return;

  const start = (db_page - 1) * DB_PER_PAGE;
  const slice = db_filtered.slice(start, start + DB_PER_PAGE);

  if (slice.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="db-td" style="text-align:center;color:var(--text-3);padding:2rem;">No materials match your selection.</td></tr>`;
    return;
  }

  tbody.innerHTML = slice.map((row, i) => {
    const rank = start + i + 1;
    const mpLink = row.id
      ? `<a href="https://next-gen.materialsproject.org/materials/${row.id}" target="_blank" rel="noopener">${row.id}</a>`
      : '—';
    return `<tr>
      <td class="db-td db-td-num">${rank}</td>
      <td class="db-td db-td-formula">${row.m}</td>
      <td class="db-td db-td-id">${mpLink}</td>
      <td class="db-td db-td-t2">${formatT2Raw(row.t2)}</td>
    </tr>`;
  }).join('');
}

function renderPagination() {
  const container = document.getElementById('dbPagination');
  if (!container) return;
  const totalPages = Math.ceil(db_filtered.length / DB_PER_PAGE);
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  let html = '';
  const addBtn = (label, page, isActive = false, disabled = false) => {
    html += `<button class="db-page-btn${isActive ? ' active' : ''}" data-page="${page}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  };
  const addEllipsis = () => { html += `<span class="db-page-ellipsis">…</span>`; };

  addBtn('‹', db_page - 1, false, db_page === 1);

  if (totalPages <= 7) {
    for (let p = 1; p <= totalPages; p++) addBtn(p, p, p === db_page);
  } else {
    addBtn(1, 1, db_page === 1);
    if (db_page > 3) addEllipsis();
    for (let p = Math.max(2, db_page - 1); p <= Math.min(totalPages - 1, db_page + 1); p++) {
      addBtn(p, p, p === db_page);
    }
    if (db_page < totalPages - 2) addEllipsis();
    addBtn(totalPages, totalPages, db_page === totalPages);
  }

  addBtn('›', db_page + 1, false, db_page === totalPages);

  container.innerHTML = html;
  container.querySelectorAll('.db-page-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      db_page = parseInt(btn.dataset.page);
      renderTable();
      renderPagination();
      updateMeta();
      document.getElementById('database').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function updateMeta() {
  const meta = document.getElementById('dbMeta');
  if (!meta) return;
  const total = db_filtered.length;
  const start = (db_page - 1) * DB_PER_PAGE + 1;
  const end = Math.min(db_page * DB_PER_PAGE, total);
  meta.textContent = total === 0
    ? '0 materials found'
    : `Showing ${start}–${end} of ${total.toLocaleString()} materials`;
}

// ── Init: load data, wire events ───────────────────────────────
(async function initDatabase() {
  try {
    const res = await fetch('db.json');
    DB_DATA = await res.json();
  } catch (e) {
    const meta = document.getElementById('dbMeta');
    if (meta) meta.textContent = 'Failed to load database.';
    return;
  }

  buildPeriodicTable();
  applyFilters();

  // Sort control
  const sortEl = document.getElementById('dbSort');
  if (sortEl) sortEl.addEventListener('change', () => { db_sort = sortEl.value; applyFilters(); });

  // Filter mode control
  const filterModeEl = document.getElementById('dbFilterMode');
  if (filterModeEl) filterModeEl.addEventListener('change', () => { db_filter_mode = filterModeEl.value; updateHint(); applyFilters(); });

  // Search control (debounced)
  const searchEl = document.getElementById('dbSearch');
  let searchTimer;
  if (searchEl) searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { db_search = searchEl.value; applyFilters(); }, 250);
  });

  // Clear button
  const clearBtn = document.getElementById('ptableClear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    db_selected.clear();
    document.querySelectorAll('.pt-cell.selected').forEach(c => c.classList.remove('selected'));
    updateHint();
    applyFilters();
  });
})();
