'use strict';
// ============================================================
// lib/providers/yahooFinance.js
//
// Yahoo Finance 非公式 chart API v8 プロバイダ
//
// 責務:
//   1. _fetchRaw()      Yahoo API への HTTP リクエスト
//                       + 自動 crumb 認証 (401/403 時)
//                       + 一時 5xx リトライ (1回)
//   2. _validateRaw()   生レスポンスの構造検証
//   3. _buildCandles()  OHLCV 配列の組み立て + null 除去
//   4. _calcDerived()   VWAP / MA5 / recentHigh/Low の計算
//   5. _buildResponse() 最終 JSON 整形
//
// 取得元を差し替える場合:
//   このファイルを丸ごと別プロバイダ実装に置き換えるか、
//   api/stock.js の require 先を変える。
//   返却する JSON 構造 (_buildResponse の shape) は維持すること。
// ============================================================

const YAHOO_CHART_BASE =
  'https://query1.finance.yahoo.com/v8/finance/chart/7011.T?interval=5m&range=1d';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

// ----------------------------------------------------------
// crumb キャッシュ
//
// Vercel のウォームインスタンス期間中（数分〜数時間）に再利用する。
// コールドスタート時はリセットされるが、その場合はその場で取得する。
// { crumb: string, cookie: string, cachedAt: number } | null
// ----------------------------------------------------------
let _crumbCache = null;
const CRUMB_TTL_MS = 55 * 60 * 1000; // 55分

// ----------------------------------------------------------
// エラークラス
// ----------------------------------------------------------
class YahooFetchError extends Error {
  constructor(message, upstreamStatus) {
    super(message);
    this.name = 'YahooFetchError';
    this.upstreamStatus = upstreamStatus;
  }
}

class YahooParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'YahooParseError';
  }
}

// ----------------------------------------------------------
// メイン取得関数 (api/stock.js から呼ぶ唯一の公開関数)
// ----------------------------------------------------------
async function fetchStockData() {
  const raw     = await _fetchRaw();
  const result  = _validateRaw(raw);
  const candles = _buildCandles(result);
  const derived = _calcDerived(candles);
  return _buildResponse(result.meta, candles, derived);
}

// ----------------------------------------------------------
// Step 1: 生データ取得
//
// フロー:
//   a) まず crumb なしで試みる（平常時はこれで200が返る）
//   b) 401 / 403 → crumb 認証を取得してリトライ
//   c) 5xx     → 1 秒後にリトライ（crumb があれば付与）
//   d) 最終的に ok でなければエラー
// ----------------------------------------------------------
async function _fetchRaw() {
  const t0 = Date.now();

  // (a) 初回リクエスト — crumb なし
  let resp = await _attemptFetch(null);
  _log(`初回リクエスト → ${resp.status} (${Date.now() - t0}ms)`);

  // (b) 401 / 403 → crumb 認証にフォールバック
  if (resp.status === 401 || resp.status === 403) {
    _log(`${resp.status} を受信。crumb 認証にフォールバックします...`);
    _crumbCache = null; // キャッシュを強制無効化して新規取得
    const auth = await _fetchCrumb();
    resp = await _attemptFetch(auth);
    _log(`crumb 付き再試行 → ${resp.status} (計 ${Date.now() - t0}ms)`);
  }

  // (c) 5xx → 1 秒待ってリトライ（crumb キャッシュがあれば付与）
  if (resp.status >= 500 && resp.status < 600) {
    _log(`${resp.status} サーバーエラー。1 秒後にリトライします...`);
    await _sleep(1000);
    resp = await _attemptFetch(_crumbCache);
    _log(`5xx リトライ → ${resp.status} (計 ${Date.now() - t0}ms)`);
  }

  // (d) 最終的なステータス判定
  if (resp.status === 429) {
    throw new YahooFetchError(
      'Yahoo Finance からレート制限を受けています (429)。' +
      'しばらく待ってから再試行してください。',
      429,
    );
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new YahooFetchError(
      `Yahoo Finance 認証エラー (${resp.status})。` +
      'crumb 認証を試みましたが失敗しました。',
      resp.status,
    );
  }
  if (!resp.ok) {
    throw new YahooFetchError(
      `Yahoo Finance HTTP エラー: ${resp.status} ${resp.statusText}`,
      resp.status,
    );
  }

  try {
    return await resp.json();
  } catch (jsonErr) {
    throw new YahooParseError(
      `Yahoo Finance のレスポンスが JSON ではありません: ${jsonErr.message}`,
    );
  }
}

// ----------------------------------------------------------
// 1回分の fetch 実行
// auth: { crumb, cookie } | null
// ----------------------------------------------------------
async function _attemptFetch(auth) {
  const url = auth?.crumb
    ? `${YAHOO_CHART_BASE}&crumb=${encodeURIComponent(auth.crumb)}`
    : YAHOO_CHART_BASE;

  const headers = {
    'User-Agent': USER_AGENT,
    'Accept':     'application/json, text/plain, */*',
  };
  if (auth?.cookie) headers['Cookie'] = auth.cookie;

  try {
    return await fetch(url, { headers });
  } catch (networkErr) {
    throw new YahooFetchError(
      `Yahoo Finance への接続に失敗しました: ${networkErr.message}`,
      503,
    );
  }
}

// ----------------------------------------------------------
// crumb 取得
//
// フロー:
//   1. fc.yahoo.com (redirect:manual) からセッション cookie を取得
//      → 404 でも set-cookie が付いていることが実証済み
//   2. query2.finance.yahoo.com/v1/test/getcrumb を cookie 付きで呼ぶ
//   3. 取得した crumb + cookie をキャッシュして返す
// ----------------------------------------------------------
async function _fetchCrumb() {
  // キャッシュが有効なら再利用
  if (_crumbCache && (Date.now() - _crumbCache.cachedAt) < CRUMB_TTL_MS) {
    _log('crumb キャッシュを再利用します');
    return _crumbCache;
  }

  _log('crumb 取得を開始します...');

  // Step 1: fc.yahoo.com からセッション cookie を取得
  let cookie = '';
  try {
    const fcResp = await fetch('https://fc.yahoo.com', {
      headers:  { 'User-Agent': USER_AGENT },
      redirect: 'manual', // リダイレクト先には行かず、ここで set-cookie を取る
    });
    const rawSetCookie = fcResp.headers.get('set-cookie') ?? '';
    cookie = rawSetCookie.split(';')[0] ?? '';
    _log(`fc.yahoo.com → ${fcResp.status}  cookie: ${cookie ? cookie.slice(0, 20) + '…' : 'なし'}`);
  } catch (e) {
    // cookie 取得失敗は致命的ではない。crumb 取得を続行する
    _log(`fc.yahoo.com 接続失敗 (${e.message})。cookie なしで crumb を試みます`);
  }

  // Step 2: crumb エンドポイントを呼ぶ
  let crumbResp;
  try {
    crumbResp = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': USER_AGENT,
        ...(cookie ? { 'Cookie': cookie } : {}),
      },
    });
  } catch (e) {
    throw new YahooFetchError(
      `crumb エンドポイントへの接続に失敗しました: ${e.message}`,
      503,
    );
  }

  if (!crumbResp.ok) {
    throw new YahooFetchError(
      `crumb 取得失敗 (HTTP ${crumbResp.status})。` +
      'Yahoo Finance の認証方式が変わった可能性があります。',
      crumbResp.status,
    );
  }

  const crumb = (await crumbResp.text()).trim();
  if (!crumb) {
    throw new YahooParseError('crumb が空文字です。Yahoo Finance の仕様変更の可能性があります。');
  }

  _crumbCache = { crumb, cookie, cachedAt: Date.now() };
  _log(`crumb 取得成功: ${crumb.slice(0, 6)}… (TTL: 55分)`);
  return _crumbCache;
}

// ----------------------------------------------------------
// Step 2: 生レスポンス検証
// ----------------------------------------------------------
function _validateRaw(raw) {
  if (!raw?.chart?.result?.[0]) {
    const apiMsg = raw?.chart?.error?.description ?? '詳細不明';
    throw new YahooParseError(
      `Yahoo Finance レスポンス異常: chart.result[0] がありません (${apiMsg})`,
    );
  }

  const r = raw.chart.result[0];

  if (!r.meta) {
    throw new YahooParseError('Yahoo Finance レスポンス異常: meta フィールドがありません');
  }
  if (!r.timestamp || !Array.isArray(r.timestamp)) {
    throw new YahooParseError('Yahoo Finance レスポンス異常: timestamp 配列がありません');
  }
  if (!r.indicators?.quote?.[0]) {
    throw new YahooParseError('Yahoo Finance レスポンス異常: indicators.quote[0] がありません');
  }

  return r;
}

// ----------------------------------------------------------
// Step 3: candles 組み立て + null 除去
// ----------------------------------------------------------
function _buildCandles(result) {
  const ts = result.timestamp;
  const q  = result.indicators.quote[0];

  const all = ts.map((t, i) => ({
    time:   new Date(t * 1000).toISOString(),
    open:   q.open[i]   ?? null,
    high:   q.high[i]   ?? null,
    low:    q.low[i]    ?? null,
    close:  q.close[i]  ?? null,
    volume: q.volume[i] ?? null,
  }));

  const valid = all.filter(
    c => c.open !== null && c.high  !== null &&
         c.low  !== null && c.close !== null && c.volume !== null,
  );

  if (valid.length === 0) {
    throw new YahooParseError(
      '有効なローソク足が 0 本です。営業時間外またはデータ未配信の可能性があります。',
    );
  }

  return valid;
}

// ----------------------------------------------------------
// Step 4: 派生値計算
// ----------------------------------------------------------
function _calcDerived(candles) {
  const n = candles.length;

  const totalTypicalVol = candles.reduce(
    (s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0,
  );
  const totalVol = candles.reduce((s, c) => s + c.volume, 0);
  const vwap = totalVol > 0 ? _round1(totalTypicalVol / totalVol) : null;

  const ma5 = n >= 5
    ? _round1(candles.slice(-5).reduce((s, c) => s + c.close, 0) / 5)
    : null;

  const recentHigh5  = n >= 5  ? Math.max(...candles.slice(-5).map(c => c.high))  : null;
  const recentLow5   = n >= 5  ? Math.min(...candles.slice(-5).map(c => c.low))   : null;
  const recentHigh15 = n >= 15 ? Math.max(...candles.slice(-15).map(c => c.high)) : null;
  const recentLow15  = n >= 15 ? Math.min(...candles.slice(-15).map(c => c.low))  : null;

  return { vwap, ma5, recentHigh5, recentLow5, recentHigh15, recentLow15 };
}

// ----------------------------------------------------------
// Step 5: 最終 JSON 整形
// ----------------------------------------------------------
function _buildResponse(meta, candles, derived) {
  return {
    symbol: '7011',
    name:   '三菱重工業',

    currentPrice: meta.regularMarketPrice   ?? null,
    prevClose:    meta.chartPreviousClose   ?? meta.previousClose ?? null,
    openPrice:    candles[0]?.open          ?? null,
    dayHigh:      meta.regularMarketDayHigh ?? null,
    dayLow:       meta.regularMarketDayLow  ?? null,
    volume:       meta.regularMarketVolume  ?? null,
    fetchedAt:    new Date().toISOString(),

    ...derived,
    candles,

    prevHigh: null, // mockData 互換 (logic.js 未使用)
    prevLow:  null,
  };
}

// ----------------------------------------------------------
// 内部ユーティリティ
// ----------------------------------------------------------
function _round1(n) {
  return Math.round(n * 10) / 10;
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _log(msg) {
  console.log(`[yahooFinance] ${msg}`);
}

module.exports = { fetchStockData, YahooFetchError, YahooParseError };
