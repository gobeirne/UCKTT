/* logs.js — session logging across both paired devices.
 *
 * Three views: this device, the peer device, and the two interleaved on a
 * common clock. The interleaving is the point — "the child tapped 340 ms after
 * the stimulus ended" is only visible when both sides sit on one timeline.
 *
 * Clock skew: the two devices' Date.now() values can differ by seconds, so raw
 * timestamps cannot be merged. An NTP-style exchange over the data channel
 * estimates the offset; the sample with the lowest round-trip time wins, since
 * that is the one least distorted by asymmetric network delay. Peer entries are
 * shifted onto the local clock before interleaving, and every merged line
 * carries the offset's uncertainty so nobody reads more precision into it than
 * the measurement supports.
 *
 * Entries are structured, not just text: presentations, responses, calibration
 * changes and level changes are recorded as objects so the log can be exported
 * as data rather than scraped back out of prose.
 */
(function () {
  'use strict';

  const MAX_ENTRIES  = 4000;
  const FLUSH_MS     = 1500;   // batch peer entries rather than sending each one
  const SKEW_SAMPLES = 7;

  const local = [];            // this device's entries
  const peer  = [];            // entries received from the other device
  let   role  = 'clinician';   // set from pairedMode once the role is known
  let   pendingOut = [];       // queued for transmission to the peer
  let   flushTimer = null;

  // Clock offset: peerClock − localClock, in ms. Null until measured.
  let skew = { offsetMs: null, rttMs: null, samples: 0, at: null };

  const now = () => Date.now();

  function setRole(r) { role = r; }
  function peerRole() { return role === 'clinician' ? 'responder' : 'clinician'; }

  // ─── Recording ────────────────────────────────────────────────────────────

  function add(entry) {
    const e = Object.assign({ t: now(), dev: role, level: 'log' }, entry);
    local.push(e);
    if (local.length > MAX_ENTRIES) local.shift();
    // The responder ships its log to the clinician, who owns the record.
    if (role === 'responder') {
      pendingOut.push(e);
      scheduleFlush();
    }
    return e;
  }

  // Structured event. `kind` is what makes an entry queryable later.
  function event(kind, data, text) {
    return add({ kind, data: data || null, text: text || kind });
  }

  function text(level, str) { return add({ kind: 'console', level, text: str }); }

  // ─── Transport ────────────────────────────────────────────────────────────

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!pendingOut.length) return;
    const batch = pendingOut;
    pendingOut = [];
    if (window.kttPaired?.sendLogBatch) window.kttPaired.sendLogBatch(batch);
    else pendingOut = batch.concat(pendingOut);   // not connected yet — keep them
  }

  function receiveBatch(entries) {
    if (!Array.isArray(entries)) return;
    entries.forEach(e => {
      peer.push(Object.assign({ dev: peerRole(), level: 'log' }, e));
    });
    while (peer.length > MAX_ENTRIES) peer.shift();
  }

  // ─── Clock skew ───────────────────────────────────────────────────────────

  /* NTP-style: t0 = local send, t1 = peer receive/reply, t3 = local receive.
     offset = t1 − (t0 + t3)/2, rtt = t3 − t0. Assumes a symmetric path, which
     is why the lowest-RTT sample is kept: the more delay there is, the more
     room there is for it to be lopsided. */
  function noteSkewSample(t0, t1, t3) {
    const rtt = t3 - t0;
    const offset = t1 - (t0 + t3) / 2;
    if (skew.rttMs === null || rtt < skew.rttMs) {
      skew = { offsetMs: Math.round(offset), rttMs: rtt, samples: skew.samples + 1, at: now() };
    } else {
      skew.samples++;
    }
    return skew;
  }

  function getSkew() { return Object.assign({}, skew); }
  function resetSkew() { skew = { offsetMs: null, rttMs: null, samples: 0, at: null }; }

  // Peer timestamp → local clock.
  function toLocalClock(t) {
    return skew.offsetMs === null ? t : t - skew.offsetMs;
  }

  // ─── Views ────────────────────────────────────────────────────────────────

  function localEntries() { return local.slice(); }
  function peerEntries()  { return peer.slice(); }

  function interleaved() {
    const a = local.map(e => Object.assign({}, e, { tLocal: e.t, corrected: false }));
    const b = peer.map(e => Object.assign({}, e, { tLocal: toLocalClock(e.t), corrected: skew.offsetMs !== null }));
    return a.concat(b).sort((x, y) => x.tLocal - y.tLocal);
  }

  /* Reaction times, which fall out of the interleaved view for free: the gap
     between a stimulus finishing and the child's tap. Only meaningful once the
     clocks are aligned, so it returns nothing until skew has been measured. */
  function reactionTimes() {
    if (skew.offsetMs === null) return [];
    const rows = interleaved();
    const out = [];
    let armed = null;
    rows.forEach(e => {
      if (e.kind === 'audio-complete') armed = e;
      else if (e.kind === 'response' && armed) {
        out.push({
          kupu: e.data?.kupu, level: armed.data?.level,
          ms: Math.round(e.tLocal - armed.tLocal),
        });
        armed = null;
      }
    });
    return out;
  }

  function clear() { local.length = 0; peer.length = 0; pendingOut = []; }

  function fmt(t) {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:` +
           `${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }

  function lineOf(e, withDev) {
    const dev = withDev ? `[${(e.dev || '?').slice(0, 4).toUpperCase().padEnd(4)}] ` : '';
    const kind = e.kind && e.kind !== 'console' ? `${e.kind}: ` : '';
    const data = e.data ? ` ${JSON.stringify(e.data)}` : '';
    return `${fmt(e.tLocal || e.t)} ${dev}${kind}${e.text || ''}${data}`;
  }

  function asText(view) {
    const s = getSkew();
    const header = [
      `KTT log — ${view} view`,
      `Exported ${new Date().toISOString()}`,
      s.offsetMs === null
        ? 'Clock skew: NOT MEASURED — peer timestamps are on their own clock and are not comparable.'
        : `Clock skew: peer is ${s.offsetMs >= 0 ? '+' : ''}${s.offsetMs} ms vs this device ` +
          `(best RTT ${s.rttMs} ms over ${s.samples} samples, so alignment is good to roughly ±${Math.ceil(s.rttMs / 2)} ms).`,
      '',
    ];
    const rows = view === 'clinician' ? (role === 'clinician' ? localEntries() : peerEntries())
               : view === 'responder' ? (role === 'responder' ? localEntries() : peerEntries())
               : interleaved();
    return header.concat(rows.map(e => lineOf(e, view === 'interleaved'))).join('\n');
  }

  function asJSON() {
    return {
      exported: new Date().toISOString(),
      role,
      skew: getSkew(),
      calibration: window.kttCal ? window.kttCal.profile() : null,
      peerCalibration: window.kttPaired?.getResponderCal?.() || null,
      reactionTimes: reactionTimes(),
      local: localEntries(),
      peer: peerEntries(),
    };
  }

  window.kttLogs = {
    setRole, add, event, text,
    flush, receiveBatch,
    noteSkewSample, getSkew, resetSkew, toLocalClock,
    localEntries, peerEntries, interleaved, reactionTimes,
    clear, asText, asJSON, fmt,
  };

  // Mirror console output into the structured store so the two views stay in
  // step without every call site having to log twice.
  ['log', 'warn', 'error'].forEach(level => {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      try {
        const str = args.map(a => {
          if (typeof a === 'object' && a !== null) {
            try { return JSON.stringify(a); } catch { return String(a); }
          }
          return String(a);
        }).join(' ');
        text(level === 'error' ? 'err' : level, str);
      } catch (_) {}
    };
  });
})();
