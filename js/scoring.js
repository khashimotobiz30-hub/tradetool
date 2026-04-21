// ============================================================
// scoring.js — スコアリングエンジン
//
// 毎回の判断を以下の固定パイプラインで構造化する:
//   中間データ (buildIntermediateData)
//     → スコア算出 (computeScores)
//     → 状態分類  (classifyState)
//     → 出力生成  (buildOutput)
//
// Logic.computeJudgment() から呼び出され、結果は
// judgment._scoring として付与される。
// UIは変えず、コンソール + localStorage へのログ保存を優先。
//
// 初期版: ルールベース強め・スコア粗め
// ============================================================

const Scoring = (() => {

  const LOG_KEY = 'mhi_score_log';
  const LOG_MAX = 50;

  // ----------------------------------------------------------
  // プライベートヘルパー (logic.js の IIFE 外から独立実装)
  // ----------------------------------------------------------
  function _highsRising(candles, n) {
    const r = candles.slice(-n);
    for (let i = 1; i < r.length; i++) {
      if (r[i].high < r[i - 1].high) return false;
    }
    return r.length >= 2;
  }

  function _lowsFalling(candles, n) {
    const r = candles.slice(-n);
    for (let i = 1; i < r.length; i++) {
      if (r[i].low > r[i - 1].low) return false;
    }
    return r.length >= 2;
  }

  function _isVolumeLow(candles) {
    if (candles.length < 4) return false;
    const vols  = candles.map(c => c.volume);
    const avg10 = vols.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, vols.length);
    const avg3  = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
    return avg3 < avg10 * (CFG.VOLUME_DOWN_RATIO || 0.70);
  }

  function _isVolumeHigh(candles) {
    if (candles.length < 4) return false;
    const vols  = candles.map(c => c.volume);
    const avg10 = vols.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, vols.length);
    const avg3  = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
    return avg3 > avg10 * (CFG.VOLUME_UP_RATIO || 1.20);
  }

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function _r1(n)            { return Math.round(n * 10) / 10; }
  function _fmtP(n)          { return n != null ? '¥' + Math.round(n).toLocaleString() : '--'; }


  // ==========================================================
  // 1. 中間データ構造を構築
  // ==========================================================
  function buildIntermediateData(stockData, marketData, position) {
    if (!stockData) return null;

    const cp      = stockData.currentPrice;
    const vwap    = stockData.vwap;
    const ma5     = stockData.ma5;
    const candles = stockData.candles || [];
    const rH5     = stockData.recentHigh5;
    const rL5     = stockData.recentLow5;
    const rH15    = stockData.recentHigh15;
    const rL15    = stockData.recentLow15;

    // ── recent_candle_bias: 直近3本の方向性 ──────────────────
    // +1=全陽線 / -1=全陰線 / ±0.5=2対1 / 0=拮抗
    const r3   = candles.slice(-3);
    const bull = r3.filter(c => c.close >= c.open).length;
    const bear = r3.filter(c => c.close <  c.open).length;
    const recentCandleBias =
      bull === 3 ? 1 : bear === 3 ? -1 :
      bull > bear ? 0.5 : bear > bull ? -0.5 : 0;

    // ── ヒゲシグナル (直近1本) ────────────────────────────────
    const lc       = candles[candles.length - 1] || null;
    const lcRange  = lc ? Math.max(lc.high - lc.low, 0.01) : 1;
    const upperWR  = lc ? (lc.high - Math.max(lc.open, lc.close)) / lcRange : 0;
    const lowerWR  = lc ? (Math.min(lc.open, lc.close) - lc.low)   / lcRange : 0;
    const upperWickSignal = upperWR > 0.35;  // 上ヒゲ35%超 = 売り圧力
    const lowerWickSignal = lowerWR > 0.35;  // 下ヒゲ35%超 = 買い支え

    // ── micro_structure: 高安の切り上がり/切り下がり ──────────
    const highsRising = _highsRising(candles, 5);
    const lowsFalling = _lowsFalling(candles, 5);
    // +1=上昇構造 / -1=下降構造 / 0=混在
    const microStructure =
      ( highsRising && !lowsFalling) ?  1 :
      (!highsRising &&  lowsFalling) ? -1 : 0;

    // ── above_ma: VWAP・5MA 両方に対する現在値位置 ────────────
    const aboveVwap = cp > vwap;
    const aboveMa5  = cp > ma5;
    const aboveMa   = ( aboveVwap &&  aboveMa5) ?  1
                    : (!aboveVwap && !aboveMa5) ? -1 : 0;

    // ── zone_type: 15本レンジ内の位置 ─────────────────────────
    const sessionRange = Math.max(rH15 - rL15, 1);
    const pricePos     = (cp - rL15) / sessionRange;
    const zoneType     = pricePos > 0.70 ? 'high' : pricePos < 0.30 ? 'low' : 'mid';

    // ── ブレイク関連 ───────────────────────────────────────────
    const recentHighBreak  = cp > rH5;
    const recentLowBreak   = cp < rL5;
    const invalidOfs       = CFG.BREAKOUT_INVALIDATE_OFFSET || 3;
    const breakHoldSuccess = recentHighBreak && cp > rH5 - invalidOfs;
    // Short 側のブレイクダウン継続判定 (EQ/classifyState で利用)
    const breakHoldShort   = recentLowBreak  && cp < rL5 + invalidOfs;

    // ── 出来高 ─────────────────────────────────────────────────
    const volHigh = _isVolumeHigh(candles);
    const volLow  = _isVolumeLow(candles);

    // ── 補助フィールド ─────────────────────────────────────────
    const supportLevel  = Math.min(vwap, ma5);
    const resistLevel   = Math.max(vwap, ma5);
    const recentRange5  = Math.max(rH5 - rL5, 1);
    const recentRange15 = Math.max(rH15 - rL15, 1);

    return {
      // ===== 指定フィールド =====
      current_price:      cp,
      prev_close:         null,   // screen sharing では未取得
      open_price:         null,   // screen sharing では未取得
      day_high:           rH15,   // 15本高値で代替
      day_low:            rL15,   // 15本安値で代替
      current_time:       new Date().toISOString(),
      vwap,
      ma5,
      recent_candle_bias: recentCandleBias,
      recent_high_break:  recentHighBreak,
      recent_low_break:   recentLowBreak,
      upper_wick_signal:  upperWickSignal,
      lower_wick_signal:  lowerWickSignal,
      micro_structure:    microStructure,
      above_ma:           aboveMa,
      ask_pressure:       null,   // 板情報: 未取得
      bid_support:        null,   // 板情報: 未取得
      absorption_signal:  null,   // 板情報: 未取得
      zone_type:          zoneType,
      break_hold_success: breakHoldSuccess,
      market_context:     marketData?.marketCondition || null,
      material_context:   null,   // ニュース: 未実装
      position:           position || null,
      // ===== 内部補助フィールド (UI 非表示、_ プレフィックス) =====
      _supportLevel:  supportLevel,
      _resistLevel:   resistLevel,
      _recentRange5:  recentRange5,
      _recentRange15: recentRange15,
      _pricePos:      pricePos,
      _volHigh:       volHigh,
      _volLow:        volLow,
      // 押し目/戻り判定 (classifyState で利用)
      _nearSupport:   Math.abs(cp - supportLevel) <= recentRange5 * 0.30,
      _nearResist:    Math.abs(cp - resistLevel)  <= recentRange5 * 0.30,
      // 直近高値・安値 (buildOutput のトリガー計算用)
      _rH5: rH5,
      _rL5: rL5,
      // ショートブレイクダウン継続判定
      _breakHoldShort: breakHoldShort,
    };
  }


  // ==========================================================
  // 2. スコア算出 (0–10, 小数1桁)
  // ==========================================================
  function computeScores(data) {
    if (!data) return null;

    const {
      above_ma:           am,
      micro_structure:    ms,
      recent_candle_bias: rcb,
      upper_wick_signal:  uws,
      lower_wick_signal:  lws,
      zone_type:          zt,
      break_hold_success: bhs,
      market_context:     mc,
      _volHigh:     vh,
      _volLow:      vl,
      _supportLevel: sup,
      _resistLevel:  res,
      _recentRange5: rng,
      _nearSupport:    nearSup,
      _nearResist:     nearRes,
      _breakHoldShort: bhs_short,
      current_price:   cp,
      position,
    } = data;

    // ── long_strength_score (0–10) ────────────────────────────
    // VWAPと5MA両方の上位 / 高安切り上がり / 陽線継続 / 下ヒゲ / 地合い強 / 出来高増
    let ls = 5.0;
    ls += am  *  2.0;          // +2(両方上) / -2(両方下) / 0(交差)
    ls += ms  *  1.5;          // +1.5(上昇構造) / -1.5(下降構造)
    ls += rcb *  0.8;          // +0.8(全陽線) 〜 -0.8(全陰線)
    if (lws) ls += 0.5;        // 下ヒゲ=買い支えあり
    if (uws) ls -= 0.3;        // 上ヒゲ=売り圧力
    if (vh)  ls += 0.5;        // 出来高増=勢いあり
    if (vl)  ls -= 0.5;        // 出来高減=勢いなし
    if (mc === '強い') ls += 0.5;
    if (mc === '弱い') ls -= 0.5;
    const long_strength_score = _clamp(_r1(ls), 0, 10);

    // ── breakdown_score (0–10) ────────────────────────────────
    // 上記の逆
    let bs = 5.0;
    bs -= am  *  2.0;          // 上にいる→崩れにくい
    bs -= ms  *  1.5;          // 上昇構造→崩れにくい
    bs -= rcb *  0.8;          // 陽線→崩れにくい
    if (uws) bs += 0.5;        // 上ヒゲ=売り圧力=崩れやすい
    if (lws) bs -= 0.3;        // 下ヒゲ=需要あり
    if (vh)  bs += 0.5;        // 出来高増で下落なら崩れ加速
    if (vl)  bs -= 0.5;
    if (mc === '弱い') bs += 0.5;
    if (mc === '強い') bs -= 0.5;
    const breakdown_score = _clamp(_r1(bs), 0, 10);

    // ── location_risk_score (0–10) ────────────────────────────
    // 高値圏でのロング追随 / 安値圏でのショート追随 は場所リスク高い
    let lr = 5.0;
    if (zt === 'high') {
      lr = (am ===  1) ? 7.5 : 4.5;  // 高値圏で上昇中=高リスク / 下落中=まだマシ
    } else if (zt === 'low') {
      lr = (am === -1) ? 7.5 : 4.5;  // 安値圏で下落中=高リスク
    }
    if (vh && zt !== 'mid') lr -= 1.0;  // 出来高の裏付けあれば緩和
    const location_risk_score = _clamp(_r1(lr), 0, 10);

    // ── entry_quality_score (0–10) ───────────────────────────
    // 良い形: 上昇中の押し目 / ブレイク確認 / 下落中の戻り売り
    // ※ nearSup / nearRes は buildIntermediateData で計算済み (_nearSupport/_nearResist)
    let eq = 5.0;

    if      (am ===  1 && nearSup)         eq = 8.5;  // 上昇中に支持帯付近=押し目の形
    else if (bhs)                           eq = 8.0;  // ロングブレイクアウト継続
    else if (bhs_short)                     eq = 8.0;  // ショートブレイクダウン継続
    else if (am ===  1 && zt === 'high')   eq = 3.5;  // 高値圏追いかけロング
    else if (am === -1 && nearRes)         eq = 8.5;  // 下落中に抵抗帯付近=戻り売りの形
    else if (am === -1 && zt === 'low')    eq = 3.5;  // 安値圏追いかけショート

    if (lws && nearSup) eq = Math.min(10, eq + 0.5);  // 下ヒゲで押し目ボーナス
    if (uws && nearRes) eq = Math.min(10, eq + 0.5);  // 上ヒゲで戻り売りボーナス
    const entry_quality_score = _clamp(_r1(eq), 0, 10);

    // ── hold_validity_score (0–10) ───────────────────────────
    // 保有中のみ意味を持つ。ポジション方向と現状の整合性。
    let hv = 5.0;
    if (position && position.status !== 'closed') {
      const basePx = position.avgEntryPrice || position.entryPrice;
      if (position.direction === 'long') {
        hv += am  *  2.0;
        hv += ms  *  0.5;
        if (cp > basePx) hv += 1.0; else hv -= 1.0;
      } else {
        hv -= am  *  2.0;   // ショートはVWAP下が望ましい
        hv -= ms  *  0.5;
        if (cp < basePx) hv += 1.0; else hv -= 1.0;
      }
    }
    const hold_validity_score = _clamp(_r1(hv), 0, 10);

    return {
      long_strength_score,
      breakdown_score,
      location_risk_score,
      entry_quality_score,
      hold_validity_score,
    };
  }


  // ==========================================================
  // 3. 状態分類 → 5状態
  // ==========================================================
  function classifyState(scores, data) {
    const {
      long_strength_score:  ls,
      breakdown_score:      bs,
      location_risk_score:  lr,
      entry_quality_score:  eq,
    } = scores;

    const nearSup = data?._nearSupport || false;
    const nearRes = data?._nearResist  || false;
    const am      = data?.above_ma     ?? 0;

    // 強い初動: どちらかが明確優勢 + 入り形が良い + 場所リスク許容範囲
    if ((ls >= 7.5 || bs >= 7.5) && eq >= 7.0 && lr <= 6.0) return '強い初動';
    // 強い初動 (ブレイク直接判定): break_hold_success で LR 制約をバイパス
    //   ロング: 高値を明確に上抜け + VWAP・5MA 上位 + スコア優勢
    //   ショート: 安値を明確に割り込み + VWAP・5MA 下位 + スコア優勢
    const trueBreakoutLong   = am ===  1 && (data?.break_hold_success || false) && ls >= 7.5 && eq >= 7.0;
    const trueBreakdownShort = am === -1 && (data?._breakHoldShort    || false) && bs >= 7.5 && eq >= 7.0;
    if (trueBreakoutLong || trueBreakdownShort) return '強い初動';

    // 崩れ: ショート方向が強く、ロング方向が明確に弱い
    if (bs >= 7.0 && ls <= 4.0) return '崩れ';

    // 押し目候補:
    //   パターンA: スコアで判定 (ls or bs が十分強く + 入り形が良い)
    //   パターンB: 直接判定 — VWAP・5MA上 かつ サポート接触 (押し中のため ls が抑えられるケース)
    //              or VWAP・5MA下 かつ 抵抗帯接触 (戻り売り候補)
    const pullbackLong  = am ===  1 && nearSup && eq >= 7.0 && lr <= 6.5;
    const pullbackShort = am === -1 && nearRes  && eq >= 7.0 && lr <= 6.5;
    if ((ls >= 6.0 || bs >= 6.0) && eq >= 6.5 && lr <= 6.5) return '押し目候補';
    if (pullbackLong || pullbackShort)                        return '押し目候補';

    // 高値揉み: 場所リスク高 + 入り形が悪い
    if (lr >= 7.0 && eq <= 5.0) return '高値揉み';

    // それ以外: 様子見
    return '様子見';
  }


  // ==========================================================
  // 4. 出力フォーマット生成
  // ==========================================================
  function buildOutput(state, scores, data) {
    const { long_strength_score: ls, breakdown_score: bs } = scores;
    const {
      _supportLevel:  sup,
      _resistLevel:   res,
      _recentRange5:  rng,
      _rH5: rH5,
      _rL5: rL5,
      current_price:  cp,
      day_high, day_low,
      vwap, ma5,
    } = data;

    const isLongBias = ls >= bs;
    const direction =
      ls > bs + 0.5 ? 'ロング' :
      bs > ls + 0.5 ? 'ショート' : '中立';

    // ----------------------------------------------------------
    // Step A: エントリー型を決定
    // ブレイク型判定条件 (ユーザー指定):
    //   Long : cp >= rH5+1 && cp > vwap && cp > ma5
    //   Short: cp <= rL5-1 && cp < vwap && cp < ma5
    // ----------------------------------------------------------
    const isBreakoutLong   = cp >= rH5 + 1 && cp > vwap && cp > ma5;
    const isBreakdownShort = cp <= rL5 - 1 && cp < vwap && cp < ma5;

    let entryType = 'wait';
    if (state === '強い初動') {
      entryType = isLongBias
        ? (isBreakoutLong   ? 'breakout_long'          : 'support_bounce_long')
        : (isBreakdownShort ? 'breakdown_short'         : 'resistance_reject_short');
    } else if (state === '押し目候補') {
      entryType = isLongBias ? 'pullback_long' : 'mean_revert_short';
    } else if (state === '崩れ') {
      entryType = !isLongBias ? 'mean_revert_short' : 'wait';
    }

    // ----------------------------------------------------------
    // Step B: 型ごとのバッファ / 価格計算
    //   ブレイク型  : buf = max(rng×0.12, 3)  ダマシ防止で少し厚め
    //   反発型      : buf = max(rng×0.08, 2)  接触確認重視で薄め
    //   minSep      : ロング・ショート最小分離幅
    // ----------------------------------------------------------
    const bufBreak = Math.max(Math.round(rng * 0.12), 3);
    const bufSmall = Math.max(Math.round(rng * 0.08), 2);
    const minSep   = Math.max(Math.round(rng * 0.25), 10);

    let prices  = { entry: null, stop: null, tp1: null, tp2: null };
    let entryPlan = '';

    // 型ラベル (ログ・デバッグ用)
    const ENTRY_TYPE_LABEL = {
      breakout_long:          'ブレイクアウト型(ロング)',
      support_bounce_long:    'サポート反発型(ロング)',
      pullback_long:          '押し目反発型(ロング)',
      breakdown_short:        'ブレイクダウン型(ショート)',
      resistance_reject_short:'レジスタンス失敗型(ショート)',
      mean_revert_short:      '戻り売り型(ショート)',
      wait:                   '待機',
    };

    // ----------------------------------------------------------
    // Step B: 型ごとの価格計算
    // ----------------------------------------------------------
    switch (entryType) {

      case 'breakout_long': {
        // 根拠: rH5 を上抜けた慣性。引き付けてから入る
        // 損切り: ブレイク水準(rH5)を割り込んだら無効
        const e = rH5 + bufBreak;
        prices    = { entry: e, stop: Math.round(rH5 - rng * 0.15),
                      tp1: Math.round(e + rng * 1.2), tp2: Math.round(e + rng * 2.0) };
        entryPlan = `${_fmtP(rH5)} 超え後の陽線維持 → ロング`;
        break;
      }
      case 'support_bounce_long': {
        // 根拠: VWAP/5MA に接触して反発。素早く入る
        // 損切り: サポート(sup)を割り込んだら無効
        const e = sup + bufSmall;
        prices    = { entry: e, stop: Math.round(sup - rng * 0.30),
                      tp1: Math.round(e + rng * 1.0), tp2: Math.round(e + rng * 1.8) };
        entryPlan = `${_fmtP(sup)} 付近で下ヒゲ陽線 → ロング`;
        break;
      }
      case 'pullback_long': {
        // 根拠: トレンドは上だが今は押し中。サポート到達を待って入る
        // 損切り: サポート(sup)を割り込んだら押し目失敗
        const e = sup + bufSmall;
        prices    = { entry: e, stop: Math.round(sup - rng * 0.30),
                      tp1: Math.round(e + rng * 1.0), tp2: Math.round(e + rng * 1.7) };
        entryPlan = `${_fmtP(sup)}〜${_fmtP(sup + bufSmall * 2)} 到達で下ヒゲ陽線 → ロング`;
        break;
      }
      case 'breakdown_short': {
        // 根拠: rL5 を割り込んだ慣性。引き付けてから入る
        // 損切り: ブレイク水準(rL5)を上回ったら無効
        const e = rL5 - bufBreak;
        prices    = { entry: e, stop: Math.round(rL5 + rng * 0.15),
                      tp1: Math.round(e - rng * 1.2), tp2: Math.round(e - rng * 2.0) };
        entryPlan = `${_fmtP(rL5)} 割れ後の陰線維持 → ショート`;
        break;
      }
      case 'resistance_reject_short': {
        // 根拠: VWAP/5MA に接触して上値を抑えられた
        // 損切り: レジスタンス(res)を上抜けたら無効
        const e = res - bufSmall;
        prices    = { entry: e, stop: Math.round(res + rng * 0.30),
                      tp1: Math.round(e - rng * 1.0), tp2: Math.round(e - rng * 1.8) };
        entryPlan = `${_fmtP(res)} 付近で上ヒゲ陰線 → ショート`;
        break;
      }
      case 'mean_revert_short': {
        // 根拠: 下落トレンド中の戻りでレジスタンスに抑えられる
        // 損切り: レジスタンス(res)を上抜けたら戻り失敗
        const e = res - bufSmall;
        prices    = { entry: e, stop: Math.round(res + rng * 0.30),
                      tp1: Math.round(e - rng * 1.0), tp2: Math.round(e - rng * 1.7) };
        entryPlan = `${_fmtP(res - bufSmall * 2)}〜${_fmtP(res)} 到達で上ヒゲ陰線 → ショート`;
        break;
      }
      default: // wait
        entryPlan = state === '高値揉み' ? `ブレイク確定まで待機`
                  : state === '崩れ'     ? `下げ止まり確認まで待機`
                                         : `ブレイク方向が出るまで待機`;
    }

    const stopLoss = prices.stop != null ? _fmtP(prices.stop) : '−';
    const targets  = prices.tp1 != null
      ? [`①${_fmtP(prices.tp1)}`, `②${_fmtP(prices.tp2)}`] : ['−'];

    // ----------------------------------------------------------
    // Step C: 状態 + 型に応じたテキスト出力
    //         avoid / summary / trigger
    // ----------------------------------------------------------
    let avoid   = [];
    let summary = '';
    let trigger = { long: { entry: '', invalidation: '' }, short: { entry: '', invalidation: '' } };

    switch (state) {

      case '強い初動':
        if (entryType === 'breakout_long') {
          avoid   = [
            `${_fmtP(rH5)} 未確認での追いかけ買い禁止`,
            `VWAP・5MA 下でのロング禁止`,
            `出来高なしの弱い陽線で入らない`,
          ];
          summary = `${_fmtP(rH5)} 超え後の陽線維持を確認して入る`;
          trigger = {
            long:  { entry:        `${_fmtP(rH5)} 超え後の陽線維持 → ロング`,
                     invalidation: `${_fmtP(prices.stop)} 割れ → ロング見送り` },
            short: { entry:        `${_fmtP(rH5)} 上抜け失敗 → ショート検討`,
                     invalidation: `` },
          };
        } else if (entryType === 'support_bounce_long') {
          avoid   = [
            `${_fmtP(sup)} 未達での飛び乗り禁止`,
            `VWAP・5MA 割れでのロング禁止`,
            `出来高なしの小陽線で入らない`,
          ];
          summary = `${_fmtP(sup)} 付近の下ヒゲ陽線を確認して入る`;
          trigger = {
            long:  { entry:        `${_fmtP(sup)} 付近で下ヒゲ陽線 → ロング`,
                     invalidation: `${_fmtP(prices.stop)} 割れ → ロング見送り` },
            short: { entry:        `${_fmtP(res)} 上抜け失敗 → ショート検討`,
                     invalidation: `` },
          };
        } else if (entryType === 'breakdown_short') {
          avoid   = [
            `${_fmtP(rL5)} 未確認での飛び乗り空売り禁止`,
            `VWAP・5MA 上でのショート禁止`,
            `出来高なしの弱い陰線で入らない`,
          ];
          summary = `${_fmtP(rL5)} 割れ後の陰線維持を確認して入る`;
          trigger = {
            long:  { entry:        `${_fmtP(prices.stop)} 上抜け維持 → 様子見`,
                     invalidation: `` },
            short: { entry:        `${_fmtP(rL5)} 割れ後の陰線維持 → ショート`,
                     invalidation: `${_fmtP(prices.stop)} 上抜け → ショート見送り` },
          };
        } else { // resistance_reject_short
          avoid   = [
            `${_fmtP(res)} 上抜け直後の飛び乗りショート禁止`,
            `陽線継続中の逆張り禁止`,
            `上値抑え未確認で入らない`,
          ];
          summary = `${_fmtP(res)} 付近の上ヒゲ陰線を確認して入る`;
          trigger = {
            long:  { entry:        `${_fmtP(prices.stop)} 上抜け維持 → ロング再考`,
                     invalidation: `` },
            short: { entry:        `${_fmtP(res)} 付近で上ヒゲ陰線 → ショート`,
                     invalidation: `${_fmtP(prices.stop)} 上抜け → ショート見送り` },
          };
        }
        break;

      case '押し目候補':
        if (entryType === 'pullback_long') {
          avoid   = [
            `${_fmtP(sup)} 未達での押し途中エントリー禁止`,
            `陰線継続中の逆張り禁止`,
            `反発確認なしの見切り禁止`,
          ];
          summary = `${_fmtP(sup)} 到達を待って反発ローソクを確認して入る`;
          trigger = {
            long:  { entry:        `${_fmtP(sup)} 付近で下ヒゲ陽線 → ロング`,
                     invalidation: `${_fmtP(prices.stop)} 割れ → 押し目失敗` },
            short: { entry:        `${_fmtP(prices.stop)} 割れ出来高増 → ショート検討`,
                     invalidation: `` },
          };
        } else { // mean_revert_short
          avoid   = [
            `${_fmtP(res)} 未達での早まりショート禁止`,
            `陽線継続中の逆張り禁止`,
            `上値抑え未確認で入らない`,
          ];
          summary = `${_fmtP(res)} 到達を待って上値抑えのローソクを確認して入る`;
          trigger = {
            long:  { entry:        `${_fmtP(prices.stop)} 上抜け → ロング検討`,
                     invalidation: `` },
            short: { entry:        `${_fmtP(res)} 付近で上ヒゲ陰線 → ショート`,
                     invalidation: `${_fmtP(prices.stop)} 上抜け → ショート見送り` },
          };
        }
        break;

      case '高値揉み':
        avoid   = [
          `ブレイク未確認の追いかけ買い禁止`,
          `出来高なしの高値更新でロングしない`,
          `ナンピン・根拠なし買い増し禁止`,
        ];
        summary = `${_fmtP(rH5)} 超え or ${_fmtP(rL5)} 割れまで様子見`;
        trigger = {
          long:  { entry:        `${_fmtP(rH5)} 上抜け陽線2本 → ロング検討`,
                   invalidation: `${_fmtP(rL5)} 割れ → ロング見送り` },
          short: { entry:        `${_fmtP(rL5)} 割れ VWAP 下落 → ショート検討`,
                   invalidation: `${_fmtP(rH5)} 上抜け維持 → ショート見送り` },
        };
        break;

      case '崩れ':
        if (entryType === 'mean_revert_short') {
          avoid   = [
            `下落中の逆張りロング禁止`,
            `安値水準での飛び乗りショート禁止`,
            `VWAP・5MA 割れでのロング禁止`,
          ];
          summary = `ロング見送り。${_fmtP(res)} 戻りで上ヒゲ陰線なら → ショート`;
          trigger = {
            long:  { entry:        ``,
                     invalidation: `${_fmtP(prices.stop)} 上抜け維持 → 様子見へ` },
            short: { entry:        `${_fmtP(res)} 付近で上ヒゲ陰線 → ショート`,
                     invalidation: `${_fmtP(prices.stop)} 上抜け → ショート見送り` },
          };
        } else { // wait (ロングバイアスの崩れ)
          avoid   = [
            `下落中の逆張りロング禁止`,
            `反転確認なしの見切りロング禁止`,
            `安値更新中のナンピン禁止`,
          ];
          summary = `ロング見送り。${_fmtP(sup)} 回復陽線維持を確認してから再検討`;
          trigger = {
            long:  { entry:        `${_fmtP(sup)} 回復陽線維持 → ロング再検討`,
                     invalidation: `${_fmtP(rL5)} 割れ継続 → ロング見送り` },
            short: { entry:        `${_fmtP(rL5)} 割れ出来高増 → ショート検討`,
                     invalidation: `` },
          };
        }
        break;

      default: // 様子見
        avoid   = [
          `根拠なしの衝動エントリー禁止`,
          `VWAP 付近での見切り禁止`,
          `ブレイク未確認の追いかけ禁止`,
        ];
        summary = `${_fmtP(rH5)} 上抜け or ${_fmtP(rL5)} 割れで動く`;
        trigger = {
          long:  { entry:        `${_fmtP(rH5)} 上抜け陽線維持 → ロング検討`,
                   invalidation: `${_fmtP(rL5)} 割れ → ロング見送り` },
          short: { entry:        `${_fmtP(rL5)} 割れ陰線継続 → ショート検討`,
                   invalidation: `${_fmtP(rH5)} 上抜け → ショート見送り` },
        };
    }

    const evaluation =
      `LS:${scores.long_strength_score} / BS:${scores.breakdown_score}` +
      ` / LR:${scores.location_risk_score} / EQ:${scores.entry_quality_score}`;

    return {
      state, direction, evaluation, entryPlan, stopLoss, targets,
      avoid, summary, prices, trigger,
      entryType,
      entryTypeLabel: ENTRY_TYPE_LABEL[entryType] || entryType,
    };
  }


  // ==========================================================
  // ログ保存
  // ==========================================================
  function _saveLog(entry) {
    try {
      const list = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      list.push(entry);
      if (list.length > LOG_MAX) list.splice(0, list.length - LOG_MAX);
      localStorage.setItem(LOG_KEY, JSON.stringify(list));
    } catch (_) { /* storage エラーは無視 */ }
  }

  function logAnalysis(result) {
    const entry = {
      timestamp:      new Date().toISOString(),
      state:          result.state,
      direction:      result.output.direction,
      entryType:      result.output.entryType,
      entryTypeLabel: result.output.entryTypeLabel,
      scores:         result.scores,
      prices:         result.output.prices,
      summary:        result.output.summary,
    };

    console.group(`[Scoring] ${result.state} | ${result.output.direction} | ${result.output.entryTypeLabel}`);
    console.log('スコア :', result.scores);
    console.log('エントリー型:', result.output.entryType, '/', result.output.entryTypeLabel);
    console.log('価格  :', result.output.prices);
    console.log('中間データ:', result.data);
    console.log('出力   :', result.output);
    console.groupEnd();

    _saveLog(entry);
    return entry;
  }


  // ==========================================================
  // メインパイプライン
  // ==========================================================
  function analyze(stockData, marketData, position) {
    const data = buildIntermediateData(stockData, marketData, position);
    if (!data) return null;
    const scores = computeScores(data);
    const state  = classifyState(scores, data);
    const output = buildOutput(state, scores, data);
    return { data, scores, state, output };
  }

  return {
    analyze,
    buildIntermediateData,
    computeScores,
    classifyState,
    buildOutput,
    logAnalysis,
  };
})();
