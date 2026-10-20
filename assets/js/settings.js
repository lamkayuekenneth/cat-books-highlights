/* ============================================================
   CatBookmark — 設定頁：GitHub 連線、AI model / base_url /
   OpenRouter API Key（瀏覽器直連，唯一通道）
   ============================================================ */
(function () {
  'use strict';

  var ownerInput = document.getElementById('owner');
  var repoInput = document.getElementById('repo');
  var patInput = document.getElementById('pat');
  var testBtn = document.getElementById('test-conn');
  var connStatus = document.getElementById('conn-status');

  var modelInput = document.getElementById('model');
  var baseUrlInput = document.getElementById('base-url');
  var saveAiBtn = document.getElementById('save-ai');
  var aiStatus = document.getElementById('ai-status');
  var testAiBtn = document.getElementById('test-ai');
  var aiTestStatus = document.getElementById('ai-test-status');

  var orKeyInput = document.getElementById('orkey');
  var orKeyStatus = document.getElementById('orkey-status');

  /* ---------- 初始值 ---------- */
  var conn = CB.getOwnerRepo();
  ownerInput.value = conn.owner;
  repoInput.value = conn.repo;
  patInput.value = CB.getPat();
  /* 先用瀏覽器快取（localStorage）做預設，再畀 repo 嘅 config/settings.json 覆蓋 */
  var aiCache = CB.getAiCache();
  modelInput.value = aiCache.model;
  baseUrlInput.value = aiCache.baseUrl;

  try {
    CB.freshText('config/settings.json').then(function (text) {
      var s = JSON.parse(text);
      if (s.model) modelInput.value = s.model;
      if (s.base_url) baseUrlInput.value = s.base_url;
    }).catch(function () { /* 未有設定檔都冇問題 */ });
  } catch (e) { /* 未填 owner/repo 時跳過（例如本地開檔） */ }

  function saveConn() {
    CB.setOwnerRepo(ownerInput.value, repoInput.value);
    CB.setPat(patInput.value.trim());
    refreshLocalState();
  }

  /* ---------- 瀏覽器儲存狀態總覽（localStorage） ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function refreshLocalState() {
    var pat = CB.getPat();
    var c = CB.getOwnerRepo();
    var orKey = CB.getOrKey();
    var ai = CB.getAiCache();
    function set(id, html, cls) {
      var el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = html;
      el.className = cls || '';
    }
    set('ls-pat', pat
      ? '✓ 已設定（尾 4 位：…' + esc(pat.slice(-4)) + '）'
      : '✗ 未設定（儲存到 books.json 需要）', pat ? 'ok' : 'warn');
    set('ls-repo', (c.owner && c.repo)
      ? '✓ ' + esc(c.owner) + ' / ' + esc(c.repo)
      : '✗ 未設定（喺 GitHub Pages 打開會自動偵測）', (c.owner && c.repo) ? 'ok' : 'warn');
    set('ls-orkey', orKey
      ? '✓ 已設定（尾 4 位：…' + esc(orKey.slice(-4)) + '，上傳即時分析）'
      : '✗ 未設定（上傳頁會提示你去 AI 模型設定填入）', orKey ? 'ok' : 'warn');
    set('ls-model', esc(ai.model || '—'));
    set('ls-base', esc(ai.baseUrl || '—'));
  }
  refreshLocalState();

  /* ---------- 測試連線 ---------- */
  testBtn.addEventListener('click', function () {
    saveConn();
    connStatus.className = 'status';
    connStatus.textContent = '檢查緊…';
    CB.gh('/user').then(function (me) {
      return CB.gh('/repos/' + ownerInput.value.trim() + '/' + repoInput.value.trim()).then(function (r) {
        connStatus.className = 'status ok';
        connStatus.textContent = '✓ 連線成功：@' + me.login + ' · ' + r.full_name;
      });
    }).catch(function (err) {
      connStatus.className = 'status error';
      connStatus.textContent = '✗ ' + err.message;
    });
  });

  /* Base URL 正規化：有啲用戶會連 /chat/completions 一齊填，
     剝走尾端嘅 /chat/completions 同斜線，等後續 call 唔會變雙重 endpoint */
  function normBase(u) {
    return String(u || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  }

  /* ---------- AI model / base_url → config/settings.json ---------- */
  saveAiBtn.addEventListener('click', function () {
    saveConn();
    var model = modelInput.value.trim();
    var baseUrl = normBase(baseUrlInput.value.trim());
    if (!model) return toast('請輸入 model 名稱', 'warn');
    if (!baseUrl) return toast('請輸入 base URL', 'warn');
    if (/qwen3-v1-/i.test(model)) {
      return toast('⚠️ 打錯喇：Qwen 視覺 model 係 vl（字母 V-L），唔係 v1（V-1）。例：qwen/qwen3-vl-235b-a22b-instruct', 'warn');
    }
    if (baseUrlInput.value.trim() !== baseUrl) baseUrlInput.value = baseUrl; /* 即場修正輸入框 */
    /* 有填 Key 就一併儲存（AI 設定合併咗 Key 輸入） */
    var newKey = orKeyInput.value.trim();
    if (newKey) {
      CB.setOrKey(newKey);
      orKeyInput.value = '';
      refreshOrKeyState();
    }
    saveAiBtn.disabled = true;
    aiStatus.className = 'status';
    aiStatus.textContent = '儲存緊…';
    CB.writeFile('config/settings.json',
      JSON.stringify({ model: model, base_url: baseUrl }, null, 2) + '\n',
      '更新 AI 設定（model / base url）')
      .then(function () {
        CB.setAiCache(model, baseUrl); /* 瀏覽器快取（上傳頁用） */
        aiStatus.className = 'status ok';
        aiStatus.textContent = newKey
          ? '✓ 已寫入 config/settings.json ＋ API Key 已記低喺瀏覽器'
          : '✓ 已寫入 config/settings.json ＋ 記低喺瀏覽器';
        toast('AI 設定已儲存 ✓', 'ok');
      })
      .catch(function (err) {
        aiStatus.className = 'status error';
        aiStatus.textContent = '✗ ' + err.message;
        toast('儲存失敗：' + err.message, 'error');
      })
      .then(function () { saveAiBtn.disabled = false; });
  });

  /* ---------- 測試 AI Model（用輸入緊嘅 model + base URL + Key 實際 call 一次） ---------- */
  var pageBanner = document.getElementById('page-banner');
  function showBanner(msg, cls) {
    if (!pageBanner) return;
    pageBanner.hidden = false;
    pageBanner.className = 'page-banner ' + (cls || 'warn');
    pageBanner.innerHTML = msg;
  }
  function clearBanner() {
    if (pageBanner) pageBanner.hidden = true;
  }

  testAiBtn.addEventListener('click', function () {
    saveConn();
    var model = modelInput.value.trim();
    var baseUrl = normBase(baseUrlInput.value.trim());
    if (!model) return toast('請輸入 model 名稱', 'warn');
    if (!baseUrl) return toast('請輸入 base URL', 'warn');
    if (/qwen3-v1-/i.test(model)) {
      return toast('⚠️ 打錯喇：Qwen 視覺 model 係 vl（字母 V-L），唔係 v1（V-1）。例：qwen/qwen3-vl-235b-a22b-instruct', 'warn');
    }
    /* Key 取「AI 模型設定」入面嘅輸入框；未填就取已儲存（localStorage）嗰個 */
    var key = orKeyInput.value.trim() || CB.getOrKey();
    if (!key) {
      clearBanner();
      showBanner(
        '🚫 未有 Key 可測試：喺上面「OpenRouter API Key」貼你嘅 Key（<code>sk-or-…</code>）再撳「測試 Model」，' +
        '測試會用 <b>Key ＋ Base URL ＋ Model</b> 一併驗證連線。',
        'error');
      aiTestStatus.className = 'status error';
      aiTestStatus.textContent = '✗ 未有 Key 可測試（睇頁頂紅色提示）';
      aiTestStatus.scrollIntoView({ block: 'nearest' });
      return toast('未有 Key 可測試', 'warn');
    }
    clearBanner();
    testAiBtn.disabled = true;
    var btnText = testAiBtn.textContent;
    testAiBtn.textContent = '測試緊…';
    aiTestStatus.className = 'status';
    aiTestStatus.textContent = '測試緊…（' + model + '）';
    aiTestStatus.scrollIntoView({ block: 'nearest' });
    var t0 = Date.now();
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 20000);
    fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin + location.pathname,
        'X-Title': 'CatBookmark'
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: '只回覆一個字：好' }],
        temperature: 0,
        max_tokens: 10
      }),
      signal: ctrl.signal
    }).then(function (res) {
      var secs = ((Date.now() - t0) / 1000).toFixed(1);
      return res.json().catch(function () { return null; }).then(function (j) {
        if (!res.ok) {
          var msg = (j && j.error) ? (j.error.message || JSON.stringify(j.error)) : ('HTTP ' + res.status);
          if (res.status === 404) {
            msg += '——404 通常係：① Base URL 唔好連 /chat/completions 都填埋（只需填到 .../api/v1）；② Model ID 唔啱';
          }
          throw new Error(msg + '（' + secs + ' 秒）');
        }
        var content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        storeOrKeyFromInput(); /* 測試通過＝Key 有效，順手儲存 */
        aiTestStatus.className = 'status ok';
        aiTestStatus.textContent = '✓ 回應正常（' + model + '，' + secs + ' 秒）：' +
          (content ? String(content).trim().replace(/\s+/g, ' ').slice(0, 60) : '（無內容）');
        toast('✓ AI Model 測試通過（' + secs + ' 秒）', 'ok');
      });
    }).catch(function (err) {
      var msg = (err && err.name === 'AbortError')
        ? '測試逾時（20 秒）：網絡慢定係 base URL 唔啱？'
        : ((err && err.message) ? err.message : String(err));
      aiTestStatus.className = 'status error';
      aiTestStatus.textContent = '✗ 測試失敗：' + msg +
        '。檢查 model ID、base URL 或 Key（OpenRouter 對某啲 model 有 ToS 限制）';
      toast('✗ AI Model 測試失敗', 'error');
    }).then(function () {
      clearTimeout(timer);
      testAiBtn.disabled = false;
      testAiBtn.textContent = btnText;
    });
  });

  /* ---------- OpenRouter API Key（localStorage，唯一通道） ---------- */
  function refreshOrKeyState() {
    var k = CB.getOrKey();
    if (k) {
      orKeyStatus.className = 'status ok';
      orKeyStatus.textContent = '✓ API Key 已設定（尾 4 位：…' + k.slice(-4) + '）。上傳相片會直接 call OpenRouter，幾秒出結果。';
    } else {
      orKeyStatus.className = 'status warn';
      orKeyStatus.textContent = '尚未設定 API Key：貼入上面輸入框後撳「儲存 AI 設定」，或直接用「測試 Model」驗證連線。';
    }
  }
  refreshOrKeyState();

  /* 「測試 Model」成功時順手儲存 Key（用戶貼咗新 Key 測試，即代表想用） */
  function storeOrKeyFromInput() {
    var k = orKeyInput.value.trim();
    if (!k) return;
    CB.setOrKey(k);
    orKeyInput.value = '';
    refreshOrKeyState();
  }

  window.__CB_SETTINGS_LOADED = true; /* 畀 settings.html 嘅載入檢查用 */
})();
