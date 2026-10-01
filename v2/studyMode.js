/* studyMode.js — participant controller for research use (window.kttStudy)
 *
 * The clinician picks the lists "in the mix", the participant number and date
 * of birth, then how many lists THIS child will do ("Present 2 lists", 3 …).
 * Everything else is assigned here.
 *
 * Why not a fixed Latin square?
 *   A Latin square only balances when every child does every list and whole
 *   blocks of children are completed. Once children do different numbers of
 *   lists (two for a two-year-old, four for a five-year-old), any fixed square
 *   drifts out of balance. So list sequences are assigned by MINIMISATION: each
 *   new child gets the ordered set of lists that keeps the running totals most
 *   even, given everyone assigned so far. In priority order it balances:
 *     1. how often each list is used,
 *     2. how often each list is in each serial position (1st, 2nd …),
 *     3. how often each pair of lists is done by the same child (so all lists
 *        can be compared within children),
 *     4. which list follows which (carryover).
 *   Ties are broken by a seeded random draw. When every child does all four
 *   lists this reproduces a balanced Latin square.
 *
 * Kupu order within a list: a Williams (balanced Latin) square on the 15 kupu
 * (30 sequences), stepped per LIST rather than per child: the m-th child to get
 * list L uses row m. So each list's kupu order stays balanced however many
 * children end up doing that list. Each list's kupu get a fixed seeded shuffle
 * first, so the square doesn't inherit the list's built-in grouping.
 *
 * Picture positions (child's grid / printed sheet): seeded random per child ×
 * list, independent of presentation order.
 *
 * Assignments are stored on this device and written into every results file.
 */
(function () {
  'use strict';

  const LS_KEY = 'ktt_study_v2';
  const DEFAULTS = { enabled: false, name: 'Study', listIds: [], participant: 1,
                     kupuDesign: 'williams', assignments: {}, done: {}, current: null };

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
      // Carry settings over from the first version (no assignments existed then).
      const v1 = JSON.parse(localStorage.getItem('ktt_study_v1') || 'null');
      if (v1) return Object.assign({}, DEFAULTS, { enabled: v1.enabled, name: v1.name,
        listIds: v1.listIds || [], participant: v1.participant || 1, kupuDesign: v1.kupuDesign || 'williams' });
    } catch (_) {}
    return Object.assign({}, DEFAULTS);
  }
  function save(patch) {
    // Anything that changes who-got-what counts as a change needing export.
    if (patch.assignments || patch.done) patch = Object.assign({}, patch, {
      changedAt: Date.now(), changesSinceExport: (load().changesSinceExport || 0) + 1 });
    const s = Object.assign(load(), patch);
    localStorage.setItem(LS_KEY, JSON.stringify(s));
    return s;
  }

  // ─── Seeded randomness ─────────────────────────────────────────────────────
  function hashStr(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    return h1 >>> 0;
  }
  function rng(seedStr) {
    let a = hashStr(seedStr);
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seededShuffle(arr, seedStr) {
    const r = rng(seedStr), out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // ─── Williams square (kupu order) ──────────────────────────────────────────
  function williams(n) {
    if (n <= 1) return [[0]];
    const first = [0];
    for (let k = 1; first.length < n; k++) {
      first.push(k);
      if (first.length < n) first.push(n - k);
    }
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(first.map(v => (v + i) % n));
    if (n % 2 === 1) rows.slice().forEach(r => rows.push(r.slice().reverse()));
    return rows;
  }

  // ─── Lists ─────────────────────────────────────────────────────────────────
  function allLists() { return window.kttManual?.getAllLists?.() || []; }
  function listById(id) { return allLists().find(l => l.id === id) || null; }
  function mix(s) { return s.listIds.filter(id => listById(id)); }

  // ─── Balance tallies over everyone assigned so far ─────────────────────────
  function tallies(s, excludeP) {
    const T = { use: {}, pos: {}, pair: {}, carry: {}, exposures: {} };
    Object.entries(s.assignments).forEach(([p, a]) => {
      if (String(p) === String(excludeP)) return;
      a.seq.forEach((id, j) => {
        T.use[id] = (T.use[id] || 0) + 1;
        T.pos[id + '@' + j] = (T.pos[id + '@' + j] || 0) + 1;
        T.exposures[id] = (T.exposures[id] || 0) + 1;
        if (j > 0) { const c = a.seq[j - 1] + '>' + id; T.carry[c] = (T.carry[c] || 0) + 1; }
        for (let i = 0; i < j; i++) {
          const k = [a.seq[i], id].sort().join('|');
          T.pair[k] = (T.pair[k] || 0) + 1;
        }
      });
    });
    return T;
  }

  // Cost of giving the next child sequence `seq`. Squared counts make the
  // choice favour the least-used options; weights set the priority order.
  function cost(seq, T) {
    let c = 0;
    seq.forEach((id, j) => {
      c += 1e6 * (2 * (T.use[id] || 0) + 1);
      c += 1e4 * (2 * (T.pos[id + '@' + j] || 0) + 1);
      if (j > 0) c += 1 * (2 * (T.carry[seq[j - 1] + '>' + id] || 0) + 1);
      for (let i = 0; i < j; i++) c += 1e2 * (2 * (T.pair[[seq[i], id].sort().join('|')] || 0) + 1);
    });
    return c;
  }

  // Best ordered sequence of k lists, optionally extending a fixed prefix.
  function chooseSequence(s, p, k, prefix) {
    const ids = mix(s);
    prefix = (prefix || []).filter(id => ids.includes(id));
    k = Math.min(k, ids.length);
    const T = tallies(s, p);
    const r = rng(`tie|${s.name}|${p}|${prefix.join(',')}|${k}`);
    let best = null, bestCost = Infinity, nTies = 0;
    let budget = 200000;                     // exhaustive for realistic sizes
    (function extend(seq) {
      if (budget-- <= 0) return;
      if (seq.length === k) {
        const c = cost(seq, T);
        if (c < bestCost) { best = seq.slice(); bestCost = c; nTies = 1; }
        else if (c === bestCost && r() < 1 / ++nTies) best = seq.slice();
        return;
      }
      ids.forEach(id => { if (!seq.includes(id)) { seq.push(id); extend(seq); seq.pop(); } });
    })(prefix.slice());
    return best || prefix;
  }

  function assign(p, k, dob) {
    const s = load();
    const seq = chooseSequence(s, p, k);
    const T = tallies(s, p);
    const rows = {};
    seq.forEach(id => { rows[id] = T.exposures[id] || 0; });
    const assignments = Object.assign({}, s.assignments);
    assignments[String(p)] = { k: seq.length, seq, kupuRows: rows, dob: dob || '', assignedAt: Date.now() };
    save({ assignments });
  }
  function addOne(p) {
    const s = load(), a = s.assignments[String(p)];
    if (!a) return;
    const seq = chooseSequence(s, p, a.seq.length + 1, a.seq);
    const added = seq[seq.length - 1];
    if (!added || a.seq.includes(added)) return;
    const T = tallies(s, p);
    const assignments = Object.assign({}, s.assignments);
    assignments[String(p)] = Object.assign({}, a, { seq, k: seq.length,
      kupuRows: Object.assign({}, a.kupuRows, { [added]: T.exposures[added] || 0 }) });
    save({ assignments });
  }
  // Child stopped early: drop untested lists so the tallies reflect what was used.
  function stopHere(p) {
    const s = load(), a = s.assignments[String(p)];
    if (!a) return;
    const done = s.done[String(p)] || [];
    const seq = a.seq.filter(id => done.includes(id));
    const assignments = Object.assign({}, s.assignments);
    if (seq.length) assignments[String(p)] = Object.assign({}, a, { seq, k: seq.length, stoppedEarly: true });
    else delete assignments[String(p)];
    save({ assignments });
  }
  function resetAssignment(p) {
    const s = load();
    const assignments = Object.assign({}, s.assignments);
    delete assignments[String(p)];
    save({ assignments });
  }

  // ─── Orders for a given child and list ─────────────────────────────────────
  function kupuOrder(p, list, s) {
    s = s || load();
    if (s.kupuDesign === 'random') return seededShuffle(list.kupu, `order|${s.name}|${p}|${list.id}`);
    const base = seededShuffle(list.kupu, `base|${s.name}|${list.id}`);
    const rows = williams(base.length);
    const a = s.assignments[String(p)];
    const m = a?.kupuRows?.[list.id] ?? (p - 1);
    return rows[m % rows.length].map(i => base[i]);
  }
  function gridOrder(p, list, s) {
    s = s || load();
    return seededShuffle(list.kupu, `grid|${s.name}|${p}|${list.id}`);
  }
  function code(p) { return 'P' + String(p).padStart(3, '0'); }

  function ageMonths(dob, at) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec((dob || '').trim());
    if (!m) return null;
    const d = new Date(+m[3], +m[2] - 1, +m[1]);
    if (isNaN(d)) return null;
    at = at || new Date();
    let months = (at.getFullYear() - d.getFullYear()) * 12 + (at.getMonth() - d.getMonth());
    if (at.getDate() < d.getDate()) months--;
    return months >= 0 ? months : null;
  }
  function ageText(dob) {
    const mo = ageMonths(dob);
    return mo == null ? '' : `${Math.floor(mo / 12)};${String(mo % 12).padStart(2, '0')}`;
  }

  // ─── Hooks used by manualTest.js ───────────────────────────────────────────
  function activeFor(list) {
    const s = load();
    return (s.enabled && s.current && list && s.current.listId === list.id) ? s : null;
  }
  function clinicianOrder(list) {
    const s = activeFor(list);
    return s ? kupuOrder(s.current.participant, list, s) : null;
  }
  function childGridOrder(list) {
    const s = activeFor(list);
    return s ? gridOrder(s.current.participant, list, s) : null;
  }
  function badge(list) {
    const s = activeFor(list);
    if (!s) return null;
    return `${s.name} · ${code(s.current.participant)} · list ${s.current.step} of ${s.current.of}`;
  }
  function resultBlock(list) {
    const s = activeFor(list);
    if (!s) return null;
    const p = s.current.participant, a = s.assignments[String(p)] || {};
    return {
      study_name: s.name,
      participant: p,
      participant_code: code(p),
      dob: a.dob || null,
      age_months: ageMonths(a.dob),
      lists_assigned: (a.seq || []).length,
      sequence_position: s.current.step,
      list_sequence: (a.seq || []).map(id => ({ id, name: listById(id)?.name || id })),
      lists_in_mix: mix(s).map(id => ({ id, name: listById(id)?.name || id })),
      kupu_order: kupuOrder(p, list, s),
      kupu_order_row: s.kupuDesign === 'random' ? null : (a.kupuRows?.[list.id] ?? null),
      grid_order: gridOrder(p, list, s),
      design: {
        list_order: 'minimisation (usage > position > pairing > carryover)',
        kupu_order: s.kupuDesign === 'random' ? 'seeded-random'
                    : `williams-${williams(list.kupu.length).length}, stepped per list`,
        grid_order: 'seeded-random',
      },
    };
  }
  function clearCurrent() { if (load().current) save({ current: null }); }
  function onSaved(list) {
    const s = activeFor(list);
    if (!s) return;
    const p = String(s.current.participant);
    const done = Object.assign({}, s.done);
    done[p] = Array.from(new Set([...(done[p] || []), list.id]));
    save({ done, current: null });
  }
  function startList(p, listId, step, of) {
    const s = save({ current: { participant: p, listId, step, of } });
    window.kttManual?.startStudyList?.(listId, { code: code(p), dob: s.assignments[String(p)]?.dob || '' });
  }

  // ─── Setup-screen card ─────────────────────────────────────────────────────
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'cls') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n[k] = v;
      else n.setAttribute(k, v);
    });
    kids.flat().forEach(c => n.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return n;
  }
  const label = (t, top) => h('div', { cls: 'mt-field-label', style: `margin-top:${top || 8}px` }, t);

  function renderCard(rerender) {
    const s = load();
    const card = h('div', { cls: 'mt-card' });

    const onToggle = h('input', { type: 'checkbox' });
    onToggle.checked = s.enabled;
    onToggle.onchange = () => { save({ enabled: onToggle.checked, current: null }); rerender(); };
    card.append(h('label', { style: 'display:flex;gap:8px;align-items:center;font-weight:600;cursor:pointer' },
      onToggle, 'Study mode (participant counterbalancing)'));
    if (!s.enabled) {
      card.append(h('div', { cls: 'mt-hint-text', style: 'margin-top:6px' },
        'Assigns each participant a balanced set and order of lists, and records it with the results.'));
      return card;
    }
    const anyAssigned = Object.keys(s.assignments).length > 0;

    // Study name
    const nameIn = h('input', { cls: 'mt-inp', value: s.name, placeholder: 'e.g. May 2026' });
    nameIn.onchange = () => {
      if (anyAssigned && !confirm('Changing the study name changes every kupu and picture order. Continue?')) {
        nameIn.value = s.name; return;
      }
      save({ name: nameIn.value.trim() || 'Study' }); rerender();
    };
    card.append(label('Study name (seeds all orders)'), nameIn);

    // Lists in the mix
    card.append(label('Lists in the mix'));
    const box = h('div', { style: 'max-height:130px;overflow:auto;border:1px solid #e3e3e3;border-radius:6px;padding:4px 6px' });
    allLists().forEach(l => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = s.listIds.includes(l.id);
      cb.onchange = () => {
        if (anyAssigned && !confirm('Changing the lists in the mix part-way through affects balance from here on. Continue?')) {
          cb.checked = !cb.checked; return;
        }
        save({ listIds: cb.checked ? [...s.listIds, l.id] : s.listIds.filter(id => id !== l.id) });
        rerender();
      };
      box.append(h('label', { style: 'display:flex;gap:6px;align-items:center;font-size:12px;cursor:pointer' }, cb, l.name));
    });
    card.append(box);

    const sel = h('select', { cls: 'mt-inp' },
      h('option', { value: 'williams' }, 'Balanced Latin square (recommended)'),
      h('option', { value: 'random' }, 'Random (seeded per participant)'));
    sel.value = s.kupuDesign;
    sel.onchange = () => { save({ kupuDesign: sel.value }); rerender(); };
    card.append(label('Kupu order within each list'), sel);

    const ids = mix(s);
    if (!ids.length) {
      card.append(h('div', { cls: 'mt-hint-text', style: 'margin-top:8px;color:#a02020' }, 'Tick the lists in the mix, or import a study.'));
      card.append(backupRow(s, rerender));
      return card;
    }

    // Participant
    const p = Math.max(1, s.participant | 0);
    const setP = v => { save({ participant: Math.max(1, v | 0), current: null }); rerender(); };
    const pIn = h('input', { cls: 'mt-inp', type: 'number', min: '1', value: String(p), style: 'width:70px;text-align:center' });
    pIn.onchange = () => setP(parseInt(pIn.value, 10) || 1);
    const nextFree = (() => { let q = 1; while (s.assignments[String(q)]) q++; return q; })();
    card.append(h('div', { style: 'display:flex;gap:6px;align-items:center;margin-top:12px;flex-wrap:wrap' },
      h('span', { style: 'font-weight:700' }, 'Participant'),
      h('button', { cls: 'mt-btn', onclick: () => setP(p - 1) }, '◀'), pIn,
      h('button', { cls: 'mt-btn', onclick: () => setP(p + 1) }, '▶'),
      h('span', { style: 'font-size:12px;color:#667' }, code(p)),
      p !== nextFree ? h('button', { cls: 'mt-btn', style: 'font-size:11px', onclick: () => setP(nextFree) },
        `Next new → ${code(nextFree)}`) : ''));

    const a = s.assignments[String(p)];
    const doneHere = s.done[String(p)] || [];

    // DOB (editable either way)
    const dobIn = h('input', { cls: 'mt-inp', placeholder: 'DD/MM/YYYY', value: a?.dob || s.pendingDob || '', style: 'width:120px' });
    const ageEl = h('span', { style: 'font-size:12px;color:#667' }, ageText(dobIn.value) ? `age ${ageText(dobIn.value)}` : '');
    dobIn.oninput = () => { ageEl.textContent = ageText(dobIn.value) ? `age ${ageText(dobIn.value)}` : ''; };
    dobIn.onchange = () => {
      if (a) {
        const assignments = Object.assign({}, s.assignments);
        assignments[String(p)] = Object.assign({}, a, { dob: dobIn.value.trim() });
        save({ assignments });
      } else save({ pendingDob: dobIn.value.trim() });
    };
    card.append(label('Date of birth'), h('div', { style: 'display:flex;gap:8px;align-items:center' }, dobIn, ageEl));

    if (!a) {
      // Choose how many lists this child will do
      card.append(label('Present', 10));
      const row = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
      const words = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT'];
      for (let k = 1; k <= ids.length; k++) {
        row.append(h('button', { cls: k === ids.length ? 'mt-btn-sm-primary' : 'mt-btn', style: 'font-size:12px;padding:5px 10px',
          onclick: () => {
            if (!dobIn.value.trim() && !confirm('No date of birth entered. Assign lists anyway?')) return;
            assign(p, k, dobIn.value.trim());
            save({ pendingDob: '' });
            rerender();
          } }, `${words[k - 1] || k} list${k === 1 ? '' : 's'}`));
      }
      card.append(row);
    } else {
      // Assigned sequence
      card.append(label(`Lists for ${code(p)}` + (a.stoppedEarly ? ' (stopped early)' : ''), 10));
      const nextIdx = a.seq.findIndex(id => !doneHere.includes(id));
      const seqBox = h('div', { style: 'display:flex;flex-direction:column;gap:4px' });
      a.seq.forEach((id, i) => {
        const isDone = doneHere.includes(id), isNext = i === nextIdx;
        const row = h('div', { style: 'display:flex;gap:6px;align-items:center;font-size:13px;padding:4px 6px;border-radius:6px;' +
          (isNext ? 'background:#e8f0fb;border:1px solid #9ab8f0' : 'border:1px solid transparent') },
          h('span', { style: 'width:18px;text-align:center' }, isDone ? '✓' : String(i + 1)),
          h('span', { style: 'flex:1' + (isDone ? ';color:#888' : '') }, listById(id)?.name || id));
        row.append(h('button', { cls: isNext ? 'mt-btn-sm-primary' : 'mt-btn', style: 'font-size:11px;padding:2px 8px',
          onclick: () => {
            if (isDone && !confirm(`${code(p)} has already done this list. Test it again?`)) return;
            startList(p, id, i + 1, a.seq.length);
          } }, isDone ? 'Redo' : '▶ Start'));
        seqBox.append(row);
      });
      card.append(seqBox);

      const tools = h('div', { style: 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center' });
      if (nextIdx === -1) tools.append(h('span', { style: 'font-size:12px;color:#2d7010;flex:1' }, `${code(p)} complete.`));
      if (a.seq.length < ids.length)
        tools.append(h('button', { cls: 'mt-btn', style: 'font-size:11px', title: 'Child is keen: assign one more balanced list',
          onclick: () => { addOne(p); rerender(); } }, '+ One more list'));
      if (nextIdx !== -1 && doneHere.some(id => a.seq.includes(id)))
        tools.append(h('button', { cls: 'mt-btn', style: 'font-size:11px', title: 'Child has had enough: drop the remaining lists',
          onclick: () => { if (confirm('Stop here and release the untested lists?')) { stopHere(p); rerender(); } } }, 'Stop here'));
      if (!doneHere.length)
        tools.append(h('button', { cls: 'mt-btn', style: 'font-size:11px;color:#c0392b;border-color:#e0b0b0',
          onclick: () => { if (confirm(`Clear ${code(p)}'s assignment?`)) { resetAssignment(p); rerender(); } } }, 'Change number of lists'));
      if (nextIdx === -1)
        tools.append(h('button', { cls: 'mt-btn-sm-primary', onclick: () => setP(nextFree) }, `Next participant → ${code(nextFree)}`));
      card.append(tools);
    }

    card.append(balanceTable(s, ids));
    card.append(backupRow(load(), rerender));
    return card;
  }

  // ─── Export / import ───────────────────────────────────────────────────────
  /* Assignment is adaptive, so the study's history IS the design: lose it and
     the next child can't be balanced against the previous ones. Export it at the
     end of each session. It can be restored three ways:
       • Replace — this device takes the exported state (new or reset device).
       • Merge   — combine two devices' records (union; conflicts reported).
       • Rebuild from results files — every saved result carries its child's
         assignment, so the history can be reconstructed if a device is lost. */
  function exportState() {
    const s = load();
    const data = {
      type: 'ktt-study', version: 2, exported_at: new Date().toISOString(),
      state: { name: s.name, listIds: s.listIds, kupuDesign: s.kupuDesign,
               participant: s.participant, assignments: s.assignments, done: s.done },
      lists: mix(s).map(id => listById(id)).filter(Boolean)
               .map(l => ({ id: l.id, name: l.name, kupu: l.kupu, builtin: !!l.builtin })),
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `KTT_study_${s.name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    save({ exportedAt: Date.now(), changesSinceExport: 0 });
  }

  function fillKupuRows(st) {
    // Any list without a recorded kupu row gets the next row for that list.
    const count = {};
    Object.keys(st.assignments).map(Number).sort((a, b) => a - b).forEach(p => {
      const a = st.assignments[String(p)];
      a.kupuRows = Object.assign({}, a.kupuRows);
      a.seq.forEach(id => {
        if (a.kupuRows[id] == null) a.kupuRows[id] = count[id] || 0;
        count[id] = Math.max(count[id] || 0, a.kupuRows[id] + 1);
      });
    });
    return st;
  }

  function mergeInto(cur, inc) {
    const out = { assignments: Object.assign({}, cur.assignments), done: Object.assign({}, cur.done) };
    const conflicts = [];
    Object.entries(inc.assignments || {}).forEach(([p, a]) => {
      const mine = out.assignments[p];
      const doneMine = cur.done[p] || [], doneTheirs = (inc.done || {})[p] || [];
      if (!mine) out.assignments[p] = a;
      else if (mine.seq.join() !== a.seq.join()) {
        conflicts.push(`P${String(p).padStart(3, '0')}`);
        if (doneTheirs.length > doneMine.length) out.assignments[p] = a;   // keep the one with more testing done
      } else if (!mine.dob && a.dob) out.assignments[p] = Object.assign({}, mine, { dob: a.dob });
    });
    Object.entries(inc.done || {}).forEach(([p, ids]) => {
      out.done[p] = Array.from(new Set([...(out.done[p] || []), ...ids]));
    });
    out.listIds = Array.from(new Set([...(cur.listIds || []), ...(inc.listIds || [])]));
    out.participant = Math.max(cur.participant || 1, inc.participant || 1);
    return { out, conflicts };
  }

  // Rebuild a study state from saved results files.
  function fromResults(files) {
    const st = { name: null, listIds: [], assignments: {}, done: {}, participant: 1 };
    files.forEach(d => {
      const b = d.study, p = String(b.participant);
      st.name = st.name || b.study_name;
      (b.lists_in_mix || b.list_sequence || []).forEach(l => { if (!st.listIds.includes(l.id)) st.listIds.push(l.id); });
      const seq = (b.list_sequence || []).map(l => l.id);
      const a = st.assignments[p] || { k: seq.length, seq, kupuRows: {}, dob: b.dob || '', assignedAt: Date.parse(d.exported_at) || Date.now() };
      if (b.kupu_order_row != null) a.kupuRows[d.test.list_id] = b.kupu_order_row;
      st.assignments[p] = a;
      st.done[p] = Array.from(new Set([...(st.done[p] || []), d.test.list_id]));
      st.participant = Math.max(st.participant, b.participant);
    });
    return st;
  }

  function choose(title, text, buttons) {
    return new Promise(resolve => {
      const ov = h('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9300;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif' });
      const box = h('div', { style: 'background:#fff;border-radius:12px;padding:20px;max-width:380px;width:100%' },
        h('div', { style: 'font-weight:700;font-size:15px;margin-bottom:8px' }, title),
        h('div', { style: 'font-size:13px;color:#444;margin-bottom:14px;white-space:pre-line' }, text));
      const row = h('div', { style: 'display:flex;flex-direction:column;gap:6px' });
      buttons.forEach(([label, val, primary]) => row.append(h('button', { cls: primary ? 'mt-btn-primary' : 'mt-btn',
        onclick: () => { ov.remove(); resolve(val); } }, label)));
      box.append(row); ov.append(box); document.body.append(ov);
    });
  }

  function importState(rerender) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json'; inp.multiple = true;
    inp.onchange = async () => {
      const exports = [], results = [];
      for (const f of inp.files) {
        try {
          const d = JSON.parse(await f.text());
          if (d.type === 'ktt-study') exports.push(d);
          else if (d.study && d.test) results.push(d);
        } catch (_) {}
      }
      if (!exports.length && !results.length) { alert('No study exports or study results files found.'); return; }
      const cur = load();
      let inc, lists = [];
      if (exports.length) { inc = exports[exports.length - 1].state; lists = exports[exports.length - 1].lists || []; }
      else inc = fromResults(results);

      // Lists the study needs but this device doesn't have yet.
      const missing = lists.filter(l => !l.builtin && !listById(l.id));
      if (missing.length) window.kttManual?.addCustomLists?.(missing);

      const nInc = Object.keys(inc.assignments || {}).length, nCur = Object.keys(cur.assignments).length;
      const sameName = !nCur || !inc.name || inc.name === cur.name;
      const choice = await choose(
        exports.length ? 'Import study' : `Rebuild from ${results.length} results file${results.length === 1 ? '' : 's'}`,
        `Imported: “${inc.name || cur.name}”, ${nInc} participant${nInc === 1 ? '' : 's'}.\n` +
        `This device: “${cur.name}”, ${nCur} participant${nCur === 1 ? '' : 's'}.` +
        (sameName ? '' : '\n\nThe study names differ — merging is not possible (orders are seeded by name).') +
        (missing.length ? `\n\n${missing.length} list${missing.length === 1 ? '' : 's'} added to custom lists.` : ''),
        [ ...(sameName && nCur ? [['Merge with this device', 'merge', true]] : []),
          [nCur ? 'Replace this device’s study' : 'Load', 'replace', !nCur || !sameName],
          ['Cancel', null] ]);
      if (!choice) return;
      if (choice === 'replace') {
        save(fillKupuRows({ enabled: true, name: inc.name || cur.name, listIds: inc.listIds || [],
          kupuDesign: inc.kupuDesign || cur.kupuDesign, participant: inc.participant || 1,
          assignments: inc.assignments || {}, done: inc.done || {}, current: null }));
      } else {
        const { out, conflicts } = mergeInto(cur, inc);
        save(fillKupuRows(Object.assign({ name: cur.name, current: null }, out)));
        if (conflicts.length) alert(`Different list assignments for ${conflicts.join(', ')} on the two devices. ` +
          'Kept whichever had more lists tested. Check these participants.');
      }
      save({ changesSinceExport: 0 });
      rerender();
    };
    inp.click();
  }

  function backupRow(s, rerender) {
    const n = s.changesSinceExport || 0;
    const when = s.exportedAt ? new Date(s.exportedAt).toLocaleString() : 'never';
    return h('div', { style: 'margin-top:10px;border-top:1px solid #eee;padding-top:8px' },
      h('div', { style: 'display:flex;gap:6px' },
        h('button', { cls: n ? 'mt-btn-sm-primary' : 'mt-btn', style: 'flex:1;font-size:12px', onclick: () => { exportState(); rerender(); } }, '⬇ Export study'),
        h('button', { cls: 'mt-btn', style: 'flex:1;font-size:12px', onclick: () => importState(rerender) }, '⬆ Import / restore…')),
      h('div', { style: `font-size:10px;margin-top:3px;color:${n ? '#a02020' : '#667'}` },
        `Last export: ${when}` + (n ? ` — ${n} change${n === 1 ? '' : 's'} not exported` : '')));
  }

  // Running totals, so the balance is visible at a glance.
  function balanceTable(s, ids) {
    const T = tallies(s, null);
    const maxK = Math.max(0, ...Object.values(s.assignments).map(a => a.seq.length));
    const n = Object.keys(s.assignments).length;
    const wrap = h('details', { style: 'margin-top:10px' });
    wrap.append(h('summary', { style: 'font-size:12px;cursor:pointer;color:#445' }, `Balance so far (${n} participant${n === 1 ? '' : 's'})`));
    if (!n) return wrap;
    const t = h('table', { style: 'border-collapse:collapse;font-size:11px;margin-top:4px;width:100%' });
    const th = x => h('th', { style: 'text-align:center;border-bottom:1px solid #ccc;padding:2px 4px' }, x);
    const td = x => h('td', { style: 'text-align:center;border-bottom:1px solid #eee;padding:2px 4px' }, x);
    t.append(h('tr', {}, th('List'), th('Total'), ...Array.from({ length: maxK }, (_, j) => th(`#${j + 1}`))));
    ids.forEach(id => t.append(h('tr', {},
      h('td', { style: 'padding:2px 4px;border-bottom:1px solid #eee' }, listById(id)?.name || id),
      td(T.use[id] || 0), ...Array.from({ length: maxK }, (_, j) => td(T.pos[id + '@' + j] || 0)))));
    wrap.append(t, h('div', { cls: 'mt-hint-text', style: 'margin-top:4px' },
      '#1, #2 … = times each list was given 1st, 2nd …. Totals stay within one of each other.'));
    return wrap;
  }

  window.kttStudy = {
    renderCard, clinicianOrder, childGridOrder, badge, resultBlock,
    clearCurrent, onSaved, isOn: () => load().enabled,
    exportState, _fromResults: fromResults, _mergeInto: mergeInto, _fillKupuRows: fillKupuRows,
    _williams: williams, _assign: assign, _load: load, _tallies: tallies, _addOne: addOne, _stopHere: stopHere,
  };
})();
