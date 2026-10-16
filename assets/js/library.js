/* ============================================================
   CatBookmark — 書目庫：檢視／編輯 books.json，頂部篩選
   （可揀或手動輸入現存書名／標籤）
   ============================================================ */
(function () {
  'use strict';

  var allRows = [];   /* [{book_title, tag}] */
  var books = [];     /* [{title, tags: []}] */

  var titleFilter = document.getElementById('filter-title');
  var tagFilter = document.getElementById('filter-tag');
  var titleList = document.getElementById('title-list');
  var tagList = document.getElementById('tag-list');
  var bookList = document.getElementById('book-list');
  var countEl = document.getElementById('filter-count');
  var clearBtn = document.getElementById('filter-clear');
  var loadBtn = document.getElementById('reload');

  titleFilter.addEventListener('input', render);
  tagFilter.addEventListener('input', render);
  clearBtn.addEventListener('click', function () {
    titleFilter.value = '';
    tagFilter.value = '';
    render();
  });
  if (loadBtn) loadBtn.addEventListener('click', load);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function load() {
    return CB.rawText('data/books.json').then(function (text) {
      allRows = JSON.parse(text);
      if (!Array.isArray(allRows)) allRows = [];
    }).catch(function (err) {
      allRows = [];
      if (!CB.getPat()) toast('未設定 GitHub Token：去「設定」頁填返先睇到資料', 'warn');
      else toast('讀唔到 books.json：' + err.message, 'error');
    }).then(function () {
      group();
      render();
    });
  }

  function group() {
    var map = {};
    allRows.forEach(function (r) {
      var t = String(r.book_title || '').trim();
      var g = String(r.tag || '').trim();
      if (!t || !g) return;
      if (!map[t]) map[t] = [];
      if (map[t].indexOf(g) === -1) map[t].push(g);
    });
    books = Object.keys(map).map(function (title) {
      return { title: title, tags: map[title] };
    });
    books.sort(function (a, b) { return a.title.localeCompare(b.title, 'zh-Hant'); });
  }

  function filtered() {
    var qt = titleFilter.value.trim();
    var qg = tagFilter.value.trim();
    return books.filter(function (b) {
      return (!qt || b.title.indexOf(qt) !== -1) &&
        (!qg || b.tags.some(function (t) { return t.indexOf(qg) !== -1; }));
    });
  }

  function render() {
    var list = filtered();

    /* 篩選 autocomplete */
    var allTitles = books.map(function (b) { return b.title; });
    var tagSet = {};
    books.forEach(function (b) {
      b.tags.forEach(function (t) { tagSet[t] = true; });
    });
    var allTags = Object.keys(tagSet).sort(function (a, b) { return a.localeCompare(b, 'zh-Hant'); });
    titleList.innerHTML = allTitles.map(function (t) {
      return '<option value="' + esc(t) + '">';
    }).join('');
    tagList.innerHTML = allTags.map(function (t) {
      return '<option value="' + esc(t) + '">';
    }).join('');

    var totalTagRows = allRows.length;
    countEl.textContent = '顯示 ' + list.length + ' / ' + books.length + ' 本書 · 共 ' + totalTagRows + ' 條 tag';

    bookList.innerHTML = '';
    if (!list.length) {
      bookList.innerHTML = '<p class="empty">冇符合嘅書目。</p>';
      return;
    }
    list.forEach(function (b) { bookList.appendChild(renderBook(b)); });
  }

  function renderBook(book) {
    var article = document.createElement('article');
    article.className = 'card book-card';
    article.innerHTML =
      '<div class="book-head">' +
      '  <h3 class="book-title" data-role="title">' + esc(book.title) + '</h3>' +
      '  <span class="book-count">' + book.tags.length + ' 個 tag</span>' +
      '</div>' +
      '<div class="chips" data-role="chips">' +
      book.tags.map(function (t) { return '<span class="chip"><span class="chip-text">' + esc(t) + '</span></span>'; }).join('') +
      '</div>' +
      '<div class="card-actions">' +
      '  <button class="btn btn-primary" data-role="edit" type="button">編輯</button>' +
      '  <button class="btn btn-danger-ghost" data-role="del" type="button">刪除</button>' +
      '</div>';

    article.querySelector('[data-role="edit"]').addEventListener('click', function () {
      editBook(article, book);
    });
    article.querySelector('[data-role="del"]').addEventListener('click', function () {
      if (!window.confirm('刪除《' + book.title + '》同佢 ' + book.tags.length + ' 個 tag？')) return;
      saveRows(allRows.filter(function (r) {
        return String(r.book_title || '').trim() !== book.title;
      }));
    });
    return article;
  }

  function editBook(article, book) {
    var oldTitle = book.title;
    article.innerHTML =
      '<div class="book-head">' +
      '  <input class="book-title-input" data-role="title" type="text" value="' + esc(oldTitle) + '" autocomplete="off">' +
      '</div>' +
      '<div class="chips" data-role="chips"></div>' +
      '<input class="add-tag" data-role="add" type="text" placeholder="＋ 新增標籤，按 Enter" autocomplete="off">' +
      '<div class="card-actions">' +
      '  <button class="btn btn-primary" data-role="save" type="button">儲存變更</button>' +
      '  <button class="btn btn-ghost" data-role="cancel" type="button">取消</button>' +
      '</div>';

    var chipsEl = article.querySelector('[data-role="chips"]');
    var titleInput = article.querySelector('[data-role="title"]');
    var addInput = article.querySelector('[data-role="add"]');

    function readTags() {
      return Array.prototype.map.call(
        chipsEl.querySelectorAll('.chip-text'),
        function (el) { return el.textContent.trim(); }
      ).filter(Boolean);
    }

    function renderChips(tags) {
      chipsEl.innerHTML = '';
      tags.forEach(function (t) {
        var chip = document.createElement('span');
        chip.className = 'chip';
        var text = document.createElement('span');
        text.className = 'chip-text';
        text.textContent = t;
        var x = document.createElement('button');
        x.className = 'chip-x';
        x.type = 'button';
        x.textContent = '×';
        x.setAttribute('aria-label', '刪除標籤');
        chip.appendChild(text);
        chip.appendChild(x);
        chipsEl.appendChild(chip);
        x.addEventListener('click', function () {
          renderChips(readTags().filter(function (v) { return v !== t; }));
        });
      });
    }
    renderChips(book.tags.slice());

    addInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var t = addInput.value.trim().replace(/^#+/, '').trim();
      if (!t) return;
      var tags = readTags();
      if (tags.indexOf(t) === -1) renderChips(tags.concat([t]));
      addInput.value = '';
    });

    article.querySelector('[data-role="cancel"]').addEventListener('click', load);
    article.querySelector('[data-role="save"]').addEventListener('click', function () {
      var newTitle = titleInput.value.trim();
      var tags = readTags();
      if (!newTitle) return toast('書名不可為空', 'warn');
      if (!tags.length) return toast('至少一個標籤', 'warn');
      var rest = allRows.filter(function (r) {
        return String(r.book_title || '').trim() !== oldTitle;
      });
      var seen = {};
      rest.forEach(function (r) { seen[r.book_title + '\u0000' + r.tag] = true; });
      tags.forEach(function (t) {
        var key = newTitle + '\u0000' + t;
        if (!seen[key]) { rest.push({ book_title: newTitle, tag: t }); seen[key] = true; }
      });
      saveRows(rest);
    });
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
