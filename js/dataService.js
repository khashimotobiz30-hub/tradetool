// ============================================================
// dataService.js — データ取得の抽象層
//
// ★ 取得元の切り替えフラグ (優先順):
//   1. USE_MOCK = true          → モック (開発・オフライン)
//   2. USE_SCREEN_CAPTURE = true → 画面キャプチャ + OpenAI 解析
//   3. どちらも false           → Yahoo Finance (api/stock.js 経由)
// ============================================================

const DataService = (() => {

  // ★ true  = モック (開発・オフライン時)
  // ★ false = 実データ (下の USE_SCREEN_CAPTURE で取得元を選択)
  const USE_MOCK = false;

  // ★ true  = 銘柄更新ボタン押下時に画面キャプチャ + OpenAI 解析を使う
  // ★ false = Yahoo Finance (USE_MOCK が false の場合のデフォルト)
  // ※ 画面共有を開始してから「銘柄更新」を押すこと
  const USE_SCREEN_CAPTURE = false;

  // ----------------------------------------------------------
  // 銘柄データ取得 (高頻度: 銘柄更新ボタン押下時)
  // ----------------------------------------------------------
  async function fetchStockData() {
    if (USE_MOCK)           return MockData.getStockData();
    if (USE_SCREEN_CAPTURE) return await fetchScreenCaptureData();
    return await fetchRealStockData();
  }

  // ----------------------------------------------------------
  // 市場・前日情報取得 (低頻度: 市場情報更新ボタン押下時)
  // 一次版: 実装待ちのためモック継続
  // ----------------------------------------------------------
  async function fetchMarketData() {
    return MockData.getMarketData();
  }

  // ----------------------------------------------------------
  // 銘柄データ: Yahoo Finance (api/stock.js 経由)
  // ----------------------------------------------------------
  async function fetchRealStockData() {
    let res;
    try {
      res = await fetch('/api/stock');
    } catch (networkErr) {
      throw new Error(
        `ネットワークエラー: サーバーに接続できません (${networkErr.message})`,
      );
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(
        `サーバーエラー: レスポンスが不正な形式です (HTTP ${res.status})`,
      );
    }

    if (!res.ok) {
      throw new Error(data?.message ?? `株価取得エラー (HTTP ${res.status})`);
    }

    _fillFallbacks(data);
    return data;
  }

  // ----------------------------------------------------------
  // 銘柄データ: 画面キャプチャ + OpenAI 解析 (USE_SCREEN_CAPTURE = true 時)
  //
  // 1. ScreenShare.captureBase64() でフレームを取得
  // 2. POST /api/analyze で OpenAI に送信
  // 3. 返却 JSON を既存 stockData 形式に整形して返す
  // ----------------------------------------------------------
  async function fetchScreenCaptureData() {
    // Step 1: フレームキャプチャ
    // ScreenShare は app.js (グローバル) に定義済み。
    // dataService.js のロードより後に app.js がロードされるが、
    // この関数はボタン押下時 (全スクリプトロード後) に呼ばれるため問題ない。
    let base64;
    try {
      base64 = ScreenShare.captureBase64();
    } catch (e) {
      throw new Error(e.message); // 「画面共有が開始されていません」等
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

    console.log('[DataService] screen capture analyzed:', analyzed);

    // Step 3: stockData 形式に整形
    return _shapeScreenCaptureData(analyzed);
  }

  // ----------------------------------------------------------
  // OpenAI 解析結果 → 既存 stockData 形式に整形
  //
  // candles は空配列のため _fillFallbacks では補完されない。
  // currentPrice を基準に recentHigh/Low を推定し、
  // logic.js が NaN を出さないよう最低限の値を埋める。
  // ----------------------------------------------------------
  function _shapeScreenCaptureData(analyzed) {
    const cp = analyzed.currentPrice ?? null;

    const data = {
      symbol: CFG.SYMBOL,
      name:   CFG.SYMBOL_NAME,

      currentPrice: cp,
      prevClose:    null,
      openPrice:    null,
      dayHigh:      null,
      dayLow:       null,
      volume:       null,

      vwap: analyzed.vwap ?? (cp ?? null),
      ma5:  analyzed.ma5  ?? (cp ?? null),

      // candles は空配列 (_fillFallbacks はスキップされる)
      candles: [],

      // recentHigh/Low: currentPrice ± 小幅 drift で推定
      // 0.3% ≈ 5本分・0.6% ≈ 15本分のレンジを仮定
      recentHigh5:  cp ? Math.round(cp * 1.003) : null,
      recentLow5:   cp ? Math.round(cp * 0.997) : null,
      recentHigh15: cp ? Math.round(cp * 1.006) : null,
      recentLow15:  cp ? Math.round(cp * 0.994) : null,

      fetchedAt: new Date().toISOString(),
      prevHigh:  null,
      prevLow:   null,
    };

    return data;
  }

  // ----------------------------------------------------------
  // null 補完: 足数不足時の graceful degradation
  // candles が存在する限り、利用可能な本数で計算する。
  // (USE_SCREEN_CAPTURE 時は candles = [] なのでスキップされる)
  // ----------------------------------------------------------
  function _fillFallbacks(data) {
    const c = data.candles;
    if (!c || c.length === 0) return;
    const n = c.length;

    if (data.recentHigh5 === null) {
      data.recentHigh5 = Math.max(...c.slice(-Math.min(5, n)).map(x => x.high));
    }
    if (data.recentLow5 === null) {
      data.recentLow5 = Math.min(...c.slice(-Math.min(5, n)).map(x => x.low));
    }
    if (data.recentHigh15 === null) {
      data.recentHigh15 = Math.max(...c.slice(-Math.min(15, n)).map(x => x.high));
    }
    if (data.recentLow15 === null) {
      data.recentLow15 = Math.min(...c.slice(-Math.min(15, n)).map(x => x.low));
    }
    if (data.ma5 === null) {
      const slice = c.slice(-Math.min(5, n));
      const avg   = slice.reduce((s, x) => s + x.close, 0) / slice.length;
      data.ma5    = Math.round(avg * 10) / 10;
    }
  }

  return { fetchStockData, fetchMarketData };
})();
