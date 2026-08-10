/* logViewer.js — the Logs dialog: Clinician, Responder, Interleaved.
 *
 * Kept separate from logs.js so the responder-only page can record and ship a
 * log without carrying the viewer, and so the store can be tested without a DOM.
 */
(function () {
  'use strict';

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'cls') n.className = v;
      else if (k.startsWith('on')) n[k] = v;
      else if (k === 'style') n.setAttribute('style', v);
      else n.setAttribute(k, v);
    }
    kids.forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }

  function injectStyles() {
    if (document.getElementById('ktt-logview-styles')) return;
    const s = document.createElement('style');
    s.id = 'ktt-logview-styles';
    s.textContent = `
      .lv-overlay { position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9900;
        display:flex;align-items:center;justify-content:center;padding:14px;box-sizing:border-box; }
      .lv-modal { background:#fff;border-radius:12px;width:100%;max-width:960px;height:88vh;
        display:flex;flex-direction:column;overflow:hidden;box-shadow:0 6px 40px rgba(0,0,0,.3);
        font-family:system-ui,-apple-system,sans-serif; }
      .lv-head { padding:12px 16px;border-bottom:1px solid #e0e0e0;display:flex;gap:10px;
        align-items:center;flex-wrap:wrap; }
      .lv-title { font-size:17px;font-weight:700;color:#1a3a5c;margin-right:4px; }
      .lv-tabs { display:flex;border:1px solid #ccc;border-radius:7px;overflow:hidden; }
      .lv-tab { padding:6px 13px;border:0;background:#fff;font-size:12.5px;cursor:pointer;
        color:#555;border-right:1px solid #ddd;font-family:inherit; }
      .lv-tab:last-child { border-right:0; }
      .lv-tab.on { background:#1a5fa5;color:#fff;font-weight:600; }
      .lv-skew { font-size:11px;padding:3px 9px;border-radius:10px;background:#eef4fb;
        color:#1a5fa5;border:1px solid #c4dbf5; }
      .lv-skew.bad { background:#fff1f1;color:#a02020;border-color:#e0b0b0; }
      .lv-filter { flex:1;min-width:110px;padding:6px 9px;border:1px solid #ccc;border-radius:6px;
        font-size:12.5px;font-family:inherit; }
      .lv-body { flex:1;min-height:0;overflow:auto;background:#0f1720;padding:10px 12px; }
      .lv-row { font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.55;
        color:#cfe3f5;white-space:pre-wrap;word-break:break-word;border-left:3px solid transparent;
        padding-left:7px; }
      .lv-row.clinician { border-left-color:#4a9edd; }
      .lv-row.responder { border-left-color:#e0a33a; }
      .lv-row.warn { color:#ffd58a; }
      .lv-row.err  { color:#ff9c94; }
      .lv-ts { color:#6f8ba3; }
      .lv-kind { color:#8fe0a8; }
      .lv-foot { padding:10px 16px;border-top:1px solid #e0e0e0;display:flex;gap:8px;
        align-items:center;flex-wrap:wrap; }
      .lv-btn { padding:7px 13px;border-radius:7px;border:1px solid #bbb;background:#fff;
        font-size:13px;cursor:pointer;font-family:inherit; }
      .lv-btn.primary { background:#1a5fa5;border-color:#1a5fa5;color:#fff;font-weight:600; }
      .lv-count { font-size:11px;color:#888; }
    `;
    document.head.appendChild(s);
  }

  function open() {
    injectStyles();
    const L = window.kttLogs;
    if (!L) { alert('Log store not loaded.'); return; }

    let view = 'interleaved';
    let filter = '';

    const overlay = el('div', { cls: 'lv-overlay' });
    const modal   = el('div', { cls: 'lv-modal' });
    const body    = el('div', { cls: 'lv-body' });
    const skewEl  = el('div', { cls: 'lv-skew' });
    const countEl = el('div', { cls: 'lv-count' });
    const tabsEl  = el('div', { cls: 'lv-tabs' });

    const rowsFor = () => {
      if (view === 'interleaved') return L.interleaved();
      const mine = L.localEntries(), theirs = L.peerEntries();
      const iAm = (L.asJSON().role === 'clinician') ? 'clinician' : 'responder';
      return view === iAm ? mine : theirs;
    };

    function render() {
      const s = L.getSkew();
      if (s.offsetMs === null) {
        skewEl.className = 'lv-skew bad';
        skewEl.textContent = 'Clocks not aligned — interleaving is approximate';
        skewEl.title = 'No clock-skew measurement yet. The two devices\u2019 timestamps ' +
                       'are on independent clocks, so merged ordering may be wrong.';
      } else {
        skewEl.className = 'lv-skew';
        skewEl.textContent = `Peer ${s.offsetMs >= 0 ? '+' : ''}${s.offsetMs} ms · ±${Math.ceil(s.rttMs / 2)} ms`;
        skewEl.title = `Responder clock is ${s.offsetMs} ms ahead of this device. ` +
                       `Best round trip ${s.rttMs} ms over ${s.samples} samples, so alignment ` +
                       `is trustworthy to roughly ±${Math.ceil(s.rttMs / 2)} ms.`;
      }

      const rows = rowsFor().filter(e => {
        if (!filter) return true;
        const hay = `${e.kind || ''} ${e.text || ''} ${e.data ? JSON.stringify(e.data) : ''}`.toLowerCase();
        return hay.includes(filter);
      });

      body.innerHTML = '';
      rows.forEach(e => {
        const div = el('div', { cls: `lv-row ${e.dev || ''} ${e.level === 'warn' ? 'warn' : e.level === 'err' ? 'err' : ''}` });
        div.appendChild(el('span', { cls: 'lv-ts' }, L.fmt(e.tLocal || e.t) + ' '));
        if (view === 'interleaved') {
          div.appendChild(el('span', { cls: 'lv-ts' },
            `[${(e.dev || '?').slice(0, 4).toUpperCase().padEnd(4)}] `));
        }
        if (e.kind && e.kind !== 'console') div.appendChild(el('span', { cls: 'lv-kind' }, e.kind + ': '));
        div.appendChild(document.createTextNode(
          (e.text || '') + (e.data ? ' ' + JSON.stringify(e.data) : '')));
        body.appendChild(div);
      });

      const rt = L.reactionTimes();
      countEl.textContent = `${rows.length} entries` +
        (rt.length ? ` · median reaction time ${median(rt.map(r => r.ms))} ms (n=${rt.length})` : '');
      body.scrollTop = body.scrollHeight;
    }

    [['clinician', 'Clinician device'], ['responder', 'Responder device'], ['interleaved', 'Interleaved']]
      .forEach(([v, lbl]) => {
        const b = el('button', { cls: 'lv-tab' + (view === v ? ' on' : '') }, lbl);
        b.onclick = () => {
          view = v;
          [...tabsEl.children].forEach(c => c.classList.remove('on'));
          b.classList.add('on');
          render();
        };
        tabsEl.appendChild(b);
      });

    const filterEl = el('input', { cls: 'lv-filter', placeholder: 'Filter…' });
    filterEl.oninput = e => { filter = e.target.value.toLowerCase().trim(); render(); };

    const copyBtn = el('button', { cls: 'lv-btn' }, '📋 Copy this view');
    copyBtn.onclick = () => copyText(L.asText(view));

    const jsonBtn = el('button', { cls: 'lv-btn' }, '↓ Export JSON');
    jsonBtn.onclick = () => {
      const blob = new Blob([JSON.stringify(L.asJSON(), null, 2)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob),
                          download: `ktt-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json` });
      document.body.appendChild(a); a.click(); a.remove();
    };

    const skewBtn = el('button', { cls: 'lv-btn' }, '⏱ Re-measure clocks');
    skewBtn.onclick = () => {
      if (!window.kttPaired?.isConnected()) { alert('Not paired — nothing to align to.'); return; }
      window.kttPaired.measureClockSkew(9);
      setTimeout(render, 3000);
    };

    const closeBtn = el('button', { cls: 'lv-btn primary' }, 'Close');
    closeBtn.onclick = () => overlay.remove();
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

    modal.append(
      el('div', { cls: 'lv-head' }, el('div', { cls: 'lv-title' }, 'Logs'), tabsEl, skewEl, filterEl),
      body,
      el('div', { cls: 'lv-foot' }, copyBtn, jsonBtn, skewBtn, countEl,
         el('div', { style: 'flex:1' }), closeBtn),
    );
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    render();
  }

  function median(xs) {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  }

  function copyText(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => alert('Copied to clipboard'));
      return;
    }
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); alert('Copied to clipboard'); } catch (_) {}
    ta.remove();
  }

  window.kttLogViewer = { open };
})();
