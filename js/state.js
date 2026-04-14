// ============================================================
// state.js — アプリ状態管理
//
// 状態遷移:
//   monitoring → hold_long / hold_short (購入/空売りボタン)
//   hold_long / hold_short → partial (部分利確)
//   hold_long / hold_short / partial → closed (全決済/損切り)
//   closed → monitoring (次のトレードへ)
//   any → day_ended (終了ボタン)
//   day_ended → monitoring (追加トレード時)
// ============================================================

const AppState = (() => {

  // --- 初期状態 ---
  function createInitialState() {
    return {
      // トレード状態
      status: 'monitoring', // monitoring | hold_long | hold_short | partial | closed | day_ended

      // 保有ポジション (保有中のみ)
      position: null,
      /*
        position: {
          tradeId:          string,
          direction:        'long' | 'short',
          entryPrice:       number,   // 初回建値
          avgEntryPrice:    number,   // 平均建値 (買い増し後に更新)
          entryQty:         number,   // 総建玉数 (買い増し後に加算)
          remainingQty:     number,   // 残株数
          entryTime:        string (ISO),
          splits: [{
            price, qty, type,        // type: 'add'|'partial'|'stop'|'full'
            pnl,                     // add には pnl なし
            time
          }],
          entryStockSnapshot:    object,  // 建て時の銘柄スナップショット
          entryMarketSnapshot:   object,  // 建て時の市場スナップショット
          entryJudgmentSnapshot: object,  // 建て時の判断スナップショット
          memo:             string,
        }
      */

      // 最新取得データ
      stockData:   null,
      marketData:  null,

      // 最新判断
      judgment: null,

      // セッション (当日)
      session: null,
      /*
        session: {
          date:           string,
          sessionStartTime: string | null, // 当日初回ボタン押下
          sessionEndTime:   string | null, // 終了ボタン押下
          trades:         [],              // 完了トレード一覧
          pnl:            number,
          ended:          boolean,
        }
      */
    };
  }

  let _state = createInitialState();

  // --- 初期化: ストレージから復元 ---
  function init() {
    const savedState   = Storage.loadAppState();
    const savedSession = Storage.loadSession();

    if (savedSession) {
      _state.session = savedSession;
    } else {
      _state.session = {
        date:             Storage.todayStr(),
        sessionStartTime: null,
        sessionEndTime:   null,
        trades:           [],
        pnl:              0,
        ended:            false,
      };
    }

    if (savedState) {
      // ページリロード後の状態復元
      _state.status     = savedState.status     || 'monitoring';
      _state.position   = savedState.position   || null;
      _state.stockData  = savedState.stockData  || null;
      _state.marketData = savedState.marketData || null;
    }
  }

  // --- ゲッター ---
  function get() { return _state; }

  // --- セッション開始時刻を記録 (当日初回ボタン押下) ---
  function markSessionStart() {
    if (_state.session.sessionStartTime) return; // すでに記録済み
    _state.session.sessionStartTime = new Date().toISOString();
    _persistSession();
  }

  // --- 銘柄データ更新 ---
  function updateStockData(data) {
    _state.stockData = data;
    _persistState();
  }

  // --- 市場データ更新 ---
  function updateMarketData(data) {
    _state.marketData = data;
    _persistState();
  }

  // --- 判断更新 ---
  function updateJudgment(judgment) {
    _state.judgment = judgment;
    // 判断はストレージ保存不要 (再計算できるため)
  }

  // --- 購入 (ロング建て) ---
  function openLong(price, qty, stockSnap, marketSnap, judgmentSnap) {
    const tradeId = Storage.generateId('T');
    _state.position = {
      tradeId,
      direction:             'long',
      entryPrice:            price,
      avgEntryPrice:         price,
      entryQty:              qty,
      remainingQty:          qty,
      entryTime:             new Date().toISOString(),
      splits:                [],
      entryStockSnapshot:    stockSnap,
      entryMarketSnapshot:   marketSnap,
      entryJudgmentSnapshot: judgmentSnap,
      memo:                  '',
    };
    _state.status = 'hold_long';
    _saveEvent('buy', price, qty, stockSnap, marketSnap, judgmentSnap, tradeId);
    _persistState();
    _persistSession();
    return tradeId;
  }

  // --- 空売り (ショート建て) ---
  function openShort(price, qty, stockSnap, marketSnap, judgmentSnap) {
    const tradeId = Storage.generateId('T');
    _state.position = {
      tradeId,
      direction:             'short',
      entryPrice:            price,
      avgEntryPrice:         price,
      entryQty:              qty,
      remainingQty:          qty,
      entryTime:             new Date().toISOString(),
      splits:                [],
      entryStockSnapshot:    stockSnap,
      entryMarketSnapshot:   marketSnap,
      entryJudgmentSnapshot: judgmentSnap,
      memo:                  '',
    };
    _state.status = 'hold_short';
    _saveEvent('sell_short', price, qty, stockSnap, marketSnap, judgmentSnap, tradeId);
    _persistState();
    _persistSession();
    return tradeId;
  }

  // --- 買い増し / 売り増し (同一 trade_id の追加建玉) ---
  function addToPosition(price, qty, stockSnap, marketSnap, judgmentSnap) {
    const pos = _state.position;
    if (!pos) return;

    // 平均建値の再計算
    const prevTotal    = pos.avgEntryPrice * pos.remainingQty;
    const addTotal     = price * qty;
    const newRemaining = pos.remainingQty + qty;
    pos.avgEntryPrice  = Math.round((prevTotal + addTotal) / newRemaining * 10) / 10;

    pos.remainingQty += qty;
    pos.entryQty     += qty;
    pos.splits.push({ price, qty, type: 'add', pnl: null, time: new Date().toISOString() });

    _saveEvent('add_to_position', price, qty, stockSnap, marketSnap, judgmentSnap, pos.tradeId, null);
    _persistState();
    _persistSession();
  }

  // --- 部分利確 ---
  function partialExit(price, qty, stockSnap, marketSnap, judgmentSnap) {
    const pos = _state.position;
    if (!pos) return;
    // 平均建値ベースで損益計算
    const pnl = (pos.direction === 'long')
      ? Math.round((price - pos.avgEntryPrice) * qty)
      : Math.round((pos.avgEntryPrice - price) * qty);

    pos.splits.push({ price, qty, type: 'partial', pnl, time: new Date().toISOString() });
    pos.remainingQty -= qty;
    _state.status = 'partial';

    _saveEvent('partial', price, qty, stockSnap, marketSnap, judgmentSnap, pos.tradeId, pnl);
    _persistState();
    _persistSession();
  }

  // --- 損切り ---
  function stopLoss(price, qty, stockSnap, marketSnap, judgmentSnap) {
    const pos = _state.position;
    if (!pos) return;
    const closeQty = qty || pos.remainingQty;
    const pnl = (pos.direction === 'long')
      ? Math.round((price - pos.avgEntryPrice) * closeQty)
      : Math.round((pos.avgEntryPrice - price) * closeQty);

    pos.splits.push({ price, qty: closeQty, type: 'stop', pnl, time: new Date().toISOString() });
    pos.remainingQty -= closeQty;
    if (pos.remainingQty <= 0) {
      _closePosition(price, closeQty, stockSnap, marketSnap, judgmentSnap);
    }
    _saveEvent('stop', price, closeQty, stockSnap, marketSnap, judgmentSnap, pos.tradeId, pnl);
    _persistState();
    _persistSession();
  }

  // --- 全決済 ---
  function fullExit(price, stockSnap, marketSnap, judgmentSnap) {
    const pos = _state.position;
    if (!pos) return;
    const qty = pos.remainingQty;
    const pnl = (pos.direction === 'long')
      ? Math.round((price - pos.avgEntryPrice) * qty)
      : Math.round((pos.avgEntryPrice - price) * qty);

    pos.splits.push({ price, qty, type: 'full', pnl, time: new Date().toISOString() });
    _closePosition(price, qty, stockSnap, marketSnap, judgmentSnap);
    _saveEvent('full_exit', price, qty, stockSnap, marketSnap, judgmentSnap, pos.tradeId, pnl);
    _persistState();
    _persistSession();
  }

  // --- 終了ボタン処理 ---
  function endDay() {
    _state.session.sessionEndTime = new Date().toISOString();
    _state.session.ended = true;

    // 稼働時間計算
    // ★ sessionStartTime は最初の終了ボタン押下後も維持される (再終了時は上書きしない)
    const start = new Date(_state.session.sessionStartTime || _state.session.sessionEndTime);
    const end   = new Date(_state.session.sessionEndTime);
    const mins  = Math.round((end - start) / 60000);
    _state.session.sessionMinutes = mins;

    // 日次集計
    const summary = _buildDaySummary();
    _state.session.summary = summary;

    // 日次振り返り生成
    const review = _generateReview(summary);
    _state.session.reviewComment = review;

    // コピー用テキスト
    _state.session.copyText = _buildCopyText(summary, review);

    // カレンダーへ保存
    Storage.saveDayRecord({
      date:             _state.session.date,
      sessionStartTime: _state.session.sessionStartTime,
      sessionEndTime:   _state.session.sessionEndTime,
      sessionMinutes:   mins,
      trades:           _state.session.trades,
      pnl:              _state.session.pnl,
      tradeCount:       summary.tradeCount,
      winCount:         summary.winCount,
      lossCount:        summary.lossCount,
      reviewComment:    review,
      memo:             _state.session.memo || '',
    });

    _state.status = 'day_ended';
    _persistState();
    _persistSession();

    // セッション終了後に追加トレードがあれば monitoring に戻す
    if (!_state.position) {
      _state.status = 'day_ended';
    }

    return { summary, review, copyText: _state.session.copyText };
  }

  // 終了後に追加トレードするために監視中に戻す
  function resumeAfterEnd() {
    _state.status = 'monitoring';
    _state.session.ended = false;
    _persistState();
    _persistSession();
  }

  // ----------------------------------------------------------
  // トレード編集 (完了済みトレードの事後修正)
  // ----------------------------------------------------------
  function editTrade(tradeId, updates) {
    const trade = _state.session.trades.find(t => t.tradeId === tradeId);
    if (!trade) return false;

    // 編集可能フィールドを上書き
    if (updates.entryPrice != null) {
      trade.entryPrice    = updates.entryPrice;
      trade.avgEntryPrice = updates.entryPrice; // 手修正時は avgEntryPrice も揃える
    }
    if (updates.entryQty != null) {
      trade.entryQty = updates.entryQty;
      trade.exitQty  = updates.entryQty;
    }
    if (updates.exitPrice != null) {
      trade.exitPrice = updates.exitPrice;
      // 最後の決済 split の価格も更新 (表示の一貫性)
      const exitSplit = [...trade.splits].reverse().find(s => s.type === 'full' || s.type === 'stop' || s.type === 'partial');
      if (exitSplit) exitSplit.price = updates.exitPrice;
    }
    if (updates.memo != null) trade.memo = updates.memo;

    // 損益を再計算 (平均建値 × 決済価格 × 株数ベース)
    const base = trade.avgEntryPrice || trade.entryPrice;
    const exit = trade.exitPrice;
    const qty  = trade.entryQty;
    trade.totalPnl = trade.direction === 'long'
      ? Math.round((exit - base) * qty)
      : Math.round((base - exit) * qty);

    // セッション損益を再集計
    _recalcSessionPnl();
    return true;
  }

  // トレード削除 (trade_id 単位)
  function deleteTrade(tradeId) {
    const idx = _state.session.trades.findIndex(t => t.tradeId === tradeId);
    if (idx === -1) return false;

    _state.session.trades.splice(idx, 1);
    _recalcSessionPnl();
    return true;
  }

  // セッション損益の再集計 + 永続化 + カレンダー更新 (共通)
  function _recalcSessionPnl() {
    _state.session.pnl = _state.session.trades.reduce((s, t) => s + t.totalPnl, 0);
    _persistSession();

    // 終了済み日の場合はカレンダーレコードも更新
    if (_state.session.ended || _state.status === 'day_ended') {
      const summary = _buildDaySummary();
      const review  = _generateReview(summary);
      _state.session.reviewComment = review;
      Storage.saveDayRecord({
        date:             _state.session.date,
        sessionStartTime: _state.session.sessionStartTime,
        sessionEndTime:   _state.session.sessionEndTime,
        sessionMinutes:   _state.session.sessionMinutes || 0,
        trades:           _state.session.trades,
        pnl:              _state.session.pnl,
        tradeCount:       summary.tradeCount,
        winCount:         summary.winCount,
        lossCount:        summary.lossCount,
        reviewComment:    review,
        memo:             _state.session.memo || '',
      });
    }
  }

  // --- メモ更新 ---
  function updatePositionMemo(memo) {
    if (_state.position) {
      _state.position.memo = memo;
      _persistState();
    }
  }

  function updateSessionMemo(memo) {
    _state.session.memo = memo;
    _persistSession();
  }

  // --- 内部: ポジションクローズ ---
  function _closePosition(exitPrice, exitQty, stockSnap, marketSnap, judgmentSnap) {
    const pos = _state.position;

    // 決済イベントのみの pnl 合算 (add_to_position は除く)
    const totalPnl = pos.splits
      .filter(s => s.type !== 'add')
      .reduce((sum, s) => sum + (s.pnl || 0), 0);
    const holdingMs = Date.now() - new Date(pos.entryTime).getTime();
    const holdingMinutes = Math.round(holdingMs / 60000);

    const tradeRecord = {
      tradeId:           pos.tradeId,
      direction:         pos.direction,
      entryPrice:        pos.entryPrice,
      avgEntryPrice:     pos.avgEntryPrice,
      entryQty:          pos.entryQty,
      entryTime:         pos.entryTime,
      exitPrice:         exitPrice,
      exitQty:           pos.entryQty,
      exitTime:          new Date().toISOString(),
      splits:            pos.splits,
      totalPnl,
      holdingMinutes,
      status:            'closed',
      // 建て時スナップショット
      entryStockSnapshot:    pos.entryStockSnapshot,
      entryMarketSnapshot:   pos.entryMarketSnapshot,
      entryJudgmentSnapshot: pos.entryJudgmentSnapshot,
      // 決済時スナップショット
      exitStockSnapshot:    stockSnap,
      exitMarketSnapshot:   marketSnap,
      exitJudgmentSnapshot: judgmentSnap,
      memo:                 pos.memo,
    };

    _state.session.trades.push(tradeRecord);
    _state.session.pnl += totalPnl;
    _state.position = null;
    _state.status = 'monitoring';
  }

  // --- 内部: イベントログ保存 ---
  function _saveEvent(type, price, qty, stockSnap, marketSnap, judgmentSnap, tradeId, pnl = null) {
    Storage.appendEvent({
      eventId:    Storage.generateId('E'),
      tradeId:    tradeId || null,
      type,
      timestamp:  new Date().toISOString(),
      price,
      qty,
      direction:  _state.position?.direction || null,
      remainingQty: _state.position ? _state.position.remainingQty - (type === 'buy' || type === 'sell_short' ? 0 : qty) : 0,
      pnl,
      stockSnapshot:    stockSnap,
      marketSnapshot:   marketSnap,
      judgmentSnapshot: judgmentSnap,
    });
  }

  // --- 内部: 日次集計 ---
  function _buildDaySummary() {
    const trades = _state.session.trades;
    const tradeCount = trades.length;
    const winCount  = trades.filter(t => t.totalPnl > 0).length;
    const lossCount = trades.filter(t => t.totalPnl < 0).length;
    const evenCount = tradeCount - winCount - lossCount;

    const totalPnl  = _state.session.pnl;
    const winRate   = tradeCount > 0 ? Math.round((winCount / tradeCount) * 100) : 0;
    const avgWin    = winCount  > 0 ? Math.round(trades.filter(t => t.totalPnl > 0).reduce((s, t) => s + t.totalPnl, 0) / winCount)  : 0;
    const avgLoss   = lossCount > 0 ? Math.round(trades.filter(t => t.totalPnl < 0).reduce((s, t) => s + t.totalPnl, 0) / lossCount) : 0;

    const longTrades  = trades.filter(t => t.direction === 'long');
    const shortTrades = trades.filter(t => t.direction === 'short');

    return {
      tradeCount, winCount, lossCount, evenCount,
      totalPnl, winRate, avgWin, avgLoss,
      longPnl:   longTrades.reduce( (s, t) => s + t.totalPnl, 0),
      shortPnl:  shortTrades.reduce((s, t) => s + t.totalPnl, 0),
      longCount: longTrades.length,
      shortCount: shortTrades.length,
      sessionMinutes: _state.session.sessionMinutes,
    };
  }

  // --- 内部: 日次振り返り生成 ---
  function _generateReview(summary) {
    if (summary.tradeCount === 0) {
      return 'トレードなし。相場を観察した日。';
    }

    const lines = [];
    if (summary.winRate >= 70) {
      lines.push(`勝率 ${summary.winRate}% と高い。判断の精度が良かった。`);
    } else if (summary.winRate >= 50) {
      lines.push(`勝率 ${summary.winRate}%。安定した結果。`);
    } else {
      lines.push(`勝率 ${summary.winRate}%。エントリー条件の見直しを検討。`);
    }

    if (summary.totalPnl > 0) {
      lines.push(`日次損益 +¥${summary.totalPnl.toLocaleString()}。利益確定できた。`);
    } else if (summary.totalPnl < 0) {
      lines.push(`日次損益 ¥${summary.totalPnl.toLocaleString()}。損切りルールを振り返る。`);
    }

    if (summary.avgWin > 0 && summary.avgLoss < 0) {
      const rr = Math.abs(summary.avgWin / summary.avgLoss).toFixed(1);
      lines.push(`平均リスクリワード比 ${rr}。${parseFloat(rr) >= 1.5 ? '良好。' : '改善余地あり。'}`);
    }

    if (summary.sessionMinutes > 0) {
      lines.push(`稼働時間 ${summary.sessionMinutes} 分。`);
    }

    return lines.join(' ');
  }

  // --- 内部: コピー用テキスト ---
  function _buildCopyText(summary, review) {
    const s = _state.session;
    const d = s.date;
    const trades = s.trades;

    let text = `【${d} デイトレ記録 (三菱重工 7011)】\n`;
    text += `稼働: ${_fmtTime(s.sessionStartTime)} ～ ${_fmtTime(s.sessionEndTime)} (${s.sessionMinutes}分)\n`;
    text += `損益合計: ${summary.totalPnl >= 0 ? '+' : ''}¥${summary.totalPnl.toLocaleString()}\n`;
    text += `取引: ${summary.tradeCount}回 勝:${summary.winCount} 負:${summary.lossCount} 勝率:${summary.winRate}%\n\n`;

    trades.forEach((t, i) => {
      const dir = t.direction === 'long' ? 'ロング' : 'ショート';
      const pnl = t.totalPnl >= 0 ? `+¥${t.totalPnl}` : `¥${t.totalPnl}`;
      text += `${i + 1}. ${dir} ¥${t.entryPrice}×${t.entryQty}株 → ¥${t.exitPrice} ${pnl} (${t.holdingMinutes}分)\n`;
    });

    text += `\n【振り返り】\n${review}`;
    return text;
  }

  function _fmtTime(iso) {
    if (!iso) return '--:--';
    return iso.slice(11, 16);
  }

  // --- 永続化 ---
  function _persistState() {
    Storage.saveAppState({
      status:     _state.status,
      position:   _state.position,
      stockData:  _state.stockData,
      marketData: _state.marketData,
    });
  }

  function _persistSession() {
    Storage.saveSession(_state.session);
  }

  return {
    init, get,
    markSessionStart,
    updateStockData, updateMarketData, updateJudgment,
    openLong, openShort, addToPosition,
    partialExit, stopLoss, fullExit,
    editTrade, deleteTrade,
    endDay, resumeAfterEnd,
    updatePositionMemo, updateSessionMemo,
  };
})();
