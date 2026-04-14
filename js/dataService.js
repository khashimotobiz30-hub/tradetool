// ============================================================
// dataService.js — データ取得の抽象層
//
// ★ 実データへの差し替えポイント:
//   USE_MOCK = false にすると /api/stock (Vercel API ルート) を呼ぶ。
//   モックに戻したい場合は USE_MOCK = true に切り替えるだけでよい。
//
// ★ 市場情報 (fetchMarketData) は一次版ではモック継続。
//   fetchRealMarketData() を実装したら fetchMarketData() 内の
//   TODO コメントを外してください。
// ============================================================

const DataService = (() => {

  // ★ false = 実 API (api/stock.js → Yahoo Finance)
  // ★ true  = モック (開発・オフライン時はここを true に戻す)
  const USE_MOCK = false;

  // ----------------------------------------------------------
  // 銘柄データ取得 (高頻度: 銘柄更新ボタン押下時)
  // ----------------------------------------------------------
  async function fetchStockData() {
    if (USE_MOCK) return MockData.getStockData();
    return await fetchRealStockData();
  }

  // ----------------------------------------------------------
  // 市場・前日情報取得 (低頻度: 市場情報更新ボタン押下時)
  // 一次版: 実装待ちのためモック継続
  // ----------------------------------------------------------
  async function fetchMarketData() {
    // TODO: fetchRealMarketData() を実装したら以下に差し替える
    //   if (USE_MOCK) return MockData.getMarketData();
    //   return await fetchRealMarketData();
    return MockData.getMarketData();
  }

  // ----------------------------------------------------------
  // 銘柄データ: 実 API 呼び出し (api/stock.js 経由)
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

    // JSON パースは ok/ng 判定より先に試みる
    // (エラーレスポンスも JSON で返ってくるため)
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(
        `サーバーエラー: レスポンスが不正な形式です (HTTP ${res.status})`,
      );
    }

    if (!res.ok) {
      // api/stock.js が設定したエラーメッセージを優先して使う
      throw new Error(data?.message ?? `株価取得エラー (HTTP ${res.status})`);
    }

    // ----------------------------------------------------------
    // logic.js は recentHigh/LowN・ma5 が null だと NaN になる。
    // 足数不足時 (取引開始直後など) でも UI が壊れないよう、
    // 利用可能な candles から補完する。
    // ※ provider 側は「データの正確性」で null を返す設計。
    //   ここでは「アプリの動作継続」を優先して補完する。
    // ----------------------------------------------------------
    _fillFallbacks(data);

    return data;
  }

  // ----------------------------------------------------------
  // null 補完: 足数不足時の graceful degradation
  // candles が存在する限り、利用可能な本数で計算する。
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

  // ----------------------------------------------------------
  // 市場情報: 実 API プレースホルダー (未実装)
  // ----------------------------------------------------------
  async function fetchRealMarketData() {
    // TODO: 日経・TOPIX・USD/JPY 等を外部 API から取得して返す
    // 返却する shape は MockData.getMarketData() に合わせること
    throw new Error(
      'fetchRealMarketData() は未実装です。dataService.js を編集してください。',
    );
  }

  return { fetchStockData, fetchMarketData };
})();
