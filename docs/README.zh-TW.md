[English](README.md) | **繁體中文**

# TapeCard 文件

[← 回到專案首頁](../README.zh-TW.md)

第一次用？先看[看盤基本操作](guide/chart.zh-TW.md)和[卡片與視窗](guide/windows.zh-TW.md)，然後在任一張卡片上按 `F1` 看全部按鍵的總表。

## 使用手冊

每個功能怎麼用。

| 頁面 | 內容 |
| --- | --- |
| [看盤基本操作](guide/chart.zh-TW.md) | 縮放平移、十字線、價格與時間、大週期疊圖、RSI / MACD、工具列、介面語言 |
| [幣種與市場](guide/markets.zh-TW.md) | 搜尋幣種、現貨 ↔ 永續、美股與商品永續、常用清單 |
| [畫圖](guide/drawing.zh-TW.md) | 水平線、趨勢線、斐波那契、矩形、量測、顏色、隱藏、撤銷 |
| [關鍵價位與成交量分布](guide/levels.zh-TW.md) | 日／週／月開盤價、高低點、成交量分布、區間成交量分布 |
| [訂單流](guide/order-flow.zh-TW.md) | 成交量、CVD、Coinbase 溢價、未平倉量、多空比、大單、倉位判讀、掛單牆、清算、足跡圖 |
| [提醒](guide/alerts.zh-TW.md) | 價格、成交量、位置提醒，以及玩遊戲時通知怎麼送到 |
| [下單](guide/trading.zh-TW.md) | 幣安永續：設定、下單票、止盈止損、拖曳改價、反手 |
| [模擬交易](guide/paper-trading.zh-TW.md) | 本機練習帳戶、成交與成本怎麼算、紀錄視窗 |
| [卡片與視窗](guide/windows.zh-TW.md) | Float 與 Board、迷你 K 線與價格條、滑鼠穿透、設定、快捷鍵、已知限制 |

## 設計文件

給要修改程式的人：為什麼這樣做。

| 頁面 | 內容 |
| --- | --- |
| [架構](design/architecture.zh-TW.md) | 行程、隱藏的 hub 視窗、`app://`、介面語言、原始碼檔案、測試 |
| [資料來源](design/data-sources.zh-TW.md) | 幣安端點、更新頻率、重連、請求額度、現貨 ↔ 永續的幣種對應 |
| [資料儲存](design/storage.zh-TW.md) | 設定、K 線快取、未平倉量記錄、大單、足跡圖、金鑰檔 |
| [分析指標](design/analytics.zh-TW.md) | 成交量分布、位置提醒、縮量、RSI / MACD、CVD、Coinbase 溢價、大單、倉位判讀、掛單牆、清算 |
| [交易內部設計](design/trading.zh-TW.md) | 金鑰、取整、精確的委託編號、改價、反手、模擬交易所 |
| [足跡圖](design/footprint.zh-TW.md) | 足跡圖從評估到實作，含實測數字 |
| [原始規格](design/original-spec.zh-TW.md) | 專案一開始依據的規格（歷史文件） |

## 疑難排解

| 頁面 | 內容 |
| --- | --- |
| [卡片消失排查](troubleshooting/vanishing-cards.zh-TW.md) | 目前遇過卡片消失的每一種情況、怎麼判斷、怎麼修 |

## 給貢獻者

[CONTRIBUTING.zh-TW.md](../CONTRIBUTING.zh-TW.md) 說明要跑哪些檢查、翻譯和這些文件的規則，以及截圖怎麼做。依日期整理的變更在 [CHANGELOG.zh-TW.md](../CHANGELOG.zh-TW.md)。
