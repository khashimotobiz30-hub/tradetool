// ============================================================
// tradeTab.js — トレードタブ UI
// ============================================================

const TradeTab = (() => {

  // --- 株数ステッパー HTML ヘルパー ---
  // 「− [n] ＋」ウィジェットを生成する。ボタン操作は app.js の委譲イベントが処理する。
  function _qtyStepperHtml(id, value) {
    return `<span class="qty-stepper">
      <button type="button" class="qty-btn qty-minus" data-target="${id}">−</button>
      <input type="number" id="${id}" class="qty-input qty-units" value="${value}" step="1" min="1">
      <button type="button" class="qty-btn qty-plus" data-target="${id}">＋</button>
    </span>`;
  }

  // --- 価格ステッパー HTML ヘルパー ---
  // 「− [価格] ＋」ウィジェットを生成する。1円刻みで増減。
  function _priceStepperHtml(id, value) {
    return `<span class="qty-stepper">
      <button type="button" class="qty-btn price-btn qty-minus" data-target="${id}">−</button>
      <input type="number" id="${id}" class="price-input price-units" value="${value}" step="1">
      <button type="button" class="qty-btn price-btn qty-plus" data-target="${id}">＋</button>
    </span>`;
  }

  // --- フォーマットヘルパー ---
  // 価格入力欄の初期値: 小数点以下を切り捨てた整数を返す
  // 手動入力では引き続き小数を入力できる (step="0.1" は維持しない、入力自由)
  function fmtInitPrice(n) {
    if (n == null || n === '') return '';
    return Math.floor(n);
  }

  // --- 数値読み取りヘルパー (全角→半角正規化込み) ---
  // 全ての parseFloat / parseInt の代わりにこちらを使う
  function readPrice(inputId) {
    const el = document.getElementById(inputId);
    return el ? parseFloat(normalizeNum(el.value)) : NaN;
  }
  function readQtyUnits(inputId) {
    const el = document.getElementById(inputId);
    const units = el ? parseInt(normalizeNum(el.value)) : 0;
    return (units >= 1) ? units * 100 : 0;
  }

  function fmtPrc(n) {
    return n != null ? '¥' + Number(n).toLocaleString() : '--';
  }
  function fmtNum(n) {
    return n != null ? Number(n).toLocaleString() : '--';
  }
  function fmtPnl(n) {
    if (n == null) return '--';
    const sign = n >= 0 ? '+' : '';
    return sign + '¥' + Number(n).toLocaleString();
  }
  function fmtTime(iso) {
    if (!iso) return '--:--:--';
    // UTC ISO 文字列を Asia/Tokyo (JST = UTC+9) の HH:mm:ss に変換して表示
    try {
      return new Date(iso).toLocaleTimeString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        hour:     '2-digit',
        minute:   '2-digit',
        second:   '2-digit',
        hour12:   false,
      });
    } catch (_) {
      return iso.slice(11, 19); // フォールバック (ブラウザが Intl 非対応の場合)
    }
  }
  function fmtDate(iso) {
    if (!iso) return '--';
    return iso.slice(0, 10);
  }

  // --- 鮮度バッジ ---
  function freshnessTag(fetchedAt) {
    const freshness = Logic.getMarketFreshness(fetchedAt);
    const label     = Logic.marketFreshnessLabel(freshness);
    const cls = freshness === 'fresh' ? 'badge-fresh' : freshness === 'stale' ? 'badge-stale' : 'badge-old';
    return `<span class="badge ${cls}">${label}</span>`;
  }

  // ----------------------------------------------------------
  // メインレンダリング
  // ----------------------------------------------------------
  function render() {
    const state    = AppState.get();
    const { status, stockData, marketData, judgment, session, position } = state;

    const root = document.getElementById('trade-tab-content');
    if (!root) return;

    root.innerHTML = `
      ${_renderUpdateArea(stockData)}
      ${_renderJudgmentPanel(status, judgment, stockData, position)}
      ${_renderCommentPanel(judgment)}
      ${_renderOperationPanel(status, stockData, position)}
      ${_renderTradeList(session)}
      ${_renderDaySummary(session)}
      ${_renderEndButton(status)}
    `;

    _attachEventListeners(state);
  }

  // --- 更新エリア ---
  function _renderUpdateArea(stockData) {
    const stockTime  = stockData ? fmtTime(stockData.fetchedAt) : '--:--:--';
    const price      = stockData ? fmtPrc(stockData.currentPrice) : '--';
    const confidence = stockData?.confidence;
    const confBadge  = confidence
      ? `<span class="badge badge-conf-${confidence}">${{ high: '信頼度: 高', medium: '信頼度: 中', low: '信頼度: 低' }[confidence] ?? confidence}</span>`
      : '';

    return `
    <div class="update-area card">
      <div class="update-row">
        <div class="price-display">
          <span class="symbol-name">${CFG.SYMBOL_NAME}（${CFG.SYMBOL}）</span>
          <span class="current-price">${price}</span>
          <span class="source-tag">画面共有</span>
        </div>
        <div class="action-bar">
          <button id="btn-stock-update"  class="btn btn-primary btn-sm">銘柄更新</button>
          <button id="btn-market-update" class="btn btn-secondary btn-sm">市場情報更新</button>
          <button id="btn-screen-start"  class="btn btn-sm btn-screen-start">共有開始</button>
          <button id="btn-screen-stop"   class="btn btn-sm btn-screen-stop" disabled>共有停止</button>
        </div>
      </div>
      <div class="update-meta">
        <span class="update-time">最終: <strong>${stockTime}</strong> ${confBadge}</span>
        ${stockData ? `<button id="btn-show-capture" class="btn-link">取得画像を確認</button>` : ''}
      </div>
      ${stockData ? `
      <div class="stock-sub-info">
        <span>VWAP: ${fmtPrc(stockData.vwap)}</span>
        <span>5MA: ${fmtPrc(stockData.ma5)}</span>
      </div>` : `
      <div class="share-guidance">
        「共有開始」で画面共有を開始してから「銘柄更新」を押すと解析が始まります
      </div>`}
    </div>`;
  }

  // --- 取得画像確認モーダル ---
  function showCaptureModal() {
    const capture = ScreenShare.getLastCapture();

    // 既存モーダルがあれば閉じる
    document.querySelectorAll('.capture-modal-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'capture-modal-overlay';

    let bodyHtml;
    if (!capture) {
      bodyHtml = `<p class="capture-modal-empty">まだ画像が取得されていません。<br>「共有開始」→「銘柄更新」の順に操作してください。</p>`;
    } else {
      const timeStr = fmtTime(capture.capturedAt);
      const a = capture.analyzed;
      const analysisHtml = a
        ? `<table class="capture-analysis-table">
             <tr><th>現在値</th><td>${a.currentPrice != null ? fmtPrc(a.currentPrice) : '--'}</td></tr>
             <tr><th>VWAP</th><td>${a.vwap != null ? fmtPrc(a.vwap) : '--'}</td></tr>
             <tr><th>5MA</th><td>${a.ma5 != null ? fmtPrc(a.ma5) : '--'}</td></tr>
             <tr><th>信頼度</th><td>${a.confidence ?? '--'}</td></tr>
           </table>`
        : `<p class="capture-modal-empty">解析結果なし</p>`;

      bodyHtml = `
        <div class="capture-modal-time">取得時刻: ${timeStr}</div>
        <img class="capture-modal-img" src="${capture.dataUrl}" alt="取得画像">
        <div class="capture-modal-analysis">
          <div class="capture-analysis-title">解析結果</div>
          ${analysisHtml}
        </div>`;
    }

    overlay.innerHTML = `
      <div class="capture-modal-box">
        <div class="capture-modal-header">
          <span class="capture-modal-title">取得画像を確認</span>
          <button class="btn-modal-close" id="btn-capture-close">✕</button>
        </div>
        <div class="capture-modal-body">
          ${bodyHtml}
        </div>
      </div>`;

    document.body.appendChild(overlay);

    document.getElementById('btn-capture-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  // --- 判断パネル ---
  function _renderJudgmentPanel(status, judgment, stockData, position) {
    if (!judgment) {
      return `<div class="card judgment-panel">
        <div class="no-data-msg">画面共有を開始してから「銘柄更新」を押すと判断が表示されます</div>
      </div>`;
    }

    const stateClass = {
      buy_wait:   'state-buy',
      sell_wait:  'state-sell',
      pass:       'state-pass',
      hold_long:  'state-hold-long',
      hold_short: 'state-hold-short',
      no_data:    'state-nodata',
    }[judgment.state] || 'state-nodata';

    let content = '';

    if (judgment.state === 'hold_long' || judgment.state === 'hold_short') {
      // 保有中表示
      const pos = position;
      const ex  = judgment.exitLevels || {};
      const pnlClass = (judgment.unrealizedPnl || 0) >= 0 ? 'pos' : 'neg';

      const hasAdded = pos?.splits?.some(s => s.type === 'add');
      const avgLabel = hasAdded ? `平均建値` : `建値`;

      content = `
        <div class="hold-info">
          <div class="hold-row">
            <span class="label">初回建値</span>
            <span>${fmtPrc(pos?.entryPrice)}</span>
          </div>
          ${hasAdded ? `<div class="hold-row">
            <span class="label">平均建値</span>
            <span class="avg-price">${fmtPrc(pos?.avgEntryPrice)}</span>
          </div>` : ''}
          <div class="hold-row">
            <span class="label">保有</span>
            <span>${fmtNum(pos?.entryQty)}株建て / 残 <strong>${fmtNum(pos?.remainingQty)}株</strong></span>
          </div>
          <div class="hold-row">
            <span class="label">評価損益</span>
            <span class="${pnlClass} pnl-large">${fmtPnl(judgment.unrealizedPnl)} (${judgment.pnlRate >= 0 ? '+' : ''}${judgment.pnlRate}%)</span>
          </div>
        </div>
        <div class="exit-levels">
          <div class="exit-row target">
            <span class="label">第1利確</span>
            <span class="price-val">${fmtPrc(ex.target1)}</span>
          </div>
          <div class="exit-row target">
            <span class="label">第2利確</span>
            <span class="price-val">${fmtPrc(ex.target2)}</span>
          </div>
          <div class="exit-row stop">
            <span class="label">損切りライン</span>
            <span class="price-val">${fmtPrc(ex.stopLoss)}</span>
          </div>
          <div class="exit-row defend">
            <span class="label">${avgLabel}防衛</span>
            <span class="price-val">${fmtPrc(ex.defensiveLine)}</span>
          </div>
          <div class="exit-row escape">
            <span class="label">逃げ優先</span>
            <span class="price-val">${fmtPrc(ex.escapeLine)}</span>
          </div>
        </div>`;

    } else if (judgment.state === 'buy_wait') {
      const lc = judgment.longCondition || {};
      content = `
        <div class="condition-block long-block">
          <div class="cond-title">ロング条件</div>
          <div class="cond-row"><span class="label">エントリー</span><span>${lc.entryTrigger || '--'}</span></div>
          <div class="cond-row"><span class="label">目標①</span><span class="price-val">${fmtPrc(lc.target1)}</span></div>
          <div class="cond-row"><span class="label">目標②</span><span class="price-val">${fmtPrc(lc.target2)}</span></div>
          <div class="cond-row"><span class="label">損切り</span><span class="price-val stop-price">${fmtPrc(lc.stopLoss)}</span></div>
          <div class="cond-row"><span class="label">否定条件</span><span class="neg-price">${fmtPrc(lc.negationPrice)} 割れで無効</span></div>
        </div>
        ${judgment.passReason ? `<div class="pass-reason"><span class="badge badge-pass">見送り追加理由</span> ${judgment.passReason}</div>` : ''}`;

    } else if (judgment.state === 'sell_wait') {
      const sc = judgment.shortCondition || {};
      content = `
        <div class="condition-block short-block">
          <div class="cond-title">ショート条件</div>
          <div class="cond-row"><span class="label">エントリー</span><span>${sc.entryTrigger || '--'}</span></div>
          <div class="cond-row"><span class="label">目標①</span><span class="price-val">${fmtPrc(sc.target1)}</span></div>
          <div class="cond-row"><span class="label">目標②</span><span class="price-val">${fmtPrc(sc.target2)}</span></div>
          <div class="cond-row"><span class="label">損切り</span><span class="price-val stop-price">${fmtPrc(sc.stopLoss)}</span></div>
          <div class="cond-row"><span class="label">否定条件</span><span class="neg-price">${fmtPrc(sc.negationPrice)} 超えで無効</span></div>
        </div>`;

    } else if (judgment.state === 'pass') {
      content = `<div class="pass-reason"><strong>見送り理由:</strong> ${judgment.passReason || '方向感なし'}</div>`;
    } else {
      content = `<div class="no-data-msg">${judgment.comment?.situation || ''}</div>`;
    }

    return `
    <div class="card judgment-panel">
      <div class="judgment-header">
        <span class="state-badge ${stateClass}">${judgment.stateLabel}</span>
        <span class="computed-at">更新時点: ${fmtTime(judgment.computedAt)}</span>
      </div>
      ${content}
    </div>`;
  }

  // --- コメントパネル (現状/メインシナリオ/否定条件) ---
  function _renderCommentPanel(judgment) {
    if (!judgment || !judgment.comment) return '';
    const { situation, mainScenario, negationCondition } = judgment.comment;
    if (!situation && !mainScenario && !negationCondition) return '';

    return `
    <div class="card comment-panel">
      <div class="comment-row">
        <span class="comment-label">現状</span>
        <span class="comment-text">${situation || '--'}</span>
      </div>
      <div class="comment-row">
        <span class="comment-label scenario">メインシナリオ</span>
        <span class="comment-text">${mainScenario || '--'}</span>
      </div>
      <div class="comment-row">
        <span class="comment-label negation">否定条件</span>
        <span class="comment-text">${negationCondition || '--'}</span>
      </div>
    </div>`;
  }

  // --- 操作パネル ---
  function _renderOperationPanel(status, stockData, position) {
    const currentPrice = stockData ? stockData.currentPrice : '';
    const defaultLot = CFG.DEFAULT_LOT;

    if (status === 'day_ended') {
      return `
      <div class="card operation-panel">
        <div class="ended-msg">本日の取引は終了済みです。追加トレードする場合は下の「追加トレード」ボタンを押してください。</div>
        <button id="btn-resume" class="btn btn-secondary">追加トレード (終了を解除)</button>
      </div>`;
    }

    if (status === 'monitoring' || status === 'closed') {
      return `
      <div class="card operation-panel">
        <div class="op-title">売買操作</div>
        <div class="op-row">
          <label>価格 ${_priceStepperHtml('op-price', fmtInitPrice(currentPrice))}</label>
          <label>株数(100株単位) ${_qtyStepperHtml('op-qty', 1)}</label>
        </div>
        <div class="op-buttons">
          <button id="btn-buy" class="btn btn-buy">この値段で購入 (ロング)</button>
          <button id="btn-sell-short" class="btn btn-sell">この値段で空売り (ショート)</button>
        </div>
        <div class="op-memo-row">
          <label>メモ <input type="text" id="op-memo" class="memo-input" placeholder="任意メモ (省略可)"></label>
        </div>
      </div>`;
    }

    if (status === 'hold_long' || status === 'hold_short' || status === 'partial') {
      const pos = position;
      const dir = pos?.direction === 'long' ? 'ロング' : 'ショート';
      const currentVal = fmtInitPrice(stockData ? stockData.currentPrice : (pos?.entryPrice || ''));
      const addLabel   = pos?.direction === 'long' ? '買い増し' : '売り増し';
      const addBtnCls  = pos?.direction === 'long' ? 'btn-buy' : 'btn-sell';

      return `
      <div class="card operation-panel">
        <div class="op-title">保有中操作 (${dir})</div>
        <div class="op-hold-grid">

          <!-- 左: 決済 -->
          <div class="op-col op-col-exit">
            <div class="op-col-heading">決済</div>
            <div class="op-col-inputs">
              <label>価格
                ${_priceStepperHtml('op-price', currentVal)}
              </label>
              <label>株数(100株単位)
                ${_qtyStepperHtml('op-qty', Math.round((pos?.remainingQty || CFG.DEFAULT_LOT) / 100))}
              </label>
            </div>
            <div class="op-col-buttons">
              <button id="btn-partial"   class="btn btn-partial">部分利確</button>
              <button id="btn-stop"      class="btn btn-stop">損切り</button>
              <button id="btn-full-exit" class="btn btn-exit">全決済</button>
            </div>
          </div>

          <!-- 仕切り -->
          <div class="op-col-divider"></div>

          <!-- 右: 買い増し / 売り増し -->
          <div class="op-col op-col-add">
            <div class="op-col-heading add">${addLabel}</div>
            <div class="op-col-inputs">
              <label>価格
                ${_priceStepperHtml('op-add-price', currentVal)}
              </label>
              <label>株数(100株単位)
                ${_qtyStepperHtml('op-add-qty', 1)}
              </label>
            </div>
            <div class="op-col-buttons">
              <button id="btn-add-to" class="btn ${addBtnCls}">${addLabel}</button>
            </div>
          </div>

        </div><!-- /.op-hold-grid -->

        <!-- メモ: 下段フル幅 -->
        <div class="op-memo-row">
          <label>メモ
            <input type="text" id="op-memo" class="memo-input-wide" value="${pos?.memo || ''}" placeholder="任意メモ (省略可)">
          </label>
        </div>
      </div>`;
    }

    return '';
  }

  // --- 本日取引一覧 ---
  function _renderTradeList(session) {
    if (!session || !session.trades || session.trades.length === 0) {
      return `<div class="card trade-list-panel"><div class="list-empty">本日のトレードはまだありません</div></div>`;
    }

    const rows = session.trades.map((t, i) => {
      const dir      = t.direction === 'long' ? '🔼 ロング' : '🔽 ショート';
      const pnlClass = t.totalPnl >= 0 ? 'pos' : 'neg';
      // 決済値: exitPrice フィールド優先、なければ最後の split
      const exitPrc  = t.exitPrice != null
        ? t.exitPrice
        : (t.splits.length > 0 ? t.splits[t.splits.length - 1].price : '--');
      return `
        <tr data-trade-id="${t.tradeId}">
          <td>${i + 1}</td>
          <td>${fmtTime(t.entryTime)}</td>
          <td>${dir}</td>
          <td>${fmtPrc(t.entryPrice)}</td>
          <td>${fmtNum(t.entryQty)}</td>
          <td>${fmtPrc(exitPrc)}</td>
          <td class="${pnlClass}">${fmtPnl(t.totalPnl)}</td>
          <td>${t.holdingMinutes}分</td>
          <td class="memo-cell">${t.memo || ''}</td>
          <td class="trade-actions">
            <button class="btn-trade-edit btn-icon-sm" data-id="${t.tradeId}" title="編集">✏️</button>
            <button class="btn-trade-delete btn-icon-sm btn-icon-danger" data-id="${t.tradeId}" title="削除">🗑️</button>
          </td>
        </tr>`;
    }).join('');

    return `
    <div class="card trade-list-panel">
      <div class="panel-title">本日のトレード</div>
      <table class="trade-table">
        <thead>
          <tr>
            <th>#</th><th>時刻</th><th>方向</th><th>建値</th><th>株数</th>
            <th>決済値</th><th>損益</th><th>保有時間</th><th>メモ</th><th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  // --- 編集モーダル ---
  function showEditModal(trade) {
    // 既存モーダルがあれば閉じる
    document.querySelectorAll('.modal-overlay').forEach(el => el.remove());

    const exitPrc = trade.exitPrice != null
      ? trade.exitPrice
      : (trade.splits.length > 0 ? trade.splits[trade.splits.length - 1].price : '');
    const hasMultipleExits = trade.splits.filter(s => s.type !== 'add').length > 1;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <h2>トレード編集</h2>
        <div class="edit-meta">${fmtTime(trade.entryTime)} / ${trade.direction === 'long' ? 'ロング' : 'ショート'} / ${trade.tradeId}</div>

        ${hasMultipleExits ? `<div class="edit-notice">※ 複数回決済のトレードです。決済値を変更すると最終決済価格を上書きし、全株数で損益を再計算します。</div>` : ''}

        <div class="edit-fields">
          <div class="edit-field">
            <label>建値</label>
            ${_priceStepperHtml('edit-entry-price', fmtInitPrice(trade.entryPrice))}
          </div>
          <div class="edit-field">
            <label>株数(100株単位)</label>
            ${_qtyStepperHtml('edit-qty', Math.round(trade.entryQty / 100))}
          </div>
          <div class="edit-field">
            <label>決済値</label>
            ${_priceStepperHtml('edit-exit-price', fmtInitPrice(exitPrc))}
          </div>
          <div class="edit-field edit-field-wide">
            <label>メモ</label>
            <input type="text" id="edit-memo" class="memo-input" value="${trade.memo || ''}" placeholder="任意メモ">
          </div>
        </div>

        <div class="edit-preview" id="edit-preview"></div>

        <div class="modal-actions">
          <button id="edit-save-btn" class="btn btn-primary">保存して再計算</button>
          <button id="edit-cancel-btn" class="btn btn-secondary">キャンセル</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // プレビュー計算 (入力は口数 → 実株数に変換)
    function updatePreview() {
      const ep    = readPrice('edit-entry-price') || trade.entryPrice;
      const xp    = readPrice('edit-exit-price')  || exitPrc;
      const units = parseInt(normalizeNum(document.getElementById('edit-qty')?.value || ''));
      const qty   = (units >= 1 ? units : Math.round(trade.entryQty / 100)) * 100;
      const pnl = trade.direction === 'long'
        ? Math.round((xp - ep) * qty)
        : Math.round((ep - xp) * qty);
      const cls = pnl >= 0 ? 'pos' : 'neg';
      document.getElementById('edit-preview').innerHTML =
        `予測損益: <span class="${cls}">${fmtPnl(pnl)}</span>`;
    }
    ['edit-entry-price','edit-exit-price','edit-qty'].forEach(id =>
      document.getElementById(id)?.addEventListener('input', updatePreview)
    );
    updatePreview();

    // 保存 (口数 → 実株数に変換してから渡す)
    document.getElementById('edit-save-btn').addEventListener('click', () => {
      const units = parseInt(normalizeNum(document.getElementById('edit-qty')?.value || ''));
      const updates = {
        entryPrice: readPrice('edit-entry-price'),
        entryQty:   units >= 1 ? units * 100 : NaN,
        exitPrice:  readPrice('edit-exit-price'),
        memo:       document.getElementById('edit-memo').value,
      };
      if (isNaN(updates.entryPrice) || isNaN(updates.entryQty) || isNaN(updates.exitPrice)) {
        showToast('入力値が正しくありません', 'warn');
        return;
      }
      overlay.remove();
      App.onEditTrade(trade.tradeId, updates);
    });

    // キャンセル
    document.getElementById('edit-cancel-btn').addEventListener('click', () => overlay.remove());

    // オーバーレイ外クリックで閉じる
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  // --- 本日損益サマリー ---
  function _renderDaySummary(session) {
    if (!session) return '';
    const pnl = session.pnl || 0;
    const cnt = session.trades ? session.trades.length : 0;
    const pnlClass = pnl >= 0 ? 'pos' : 'neg';

    return `
    <div class="card daily-summary">
      <span class="summary-label">本日損益</span>
      <span class="summary-pnl ${pnlClass}">${fmtPnl(pnl)}</span>
      <span class="summary-count">${cnt}トレード</span>
      ${session.sessionStartTime ? `<span class="summary-time">稼働: ${fmtTime(session.sessionStartTime)} ～ ${session.sessionEndTime ? fmtTime(session.sessionEndTime) : '継続中'}</span>` : ''}
    </div>`;
  }

  // --- 終了ボタン ---
  function _renderEndButton(status) {
    if (status === 'hold_long' || status === 'hold_short' || status === 'partial') {
      return `<div class="end-btn-area"><button class="btn btn-end" disabled title="保有中は終了できません">本日終了 (保有中のため無効)</button></div>`;
    }
    const label = status === 'day_ended' ? '本日終了 (再集計)' : '本日終了';
    return `<div class="end-btn-area"><button id="btn-end-day" class="btn btn-end">${label}</button></div>`;
  }

  // ----------------------------------------------------------
  // トースト通知
  // ----------------------------------------------------------
  function showToast(message, type = 'info', durationMs) {
    // 既存のトーストがあれば消す
    document.querySelectorAll('.toast').forEach(el => el.remove());

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // warn / stop は読み取り時間を確保するためデフォルトを長めに設定
    const duration = durationMs ?? (type === 'warn' || type === 'stop' ? 4000 : 2000);

    // 少し遅らせてフェードイン → duration 後にフェードアウト
    requestAnimationFrame(() => {
      toast.classList.add('toast-show');
      setTimeout(() => {
        toast.classList.remove('toast-show');
        setTimeout(() => toast.remove(), 300);
      }, duration);
    });
  }

  // ----------------------------------------------------------
  // イベントリスナー
  // ----------------------------------------------------------
  function _attachEventListeners(state) {
    // 銘柄更新
    const btnStock = document.getElementById('btn-stock-update');
    if (btnStock) btnStock.addEventListener('click', () => App.onStockUpdate());

    // 市場情報更新
    const btnMarket = document.getElementById('btn-market-update');
    if (btnMarket) btnMarket.addEventListener('click', () => App.onMarketUpdate());

    // 画面共有 開始 / 停止
    const btnScreenStart = document.getElementById('btn-screen-start');
    if (btnScreenStart) btnScreenStart.addEventListener('click', () => ScreenShare.start());

    const btnScreenStop = document.getElementById('btn-screen-stop');
    if (btnScreenStop) btnScreenStop.addEventListener('click', () => ScreenShare.stop());

    // 取得画像を確認
    const btnShowCapture = document.getElementById('btn-show-capture');
    if (btnShowCapture) btnShowCapture.addEventListener('click', () => showCaptureModal());

    // render() 再実行後にボタン状態を復元
    // (TradeTab.render() は innerHTML を丸ごと差し替えるため、
    //  共有中だった場合にボタンが disabled に戻るのを防ぐ)
    ScreenShare.restoreUI();

    // 購入
    const btnBuy = document.getElementById('btn-buy');
    if (btnBuy) btnBuy.addEventListener('click', () => {
      const price = readPrice('op-price');
      const qty   = readQtyUnits('op-qty');
      const memo  = document.getElementById('op-memo')?.value || '';
      if (!price || !qty) { showToast('価格と口数(1以上)を入力してください', 'warn'); return; }
      App.onBuy(price, qty, memo);
      showToast(`ロング記録: ¥${price} × ${qty}株`, 'buy');
    });

    // 空売り
    const btnSell = document.getElementById('btn-sell-short');
    if (btnSell) btnSell.addEventListener('click', () => {
      const price = readPrice('op-price');
      const qty   = readQtyUnits('op-qty');
      const memo  = document.getElementById('op-memo')?.value || '';
      if (!price || !qty) { showToast('価格と口数(1以上)を入力してください', 'warn'); return; }
      App.onSellShort(price, qty, memo);
      showToast(`ショート記録: ¥${price} × ${qty}株`, 'sell');
    });

    // 買い増し / 売り増し
    const btnAdd = document.getElementById('btn-add-to');
    if (btnAdd) btnAdd.addEventListener('click', () => {
      const price = readPrice('op-add-price');
      const qty   = readQtyUnits('op-add-qty');
      if (!price || !qty) { showToast('追加価格と口数(1以上)を入力してください', 'warn'); return; }
      const dirLabel = state.position?.direction === 'long' ? '買い増し' : '売り増し';
      App.onAddToPosition(price, qty);
      showToast(`${dirLabel}記録: ¥${price} × ${qty}株`, 'info');
    });

    // 部分利確
    const btnPartial = document.getElementById('btn-partial');
    if (btnPartial) btnPartial.addEventListener('click', () => {
      const price = readPrice('op-price');
      const qty   = readQtyUnits('op-qty');
      if (!price || !qty) { showToast('価格と口数(1以上)を入力してください', 'warn'); return; }
      App.onPartialExit(price, qty);
      showToast(`部分利確記録: ¥${price} × ${qty}株`, 'info');
    });

    // 損切り
    const btnStop = document.getElementById('btn-stop');
    if (btnStop) btnStop.addEventListener('click', () => {
      const price = readPrice('op-price');
      const qty   = readQtyUnits('op-qty');
      if (!price || !qty) { showToast('価格と口数(1以上)を入力してください', 'warn'); return; }
      App.onStopLoss(price, qty);
      showToast(`損切り記録: ¥${price} × ${qty}株`, 'stop');
    });

    // 全決済
    const btnFull = document.getElementById('btn-full-exit');
    if (btnFull) btnFull.addEventListener('click', () => {
      const price = readPrice('op-price');
      if (!price) { showToast('価格を入力してください', 'warn'); return; }
      App.onFullExit(price);
      showToast(`全決済記録: ¥${price}`, 'info');
    });

    // 終了
    const btnEnd = document.getElementById('btn-end-day');
    if (btnEnd) btnEnd.addEventListener('click', () => App.onEndDay());

    // 追加トレード (終了解除)
    const btnResume = document.getElementById('btn-resume');
    if (btnResume) btnResume.addEventListener('click', () => App.onResumeAfterEnd());

    // 取引一覧: 編集ボタン
    document.querySelectorAll('.btn-trade-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const tradeId = btn.dataset.id;
        const trade   = state.session?.trades?.find(t => t.tradeId === tradeId);
        if (trade) showEditModal(trade);
      });
    });

    // 取引一覧: 削除ボタン (削除だけ確認あり)
    document.querySelectorAll('.btn-trade-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const tradeId = btn.dataset.id;
        const trade   = state.session?.trades?.find(t => t.tradeId === tradeId);
        if (!trade) return;
        const dir = trade.direction === 'long' ? 'ロング' : 'ショート';
        if (!confirm(`${fmtTime(trade.entryTime)} ${dir} ¥${trade.entryPrice} を削除します。\nこの操作は取り消せません。`)) return;
        App.onDeleteTrade(tradeId);
      });
    });

    // メモ入力 (即時保存)
    const memoInput = document.getElementById('op-memo');
    if (memoInput) {
      memoInput.addEventListener('change', () => {
        if (state.status === 'hold_long' || state.status === 'hold_short' || state.status === 'partial') {
          AppState.updatePositionMemo(memoInput.value);
        }
      });
    }
  }

  // --- 終了結果ダイアログ ---
  function showEndDayResult(result) {
    const { summary, review, copyText } = result;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <h2>本日の取引終了</h2>
        <div class="modal-summary">
          <div class="modal-row"><span>損益合計</span><span class="${summary.totalPnl >= 0 ? 'pos' : 'neg'}">${fmtPnl(summary.totalPnl)}</span></div>
          <div class="modal-row"><span>取引回数</span><span>${summary.tradeCount}回</span></div>
          <div class="modal-row"><span>勝率</span><span>${summary.winRate}%</span></div>
          <div class="modal-row"><span>稼働時間</span><span>${summary.sessionMinutes}分</span></div>
        </div>
        <div class="modal-review">
          <strong>振り返り</strong>
          <p>${review}</p>
        </div>
        <div class="modal-copy">
          <strong>コピー用テキスト</strong>
          <textarea readonly rows="6">${copyText}</textarea>
          <button id="modal-copy-btn" class="btn btn-secondary">クリップボードにコピー</button>
        </div>
        <button id="modal-close" class="btn btn-primary">閉じる</button>
      </div>`;

    document.body.appendChild(overlay);

    document.getElementById('modal-close').addEventListener('click', () => {
      document.body.removeChild(overlay);
      render();
    });

    document.getElementById('modal-copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(copyText).then(() => showToast('クリップボードにコピーしました', 'info'));
    });
  }

  return { render, showEndDayResult, showToast, showCaptureModal };
})();
