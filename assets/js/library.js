/* ============================================================
   CatBookmark — 書目庫：表格形式檢視／編輯 books.json，
   頂部篩選（可揀或手動輸入現存書名／標籤）
   表格 column：書名 | tag | 頁數 | 操作；sort by 書名，然後頁數
   編輯書目用 modal：書名支援 suggest／揀書／揀相／拍照（同「上傳」一致），
   儲存時如果書名未喺書本庫會問要唔要加入書本庫
   ============================================================ */
(function () {
  'use strict';

  var allRows = [];   /* [{book_title, tag, page}] */
  var titleOptions = [];  /* 現存書名（suggest 用） */
  var tagOptions = [];    /* 現存標籤（suggest 用） */

  var titleFilter = document.getElementById('filter-title');
  var tagFilter = document.getElementById('filter-tag');
  var suggestTitleEl = document.getElementById('suggest-title');
  var suggestTagEl = document.getElementById('suggest-tag');
  var tbody = document.getElementById('book-list');
  var countEl = document.getElementById('filter-count');
  var clearBtn = document.getElementById('filter-clear');
  var loadBtn = document.getElementById('reload');
  var exportBtn = document.getElementById('export-csv');

  /* ---------- 書本庫 meta 快取（suggest／揀書 modal／儲存確認用） ---------- */
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
  function escReg(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  /* 將命中嘅 filter 文字包 <mark>（先 escape HTML，再對返命中字） */
  function hl(text, q) {
    var s = esc(text);
    if (!q) return s;
    try {
      var re = new RegExp('(' + escReg(esc(q)) + ')', 'gi');
      return s.replace(re, '<mark>$1</mark>');
    } catch (e) { return s; }
  }

  /* ---------- 直連 OpenRouter：AI 認書名＋作者（同 upload.js 一致） ---------- */
  var BOOKS_SYSTEM_PROMPT =
    'You are an assistant that helps organize book catalog data. The user photographed a book (usually the cover, spine, or copyright page, sometimes an inner page).\n' +
    'Please identify two things:\n' +
    '1. Book title: the title printed on the book (the most prominent title on the cover, or the title on the copyright page). If you cannot identify it, write an empty string — do not guess.\n' +
    '2. Author: the author name printed on the book (usually near "著/作者/撰/by", or the signature on the cover). If you cannot identify it, write an empty string — do not guess.\n' +
    'Output ONLY one JSON object in exactly this format:\n' +
    '{"book_title": "書名", "author": "作者"}\n' +
    'Write an empty string if the title or author cannot be identified. Do not output any other text, explanation, or markdown formatting.';
  var BOOKS_USER_PROMPT = 'Look at this photo and identify the book title and author (leave empty if you cannot identify them).';

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

  /* 簡化壓縮（AI 直連冇 65K 限制，縮到 1280 就夠） */
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, 1280 / Math.max(img.width, img.height));
          var w = Math.max(2, Math.round(img.width * scale));
          var h = Math.max(2, Math.round(img.height * scale));
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          resolve({ dataUrl: c.toDataURL('image/jpeg', 0.8) });
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('圖片解碼失敗')); };
      img.src = url;
    });
  }

  /* ---------- 編輯書目 modal（書名功能同「上傳」一致） ---------- */
  var editModal = document.getElementById('lib-edit-modal');
  var libTitle = document.getElementById('lib-title');
  var libTag = document.getElementById('lib-tag');
  var libPage = document.getElementById('lib-page');
  var libSuggest = document.getElementById('lib-suggest');
  var libHint = document.getElementById('lib-hint');
  var libStatus = document.getElementById('lib-modal-status');
  var libSave = document.getElementById('lib-save');
  var libCancel = document.getElementById('lib-cancel');
  var libPickBtn = document.getElementById('lib-pick');
  var libPhoto = document.getElementById('lib-photo');
  var libCamera = document.getElementById('lib-camera');
  var editingRow = null;   /* 而家編輯緊嘅 row */
  var aiAuthor = '';       /* AI 認到嘅作者（加入書本庫嗰陣用） */

  function modalStatus(msg, type) {
    libStatus.textContent = msg || '';
    libStatus.className = 'modal-status' + (type ? ' ' + type : '');
  }

  /* 書名框：空 → 紅底，有字 → 綠底 */
  function updateTitleState() {
    var has = !!libTitle.value.trim();
    libTitle.classList.toggle('state-empty', !has);
    libTitle.classList.toggle('state-filled', has);
  }

  /* 一路打一路 suggest 書本庫書名（最多 6 條，同「上傳」一致） */
  function updateSuggest() {
    var q = libTitle.value.trim();
    libSuggest.innerHTML = '';
    if (!q) { libSuggest.hidden = true; return; }
    loadMeta().then(function (meta) {
      var ql = q.toLowerCase();
      var hits = meta.filter(function (b) {
        return String(b.book_title || '').toLowerCase().indexOf(ql) !== -1;
      }).slice(0, 6);
      if (!hits.length) { libSuggest.hidden = true; return; }
      hits.forEach(function (b) {
        var t = String(b.book_title || '');
        var i = t.toLowerCase().indexOf(ql);
        var html = '';
        if (i >= 0) {
          html = esc(t.slice(0, i)) + '<b>' + esc(t.slice(i, i + q.length)) + '</b>' + esc(t.slice(i + q.length));
        } else {
          html = esc(t);
        }
        var author = String(b.author || '').trim();
        var it = document.createElement('div');
        it.className = 'suggest-item';
        it.innerHTML = '<span class="suggest-title">' + html + '</span>' +
          (author ? '<span class="suggest-author">' + esc(author) + '</span>' : '');
        it.addEventListener('mousedown', function (e) { e.preventDefault(); applyLibraryBook(b); });
        it.addEventListener('touchstart', function (e) { e.preventDefault(); applyLibraryBook(b); }, { passive: false });
        libSuggest.appendChild(it);
      });
      libSuggest.hidden = false;
    });
  }

  /* 揀咗書本庫嘅書 → 填書名（書本庫一定有呢本書 → 唔使再確認加入） */
  function applyLibraryBook(b) {
    var t = String(b.book_title || '').trim();
    if (!t) return;
    libTitle.value = t;
    aiAuthor = '';
    updateTitleState();
    updateSuggest();
    checkLibraryHint();
    libTitle.classList.remove('input-error');
    modalStatus('✓ 已揀書本庫嘅書：「' + t + '」', 'ok');
  }

  /* 書名空／未喺書本庫 → 提示（三個掣常駐喺書名下面） */
  function checkLibraryHint() {
    var t = libTitle.value.trim();
    if (!t) { libHint.hidden = true; return; }
    loadMeta().then(function (meta) {
      var found = false;
      meta.forEach(function (b) {
        if (String(b.book_title || '').trim() === t) found = true;
      });
      if (found) {
        libHint.hidden = true;
      } else {
        libHint.hidden = false;
        libHint.innerHTML = '⚠️「<b>' + esc(t) + '</b>」未喺「書本庫」入面。新 tag 一定要掛喺書本庫內嘅書——可以喺下面揀書 / 揀相 / 拍照，或者直接打返書名（儲存嗰陣會問你確認加入書本庫）。';
      }
    });
  }

  function openEditModal(row) {
    editingRow = row;
    aiAuthor = '';
    libTitle.value = String(row.book_title || '');
    libTag.value = String(row.tag || '');
    libPage.value = String(row.page || '');
    modalStatus('');
    updateTitleState();
    libSuggest.hidden = true;
    libHint.hidden = true;
    checkLibraryHint();
    editModal.hidden = false;
    libTitle.focus();
    libTitle.setSelectionRange(libTitle.value.length, libTitle.value.length);
  }
  function closeEditModal() {
    editModal.hidden = true;
    editingRow = null;
    aiAuthor = '';
  }

  /* 揀相／拍照 → AI 認書名＋作者 → 填入 */
  function handleLibPhoto(file) {
    if (!file) return;
    if (!CB.getOrKey()) {
      toast('⚠ 需要「🚀 瀏覽器直連」（設定頁貼 OpenRouter Key）先可以 AI 認書名；唔想用 AI 就直接打返書名', 'warn');
      return;
    }
    modalStatus('AI 認緊書名＋作者…（直連，幾秒）');
    compressImage(file).then(function (compressed) {
      return directAnalyze(compressed.dataUrl);
    }).then(function (res) {
      if (res.book_title) {
        libTitle.value = res.book_title;
        aiAuthor = res.author;
      }
      updateTitleState();
      updateSuggest();
      checkLibraryHint();
      modalStatus(res.book_title
        ? '✓ AI 認完：「' + res.book_title + '」' + (res.author ? '（' + res.author + '）' : '') + '，改完先撳儲存'
        : '⚠ AI 認唔到——可以自己打返書名，或者喺下面揀書／再揀相', res.book_title ? 'ok' : 'warn');
    }).catch(function (err) {
      modalStatus('✗ AI 認書名失敗：' + (err.message || err) + '（可以自己打返書名）', 'error');
      toast('AI 認書名失敗：' + (err.message || err), 'error');
    });
  }

  /* ---------- 「🗂️ 從書本庫中揀書」modal ---------- */
  var pickModal = document.getElementById('pick-modal');
  var pickFilter = document.getElementById('pick-filter');
  var pickList = document.getElementById('pick-list');
  var pickCount = document.getElementById('pick-count');
  var pickCancel = document.getElementById('pick-cancel');

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
          applyLibraryBook(b);
          closePickModal();
          toast('已揀：「' + title + '」', 'ok');
        });
        pickList.appendChild(tr);
      });
      pickCount.textContent = '顯示 ' + rows.length + ' / ' + meta.length + ' 本書';
    });
  }
  function openPickModal() {
    pickFilter.value = '';
    pickModal.hidden = false;
    renderPick();
    pickFilter.focus();
  }
  function closePickModal() {
    pickModal.hidden = true;
  }
  if (pickFilter) pickFilter.addEventListener('input', renderPick);
  if (pickCancel) pickCancel.addEventListener('click', closePickModal);

  /* ---------- 儲存時確認：書本庫冇呢本書 → 問要唔要加入 ---------- */
  var confirmModal = document.getElementById('confirm-modal');
  var confirmText = document.getElementById('confirm-text');
  var confirmOk = document.getElementById('confirm-ok');
  var confirmCancel = document.getElementById('confirm-cancel');
  function confirmAddBook(title) {
    return new Promise(function (resolve) {
      confirmText.innerHTML = '「<b>' + esc(title) + '</b>」未喺「書本庫」入面。<br>' +
        '要唔要將佢加入書本庫（作者可以之後喺「書本庫」頁補），再儲存呢條書目？';
      confirmModal.hidden = false;
      confirmOk.onclick = function () { confirmModal.hidden = true; resolve(true); };
      confirmCancel.onclick = function () { confirmModal.hidden = true; resolve(false); };
    });
  }

  /* ---------- 儲存（modal） ---------- */
  libSave.addEventListener('click', function () {
    var newTitle = libTitle.value.trim();
    var newTag = libTag.value.trim().replace(/^#+/, '').trim();
    var newPage = libPage.value.trim();
    if (!newTitle) {
      modalStatus('⚠ 書名係必填', 'error');
      toast('書名不可為空', 'warn');
      libTitle.focus();
      return;
    }
    if (!newTag) return toast('tag 不可為空', 'warn');
    modalStatus('儲存緊…');
    libSave.disabled = true;
    /* 1) 檢查書本庫：書未喺書本庫 → 彈確認（要唔要加入先儲存） */
    loadMeta(true).then(function (meta) {
      var idx = -1;
      meta.forEach(function (b, i) {
        if (String(b.book_title || '').trim() === newTitle) idx = i;
      });
      if (idx >= 0) return meta;
      return confirmAddBook(newTitle).then(function (ok) {
        if (!ok) return null;
        meta.push({ book_title: newTitle, author: aiAuthor });
        return meta;
      });
    }).then(function (meta) {
      if (!meta) throw { cancelled: true };
      /* 2) 寫入書本庫（upsert） */
      return CB.writeFile('data/books_meta.json',
        JSON.stringify(meta, null, 2) + '\n', '書本庫新增：' + newTitle)
        .then(function () { metaCache = null; });
    }).then(function () {
      /* 3) 更新 books.json 呢條 tag */
      var rest = allRows.filter(function (r) {
        return !(String(r.book_title || '') === String(editingRow.book_title || '') &&
                 String(r.tag || '') === String(editingRow.tag || '') &&
                 String(r.page || '') === String(editingRow.page || ''));
      });
      var seen = {};
      rest.forEach(function (r) {
        seen[String(r.book_title || '') + '\u0000' + String(r.page || '') + '\u0000' + String(r.tag || '')] = true;
      });
      var key = newTitle + '\u0000' + newPage + '\u0000' + newTag;
      if (seen[key]) { throw { duplicate: true }; }
      rest.push({ book_title: newTitle, page: newPage, tag: newTag });
      return CB.writeFile('data/books.json', JSON.stringify(rest, null, 2) + '\n', '更新書目庫');
    }).then(function () {
      toast('已儲存 ✓', 'ok');
      return load();
    }).then(function () {
      closeEditModal();
    }).catch(function (err) {
      libSave.disabled = false;
      if (err && err.cancelled) {
        modalStatus('未儲存——書本庫冇呢本書，已取消', 'warn');
        toast('已取消儲存（書本庫冇呢本書）', 'warn');
      } else if (err && err.duplicate) {
        modalStatus('呢條記錄已存在', 'warn');
        toast('呢條記錄已存在', 'warn');
      } else {
        modalStatus('儲存失敗：' + (err && err.message ? err.message : err), 'error');
        toast('儲存失敗：' + (err && err.message ? err.message : err), 'error');
      }
    });
  });
  libCancel.addEventListener('click', closeEditModal);

  /* ---------- 書名 input 事件 ---------- */
  libTitle.addEventListener('input', function () {
    updateTitleState();
    updateSuggest();
    checkLibraryHint();
  });
  if (libPickBtn) libPickBtn.addEventListener('click', openPickModal);
  if (libPhoto) libPhoto.addEventListener('change', function () { handleLibPhoto(libPhoto.files && libPhoto.files[0]); });
  if (libCamera) libCamera.addEventListener('change', function () { handleLibPhoto(libCamera.files && libCamera.files[0]); });

  /* 📋 貼上圖片：Clipboard API（HTTPS／localhost）→ 同一條 AI 認書名流程 */
  var libClipboard = document.getElementById('lib-clipboard');
  if (libClipboard) {
    libClipboard.addEventListener('click', function () {
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
          handleLibPhoto(f);
        });
      }).catch(function (err) {
        toast(err && err.message ? err.message : ('讀剪貼簿失敗：' + err), 'warn');
      });
    });
  }

  /* ---------- 頂部 filter ---------- */
  titleFilter.addEventListener('focus', function () { showSuggestions('title', titleFilter.value); });
  tagFilter.addEventListener('focus', function () { showSuggestions('tag', tagFilter.value); });
  titleFilter.addEventListener('input', function () {
    render();
    showSuggestions('title', titleFilter.value);
  });
  tagFilter.addEventListener('input', function () {
    render();
    showSuggestions('tag', tagFilter.value);
  });
  titleFilter.addEventListener('blur', function () { setTimeout(function () { suggestTitleEl.hidden = true; }, 150); });
  tagFilter.addEventListener('blur', function () { setTimeout(function () { suggestTagEl.hidden = true; }, 150); });
  clearBtn.addEventListener('click', function () {
    titleFilter.value = '';
    tagFilter.value = '';
    render();
  });
  if (loadBtn) loadBtn.addEventListener('click', load);
  if (exportBtn) exportBtn.addEventListener('click', exportCsv);

  /* suggest：揀現存書名／標籤，或者一路打字即時篩選 */
  function showSuggestions(kind, q) {
    var box = kind === 'title' ? suggestTitleEl : suggestTagEl;
    var options = kind === 'title' ? titleOptions : tagOptions;
    if (!q) { box.innerHTML = ''; box.hidden = true; return; }
    var ql = q.toLowerCase();
    var hits = options.filter(function (v) {
      return String(v).toLowerCase().indexOf(ql) !== -1;
    }).slice(0, 8);
    box.innerHTML = '';
    if (!hits.length) { box.hidden = true; return; }
    hits.forEach(function (v) {
      var i = String(v).toLowerCase().indexOf(ql);
      var html = '';
      if (i >= 0) {
        html = esc(v.slice(0, i)) + '<b>' + esc(v.slice(i, i + q.length)) + '</b>' + esc(v.slice(i + q.length));
      } else {
        html = esc(v);
      }
      var it = document.createElement('div');
      it.className = 'suggest-item';
      it.innerHTML = '<span class="suggest-title">' + html + '</span>';
      it.addEventListener('mousedown', function (e) { e.preventDefault(); applySuggestion(kind, v); });
      it.addEventListener('touchstart', function (e) { e.preventDefault(); applySuggestion(kind, v); }, { passive: false });
      box.appendChild(it);
    });
    box.hidden = false;
  }

  function applySuggestion(kind, v) {
    if (kind === 'title') {
      titleFilter.value = v;
      suggestTitleEl.hidden = true;
    } else {
      tagFilter.value = v;
      suggestTagEl.hidden = true;
    }
    render();
  }

  /* ---------- 匯出 CSV ---------- */
  function exportCsv() {
    var rows = filtered(sorted());
    if (!rows.length) return toast('冇資料可匯出', 'warn');
    var lines = [['書名', 'tag', '頁數'].join(',')];
    rows.forEach(function (r) {
      var cells = [r.book_title || '', r.tag || '', r.page || ''].map(function (v) {
        v = String(v);
        if (/[",\n\r]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
        return v;
      });
      lines.push(cells.join(','));
    });
    var now = new Date();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var stamp = now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) +
      '_' + p2(now.getHours()) + p2(now.getMinutes());
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'catbookmark_books_' + stamp + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast('已匯出 ' + rows.length + ' 條記錄', 'ok');
  }

  function load() {
    /* 用 Contents API 讀（冇 raw CDN 延遲）：啱啱儲存完即刻睇到最新資料 */
    return CB.freshText('data/books.json').then(function (text) {
      allRows = JSON.parse(text);
      if (!Array.isArray(allRows)) allRows = [];
    }).catch(function (err) {
      allRows = [];
      if (!CB.getPat()) toast('未設定 GitHub Token：去「設定」頁填返先睇到資料', 'warn');
      else toast('讀唔到 books.json：' + err.message, 'error');
    }).then(function () {
      render();
    });
  }

  /* 頁碼排序：數字行先數字比較，非數字行後字串比較 */
  function pageKey(p) {
    var s = String(p || '').trim();
    var m = s.match(/^\s*(\d+)/);
    if (m) return [0, parseInt(m[1], 10), s];
    return [1, 0, s];
  }
  function cmpPage(a, b) {
    var ka = pageKey(a), kb = pageKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[0] === 0) {
      if (ka[1] !== kb[1]) return ka[1] - kb[1];
    }
    return ka[2].localeCompare(kb[2], 'zh-Hant');
  }

  function sorted() {
    return allRows.slice().sort(function (a, b) {
      var byTitle = String(a.book_title || '').localeCompare(String(b.book_title || ''), 'zh-Hant');
      if (byTitle !== 0) return byTitle;
      var byPage = cmpPage(a.page, b.page);
      if (byPage !== 0) return byPage;
      return String(a.tag || '').localeCompare(String(b.tag || ''), 'zh-Hant');
    });
  }

  function filtered(rows) {
    var qt = titleFilter.value.trim();
    var qg = tagFilter.value.trim();
    return rows.filter(function (r) {
      return (!qt || String(r.book_title || '').indexOf(qt) !== -1) &&
        (!qg || String(r.tag || '').indexOf(qg) !== -1);
    });
  }

  function render() {
    var rows = filtered(sorted());

    /* suggest 選項（現存書名／標籤） */
    var titleSet = {}, tagSet = {};
    allRows.forEach(function (r) {
      titleSet[String(r.book_title || '').trim()] = true;
      tagSet[String(r.tag || '').trim()] = true;
    });
    titleOptions = Object.keys(titleSet).filter(Boolean).sort(function (a, b) { return a.localeCompare(b, 'zh-Hant'); });
    tagOptions = Object.keys(tagSet).filter(Boolean).sort(function (a, b) { return a.localeCompare(b, 'zh-Hant'); });

    var bookCount = Object.keys(titleSet).filter(Boolean).length;
    countEl.textContent = '顯示 ' + rows.length + ' / ' + allRows.length + ' 條記錄 · 共 ' + bookCount + ' 本書';

    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">冇符合嘅書目。</td></tr>';
      return;
    }
    rows.forEach(function (row) { tbody.appendChild(renderRow(row)); });
  }

  function renderRow(row) {
    var tr = document.createElement('tr');
    tr.className = 'book-row';
    tr.innerHTML =
      '<td class="cell-title clickable" data-role="title-cell">' + hl(row.book_title || '', titleFilter.value.trim()) + '</td>' +
      '<td class="cell-tag">' + hl(row.tag || '', tagFilter.value.trim()) + '</td>' +
      '<td class="cell-page">' + esc(row.page || '—') + '</td>' +
      '<td class="cell-actions">' +
      '  <button class="btn btn-small" data-role="edit" type="button">編輯</button>' +
      '  <button class="btn btn-small btn-danger-ghost" data-role="del" type="button">刪除</button>' +
      '</td>';

    /* 撳書名格 → 即時 filter（再撳一次就取消 filter） */
    tr.querySelector('[data-role="title-cell"]').addEventListener('click', function () {
      var t = String(row.book_title || '').trim();
      if (!t) return;
      if (titleFilter.value.trim() === t) {
        titleFilter.value = '';
        toast('已取消書名篩選', 'ok');
      } else {
        titleFilter.value = t;
        toast('已篩選書名：「' + t + '」', 'ok');
      }
      render();
    });
    tr.querySelector('[data-role="edit"]').addEventListener('click', function () {
      openEditModal(row);
    });
    tr.querySelector('[data-role="del"]').addEventListener('click', function () {
      if (!window.confirm('刪除「' + row.book_title + '」嘅呢條 tag（' + (row.tag || '') + '，頁 ' + (row.page || '—') + '）？')) return;
      saveRows(allRows.filter(function (r) {
        return !(String(r.book_title || '') === String(row.book_title || '') &&
                 String(r.tag || '') === String(row.tag || '') &&
                 String(r.page || '') === String(row.page || ''));
      }));
    });
    return tr;
  }

  function saveRows(rows) {
    return CB.writeFile('data/books.json', JSON.stringify(rows, null, 2) + '\n', '更新書目庫')
      .then(function () {
        toast('已儲存 ✓', 'ok');
        return load();
      })
      .catch(function (err) {
        toast('儲存失敗：' + err.message, 'error');
      });
  }

  load();
})();
