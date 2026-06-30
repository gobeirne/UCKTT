// listBuilder.js — Custom KTT list builder
// Exposes window.kttListBuilder.open(listId, onSave)
// Saves to localStorage key 'ktt_custom_lists_v1' (shared with manualTest.js)

(() => {
  'use strict';

  const LS_KEY = 'ktt_custom_lists_v1';
  const TARGET = 15;

  // ─── Word pool ─────────────────────────────────────────────────────────────
  // Table 1: full word pool grouped by vowel sound
  const VOWEL_GROUPS = [
    { label: '/a/ /ā/', words: ['taraka','karaka','māmā','māra','tāra','mata','pata','pāpā','haka','waka','mahi','pahi','paki','tahi'] },
    { label: '/e/ /ē/', words: ['hēki','hēti','keke','wheke','pere'] },
    { label: '/i/ /ī/', words: ['kīngi','rīngi','rīhi','tīhi','ihu','inu','ipu','koti','poti'] },
    { label: '/o/ /ō/', words: ['koro','roro','mako','moko','kōrero','kōtiro','tōtiti'] },
    { label: '/u/ /ū/', words: ['hū','pū','kutu','manu','motu'] },
    { label: '/ai/',    words: ['kai','pai','tai','wai'] },
    { label: '/ae/',    words: ['taea','waea','whaea'] },
    { label: '/au/',    words: ['kau','rau','tau'] },
  ];

  // Table 2: minimal pairs lookup
  const PAIRS = {
    haka:    ['waka'],
    hēki:    ['hēti'],
    hēti:    ['hēki'],
    hū:      ['pū'],
    ihu:     ['inu','ipu'],
    inu:     ['ihu','ipu'],
    ipu:     ['inu','ihu'],
    kai:     ['pai','tai','wai'],
    karaka:  ['taraka'],
    kau:     ['tau','rau'],
    keke:    ['wheke'],
    kīngi:   ['rīngi','rīhi'],
    kōrero:  ['kōtiro'],
    koro:    ['roro'],
    koti:    ['poti'],
    kōtiro:  ['kōrero','tōtiti'],
    kutu:    [],
    mahi:    ['pahi','tahi'],
    mako:    ['moko'],
    māmā:    ['māra','mata','pāpā'],
    manu:    [],
    māra:    ['māmā','tāra'],
    mata:    ['māmā','māra','pata'],
    moko:    ['mako'],
    motu:    [],
    pahi:    ['tahi','mahi'],
    pai:     ['tai','wai','kai'],
    paki:    [],
    pāpā:    ['pata','māmā'],
    pata:    ['pāpā','mata'],
    pere:    [],
    poti:    ['koti'],
    pū:      ['hū'],
    rau:     ['kau','tau'],
    rīhi:    ['rīngi','tīhi'],
    rīngi:   ['kīngi','rīhi'],
    roro:    ['koro'],
    taea:    ['waea','whaea'],
    tahi:    ['tīhi','mahi','pahi'],
    tai:     ['kai','pai','wai'],
    tāra:    ['māra'],
    taraka:  ['karaka'],
    tau:     ['kau','rau'],
    tīhi:    ['rīhi'],
    tōtiti:  ['kōtiro'],
    waea:    ['whaea','taea'],
    wai:     ['kai','pai','tai'],
    waka:    ['haka'],
    whaea:   ['taea','waea'],
    wheke:   ['keke'],
  };

  // ─── Visual conflict groups ─────────────────────────────────────────────────
  // Some kupu, with their DEFAULT images, share a confounding visual feature
  // (e.g. both depict water, or both depict food), so a child could pick the
  // right picture for the wrong reason. These are soft cautions, not blocks —
  // a clinician using their own uploaded images may have no conflict at all.
  // Add new members to a group's `words`; the warning fires for any 2+ in a group.
  const CONFLICT_GROUPS = [
    { id: 'water', feature: 'contain water', words: ['inu', 'wai'] },
    { id: 'food',  feature: 'are food',      words: ['kai', 'tīhi'] },
  ];

  // Returns array of { feature, words:[...] } for every group with 2+ selected.
  function detectConflicts() {
    const out = [];
    CONFLICT_GROUPS.forEach(g => {
      const hits = g.words.filter(w => selected.has(w));
      if (hits.length >= 2) out.push({ feature: g.feature, words: hits });
    });
    return out;
  }

  // ─── State ─────────────────────────────────────────────────────────────────
  let selected = new Set();
  let listName = '';
  let editingId   = null;       // null = new, string = editing existing custom list
  let isBuiltin   = false;      // true when viewing an Isiah/builtin list
  let originalKupu = [];        // snapshot of kupu on open — to detect changes
  let onSaveCallback = null;
  let overlayEl = null;

  // ─── Storage helpers ───────────────────────────────────────────────────────
  function loadCustomLists() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
  }
  function saveCustomLists(lists) {
    localStorage.setItem(LS_KEY, JSON.stringify(lists));
  }

  // ─── Pair logic ────────────────────────────────────────────────────────────
  function getSuggested() {
    // Words that are pairs of selected words but not yet selected themselves
    const s = new Set();
    selected.forEach(w => {
      (PAIRS[w] || []).forEach(p => { if (!selected.has(p)) s.add(p); });
    });
    return s;
  }

  function toggleWord(word) {
    if (selected.has(word)) selected.delete(word);
    else selected.add(word);
    renderAll();
  }

  function addWord(word) {
    selected.add(word);
    renderAll();
  }

  // ─── Counter helpers ───────────────────────────────────────────────────────
  function counterText() {
    const n = selected.size;
    if (n === 0)       return { num: '0', strong: 'of 15 kupu', sub: 'add 15 to reach standard size', color: '#888' };
    if (n < TARGET)    return { num: String(n), strong: `of 15 kupu`, sub: `add ${TARGET - n} more to reach 15`, color: '#111' };
    if (n === TARGET)  return { num: String(n), strong: 'of 15 — ready!', sub: 'standard list size reached', color: '#1a7a30' };
    return { num: String(n), strong: `of 15 — ${n - TARGET} over`, sub: 'you can still proceed', color: '#b05800' };
  }

  // ─── Main render ───────────────────────────────────────────────────────────
  function renderAll() {
    if (!overlayEl) return;
    const suggested = getSuggested();
    renderChips(suggested);
    renderCounter();
    renderBasket(suggested);
  }

  function renderChips(suggested) {
    overlayEl.querySelectorAll('.lb-chip').forEach(chip => {
      const w = chip.dataset.word;
      chip.className = 'lb-chip' +
        (selected.has(w) ? ' selected' : suggested.has(w) ? ' suggested' : '');
    });
    const cnt = overlayEl.querySelector('#lb-sel-count');
    if (cnt) cnt.textContent = selected.size;
  }

  function renderCounter() {
    const ct = counterText();
    const num = overlayEl.querySelector('#lb-counter-num');
    const strong = overlayEl.querySelector('#lb-counter-strong');
    const sub = overlayEl.querySelector('#lb-counter-sub');
    const bar = overlayEl.querySelector('#lb-progress-bar');
    if (num) { num.textContent = ct.num; num.style.color = ct.color; }
    if (strong) strong.textContent = ct.strong;
    if (sub) sub.textContent = ct.sub;
    if (bar) {
      const pct = Math.min(100, Math.round(selected.size / TARGET * 100));
      bar.style.width = pct + '%';
      bar.style.background = selected.size === TARGET ? '#1a7a30' : selected.size > TARGET ? '#b05800' : '#3a7de0';
    }
    // Proceed link
    const proc = overlayEl.querySelector('#lb-proceed-note');
    const procCount = overlayEl.querySelector('#lb-proceed-count');
    if (proc) proc.style.display = (selected.size > 0 && selected.size !== TARGET) ? 'block' : 'none';
    if (procCount) procCount.textContent = selected.size;
  }

  function renderBasket(suggested) {
    const container = overlayEl.querySelector('#lb-basket-items');
    if (!container) return;

    if (selected.size === 0) {
      container.innerHTML = '<div class="lb-basket-empty">No kupu added yet.<br>Click words on the left to begin.</div>';
      return;
    }

    // Soft caution for kupu whose default images share a confounding feature.
    let html = '';
    const conflicts = detectConflicts();
    if (conflicts.length) {
      const lines = conflicts.map(c => {
        const list = c.words.join(' + ');
        return `<div class="lb-conflict-line"><strong>${list}</strong> ${c.feature}</div>`;
      }).join('');
      html += `
        <div class="lb-conflict">
          <div class="lb-conflict-head">⚠ Possible image overlap</div>
          ${lines}
          <div class="lb-conflict-note">A child might choose correctly for the wrong reason.
          Fine to keep if your own images differ — just a heads-up.</div>
        </div>`;
    }

    selected.forEach(w => {
      const pairs = (PAIRS[w] || []);
      const pairTags = pairs.map(p => {
        if (selected.has(p)) {
          return `<span class="lb-pair-tag active">${p}</span>`;
        }
        // pair is suggested but not selected — clickable to add
        return `<span class="lb-pair-tag suggested" data-add="${p}" title="Add ${p}">${p} +</span>`;
      }).join('');
      html += `
        <div class="lb-basket-item">
          <div class="lb-basket-word">${w}</div>
          <div class="lb-basket-pairs">${pairTags}</div>
          <button class="lb-remove-btn" data-remove="${w}" title="Remove ${w}">✕</button>
        </div>`;
    });
    container.innerHTML = html;

    // Wire remove buttons
    container.querySelectorAll('.lb-remove-btn').forEach(btn => {
      btn.onclick = () => { selected.delete(btn.dataset.remove); renderAll(); };
    });
    // Wire add-pair tags
    container.querySelectorAll('.lb-pair-tag.suggested').forEach(tag => {
      tag.onclick = () => addWord(tag.dataset.add);
    });
  }

  // ─── Build the overlay DOM ─────────────────────────────────────────────────
  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'lb-overlay';
    overlay.className = 'lb-overlay';

    const title = isBuiltin
      ? `Viewing ${listName.replace(' (copy)', '')} — save as new list to keep changes`
      : editingId ? 'Edit list' : 'Build a custom test list';

    overlay.innerHTML = `
      <div class="lb-modal">
        <div class="lb-modal-header">
          <div>
            <div class="lb-modal-title">${title}</div>
            <div class="lb-modal-sub">${isBuiltin
              ? '🔒 Built-in list — any changes will be saved as a new custom list'
              : 'Select kupu — minimal pairs are suggested automatically'}</div>
          </div>
          <button class="lb-close-btn" id="lb-close">✕</button>
        </div>

        <!-- Body: two panels -->
        <div class="lb-modal-body">

          <!-- LEFT: word pool -->
          <div class="lb-panel-left">
            <div class="lb-panel-head">
              <span class="lb-panel-title">Kupu by vowel sound</span>
              <span class="lb-small-muted"><span id="lb-sel-count">0</span> added</span>
            </div>
            <div class="lb-legend-row">
              <span class="lb-leg-item"><span class="lb-leg-dot selected"></span> Added</span>
              <span class="lb-leg-item"><span class="lb-leg-dot suggested"></span> Suggested pair</span>
              <span class="lb-leg-item"><span class="lb-leg-dot"></span> Available</span>
            </div>
            <div class="lb-word-pool" id="lb-word-pool">
              ${buildWordPoolHTML()}
            </div>
          </div>

          <!-- RIGHT: basket -->
          <div class="lb-panel-right">
            <div class="lb-basket-header">
              <div class="lb-panel-title">Your list</div>
              <!-- Counter -->
              <div class="lb-counter-row">
                <div class="lb-counter-num" id="lb-counter-num">0</div>
                <div class="lb-counter-labels">
                  <div class="lb-counter-strong" id="lb-counter-strong">of 15 kupu</div>
                  <div class="lb-counter-sub" id="lb-counter-sub">add 15 to reach standard size</div>
                </div>
              </div>
              <div class="lb-progress-track"><div class="lb-progress-bar" id="lb-progress-bar" style="width:0%"></div></div>
            </div>

            <div class="lb-name-row">
              <input class="lb-name-input" id="lb-name-input" type="text"
                placeholder="Name this list…" value="${escHtml(listName)}" />
            </div>

            <div class="lb-basket-items" id="lb-basket-items">
              <div class="lb-basket-empty">No kupu added yet.<br>Click words on the left to begin.</div>
            </div>

            <div class="lb-footer">
              <div class="lb-footer-btns">
                <button class="lb-btn" id="lb-clear-btn">Clear</button>
                <button class="lb-btn lb-btn-primary" id="lb-save-btn">${isBuiltin ? 'Save as new list' : 'Save list'}</button>
              </div>
              <div class="lb-proceed-note" id="lb-proceed-note" style="display:none">
                <a class="lb-proceed-link" id="lb-proceed-link" href="#">
                  Save &amp; use with <span id="lb-proceed-count">0</span> kupu anyway →
                </a>
              </div>
            </div>
          </div>

        </div>
      </div>`;

    return overlay;
  }

  function buildWordPoolHTML() {
    return VOWEL_GROUPS.map(g => `
      <div class="lb-vowel-group">
        <div class="lb-vowel-label">${g.label}</div>
        <div class="lb-chip-row">
          ${g.words.map(w => `<div class="lb-chip" data-word="${w}">${w}</div>`).join('')}
        </div>
      </div>`).join('');
  }

  function escHtml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ─── Wire events ───────────────────────────────────────────────────────────
  function wireEvents() {
    // Chip clicks (left = toggle, right-click = replace image)
    overlayEl.querySelectorAll('.lb-chip').forEach(chip => {
      chip.onclick = () => toggleWord(chip.dataset.word);
      chip.oncontextmenu = (e) => {
        e.preventDefault();
        if (window.kttImageStore) {
          window.kttImageStore.openReplacer(chip.dataset.word, () => {});
        }
      };
      chip.title = chip.dataset.word + ' (right-click to replace image)';
    });

    // Close / backdrop
    overlayEl.querySelector('#lb-close').onclick = close;
    overlayEl.addEventListener('click', e => {
      if (e.target === overlayEl) close();
    });

    // Clear
    overlayEl.querySelector('#lb-clear-btn').onclick = () => {
      if (selected.size === 0 || confirm('Clear all selected kupu?')) {
        selected.clear();
        renderAll();
      }
    };

    // Save
    overlayEl.querySelector('#lb-save-btn').onclick = saveList;

    // Proceed
    overlayEl.querySelector('#lb-proceed-link').onclick = (e) => {
      e.preventDefault();
      saveList(true);
    };

    // Name input sync
    overlayEl.querySelector('#lb-name-input').oninput = (e) => {
      listName = e.target.value;
    };
  }

  // ─── Save ──────────────────────────────────────────────────────────────────
  function saveList(force) {
    const name = (overlayEl.querySelector('#lb-name-input').value || '').trim();
    if (!name) {
      overlayEl.querySelector('#lb-name-input').focus();
      overlayEl.querySelector('#lb-name-input').style.borderColor = '#d94040';
      setTimeout(() => { if (overlayEl) overlayEl.querySelector('#lb-name-input').style.borderColor = ''; }, 1500);
      return;
    }
    if (selected.size === 0) { alert('Please add at least one kupu.'); return; }
    if (!force && selected.size !== TARGET) {
      const proc = overlayEl.querySelector('#lb-proceed-note');
      if (proc) { proc.style.display = 'block'; proc.querySelector('a').style.fontWeight = '700'; }
    }

    // For builtin lists, always create a new custom list — never overwrite
    // For custom lists, check if anything actually changed — if not, just close
    if (!isBuiltin && editingId) {
      const currentKupu = Array.from(selected).sort().join(',');
      const origKupu    = [...originalKupu].sort().join(',');
      const origName    = (() => {
        const lists = loadCustomLists();
        return lists.find(l => l.id === editingId)?.name || '';
      })();
      if (currentKupu === origKupu && name === origName) {
        // Nothing changed — just close
        close();
        return;
      }
    }

    const existing = loadCustomLists();
    const kupu = Array.from(selected);
    const now  = Date.now();

    if (!isBuiltin && editingId) {
      // Update existing custom list
      const idx = existing.findIndex(l => l.id === editingId);
      if (idx >= 0) existing[idx] = { ...existing[idx], name, kupu, updatedAt: now };
      else existing.unshift({ id: editingId, name, kupu, builtin: false, createdAt: now });
    } else {
      // New custom list (either fresh, or saved copy of a builtin)
      const id = 'custom_' + now + '_' + Math.random().toString(36).slice(2, 7);
      existing.unshift({ id, name, kupu, builtin: false, createdAt: now });
    }

    saveCustomLists(existing);
    close();
    if (typeof onSaveCallback === 'function') onSaveCallback();
  }

  // ─── Open / Close ──────────────────────────────────────────────────────────
  // listId   — custom list ID to edit, OR null for new
  // callback — called after save
  // builtinList — { id, name, kupu } passed directly for Isiah/builtin lists
  function open(listId, callback, builtinList) {
    onSaveCallback = callback || null;
    editingId  = null;
    isBuiltin  = false;
    selected.clear();
    listName = '';
    originalKupu = [];

    if (builtinList) {
      // Viewing a builtin — pre-populate but never save back to it
      isBuiltin = true;
      listName  = builtinList.name + ' (copy)';
      (builtinList.kupu || []).forEach(w => selected.add(w));
      originalKupu = [...selected];
    } else if (listId) {
      // Editing a custom list
      editingId = listId;
      const lists = loadCustomLists();
      const existing = lists.find(l => l.id === listId);
      if (existing) {
        listName = existing.name;
        (existing.kupu || []).forEach(w => selected.add(w));
        originalKupu = [...selected];
      }
    }

    overlayEl = buildOverlay();
    document.body.appendChild(overlayEl);
    wireEvents();
    renderAll();

    setTimeout(() => {
      const nameInp = overlayEl.querySelector('#lb-name-input');
      if (nameInp && !listName) nameInp.focus();
    }, 100);
  }

  function close() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  // ─── Inject styles ─────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('lb-styles')) return;
    const style = document.createElement('style');
    style.id = 'lb-styles';
    style.textContent = `
.lb-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.45);
  display: flex; align-items: center; justify-content: center;
  z-index: 9000; padding: 16px; box-sizing: border-box;
}
.lb-modal {
  background: #fff; border-radius: 10px; width: 100%; max-width: 860px;
  max-height: 92vh; display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 4px 32px rgba(0,0,0,.18);
}
.lb-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid #e8e8e8; background: #f7f7f7;
  flex-shrink: 0;
}
.lb-modal-title { font-size: 14px; font-weight: 700; color: #111; }
.lb-modal-sub   { font-size: 12px; color: #777; margin-top: 1px; }
.lb-close-btn {
  font-size: 16px; border: none; background: none; cursor: pointer;
  color: #888; padding: 4px 8px; border-radius: 4px;
}
.lb-close-btn:hover { background: #eee; color: #111; }

.lb-modal-body {
  display: grid; grid-template-columns: 1fr 280px;
  flex: 1; overflow: hidden;
}

/* Left panel */
.lb-panel-left {
  border-right: 1px solid #e8e8e8; display: flex; flex-direction: column; overflow: hidden;
}
.lb-panel-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 14px; border-bottom: 1px solid #f0f0f0;
}
.lb-panel-title { font-size: 12px; font-weight: 700; color: #111; }
.lb-small-muted { font-size: 11px; color: #888; }

.lb-legend-row {
  display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  padding: 5px 14px; border-bottom: 1px solid #f5f5f5; background: #fafafa;
}
.lb-leg-item { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #666; }
.lb-leg-dot {
  width: 10px; height: 10px; border-radius: 50%;
  border: 1px solid #ccc; background: #f0f0f0; flex-shrink: 0;
}
.lb-leg-dot.selected  { background: #3a7de0; border-color: #1a5fa5; }
.lb-leg-dot.suggested { background: #4a9e1a; border-color: #2d7010; }

.lb-word-pool {
  padding: 10px 14px; overflow-y: auto; flex: 1;
  display: flex; flex-direction: column; gap: 12px;
}
.lb-vowel-group {}
.lb-vowel-label {
  font-size: 11px; font-weight: 700; color: #888; margin-bottom: 6px;
  letter-spacing: .03em;
}
.lb-chip-row { display: flex; flex-wrap: wrap; gap: 5px; }
.lb-chip {
  font-size: 13px; padding: 4px 11px; border-radius: 100px;
  border: 1px solid #ccc; background: #f5f5f5; color: #555;
  cursor: pointer; user-select: none; white-space: nowrap;
  transition: background .1s, border-color .1s, color .1s;
}
.lb-chip:hover { border-color: #999; background: #ebebeb; color: #111; }
.lb-chip.selected  { background: #ddeeff; border-color: #3a7de0; color: #0c3d8a; font-weight: 600; }
.lb-chip.suggested { background: #dff0cc; border-color: #4a9e1a; color: #1a5a00; }

/* Right panel */
.lb-panel-right {
  display: flex; flex-direction: column; background: #f7f7f7; overflow: hidden;
}
.lb-basket-header {
  padding: 10px 14px; border-bottom: 1px solid #e8e8e8; background: #fff; flex-shrink: 0;
}
.lb-counter-row { display: flex; align-items: center; gap: 8px; margin: 6px 0 4px; }
.lb-counter-num { font-size: 26px; font-weight: 700; line-height: 1; color: #111; min-width: 32px; }
.lb-counter-labels { flex: 1; }
.lb-counter-strong { font-size: 13px; font-weight: 600; color: #111; }
.lb-counter-sub    { font-size: 11px; color: #888; margin-top: 1px; }
.lb-progress-track { height: 4px; background: #e8e8e8; border-radius: 2px; margin-top: 4px; }
.lb-progress-bar   { height: 4px; border-radius: 2px; background: #3a7de0; transition: width .2s, background .2s; }

.lb-name-row {
  padding: 8px 12px; border-bottom: 1px solid #e8e8e8; flex-shrink: 0;
}
.lb-name-input {
  width: 100%; font-size: 13px; padding: 6px 9px; border: 1px solid #ccc;
  border-radius: 6px; background: #fff; color: #111; box-sizing: border-box;
}
.lb-name-input:focus { outline: none; border-color: #3a7de0; box-shadow: 0 0 0 2px #c8dcfa; }

.lb-basket-items { flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
.lb-basket-empty { font-size: 12px; color: #aaa; text-align: center; padding: 24px 0; line-height: 1.7; }

.lb-conflict {
  background: #fff8e1; border: 1px solid #ffe08a; border-radius: 7px;
  padding: 8px 10px; margin-bottom: 8px;
}
.lb-conflict-head { font-size: 12px; font-weight: 700; color: #7a5b00; margin-bottom: 3px; }
.lb-conflict-line { font-size: 12px; color: #5a4500; line-height: 1.6; }
.lb-conflict-line strong { color: #111; }
.lb-conflict-note { font-size: 11px; color: #8a7330; margin-top: 4px; line-height: 1.5; }

.lb-basket-item {
  background: #fff; border: 1px solid #e8e8e8; border-radius: 7px;
  padding: 6px 8px; display: flex; align-items: center; gap: 6px;
  border-left: 3px solid #3a7de0;
}
.lb-basket-word { font-size: 13px; font-weight: 700; min-width: 58px; color: #111; }
.lb-basket-pairs { flex: 1; display: flex; flex-wrap: wrap; gap: 3px; }
.lb-pair-tag {
  font-size: 11px; padding: 2px 7px; border-radius: 100px;
}
.lb-pair-tag.active    { background: #ddeeff; color: #0c3d8a; border: 1px solid #9ab8f0; }
.lb-pair-tag.suggested {
  background: #dff0cc; color: #1a5a00; border: 1px solid #8dc860;
  cursor: pointer;
}
.lb-pair-tag.suggested:hover { background: #c5e59a; }
.lb-remove-btn {
  font-size: 13px; border: none; background: none; cursor: pointer;
  color: #aaa; padding: 2px 5px; border-radius: 4px; flex-shrink: 0; line-height: 1;
}
.lb-remove-btn:hover { color: #d94040; background: #fde8e8; }

.lb-footer { padding: 10px 12px; border-top: 1px solid #e8e8e8; flex-shrink: 0; }
.lb-footer-btns { display: flex; gap: 6px; }
.lb-btn {
  font-size: 13px; padding: 7px 12px; border: 1px solid #ccc; border-radius: 6px;
  background: #fff; color: #111; cursor: pointer;
}
.lb-btn:hover { background: #f0f0f0; }
.lb-btn-primary {
  flex: 1; background: #1a5fa5; color: #fff; border-color: #1a5fa5; font-weight: 600;
}
.lb-btn-primary:hover { background: #0d4a8a; }
.lb-proceed-note { margin-top: 7px; text-align: center; }
.lb-proceed-link { font-size: 11px; color: #1a5fa5; }

@media (max-width: 600px) {
  .lb-modal-body { grid-template-columns: 1fr; grid-template-rows: 1fr auto; }
  .lb-panel-left { border-right: none; border-bottom: 1px solid #e8e8e8; max-height: 45vh; }
  .lb-panel-right { max-height: 45vh; }
}
    `;
    document.head.appendChild(style);
  }

  // ─── Init ──────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    window.kttListBuilder = { open };
  }

  document.addEventListener('DOMContentLoaded', init);

})();
