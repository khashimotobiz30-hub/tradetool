'use strict';
// ============================================================
// api/stock.js — 銘柄データ取得 API ルート (Vercel serverless)
//
// GET /api/stock
//   → lib/providers/yahooFinance.js を呼び出し、整形済みの
//     銘柄データ JSON を返す。
//
// このファイルは「薄いルーター」として保つ。
// 取得・整形ロジックは provider 側に持たせる。
//
// 取得元を差し替えるには:
//   require 先を別プロバイダに変えるだけでよい。
//   返却 JSON の shape は provider 側の責務。
// ============================================================

const {
  fetchStockData,
  YahooFetchError,
  YahooParseError,
} = require('../lib/providers/yahooFinance');

module.exports = async function handler(req, res) {
  // GET のみ受け付ける
  if (req.method !== 'GET') {
    return res.status(405).json({
      error:   'MethodNotAllowed',
      message: 'GET のみ対応しています',
    });
  }

  try {
    const data = await fetchStockData();
    return res.status(200).json(data);

  } catch (err) {
    // ログはサーバー側に出す (フロントには message のみ渡す)
    console.error(`[api/stock] ${err.name}: ${err.message}`);

    if (err instanceof YahooFetchError) {
      // upstream の HTTP status に応じてフロントに返す status を決める
      //   429 → そのまま 429 (Too Many Requests)
      //   401 / 403 → 502 (認証情報は外に出さない)
      //   503 / 接続失敗 → 503
      //   その他 → 502 (Bad Gateway)
      const status =
        err.upstreamStatus === 429 ? 429 :
        err.upstreamStatus === 503 ? 503 :
        502;
      return res.status(status).json({
        error:   err.name,
        message: err.message,
      });
    }

    if (err instanceof YahooParseError) {
      // レスポンス構造の異常 → 422 Unprocessable Entity
      return res.status(422).json({
        error:   err.name,
        message: err.message,
      });
    }

    // 予期しないエラー
    return res.status(500).json({
      error:   'InternalServerError',
      message: err.message || 'サーバー内部エラーが発生しました',
    });
  }
};
