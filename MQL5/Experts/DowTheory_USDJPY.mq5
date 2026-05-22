//+------------------------------------------------------------------+
//|                                       DowTheory_USDJPY_EA.mq5   |
//|              ダウ理論ベース USD/JPY 自動取引 EA (M15)            |
//|                                                                  |
//|  ロジック:                                                        |
//|   1. HH+HL / LH+LL によるトレンド判定                           |
//|   2. 上位足（H1）でトレンドを二重確認                            |
//|   3. 押し目・戻り目エントリー（フィボナッチゾーン）              |
//|   4. ブレイクアウトエントリー（スウィング高安のブレイク）        |
//|   5. ティックボリュームフィルター                                |
//|   6. リスク管理（口座残高の%でロット計算）                       |
//|   7. トレーリングストップ                                        |
//+------------------------------------------------------------------+
#property copyright "DowTheory EA"
#property version   "1.00"
#property description "ダウ理論（HH/HL、押し目戻り目、ブレイクアウト）USDJPY M15"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//--- 入力パラメーター
input group "=== リスク管理 ==="
input double           InpRiskPercent   = 1.0;        // 1トレードのリスク率 (%)
input double           InpRRRatio       = 2.0;        // リスクリワード比 (1:X)
input int              InpMagicNumber   = 20250101;   // マジックナンバー

input group "=== ダウ理論設定 ==="
input int              InpSwingLookback = 5;          // スウィングポイント判定バー数 (左右)
input int              InpSwingCount    = 3;          // トレンド確認に必要なスウィング数
input bool             InpUseHigherTF   = true;       // 上位足フィルター使用
input ENUM_TIMEFRAMES  InpHigherTF      = PERIOD_H1;  // 上位足

input group "=== エントリー設定 ==="
input bool             InpUsePullback   = true;       // 押し目・戻り目エントリー
input bool             InpUseBreakout   = true;       // ブレイクアウトエントリー
input double           InpPullbackRatio = 0.618;      // 押し目の深さ比率 (0.382〜0.618)
input double           InpPBZoneBuffer  = 0.08;       // 押し目ゾーン幅 (±スウィング幅の割合)
input double           InpBreakoutPips  = 3.0;        // ブレイクアウト確認バッファ (pips)

input group "=== 出来高フィルター ==="
input bool             InpUseVolume     = true;       // 出来高フィルター使用
input int              InpVolPeriod     = 20;         // 出来高平均期間 (バー数)
input double           InpVolMultiplier = 1.2;        // 出来高閾値倍率 (平均のX倍以上)

input group "=== ストップロス バッファ ==="
input double           InpSLBuffer      = 5.0;        // SL追加バッファ (pips)

input group "=== トレーリングストップ ==="
input bool             InpUseTrailing   = true;       // トレーリングストップ使用
input double           InpTrailingStart = 20.0;       // トレーリング開始利益 (pips)
input double           InpTrailingStep  = 10.0;       // トレーリングステップ (pips)

//--- スウィングポイント構造体
struct SwingPoint {
   double   price;
   datetime time;
   bool     isHigh;
};

//--- グローバル変数
CTrade       g_trade;
SwingPoint   g_swings[];
int          g_swingCount = 0;

//+------------------------------------------------------------------+
//| 初期化                                                            |
//+------------------------------------------------------------------+
int OnInit() {
   if (StringFind(Symbol(), "USDJPY") < 0) {
      Alert("このEAはUSDJPY専用です: ", Symbol());
      return INIT_FAILED;
   }
   if (Period() != PERIOD_M15) {
      Alert("M15チャートで起動してください。現在: ", EnumToString((ENUM_TIMEFRAMES)Period()));
      return INIT_FAILED;
   }

   g_trade.SetExpertMagicNumber(InpMagicNumber);
   g_trade.SetDeviationInPoints(10);
   g_trade.SetTypeFilling(ORDER_FILLING_FOK);

   PrintFormat("[DowTheory EA] 起動 | Risk=%.1f%% RR=1:%.1f Pullback=%s Breakout=%s",
               InpRiskPercent, InpRRRatio,
               InpUsePullback ? "ON" : "OFF",
               InpUseBreakout ? "ON" : "OFF");
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| メインループ                                                       |
//+------------------------------------------------------------------+
void OnTick() {
   // ポジション管理は毎ティック実行
   ManageTrailingStop();

   // 新しいバーが開いた時だけシグナル判定
   static datetime s_lastBar = 0;
   datetime curBar = iTime(Symbol(), PERIOD_CURRENT, 0);
   if (curBar == s_lastBar) return;
   s_lastBar = curBar;

   // スウィングポイントを更新（確定済みバーのみ）
   DetectSwingPoints();

   // 既存ポジションがあれば新規エントリーしない
   if (HasOpenPosition()) return;

   // M15トレンド判定
   int trend = ClassifyTrend(g_swings, g_swingCount);
   if (trend == 0) return; // レンジ→スキップ

   // 上位足フィルター（同方向のみエントリー）
   if (InpUseHigherTF) {
      int htfTrend = GetHigherTFTrend();
      if (htfTrend != 0 && htfTrend != trend) return;
   }

   // 出来高フィルター
   if (InpUseVolume && !VolumeAboveAverage()) return;

   // エントリー（押し目優先、ブレイクアウトはなければ）
   if (InpUsePullback) TryPullbackEntry(trend);
   if (!HasOpenPosition() && InpUseBreakout) TryBreakoutEntry(trend);
}

//+------------------------------------------------------------------+
//| スウィングポイント検出                                             |
//| 直近120バーの確定済みバーから高値・安値を抽出                     |
//+------------------------------------------------------------------+
void DetectSwingPoints() {
   int totalBars = iBars(Symbol(), PERIOD_CURRENT);
   if (totalBars < InpSwingLookback * 2 + 5) return;

   ArrayResize(g_swings, 0);
   g_swingCount = 0;

   // bar=1 が最新確定バー、bar=searchEnd が最古
   int searchEnd = MathMin(totalBars - InpSwingLookback - 1, 120);

   for (int i = InpSwingLookback + 1; i <= searchEnd; i++) {
      if (IsSwingHigh(i))
         AppendSwing(iHigh(Symbol(), PERIOD_CURRENT, i),
                     iTime(Symbol(), PERIOD_CURRENT, i), true);
      if (IsSwingLow(i))
         AppendSwing(iLow(Symbol(), PERIOD_CURRENT, i),
                     iTime(Symbol(), PERIOD_CURRENT, i), false);
   }
}

bool IsSwingHigh(int bar) {
   double h = iHigh(Symbol(), PERIOD_CURRENT, bar);
   for (int j = 1; j <= InpSwingLookback; j++) {
      if (iHigh(Symbol(), PERIOD_CURRENT, bar - j) >= h) return false;
      if (iHigh(Symbol(), PERIOD_CURRENT, bar + j) >= h) return false;
   }
   return true;
}

bool IsSwingLow(int bar) {
   double l = iLow(Symbol(), PERIOD_CURRENT, bar);
   for (int j = 1; j <= InpSwingLookback; j++) {
      if (iLow(Symbol(), PERIOD_CURRENT, bar - j) <= l) return false;
      if (iLow(Symbol(), PERIOD_CURRENT, bar + j) <= l) return false;
   }
   return true;
}

void AppendSwing(double price, datetime time, bool isHigh) {
   int n = ArraySize(g_swings);
   ArrayResize(g_swings, n + 1);
   g_swings[n].price  = price;
   g_swings[n].time   = time;
   g_swings[n].isHigh = isHigh;
   g_swingCount++;
}

//+------------------------------------------------------------------+
//| ダウ理論によるトレンド分類                                         |
//|                                                                   |
//| swings[0] = 最新スウィング（最近確定）                            |
//| 上昇: 直近HighがHH、直近LowがHL（新値更新の連続）                |
//| 下降: 直近HighがLH、直近LowがLL                                  |
//|                                                                   |
//| 戻り値: 1=上昇, -1=下降, 0=不明/レンジ                          |
//+------------------------------------------------------------------+
int ClassifyTrend(SwingPoint &swings[], int count) {
   if (count < InpSwingCount * 2) return 0;

   // 最新から順に Highs / Lows を分離（各 InpSwingCount 個ずつ）
   double highs[], lows[];
   ArrayResize(highs, 0);
   ArrayResize(lows,  0);

   for (int i = 0; i < count; i++) {
      if (ArraySize(highs) >= InpSwingCount && ArraySize(lows) >= InpSwingCount) break;
      if (swings[i].isHigh && ArraySize(highs) < InpSwingCount) {
         int n = ArraySize(highs); ArrayResize(highs, n + 1); highs[n] = swings[i].price;
      }
      if (!swings[i].isHigh && ArraySize(lows) < InpSwingCount) {
         int n = ArraySize(lows); ArrayResize(lows, n + 1); lows[n] = swings[i].price;
      }
   }

   if (ArraySize(highs) < InpSwingCount || ArraySize(lows) < InpSwingCount) return 0;

   // highs[0]=最新High, highs[1]=1個前High ...
   // 上昇: highs[0] > highs[1] > ... かつ lows[0] > lows[1] > ...
   bool isUp = true;
   for (int i = 0; i < InpSwingCount - 1 && isUp; i++) {
      if (highs[i] <= highs[i + 1]) isUp = false; // 新しい高値が前より低い → HHでない
      if (lows[i]  <= lows[i + 1])  isUp = false; // 新しい安値が前より低い → HLでない
   }

   // 下降: highs[0] < highs[1] > ... かつ lows[0] < lows[1] > ...
   bool isDn = true;
   for (int i = 0; i < InpSwingCount - 1 && isDn; i++) {
      if (highs[i] >= highs[i + 1]) isDn = false; // 新しい高値が前より高い → LHでない
      if (lows[i]  >= lows[i + 1])  isDn = false; // 新しい安値が前より高い → LLでない
   }

   if (isUp) return  1;
   if (isDn) return -1;
   return 0;
}

//+------------------------------------------------------------------+
//| 上位足トレンド判定                                                 |
//+------------------------------------------------------------------+
int GetHigherTFTrend() {
   int bars = iBars(Symbol(), InpHigherTF);
   if (bars < InpSwingLookback * 2 + 5) return 0;

   SwingPoint htfSwings[];
   int        htfCount  = 0;
   int        searchEnd = MathMin(bars - InpSwingLookback - 1, 60);

   for (int i = InpSwingLookback + 1; i <= searchEnd; i++) {
      double h = iHigh(Symbol(), InpHigherTF, i);
      double l = iLow(Symbol(),  InpHigherTF, i);
      bool   isH = true, isL = true;

      for (int j = 1; j <= InpSwingLookback; j++) {
         if (iHigh(Symbol(), InpHigherTF, i - j) >= h ||
             iHigh(Symbol(), InpHigherTF, i + j) >= h) isH = false;
         if (iLow(Symbol(),  InpHigherTF, i - j) <= l ||
             iLow(Symbol(),  InpHigherTF, i + j) <= l) isL = false;
      }

      if (isH) {
         int n = ArraySize(htfSwings); ArrayResize(htfSwings, n + 1);
         htfSwings[n].price  = h;
         htfSwings[n].time   = iTime(Symbol(), InpHigherTF, i);
         htfSwings[n].isHigh = true;
         htfCount++;
      }
      if (isL) {
         int n = ArraySize(htfSwings); ArrayResize(htfSwings, n + 1);
         htfSwings[n].price  = l;
         htfSwings[n].time   = iTime(Symbol(), InpHigherTF, i);
         htfSwings[n].isHigh = false;
         htfCount++;
      }
      if (htfCount >= InpSwingCount * 2 + 4) break;
   }

   return ClassifyTrend(htfSwings, htfCount);
}

//+------------------------------------------------------------------+
//| 出来高フィルター                                                   |
//| FXではティックボリュームを代替指標として使用                       |
//+------------------------------------------------------------------+
bool VolumeAboveAverage() {
   double curVol = (double)iVolume(Symbol(), PERIOD_CURRENT, 1);
   double avgVol = 0;
   for (int i = 1; i <= InpVolPeriod; i++)
      avgVol += (double)iVolume(Symbol(), PERIOD_CURRENT, i);
   avgVol /= InpVolPeriod;
   return (curVol >= avgVol * InpVolMultiplier);
}

//+------------------------------------------------------------------+
//| スウィング高値・安値の取得ヘルパー                                 |
//+------------------------------------------------------------------+
double GetNthSwingHigh(int n) {
   int cnt = 0;
   for (int i = 0; i < g_swingCount; i++) {
      if (g_swings[i].isHigh && ++cnt == n) return g_swings[i].price;
   }
   return 0;
}

double GetNthSwingLow(int n) {
   int cnt = 0;
   for (int i = 0; i < g_swingCount; i++) {
      if (!g_swings[i].isHigh && ++cnt == n) return g_swings[i].price;
   }
   return 0;
}

//+------------------------------------------------------------------+
//| 押し目・戻り目エントリー                                           |
//|                                                                   |
//| 上昇: HH到達後の押し目（HHとHLの間のフィボゾーン）で買い         |
//| 下降: LL到達後の戻り目（LHとLLの間のフィボゾーン）で売り         |
//+------------------------------------------------------------------+
void TryPullbackEntry(int trend) {
   double ask   = SymbolInfoDouble(Symbol(), SYMBOL_ASK);
   double bid   = SymbolInfoDouble(Symbol(), SYMBOL_BID);
   double pip   = SymbolInfoDouble(Symbol(), SYMBOL_POINT) * 10; // 1pip = 0.01 for USDJPY
   double slBuf = InpSLBuffer * pip;

   if (trend == 1) {
      // 上昇トレンド：押し目買い
      double swHigh = GetNthSwingHigh(1); // 最新HH
      double swLow  = GetNthSwingLow(1);  // 直前HL
      if (swHigh == 0 || swLow == 0 || swHigh <= swLow) return;

      double range    = swHigh - swLow;
      double pbLevel  = swHigh - range * InpPullbackRatio;
      double zoneHigh = pbLevel + range * InpPBZoneBuffer;
      double zoneLow  = pbLevel - range * InpPBZoneBuffer;

      // 現在ASK価格が押し目ゾーンにあるか
      if (ask >= zoneLow && ask <= zoneHigh) {
         double sl  = NormalizeDouble(swLow - slBuf, Digits());
         double tp  = NormalizeDouble(ask + (ask - sl) * InpRRRatio, Digits());
         double lot = CalcLotSize(ask, sl);
         if (lot > 0 && g_trade.Buy(lot, Symbol(), ask, sl, tp, "Dow_PB_BUY"))
            LogTrade("押し目BUY", lot, ask, sl, tp);
      }
   }
   else if (trend == -1) {
      // 下降トレンド：戻り売り
      double swLow  = GetNthSwingLow(1);  // 最新LL
      double swHigh = GetNthSwingHigh(1); // 直前LH
      if (swLow == 0 || swHigh == 0 || swHigh <= swLow) return;

      double range    = swHigh - swLow;
      double pbLevel  = swLow + range * InpPullbackRatio;
      double zoneHigh = pbLevel + range * InpPBZoneBuffer;
      double zoneLow  = pbLevel - range * InpPBZoneBuffer;

      if (bid >= zoneLow && bid <= zoneHigh) {
         double sl  = NormalizeDouble(swHigh + slBuf, Digits());
         double tp  = NormalizeDouble(bid - (sl - bid) * InpRRRatio, Digits());
         double lot = CalcLotSize(bid, sl);
         if (lot > 0 && g_trade.Sell(lot, Symbol(), bid, sl, tp, "Dow_PB_SELL"))
            LogTrade("戻りSELL", lot, bid, sl, tp);
      }
   }
}

//+------------------------------------------------------------------+
//| ブレイクアウトエントリー                                           |
//|                                                                   |
//| 上昇: 直前確定バーがスウィングハイをブレイクしたら買い            |
//| 下降: 直前確定バーがスウィングローをブレイクしたら売り            |
//+------------------------------------------------------------------+
void TryBreakoutEntry(int trend) {
   double ask     = SymbolInfoDouble(Symbol(), SYMBOL_ASK);
   double bid     = SymbolInfoDouble(Symbol(), SYMBOL_BID);
   double pip     = SymbolInfoDouble(Symbol(), SYMBOL_POINT) * 10;
   double slBuf   = InpSLBuffer * pip;
   double boBuf   = InpBreakoutPips * pip;

   double prevClose = iClose(Symbol(), PERIOD_CURRENT, 1);
   double prevOpen  = iOpen(Symbol(),  PERIOD_CURRENT, 1);

   if (trend == 1) {
      double swHigh = GetNthSwingHigh(1);
      double swLow  = GetNthSwingLow(1);
      if (swHigh == 0 || swLow == 0) return;

      // 直前バーの終値がスウィングハイ+バッファを超えてブレイク
      bool boConfirmed = (prevClose > swHigh + boBuf) &&
                         (prevOpen  <= swHigh + boBuf);
      if (boConfirmed) {
         double sl  = NormalizeDouble(swLow - slBuf, Digits());
         double tp  = NormalizeDouble(ask + (ask - sl) * InpRRRatio, Digits());
         double lot = CalcLotSize(ask, sl);
         if (lot > 0 && g_trade.Buy(lot, Symbol(), ask, sl, tp, "Dow_BO_BUY"))
            LogTrade("ブレイクBUY", lot, ask, sl, tp);
      }
   }
   else if (trend == -1) {
      double swLow  = GetNthSwingLow(1);
      double swHigh = GetNthSwingHigh(1);
      if (swLow == 0 || swHigh == 0) return;

      bool boConfirmed = (prevClose < swLow - boBuf) &&
                         (prevOpen  >= swLow - boBuf);
      if (boConfirmed) {
         double sl  = NormalizeDouble(swHigh + slBuf, Digits());
         double tp  = NormalizeDouble(bid - (sl - bid) * InpRRRatio, Digits());
         double lot = CalcLotSize(bid, sl);
         if (lot > 0 && g_trade.Sell(lot, Symbol(), bid, sl, tp, "Dow_BO_SELL"))
            LogTrade("ブレイクSELL", lot, bid, sl, tp);
      }
   }
}

//+------------------------------------------------------------------+
//| トレーリングストップ管理                                           |
//+------------------------------------------------------------------+
void ManageTrailingStop() {
   if (!InpUseTrailing) return;

   double pip        = SymbolInfoDouble(Symbol(), SYMBOL_POINT) * 10;
   double trailStart = InpTrailingStart * pip;
   double trailStep  = InpTrailingStep  * pip;
   double point      = SymbolInfoDouble(Symbol(), SYMBOL_POINT);

   for (int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if (!PositionSelectByTicket(ticket)) continue;
      if (PositionGetInteger(POSITION_MAGIC) != InpMagicNumber) continue;
      if (PositionGetString(POSITION_SYMBOL) != Symbol()) continue;

      double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double curSL     = PositionGetDouble(POSITION_SL);
      double curTP     = PositionGetDouble(POSITION_TP);
      double bid       = SymbolInfoDouble(Symbol(), SYMBOL_BID);
      double ask       = SymbolInfoDouble(Symbol(), SYMBOL_ASK);
      ENUM_POSITION_TYPE ptype = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      if (ptype == POSITION_TYPE_BUY) {
         double floatingProfit = bid - openPrice;
         if (floatingProfit >= trailStart) {
            double newSL = NormalizeDouble(bid - trailStep, Digits());
            if (newSL > curSL + point)
               g_trade.PositionModify(ticket, newSL, curTP);
         }
      }
      else if (ptype == POSITION_TYPE_SELL) {
         double floatingProfit = openPrice - ask;
         if (floatingProfit >= trailStart) {
            double newSL = NormalizeDouble(ask + trailStep, Digits());
            if (curSL == 0 || newSL < curSL - point)
               g_trade.PositionModify(ticket, newSL, curTP);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| リスク基準のロットサイズ計算                                       |
//|                                                                   |
//| lotSize = リスク金額 / (SL距離[ticks] × tick価値)               |
//+------------------------------------------------------------------+
double CalcLotSize(double entryPrice, double slPrice) {
   double slDist = MathAbs(entryPrice - slPrice);
   if (slDist <= 0) return 0;

   double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskAmt   = balance * InpRiskPercent / 100.0;
   double tickSize  = SymbolInfoDouble(Symbol(), SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(Symbol(), SYMBOL_TRADE_TICK_VALUE);
   double lotStep   = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_STEP);
   double minLot    = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_MIN);
   double maxLot    = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_MAX);

   double ticks  = slDist / tickSize;
   double lot    = riskAmt / (ticks * tickValue);
   lot = MathFloor(lot / lotStep) * lotStep;
   lot = MathMax(minLot, MathMin(maxLot, lot));

   return lot;
}

//+------------------------------------------------------------------+
//| ポジション存在確認                                                 |
//+------------------------------------------------------------------+
bool HasOpenPosition() {
   for (int i = 0; i < PositionsTotal(); i++) {
      if (!PositionSelectByTicket(PositionGetTicket(i))) continue;
      if (PositionGetInteger(POSITION_MAGIC) == InpMagicNumber &&
          PositionGetString(POSITION_SYMBOL) == Symbol()) return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| ログ出力                                                           |
//+------------------------------------------------------------------+
void LogTrade(string type, double lot, double price, double sl, double tp) {
   double pip     = SymbolInfoDouble(Symbol(), SYMBOL_POINT) * 10;
   double slPips  = MathAbs(price - sl) / pip;
   double tpPips  = MathAbs(price - tp) / pip;
   PrintFormat("[%s] lot=%.2f entry=%.3f SL=%.3f(%.1fpips) TP=%.3f(%.1fpips)",
               type, lot, price, sl, slPips, tp, tpPips);
}
