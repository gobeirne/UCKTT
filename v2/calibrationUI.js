/* calibrationUI.js — the calibration dialog.
 *
 * Deliberately self-contained and dependency-free so the responder-only page
 * can load it without pulling in any clinician code. Follows the UC_CVCV
 * procedure: volume to maximum, noise at unity, measure, type the figure in.
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
    if (document.getElementById('ktt-cal-styles')) return;
    const s = document.createElement('style');
    s.id = 'ktt-cal-styles';
    s.textContent = `
      .cal-overlay { position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9800;
        display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box; }
      .cal-modal { background:#fff;border-radius:12px;width:100%;max-width:520px;max-height:90vh;
        overflow:auto;box-shadow:0 6px 40px rgba(0,0,0,.3);padding:20px;box-sizing:border-box;
        font-family:system-ui,-apple-system,sans-serif; }
      .cal-modal h2 { margin:0 0 4px;font-size:19px;color:#1a3a5c; }
      .cal-step { display:flex;gap:10px;margin:14px 0;font-size:13px;line-height:1.45;color:#333; }
      .cal-num { flex:0 0 24px;height:24px;border-radius:50%;background:#1a5fa5;color:#fff;
        display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px; }
      .cal-warn { background:#fff4e0;border:1px solid #e0c08a;border-radius:8px;padding:10px 12px;
        font-size:12.5px;color:#7a4a00;margin:12px 0; }
      .cal-status { background:#f5f7fa;border-radius:8px;padding:10px 12px;font-size:12.5px;
        color:#444;margin:12px 0; }
      .cal-status.ok { background:#eaf6e4;color:#2d7010; }
      .cal-btn { padding:9px 16px;border-radius:7px;border:1px solid #bbb;background:#fff;
        font-size:14px;cursor:pointer;font-family:inherit; }
      .cal-btn.primary { background:#1a5fa5;border-color:#1a5fa5;color:#fff;font-weight:600; }
      .cal-btn.playing { background:#c0392b;border-color:#c0392b;color:#fff;font-weight:600; }
      .cal-btn:disabled { opacity:.45;cursor:not-allowed; }
      .cal-row { display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px; }
      .cal-input { width:110px;padding:9px 10px;border:1px solid #bbb;border-radius:7px;
        font-size:16px;font-family:inherit; }
    `;
    document.head.appendChild(s);
  }

  function open() {
    injectStyles();
    const cal = window.kttCal;
    if (!cal) { alert('Calibration module not loaded.'); return; }

    const overlay = el('div', { cls: 'cal-overlay' });
    const modal   = el('div', { cls: 'cal-modal' });

    const status = el('div', { cls: 'cal-status' });
    const input  = el('input', { cls: 'cal-input', type: 'number', step: '0.1',
                                 placeholder: 'dB A', inputmode: 'decimal' });

    const refresh = () => {
      const p = cal.profile();
      status.textContent = cal.summary(p);
      status.className = 'cal-status' + (p.isCalibrated ? ' ok' : '');
      if (p.isCalibrated && !input.value) input.value = String(p.measuredDbA);
    };

    const playBtn = el('button', { cls: 'cal-btn primary' }, '▶ Play calibration noise');
    playBtn.onclick = async () => {
      if (cal.isNoisePlaying()) {
        cal.stopNoise();
        playBtn.textContent = '▶ Play calibration noise';
        playBtn.className = 'cal-btn primary';
        return;
      }
      try {
        cal.prime();
        await cal.startNoise();
        playBtn.textContent = '■ Stop noise';
        playBtn.className = 'cal-btn playing';
      } catch (e) {
        alert(`Could not play ${cal.NOISE_URL}\n\n${e.message}`);
      }
    };

    const saveBtn = el('button', { cls: 'cal-btn primary' }, 'Save calibration');
    saveBtn.onclick = () => {
      const v = parseFloat(input.value);
      if (!isFinite(v)) { alert('Enter the measured level in dB A.'); return; }
      cal.stopNoise();
      cal.applyLevel(v);
      refresh();
      playBtn.textContent = '▶ Play calibration noise';
      playBtn.className = 'cal-btn primary';
      if (typeof window.kttCalUI.onSaved === 'function') window.kttCalUI.onSaved(cal.profile());
    };

    const clearBtn = el('button', { cls: 'cal-btn', style: 'color:#c0392b;border-color:#e0b0b0' },
                        'Clear calibration');
    clearBtn.onclick = () => {
      if (!confirm('Clear this device\u2019s calibration? Levels will revert to dB FS.')) return;
      cal.clear();
      input.value = '';
      refresh();
      if (typeof window.kttCalUI.onSaved === 'function') window.kttCalUI.onSaved(cal.profile());
    };

    const close = () => { cal.stopNoise(); overlay.remove(); };
    const closeBtn = el('button', { cls: 'cal-btn' }, 'Close');
    closeBtn.onclick = close;
    overlay.onclick = e => { if (e.target === overlay) close(); };

    modal.append(
      el('h2', {}, 'Calibrate this device'),
      el('div', { style: 'font-size:12px;color:#666' },
         'Each device is calibrated separately. Sound is presented from whichever device is set as the audio source.'),
      el('div', { cls: 'cal-warn' },
         'Set this device\u2019s volume to MAXIMUM before measuring, and leave it there. ' +
         'Every presentation level is an attenuation below that maximum, so if the volume ' +
         'is lowered afterwards, every level presented will be wrong.'),
      step(1, 'Turn the device volume all the way up and connect it to the audiometer or sound system as it will be used for testing.'),
      step(2, 'Play the calibration noise. It is ILTASS-filtered and sits at the mean level of the kupu, so the figure you measure is the speech reference level \u2014 there is no offset to apply.'),
      step(3, 'Measure with the sound level meter at the position the child\u2019s head will occupy, then stop the noise and type the reading below.'),
      el('div', { cls: 'cal-row' }, playBtn),
      el('div', { cls: 'cal-row' },
         el('label', { style: 'font-size:13px' }, 'Measured level:'), input,
         el('span', { style: 'font-size:13px;color:#666' }, 'dB A'), saveBtn),
      status,
      el('div', { cls: 'cal-row' }, clearBtn, el('div', { style: 'flex:1' }), closeBtn),
    );

    refresh();
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  function step(n, text) {
    return el('div', { cls: 'cal-step' }, el('div', { cls: 'cal-num' }, String(n)),
                                          el('div', {}, text));
  }

  window.kttCalUI = { open, onSaved: null };
})();
