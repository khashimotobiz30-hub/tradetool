// ============================================================
// calendarTab.js — カレンダータブ UI
// ============================================================

const CalendarTab = (() => {

  let _currentYear  = new Date().getFullYear();
  let _currentMonth = new Date().getMonth(); // 0-indexed
  let _selectedDate = Storage.todayStr(); // 初期選択 = 今日

  function fmtPnl(n) {
    if (n == null) return '';
    return (n >= 0 ? '+' : '') + n.toLocaleString();
  }
  function fmtTime(iso) {
    if (!iso) return '--';
    return iso.slice(11, 16);
  }

  // ----------------------------------------------------------
  // メインレンダリング
  // ----------------------------------------------------------
  function render() {
    const root = document.getElementById('calendar-tab-content');
    if (!root) return;

    const allDays = Storage.loadAllDayRecords();

    root.innerHTML = `
      ${_renderCalendar(allDays)}
      ${_renderDayDetail(allDays[_selectedDate])}
      ${_renderMonthSummary(allDays)}
    `;

    _attachEventListeners(allDays);
  }

  // --- カレンダー ---
  function _renderCalendar(allDays) {
    const year  = _currentYear;
    const month = _currentMonth;

    const monthLabel = `${year}年${month + 1}月`;
    const firstDay   = new Date(year, month, 1).getDay(); // 0=Sun
    const lastDate   = new Date(year, month + 1, 0).getDate();

    const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
    const headerCells = dayNames.map((d, i) =>
      `<th class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${d}</th>`
    ).join('');

    let cells = '';
    let dayNum = 1;

    // 空セル (月初前)
    let row = '<tr>';
    for (let i = 0; i < firstDay; i++) row += '<td class="empty"></td>';

    while (dayNum <= lastDate) {
      const dow = (firstDay + dayNum - 1) % 7;
      if (dow === 0 && dayNum > 1) {
        cells += row + '</tr>';
        row = '<tr>';
      }

      const dateStr  = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      const dayRecord = allDays[dateStr];
      const isToday   = dateStr === Storage.todayStr();
      const isSelected = dateStr === _selectedDate;

      let cellClass = 'cal-day';
      if (dow === 0) cellClass += ' sun';
      if (dow === 6) cellClass += ' sat';
      if (isToday)   cellClass += ' today';
      if (isSelected) cellClass += ' selected';

      let cellContent = `<span class="day-num">${dayNum}</span>`;
      if (dayRecord) {
        const pnlClass = dayRecord.pnl >= 0 ? 'pos' : 'neg';
        cellClass += ' has-record';
        cellContent += `<span class="day-pnl ${pnlClass}">${fmtPnl(dayRecord.pnl)}</span>`;
        if (dayRecord.reviewComment) cellClass += ' has-review';
      }

      row += `<td class="${cellClass}" data-date="${dateStr}">${cellContent}</td>`;
      dayNum++;
    }

    // 末尾の空セル
    const lastDow = (firstDay + lastDate - 1) % 7;
    if (lastDow < 6) {
      for (let i = lastDow + 1; i <= 6; i++) row += '<td class="empty"></td>';
    }
    cells += row + '</tr>';

    return `
    <div class="card calendar-panel">
      <div class="cal-header">
        <button id="cal-prev" class="btn btn-icon">◀</button>
        <span class="cal-month-label">${monthLabel}</span>
        <button id="cal-next" class="btn btn-icon">▶</button>
      </div>
      <table class="cal-table">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${cells}</tbody>
      </table>
      <div class="cal-legend">
        <span class="legend-item has-review-dot">振り返りあり</span>
        <span class="legend-item pos">+損益 (黒字)</span>
        <span class="legend-item neg">損益 (赤字)</span>
      </div>
    </div>`;
  }

  // --- 月間サマリー ---
  function _renderMonthSummary(allDays) {
    const year  = _currentYear;
    const month = _currentMonth;

    // 当月の記録だけ抽出
    const monthRecords = Object.entries(allDays)
      .filter(([d]) => d.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`))
      .map(([, r]) => r);

    if (monthRecords.length === 0) {
      return `<div class="card month-summary"><div class="no-data-msg">この月の記録はありません</div></div>`;
    }

    const totalPnl     = monthRecords.reduce((s, r) => s + (r.pnl || 0), 0);
    const totalTrades  = monthRecords.reduce((s, r) => s + (r.tradeCount || 0), 0);
    const totalWins    = monthRecords.reduce((s, r) => s + (r.winCount || 0), 0);
    const totalLosses  = monthRecords.reduce((s, r) => s + (r.lossCount || 0), 0);
    const winRate      = totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100) : 0;
    const tradingDays  = monthRecords.filter(r => r.tradeCount > 0).length;

    // 時間帯別 (エントリー時刻の時間帯を集計したい → trades から取る)
    let hourStats = {};
    monthRecords.forEach(r => {
      (r.trades || []).forEach(t => {
        if (!t.entryTime) return;
        const h = parseInt(t.entryTime.slice(11, 13));
        if (!hourStats[h]) hourStats[h] = { count: 0, pnl: 0 };
        hourStats[h].count++;
        hourStats[h].pnl += t.totalPnl || 0;
      });
    });

    const hourRows = Object.entries(hourStats)
      .sort(([a], [b]) => a - b)
      .map(([h, s]) => `<div class="hour-row"><span>${h}時台</span><span>${s.count}回</span><span class="${s.pnl >= 0 ? 'pos' : 'neg'}">${fmtPnl(s.pnl)}</span></div>`)
      .join('');

    // 総評コメント生成
    const comment = _generateMonthComment(totalPnl, winRate, totalTrades, tradingDays);

    return `
    <div class="card month-summary">
      <div class="panel-title">${year}年${month + 1}月 月間総評</div>
      <div class="month-stats">
        <div class="stat-item"><span class="stat-label">月間損益</span><span class="stat-val ${totalPnl >= 0 ? 'pos' : 'neg'}">${fmtPnl(totalPnl)}円</span></div>
        <div class="stat-item"><span class="stat-label">取引日数</span><span class="stat-val">${tradingDays}日</span></div>
        <div class="stat-item"><span class="stat-label">総取引回数</span><span class="stat-val">${totalTrades}回</span></div>
        <div class="stat-item"><span class="stat-label">勝率</span><span class="stat-val">${winRate}%</span></div>
        <div class="stat-item"><span class="stat-label">勝</span><span class="stat-val pos">${totalWins}回</span></div>
        <div class="stat-item"><span class="stat-label">負</span><span class="stat-val neg">${totalLosses}回</span></div>
      </div>
      ${hourRows ? `<div class="hour-stats"><div class="sub-title">時間帯別</div>${hourRows}</div>` : ''}
      <div class="month-comment">
        <strong>傾向と対策</strong>
        <p>${comment}</p>
      </div>
    </div>`;
  }

  // --- 日次詳細 ---
  function _renderDayDetail(record) {
    const dateLabel = _selectedDate
      ? `${_selectedDate} 詳細`
      : '日次詳細';

    if (!record) {
      return `
      <div class="card day-detail">
        <div class="panel-title">${dateLabel}</div>
        <div class="no-data-msg">この日の記録はありません</div>
      </div>`;
    }

    const trades = record.trades || [];
    const tradeRows = trades.map((t, i) => {
      const dir    = t.direction === 'long' ? '🔼 ロング' : '🔽 ショート';
      const exitPrc = t.splits?.length > 0 ? t.splits[t.splits.length - 1].price : '--';
      return `
        <tr>
          <td>${i + 1}</td>
          <td>${fmtTime(t.entryTime)}</td>
          <td>${dir}</td>
          <td>¥${t.entryPrice}</td>
          <td>${t.entryQty}株</td>
          <td>¥${exitPrc}</td>
          <td class="${t.totalPnl >= 0 ? 'pos' : 'neg'}">${fmtPnl(t.totalPnl)}円</td>
          <td>${t.holdingMinutes}分</td>
        </tr>`;
    }).join('');

    const pnlClass = (record.pnl || 0) >= 0 ? 'pos' : 'neg';

    return `
    <div class="card day-detail">
      <div class="panel-title">${dateLabel}</div>
      <div class="day-stats-row">
        <span>損益: <strong class="${pnlClass}">${fmtPnl(record.pnl)}円</strong></span>
        <span>稼働: ${fmtTime(record.sessionStartTime)} ～ ${fmtTime(record.sessionEndTime)} (${record.sessionMinutes || '--'}分)</span>
        <span>${record.tradeCount}トレード / 勝${record.winCount || 0} 負${record.lossCount || 0}</span>
      </div>

      ${tradeRows ? `
      <table class="trade-table">
        <thead><tr><th>#</th><th>時刻</th><th>方向</th><th>建値</th><th>株数</th><th>決済</th><th>損益</th><th>保有時間</th></tr></thead>
        <tbody>${tradeRows}</tbody>
      </table>` : '<div class="no-data-msg">取引なし</div>'}

      <div class="review-section">
        <strong>振り返り</strong>
        <p>${record.reviewComment || '(振り返りなし)'}</p>
      </div>

      <div class="memo-section">
        <strong>自由メモ</strong>
        <textarea id="day-memo" rows="3" class="memo-textarea">${record.memo || ''}</textarea>
        <button id="btn-save-memo" class="btn btn-secondary btn-sm">メモ保存</button>
      </div>
    </div>`;
  }

  // --- 月間総評コメント生成 ---
  function _generateMonthComment(totalPnl, winRate, totalTrades, tradingDays) {
    if (totalTrades === 0) return '取引記録がありません。';
    const lines = [];

    if (totalPnl > 0) lines.push(`月間で黒字 (+¥${totalPnl.toLocaleString()})。`);
    else if (totalPnl < 0) lines.push(`月間で赤字 (¥${totalPnl.toLocaleString()})。損切りルールと入り方を見直す。`);
    else lines.push('月間収支はトントン。');

    if (winRate >= 60) lines.push(`勝率 ${winRate}% は良好。`);
    else if (winRate >= 50) lines.push(`勝率 ${winRate}%。安定している。`);
    else lines.push(`勝率 ${winRate}%。エントリー精度を上げる余地あり。`);

    if (tradingDays > 0 && totalTrades > 0) {
      const avgPerDay = (totalTrades / tradingDays).toFixed(1);
      lines.push(`1日平均 ${avgPerDay} 回取引。`);
      if (parseFloat(avgPerDay) > 5) lines.push('過剰取引の傾向。良いセットアップのみに絞ることを意識。');
    }

    lines.push('データ量が少ない場合は参考値として扱うこと。');
    return lines.join(' ');
  }

  // --- イベントリスナー ---
  function _attachEventListeners(allDays) {
    document.getElementById('cal-prev')?.addEventListener('click', () => {
      _currentMonth--;
      if (_currentMonth < 0) { _currentMonth = 11; _currentYear--; }
      render();
    });

    document.getElementById('cal-next')?.addEventListener('click', () => {
      _currentMonth++;
      if (_currentMonth > 11) { _currentMonth = 0; _currentYear++; }
      render();
    });

    document.querySelectorAll('.cal-day[data-date]').forEach(cell => {
      cell.addEventListener('click', () => {
        _selectedDate = cell.dataset.date;
        render();
      });
    });

    // メモ保存
    const btnMemo = document.getElementById('btn-save-memo');
    if (btnMemo) {
      btnMemo.addEventListener('click', () => {
        const memo = document.getElementById('day-memo').value;
        const rec  = allDays[_selectedDate];
        if (rec) {
          rec.memo = memo;
          Storage.saveDayRecord(rec);
          TradeTab.showToast('メモを保存しました', 'info');
        }
      });
    }
  }

  return { render };
})();
