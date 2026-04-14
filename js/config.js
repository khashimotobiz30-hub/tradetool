// ============================================================
// config.js — 定数・閾値設定
// ここの値を変えることでロジックの挙動を調整できます
// ============================================================
const CFG = {
  // --- 対象銘柄 ---
  SYMBOL: '7011',
  SYMBOL_NAME: '三菱重工業',

  // --- 判断ロジック用パラメータ ---
  MA_PERIOD: 5,               // 短期MA本数 (初期: 5本)
  RECENT_BARS: 5,             // 直近高安の基本参照本数
  EXTENDED_BARS: 15,          // 補助参照本数

  // ブレイク継続判定: 直近高値超え後N本連続で大きく割り込まない
  BREAKOUT_CONFIRM_BARS: 2,
  // ブレイク後「大きく割り込む」とみなすオフセット (円)
  BREAKOUT_INVALIDATE_OFFSET: 3,

  // 戻り売り判定: 直近5本安値割れ後、戻りがVWAP/5MAで抑えられる
  BREAKDOWN_CONFIRM_BARS: 2,
  BREAKDOWN_INVALIDATE_OFFSET: 3,

  // 利確ターゲット計算 (直近レンジの倍率)
  TARGET1_RANGE_MULT: 0.8,
  TARGET2_RANGE_MULT: 1.6,

  // ロスカット計算 (直近レンジの倍率)
  STOP_RANGE_MULT: 0.5,

  // 出来高低下とみなす閾値 (直近3本 / 過去10本平均)
  VOLUME_DOWN_RATIO: 0.70,
  // 出来高増加とみなす閾値
  VOLUME_UP_RATIO: 1.20,

  // --- 市場情報 鮮度ルール (分) ---
  MARKET_FRESH_MIN: 10,       // 10分以内 → 「最新」
  MARKET_STALE_MIN: 30,       // 30分超  → 「やや古い」
  MARKET_OLD_MIN: 60,         // 60分超  → 「更新推奨」

  // --- デフォルト株数 ---
  DEFAULT_LOT: 100,

  // --- ストレージキー ---
  STORAGE_KEY_STATE: 'mhi_state',
  STORAGE_KEY_SESSION: 'mhi_session',
  STORAGE_KEY_DAYS: 'mhi_days',
  STORAGE_KEY_EVENTS: 'mhi_events',
};
