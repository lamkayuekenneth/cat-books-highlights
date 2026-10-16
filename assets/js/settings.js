/* ============================================================
   CatBookmark — 設定頁：GitHub 連線、AI model/base_url、
   OpenRouter API Key（加密寫入 GitHub Actions secret）
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

  var apiKeyInput = document.getElementById('api-key');
  var saveKeyBtn = document.getElementById('save-key');
  var keyStatus = document.getElementById('key-status');
  var secretState = document.getElementById('secret-state');

  var orKeyInput = document.getElementById('orkey');
  var enableOrBtn = document.getElementById('enable-orkey');
  var orKeyStatus = document.getElementById('orkey-status');

  /* ---------- 初始值 ---------- */
  var conn = CB.getOwnerRepo();
  ownerInput.value = conn.owner;
  repoInput.value = conn.repo;
  patInput.value = CB.getPat();
  modelInput.value = 'openai/gpt-4o-mini';
  baseUrlInput.value = 'https://openrouter.ai/api/v1';

  try {
    CB.rawText('config/settings.json').then(function (text) {
      var s = JSON.parse(text);
      if (s.model) modelInput.value = s.model;
      if (s.base_url) baseUrlInput.value = s.base_url;
    }).catch(function () { /* 未有設定檔都冇問題 */ });
  } catch (e) { /* 未填 owner/repo 時跳過（例如本地開檔） */ }

  function saveConn() {
    CB.setOwnerRepo(ownerInput.value, repoInput.value);
    CB.setPat(patInput.value.trim());
  }

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

  /* ---------- AI model / base_url → config/settings.json ---------- */
  saveAiBtn.addEventListener('click', function () {
    saveConn();
    var model = modelInput.value.trim();
    var baseUrl = baseUrlInput.value.trim();
    if (!model) return toast('請輸入 model 名稱', 'warn');
    if (!baseUrl) return toast('請輸入 base URL', 'warn');
    saveAiBtn.disabled = true;
    aiStatus.className = 'status';
    aiStatus.textContent = '儲存緊…';
    CB.writeFile('config/settings.json',
      JSON.stringify({ model: model, base_url: baseUrl }, null, 2) + '\n',
      '更新 AI 設定（model / base url）')
      .then(function () {
        CB.setAiCache(model, baseUrl); /* 直連模式用嘅瀏覽器快取 */
        aiStatus.className = 'status ok';
        aiStatus.textContent = '✓ 已寫入 config/settings.json，同時記低喺瀏覽器（直連用）';
        toast('AI 設定已儲存 ✓', 'ok');
      })
      .catch(function (err) {
        aiStatus.className = 'status error';
        aiStatus.textContent = '✗ ' + err.message;
        toast('儲存失敗：' + err.message, 'error');
      })
      .then(function () { saveAiBtn.disabled = false; });
  });

  /* ---------- 瀏覽器直連 Key（localStorage） ---------- */
  function refreshOrKeyState() {
    var k = CB.getOrKey();
    if (k) {
      orKeyStatus.className = 'status ok';
      orKeyStatus.textContent = '✓ 直連已啟用（Key 尾 4 位：…' + k.slice(-4) + '）。上傳相片會直接 call OpenRouter，幾秒出結果。';
    } else {
      orKeyStatus.className = 'status warn';
      orKeyStatus.textContent = '尚未啟用直連：填入 Key 後按「啟用直連」；否則用 GitHub Actions 後備模式（約 1–2 分鐘）。';
    }
  }
  enableOrBtn.addEventListener('click', function () {
    var key = orKeyInput.value.trim();
    if (!key) return toast('請輸入 OpenRouter API Key', 'warn');
    CB.setOrKey(key);
    orKeyInput.value = '';
    refreshOrKeyState();
    toast('✓ 直連已啟用（幾秒出結果）', 'ok');
  });
  refreshOrKeyState();

  /* ---------- API Key → GitHub Actions secret（後備模式） ---------- */
  var sodiumPromise = null;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('載入失敗：' + src)); };
      document.head.appendChild(s);
    });
  }
  function sodiumReady() {
    if (!sodiumPromise) {
      /* 優先本地檔案（隨 repo 分發，離線可用）；失敗先至試 CDN */
      var candidates = [
        ['assets/js/libsodium.js', 'assets/js/libsodium-wrappers.js'],
        ['https://cdn.jsdelivr.net/npm/libsodium@0.7.15/dist/modules/libsodium.js',
         'https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.15/dist/modules/libsodium-wrappers.js']
      ];
      function tryAt(i) {
        if (i >= candidates.length) {
          return Promise.reject(new Error('無法載入加密庫（libsodium CDN 唔通）'));
        }
        var pair = candidates[i];
        return loadScript(pair[0]).then(function () { return loadScript(pair[1]); })
          .then(function () {
            if (!window.sodium) throw new Error('sodium 未初始化');
            return window.sodium.ready.then(function () { return window.sodium; });
          })
          .catch(function () { return tryAt(i + 1); });
      }
      sodiumPromise = tryAt(0);
    }
    return sodiumPromise;
  }

  saveKeyBtn.addEventListener('click', function () {
    saveConn();
    var key = apiKeyInput.value.trim();
    if (!key) return toast('請輸入 OpenRouter API Key', 'warn');
    saveKeyBtn.disabled = true;
    keyStatus.className = 'status';
    keyStatus.textContent = '加密緊同寫入緊…';
    var r = CB.getOwnerRepo();
    CB.gh('/repos/' + r.owner + '/' + r.repo + '/actions/secrets/public-key')
      .then(function (pub) {
        return sodiumReady().then(function (sodium) {
          var pk = sodium.from_base64(pub.key, sodium.base64_variants.ORIGINAL);
          return sodium.to_base64(
            sodium.crypto_box_seal(sodium.from_string(key), pk),
            sodium.base64_variants.ORIGINAL);
        }).then(function (sealed) {
          return CB.gh('/repos/' + r.owner + '/' + r.repo + '/actions/secrets/OPENROUTER_API_KEY', {
            method: 'PUT',
            body: JSON.stringify({ encrypted_value: sealed, key_id: pub.key_id })
          });
        });
      })
      .then(function () {
        apiKeyInput.value = '';
        keyStatus.className = 'status ok';
        keyStatus.textContent = '✓ API Key 已加密寫入 GitHub Actions secret（OPENROUTER_API_KEY），唔會存入 repository';
        toast('API Key 已寫入 Secret ✓', 'ok');
        refreshSecretState();
      })
      .catch(function (err) {
        keyStatus.className = 'status error';
        keyStatus.textContent = '✗ ' + err.message +
          '。替代方法：GitHub → Settings → Secrets and variables → Actions → New repository secret → 名稱 OPENROUTER_API_KEY';
        toast('API Key 設定失敗，請睇提示', 'error');
      })
      .then(function () { saveKeyBtn.disabled = false; });
  });

  /* ---------- 驗證 OpenRouter Key（直接 call OpenRouter /api/v1/key） ---------- */
  var verifyKeyBtn = document.getElementById('verify-key');
  var keyVerifyStatus = document.getElementById('key-verify-status');
  verifyKeyBtn.addEventListener('click', function () {
    var key = apiKeyInput.value.trim();
    if (!key) return toast('請先喺上面輸入 API Key', 'warn');
    verifyKeyBtn.disabled = true;
    keyVerifyStatus.className = 'status';
    keyVerifyStatus.textContent = '驗證緊…（call OpenRouter）';
    fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: 'Bearer ' + key }
    }).then(function (res) {
      if (res.ok) {
        return res.json().then(function (info) {
          keyVerifyStatus.className = 'status ok';
          var label = (info && info.data && info.data.label) ? '（' + info.data.label + '）' : '';
          keyVerifyStatus.textContent = '✓ Key 有效' + label + '，可以放心儲存';
          toast('✓ OpenRouter Key 有效', 'ok');
        });
      }
      return res.json().catch(function () { return null; }).then(function (j) {
        var msg = (j && j.error && j.error.message) ? j.error.message : ('HTTP ' + res.status);
        keyVerifyStatus.className = 'status error';
        keyVerifyStatus.textContent = '✗ Key 無效：' + msg + '。請去 openrouter.ai/settings/keys 複製正確嘅 key';
        toast('✗ Key 無效', 'error');
      });
    }).catch(function (err) {
      keyVerifyStatus.className = 'status error';
      keyVerifyStatus.textContent = '✗ 驗證失敗（' + err.message + '），可能係網絡問題';
    }).then(function () { verifyKeyBtn.disabled = false; });
  });

  function refreshSecretState() {
    secretState.className = 'status';
    secretState.textContent = '檢查緊…';
    var r = CB.getOwnerRepo();
    CB.gh('/repos/' + r.owner + '/' + r.repo + '/actions/secrets')
      .then(function (data) {
        var has = (data.secrets || []).some(function (s) { return s.name === 'OPENROUTER_API_KEY'; });
        secretState.className = 'status ' + (has ? 'ok' : 'warn');
        secretState.textContent = has
          ? '✓ OPENROUTER_API_KEY 已設定'
          : '尚未設定 OPENROUTER_API_KEY（可用上方表單，或去 GitHub UI 手動加）';
      })
      .catch(function (err) {
        secretState.className = 'status warn';
        secretState.textContent = '未能讀取 secret 狀態（' + err.message +
          '）。如果 Token 冇 Secrets 權限，可直接去 GitHub UI 新增 OPENROUTER_API_KEY。';
      });
  }
  refreshSecretState();
})();
