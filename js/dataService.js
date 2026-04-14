// ============================================================
// dataService.js — データ取得の抽象層
//
// 取得元: 画面共有キャプチャ → POST /api/analyze → OpenAI 解析
//
// stockData の取得は fetchStockData() のみ。
// 画面共有が開始されていない場合は Error をスローする。
// ============================================================

const DataService = (() => {

  // ----------------------------------------------------------
  // 銘柄データ取得 (銘柄更新ボタン押下時)
  // 画面共有が未開始なら Error をスロー。
  // ----------------------------------------------------------
  async function fetchStockData() {
    return await _fetchScreenCaptureData();
  }

  // ----------------------------------------------------------
  // 市場情報取得 — 引き続きモック
  // judgment ロジックの地合いコメントに使用。
  // ----------------------------------------------------------
  async function fetchMarketData() {
    return MockData.getMarketData();
  }

  // ----------------------------------------------------------
  // 画面キャプチャ + OpenAI 解析 → stockData 形式に整形
  // ----------------------------------------------------------
  async function _fetchScreenCaptureData() {
    // Step 1: フレームキャプチャ
    // ScreenShare は app.js (グローバル) に定義済み。
    // この関数はボタン押下時 (全スクリプトロード後) に呼ばれる。
    let base64;
    try {
      base64 = ScreenShare.captureBase64();
    } catch (e) {
      // 「画面共有が開始されていません」等をそのまま上位に伝える
      throw new Error(e.message);
    }

    // Step 2: OpenAI 解析 API に送信
    let res;
    try {
      res = await fetch('/api/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ imageBase64: base64 }),
      });
    } catch (networkErr) {
      throw new Error(`ネットワークエラー: ${networkErr.message}`);
    }

    let analyzed;
    try {
      analyzed = await res.json();
    } catch {
      throw new Error(`解析レスポンスの形式が不正です (HTTP ${res.status})`);
    }

    if (!res.ok) {
      throw new Error(analyzed?.message ?? `画面解析エラー (HTTP ${res.status})`);
    }

    console.log('[DataService] analyzed:', analyzed);

    // Step 3: stockData 形式に整形
    return _shape(analyzed);
  }

  // ----------------------------------------------------------
  // OpenAI 解析結果 → stockData 形式
  //
  // candles は空配列。recentHigh/Low は currentPrice を基準に
  // 推定補完し、logic.js が NaN を出さないようにする。
  // ----------------------------------------------------------
  function _shape(analyzed) {
    const cp = analyzed.currentPrice ?? null;

    return {
      symbol: CFG.SYMBOL,
      name:   CFG.SYMBOL_NAME,

      currentPrice: cp,
      prevClose:    null,
      openPrice:    null,
      dayHigh:      null,
      dayLow:       null,
      volume:       null,

      // OpenAI が読み取った値。取れなければ currentPrice で代替
      vwap: analyzed.vwap ?? cp,
      ma5:  analyzed.ma5  ?? cp,

      // candles なし → _fillFallbacks は走らないため、ここで補完
      // currentPrice ±0.3% (5本相当) / ±0.6% (15本相当) を仮定
      recentHigh5:  cp ? Math.round(cp * 1.003) : null,
      recentLow5:   cp ? Math.round(cp * 0.997) : null,
      recentHigh15: cp ? Math.round(cp * 1.006) : null,
      recentLow15:  cp ? Math.round(cp * 0.994) : null,

      candles:    [],
      fetchedAt:  new Date().toISOString(),
      confidence: analyzed.confidence ?? null,

      prevHigh: null,
      prevLow:  null,
    };
  }

  return { fetchStockData, fetchMarketData };
})();
