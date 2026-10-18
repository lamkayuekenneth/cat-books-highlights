#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CatBookmark – 書頁 AI 分析（喺 GitHub Actions 入面執行）
==========================================================
輸入：
  argv[1] = image_id（用戶端生成嘅唯一 ID）
  stdin  = JPEG 圖片嘅 base64（唔含 "data:image/jpeg;base64," 前綴）
輸出：
  data/pending/<image_id>.json
    { "book_title": "...", "tags": ["...", ...] }
    或 { "error": "..." }

設計重點：
  - 相片本身永遠唔會寫入 repo / 磁碟 —— base64 只喺記憶體解碼後送去
    OpenRouter vision model；落到 repo 嘅淨係文字結果（book_title + tags）。
  - model / base_url 由 config/settings.json 讀取（用戶喺網頁「設定」頁改）。
  - API key 由環境變數 OPENROUTER_API_KEY 讀取（GitHub Actions secret），
    永遠唔會出現喺 repo。
"""
import base64
import json
import os
import re
import socket
import sys
import urllib.error
import urllib.request

# 硬性 socket 層 timeout：就算 urlopen timeout 失效都唔會卡死成個 workflow
socket.setdefaulttimeout(120)

SYSTEM_PROMPT = (
    "你係一個協助整理閱讀筆記嘅助手。用戶影咗一本書其中一頁嘅相片，"
    "頁面可能有書名、章節名、頁碼、螢光筆同底線標記（直排或橫排書都啱）。\n"
    "請完成三件事：\n"
    "1. 核實頁面有冇書名：檢查頁眉/頁腳（header / footer）印嘅文字。"
    "如果係完整嘅書名就寫出嚟；如果嗰行係章節標題（例如「第一章」「第X卷」「第X節」）或者內文，就寫空字串——章節名唔算書名。\n"
    "2. 如果頁面印有頁碼（通常喺頁面頂部或底部嘅獨立數字，例如 12、150、-25-、p.87），"
    "寫出頁碼（淨係寫數字，唔好要 p.、第、- 呢啲前後綴）；冇頁碼就寫空字串。\n"
    "3. 睇下頁面有冇閱讀標記（直排或橫排書都啱）：\n"
    "   - 螢光筆（marker / highlighter，通常係粉紅色、黃色或綠色 marker 塗喺字上面嘅底色）；\n"
    "   - 底線（underline，通常係鉛筆／原子筆／中性筆畫喺文字下面嘅直線；"
    "注意：橫排（水平）書嘅底線畫喺文字下面，直排（垂直）書嘅底線通常畫喺文字左側）；\n"
    "每一處標記（螢光筆或底線），只抄實際有標記嗰啲字（highlighted / underlined characters），成為一個 tag；"
    "唔好連標記以外嘅字都抄、唔好成句成段照抄、唔好拆開、唔好消化、唔好改寫、唔好翻譯、唔好擴寫；"
    "如果頁面完全冇螢光筆同底線，tags 一定要輸出空陣列 []，絕對唔可以將頁面嘅普通文字拆散做 tag；"
    "標記（螢光筆＋底線）通常唔會多過 5 處，如果拆出超過 10 個 tag 好可能係誤判，要重新只輸出真正有標記嘅文字；"
    "有幾多處標記，就係幾多個 tag。\n"
    "【直排（垂直）書線標記特別規則】直排書讀者通常喺每一欄文字左側畫一條直線標記："
    "如果同一段連續文字跨幾欄被標記（上一欄最後一個字同下一欄第一個字接得上＝內容連貫），"
    "要將呢幾欄嘅標記文字連貫合併做一個 tag，唔好每欄拆開一個 tag；"
    "只有真係分開、內容唔連貫嘅幾段標記先至各自做一個 tag。\n"
    "只可以輸出一個 JSON 物件，格式嚴格如下：\n"
    '{"book_title": "書名", "page": "頁碼", "tags": ["標記字1", "標記字2"]}\n'
    "書名或頁碼搵唔到就寫空字串。唔好輸出任何其他文字、解釋、或者 markdown 標記。"
)

USER_PROMPT = "請睇吓呢張書頁相片：核實有冇書名（章節名唔算，冇就留空）、寫出頁碼（有先寫）；每一處標記——螢光筆塗住嘅字，或者底線畫住嘅字（橫排書底線喺字下面、直排書底線喺字左側）——只抄實際有標記嗰啲字成為一個 tag（唔好連標記以外嘅字）；如果係直排書、同一段連續文字跨幾欄被線標記，要將呢幾欄合併做一個 tag，唔好每欄拆開；如果睇唔到任何螢光筆或底線，tags 輸出 []，唔好自己拆字。"


def write_result(image_id, result):
    os.makedirs("data/pending", exist_ok=True)
    path = os.path.join("data", "pending", "%s.json" % image_id)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)


def parse_ai_json(content):
    """由模型回應抽出 JSON 物件；處理 markdown fence 同多餘文字。"""
    if not content:
        return None
    content = content.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", content, re.S)
    if m:
        content = m.group(1).strip()
    try:
        obj = json.loads(content)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    start, end = content.find("{"), content.rfind("}")
    if start != -1 and end > start:
        try:
            obj = json.loads(content[start:end + 1])
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass
    return None


def detect_mime(image_b64):
    """由 base64 開頭幾個位元組偵測圖片格式（JPEG / PNG / WebP）。"""
    try:
        head = base64.b64decode(image_b64[:32])
    except Exception:
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "image/jpeg"


def call_openrouter(image_b64, model, base_url, api_key):
    mime = detect_mime(image_b64)
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:%s;base64,%s" % (mime, image_b64)},
                    },
                    {"type": "text", "text": USER_PROMPT},
                ],
            },
        ],
        "temperature": 0.1,
        "max_tokens": 500,
    }
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/lamkayuekenneth/cat-books-highlights",
            "X-Title": "CatBookmark",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:500]
        raise RuntimeError("OpenRouter HTTP %s: %s" % (e.code, body))
    except socket.timeout:
        raise RuntimeError("OpenRouter 回應逾時（120 秒）：model 太慢或暫時繁忙，請稍後再試或轉另一個 model")
    except Exception as e:  # noqa: BLE001
        raise RuntimeError("OpenRouter request failed: %s" % e)


def main():
    if len(sys.argv) < 2:
        print("usage: python3 scripts/analyze.py <image_id>  (base64 由 stdin 輸入)")
        return 1
    image_id = sys.argv[1].strip()
    image_b64 = sys.stdin.read().strip()

    if not image_b64:
        write_result(image_id, {"error": "冇收到圖片資料"})
        return 0

    try:
        with open("config/settings.json", "r", encoding="utf-8") as f:
            settings = json.load(f)
    except Exception as e:
        write_result(image_id, {"error": "讀唔到 config/settings.json: %s" % e})
        return 0

    model = (settings.get("model") or "openai/gpt-4o-mini").strip()
    base_url = (settings.get("base_url") or "https://openrouter.ai/api/v1").strip()
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        write_result(image_id, {"error": "OPENROUTER_API_KEY secret 未設定：請去網頁「設定」頁或 GitHub repo 設定新增"})
        return 0

    # 解碼確認（唔會寫落磁碟）
    debug = {}
    try:
        raw = base64.b64decode(image_b64, validate=True)
        import hashlib
        debug = {
            "b64_len": len(image_b64),
            "bytes": len(raw),
            "mime": detect_mime(image_b64),
            "sha256": hashlib.sha256(raw).hexdigest()[:16],
            "model": model,
        }
        print("DEBUG:", json.dumps(debug, ensure_ascii=False), flush=True)
    except Exception as e:
        write_result(image_id, {"error": "圖片 base64 無效: %s" % e})
        return 0

    try:
        data = call_openrouter(image_b64, model, base_url, api_key)
        content = data["choices"][0]["message"]["content"]
    except Exception as e:  # noqa: BLE001
        write_result(image_id, {"error": str(e)})
        return 0

    parsed = parse_ai_json(content)
    if parsed is None:
        write_result(image_id, {"error": "模型回應無法解析: %s" % (content or "")[:300]})
        return 0

    book_title = str(parsed.get("book_title") or "").strip()
    page = str(parsed.get("page") or "").strip()
    raw_tags = parsed.get("tags")
    if not isinstance(raw_tags, list):
        raw_tags = []
    tags = []
    seen = set()
    for t in raw_tags:
        t = str(t).strip().lstrip("#").strip()
        if t and t not in seen and len(tags) < 30:
            seen.add(t)
            tags.append(t)

    write_result(image_id, {"book_title": book_title, "page": page, "tags": tags, "_debug": debug})
    print("OK: %s -> book_title=%r page=%r tags=%r" % (image_id, book_title, page, tags))
    return 0


if __name__ == "__main__":
    sys.exit(main())
