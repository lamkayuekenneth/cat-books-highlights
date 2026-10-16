/* ============================================================
   CatBookmark 貓書籤 — 共用工具（GitHub API helper + toast）
   ============================================================ */
(function () {
  'use strict';

  var LS_PAT = 'catbookmark_pat';
  var LS_OWNER = 'catbookmark_owner';
  var LS_REPO = 'catbookmark_repo';

  function b64ToUtf8(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  var CB = {
    LS_PAT: LS_PAT,
    LS_OWNER: LS_OWNER,
    LS_REPO: LS_REPO,
    API: 'https://api.github.com',
    b64ToUtf8: b64ToUtf8,
    utf8ToB64: utf8ToB64,

    getPat: function () { return localStorage.getItem(LS_PAT) || ''; },
    setPat: function (v) { if (v) localStorage.setItem(LS_PAT, v); else localStorage.removeItem(LS_PAT); },

    /* 自動偵測 GitHub Pages 網址：https://<owner>.github.io/<repo>/ */
    getOwnerRepo: function () {
      var owner = localStorage.getItem(LS_OWNER);
      var repo = localStorage.getItem(LS_REPO);
      if (!owner || !repo) {
        try {
          var h = location.hostname.split('.');
          if (h.length >= 3 && h[h.length - 2] === 'github' && h[h.length - 1] === 'io') {
            owner = owner || h[0];
            repo = repo || (location.pathname.split('/').filter(Boolean)[0] || '');
          }
        } catch (e) { /* ignore */ }
      }
      return { owner: owner || '', repo: repo || '' };
    },

    setOwnerRepo: function (owner, repo) {
      localStorage.setItem(LS_OWNER, owner.trim());
      localStorage.setItem(LS_REPO, repo.trim());
    },

    requireRepo: function () {
      var r = this.getOwnerRepo();
      if (!r.owner || !r.repo) throw new Error('請先喺「設定」頁填 GitHub owner / repo');
      return r;
    },

    /* GitHub REST API（browser CORS 支援） */
    gh: function (path, options) {
      options = options || {};
      var headers = Object.assign({
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }, options.headers || {});
      var pat = this.getPat();
      if (pat) headers.Authorization = 'Bearer ' + pat;
      var opts = Object.assign({}, options, { headers: headers });
      return fetch(this.API + path, opts).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return null; }).then(function (j) {
            var msg = 'GitHub API ' + res.status;
            if (j && j.message) msg += ': ' + j.message;
            var err = new Error(msg);
            err.status = res.status;
            throw err;
          });
        }
        return res.status === 204 ? null : res.json();
      });
    },

    /* 讀 repo 上嘅檔案（raw，公開 repo 唔使 token） */
    rawText: function (path) {
      var r = this.requireRepo();
      return fetch('https://raw.githubusercontent.com/' + r.owner + '/' + r.repo + '/main/' + path,
        { cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new Error('raw ' + res.status);
        return res.text();
      });
    },

    readFileMeta: function (path) {
      var r = this.requireRepo();
      return this.gh('/repos/' + r.owner + '/' + r.repo + '/contents/' + path).then(function (data) {
        return { sha: data.sha, content: b64ToUtf8(data.content) };
      });
    },

    /* 用 Contents API 寫檔（需要 token 有 contents:write） */
    writeFile: function (path, content, message) {
      var r = this.requireRepo();
      var self = this;
      return self.readFileMeta(path).then(function (meta) {
        return meta.sha;
      }).catch(function () {
        return null; /* 新檔 */
      }).then(function (sha) {
        var body = { message: message, content: utf8ToB64(content) };
        if (sha) body.sha = sha;
        return self.gh('/repos/' + r.owner + '/' + r.repo + '/contents/' + path, {
          method: 'PUT',
          body: JSON.stringify(body)
        });
      });
    },

    deleteFile: function (path, message) {
      var r = this.requireRepo();
      var self = this;
      return self.readFileMeta(path).then(function (meta) {
        return self.gh('/repos/' + r.owner + '/' + r.repo + '/contents/' + path, {
          method: 'DELETE',
          body: JSON.stringify({ message: message || 'delete ' + path, sha: meta.sha })
        });
      });
    },

    /* dispatch GitHub Actions workflow（需要 token 有 actions:write） */
    dispatchWorkflow: function (fileName, inputs) {
      var r = this.requireRepo();
      return this.gh('/repos/' + r.owner + '/' + r.repo + '/actions/workflows/' + fileName + '/dispatches', {
        method: 'POST',
        body: JSON.stringify({ ref: 'main', inputs: inputs })
      });
    }
  };

  window.CB = CB;

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg, type) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'toast show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 4200);
  }
  window.toast = toast;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  window.sleep = sleep;
})();
