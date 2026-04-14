'use strict';
// ============================================================
// api/analyze.js — 画面キャプチャ画像を OpenAI で解析する API
//
// POST /api/analyze
//   body: { imageBase64: string }  ← JPEG の base64 文字列 (data: prefix なし)
//   返却: { currentPrice, vwap, ma5, confidence }
//
// 環境変数: OPENAI_API_KEY
// ============================================================

const OpenAI = require('openai');

// .env を手動でロード (Vercel は自動、ローカルは dotenv 互換で読む)
// NODE_ENV が production でなければ .env を試みる
if (process.env.NODE_ENV !== 'production') {
  try {
    const fs   = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.match(/^([^#\s][^=]*)=(.*)$/);
        if (m) process.env[m[1].trim()] ??= m[2].trim();
      }
    }
  } catch (_) { /* .env 読み込み失敗は無視 */ }
}

const PROMPT = `この画像は株式取引ツール（マーケットスピード等）の画面です。
画面に表示されている以下の数値を読み取ってください。

- currentPrice : 現在値（円）
- vwap         : VWAP（円）
- ma5          : 5分移動平均（MA5）（円）

必ず以下の JSON 形式のみで返してください。
読み取れない項目は null にしてください。
confidence は "high" / "medium" / "low" のいずれかです。

{
  "currentPrice": 数値 or null,
  "vwap": 数値 or null,
  "ma5": 数値 or null,
  "confidence": "high" or "medium" or "low"
}`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'MethodNotAllowed', message: 'POST のみ対応しています' });
  }

  const { imageBase64 } = req.body ?? {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'BadRequest', message: 'imageBase64 (string) が必要です' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'your_openai_api_key_here') {
    return res.status(503).json({ error: 'ConfigError', message: 'OPENAI_API_KEY が設定されていません' });
  }

  const client = new OpenAI({ apiKey });

  let rawText;
  try {
    const completion = await client.chat.completions.create({
      model:      'gpt-4o-mini',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url:    `data:image/jpeg;base64,${imageBase64}`,
                detail: 'high',
              },
            },
            {
              type: 'text',
              text: PROMPT,
            },
          ],
        },
      ],
    });

    rawText = completion.choices[0].message.content.trim();
    console.log('[api/analyze] OpenAI raw response:', rawText);

  } catch (err) {
    console.error('[api/analyze] OpenAI API error:', err.message);
    return res.status(502).json({ error: 'OpenAIError', message: err.message });
  }

  // JSON ブロック抽出 (```json ... ``` で囲まれている場合にも対応)
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return res.status(422).json({
      error:   'ParseError',
      message: 'レスポンスから JSON を抽出できませんでした',
      raw:     rawText,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return res.status(422).json({
      error:   'ParseError',
      message: 'JSON のパースに失敗しました: ' + e.message,
      raw:     rawText,
    });
  }

  // 数値型バリデーション・正規化
  const result = {
    currentPrice: _toNumOrNull(parsed.currentPrice),
    vwap:         _toNumOrNull(parsed.vwap),
    ma5:          _toNumOrNull(parsed.ma5),
    confidence:   ['high', 'medium', 'low'].includes(parsed.confidence)
                    ? parsed.confidence : 'low',
  };

  return res.status(200).json(result);
};

function _toNumOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}
