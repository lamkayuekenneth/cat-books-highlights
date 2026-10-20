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
    "You are an OCR assistant that extracts reading marks from a photo of a book page (vertical or horizontal books both work).\n"
    "Your ONLY job:\n"
    "1. Extract the characters marked with a highlighter (any color; includes text enclosed in a colored box/frame) — INCLUDE the punctuation of the marked text.\n"
    "2. Extract the characters underlined with any pen, pencil or highlighter — INCLUDE the punctuation of the marked text.\n"
    "Each continuous marked run becomes exactly ONE tag. Only clear, continuous marks count: a solid color block covering characters, a complete colored box/frame around characters, or a line drawn over the characters (horizontal book: line below the characters; vertical book: line on the left side of the characters).\n"
    "Do NOT include unmarked text. Do NOT paraphrase, summarize, translate, expand or rewrite — copy the marked characters exactly as printed.\n"
    "If a mark covers a character, read the real character shape beneath it — the mark never changes the character.\n"
    "Do NOT count faint color noise, paper shadows, stains, color bleeding from an adjacent mark, or isolated dots as marks.\n"
    "If the same continuous marked text spans multiple columns, merge the columns into ONE tag.\n"
    "If there are no marks, tags MUST be [].\n"
    "Also return the book title printed on the page (in the header/footer; chapter titles do not count — write an empty string if none) and the printed page number (digits only — write an empty string if none).\n"
    "Output ONLY one JSON object, no other text, in exactly this format:\n"
    '{"book_title": "書名", "page": "頁碼", "tags": ["標記字1", "標記字2"]}'
)

USER_PROMPT = "Extract ONLY the highlighted or underlined characters (including their punctuation) from this book page — one tag per continuous mark. Also include the printed book title (empty string if none; chapter titles do not count) and the printed page number (digits only; empty string if none). If there are no marks, tags = []. Return JSON only in the format {\"book_title\": \"...\", \"page\": \"...\", \"tags\": [\"...\"]}."


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
