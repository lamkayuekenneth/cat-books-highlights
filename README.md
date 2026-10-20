# CatBookmark（貓書籤）

📚 **影書頁 → AI 自動認書名／頁碼／標記 → 整理成閱讀 tag** 嘅個人書籤 app。

完全靜態、跑喺 GitHub Pages，零後端伺服器：AI 分析用 OpenRouter vision model（瀏覽器直連優先，GitHub Actions 後備），你嘅 GitHub token 用 libsodium 加密後存喺瀏覽器 localStorage。

## 快速開始

1. Fork 呢個 repo，喺 Settings → Pages 揀 `main` branch / root 部署。
2. 打開 app → 去「設定」頁：
   - 填 **GitHub Personal Access Token**（需要 `repo` + `workflow` scope）、owner（GitHub 用戶名）、repo 名；
   - 填 **OpenRouter API Key**（`catbookmark_orkey`，用嚟瀏覽器直連 AI）；
   - 揀 model（建議 `qwen/qwen3-vl-235b-a22b-instruct`，實測最穩）。
3. 去「上傳」頁影書頁相，或者「書本庫」直接加書。

> AI 分析有兩條路：有 OpenRouter key 就瀏覽器直連即時出結果；冇 key 就會上傳圖片去 GitHub Actions workflow 分析（慢啲，但唔使 key）。

## 四頁結構

| 頁 | 功能 |
|---|---|
| **上傳**（index.html） | 影書頁／揀相 → AI 認書名＋頁碼＋標記 tag → 編輯 → 儲存 |
| **書目庫**（library.html） | 睇／篩選全部 tag；撳書名格即時篩選；撳「編輯」彈 modal 改書名／tag／頁數 |
| **書本庫**（books.html） | 書名＋作者表格；sort／filter；行內編輯／刪除；「＋ 新增書本」彈 modal（可揀相／拍照 AI 認書名＋作者） |
| **設定**（settings.html） | GitHub token、OpenRouter key、AI model、app 版本／狀態 |

## 核心功能

### AI 認標記（tag）
- 認 **螢光筆**（粉／黃／綠 marker 底色）同 **底線**（鉛筆／原子筆，橫排書喺字下面、直排書喺字左側）；
- 每一處標記只抄實際有標記嗰啲字成為一個 tag，唔會成句成段照抄、唔會改寫；
- **直排（垂直）書特別規則**：同一段連續文字跨幾欄被線標記（上一欄最後一字同下一欄第一字接得上）→ **合併做一個 tag**，唔會每欄拆開；真係分開、內容唔連貫嘅先各自一個 tag；
- 完全冇標記 → tags 輸出空陣列 `[]`。

### 上傳頁（index）
- 三個掣 **常駐喺書名框下面**：🗂️ 從書本庫中揀書 ／ 🖼️ 揀相（AI 認書名＋作者）／ 📷 拍照（AI 認書名＋作者）；
- 書名框一路打一路彈 **suggest 書本庫書名**（最多 6 條，顯示書名＋作者）；
- 書名 **唔喺書本庫** → 即時警示提示；
- 書名框狀態底色：**空 → 紅色底**、**有字 → 綠色底**；
- 儲存時書本庫冇呢本書 → 彈窗確認「加入書本庫並儲存／取消」。

### 書本庫（books）
- 書名＋作者表格，sort／filter；
- 行內編輯書名／作者：**改書名會自動同步**所有 tag 嘅書名；
- 刪除書本 → 相關 tag 嘅書名變成空白，可供日後喺 tag 度補返；
- 「＋ 新增書本」：modal 內可揀相／拍照，AI 認書名＋作者。

### 書目庫（library）
- 睇晒所有 tag，可篩選書名／內容；
- 撳書名格 → 即時 filter 嗰本書嘅 tag；
- 撳「編輯」→ 彈 modal：書名功能同上傳頁**全套一致**（suggest、未喺書本庫提示、揀書／揀相／拍照三掣、儲存時確認加入書本庫），UI 緊湊、手機友好。

## 資料檔

| 檔案 | 內容 |
|---|---|
| `data/books.json` | 所有 tag：`{book_title, page, tag}` |
| `data/books_meta.json` | 書本庫：`{book_title, author}`（書名唯一） |
| `config/settings.json` | 預設 AI model / base_url |

全部資料直接 commit 去 repo 嘅 `data/` 目錄，即係 GitHub 就係你嘅 database。

## 技術細節

- **零後端**：靜態 HTML/CSS/JS，GitHub Pages hosting；
- **AI 分析兩路**：
  - 直連：瀏覽器直接 call OpenRouter（有 `catbookmark_orkey` 時），即時；
  - 後備：`.github/workflows/analyze.yml` GitHub Actions workflow（圖片 base64 放 dispatch payload，GitHub 有 key 時用）；
- **token 安全**：GitHub token／OpenRouter key 用 `libsodium.js` 加密後存 localStorage，唔會寫入 repo；
- 版本參數 `?v=YYYYMMDD` 綴喺 CSS/JS link，bump 版本強制刷新 cache。

## 開發

```bash
# 本地試
python3 -m http.server 8791 --bind 127.0.0.1
# 然後開 http://127.0.0.1:8791/
```

改完 JS／Python 記得：
```bash
node --check assets/js/*.js
python3 -m py_compile scripts/analyze.py
```

## 授權

私人／個人使用。
