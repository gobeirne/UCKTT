// imageStore.js — Image loading with extension fallback + per-kupu override storage
//
// Two responsibilities:
//   1. loadKupuImage(img, kupu) — sets img.src, trying extensions in order until one loads
//   2. window.kttImageStore — manage per-kupu image overrides stored as base64 in localStorage
//      kttImageStore.get(kupu)         → base64 data URL or null
//      kttImageStore.set(kupu, dataURL)→ saves override
//      kttImageStore.remove(kupu)      → removes override
//      kttImageStore.openReplacer(kupu, onDone) → opens the replace-image UI

(() => {
  'use strict';

  const IMAGE_DIR  = 'Images';
  const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
  const LS_KEY     = 'ktt_image_overrides_v1';

  // ─── Storage ───────────────────────────────────────────────────────────────

  function loadOverrides() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
  }
  function saveOverrides(obj) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch (e) {
      console.warn('kttImageStore: localStorage write failed (may be full):', e);
    }
  }

  const store = {
    get(kupu)           { return loadOverrides()[kupu] || null; },
    set(kupu, dataURL)  { const o = loadOverrides(); o[kupu] = dataURL; saveOverrides(o); },
    remove(kupu)        { const o = loadOverrides(); delete o[kupu]; saveOverrides(o); },
    all()               { return loadOverrides(); },
  };

  // ─── Extension-fallback loader ─────────────────────────────────────────────
  // Returns a Promise<string> of the working URL (for callers that need it).

  function loadKupuImage(imgEl, kupu) {
    // 1. Check for a stored override first
    const override = store.get(kupu);
    if (override) {
      imgEl.src = override;
      imgEl.style.display = '';
      return Promise.resolve(override);
    }

    // 2. Try each extension in sequence
    const exts = EXTENSIONS.slice();

    return new Promise((resolve, reject) => {
      function tryNext() {
        if (!exts.length) {
          imgEl.style.display = 'none';
          reject(new Error(`No image found for "${kupu}"`));
          return;
        }
        const ext = exts.shift();
        const url = `${IMAGE_DIR}/${encodeURIComponent(kupu)}.${ext}`;
        imgEl.onload  = () => { imgEl.style.display = ''; resolve(url); };
        imgEl.onerror = tryNext;
        imgEl.src = url;
      }
      tryNext();
    });
  }

  // Convenience: create a new <img> with fallback loading built in
  function makeKupuImg(kupu, className) {
    const img = document.createElement('img');
    img.className = className || 'thumb';
    img.alt = kupu;
    loadKupuImage(img, kupu);
    return img;
  }

  // ─── Replace-image UI ──────────────────────────────────────────────────────

  function injectReplacerStyles() {
    if (document.getElementById('ktt-replacer-styles')) return;
    const s = document.createElement('style');
    s.id = 'ktt-replacer-styles';
    s.textContent = `
.kr-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 10000; padding: 16px; box-sizing: border-box;
}
.kr-modal {
  background: #fff; border-radius: 10px; width: 100%; max-width: 420px;
  box-shadow: 0 4px 32px rgba(0,0,0,.2); overflow: hidden;
  display: flex; flex-direction: column;
}
.kr-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid #e8e8e8; background: #f7f7f7;
}
.kr-title { font-size: 14px; font-weight: 700; color: #111; font-family: system-ui, sans-serif; }
.kr-close {
  font-size: 18px; border: none; background: none; cursor: pointer;
  color: #888; padding: 2px 7px; border-radius: 4px; line-height: 1;
}
.kr-close:hover { background: #eee; color: #333; }
.kr-body { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.kr-compare {
  display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
}
.kr-img-wrap {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
}
.kr-img-wrap img {
  width: 100%; max-height: 140px; object-fit: contain;
  border: 1px solid #e0e0e0; border-radius: 7px; background: #fafafa;
}
.kr-img-label {
  font-size: 11px; color: #888; font-family: system-ui, sans-serif; text-align: center;
}
.kr-drop-zone {
  border: 2px dashed #bbb; border-radius: 8px; padding: 18px 12px;
  text-align: center; cursor: pointer; background: #fafafa;
  transition: border-color .15s, background .15s;
  font-family: system-ui, sans-serif;
}
.kr-drop-zone:hover, .kr-drop-zone.drag-over { border-color: #3a7de0; background: #eef4ff; }
.kr-drop-text { font-size: 13px; color: #555; }
.kr-drop-sub  { font-size: 11px; color: #aaa; margin-top: 4px; }
.kr-file-input { display: none; }
.kr-preview-wrap {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
}
.kr-preview {
  width: 100%; max-height: 160px; object-fit: contain;
  border: 1px solid #e0e0e0; border-radius: 7px; background: #fafafa; display: none;
}
.kr-preview-label { font-size: 11px; color: #666; font-family: system-ui, sans-serif; }
.kr-actions { display: flex; gap: 8px; }
.kr-btn {
  flex: 1; font-size: 13px; padding: 8px 12px; border: 1px solid #ccc;
  border-radius: 6px; background: #fff; color: #111; cursor: pointer;
  font-family: system-ui, sans-serif;
}
.kr-btn:hover { background: #f0f0f0; }
.kr-btn-primary {
  background: #1a5fa5; color: #fff; border-color: #1a5fa5; font-weight: 600;
}
.kr-btn-primary:hover { background: #0d4a8a; }
.kr-btn-primary:disabled { opacity: .4; cursor: default; }
.kr-btn-danger { border-color: #c0392b; color: #c0392b; }
.kr-btn-danger:hover { background: #fde8e8; }
.kr-size-warn {
  font-size: 11px; color: #b05800; background: #fff8ee; border: 1px solid #f0c070;
  border-radius: 5px; padding: 7px 9px; font-family: system-ui, sans-serif;
  display: flex; flex-direction: column; gap: 5px;
}
    `;
    document.head.appendChild(s);
  }

  function openReplacer(kupu, onDone) {
    injectReplacerStyles();

    let pendingDataURL = null;

    const overlay = document.createElement('div');
    overlay.className = 'kr-overlay';

    // Build current image src (try override first, then default)
    const currentSrc = store.get(kupu) || `${IMAGE_DIR}/${encodeURIComponent(kupu)}.png`;
    const hasOverride = !!store.get(kupu);

    overlay.innerHTML = `
      <div class="kr-modal">
        <div class="kr-header">
          <div class="kr-title">Replace image — ${kupu}</div>
          <button class="kr-close" id="kr-close">✕</button>
        </div>
        <div class="kr-body">
          <div class="kr-compare">
            <div class="kr-img-wrap">
              <img id="kr-current-img" src="${currentSrc}" onerror="this.style.opacity='.3'" alt="${kupu}">
              <div class="kr-img-label">${hasOverride ? 'Current (custom)' : 'Current (default)'}</div>
            </div>
            <div class="kr-img-wrap">
              <img id="kr-new-img" class="kr-preview" alt="new image">
              <div class="kr-img-label kr-preview-label" id="kr-new-label">New image will appear here</div>
            </div>
          </div>

          <div class="kr-drop-zone" id="kr-drop-zone">
            <div class="kr-drop-text">Drop an image here, or click to browse</div>
            <div class="kr-drop-sub">PNG, JPG, JPEG, WebP · Stored locally on this device</div>
            <input class="kr-file-input" id="kr-file-input" type="file" accept="image/*">
          </div>

          <div class="kr-size-warn" id="kr-size-warn" style="display:none">
            <span id="kr-size-warn-text"></span>
            <button class="kr-btn" id="kr-compress-btn" style="margin-top:6px;width:100%">Compress &amp; use</button>
          </div>

          <div class="kr-actions">
            ${hasOverride ? '<button class="kr-btn kr-btn-danger" id="kr-restore-btn">Restore default</button>' : ''}
            <button class="kr-btn" id="kr-cancel-btn">Cancel</button>
            <button class="kr-btn kr-btn-primary" id="kr-save-btn" disabled>Save</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const dropZone   = overlay.querySelector('#kr-drop-zone');
    const fileInput  = overlay.querySelector('#kr-file-input');
    const newImg     = overlay.querySelector('#kr-new-img');
    const newLabel   = overlay.querySelector('#kr-new-label');
    const saveBtn    = overlay.querySelector('#kr-save-btn');
    const sizeWarn   = overlay.querySelector('#kr-size-warn');

    function close() { overlay.remove(); }

    overlay.querySelector('#kr-close').onclick    = close;
    overlay.querySelector('#kr-cancel-btn').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const restoreBtn = overlay.querySelector('#kr-restore-btn');
    if (restoreBtn) {
      restoreBtn.onclick = () => {
        store.remove(kupu);
        close();
        if (typeof onDone === 'function') onDone(kupu, null);
      };
    }

    saveBtn.onclick = () => {
      if (!pendingDataURL) return;
      store.set(kupu, pendingDataURL);
      close();
      if (typeof onDone === 'function') onDone(kupu, pendingDataURL);
    };

    // Drop zone
    dropZone.onclick = () => fileInput.click();
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
    dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
    dropZone.ondrop = (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    };
    fileInput.onchange = () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); };

    const compressBtn = overlay.querySelector('#kr-compress-btn');
    const sizeWarnText = overlay.querySelector('#kr-size-warn-text');

    // Target: max 400px on longest side, JPEG quality 0.82 — typically < 80 KB
    const TARGET_PX   = 400;
    const JPEG_Q      = 0.82;
    const WARN_KB     = 300;  // warn above this

    function compressImage(dataURL, callback) {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, TARGET_PX / Math.max(img.width, img.height));
        const w = Math.round(img.width  * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        callback(canvas.toDataURL('image/jpeg', JPEG_Q), w, h);
      };
      img.src = dataURL;
    }

    function showSizeState(dataURL, filename) {
      const sizeKB = Math.round(dataURL.length * 0.75 / 1024); // base64 → approx bytes
      if (sizeKB > WARN_KB) {
        sizeWarnText.textContent = `This image is ${sizeKB} KB — large images slow the app and may not save.`;
        sizeWarn.style.display = 'block';
        compressBtn.style.display = '';
        compressBtn.textContent = `Compress to ~${TARGET_PX}px JPEG (recommended)`;
      } else {
        sizeWarn.style.display = 'none';
      }
    }

    compressBtn.onclick = () => {
      if (!pendingDataURL) return;
      compressBtn.disabled = true;
      compressBtn.textContent = 'Compressing…';
      compressImage(pendingDataURL, (compressed, w, h) => {
        pendingDataURL = compressed;
        newImg.src = compressed;
        const kb = Math.round(compressed.length * 0.75 / 1024);
        sizeWarnText.textContent = `Compressed to ${w}×${h}px, ~${kb} KB.`;
        compressBtn.style.display = 'none';
      });
    };

    function handleFile(file) {
      if (!file.type.startsWith('image/')) {
        alert('Please choose an image file.');
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        pendingDataURL = e.target.result;
        newImg.src = pendingDataURL;
        newImg.style.display = '';
        newLabel.textContent = file.name;
        saveBtn.disabled = false;
        compressBtn.disabled = false;
        showSizeState(pendingDataURL, file.name);
      };
      reader.readAsDataURL(file);
    }
  }

  // ─── Expose ────────────────────────────────────────────────────────────────

  window.kttImageStore = { ...store, openReplacer };
  window.loadKupuImage = loadKupuImage;
  window.makeKupuImg   = makeKupuImg;

})();
