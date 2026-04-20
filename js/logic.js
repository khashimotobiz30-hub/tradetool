// ============================================================
// logic.js — ルールベース判断エンジン
//
// computeJudgment(stockData, marketData, position) を呼ぶと
// 判断オブジェクトを返す。
//
// 閾値はすべて config.js の CFG から取得しているので、
// ここのロジックを変えずに CFG だけで調整できる。
// ============================================================

const Logic = (() => {

  // --- ヘルパー ---
  function fmt(n) { return Math.round(n); }

  function calcMA(values, period) {
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  function isVolumeLow(candles) {
    const vols = candles.map(c => c.volume);
    const avg10 = vols.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, vols.length);
    const avg3  = vols.slice(-3).reduce((a, b) => a + b, 0)  / 3;
    return avg3 < avg10 * CFG.VOLUME_DOWN_RATIO;
  }

  function isVolumeHigh(candles) {
    const vols = candles.map(c => c.volume);
    const avg10 = vols.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, vols.length);
    const avg3  = vols.slice(-3).reduce((a, b) => a + b, 0)  / 3;
    return avg3 > avg10 * CFG.VOLUME_UP_RATIO;
  }

  // 直近 n 本のローソクで高値が切り上がっているか
  function isHighsRising(candles, n) {
    const recent = candles.slice(-n);
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].high < recent[i - 1].high) return false;
    }
    return true;
  }

  // 直近 n 本のローソクで安値が切り下がっているか
  function isLowsFalling(candles, n) {
    const recent = candles.slice(-n);
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].low > recent[i - 1].low) return false;
    }
    return true;
  }

  // 市場鮮度チェック
  function getMarketFreshness(fetchedAt) {
    if (!fetchedAt) return 'unknown';
    const mins = (Date.now() - new Date(fetchedAt).getTime()) / 60000;
    if (mins <= CFG.MARKET_FRESH_MIN) return 'fresh';
    if (mins <= CFG.MARKET_STALE_MIN) return 'stale';
    return 'old';
  }

  function marketFreshnessLabel(freshness) {
    if (freshness === 'fresh')   return '最新';
    if (freshness === 'stale')   return 'やや古い';
    if (freshness === 'old')     return '更新推奨';
    return '未取得';
  }

  // ----------------------------------------------------------
  // メイン: 判断計算
  // ----------------------------------------------------------
  function computeJudgment(stockData, marketData, position) {
    if (!stockData) {
      return {
        state: 'no_data',
        stateLabel: 'データ未取得',
        comment: { situation: '銘柄更新ボタンを押してください。', mainScenario: '', negationCondition: '' },
        computedAt: new Date().toISOString(),
      };
    }

    // 保有中の場合は出口判断を返す
    if (position && position.status !== 'closed') {
      return computeExitJudgment(stockData, marketData, position);
    }

    const judgment = computeEntryJudgment(stockData, marketData);

    // スコアリングエンジンを呼び出して結果を付加
    try {
      if (typeof Scoring !== 'undefined') {
        const scoring = Scoring.analyze(stockData, marketData, position);
        if (scoring) {
          judgment._scoring = scoring;
          Scoring.logAnalysis(scoring);
        }
      }
    } catch (e) {
      console.warn('[Scoring] analyze error:', e);
    }

    return judgment;
  }

  // ----------------------------------------------------------
  // エントリー判断 (ノーポジ時)
  // ----------------------------------------------------------
  function computeEntryJudgment(stockData, marketData) {
    const { currentPrice, vwap, ma5, candles,
            recentHigh5, recentLow5, recentHigh15, recentLow15 } = stockData;

    const recentRange = Math.max(recentHigh5 - recentLow5, 1); // ゼロ除算防止

    // --- トレンド判定 ---
    const aboveVwap    = currentPrice > vwap;
    const aboveMa5     = currentPrice > ma5;
    const vwapAboveMa5 = vwap > ma5;
    const highsRising  = isHighsRising(candles, CFG.RECENT_BARS);
    const lowsFalling  = isLowsFalling(candles, CFG.RECENT_BARS);
    const volumeLow    = isVolumeLow(candles);
    const volumeHigh   = isVolumeHigh(candles);

    const isUptrend   = aboveVwap && aboveMa5 && (highsRising || !lowsFalling);
    const isDowntrend = !aboveVwap && !aboveMa5 && (lowsFalling || !highsRising);

    const marketCond   = marketData?.marketCondition || '中立';
    const freshness    = getMarketFreshness(marketData?.fetchedAt);
    const staleWarning = freshness === 'old' || freshness === 'stale';

    // ----------------------------------------------------------
    // ロング・ショート 両方向プランを常時算出
    // エントリープランパネルで常に両方を表示するための構造。
    // ----------------------------------------------------------
    const supportLevel = Math.min(vwap, ma5);
    const resistLevel  = Math.max(vwap, ma5);

    // ロングプラン
    const longEntry    = fmt(supportLevel);
    const longStop     = fmt(supportLevel - recentRange * CFG.STOP_RANGE_MULT);
    const longTarget1  = fmt(recentHigh5  + recentRange * CFG.TARGET1_RANGE_MULT);
    const longTarget2  = fmt(recentHigh15 + recentRange * CFG.TARGET2_RANGE_MULT * 0.5);
    const longNegation = fmt(supportLevel - CFG.BREAKOUT_INVALIDATE_OFFSET);
    const longReason   = isUptrend
      ? `VWAP(¥${fmt(vwap)})上で上昇継続中。支持帯接触後の反発を狙う。`
      : aboveVwap
        ? `VWAP上をキープ。反発ローソク確認後にエントリー。`
        : `トレンドは下向き。反発時の買い戻し局面に限定して検討。`;

    // ショートプラン
    const shortEntry    = fmt(resistLevel);
    const shortStop     = fmt(resistLevel + recentRange * CFG.STOP_RANGE_MULT);
    const shortTarget1  = fmt(recentLow5  - recentRange * CFG.TARGET1_RANGE_MULT);
    const shortTarget2  = fmt(recentLow15 - recentRange * CFG.TARGET2_RANGE_MULT * 0.5);
    const shortNegation = fmt(resistLevel + CFG.BREAKDOWN_INVALIDATE_OFFSET);
    const shortReason   = isDowntrend
      ? `VWAP(¥${fmt(vwap)})下で下落継続中。戻りが抵抗帯で止まれば空売り。`
      : !aboveVwap
        ? `VWAP下位置。上値が重ければ売り継続。戻り売りを検討。`
        : `トレンドは上向き。高値圏での過熱時の調整局面に限定して検討。`;

    // 総合バイアス (エントリープランパネルの見出しに使用)
    const planSummary = _buildPlanSummary(isUptrend, isDowntrend, volumeLow, aboveVwap, aboveMa5);

    // 両方向プランをまとめたオブジェクト (各 return に展開して付与)
    const entryPlans = {
      planSummary,
      longPlan: {
        entry:        longEntry,
        stopLoss:     longStop,
        takeProfit1:  longTarget1,
        takeProfit2:  longTarget2,
        reason:       longReason,
        invalidation: `¥${longNegation} 割れで無効`,
      },
      shortPlan: {
        entry:        shortEntry,
        stopLoss:     shortStop,
        takeProfit1:  shortTarget1,
        takeProfit2:  shortTarget2,
        reason:       shortReason,
        invalidation: `¥${shortNegation} 超えで無効`,
      },
    };

    // --- 見送り判定 ---
    if (volumeLow && !isUptrend && !isDowntrend) {
      return {
        ...buildPassJudgment(
          '出来高低下・方向感なし',
          stockData, marketData,
          '出来高が平均を下回り、VWAPと5MAが交差付近。方向感が出るまで待機。',
          '出来高が回復し、VWAPと5MAが明確に乖離するまで様子見。',
          '出来高が急増し、明確な方向が出た場合は再判断。',
          staleWarning
        ),
        ...entryPlans,
      };
    }

    // --- ロング判断 ---
    if (isUptrend || (aboveVwap && vwapAboveMa5)) {
      const nearVwap   = Math.abs(currentPrice - vwap) <= recentRange * 0.3;
      const nearMa5    = Math.abs(currentPrice - ma5)  <= recentRange * 0.3;
      const isPullback = nearVwap || nearMa5;
      const isBreakout = currentPrice > recentHigh5 - CFG.BREAKOUT_INVALIDATE_OFFSET;

      let stateLabel, entryTrigger, situation, mainScenario, negationCond;

      if (isPullback) {
        stateLabel   = '押し目買い待ち';
        entryTrigger = `VWAP (¥${fmt(vwap)}) または 5MA (¥${fmt(ma5)}) 接触後の反発確認`;
        situation    = `上昇トレンド継続中。現在値が支持帯 (VWAP/5MA) 付近まで押している局面。`;
        mainScenario = `¥${fmt(supportLevel)}±3 接触後に反発ローソクが確認できれば買い。目標①¥${longTarget1} / ②¥${longTarget2}。`;
        negationCond = `¥${longNegation} を明確に割り込んだらシナリオ無効。見送り継続。`;
      } else if (isBreakout) {
        stateLabel   = 'ブレイク継続待ち';
        entryTrigger = `¥${fmt(recentHigh5)} 超えを維持できるか確認後に追随`;
        situation    = `直近高値 ¥${fmt(recentHigh5)} をブレイク。ブレイク継続か押し返されるかを確認中。`;
        mainScenario = `¥${fmt(recentHigh5)} を割り込まずに推移 (${CFG.BREAKOUT_CONFIRM_BARS}本確認) できれば乗る。目標①¥${longTarget1} / ②¥${longTarget2}。`;
        negationCond = `¥${fmt(recentHigh5 - CFG.BREAKOUT_INVALIDATE_OFFSET)} を割り込んだらダマシ。見送り。`;
      } else {
        stateLabel   = '上昇中・待機';
        entryTrigger = `次の押し目 (VWAP/5MA) を待つ`;
        situation    = `上昇トレンドだが現在値は高値圏。乗りやすい場所ではない。`;
        mainScenario = `一度 VWAP (¥${fmt(vwap)}) または 5MA (¥${fmt(ma5)}) 付近まで押したら改めて買い検討。`;
        negationCond = `¥${longNegation} 割れで上昇トレンド終了とみなす。`;
      }

      return {
        state: 'buy_wait',
        stateLabel,
        trend: 'up',
        longCondition: {
          entryTrigger,
          supportLevel: fmt(supportLevel),
          target1: longTarget1,
          target2: longTarget2,
          stopLoss: longStop,
          negationPrice: longNegation,
        },
        shortCondition: null,
        passReason: null,
        comment: {
          situation:         situation + (staleWarning ? ' ※市場情報が古いため参考値。' : ''),
          mainScenario:      mainScenario + (buildMarketNote(marketCond, freshness, 'long') ? ` ${buildMarketNote(marketCond, freshness, 'long')}` : ''),
          negationCondition: negationCond,
        },
        computedAt: new Date().toISOString(),
        ...entryPlans,
      };
    }

    // --- ショート判断 ---
    if (isDowntrend || (!aboveVwap && !vwapAboveMa5)) {
      const nearVwap    = Math.abs(currentPrice - vwap) <= recentRange * 0.3;
      const nearMa5     = Math.abs(currentPrice - ma5)  <= recentRange * 0.3;
      const isBounce    = nearVwap || nearMa5;
      const isBreakdown = currentPrice < recentLow5 + CFG.BREAKDOWN_INVALIDATE_OFFSET;

      let stateLabel, entryTrigger, situation, mainScenario, negationCond;

      if (isBounce) {
        stateLabel   = '戻り売り候補';
        entryTrigger = `VWAP (¥${fmt(vwap)}) または 5MA (¥${fmt(ma5)}) で戻りが止まる確認後に空売り`;
        situation    = `下降トレンド継続中。現在値が抵抗帯 (VWAP/5MA) 付近まで戻っている局面。`;
        mainScenario = `¥${fmt(resistLevel)}±3 で上値が抑えられたら空売り。目標①¥${shortTarget1} / ②¥${shortTarget2}。`;
        negationCond = `¥${shortNegation} を上抜けたら戻りシナリオ崩れ。見送り。`;
      } else if (isBreakdown) {
        stateLabel   = '安値割れ後の戻り待ち';
        entryTrigger = `¥${fmt(recentLow5)} 割れ後の戻りが VWAP/5MA で抑えられる確認後`;
        situation    = `直近安値 ¥${fmt(recentLow5)} を割り込んだ。ブレイク継続かどうか確認中。`;
        mainScenario = `戻り局面で VWAP (¥${fmt(vwap)}) 付近が抵抗になれば空売り。目標①¥${shortTarget1}。`;
        negationCond = `¥${shortNegation} 超えで下落シナリオ無効。見送り。`;
      } else {
        stateLabel   = '下落中・待機';
        entryTrigger = `次の戻り (VWAP/5MA) を待つ`;
        situation    = `下降トレンドだが現在値は安値圏。乗りやすい場所ではない。`;
        mainScenario = `VWAP (¥${fmt(vwap)}) 付近まで戻ったら改めて空売り検討。`;
        negationCond = `¥${shortNegation} 超えで下降トレンド終了。`;
      }

      return {
        state: 'sell_wait',
        stateLabel,
        trend: 'down',
        longCondition: null,
        shortCondition: {
          entryTrigger,
          resistLevel: fmt(resistLevel),
          target1: shortTarget1,
          target2: shortTarget2,
          stopLoss: shortStop,
          negationPrice: shortNegation,
        },
        passReason: null,
        comment: {
          situation:         situation + (staleWarning ? ' ※市場情報が古いため参考値。' : ''),
          mainScenario:      mainScenario + (buildMarketNote(marketCond, freshness, 'short') ? ` ${buildMarketNote(marketCond, freshness, 'short')}` : ''),
          negationCondition: negationCond,
        },
        computedAt: new Date().toISOString(),
        ...entryPlans,
      };
    }

    // --- デフォルト: 見送り ---
    return {
      ...buildPassJudgment(
        '方向感なし',
        stockData, marketData,
        'VWAPと5MAが交差付近。上下どちらにも傾きにくい状況。',
        '明確な方向が出るまで様子見。焦らず待機が最善。',
        'VWAPと5MAが明確に乖離し、方向が確認できたら再判断。',
        staleWarning
      ),
      ...entryPlans,
    };
  }

  // 総合バイアスを算出するヘルパー
  // aboveVwap / aboveMa5 を使って「両にらみ」の微妙な傾きも表現する
  function _buildPlanSummary(isUptrend, isDowntrend, volumeLow, aboveVwap, aboveMa5) {
    // 出来高不足で方向感なし
    if (volumeLow && !isUptrend && !isDowntrend) {
      return { bias: 'neutral', label: '様子見（出来高不足）' };
    }
    // 明確な上昇トレンド
    if (isUptrend  && !isDowntrend) return { bias: 'long',       label: 'ロング優勢' };
    // 明確な下降トレンド
    if (isDowntrend && !isUptrend)  return { bias: 'short',      label: 'ショート優勢' };

    // どちらのトレンド条件も満たさない「中間域」= 両にらみ
    // VWAP・5MA の位置関係でやや方向を示す
    if (aboveVwap && aboveMa5)    return { bias: 'both_long',  label: '両にらみ（やや買い優勢）' };
    if (!aboveVwap && !aboveMa5)  return { bias: 'both_short', label: '両にらみ（やや売り優勢）' };
    // VWAP と5MA が食い違う（交差直前・直後）
    return { bias: 'both', label: '両にらみ（中立）' };
  }

  // ----------------------------------------------------------
  // 出口判断 (保有中)
  // ----------------------------------------------------------
  function computeExitJudgment(stockData, marketData, position) {
    const { currentPrice, vwap, ma5, recentHigh5, recentLow5 } = stockData;
    const { direction, remainingQty } = position;
    // 買い増し後は平均建値を使う。なければ初回建値にフォールバック
    const basePrice = position.avgEntryPrice || position.entryPrice;

    const priceDiff  = direction === 'long'
      ? currentPrice - basePrice
      : basePrice - currentPrice;
    const unrealizedPnl = Math.round(priceDiff * remainingQty);
    const pnlRate = ((priceDiff / basePrice) * 100).toFixed(2);

    const recentRange = recentHigh5 - recentLow5;

    let target1, target2, stopLoss, defensiveLine, escapeLine;
    let exitComment = {};

    if (direction === 'long') {
      target1       = fmt(basePrice + recentRange * CFG.TARGET1_RANGE_MULT);
      target2       = fmt(basePrice + recentRange * CFG.TARGET2_RANGE_MULT);
      stopLoss      = fmt(basePrice - recentRange * CFG.STOP_RANGE_MULT);
      defensiveLine = fmt(basePrice); // 平均建値防衛
      escapeLine    = fmt(Math.min(vwap, ma5) - CFG.BREAKOUT_INVALIDATE_OFFSET);

      exitComment = {
        situation:         `ロング保有中。平均建値 ¥${fmt(basePrice)} から ${priceDiff >= 0 ? '+' : ''}¥${fmt(priceDiff)} (${pnlRate > 0 ? '+' : ''}${pnlRate}%)。`,
        mainScenario:      `¥${target1} で第1利確 (半分)。残りは ¥${target2} まで引っ張る。VWAPが下支えしているうちは保持。`,
        negationCondition: `¥${escapeLine} 割れで逃げ優先。VWAPと5MAを両方割ったら損切り検討。`,
      };
    } else {
      target1       = fmt(basePrice - recentRange * CFG.TARGET1_RANGE_MULT);
      target2       = fmt(basePrice - recentRange * CFG.TARGET2_RANGE_MULT);
      stopLoss      = fmt(basePrice + recentRange * CFG.STOP_RANGE_MULT);
      defensiveLine = fmt(basePrice);
      escapeLine    = fmt(Math.max(vwap, ma5) + CFG.BREAKOUT_INVALIDATE_OFFSET);

      exitComment = {
        situation:         `ショート保有中。平均建値 ¥${fmt(basePrice)} から ${priceDiff >= 0 ? '+' : ''}¥${fmt(priceDiff)} (${pnlRate > 0 ? '+' : ''}${pnlRate}%)。`,
        mainScenario:      `¥${target1} で第1利確 (半分)。残りは ¥${target2} まで引っ張る。VWAPが上値を抑えているうちは保持。`,
        negationCondition: `¥${escapeLine} 超えで逃げ優先。VWAPと5MAを両方超えたら損切り検討。`,
      };
    }

    return {
      state: direction === 'long' ? 'hold_long' : 'hold_short',
      stateLabel: direction === 'long' ? '保有中 (ロング)' : '保有中 (ショート)',
      trend: direction === 'long' ? 'up' : 'down',
      unrealizedPnl,
      pnlRate,
      exitLevels: { target1, target2, stopLoss, defensiveLine, escapeLine },
      comment: exitComment,
      computedAt: new Date().toISOString(),
    };
  }

  // --- 見送り判断ビルダー ---
  function buildPassJudgment(reason, stockData, marketData, situation, mainScenario, negationCond, staleWarning) {
    return {
      state: 'pass',
      stateLabel: '見送り',
      trend: 'range',
      longCondition: null,
      shortCondition: null,
      passReason: reason,
      comment: {
        situation:         situation + (staleWarning ? ' ※市場情報が古いため参考値。' : ''),
        mainScenario,
        negationCondition: negationCond,
      },
      computedAt: new Date().toISOString(),
    };
  }

  // --- 地合いコメント付加 ---
  function buildMarketNote(cond, freshness, side) {
    if (freshness === 'old') return '※市場情報が60分以上古い。地合い判断は参考値。';
    if (freshness === 'stale') return '※市場情報がやや古い (30分超)。';
    if (!cond || cond === '中立') return '';
    if (cond === '強い' && side === 'long')  return '地合いは強い。ブレイク継続をやや優先してよい。';
    if (cond === '弱い' && side === 'long')  return '地合いが弱い。飛びつき回避。慎重に。';
    if (cond === '強い' && side === 'short') return '地合いは強い。ショートは慎重に。伸びにくい可能性。';
    if (cond === '弱い' && side === 'short') return '地合いが弱い。ショート方向は追い風。';
    return '';
  }

  return { computeJudgment, getMarketFreshness, marketFreshnessLabel };
})();
