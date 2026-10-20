# CatBookmark（貓書籤）

📚 **影書頁 → AI 自動認書名／頁碼／標記 → 整理成閱讀 tag** 嘅個人書籤 app。

完全靜態、跑喺 GitHub Pages，零後端伺服器：AI 分析用 OpenRouter vision model，由你嘅**瀏覽器直接 call（直連）**，幾秒出結果；GitHub token 同 OpenRouter key 都只存喺你瀏覽器嘅 localStorage，唔會寫入 repo。

## 快速開始

1. Fork 呢個 repo，喺 Settings → Pages 揀 `main` branch / root 部署。
2. 打開 app → 去「設定」頁：
   - 填 **GitHub Personal Access Token**（需要 `repo` scope，用嚟讀寫 `data/*.json`）、owner（GitHub 用戶名）、repo 名；
   - 喺「🤖 AI 模型設定」填 **OpenRouter API Key**（`sk-or-…`）；
   - 揀 model（建議 `qwen/qwen3-vl-235b-a22b-instruct`，實測最穩）＋ Base URL（預設 `https://openrouter.ai/api/v1`）；
   - 撳 **「測試 Model」**——會用你輸入嘅 **Key ＋ Base URL ＋ Model** 一併實際 call 一次驗證連線，通過後自動記低 Key。
3. 去「上傳」頁影書頁相，或者「書本庫」直接加書。

> AI 分析只有一條路：**瀏覽器直連 OpenRouter**（需要有 Key）。未設定 Key 時上傳頁會提示你去設定頁填入。

## 四頁結構

| 頁 | 功能 |
|---|---|
| **上傳**（index.html） | 影書頁／揀相／貼上 → AI 認書名＋頁碼＋標記 tag → 編輯 → 儲存 |
| **書目庫**（library.html） | 睇／篩選全部 tag；撳書名格即時篩選；撳「編輯」彈 modal 改書名／tag／頁數 |
| **書本庫**（books.html） | 書名＋作者表格；sort／filter；行內編輯／刪除；「＋ 新增書本」彈 modal（可揀相／拍照 AI 認書名＋作者） |
| **設定**（settings.html） | GitHub token、AI 模型（Key／Model／Base URL）、app 版本／狀態 |

## 核心功能

### AI 認標記（tag）
- 認 **螢光筆**（粉／黃／綠 marker 底色）同 **底線**（鉛筆／原子筆／螢光筆，橫排書喺字下面、直排書喺字左側）；
- AI 只負責將 **螢光筆 highlight 嘅字（包括標點）＋任何筆 underline 嘅字（包括標點）** 取出，**全部合併放入一個 tag**（冇標記 → `tags: []`）；
- 用戶之後可以自己編輯 tag：**Enter＝喺 cursor 位切開，後面變成另一個 tag；Backspace（cursor 喺 tag 開頭）＝併返上去上面嗰個 tag**；
- **直排（垂直）書特別規則**：同一段連續文字跨幾欄被線標記（上一欄最後一字同下一欄第一字接得上）→ **合併做一個 tag**，唔會每欄拆開；真係分開、內容唔連貫嘅先各自一個 tag。

### 上傳頁（index）
- 掣常駐喺書名框下面：🗂️ 從書本庫中揀書 ／ 🖼️ 揀相（AI 認書名＋作者）／ 📷 拍照／ 📋 貼上（clipboard 貼圖）；
- 書名框一路打一路彈 **suggest 書本庫書名**（最多 6 條，顯示書名＋作者）；
- 書名 **唔喺書本庫** → 即時警示提示；
- 書名框狀態底色：**空 → 紅色底**、**有字 → 綠色底**；
- 儲存時書本庫冇呢本書 → 彈窗確認「加入書本庫並儲存／取消」；
- 所有 AI 認相／刪除／編輯／儲存過程有**灰色全屏 loading 遮罩**，期間唔可以操作 UI。

### 書本庫（books）
- 書名＋作者表格，sort／filter；
- 行內編輯書名／作者：**改書名會自動同步**所有 tag 嘅書名；
- 刪除書本 → 相關 tag 嘅書名變成空白，可供日後喺 tag 度補返；
- 「＋ 新增書本」：modal 內可揀相／拍照／貼上，AI 認書名＋作者。

### 書目庫（library）
- 睇晒所有 tag，可篩選書名／內容；
- 撳書名格 → 即時 filter 嗰本書嘅 tag；
- 撳「編輯」→ 彈 modal：書名功能同上傳頁**全套一致**（suggest、未喺書本庫提示、揀書／揀相／拍照／貼上四掣、儲存時確認加入書本庫），UI 緊湊、手機友好。

## 資料檔

| 檔案 | 內容 |
|---|---|
| `data/books.json` | 所有 tag：`{book_title, page, tag}` |
| `data/books_meta.json` | 書本庫：`{book_title, author}`（書名唯一） |
| `config/settings.json` | 預設 AI model / base_url |

全部資料直接 commit 去 repo 嘅 `data/` 目錄，即係 GitHub 就係你嘅 database。

## 技術細節

- **零後端**：靜態 HTML/CSS/JS，GitHub Pages hosting；
- **AI 分析單一通道**：瀏覽器直連 OpenRouter（`/chat/completions`），支援任何 OpenAI 兼容端點；
- **token 安全**：GitHub token／OpenRouter key 只存瀏覽器 localStorage，唔會寫入 repo；
- **tag 編輯**：上傳頁支援 Enter 切分／開頭 Backspace 合併；
- 版本參數 `?v=YYYYMMDD` 綴喺 CSS/JS link，bump 版本強制刷新 cache。

## 開發

```bash
# 本地試
python3 -m http.server 8791 --bind 127.0.0.1
# 然後開 http://127.0.0.1:8791/
```

改完 JS 記得：
```bash
node --check assets/js/*.js
```

## 授權

私人／個人使用。
