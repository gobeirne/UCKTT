/* itemAnalysis.js — pooled item analysis across many KTT results files
 *                   (window.kttItemAnalysis)
 *
 * Which kupu are consistently easier or harder than the others?
 *
 * Raw % correct per kupu is misleading on its own: children differ in ability,
 * and levels change during testing. So each trial is compared with what that
 * same child scored at that same level on everything else:
 *
 *     residual = (1 if correct else 0) − (child's proportion correct at this
 *                level, on all OTHER trials, across all their lists)
 *
 * A kupu's mean residual is how much better (+) or worse (−) children did on it
 * than on the rest of the test at the same level. Groups where a child was at
 * ceiling or floor (all right / all wrong at that level) carry no information
 * about relative difficulty and are left out of the residual (still counted in
 * raw % correct).
 *
 * Flags: ● = 95% CI excludes 0; ●● = still significant after Bonferroni across
 * all kupu (expect ~1 in 20 single-● flags by chance). This is a screening
 * view; the trial-level CSV is laid out for a proper mixed model, e.g. in R:
 *   glmer(correct ~ level + position + (1|participant) + (1|kupu), binomial)
 */
(function () {
  'use strict';

  let files = [];          // { key, name, data }

  // ─── Stats helpers ─────────────────────────────────────────────────────────
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  function sd(a) {
    if (a.length < 2) return NaN;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  }
  // Inverse standard normal (Acklam's approximation)
  function probit(p) {
    const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
    const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
    const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
    const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
    const pl = 0.02425;
    if (p < pl) { const q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    if (p > 1 - pl) return -probit(1 - p);
    const q = p - 0.5, r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }

  // ─── Data extraction ───────────────────────────────────────────────────────
  function extract() {
    const trials = [], confusions = [], resp = [];
    files.forEach((f, fi) => {
      const d = f.data, st = d.study || null;
      const pid = st?.participant_code || d.client?.clientName || `file${fi + 1}`;
      const order = st?.kupu_order || null, grid = st?.grid_order || null;
      Object.entries(d.scores || {}).forEach(([kupu, byLevel]) => {
        Object.entries(byLevel).forEach(([lv, rec]) => {
          (rec.pips || []).forEach(state => {
            if (state === 'empty') return;
            trials.push({
              pid, list_id: d.test?.list_id, list_name: d.test?.list_name,
              seq: st?.sequence_position ?? null, kupu,
              pos: order ? order.indexOf(kupu) + 1 || null : null,
              grid: grid ? grid.indexOf(kupu) + 1 || null : null,
              level: Number(lv), state, correct: state === 'correct' ? 1 : 0,
              file: f.name,
            });
          });
        });
      });
      (d.responses || []).forEach(r => {
        if (r.chosen && r.chosen !== r.target) confusions.push({ pid, target: r.target, chosen: r.chosen });
        resp.push({ pid, list_name: d.test?.list_name, seq: st?.sequence_position ?? null,
          target: r.target, chosen: r.chosen, state: r.state, level: r.level,
          rt_ms: r.rt_ms ?? null, rt_method: r.rt_method ?? null, file: f.name });
      });
    });

    // Leave-one-out residual within child × level
    const groups = {};
    trials.forEach(t => { (groups[t.pid + '|' + t.level] ||= []).push(t); });
    Object.values(groups).forEach(g => {
      const sum = g.reduce((s, t) => s + t.correct, 0);
      const informative = g.length >= 2 && sum > 0 && sum < g.length;
      g.forEach(t => { t.resid = informative ? t.correct - (sum - t.correct) / (g.length - 1) : null; });
    });
    // Response times: correct taps only. Each RT is also expressed relative to
    // the same child's median correct RT, so slow children don't make kupu look slow.
    const rts = resp.filter(r => r.state === 'correct' && Number.isFinite(r.rt_ms) && r.rt_ms > 0);
    const byKid = {};
    rts.forEach(r => (byKid[r.pid] ||= []).push(r.rt_ms));
    const kidMed = Object.fromEntries(Object.entries(byKid).map(([k, a]) => [k, median(a)]));
    rts.forEach(r => { r.rel = byKid[r.pid].length >= 5 ? r.rt_ms - kidMed[r.pid] : null; });
    return { trials, confusions, resp, rts };
  }

  function median(a) {
    if (!a.length) return NaN;
    const b = a.slice().sort((x, y) => x - y), m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }

  function summarise(trials, keyFn) {
    const by = {};
    trials.forEach(t => { const k = keyFn(t); if (k == null) return; (by[k] ||= []).push(t); });
    return Object.entries(by).map(([k, ts]) => {
      const res = ts.map(t => t.resid).filter(r => r != null);
      const m = res.length ? mean(res) : NaN, se = sd(res) / Math.sqrt(res.length);
      return { key: k, n: ts.length, kids: new Set(ts.map(t => t.pid)).size,
        pct: 100 * mean(ts.map(t => t.correct)), nInf: res.length, m, se, z: m / se };
    });
  }

  // ─── UI ────────────────────────────────────────────────────────────────────
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'style') n.style.cssText = v; else if (k.startsWith('on')) n[k] = v; else n.setAttribute(k, v);
    });
    kids.flat().forEach(c => n.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return n;
  }
  const f1 = x => Number.isFinite(x) ? x.toFixed(1) : '—';
  const f2 = x => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '—';

  function table(headers, rows) {
    const t = h('table', { style: 'border-collapse:collapse;font-size:12px;width:100%' });
    t.append(h('tr', {}, headers.map(x => h('th', { style: 'text-align:left;border-bottom:2px solid #ccc;padding:4px 6px;white-space:nowrap' }, x))));
    rows.forEach(r => t.append(h('tr', {}, r.map(x => h('td', { style: 'border-bottom:1px solid #eee;padding:3px 6px;white-space:nowrap' }, x)))));
    return h('div', { style: 'overflow-x:auto' }, t);
  }

  function residBar(m) {
    if (!Number.isFinite(m)) return '';
    const w = Math.min(50, Math.abs(m) * 100);
    const wrap = h('div', { style: 'position:relative;width:110px;height:10px;background:#f2f2f2;border-radius:3px' });
    wrap.append(h('div', { style: 'position:absolute;left:55px;top:0;bottom:0;width:1px;background:#999' }));
    wrap.append(h('div', { style: `position:absolute;top:1px;bottom:1px;${m < 0 ? `right:55px` : `left:55px`};width:${w}px;background:${m < 0 ? '#c0392b' : '#2d7010'};border-radius:2px` }));
    return wrap;
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }
  function csv(rows) {
    return rows.map(r => r.map(v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n') + '\n';
  }

  function render(body) {
    body.innerHTML = '';
    const { trials, confusions, resp, rts } = extract();
    const rtBy = {};
    rts.forEach(r => (rtBy[r.target] ||= []).push(r));
    const medRT = k => { const a = (rtBy[k] || []).map(r => r.rt_ms); return a.length >= 3 ? median(a) / 1000 : NaN; };
    const relRT = k => { const a = (rtBy[k] || []).map(r => r.rel).filter(x => x != null); return a.length >= 3 ? median(a) / 1000 : NaN; };
    const fs = x => Number.isFinite(x) ? x.toFixed(2) : '—';
    const fsr = x => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '—';
    const kids = new Set(trials.map(t => t.pid)).size;
    body.append(h('div', { style: 'font-size:13px;color:#444;margin-bottom:10px' },
      `${files.length} results file${files.length === 1 ? '' : 's'} · ${kids} participant${kids === 1 ? '' : 's'} · ${trials.length} scored trials`));
    if (!trials.length) {
      body.append(h('div', { style: 'color:#888' }, 'Add results JSON files to begin. Select many at once.'));
      return;
    }

    // Kupu table
    const items = summarise(trials, t => t.kupu);
    const tested = items.filter(r => r.nInf >= 5);
    const zB = tested.length ? probit(1 - 0.025 / tested.length) : Infinity;
    items.sort((a, b) => (Number.isFinite(a.m) ? a.m : 9) - (Number.isFinite(b.m) ? b.m : 9));
    const flag = r => r.nInf < 5 ? 'few data' : Math.abs(r.z) > zB ? '●●' : Math.abs(r.z) > 1.96 ? '●' : '';
    const verdict = r => r.nInf < 5 || Math.abs(r.z) <= 1.96 ? '' : r.m < 0 ? 'harder' : 'easier';
    body.append(h('h3', { style: 'margin:12px 0 4px' }, 'Kupu difficulty (hardest first)'));
    body.append(h('div', { style: 'font-size:11px;color:#667;margin-bottom:6px' },
      'Relative = correct minus the same child\u2019s score on other kupu at the same level (−0.10 ≈ 10 points harder). ' +
      `● 95% CI excludes 0; ●● also survives Bonferroni across ${tested.length} kupu.`));
    body.append(table(['Kupu', 'Trials', 'Children', '% correct', 'Relative', '', '95% CI', 'Flag', '', 'Median RT (s)', 'RT vs child (s)'],
      items.map(r => [h('b', {}, r.key), r.n, r.kids, f1(r.pct), f2(r.m), residBar(r.m),
        Number.isFinite(r.se) ? `${f2(r.m - 1.96 * r.se)} to ${f2(r.m + 1.96 * r.se)}` : '—',
        flag(r), verdict(r), fs(medRT(r.key)), fsr(relRT(r.key))])));
    body.append(h('div', { style: 'font-size:11px;color:#667;margin-top:4px' },
      rts.length
        ? `Response times: ${rts.length} correct paired-device taps, measured from the start of the kupu (after the carrier phrase). ` +
          'RT vs child = median difference from that child\u2019s own median correct RT (+ = slower).'
        : 'No response times yet (paired-device taps saved with this version or later).'));

    // Lists
    const lists = summarise(trials, t => t.list_name).sort((a, b) => a.m - b.m);
    body.append(h('h3', { style: 'margin:16px 0 4px' }, 'Lists'));
    body.append(table(['List', 'Trials', 'Children', '% correct', 'Relative'],
      lists.map(r => [r.key, r.n, r.kids, f1(r.pct), f2(r.m)])));

    // Order effects
    const bySeq = summarise(trials, t => t.seq).sort((a, b) => a.key - b.key);
    if (bySeq.length) {
      body.append(h('h3', { style: 'margin:16px 0 4px' }, 'List order (1st, 2nd … list tested)'));
      body.append(table(['Position', 'Trials', '% correct', 'Relative'], bySeq.map(r => [r.key, r.n, f1(r.pct), f2(r.m)])));
    }
    const byPos = summarise(trials, t => t.pos).sort((a, b) => a.key - b.key);
    if (byPos.length) {
      body.append(h('h3', { style: 'margin:16px 0 4px' }, 'Presentation position within list'));
      body.append(table(['Position', ...byPos.map(r => r.key)],
        [['Relative', ...byPos.map(r => f2(r.m))], ['% correct', ...byPos.map(r => f1(r.pct))]]));
    }
    const byGrid = summarise(trials, t => t.grid).sort((a, b) => a.key - b.key);
    if (byGrid.length) {
      body.append(h('h3', { style: 'margin:16px 0 4px' }, 'Picture position on the child\u2019s grid'));
      body.append(table(['Cell', ...byGrid.map(r => r.key)], [['Relative', ...byGrid.map(r => f2(r.m))]]));
    }

    // Confusions
    body.append(h('h3', { style: 'margin:16px 0 4px' }, 'Confusions (paired device: picture chosen in error)'));
    if (!confusions.length) {
      body.append(h('div', { style: 'font-size:12px;color:#888' },
        'None recorded. Chosen pictures are only known for paired-device taps (results saved with this version or later).'));
    } else {
      const cc = {};
      confusions.forEach(c => { const k = c.target + '→' + c.chosen; cc[k] = (cc[k] || 0) + 1; });
      const top = Object.entries(cc).sort((a, b) => b[1] - a[1]).slice(0, 40);
      body.append(table(['Target → chosen', 'Times'], top.map(([k, n]) => [k, n])));
    }

    // Exports
    const ex = h('div', { style: 'display:flex;gap:8px;margin-top:16px;flex-wrap:wrap' });
    ex.append(h('button', { class: 'mt-btn', onclick: () => download('ktt_trials.csv', csv([
      ['participant', 'list_id', 'list_name', 'list_sequence_position', 'kupu', 'position_in_list', 'grid_cell', 'level', 'state', 'correct', 'relative', 'file'],
      ...trials.map(t => [t.pid, t.list_id, t.list_name, t.seq, t.kupu, t.pos, t.grid, t.level, t.state, t.correct,
        t.resid == null ? '' : t.resid.toFixed(4), t.file])]), 'text/csv') }, '↓ Trial-level CSV'));
    ex.append(h('button', { class: 'mt-btn', onclick: () => download('ktt_kupu_summary.csv', csv([
      ['kupu', 'trials', 'children', 'pct_correct', 'relative', 'se', 'z', 'flag'],
      ...items.map(r => [r.key, r.n, r.kids, f1(r.pct), Number.isFinite(r.m) ? r.m.toFixed(4) : '',
        Number.isFinite(r.se) ? r.se.toFixed(4) : '', Number.isFinite(r.z) ? r.z.toFixed(2) : '', flag(r)])]), 'text/csv') }, '↓ Kupu summary CSV'));
    ex.append(h('button', { class: 'mt-btn', onclick: () => download('ktt_confusions.csv', csv([
      ['participant', 'target', 'chosen'], ...confusions.map(c => [c.pid, c.target, c.chosen])]), 'text/csv') }, '↓ Confusions CSV'));
    ex.append(h('button', { class: 'mt-btn', onclick: () => download('ktt_responses_rt.csv', csv([
      ['participant', 'list_name', 'list_sequence_position', 'target', 'chosen', 'state', 'level', 'rt_ms', 'rt_method', 'file'],
      ...resp.map(r => [r.pid, r.list_name, r.seq, r.target, r.chosen, r.state, r.level, r.rt_ms, r.rt_method, r.file])]), 'text/csv') }, '↓ Responses + RT CSV'));
    body.append(ex);
  }

  function addFiles(body) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json'; inp.multiple = true;
    inp.onchange = async () => {
      let bad = 0;
      for (const file of inp.files) {
        try {
          const data = JSON.parse(await file.text());
          if (!data.test || !data.scores) { bad++; continue; }
          const key = [data.study?.participant_code || data.client?.clientName || file.name,
                       data.test.list_id, data.exported_at].join('|');
          if (!files.some(f => f.key === key)) files.push({ key, name: file.name, data });
        } catch { bad++; }
      }
      if (bad) alert(`${bad} file(s) skipped: not KTT results.`);
      render(body);
    };
    inp.click();
  }

  function open() {
    document.getElementById('ktt-item-analysis')?.remove();
    const ov = h('div', { id: 'ktt-item-analysis',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9200;display:flex;align-items:stretch;justify-content:center;padding:16px;font-family:system-ui,sans-serif' });
    const panel = h('div', { style: 'background:#fff;border-radius:12px;max-width:980px;width:100%;display:flex;flex-direction:column;overflow:hidden' });
    const body = h('div', { style: 'padding:14px 18px;overflow:auto;flex:1' });
    const head = h('div', { style: 'display:flex;gap:8px;align-items:center;padding:12px 18px;border-bottom:1px solid #e5e5e5' },
      h('div', { style: 'font-weight:700;font-size:16px;flex:1' }, '📊 Item analysis'),
      h('button', { class: 'mt-btn-sm-primary', onclick: () => addFiles(body) }, '+ Add results files…'),
      h('button', { class: 'mt-btn', onclick: () => { files = []; render(body); } }, 'Clear'),
      h('button', { class: 'mt-btn', onclick: () => ov.remove() }, 'Close'));
    panel.append(head, body); ov.append(panel); document.body.append(ov);
    render(body);
  }

  window.kttItemAnalysis = { open, _extract: extract, _summarise: summarise, _setFiles: f => { files = f; } };
})();
