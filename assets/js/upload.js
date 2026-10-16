/* ============================================================
   CatBookmark — 上傳頁：揀相 → 壓縮 → dispatch GitHub Actions
   → 輪詢 AI 結果 → 可編輯標籤 → 儲存入 books.json
   ============================================================ */
(function () {
  'use strict';

  var MAX_DIM = 1280;        /* 壓縮後最長邊 */
  var JPEG_QUALITY = 0.78;
  var WEBP_QUALITY = 0.75;
  /* GitHub 對 workflow_dispatch inputs 同 repository_dispatch client_payload 嘅上限都係 65,535 字元；
     圖片 base64 目標 ≤60,000 字元。用 WebP（瀏覽器支援時）喺同一預算下解像度高出約 40%，細字更易讀 */
  var MAX_B64_LEN = 60000;
  var MIN_DIM = 480;         /* 縮細下限，太細就冇辦法讀到書名 */
  var POLL_INTERVAL = 5000;  /* ms */
  var POLL_MAX = 72;         /* 約 6 分鐘 */

  /* ---------- 直連 OpenRouter 用嘅 prompt（同 analyze.py 一致） ---------- */
  var SYSTEM_PROMPT =
    '你係一個協助整理閱讀筆記嘅助手。用戶影咗一本書其中一頁嘅相片，' +
    '頁面有書名同螢光筆標記。\n' +
    '請完成兩件事：\n' +
    '1. 如果頁面頁眉或頁腳印有書名，寫出書名；如果嗰行明顯係章節名或內文，就寫空字串。\n' +
    '2. 睇下頁面有冇螢光筆（marker / highlighter）標記嘅詞彙或短語；' +
    '有就逐個列出，保留原文語言（中英夾雜就照寫），每個獨立一項，唔好加 # 符號，' +
    '唔好自行擴寫或翻譯。\n' +
    '只可以輸出一個 JSON 物件，格式嚴格如下：\n' +
    '{"book_title": "書名", "tags": ["關鍵字1", "關鍵字2"]}\n' +
    '唔好輸出任何其他文字、解釋、或者 markdown 標記。';
  var USER_PROMPT = '請睇吓呢張書頁相片，寫出書名同螢光筆標記嘅重點詞彙（最多 15 個，唔好重複）。';

  /* ---------- 直連模式提示 banner：未啟用直連就話畀用戶知 ---------- */
  (function showModeBanner() {
    var banner = document.getElementById('mode-banner');
    var text = document.getElementById('mode-banner-text');
    if (!banner || !text) return;
    if (CB.getOrKey()) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.className = 'mode-banner warn';
    text.innerHTML = '⏳ 你而家用緊 <b>GitHub Actions 後備模式</b>（約 1–2 分鐘先有結果）。' +
      '去 <a href="settings.html" style="color:inherit;text-decoration:underline;">⚙️ 設定</a> 嘅「🚀 瀏覽器直連」貼你嘅 OpenRouter API Key 一次，' +
      '之後上傳就 <b>幾秒</b>出結果。';
  })();

  var dz = document.getElementById('dropzone');
  var fileInput = document.getElementById('file-input');
  var cameraInput = document.getElementById('camera-input');
  var queue = document.getElementById('queue');

  /* ---------- 拖放 + 揀檔 ---------- */
  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
  });
  dz.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      handleFiles(e.dataTransfer.files);
    }
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files.length) handleFiles(fileInput.files);
    fileInput.value = '';
  });
  cameraInput.addEventListener('change', function () {
    if (cameraInput.files.length) handleFiles(cameraInput.files);
    cameraInput.value = '';
  });

  /* ---------- 圖片壓縮（只喺瀏覽器記憶體，唔會上傳原相） ---------- */
  var IMG_FORMAT = null; /* 'webp' 或 'jpeg'，首次使用時偵測 */

  function pickFormat() {
    if (IMG_FORMAT) return IMG_FORMAT;
    var c = document.createElement('canvas');
    c.width = 2;
    c.height = 2;
    IMG_FORMAT = c.toDataURL('image/webp', 0.8).indexOf('data:image/webp') === 0 ? 'webp' : 'jpeg';
    return IMG_FORMAT;
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('無法讀取圖片')); };
      img.src = url;
    });
  }

  function render(source, w, h, quality) {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    return canvas.toDataURL('image/' + pickFormat(), quality);
  }

  function compressImage(file) {
    return Promise.resolve().then(function () {
      var sourcePromise;
      try {
        sourcePromise = createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (e) {
        sourcePromise = loadImage(file);
      }
      return sourcePromise;
    }).then(function (source) {
      var isBitmap = !!(source && source.close);
      try {
        var scale = Math.min(1, MAX_DIM / Math.max(source.width, source.height));
        var w = Math.max(1, Math.round(source.width * scale));
        var h = Math.max(1, Math.round(source.height * scale));
        var quality = pickFormat() === 'webp' ? WEBP_QUALITY : JPEG_QUALITY;
        var dataUrl = render(source, w, h, quality);
        var base64 = dataUrl.split(',')[1];
        var shrunk = false;
        var guard = 0;
        /* 自適應縮細：每次最多縮 30% 尺寸、品質 -0.05，直到符合 GitHub input 上限 */
        while (base64.length > MAX_B64_LEN && guard < 8) {
          var s = Math.max(0.7, Math.sqrt(MAX_B64_LEN / base64.length));
          w = Math.max(MIN_DIM, Math.round(w * s));
          h = Math.max(MIN_DIM, Math.round(h * s));
          quality = Math.max(0.45, quality - 0.05);
          dataUrl = render(source, w, h, quality);
          base64 = dataUrl.split(',')[1];
          shrunk = true;
          guard += 1;
        }
        return { base64: base64, dataUrl: dataUrl, shrunk: shrunk, format: pickFormat() };
      } finally {
        if (isBitmap) source.close();
      }
    });
  }

  /* ---------- 直連 OpenRouter：瀏覽器直接 call，幾秒出結果 ---------- */
  function parseAiJson(content) {
    if (!content) return null;
    content = String(content).trim();
    var m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) content = m[1].trim();
    try {
      var obj = JSON.parse(content);
      if (obj && typeof obj === 'object') return obj;
    } catch (e) { /* fall through */ }
    var start = content.indexOf('{');
    var end = content.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        var obj2 = JSON.parse(content.slice(start, end + 1));
        if (obj2 && typeof obj2 === 'object') return obj2;
      } catch (e2) { /* ignore */ }
    }
    return null;
  }

  function directAnalyze(dataUrl) {
    var cfg = CB.getAiCache();
    var key = CB.getOrKey();
    return fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin + location.pathname,
        'X-Title': 'CatBookmark'
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: USER_PROMPT }
          ]}
        ],
        temperature: 0.1,
        max_tokens: 500
      })
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (j) {
        if (!res.ok) {
          var msg = (j && j.error) ? (j.error.message || JSON.stringify(j.error)) : ('HTTP ' + res.status);
          throw new Error('OpenRouter HTTP ' + res.status + ': ' + msg);
        }
        var content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        var parsed = parseAiJson(content);
        if (!parsed) throw new Error('模型回應無法解析');
        var book_title = String(parsed.book_title || '').trim();
        var tags = [];
        var seen = {};
        (Array.isArray(parsed.tags) ? parsed.tags : []).forEach(function (t) {
          t = String(t).trim().replace(/^#+/, '').trim();
          if (t && !seen[t] && tags.length < 30) { seen[t] = true; tags.push(t); }
        });
        return { book_title: book_title, tags: tags };
      });
    });
  }

  /* ---------- 輪詢 pending 結果檔（GitHub Actions 後備模式） ---------- */
  function pollPending(id) {
    var attempts = 0;
    function tick() {
      attempts += 1;
      return CB.rawText('data/pending/' + id + '.json').then(function (text) {
        return JSON.parse(text);
      }).catch(function () {
        if (attempts >= POLL_MAX) {
          throw new Error('分析逾時（約 6 分鐘）。請到 GitHub > Actions 睇下 run 狀態，或者考慮喺設定頁啟用「瀏覽器直連」。');
        }
        return sleep(POLL_INTERVAL).then(tick);
      });
    }
    return tick();
  }

  /* ---------- 卡片 ---------- */
  function Card(file, id) {
    this.id = id;
    this._saved = false;
    this._direct = false;   /* 直連模式：冇 pending 檔，儲存/捨棄唔使刪檔 */
    this._previewUrl = null;
    var card = this;

    this.el = document.createElement('article');
    this.el.className = 'card';
    this.el.innerHTML =
      '<div class="card-head">' +
      '  <div class="card-thumb" data-role="thumb"></div>' +
      '  <div class="card-status" data-role="status">準備中…</div>' +
      '</div>' +
      '<div class="card-body">' +
      '  <div class="field">' +
      '    <span class="field-label">書名（頁眉/頁腳，可編輯）</span>' +
      '    <input data-role="title" type="text" placeholder="書名…" autocomplete="off">' +
      '  </div>' +
      '  <div class="field">' +
      '    <span class="field-label">標籤（#tag，可刪除／編輯／新增）</span>' +
      '    <div class="chips" data-role="chips"></div>' +
      '    <input class="add-tag" data-role="add" type="text" placeholder="＋ 新增標籤，按 Enter" autocomplete="off">' +
      '  </div>' +
      '</div>' +
      '<div class="card-actions">' +
      '  <button class="btn btn-primary" data-role="save" type="button">儲存</button>' +
      '  <button class="btn btn-ghost" data-role="discard" type="button">捨棄</button>' +
      '</div>';

    this.thumbEl = this.el.querySelector('[data-role="thumb"]');
    this.statusEl = this.el.querySelector('[data-role="status"]');
    this.titleInput = this.el.querySelector('[data-role="title"]');
    this.chipsEl = this.el.querySelector('[data-role="chips"]');
    this.addInput = this.el.querySelector('[data-role="add"]');
    this.saveBtn = this.el.querySelector('[data-role="save"]');
    this.discardBtn = this.el.querySelector('[data-role="discard"]');

    /* 預覽只放喺瀏覽器記憶體；儲存後清除 */
    var url = URL.createObjectURL(file);
    this._previewUrl = url;
    var img = document.createElement('img');
    img.src = url;
    img.alt = '書頁預覽';
    this.thumbEl.appendChild(img);

    this.saveBtn.disabled = true;
    this.saveBtn.addEventListener('click', function () { card.save(); });
    this.discardBtn.addEventListener('click', function () { card.discard(); });
    this.addInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); card.addTag(card.addInput.value); }
    });
  }

  Card.prototype.status = function (text, cls) {
    this.statusEl.textContent = text;
    this.statusEl.className = 'card-status ' + (cls || '');
  };

  Card.prototype.getTags = function () {
    return Array.prototype.map.call(
      this.chipsEl.querySelectorAll('.chip-text'),
      function (el) { return el.textContent.trim(); }
    ).filter(Boolean);
  };

  Card.prototype._renderChips = function (tags) {
    var self = this;
    var chipsEl = this.chipsEl;
    chipsEl.innerHTML = '';
    tags.forEach(function (t) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      var text = document.createElement('span');
      text.className = 'chip-text';
      text.contentEditable = 'true';
      text.textContent = t;
      text.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); text.blur(); }
      });
      var x = document.createElement('button');
      x.className = 'chip-x';
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', '刪除標籤');
      chip.appendChild(text);
      chip.appendChild(x);
      chipsEl.appendChild(chip);
      x.addEventListener('click', function () {
        var clicked = x.parentNode.querySelector('.chip-text').textContent.trim();
        var rest = Array.prototype.map.call(
          chipsEl.querySelectorAll('.chip-text'),
          function (el) { return el.textContent.trim(); }
        ).filter(function (v) { return v !== clicked; });
        self._renderChips(rest);
      });
    });
  };

  Card.prototype.addTag = function (raw) {
    var t = String(raw || '').trim().replace(/^#+/, '').trim();
    if (!t) return;
    var tags = this.getTags();
    if (tags.indexOf(t) !== -1) { this.addInput.value = ''; return; }
    this.addInput.value = '';
    tags.push(t);
    this._renderChips(tags);
  };

  Card.prototype.setResult = function (result) {
    this.titleInput.value = result.book_title || '';
    this._renderChips(Array.isArray(result.tags) ? result.tags : []);
    this.saveBtn.disabled = false;
    this.status('AI 分析完成，可以編輯', 'ok');
  };

  Card.prototype.showError = function (msg) {
    this.saveBtn.disabled = false;
    this.status('⚠ ' + msg, 'error');
  };

  Card.prototype.save = function () {
    var card = this;
    if (card._saved) return;
    var title = card.titleInput.value.trim();
    var tags = card.getTags();
    if (!title) return toast('請輸入書名', 'warn');
    if (!tags.length) return toast('請至少保留一個標籤', 'warn');

    card.status('儲存緊…');
    card.saveBtn.disabled = true;
    CB.rawText('data/books.json').then(function (text) {
      var rows;
      try { rows = JSON.parse(text); } catch (e) { rows = []; }
      if (!Array.isArray(rows)) rows = [];
      var seen = {};
      rows.forEach(function (r) { seen[(r.book_title || '') + '\u0000' + (r.tag || '')] = true; });
      tags.forEach(function (t) {
        var key = title + '\u0000' + t;
        if (!seen[key]) { rows.push({ book_title: title, tag: t }); seen[key] = true; }
      });
      return rows;
    }).then(function (rows) {
      return CB.writeFile('data/books.json', JSON.stringify(rows, null, 2) + '\n', '新增書目：' + title);
    }).then(function () {
      if (card._direct) return null; /* 直連模式冇 pending 檔 */
      return CB.deleteFile('data/pending/' + card.id + '.json')
        .catch(function () { return null; });
    }).then(function () {
      card._saved = true;
      if (card._previewUrl) {
        URL.revokeObjectURL(card._previewUrl);
        card._previewUrl = null;
        card.thumbEl.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.6rem;color:var(--ok);">✓</div>';
      }
      card.saveBtn.textContent = '已儲存';
      card.status('✓ 已儲存到 books.json', 'ok');
      toast('已儲存 ✓', 'ok');
    }).catch(function (err) {
      card.saveBtn.disabled = false;
      card.status('儲存失敗：' + err.message, 'error');
      toast('儲存失敗：' + err.message, 'error');
    });
  };

  Card.prototype.discard = function () {
    var card = this;
    if (card._direct) { card.remove(); return; }
    CB.deleteFile('data/pending/' + card.id + '.json').catch(function () { return null; }).then(function () {
      card.remove();
    });
  };

  Card.prototype.remove = function () {
    if (this._previewUrl) URL.revokeObjectURL(this._previewUrl);
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  };

  /* ---------- 主流程 ---------- */
  function runActionsPath(id, card, compressed) {
    card.status(compressed.shrunk ? 'AI 分析緊…（已自動壓縮）' : 'AI 分析緊…');
    return CB.dispatchWorkflow('analyze.yml', {
      image_base64: compressed.base64,
      image_id: id
    }).then(function () {
      card.status('等緊分析結果…');
      return pollPending(id);
    }).then(function (result) {
      if (result && result.error) card.showError(result.error);
      else card.setResult(result || { book_title: '', tags: [] });
    });
  }

  function handleFiles(fileList) {
    var files = Array.prototype.filter.call(fileList, function (f) { return f.type.indexOf('image/') === 0; });
    if (!files.length) return toast('請揀相片檔案', 'warn');
    if (!CB.getPat()) return toast('未設定 GitHub Token：請先去「設定」頁填入', 'error');
    try { CB.requireRepo(); } catch (e) { return toast(e.message, 'error'); }

    var chain = Promise.resolve();
    files.forEach(function (file) {
      chain = chain.then(function () {
        var id = (crypto.randomUUID ? crypto.randomUUID()
          : 'cb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
        var card = new Card(file, id);
        queue.insertBefore(card.el, queue.firstChild);
        return compressImage(file).then(function (compressed) {
          if (compressed.base64.length > MAX_B64_LEN + 50000) {
            throw new Error('相片太複雜，壓縮後仍然超出限制（請揀較清晰嘅書頁相）');
          }
          if (CB.getOrKey()) {
            /* 直連模式：瀏覽器直接 call OpenRouter，幾秒出結果，相片唔會離開部機 */
            card._direct = true;
            card.status(compressed.shrunk ? 'AI 分析緊…（直連，幾秒）' : 'AI 分析緊…（直連，幾秒）');
            return directAnalyze(compressed.dataUrl).then(function (result) {
              card.setResult(result);
            }).catch(function (err) {
              card._direct = false;
              card.status('直連失敗，自動改用 GitHub Actions…');
              toast('直連失敗（' + (err.message || err) + '），改用後備模式', 'warn');
              return runActionsPath(id, card, compressed);
            });
          }
          /* 後備模式：GitHub Actions */
          return runActionsPath(id, card, compressed);
        }).catch(function (err) {
          card.showError(err.message || '分析失敗');
        });
      });
    });
  }

  window.handleFiles = handleFiles;
})();
