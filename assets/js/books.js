/* ============================================================
   CatBookmark — 書本庫（books_meta.json）
   顯示／編輯「書名＋作者」；sort by 書名；頂部 filter 書名/作者
   頂頭按鈕：影相／揀相 → AI（瀏覽器直連 OpenRouter）認書名＋作者
   → modal 編輯／確認 → 儲存。相片唔會離開瀏覽器。
   ============================================================ */
(function () {
  'use strict';

  var META = 'data/books_meta.json';
  var allBooks = [];   /* [{book_title, author}] */

  /* ---------- AI：認書名＋作者（書本庫用） ---------- */
  var BOOKS_SYSTEM_PROMPT =
    '你係一個協助整理書目資料嘅助手。用戶影咗一本書嘅相片（通常係封面、書脊或版權頁，亦可能係內頁）。\n' +
    '請認出兩樣嘢：\n' +
    '1. 書名：書上印嘅書名（封面最突出嘅標題，或者版權頁嘅書名）。認唔到就寫空字串，唔好亂估。\n' +
    '2. 作者：書上印嘅作者名（通常喺「著／作者／撰／by」附近，或者封面署名）。認唔到就寫空字串，唔好亂估。\n' +
    '只可以輸出一個 JSON 物件，格式嚴格如下：\n' +
    '{"book_title": "書名", "author": "作者"}\n' +
    '書名或作者認唔到就寫空字串。唔好輸出任何其他文字、解釋或者 markdown 標記。';
  var BOOKS_USER_PROMPT = '請睇吓呢張相：認出書名同作者（認唔到就留空）。';

  var MAX_DIM = 1280;
  var WEBP_QUALITY = 0.75;
  var JPEG_QUALITY = 0.78;
  var IMG_FORMAT = null;

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

  function makeBitmap(file) {
    return new Promise(function (resolve, reject) {
      var p = null;
      try { p = createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (e) { p = null; }
      if (p) { p.then(resolve, function () { loadImage(file).then(resolve, reject); }); }
      else { loadImage(file).then(resolve, reject); }
    });
  }

  function compressImage(file) {
    return Promise.resolve().then(function () {
      return makeBitmap(file);
    }).then(function (source) {
      var isBitmap = !!(source && source.close);
      try {
        var scale = Math.min(1, MAX_DIM / Math.max(source.width, source.height));
        var w = Math.max(1, Math.round(source.width * scale));
        var h = Math.max(1, Math.round(source.height * scale));
        var quality = pickFormat() === 'webp' ? WEBP_QUALITY : JPEG_QUALITY;
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(source, 0, 0, w, h);
        return { dataUrl: c.toDataURL('image/' + pickFormat(), quality), w: w, h: h };
      } finally {
        if (isBitmap) source.close();
      }
    });
  }

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

  function directAnalyzeBooks(dataUrl) {
    var cfg = CB.getAiCache();
    var key = CB.getOrKey();
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
          { role: 'system', content: BOOKS_SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: BOOKS_USER_PROMPT }
          ]}
        ],
        temperature: 0.1,
        max_tokens: 300
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
        return {
          book_title: String(parsed.book_title || '').trim(),
          author: String(parsed.author || '').trim()
        };
      });
    });
  }

  /* ---------- DOM ---------- */
  var tbody = document.getElementById('book-list');
  var titleFilter = document.getElementById('filter-title');
  var authorFilter = document.getElementById('filter-author');
  var titleList = document.getElementById('title-list');
  var authorList = document.getElementById('author-list');
  var countEl = document.getElementById('filter-count');
  var clearBtn = document.getElementById('filter-clear');
  var loadBtn = document.getElementById('reload');
  var photoInput = document.getElementById('book-photo');
  var cameraInput = document.getElementById('book-camera');
  var manualBtn = document.getElementById('book-manual');

  var modal = document.getElementById('book-modal');
  var modalTitleEl = document.getElementById('modal-title');
  var modalPreview = document.getElementById('modal-preview');
  var modalStatus = document.getElementById('modal-status');
  var modalBookTitle = document.getElementById('modal-book-title');
  var modalBookAuthor = document.getElementById('modal-book-author');
  var modalTitleError = document.getElementById('modal-title-error');
  var modalSave = document.getElementById('modal-save');
  var modalCancel = document.getElementById('modal-cancel');

  titleFilter.addEventListener('input', render);
  authorFilter.addEventListener('input', render);
  clearBtn.addEventListener('click', function () {
    titleFilter.value = '';
    authorFilter.value = '';
    render();
  });
  if (loadBtn) loadBtn.addEventListener('click', load);
  if (manualBtn) manualBtn.addEventListener('click', function () { openModal(null); });

  photoInput.addEventListener('change', function () {
    if (photoInput.files.length) handlePhotoFile(photoInput.files[0]);
    photoInput.value = '';
  });
  cameraInput.addEventListener('change', function () {
    if (cameraInput.files.length) handlePhotoFile(cameraInput.files[0]);
    cameraInput.value = '';
  });
  modalCancel.addEventListener('click', closeModal);
  modalBookTitle.addEventListener('input', function () {
    modalTitleError.hidden = true;
    modalBookTitle.classList.remove('input-error');
  });
  modalSave.addEventListener('click', saveModal);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escReg(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function hl(text, q) {
    var s = esc(text);
    if (!q) return s;
    try {
      var re = new RegExp('(' + escReg(esc(q)) + ')', 'gi');
      return s.replace(re, '<mark>$1</mark>');
    } catch (e) { return s; }
  }

  /* ---------- 讀／寫 ---------- */
  function load() {
    return CB.freshText(META).then(function (text) {
      allBooks = JSON.parse(text);
      if (!Array.isArray(allBooks)) allBooks = [];
    }).catch(function (err) {
      allBooks = [];
      if (!CB.getPat()) toast('未設定 GitHub Token：去「設定」頁填返先睇到資料', 'warn');
      else toast('讀唔到 ' + META + '：' + err.message, 'error');
    }).then(function () {
      render();
    });
  }

  function saveAll(books) {
    return CB.writeFile(META, JSON.stringify(books, null, 2) + '\n', '更新書本庫')
      .then(function () {
        toast('已儲存 ✓', 'ok');
        return load();
      })
      .catch(function (err) {
        toast('儲存失敗：' + err.message, 'error');
      });
  }

  /* upsert：book_title 一樣就更新 author，唔一樣就加新行 */
  function upsert(books, title, author) {
    var idx = -1;
    books.forEach(function (b, i) {
      if (String(b.book_title || '').trim() === title) idx = i;
    });
    if (idx >= 0) { books[idx].author = author; return books; }
    books.push({ book_title: title, author: author });
    return books;
  }

  /* ---------- 排序／篩選／渲染 ---------- */
  function sorted() {
    return allBooks.slice().sort(function (a, b) {
      return String(a.book_title || '').localeCompare(String(b.book_title || ''), 'zh-Hant');
    });
  }

  function filtered(rows) {
    var qt = titleFilter.value.trim();
    var qa = authorFilter.value.trim();
    return rows.filter(function (r) {
      return (!qt || String(r.book_title || '').indexOf(qt) !== -1) &&
        (!qa || String(r.author || '').indexOf(qa) !== -1);
    });
  }

  function render() {
    var rows = filtered(sorted());

    var titleSet = {}, authorSet = {};
    allBooks.forEach(function (b) {
      titleSet[String(b.book_title || '').trim()] = true;
      var a = String(b.author || '').trim();
      if (a) authorSet[a] = true;
    });
    var allTitles = Object.keys(titleSet).filter(Boolean).sort(function (a, b) { return a.localeCompare(b, 'zh-Hant'); });
    var allAuthors = Object.keys(authorSet).filter(Boolean).sort(function (a, b) { return a.localeCompare(b, 'zh-Hant'); });
    titleList.innerHTML = allTitles.map(function (t) { return '<option value="' + esc(t) + '">'; }).join('');
    authorList.innerHTML = allAuthors.map(function (a) { return '<option value="' + esc(a) + '">'; }).join('');

    countEl.textContent = '顯示 ' + rows.length + ' / ' + allBooks.length + ' 本書';

    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty">冇符合嘅書本。可以用上面「📸 影相／揀相，AI 認書名＋作者」或者「✍️ 手動新增」。</td></tr>';
      return;
    }
    rows.forEach(function (b) { tbody.appendChild(renderRow(b)); });
  }

  function renderRow(b) {
    var tr = document.createElement('tr');
    tr.className = 'book-row';
    tr.innerHTML =
      '<td class="cell-title">' + hl(b.book_title || '', titleFilter.value.trim()) + '</td>' +
      '<td class="cell-author">' + hl(b.author || '—', authorFilter.value.trim()) + '</td>' +
      '<td class="cell-actions">' +
      '  <button class="btn btn-small" data-role="edit" type="button">編輯</button>' +
      '  <button class="btn btn-small btn-danger-ghost" data-role="del" type="button">刪除</button>' +
      '</td>';

    tr.querySelector('[data-role="edit"]').addEventListener('click', function () {
      editRow(tr, b);
    });
    tr.querySelector('[data-role="del"]').addEventListener('click', function () {
      if (!window.confirm('刪除「' + b.book_title + '」？\n（注意：書目庫入面已儲存嘅 tag 唔會刪走，但新 tag 唔可以再掛喺呢本書。）')) return;
      saveAll(allBooks.filter(function (x) {
        return String(x.book_title || '').trim() !== String(b.book_title || '').trim();
      }));
    });
    return tr;
  }

  function editRow(tr, b) {
    tr.innerHTML =
      '<td class="cell-title"><input class="row-input" data-role="title" type="text" value="' + esc(b.book_title || '') + '" autocomplete="off"></td>' +
      '<td class="cell-author"><input class="row-input" data-role="author" type="text" value="' + esc(b.author || '') + '" placeholder="作者（可選）" autocomplete="off"></td>' +
      '<td class="cell-actions">' +
      '  <button class="btn btn-small btn-primary" data-role="save" type="button">儲存變更</button>' +
      '  <button class="btn btn-small btn-ghost" data-role="cancel" type="button">取消</button>' +
      '</td>';

    tr.querySelector('[data-role="cancel"]').addEventListener('click', function () { render(); });
    tr.querySelector('[data-role="save"]').addEventListener('click', function () {
      var newTitle = tr.querySelector('[data-role="title"]').value.trim();
      var newAuthor = tr.querySelector('[data-role="author"]').value.trim();
      if (!newTitle) return toast('書名不可為空', 'warn');
      saveAll(upsert(allBooks.filter(function (x) {
        return String(x.book_title || '').trim() !== String(b.book_title || '').trim();
      }), newTitle, newAuthor));
    });
  }

  /* ---------- modal：新增／編輯書本 ---------- */
  function openModal(data) {
    modalTitleEl.textContent = (data && data.book_title) ? '📚 編輯書本' : '📚 新增書本';
    modalBookTitle.value = (data && data.book_title) || '';
    modalBookAuthor.value = (data && data.author) || '';
    modalTitleError.hidden = true;
    modalBookTitle.classList.remove('input-error');
    modalStatus.textContent = '';
    modalStatus.className = 'modal-status';
    modalPreview.innerHTML = '';
    modal.hidden = false;
    modalBookTitle.focus();
  }

  function closeModal() {
    modal.hidden = true;
    modalPreview.innerHTML = '';
  }

  function saveModal() {
    var title = modalBookTitle.value.trim();
    var author = modalBookAuthor.value.trim();
    if (!title) {
      modalTitleError.hidden = false;
      modalBookTitle.classList.add('input-error');
      return toast('⚠ 書名係必填', 'warn');
    }
    modalSave.disabled = true;
    CB.freshText(META).then(function (text) {
      var books = [];
      try { books = JSON.parse(text); } catch (e) { books = []; }
      if (!Array.isArray(books)) books = [];
      return upsert(books, title, author);
    }).then(function (books) {
      return CB.writeFile(META, JSON.stringify(books, null, 2) + '\n', '書本庫新增／更新：' + title);
    }).then(function () {
      modalSave.disabled = false;
      closeModal();
      toast('已儲存到書本庫 ✓', 'ok');
      return load();
    }).catch(function (err) {
      modalSave.disabled = false;
      modalStatus.className = 'modal-status error';
      modalStatus.textContent = '✗ 儲存失敗：' + err.message;
      toast('儲存失敗：' + err.message, 'error');
    });
  }

  /* ---------- 影相／揀相 → AI 認書名＋作者 ---------- */
  function handlePhotoFile(file) {
    if (!file) return;
    if (file.type && file.type.indexOf('image/') !== 0 && !/\.(heic|heif|jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name || '')) {
      return toast('請揀相片檔案', 'warn');
    }
    if (!CB.getOrKey()) {
      openModal(null);
      modalStatus.className = 'modal-status warn';
      modalStatus.textContent = '⚠ 未啟用「🚀 瀏覽器直連」（設定頁貼 OpenRouter Key）——AI 認書名作者要直連先得。你可以照手動打字。';
      return;
    }
    openModal(null);
    modalStatus.className = 'modal-status';
    modalStatus.textContent = 'AI 認緊書名＋作者…（幾秒，相片唔會上傳／儲存）';
    var img = document.createElement('img');
    var url = URL.createObjectURL(file);
    img.src = url;
    img.alt = '書本相片預覽';
    modalPreview.innerHTML = '';
    modalPreview.appendChild(img);
    compressImage(file).then(function (compressed) {
      return directAnalyzeBooks(compressed.dataUrl);
    }).then(function (res) {
      if (res.book_title) modalBookTitle.value = res.book_title;
      if (res.author) modalBookAuthor.value = res.author;
      modalStatus.className = 'modal-status ok';
      modalStatus.textContent = (res.book_title || res.author)
        ? '✓ AI 認完，可以改完先撳「儲存」。'
        : '⚠ AI 認唔到書名／作者——可以自己打字，或者換張清啲嘅封面相再試。';
    }).catch(function (err) {
      modalStatus.className = 'modal-status error';
      modalStatus.textContent = '✗ AI 認唔到：' + (err.message || err) + '——你可以照手動打字，或者喺設定頁檢查直連 Key／Model。';
      toast('AI 認書名失敗：' + (err.message || err), 'error');
    }).then(function () {
      /* 保持 URL 直到 modal 關閉；關閉時清 */
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    });
  }

  load();
})();
