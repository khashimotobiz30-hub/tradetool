// ============================================================
// app.js — メインエントリーポイント
// イベントハンドラーとタブ切り替えを管理する
// ============================================================

// ----------------------------------------------------------
// ScreenShare モジュール
// 画面共有 → フレームキャプチャ → 直近1枚を保持
//
// _video  : 非DOM video 要素 (start() 時に生成、プレビューなし)
// _canvas : 非DOM canvas 要素 (drawImage 専用)
// _lastCapture  : 直近キャプチャ { dataUrl, capturedAt }
// _lastAnalysis : 直近解析結果 { currentPrice, vwap, ma5, confidence }
// ----------------------------------------------------------
const ScreenShare = (() => {
  let _stream       = null;
  let _video        = null;
  let _canvas       = null;
  let _lastCapture  = null; // 直近1枚のみ保持
  let _lastAnalysis = null;

  // 共有開始 / 停止に応じてボタン状態を切り替える
  function _setSharing(active) {
    const btnStart = document.getElementById('btn-screen-start');
    const btnStop  = document.getElementById('btn-screen-stop');
    if (btnStart) btnStart.disabled =  active;
    if (btnStop)  btnStop.disabled  = !active;
  }

  // 画面共有開始
  // _video は非DOM 要素として生成し、stream を srcObject にセット
  async function start() {
    try {
      _stream = await navigator.mediaDevices.getDisplayMedia({ video: true });

      if (!_video) {
        _video = document.createElement('video');
        _video.muted      = true;
        _video.playsInline = true;
      }
      _video.srcObject = _stream;
      await _video.play().catch(() => {}); // 非DOM要素のため明示的に play()

      // OS 側から停止された場合も同期して止める
      _stream.getVideoTracks()[0].addEventListener('ended', () => stop());

      _setSharing(true);
      TradeTab.showToast('画面共有を開始しました', 'info');
    } catch (e) {
      if (e.name !== 'NotAllowedError') {
        TradeTab.showToast('画面共有エラー: ' + e.message, 'warn');
      }
    }
  }

  // 共有停止
  function stop() {
    if (_stream) {
      _stream.getTracks().forEach(t => t.stop());
      _stream = null;
    }
    if (_video) _video.srcObject = null;
    _setSharing(false);
    TradeTab.showToast('画面共有を停止しました', 'info');
  }

  // フレームをキャプチャして base64 文字列を返す
  // DataService から呼ばれる。_lastCapture を更新する。
  // 共有未開始・映像未準備の場合は Error をスロー。
  function captureBase64() {
    if (!_stream || !_video) {
      throw new Error('画面共有が開始されていません。先に「共有開始」を押してください。');
    }
    if (_video.videoWidth === 0) {
      throw new Error('画面共有の映像が準備できていません。少し待ってから再試行してください。');
    }

    if (!_canvas) _canvas = document.createElement('canvas');
    _canvas.width  = _video.videoWidth;
    _canvas.height = _video.videoHeight;

    _canvas.getContext('2d').drawImage(_video, 0, 0, _canvas.width, _canvas.height);

    const dataUrl = _canvas.toDataURL('image/jpeg', 0.8);

    // 直近1枚を保持（古いものは自動的に上書き）
    _lastCapture  = { dataUrl, capturedAt: new Date().toISOString() };
    _lastAnalysis = null; // 解析完了後に setLastAnalysis() で更新

    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    console.log('[ScreenShare] captured —', _canvas.width + 'x' + _canvas.height,
                '— bytes:', base64.length);
    return base64;
  }

  // DataService → App 経由で解析結果を保存する
  function setLastAnalysis(analyzed) {
    _lastAnalysis = analyzed ? { ...analyzed } : null;
  }

  // 直近キャプチャ情報を返す（確認モーダル用）
  function getLastCapture() {
    if (!_lastCapture) return null;
    return {
      dataUrl:    _lastCapture.dataUrl,
      capturedAt: _lastCapture.capturedAt,
      analyzed:   _lastAnalysis,
    };
  }

  // render() 再実行後にボタン状態を復元する
  // _attachEventListeners() の末尾から呼ばれる
  function restoreUI() {
    if (_stream !== null) _setSharing(true);
  }

  return { start, stop, captureBase64, setLastAnalysis, getLastCapture, restoreUI };
})();

// ----------------------------------------------------------
// 全角→半角 数値正規化ユーティリティ (グローバル)
// price-input / qty-units など全ての数値入力欄で使用する
// ----------------------------------------------------------
function normalizeNum(s) {
  if (s == null) return '';
  return String(s)
    // 全角数字 ０-９ → 半角
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    // 全角小数点
    .replace(/[．]/g, '.')
    // 全角マイナス・ハイフン各種
    .replace(/[－ー−]/g, '-')
    // 全角プラス
    .replace(/[＋]/g, '+')
    // 全角・半角カンマ、読点 (1,000 形式などを除去)
    .replace(/[，、,]/g, '');
}

const App = (() => {

  let _activeTab = 'trade';

  // ----------------------------------------------------------
  // 初期化
  // ----------------------------------------------------------
  function init() {
    AppState.init();
    // 市場情報はモックで初期化（judgment ロジックの地合いコメントに使用）
    AppState.updateMarketData(MockData.getMarketData());
    _renderActiveTab();
    _setupTabSwitching();
    _setupCursorToEnd();
    _setupQtyStepper();
    _setupNumericNormalization();
    console.log('[MHI Tool] initialized');
  }

  // ----------------------------------------------------------
  // 株数ステッパー: − / ＋ ボタンで 1 ずつ増減
  // DOM を再レンダリングしても委譲イベントで拾えるため init() で1回だけ登録する
  // ----------------------------------------------------------
  function _setupQtyStepper() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.qty-btn');
      if (!btn) return;

      const input = document.getElementById(btn.dataset.target);
      if (!input) return;

      const isPrice = input.classList.contains('price-input');
      const isPlus  = btn.classList.contains('qty-plus');

      if (isPrice) {
        // 価格: 1円刻み、下限 1 円
        const current = parseFloat(input.value) || 0;
        input.value = isPlus ? current + 1 : Math.max(1, current - 1);
      } else {
        // 株数: 1口刻み、下限 1 口
        const current = parseInt(input.value) || 1;
        input.value = isPlus ? current + 1 : Math.max(1, current - 1);
      }

      // 変更を確実に伝えるため input イベントを発火 (編集プレビュー等が購読している場合に有効)
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  // ----------------------------------------------------------
  // 数値入力欄: 全角→半角リアルタイム正規化
  // price-input / price-units / qty-input / qty-units 全てに委譲イベントで対応
  // ----------------------------------------------------------
  function _setupNumericNormalization() {
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (!el.matches(
        'input.price-input, input.price-units, input.qty-input, input.qty-units'
      )) return;

      const raw  = el.value;
      const norm = normalizeNum(raw);
      if (norm === raw) return; // 変更なし → 何もしない

      // カーソル位置を保持して値を書き換える
      // (全角1文字→半角1文字なので削除はほぼないが、カンマ除去で長さが変わる場合に備える)
      const selStart = (typeof el.selectionStart === 'number') ? el.selectionStart : null;
      const removed  = raw.length - norm.length; // 削除された文字数
      el.value = norm;
      if (selStart !== null) {
        try {
          const newPos = Math.max(0, selStart - removed);
          el.setSelectionRange(newPos, newPos);
        } catch (_) { /* type="number" 等で setSelectionRange が使えない場合は無視 */ }
      }
    });
  }

  // ----------------------------------------------------------
  // 価格・株数入力欄: フォーカス時にカーソルを末尾へ移動
  //
  // type="number" は setSelectionRange が使えないため、
  // focusin 時だけ type="text" に切り替えてカーソルを末尾へ。
  // blur で type="number" に戻す。
  // ----------------------------------------------------------
  function _setupCursorToEnd() {
    document.addEventListener('focusin', (e) => {
      const el = e.target;
      if (!el.matches('input.price-input, input.qty-input, input.qty-units')) return;

      const isQty = el.classList.contains('qty-units') || el.classList.contains('qty-input');

      el.type = 'text';

      requestAnimationFrame(() => {
        if (isQty) {
          // 株数欄: 値全体を選択 → そのまま上書き入力できる
          el.select();
        } else {
          // 価格欄: カーソルを末尾へ移動
          const len = el.value.length;
          el.setSelectionRange(len, len);
        }
      });

      el.addEventListener('blur', () => {
        el.type = 'number';
      }, { once: true });
    });
  }

  // ----------------------------------------------------------
  // タブ切り替え
  // ----------------------------------------------------------
  function _setupTabSwitching() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        _switchTab(tab);
      });
    });
  }

  function _switchTab(tab) {
    _activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-content').forEach(el => {
      el.classList.toggle('hidden', el.dataset.tab !== tab);
    });
    _renderActiveTab();
  }

  function _renderActiveTab() {
    if (_activeTab === 'trade') {
      TradeTab.render();
    } else if (_activeTab === 'calendar') {
      CalendarTab.render();
    }
  }

  // ----------------------------------------------------------
  // 銘柄更新ボタン
  // ----------------------------------------------------------
  async function onStockUpdate() {
    AppState.markSessionStart();
    _setLoading('btn-stock-update', true);

    try {
      const stockData = await DataService.fetchStockData();
      AppState.updateStockData(stockData);

      // 解析結果を ScreenShare に保存（「取得画像を確認」モーダル用）
      ScreenShare.setLastAnalysis({
        currentPrice: stockData.currentPrice,
        vwap:         stockData.vwap,
        ma5:          stockData.ma5,
        confidence:   stockData.confidence,
      });

      // 判断再計算
      const state    = AppState.get();
      const judgment = Logic.computeJudgment(stockData, state.marketData, state.position);
      AppState.updateJudgment(judgment);

    } catch (e) {
      console.error('[App] stock update failed', e);
      TradeTab.showToast('銘柄取得エラー: ' + e.message, 'warn');
    } finally {
      _setLoading('btn-stock-update', false);
      _renderActiveTab();
    }
  }

  // ----------------------------------------------------------
  // 市場情報更新ボタン
  // 現時点はモック取得のみ。将来的にリアルタイム取得に差し替え可能。
  // ----------------------------------------------------------
  async function onMarketUpdate() {
    _setLoading('btn-market-update', true);
    try {
      const marketData = await DataService.fetchMarketData();
      AppState.updateMarketData(marketData);

      // stockData があれば判断を再計算
      const state = AppState.get();
      if (state.stockData) {
        const judgment = Logic.computeJudgment(state.stockData, marketData, state.position);
        AppState.updateJudgment(judgment);
      }
      TradeTab.showToast('市場情報を更新しました', 'info');
    } catch (e) {
      console.error('[App] market update failed', e);
      TradeTab.showToast('市場情報エラー: ' + e.message, 'warn');
    } finally {
      _setLoading('btn-market-update', false);
      _renderActiveTab();
    }
  }


  // ----------------------------------------------------------
  // 購入 (ロング)
  // ----------------------------------------------------------
  function onBuy(price, qty, memo) {
    AppState.markSessionStart();
    const state = AppState.get();
    const tradeId = AppState.openLong(
      price, qty,
      state.stockData, state.marketData, state.judgment
    );
    AppState.updatePositionMemo(memo);

    // 判断更新
    const newState = AppState.get();
    const judgment = Logic.computeJudgment(newState.stockData, newState.marketData, newState.position);
    AppState.updateJudgment(judgment);

    _renderActiveTab();
  }

  // ----------------------------------------------------------
  // 空売り (ショート)
  // ----------------------------------------------------------
  function onSellShort(price, qty, memo) {
    AppState.markSessionStart();
    const state = AppState.get();
    AppState.openShort(
      price, qty,
      state.stockData, state.marketData, state.judgment
    );
    AppState.updatePositionMemo(memo);

    const newState = AppState.get();
    const judgment = Logic.computeJudgment(newState.stockData, newState.marketData, newState.position);
    AppState.updateJudgment(judgment);

    _renderActiveTab();
  }

  // ----------------------------------------------------------
  // 買い増し / 売り増し (同一 trade_id)
  // ----------------------------------------------------------
  function onAddToPosition(price, qty) {
    const state = AppState.get();
    AppState.addToPosition(price, qty, state.stockData, state.marketData, state.judgment);

    // 判断再計算 (avgEntryPrice が変わったので出口条件を更新)
    const newState = AppState.get();
    const judgment = Logic.computeJudgment(newState.stockData, newState.marketData, newState.position);
    AppState.updateJudgment(judgment);

    _renderActiveTab();
  }

  // ----------------------------------------------------------
  // 部分利確
  // ----------------------------------------------------------
  function onPartialExit(price, qty) {
    const state = AppState.get();
    AppState.partialExit(price, qty, state.stockData, state.marketData, state.judgment);

    const newState = AppState.get();
    const judgment = Logic.computeJudgment(newState.stockData, newState.marketData, newState.position);
    AppState.updateJudgment(judgment);

    _renderActiveTab();
  }

  // ----------------------------------------------------------
  // 損切り
  // ----------------------------------------------------------
  function onStopLoss(price, qty) {
    const state = AppState.get();
    AppState.stopLoss(price, qty, state.stockData, state.marketData, state.judgment);

    const newState = AppState.get();
    const judgment = Logic.computeJudgment(newState.stockData, newState.marketData, newState.position);
    AppState.updateJudgment(judgment);

    _renderActiveTab();
  }

  // ----------------------------------------------------------
  // 全決済
  // ----------------------------------------------------------
  function onFullExit(price) {
    const state = AppState.get();
    AppState.fullExit(price, state.stockData, state.marketData, state.judgment);

    const newState = AppState.get();
    const judgment = Logic.computeJudgment(newState.stockData, newState.marketData, newState.position);
    AppState.updateJudgment(judgment);

    _renderActiveTab();
  }

  // ----------------------------------------------------------
  // トレード編集
  // ----------------------------------------------------------
  function onEditTrade(tradeId, updates) {
    const ok = AppState.editTrade(tradeId, updates);
    if (ok) {
      TradeTab.showToast('トレードを修正しました', 'info');
    } else {
      TradeTab.showToast('編集対象が見つかりません', 'warn');
    }
    _renderActiveTab();
  }

  // ----------------------------------------------------------
  // トレード削除
  // ----------------------------------------------------------
  function onDeleteTrade(tradeId) {
    const ok = AppState.deleteTrade(tradeId);
    if (ok) {
      TradeTab.showToast('トレードを削除しました', 'stop');
    }
    _renderActiveTab();
  }

  // ----------------------------------------------------------
  // 終了ボタン
  // ----------------------------------------------------------
  function onEndDay() {
    const state = AppState.get();

    // 稼働開始時刻が未設定の場合、今が開始時刻
    AppState.markSessionStart();

    if (!state.session.sessionStartTime) {
      TradeTab.showToast('銘柄更新を1回以上行ってから終了してください', 'warn');
      return;
    }

    const result = AppState.endDay();
    TradeTab.showEndDayResult(result);

    // カレンダータブも更新済み (endDay 内で saveRecord 済)
  }

  // ----------------------------------------------------------
  // 終了解除 (追加トレード)
  // ----------------------------------------------------------
  function onResumeAfterEnd() {
    AppState.resumeAfterEnd();
    _renderActiveTab();
  }

  // --- ローディング表示 ---
  const _btnLabels = {
    'btn-stock-update':  '銘柄更新',
    'btn-market-update': '市場情報更新',
  };
  function _setLoading(btnId, loading) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled    = loading;
    btn.textContent = loading ? '解析中...' : (_btnLabels[btnId] ?? '更新');
  }

  // DOMContentLoaded で初期化
  document.addEventListener('DOMContentLoaded', init);

  return {
    onStockUpdate, onMarketUpdate,
    onBuy, onSellShort, onAddToPosition,
    onPartialExit, onStopLoss, onFullExit,
    onEditTrade, onDeleteTrade,
    onEndDay, onResumeAfterEnd,
  };
})();
