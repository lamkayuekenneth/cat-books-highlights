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
    'You are an OCR assistant that extracts reading marks from a photo of a book page (vertical or horizontal books both work).\n' +
    'Your ONLY job:\n' +
    '1. Extract the characters marked with a highlighter (any color; includes text enclosed in a colored box/frame) — INCLUDE the punctuation of the marked text.\n' +
    '2. Extract the characters underlined with any pen, pencil or highlighter — INCLUDE the punctuation of the marked text.\n' +
    'Each continuous marked run becomes exactly ONE tag. Only clear, continuous marks count: a solid color block covering characters, a complete colored box/frame around characters, or a line drawn over the characters (horizontal book: line below the characters; vertical book: line on the left side of the characters).\n' +
    'Do NOT include unmarked text. Do NOT paraphrase, summarize, translate, expand or rewrite — copy the marked characters exactly as printed.\n' +
    'If a mark covers a character, read the real character shape beneath it — the mark never changes the character.\n' +
    'Do NOT count faint color noise, paper shadows, stains, color bleeding from an adjacent mark, or isolated dots as marks.\n' +
    'If the same continuous marked text spans multiple columns, merge the columns into ONE tag.\n' +
    'If there are no marks, tags MUST be [].\n' +
    'Also return the book title printed on the page (in the header/footer; chapter titles do not count — write an empty string if none) and the printed page number (digits only — write an empty string if none).\n' +
    'Output ONLY one JSON object, no other text, in exactly this format:\n' +
    '{"book_title": "書名", "page": "頁碼", "tags": ["標記字1", "標記字2"]}';
  var USER_PROMPT = 'Extract ONLY the highlighted or underlined characters (including their punctuation) from this book page — one tag per continuous mark. Also include the printed book title (empty string if none; chapter titles do not count) and the printed page number (digits only; empty string if none). If there are no marks, tags = []. Return JSON only in the format {"book_title": "...", "page": "...", "tags": ["..."]}.';

  /* ---------- 書本庫：認書名＋作者用嘅 prompt（同 books.js 一致） ---------- */
  var BOOKS_SYSTEM_PROMPT =
    'You are an assistant that helps organize book catalog data. The user photographed a book (usually the cover, spine, or copyright page, sometimes an inner page).\n' +
    'Please identify two things:\n' +
    '1. Book title: the title printed on the book (the most prominent title on the cover, or the title on the copyright page). If you cannot identify it, write an empty string — do not guess.\n' +
    '2. Author: the author name printed on the book (usually near "著/作者/撰/by", or the signature on the cover). If you cannot identify it, write an empty string — do not guess.\n' +
    'Output ONLY one JSON object in exactly this format:\n' +
    '{"book_title": "書名", "author": "作者"}\n' +
    'Write an empty string if the title or author cannot be identified. Do not output any other text, explanation, or markdown formatting.';
  var BOOKS_USER_PROMPT = 'Look at this photo and identify the book title and author (leave empty if you cannot identify them).';

  /* ---------- 書本庫 meta 快取（suggest／揀書 modal 用） ---------- */
  var metaCache = null;
  function loadMeta(force) {
    if (metaCache && !force) return Promise.resolve(metaCache);
    return CB.freshText('data/books_meta.json').then(function (text) {
      var arr = [];
      try { arr = JSON.parse(text); } catch (e) { arr = []; }
      if (!Array.isArray(arr)) arr = [];
      metaCache = arr;
      return arr;
    }).catch(function () { return []; });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

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
  var pageBanner = document.getElementById('page-banner');

  /* ---------- 醒目持久橫幅（手機上傳冇反應主因：淨係 toast 太易睇漏） ---------- */
  function showBanner(msg, cls) {
    if (!pageBanner) return;
    pageBanner.hidden = false;
    pageBanner.className = 'page-banner ' + (cls || 'warn');
    pageBanner.innerHTML = msg;
  }
  function clearBanner() {
    if (pageBanner) pageBanner.hidden = true;
  }

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

  /* ---------- 從剪貼簿貼上圖片（Clipboard API，HTTPS／localhost 先得） ---------- */
  var clipboardBtn = document.getElementById('clipboard-btn');
  if (clipboardBtn) {
    clipboardBtn.addEventListener('click', function () {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        return toast('此瀏覽器唔支援直接讀剪貼簿圖片（可改用「從相簿揀相片」）', 'warn');
      }
      toast('讀緊剪貼簿…', 'info');
      navigator.clipboard.read().then(function (items) {
        var item = null, type = null;
        var i, t;
        for (i = 0; i < items.length; i++) {
          for (t = 0; t < items[i].types.length; t++) {
            if (items[i].types[t].indexOf('image/') === 0) { item = items[i]; type = items[i].types[t]; break; }
          }
          if (item) break;
        }
        if (!item) {
          showBanner('⚠ 剪貼簿入面冇圖片：請先複製一張書頁相（長按／右鍵圖片 → 複製），再撳「📋 貼上圖片」。', 'warn');
          throw new Error('NO_IMAGE');
        }
        return item.getType(type).then(function (blob) {
          var ext = type.indexOf('png') !== -1 ? 'png'
            : type.indexOf('jpeg') !== -1 || type.indexOf('jpg') !== -1 ? 'jpg'
            : type.indexOf('webp') !== -1 ? 'webp' : 'img';
          var f = new File([blob], 'clipboard-' + Date.now() + '.' + ext, { type: type });
          handleFiles([f]);
        });
      }).catch(function (err) {
        if (err && err.message === 'NO_IMAGE') return;
        toast('讀剪貼簿失敗：' + (err.message || err) + '（可改用「從相簿揀相片」）', 'warn');
      });
    });
  }

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
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('無法讀取圖片（格式唔支援？）')); };
      img.src = url;
    });
  }

  /* createImageBitmap：同步 throw 同非同步 reject 都要 fallback 去 <img> 解碼
     （iOS Safari 解 HEIC 用 <img> 得，createImageBitmap 會 reject） */
  function makeBitmap(file) {
    return new Promise(function (resolve, reject) {
      var p = null;
      try { p = createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (e) { p = null; }
      if (p) { p.then(resolve, function () { loadImage(file).then(resolve, reject); }); }
      else { loadImage(file).then(resolve, reject); }
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

  function compressImage(file, opts) {
    opts = opts || {};
    var maxDim = opts.maxDim || MAX_DIM;
    var maxB64 = opts.maxB64 || MAX_B64_LEN;
    return Promise.resolve().then(function () {
      return makeBitmap(file);
    }).then(function (source) {
      var isBitmap = !!(source && source.close);
      try {
        var scale = Math.min(1, maxDim / Math.max(source.width, source.height));
        var w = Math.max(1, Math.round(source.width * scale));
        var h = Math.max(1, Math.round(source.height * scale));
        var quality = pickFormat() === 'webp' ? WEBP_QUALITY : JPEG_QUALITY;
        var dataUrl = render(source, w, h, quality);
        var base64 = dataUrl.split(',')[1];
        var shrunk = false;
        var guard = 0;
        /* 自適應縮細：每次最多縮 30% 尺寸、品質 -0.05，直到符合 GitHub input 上限 */
        while (base64.length > maxB64 && guard < 8) {
          var s = Math.max(0.7, Math.sqrt(maxB64 / base64.length));
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

  function directAnalyze(dataUrl, sysPrompt, userPrompt) {
    var cfg = CB.getAiCache();
    var key = CB.getOrKey();
    /* Base URL 正規化：剝走用戶可能連埋嘅 /chat/completions（防雙重 endpoint → 404） */
    var base = String(cfg.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
    return fetch(base + '/chat/completions', {
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
          { role: 'system', content: sysPrompt || SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: userPrompt || USER_PROMPT }
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
        var page = String(parsed.page || '').trim();
        var author = String(parsed.author || '').trim();
        var tags = [];
        var seen = {};
        (Array.isArray(parsed.tags) ? parsed.tags : []).forEach(function (t) {
          t = String(t).trim().replace(/^#+/, '').trim();
          if (t && !seen[t] && tags.length < 30) { seen[t] = true; tags.push(t); }
        });
        return { book_title: book_title, page: page, author: author, tags: tags };
      });
    });
  }

  /* ---------- 輪詢 pending 結果檔（GitHub Actions 後備模式） ---------- */
  function pollPending(id) {
    var attempts = 0;
    function tick() {
      attempts += 1;
      /* 用 Contents API 讀（冇 raw CDN 延遲），workflow 一 commit 即刻睇到 */
      return CB.freshText('data/pending/' + id + '.json').then(function (text) {
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
      '  <div class="field field-rel">' +
      '    <span class="field-label">書名（頁眉/頁腳，可編輯）</span>' +
      '    <input data-role="title" type="text" placeholder="書名…" autocomplete="off">' +
      '    <div class="suggest" data-role="suggest" hidden></div>' +
      '    <p class="field-error" data-role="title-error" hidden>⚠ 書名係必填——AI 喺頁面搵唔到書名（可能冇印），你可以手動打返書名，先至可以儲存。</p>' +
      '  </div>' +
      '  <div class="lib-options" data-role="lib-options">' +
      '    <p class="lib-options-text" data-role="lib-text" hidden></p>' +
      '    <div class="lib-options-actions">' +
      '      <button class="btn btn-small" data-role="opt-pick" type="button">🗂️ 從書本庫中揀書</button>' +
      '      <button class="btn btn-small" data-role="opt-gallery" type="button">🖼️ 揀相（AI 認書名＋作者）</button>' +
      '      <button class="btn btn-small" data-role="opt-photo" type="button">📷 拍照（AI 認書名＋作者）</button>' +
      '      <button class="btn btn-small" data-role="opt-clip" type="button">📋 貼上（AI 認書名＋作者）</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="field" data-role="author-wrap" hidden>' +
      '    <span class="field-label">作者（可選，之後可喺「書本庫」頁改）</span>' +
      '    <input data-role="author" type="text" placeholder="作者…（optional）" autocomplete="off">' +
      '  </div>' +
      '  <div class="field">' +
      '    <span class="field-label">頁數（可編輯，冇就留空）</span>' +
      '    <input data-role="page" type="text" placeholder="例如 150" autocomplete="off">' +
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
    this.pageInput = this.el.querySelector('[data-role="page"]');
    this.chipsEl = this.el.querySelector('[data-role="chips"]');
    this.addInput = this.el.querySelector('[data-role="add"]');
    this.saveBtn = this.el.querySelector('[data-role="save"]');
    this.discardBtn = this.el.querySelector('[data-role="discard"]');
    this.titleErrorEl = this.el.querySelector('[data-role="title-error"]');
    this.authorWrap = this.el.querySelector('[data-role="author-wrap"]');
    this.authorInput = this.el.querySelector('[data-role="author"]');
    this.libOptions = this.el.querySelector('[data-role="lib-options"]');
    this.libText = this.el.querySelector('[data-role="lib-text"]');
    this.optPick = this.el.querySelector('[data-role="opt-pick"]');
    this.optGallery = this.el.querySelector('[data-role="opt-gallery"]');
    this.optPhoto = this.el.querySelector('[data-role="opt-photo"]');
    this.optClip = this.el.querySelector('[data-role="opt-clip"]');
    this.suggestEl = this.el.querySelector('[data-role="suggest"]');

    /* 書名框狀態底色：空 → 紅，有字 → 綠（一開卡就反映） */
    this.updateTitleState();

    /* 書名一打字就收埋警告＋一路打一路 suggest 書本庫書名＋即時檢查書本庫 */
    this.titleInput.addEventListener('input', function () {
      card.titleErrorEl.hidden = true;
      card.titleInput.classList.remove('input-error');
      card.updateTitleState();
      card.updateSuggest();
      card.checkLibraryHint();
    });
    this.titleInput.addEventListener('blur', function () {
      setTimeout(function () { if (card.suggestEl) card.suggestEl.hidden = true; }, 150);
    });

    /* 書名框下面常駐四個掣：揀書／揀相／拍照／貼上（任何時候都得用） */
    this.optPick.addEventListener('click', function () {
      openPickModal(card);
    });
    this.optGallery.addEventListener('click', function () {
      card.pickCoverPhoto(false); /* 揀相簿 */
    });
    this.optPhoto.addEventListener('click', function () {
      card.pickCoverPhoto(true); /* 開相機 */
    });
    this.optClip.addEventListener('click', function () {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        return toast('此瀏覽器唔支援直接讀剪貼簿圖片（可改用「揀相」）', 'warn');
      }
      toast('讀緊剪貼簿…', 'info');
      navigator.clipboard.read().then(function (items) {
        var item = null, type = null, i, t;
        for (i = 0; i < items.length; i++) {
          for (t = 0; t < items[i].types.length; t++) {
            if (items[i].types[t].indexOf('image/') === 0) { item = items[i]; type = items[i].types[t]; break; }
          }
          if (item) break;
        }
        if (!item) throw new Error('剪貼簿入面冇圖片——請先複製一張書本相，再撳「📋 貼上」');
        return item.getType(type).then(function (blob) {
          var ext = type.indexOf('png') !== -1 ? 'png'
            : type.indexOf('jpeg') !== -1 || type.indexOf('jpg') !== -1 ? 'jpg'
            : type.indexOf('webp') !== -1 ? 'webp' : 'img';
          var f = new File([blob], 'clipboard-' + Date.now() + '.' + ext, { type: type });
          card.analyzeCoverFile(f);
        });
      }).catch(function (err) {
        toast(err && err.message ? err.message : ('讀剪貼簿失敗：' + err), 'warn');
      });
    });

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

  /* 建立一個 tag chip（index 頁專用編輯方式）：
     - Enter：喺 cursor 位置切開，後面文字變成另一個 tag
     - Backspace（cursor 喺 tag 開頭）：成個 tag 併返上去上面嗰個 tag */
  Card.prototype._makeChip = function (value) {
    var self = this;
    var chipsEl = this.chipsEl;
    var chip = document.createElement('span');
    chip.className = 'chip';
    var text = document.createElement('span');
    text.className = 'chip-text';
    text.contentEditable = 'true';
    text.textContent = value;

    text.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var sel = window.getSelection();
        var off = (sel && sel.anchorNode === text.firstChild) ? sel.anchorOffset : 0;
        var full = text.textContent;
        var before = full.slice(0, off);
        var after = full.slice(off);
        if (before.trim() === '' || after.trim() === '') { text.blur(); return; }
        /* 喺 cursor 位切開：前面留喺呢個 tag，後面開一個新 tag */
        text.textContent = before.trim();
        var newChip = self._makeChip(after.trim());
        chip.insertAdjacentElement('afterend', newChip);
        var r = document.createRange();
        var nc = newChip.querySelector('.chip-text').firstChild;
        r.setStart(nc, 0);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
      if (e.key === 'Backspace') {
        var sel2 = window.getSelection();
        var off2 = (sel2 && sel2.anchorNode === text.firstChild) ? sel2.anchorOffset : 0;
        if (off2 === 0) {
          e.preventDefault();
          var all = chipsEl.querySelectorAll('.chip-text');
          var idx = Array.prototype.indexOf.call(all, text);
          if (idx > 0) {
            var prev = all[idx - 1];
            prev.textContent = prev.textContent + text.textContent;
            chip.remove();
            var r2 = document.createRange();
            r2.selectNodeContents(prev);
            r2.collapse(false);
            var s2 = window.getSelection();
            s2.removeAllRanges();
            s2.addRange(r2);
          }
        }
        return;
      }
    });

    var x = document.createElement('button');
    x.className = 'chip-x';
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', '刪除標籤');
    chip.appendChild(text);
    chip.appendChild(x);
    x.addEventListener('click', function () {
      var clicked = x.parentNode.querySelector('.chip-text').textContent.trim();
      var rest = Array.prototype.map.call(
        chipsEl.querySelectorAll('.chip-text'),
        function (el) { return el.textContent.trim(); }
      ).filter(function (v) { return v !== clicked; });
      self._renderChips(rest);
    });
    return chip;
  };

  Card.prototype._renderChips = function (tags) {
    var chipsEl = this.chipsEl;
    chipsEl.innerHTML = '';
    tags.forEach(function (t) {
      chipsEl.appendChild(this._makeChip(t));
    }, this);
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
    var card = this;
    this.titleInput.value = result.book_title || '';
    this.updateTitleState();
    this.pageInput.value = result.page || '';
    if (result.author) {
      this.authorInput.value = result.author;
      this.authorWrap.hidden = false;
    }
    this._renderChips(Array.isArray(result.tags) ? result.tags : []);
    this.saveBtn.disabled = false;
    this.status('AI 分析完成，可以編輯', 'ok');
    /* 檢查書本庫：tag 一定要掛喺書本庫內嘅書；書名空／未喺書本庫就喺掣上面出提示 */
    var title = this.titleInput.value.trim();
    loadMeta(true).then(function (meta) {
      var inLib = meta.some(function (b) {
        return String(b.book_title || '').trim() === title;
      });
      card._inLibrary = inLib;
      if (!inLib) card.showLibText(title);
      else card.libText.hidden = true;
    });
  };

  /* 書名框狀態底色：空 → 紅底（必填），有字 → 綠底 */
  Card.prototype.updateTitleState = function () {
    var has = !!this.titleInput.value.trim();
    this.titleInput.classList.toggle('state-empty', !has);
    this.titleInput.classList.toggle('state-filled', has);
  };

  /* 書名空／未喺書本庫 → 喺三個掣上面出提示（掣本身任何時候都喺度） */
  Card.prototype.showLibText = function (title) {
    this.libText.innerHTML = title
      ? '⚠ 「<b>' + esc(title) + '</b>」未喺「書本庫」入面。新 tag 一定要掛喺書本庫內嘅書——可以喺下面揀書／揀相／拍照，或者直接打返書名（儲存嗰陣會問你確認加入書本庫）。'
      : '⚠ AI 冇喺相中搵到書名。新 tag 一定要掛喺書本庫內嘅書——可以喺下面揀書／揀相／拍照，或者直接打返書名（儲存嗰陣會問你確認加入書本庫）。';
    this.libText.hidden = false;
  };

  /* 打字時即時檢查：打咗個唔喺書本庫嘅書名 → 出提示；喺書本庫 → 收埋提示 */
  Card.prototype.checkLibraryHint = function () {
    var card = this;
    var title = this.titleInput.value.trim();
    if (!title) return;
    loadMeta().then(function (meta) {
      var inLib = meta.some(function (b) {
        return String(b.book_title || '').trim() === title;
      });
      if (inLib) card.libText.hidden = true;
      else card.showLibText(title);
    });
  };

  /* 藍圈：書名一路打一路 suggest 書本庫書名（唔一定要揀） */
  Card.prototype.updateSuggest = function () {
    var card = this;
    var q = this.titleInput.value.trim();
    var sEl = this.suggestEl;
    if (!q) { if (sEl) sEl.hidden = true; return; }
    loadMeta().then(function (meta) {
      if (!sEl || sEl.hidden === undefined) return;
      var ql = q.toLowerCase();
      var hits = meta.filter(function (b) {
        return String(b.book_title || '').toLowerCase().indexOf(ql) !== -1;
      }).slice(0, 6);
      if (!hits.length) { sEl.hidden = true; return; }
      sEl.innerHTML = '';
      hits.forEach(function (b) {
        var title = String(b.book_title || '');
        var author = String(b.author || '').trim();
        var i = title.toLowerCase().indexOf(ql);
        var html = '';
        if (i >= 0) {
          html = esc(title.slice(0, i)) + '<b>' + esc(title.slice(i, i + q.length)) + '</b>' + esc(title.slice(i + q.length));
        } else {
          html = esc(title);
        }
        var it = document.createElement('div');
        it.className = 'suggest-item';
        it.innerHTML = '<span class="suggest-title">' + html + '</span>' +
          (author ? '<span class="suggest-author">' + esc(author) + '</span>' : '');
        it.addEventListener('mousedown', function (e) { e.preventDefault(); card.applyLibraryBook(b); });
        it.addEventListener('touchstart', function (e) { e.preventDefault(); card.applyLibraryBook(b); }, { passive: false });
        sEl.appendChild(it);
      });
      sEl.hidden = false;
    });
  };

  /* 揀中書本庫嘅書 → 填入卡片 */
  Card.prototype.applyLibraryBook = function (b) {
    this.titleInput.value = String(b.book_title || '').trim();
    this.updateTitleState();
    this.titleErrorEl.hidden = true;
    this.titleInput.classList.remove('input-error');
    if (b.author) {
      this.authorInput.value = String(b.author || '').trim();
      this.authorWrap.hidden = false;
    }
    this.libText.hidden = true;
    if (this.suggestEl) this.suggestEl.hidden = true;
  };

  /* ---------- 「🗂️ 從書本庫中揀」modal：compact 表格＋filter ---------- */
  var pickModal = document.getElementById('pick-modal');
  var pickFilter = document.getElementById('pick-filter');
  var pickList = document.getElementById('pick-list');
  var pickCount = document.getElementById('pick-count');
  var pickCancel = document.getElementById('pick-cancel');
  var activePickCard = null;

  function renderPick() {
    var q = pickFilter.value.trim().toLowerCase();
    loadMeta().then(function (meta) {
      var rows = meta.filter(function (b) {
        if (!q) return true;
        return String(b.book_title || '').toLowerCase().indexOf(q) !== -1 ||
          String(b.author || '').toLowerCase().indexOf(q) !== -1;
      }).slice(0, 60);
      pickList.innerHTML = '';
      if (!rows.length) {
        pickList.innerHTML = '<tr><td colspan="2" class="empty">冇符合嘅書（或者書本庫仲未有書）。可以撳「取消」返去手動／影相。</td></tr>';
      }
      rows.forEach(function (b) {
        var tr = document.createElement('tr');
        tr.className = 'pick-row';
        var title = String(b.book_title || '');
        var author = String(b.author || '').trim();
        var html = q ? '<b>' + esc(title) + '</b>' : esc(title);
        tr.innerHTML = '<td>' + html + '</td><td class="pick-author">' + esc(author || '—') + '</td>';
        tr.addEventListener('click', function () {
          if (activePickCard) activePickCard.applyLibraryBook(b);
          closePickModal();
          toast('已揀：「' + title + '」', 'ok');
        });
        pickList.appendChild(tr);
      });
      pickCount.textContent = '顯示 ' + rows.length + ' / ' + meta.length + ' 本書';
    });
  }

  function openPickModal(card) {
    activePickCard = card;
    pickFilter.value = '';
    pickModal.hidden = false;
    renderPick();
    pickFilter.focus();
  }
  function closePickModal() {
    pickModal.hidden = true;
    activePickCard = null;
  }
  if (pickFilter) pickFilter.addEventListener('input', renderPick);
  if (pickCancel) pickCancel.addEventListener('click', closePickModal);

  /* ---------- 儲存時確認 modal：書本庫冇呢本書 → 問用戶要唔要加入 ---------- */
  var confirmModal = document.getElementById('confirm-modal');
  var confirmText = document.getElementById('confirm-text');
  var confirmOk = document.getElementById('confirm-ok');
  var confirmCancel = document.getElementById('confirm-cancel');
  function confirmAddBook(title) {
    return new Promise(function (resolve) {
      confirmText.innerHTML = '「<b>' + esc(title) + '</b>」未喺「書本庫」入面。<br>' +
        '要唔要將佢加入書本庫（作者可以之後喺「書本庫」頁補），再儲存呢張 tag？';
      confirmModal.hidden = false;
      confirmOk.onclick = function () { confirmModal.hidden = true; resolve(true); };
      confirmCancel.onclick = function () { confirmModal.hidden = true; resolve(false); };
    });
  }

  /* 揀相（capture=false）／拍照（capture=true）→ AI（直連）認書名＋作者 → 填入卡片 */
  Card.prototype.pickCoverPhoto = function (useCamera) {
    var card = this;
    if (!CB.getOrKey()) {
      toast('⚠ 需要「🚀 瀏覽器直連」（設定頁貼 OpenRouter Key）先可以 AI 認書名；唔想用 AI 就直接喺書名框打返書名', 'warn');
      return;
    }
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    if (useCamera) inp.setAttribute('capture', 'environment');
    inp.addEventListener('change', function () {
      var file = inp.files && inp.files[0];
      if (!file) return;
      card.analyzeCoverFile(file);
    });
    inp.click();
  };

  /* 封面相（揀相／拍照／貼上共用）→ AI 認書名＋作者 → 填入卡片 */
  Card.prototype.analyzeCoverFile = function (file) {
    var card = this;
    if (!file) return;
    if (!CB.getOrKey()) {
      toast('⚠ 需要「🚀 瀏覽器直連」（設定頁貼 OpenRouter Key）先可以 AI 認書名；唔想用 AI 就直接喺書名框打返書名', 'warn');
      return;
    }
    card.status('AI 認緊書名＋作者…（直連，幾秒）');
    CB.aiBusy('AI 認緊書名＋作者…');
    compressImage(file, { maxDim: 1920, maxB64: 800000 }).then(function (compressed) {
      return directAnalyze(compressed.dataUrl, BOOKS_SYSTEM_PROMPT, BOOKS_USER_PROMPT);
    }).then(function (res) {
      CB.aiReady();
      if (res.book_title) card.titleInput.value = res.book_title;
      card.updateTitleState();
      if (res.author) card.authorInput.value = res.author;
      card.authorWrap.hidden = false;
      card.libText.hidden = true;
      card.titleInput.classList.remove('input-error');
      card.titleErrorEl.hidden = true;
      card.status((res.book_title || res.author)
        ? '✓ AI 認完書名／作者，改完先撳儲存'
        : '⚠ AI 認唔到——可以自己打返書名，或者喺下面揀書／再揀相', res.book_title ? 'ok' : 'warn');
    }).catch(function (err) {
      CB.aiReady();
      card.status('✗ AI 認書名失敗：' + (err.message || err) + '（可以自己打返書名）', 'error');
      toast('AI 認書名失敗：' + (err.message || err), 'error');
    });
  };

  Card.prototype.showError = function (msg) {
    this.saveBtn.disabled = false;
    this.status('⚠ ' + msg, 'error');
  };

  Card.prototype.save = function () {
    var card = this;
    if (card._saved) return;
    var title = card.titleInput.value.trim();
    var page = card.pageInput.value.trim();
    var author = card.authorInput.value.trim();
    var tags = card.getTags();
    if (!title) {
      card.titleErrorEl.hidden = false;
      card.titleInput.classList.add('input-error');
      if (card.titleInput.scrollIntoView) {
        card.titleInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      toast('⚠ 書名係必填：請喺「書名」輸入框填返書名先至可以儲存', 'warn');
      return;
    }
    if (!tags.length) return toast('請至少保留一個標籤', 'warn');

    card.status('儲存緊…');
    card.saveBtn.disabled = true;
    /* 1) 檢查書本庫：書未喺書本庫 → 彈確認 popup（要唔要加入先儲存） */
    loadMeta(true).then(function (meta) {
      var idx = -1;
      meta.forEach(function (b, i) {
        if (String(b.book_title || '').trim() === title) idx = i;
      });
      if (idx >= 0) {
        if (author) meta[idx].author = author;
        return meta;
      }
      return confirmAddBook(title).then(function (ok) {
        if (!ok) return null;
        meta.push({ book_title: title, author: author });
        return meta;
      });
    }).then(function (meta) {
      if (!meta) throw { cancelled: true };
      /* 2) 寫入書本庫（upsert） */
      return CB.writeFile('data/books_meta.json',
        JSON.stringify(meta, null, 2) + '\n', '書本庫新增／更新：' + title)
        .then(function () { metaCache = null; return true; });
    }).then(function () {
      /* 3) 然後先至寫 tag 入 books.json */
      return CB.freshText('data/books.json').then(function (text) {
        var rows;
        try { rows = JSON.parse(text); } catch (e) { rows = []; }
        if (!Array.isArray(rows)) rows = [];
        var seen = {};
        rows.forEach(function (r) {
          seen[(r.book_title || '') + '\u0000' + (r.page || '') + '\u0000' + (r.tag || '')] = true;
        });
        tags.forEach(function (t) {
          var key = title + '\u0000' + page + '\u0000' + t;
          if (!seen[key]) { rows.push({ book_title: title, page: page, tag: t }); seen[key] = true; }
        });
        return rows;
      }).then(function (rows) {
        return CB.writeFile('data/books.json', JSON.stringify(rows, null, 2) + '\n', '新增書目：' + title);
      });
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
      if (err && err.cancelled) {
        card.status('未儲存——書本庫冇呢本書，已取消', 'warn');
        toast('已取消儲存（書本庫冇呢本書）', 'warn');
      } else {
        card.status('儲存失敗：' + err.message, 'error');
        toast('儲存失敗：' + err.message, 'error');
      }
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

  /* 手機相片：iOS 相機可能係 HEIC/HEIF，一啲 Android 揀檔器連 MIME type 都唔填（空字串）——
     唔可以淨係靠 f.type 過濾，否則揀完相「冇反應」 */
  function isImageFile(f) {
    if (f.type && f.type.indexOf('image/') === 0) return true;
    if (!f.type) return true; /* 空 MIME 照試，解碼失敗先至喺卡片度報錯 */
    return /\.(heic|heif|jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name || '');
  }

  function handleFiles(fileList) {
    var files = Array.prototype.filter.call(fileList, isImageFile);
    if (!files.length) {
      showBanner('⚠ 請揀相片檔案（HEIC／JPEG／PNG 都支援）', 'warn');
      return toast('請揀相片檔案', 'warn');
    }
    var pat = CB.getPat();
    var orKey = CB.getOrKey();
    var repoOk = true;
    try { CB.requireRepo(); } catch (e) { repoOk = false; }
    if (!pat && !orKey) {
      /* 最常見「揀完相冇反應」：手機 localStorage 係空（唔會同電腦同步） */
      showBanner(
        '🚫 未設定 GitHub Token：AI 分析同儲存都需要佢。<br>' +
        '請去 <a href="settings.html">⚙️ 設定</a> 貼你嘅 GitHub Token，或啟用「🚀 瀏覽器直連」貼 OpenRouter Key（幾秒出結果）。',
        'error');
      return toast('未設定 GitHub Token：去設定頁填入先', 'error');
    }
    if (!pat && orKey) {
      /* 直連模式：AI 分析唔使 PAT 照行，但儲存到 books.json 需要 PAT */
      showBanner(
        '⚠ 未有 GitHub Token：AI 分析會用「🚀 瀏覽器直連」照行，但<b>儲存到 books.json 需要 Token</b>——' +
        '請去 <a href="settings.html">⚙️ 設定</a> 補填，分析完先至撳「儲存」。', 'warn');
    } else if (!repoOk) {
      showBanner('⚠ 未有 GitHub Owner / Repo：請去 <a href="settings.html">⚙️ 設定</a> 填返（GitHub Pages 打開會自動偵測）。', 'warn');
    } else {
      clearBanner();
    }

    var chain = Promise.resolve();
    CB.aiBusy(files.length > 1 ? ('AI 分析緊 ' + files.length + ' 張相…') : 'AI 分析緊…');
    files.forEach(function (file) {
      chain = chain.then(function () {
        var id = (crypto.randomUUID ? crypto.randomUUID()
          : 'cb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
        var card = new Card(file, id);
        queue.insertBefore(card.el, queue.firstChild);
        var isDirect = !!CB.getOrKey();
        /* 直連模式可以送大圖（豎排細字更清晰）；後備模式受 GitHub dispatch 65535 限制要壓細 */
        var copts = isDirect ? { maxDim: 1920, maxB64: 800000 } : { maxDim: 1280, maxB64: MAX_B64_LEN };
        var maxOk = isDirect ? 800000 + 50000 : MAX_B64_LEN + 50000;
        return compressImage(file, copts).then(function (compressed) {
          if (compressed.base64.length > maxOk) {
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

    /* 成個分析 chain 完晒先收起遮罩（多張相順序分析都 cover） */
    chain.then(function () { CB.aiReady(); }, function () { CB.aiReady(); });
  }

  window.handleFiles = handleFiles;
  window.Card = Card; /* 測試用 expose（正式版亦無害） */
})();

window.__CB_UPLOAD_LOADED = true; /* 畀 index.html 嘅載入檢查用 */
