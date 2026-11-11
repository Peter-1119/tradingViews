[English](data-sources.md) | **繁體中文**

# 資料來源

圖上的一切都來自公開端點，免註冊、免 API Key：幣安的，溢價加上 Coinbase 的，清算還加上 Bybit 和 OKX 的。只有交易會用到你的金鑰（[交易內部設計](trading.zh-TW.md)）。

## 主機

| 市場 | REST | WebSocket |
| --- | --- | --- |
| 現貨 | `api.binance.com/api/v3` | `stream.binance.com:9443/stream` |
| U 本位永續 | `fapi.binance.com/fapi/v1` | `fstream.binance.com/market/stream`；掛單簿在 `fstream.binance.com/public/stream` |
| 其他交易所的清算 | `www.okx.com/api/v5/public/instruments`（合約大小） | `stream.bybit.com/v5/public/linear`、`ws.okx.com:443/ws/v5/public` |
| Coinbase | `api.exchange.coinbase.com` | `ws-feed.exchange.coinbase.com` |

兩個市場的 REST 路徑和 stream 名稱相同，所以是同一個 `BinanceProvider` 帶不同的市場設定，重連、回補和合併全部沿用。

**永續的 socket 一定要連 `/market/stream`。** 舊的 `/stream` 還連得上，但已經不送 kline、成交和 ticker，卡片會顯示「即時」卻完全不動。永續的深度串流只在 `/public/stream` 上，所以掛單簿有自己的連線。

## 端點

| 資料 | 來源 |
| --- | --- |
| 歷史 K 線 | `GET /klines`（一頁 500 根） |
| 即時 K 棒與價格 | combined stream：`@kline_<interval>` + `@miniTicker` + `@aggTrade`；永續多一條 `@markPrice` |
| 交易對清單 | `GET /exchangeInfo`，快取 24 小時。永續取合約類型 `PERPETUAL` 和 `TRADIFI_PERPETUAL`（美股、ETF、貴金屬、原油、外匯），不含交割合約 |
| 24h 漲跌 | 啟動時打一次 `/ticker/24hr`，之後由 miniTicker 更新 |
| 資金費率 | 啟動時打一次 `/premiumIndex`，之後由 `@markPrice`（每 3 秒）更新。結算週期來自 `/fundingInfo`，只列出不是 8 小時的幣種（快取 1 小時） |
| 未平倉量 | 每 3 秒輪詢 `/fapi/v1/openInterest`；歷史 `GET /futures/data/openInterestHist`（5m，30 天） |
| 多空比 | `/futures/data/globalLongShortAccountRatio`（帳戶）與 `/topLongShortPositionRatio`（大戶持倉）：5m 樣本，30 天 |
| 足跡圖、大單 | 即時用已訂閱的 `@aggTrade`；缺的分鐘用 `GET /aggTrades`（用 `startTime` / `endTime` 取一分鐘，超過 1,000 筆再用 `fromId` 往後翻），每秒最多一次 |
| 掛單牆 | `GET /depth` 快照（現貨每邊 5,000 檔、永續 1,000 檔）加上 `@depth` 變動串流 |
| Coinbase 溢價與 CVD | `GET /products`（美元交易對，快取 6 小時）、`GET /products/{id}/candles`（每頁 300 根，算溢價和 USDT-USD）、`GET /products/{id}/trades`（每頁 1,000 筆，啟動時補最近 3 小時），以及即時的 `matches` 頻道（[分析指標](analytics.zh-TW.md#coinbase-溢價)） |
| 清算 | Binance `!forceOrder@arr`、Bybit `allLiquidation.{symbol}`、OKX `liquidation-orders`（[分析指標](analytics.zh-TW.md#清算)）；估計清算區用上面的 5 分 K 和 OI 歷史 |

## 更新頻率

幣安的 `@kline_*` 每秒推一次，這是 K 棒官方數值的上限。為了讓價格跳得更即時，另外訂了逐筆的 `@aggTrade`，在兩次 kline 之間把成交價併進「正在形成的那根」的收盤、最高、最低和成交量。

逐筆訊息在 hub 端以 **100ms** 為窗口合併（`LIVE_TICK_MS`），同一窗口只送出最後一筆，所以不論行情多熱，每張卡最多每秒重繪十次。kline 一到就用官方數值覆蓋，誤差最多存活一秒。跨棒那一刻不自己開新 K 棒，等 kline 來換棒。

## 連線韌性

- 斷線後以指數退避重連：1 秒 → 2 秒 → 4 秒 → … → 30 秒。
- 重連後重新訂閱全部 stream，並用 REST 補齊斷線期間缺的 K 線，再接回即時流。
- 有訂閱、卻安靜超過一分鐘的 socket 視為已死、換一條（活著的連線一定有東西，光是永續的標記價格就每 3 秒一筆）；安靜的 stream 跳過的 K 棒也會補上。
- 連線滿 23 小時主動換一條，避開幣安 24 小時的強制斷線。
- 卡片左上角的小圓點顯示狀態：綠是即時、黃是重連中、紅是離線。不會跳錯誤視窗。

這些行為有 `npm test` 涵蓋（`scripts/test-datafeed.mjs`，用假的 socket 和 fetch），不需要真的拔網路線也能驗證。

## 請求額度

幣安的 REST 以每個 IP 的權重限流，而且**公開行情和下單共用同一個額度**。背景工作都有讓出空間：

- 足跡補資料：`/aggTrades` 一次權重 20，每分鐘上限 2,400，所以每秒最多一次（最多用一半額度），回應標頭的已用權重超過 1,500 就等下一分鐘，遇到 429 / 418 照 `Retry-After` 暫停。
- OI 和多空比的歷史有自己的額度（每 5 分鐘 1,000 次），不會用到下單的額度。
- OI 歷史端點不管 `startTime` 設多早，一律回傳範圍內**最新**的 500 筆，所以要從新往舊翻頁（實測一次要 10 天只拿到最後 41 小時）。

- Coinbase 的公開 API 每個 IP 每秒上限 10 次。K 線每秒最多發 5 次、成交每秒最多 3 次，兩邊同時進行，每個請求 15 秒沒回應就放棄。

## DNS

有些網路查詢 Coinbase 主機時，系統 DNS 會回一個永遠不會回應的位址（台灣部分網路業者回的是 `182.173.0.181` 的封鎖頁）。所以 App 的視窗改用 DNS over HTTPS 查詢網址（`main/secure-dns.js`，用 Electron 的 `app.configureHostResolver` 安全模式，先 Cloudflare 再 Google），在第一個視窗打開前就設定好。只有查網址這一步改變，連線仍然直接連到交易所。它涵蓋 Chromium 發出的請求，也就是 hub 和卡片；交易用的是 Node 的 `fetch`，維持系統的 DNS，所以下單永遠不依賴它。系統匣選單可以立刻關閉。

## 幣種對應

「現貨 / 永續」標籤需要知道同一個幣種在另一個市場叫什麼（`renderer/datafeed/binance.js` 的 `counterpartSymbol`）：

1. TradFi 永續對應它的代幣化股票：基礎資產 + `B`（`SNDKUSDT` → `SNDKBUSDT`），沒有就沒有。
2. 否則找同名的交易對，前提是另一邊有、而且不是 TradFi 合約。
3. 現貨基礎資產結尾是 `B` 時，對應去掉 `B` 的 TradFi 永續（`SNDKBUSDT` → `SNDKUSDT`），所以 `ARB` 這種幣不會被誤認成代幣化股票。
4. 否則找放大報價的名稱：`1000PEPEUSDT`、`1000000MOGUSDT` 等，兩個方向都可以。

測試用以前出過問題的情況檢查：`WEN`（幣和股票代幣撞名）、`ARB`、沒有代幣的黃金。
