/* ============================================================
   CatBookmark — 上傳頁：揀相 → 壓縮 → dispatch GitHub Actions
   → 輪詢 AI 結果 → 可編輯標籤 → 儲存入 books.json
   ============================================================ */
(function () {
  'use strict';

  var MAX_DIM = 1280;        /* 壓縮後最長邊 */
  var JPEG_QUALITY = 0.78;
  var MAX_B64_LEN = 750000;  /* 超過就再縮細（workflow input 體積控制） */
  var POLL_INTERVAL = 4000;  /* ms */
  var POLL_MAX = 60;         /* 約 4 分鐘 */

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
    return canvas.toDataURL('image/jpeg', quality);
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
        var dataUrl = render(source, w, h, JPEG_QUALITY);
        var base64 = dataUrl.split(',')[1];
        if (base64.length > MAX_B64_LEN) {
          var s2 = Math.sqrt(MAX_B64_LEN / base64.length);
          dataUrl = render(source,
            Math.max(1, Math.round(w * s2)),
            Math.max(1, Math.round(h * s2)), 0.7);
          base64 = dataUrl.split(',')[1];
        }
        return { base64: base64, dataUrl: dataUrl };
      } finally {
        if (isBitmap) source.close();
      }
    });
  }

  /* ---------- 輪詢 pending 結果檔 ---------- */
  function pollPending(id) {
    var attempts = 0;
    function tick() {
      attempts += 1;
      return CB.rawText('data/pending/' + id + '.json').then(function (text) {
        return JSON.parse(text);
      }).catch(function () {
        if (attempts >= POLL_MAX) {
          throw new Error('分析逾時（約 4 分鐘）。請到 GitHub > Actions 睇下 run 狀態。');
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
    CB.deleteFile('data/pending/' + card.id + '.json').catch(function () { return null; }).then(function () {
      card.remove();
    });
  };

  Card.prototype.remove = function () {
    if (this._previewUrl) URL.revokeObjectURL(this._previewUrl);
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  };

  /* ---------- 主流程 ---------- */
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
          card.status('AI 分析緊…');
          return CB.dispatchWorkflow('analyze.yml', {
            image_base64: compressed.base64,
            image_id: id
          });
        }).then(function () {
          card.status('等緊分析結果…');
          return pollPending(id);
        }).then(function (result) {
          if (result && result.error) card.showError(result.error);
          else card.setResult(result || { book_title: '', tags: [] });
        }).catch(function (err) {
          card.showError(err.message || '分析失敗');
        });
      });
    });
  }

  window.handleFiles = handleFiles;
})();
