'use strict';
// ============================================================
// api/analyze.js — 画面キャプチャ画像を OpenAI で解析する API
//
// POST /api/analyze
//   body: { imageBase64: string, mode?: 'price' | 'commentary' }
//
//   mode='price' (デフォルト):
//     返却: { currentPrice, vwap, ma5, confidence }
//
//   mode='commentary':
//     返却: { situation, judgment, reason, entryCondition, confidence }
//
// 環境変数: OPENAI_API_KEY
// ============================================================

const OpenAI = require('openai');

// .env を手動でロード (Vercel は自動、ローカルは dotenv 互換で読む)
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

// ----------------------------------------------------------
// mode='price' : 数値抽出プロンプト
// ----------------------------------------------------------
const PROMPT_PRICE = `この画像は株式取引ツール（マーケットスピード等）の画面です。
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

// ----------------------------------------------------------
// mode='commentary' : AI市場見解プロンプト
// ----------------------------------------------------------
const PROMPT_COMMENTARY = `あなたは日本株デイトレードの補助AIです。
この画像は株式取引ツール（マーケットスピード等）の画面です。
板情報・チャート・直近の価格推移が表示されています。

以下の観点で分析し、実戦向けの短い見解を JSON 形式のみで返してください。

分析観点:
1. 板の上下の厚み・買い板と売り板のバランス
2. 直近のチャートの流れ（上昇 / 下落 / 横ばい / 反転兆候）
3. 現在値付近の需給・節目の有無

返却 JSON フォーマット:
{
  "situation":      "板とチャートの現状を1〜2文で簡潔に説明",
  "judgment":       "long" または "short" または "pass",
  "reason":         "判断理由を50字以内で",
  "entryCondition": "エントリー条件または待つべき条件を50字以内で",
  "confidence":     "high" または "medium" または "low"
}

ルール:
- 必ず日本語で返答すること
- JSON のみ返す（前後の説明文・コードブロック記号は不要）
- 画像が不鮮明・情報不足で判断困難な場合は judgment: "pass"、confidence: "low" にする
- 各フィールドは必ず文字列で返す（null は使用しない）`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'MethodNotAllowed', message: 'POST のみ対応しています' });
  }

  const { imageBase64, mode = 'price' } = req.body ?? {};

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'BadRequest', message: 'imageBase64 (string) が必要です' });
  }
  if (mode !== 'price' && mode !== 'commentary') {
    return res.status(400).json({ error: 'BadRequest', message: 'mode は "price" または "commentary" です' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'your_openai_api_key_here') {
    return res.status(503).json({ error: 'ConfigError', message: 'OPENAI_API_KEY が設定されていません' });
  }

  const client  = new OpenAI({ apiKey });
  const prompt  = mode === 'commentary' ? PROMPT_COMMENTARY : PROMPT_PRICE;
  // commentary は詳しく読み取るため max_tokens を多めに
  const maxTok  = mode === 'commentary' ? 512 : 256;

  let rawText;
  try {
    const completion = await client.chat.completions.create({
      model:      'gpt-4o-mini',
      max_tokens: maxTok,
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
              text: prompt,
            },
          ],
        },
      ],
    });

    rawText = completion.choices[0].message.content.trim();
    console.log(`[api/analyze] mode=${mode} OpenAI raw:`, rawText);

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

  // --- mode 別にレスポンスを整形 ---
  if (mode === 'commentary') {
    const validJudgments = ['long', 'short', 'pass'];
    const result = {
      situation:      _toStrOrFallback(parsed.situation,      '情報が取得できませんでした'),
      judgment:       validJudgments.includes(parsed.judgment) ? parsed.judgment : 'pass',
      reason:         _toStrOrFallback(parsed.reason,         '判断根拠が取得できませんでした'),
      entryCondition: _toStrOrFallback(parsed.entryCondition, '条件が取得できませんでした'),
      confidence:     ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
    };
    return res.status(200).json(result);
  }

  // mode === 'price'
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

function _toStrOrFallback(v, fallback) {
  if (v == null || v === '') return fallback;
  return String(v).trim();
}
