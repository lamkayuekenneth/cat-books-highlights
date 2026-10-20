/* ============================================================
   CatBookmark 貓書籤 — 共用工具（GitHub API helper + toast）
   ============================================================ */
(function () {
  'use strict';

  var LS_PAT = 'catbookmark_pat';
  var LS_OWNER = 'catbookmark_owner';
  var LS_REPO = 'catbookmark_repo';
  var LS_ORK = 'catbookmark_orkey';
  var LS_MODEL = 'catbookmark_model';
  var LS_BASE = 'catbookmark_base_url';
  var DEFAULT_MODEL = 'qwen/qwen3-vl-8b-instruct';
  var DEFAULT_BASE = 'https://openrouter.ai/api/v1';

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

    /* 瀏覽器直連 OpenRouter 用（最快）；key 只存喺自己瀏覽器 localStorage */
    getOrKey: function () { return localStorage.getItem(LS_ORK) || ''; },
    setOrKey: function (v) { if (v) localStorage.setItem(LS_ORK, v); else localStorage.removeItem(LS_ORK); },

    getAiCache: function () {
      return {
        model: localStorage.getItem(LS_MODEL) || DEFAULT_MODEL,
        baseUrl: localStorage.getItem(LS_BASE) || DEFAULT_BASE
      };
    },
    setAiCache: function (model, baseUrl) {
      if (model) localStorage.setItem(LS_MODEL, model);
      if (baseUrl) localStorage.setItem(LS_BASE, baseUrl);
    },

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

    /* 讀 repo 上嘅檔案——優先 Contents API（即時最新 commit，冇 raw CDN 延遲），
       失敗先至 fallback 去 raw。用嚟讀 books.json / pending 結果檔呢啲啱啱先改完嘅檔 */
    freshText: function (path) {
      var self = this;
      return self.readFileMeta(path).then(function (meta) {
        return meta.content;
      }).catch(function () {
        return self.rawText(path);
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

    /* dispatch GitHub Actions workflow（repository_dispatch：client_payload 冇 65,535 字元限制，
       圖片可以高質素直送；需要 token 有 actions:write） */
    dispatchWorkflow: function (fileName, inputs) {
      var r = this.requireRepo();
      return this.gh('/repos/' + r.owner + '/' + r.repo + '/dispatches', {
        method: 'POST',
        body: JSON.stringify({ event_type: 'analyze', client_payload: inputs })
      });
    },

    /* AI 分析全屏 loading 遮罩：顯示期間用戶唔可以操作 UI */
    aiBusy: function (msg) {
      var ov = document.getElementById('cb-ai-overlay');
      if (!ov) {
        ov = document.createElement('div');
        ov.id = 'cb-ai-overlay';
        ov.className = 'ai-overlay';
        ov.hidden = true;
        ov.innerHTML = '<div class="ai-overlay-box">' +
          '<div class="ai-spinner"></div>' +
          '<div class="ai-overlay-msg" id="cb-ai-msg">AI 分析中…</div>' +
          '</div>';
        document.body.appendChild(ov);
      }
      var m = document.getElementById('cb-ai-msg');
      if (m) m.textContent = msg || 'AI 分析中…';
      ov.hidden = false;
    },
    aiReady: function () {
      var ov = document.getElementById('cb-ai-overlay');
      if (ov) ov.hidden = true;
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
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 6000);
  }
  window.toast = toast;

  /* ---------- 全頁錯誤捕捉：任何靜靜地死咗嘅錯誤都要見得到（尤其手機） ---------- */
  window.addEventListener('error', function (e) {
    var msg = (e && e.message) ? e.message : '頁面發生錯誤';
    try { toast('⚠ ' + msg, 'error'); } catch (err) { /* toast 未 ready */ }
  });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e && e.reason;
    var msg = (reason && reason.message) ? reason.message
      : (reason ? String(reason) : '未知錯誤');
    try { toast('⚠ ' + msg, 'error'); } catch (err) { /* toast 未 ready */ }
  });

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  window.sleep = sleep;
})();
