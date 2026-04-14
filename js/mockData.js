// ============================================================
// mockData.js — モックデータ生成
//
// ★ 実データに差し替える場合:
//   このファイルは不要になります。
//   dataService.js の USE_MOCK フラグを false にして、
//   fetchRealStockData / fetchRealMarketData を実装してください。
// ============================================================

const MockData = (() => {
  // MHI の典型的な価格帯に合わせたベースプライス
  const BASE_PRICE = 2680;

  function rand(range) {
    return (Math.random() - 0.5) * 2 * range;
  }

  // 1分足ローソク足を N 本生成
  function generateCandles(n, basePrice) {
    const candles = [];
    let price = basePrice + rand(20);
    const now = new Date();

    for (let i = n - 1; i >= 0; i--) {
      const t = new Date(now.getTime() - i * 60 * 1000);
      const open = price + rand(3);
      const close = open + rand(5);
      const high = Math.max(open, close) + Math.abs(rand(4));
      const low  = Math.min(open, close) - Math.abs(rand(4));
      const volume = Math.floor(Math.random() * 4000 + 500);
      candles.push({
        time: t.toISOString(),
        open:   Math.round(open  * 10) / 10,
        high:   Math.round(high  * 10) / 10,
        low:    Math.round(low   * 10) / 10,
        close:  Math.round(close * 10) / 10,
        volume,
      });
      price = close;
    }
    return candles;
  }

  // 銘柄データ (高頻度更新対象)
  function getStockData() {
    const candles = generateCandles(CFG.EXTENDED_BARS, BASE_PRICE);
    const prices  = candles.map(c => c.close);
    const maPeriod = CFG.MA_PERIOD;
    const ma5 = prices.slice(-maPeriod).reduce((a, b) => a + b, 0) / maPeriod;

    const currentPrice = candles[candles.length - 1].close + rand(2);
    const vwap = BASE_PRICE + rand(8);

    const recent5  = candles.slice(-CFG.RECENT_BARS);
    const recent15 = candles;

    return {
      symbol:       CFG.SYMBOL,
      name:         CFG.SYMBOL_NAME,
      currentPrice: Math.round(currentPrice * 10) / 10,
      openPrice:    Math.round((BASE_PRICE + rand(15)) * 10) / 10,
      dayHigh:      Math.round((BASE_PRICE + 38 + Math.abs(rand(10))) * 10) / 10,
      dayLow:       Math.round((BASE_PRICE - 28 + rand(5)) * 10) / 10,
      volume:       Math.floor(Math.random() * 400000 + 80000),
      vwap:         Math.round(vwap * 10) / 10,
      ma5:          Math.round(ma5  * 10) / 10,
      candles,
      recentHigh5:  Math.max(...recent5.map(c => c.high)),
      recentLow5:   Math.min(...recent5.map(c => c.low)),
      recentHigh15: Math.max(...recent15.map(c => c.high)),
      recentLow15:  Math.min(...recent15.map(c => c.low)),
      prevClose:    BASE_PRICE - 12,
      prevHigh:     BASE_PRICE + 22,
      prevLow:      BASE_PRICE - 32,
      fetchedAt:    new Date().toISOString(),
    };
  }

  // 市場・前日情報 (低頻度更新対象)
  function getMarketData() {
    const conditions = ['強い', '中立', '弱い'];
    const cond = conditions[Math.floor(Math.random() * 3)];
    const sectorStrengths = ['強め', '中立', '弱め'];
    const sector = sectorStrengths[Math.floor(Math.random() * 3)];

    const commentMap = {
      '強い':  '日経・TOPIXともに上昇。防衛セクターは相対的に堅調。',
      '中立':  '日経は小動き。全体としてほぼ方向感なし。',
      '弱い':  '日経下落。リスクオフ。飛びつき回避・見送り厚めで対応。',
    };

    return {
      nikkei:          { price: 35420 + Math.round(rand(300)), change: Math.round(rand(200)), changeRate: (rand(0.8)).toFixed(2) },
      topix:           { price: 2485  + Math.round(rand(30)),  change: Math.round(rand(20)),  changeRate: (rand(0.6)).toFixed(2) },
      usdJpy:          { price: Math.round((149.8 + rand(1)) * 100) / 100 },
      sectorStrength:  sector,
      marketCondition: cond,
      marketComment:   commentMap[cond],
      fetchedAt:       new Date().toISOString(),
    };
  }

  return { getStockData, getMarketData };
})();
