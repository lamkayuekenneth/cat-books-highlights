/* ============================================================
   CatBookmark — 書目庫：表格形式檢視／編輯 books.json，
   頂部篩選（可揀或手動輸入現存書名／標籤）
   表格 column：書名 | tag | 頁數 | 操作；sort by 書名，然後頁數
   ============================================================ */
(function () {
  'use strict';

  var allRows = [];   /* [{book_title, tag, page}] */

  var titleFilter = document.getElementById('filter-title');
  var tagFilter = document.getElementById('filter-tag');
  var titleList = document.getElementById('title-list');
  var tagList = document.getElementById('tag-list');
  var tbody = document.getElementById('book-list');
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

    /* 篩選 autocomplete */
    var titleSet = {}, tagSet = {};
    allRows.forEach(function (r) {
      titleSet[String(r.book_title || '').trim()] = true;
      tagSet[String(r.tag || '').trim()] = true;
    });
    var allTitles = Object.keys(titleSet).filter(Boolean).sort(function (a, b) { return a.localeCompare(b, 'zh-Hant'); });
    var allTags = Object.keys(tagSet).filter(Boolean).sort(function (a, b) { return a.localeCompare(b, 'zh-Hant'); });
    titleList.innerHTML = allTitles.map(function (t) { return '<option value="' + esc(t) + '">'; }).join('');
    tagList.innerHTML = allTags.map(function (t) { return '<option value="' + esc(t) + '">'; }).join('');

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
      '<td class="cell-title">' + esc(row.book_title || '') + '</td>' +
      '<td class="cell-tag">' + esc(row.tag || '') + '</td>' +
      '<td class="cell-page">' + esc(row.page || '—') + '</td>' +
      '<td class="cell-actions">' +
      '  <button class="btn btn-small" data-role="edit" type="button">編輯</button>' +
      '  <button class="btn btn-small btn-danger-ghost" data-role="del" type="button">刪除</button>' +
      '</td>';

    tr.querySelector('[data-role="edit"]').addEventListener('click', function () {
      editRow(tr, row);
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

  function editRow(tr, row) {
    tr.innerHTML =
      '<td class="cell-title"><input class="row-input" data-role="title" type="text" value="' + esc(row.book_title || '') + '" autocomplete="off"></td>' +
      '<td class="cell-tag"><input class="row-input" data-role="tag" type="text" value="' + esc(row.tag || '') + '" autocomplete="off"></td>' +
      '<td class="cell-page"><input class="row-input" data-role="page" type="text" value="' + esc(row.page || '') + '" placeholder="冇就留空" autocomplete="off"></td>' +
      '<td class="cell-actions">' +
      '  <button class="btn btn-small btn-primary" data-role="save" type="button">儲存變更</button>' +
      '  <button class="btn btn-small btn-ghost" data-role="cancel" type="button">取消</button>' +
      '</td>';

    tr.querySelector('[data-role="cancel"]').addEventListener('click', function () { render(); });
    tr.querySelector('[data-role="save"]').addEventListener('click', function () {
      var newTitle = tr.querySelector('[data-role="title"]').value.trim();
      var newTag = tr.querySelector('[data-role="tag"]').value.trim().replace(/^#+/, '').trim();
      var newPage = tr.querySelector('[data-role="page"]').value.trim();
      if (!newTitle) return toast('書名不可為空', 'warn');
      if (!newTag) return toast('tag 不可為空', 'warn');
      var rest = allRows.filter(function (r) {
        return !(String(r.book_title || '') === String(row.book_title || '') &&
                 String(r.tag || '') === String(row.tag || '') &&
                 String(r.page || '') === String(row.page || ''));
      });
      var seen = {};
      rest.forEach(function (r) {
        seen[String(r.book_title || '') + '\u0000' + String(r.page || '') + '\u0000' + String(r.tag || '')] = true;
      });
      var key = newTitle + '\u0000' + newPage + '\u0000' + newTag;
      if (!seen[key]) rest.push({ book_title: newTitle, page: newPage, tag: newTag });
      else return toast('呢條記錄已存在', 'warn');
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
