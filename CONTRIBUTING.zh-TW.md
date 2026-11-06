[English](CONTRIBUTING.md) | **繁體中文**

# 貢獻指南

修改 TapeCard 時怎麼不把它弄壞：要跑哪些檢查、翻譯和文件的規則、截圖怎麼做，以及交易金鑰的安全規則。

## 環境

```bash
npm install       # 同時把 lightweight-charts 複製到 renderer/vendor/
npm run dev       # 執行，並把 renderer 的 console 轉到終端機
```

Windows 10 / 11，Node.js 22 以上。程式架構和背後的理由見[架構](docs/design/architecture.zh-TW.md)。

## 每次 commit 之前

```bash
npm test          # 十一套測試，不連網路、不碰帳戶
npm run check     # 全樹語法檢查 + 每個介面字串都有翻譯
```

兩個都要通過。新功能要在 `scripts/test-*.mjs` 加上它的計算測試（參考現有的測試：它們用假的 socket 和 `fetch`，不會連到幣安），並加進 `package.json` 的 `test` 指令。

想在真的 App 上試改動、又不想動到自己的設定，就用另一個設定檔啟動：

```bash
./node_modules/electron/dist/electron.exe . --dev --user-data-dir=<暫存資料夾>
```

明確指定的 `--user-data-dir` 一定優先於固定的 `%APPDATA%/stock-card` 資料夾，所以測試用的那一份有自己的卡片、繪圖和交易環境。

## 介面字串

- 介面文字用中文寫在 `t('…')` 裡，中文就是鍵（`renderer/i18n.js`、`main/i18n.js`）。
- 英文加在 `renderer/i18n/en.json`。**新的鍵一律加在最後面，絕對不要重新排序或改寫既有的鍵**：其他程式和舊設定都依賴它們，重新排序也會讓每個 diff 都變成雜訊。
- 佔位符寫成 `{name}`，兩邊必須一致。缺翻譯、沒包 `t()` 或佔位符不一致時，`npm run check` 會失敗。

## 文件

| 位置 | 放什麼 |
| --- | --- |
| `README.md` | App 是什麼、幾張截圖、怎麼啟動、先學的按鍵、連結。保持簡短 |
| `docs/guide/` | 每個功能怎麼用，給使用者看 |
| `docs/design/` | 為什麼這樣做，給要改程式的人看 |
| `docs/troubleshooting/` | 問題排查 |
| `CHANGELOG.md` | 改了什麼，新的在前 |

- **每一頁都有英文（`name.md`）和繁體中文（`name.zh-TW.md`）兩份**，第 1 行是語言切換。兩份在同一個 commit 裡一起改。
- 使用者看得到的改動，更新對應的使用手冊頁；做法的改動，更新對應的設計文件頁。使用手冊裡如果長篇解釋「為什麼」，那段應該搬到 `docs/design/`，再放連結。
- 介面標籤在英文頁寫英文介面上的字，在中文頁寫中文介面上的字。
- 移動或改名標題後，確認相對連結和 `#錨點` 還連得到。

## 截圖

`docs/images/` 的圖片是用腳本產生的，不是手動截：

```bash
npm run shots                       # 全部圖片（約十分鐘）
npm run shots -- --only hero,walls  # 只拍其中幾張；--list 列出名稱
npm run shots -- --collect 12       # 先收集訂單流久一點再拍
```

`scripts/screenshots.mjs` 會用**暫存資料夾裡全新的空白設定檔**啟動 App，把交易切到**本機模擬帳戶**（App 回報不是模擬時拒絕下任何單），透過畫面使用的同一座橋設定每張卡片，再用 Chrome DevTools Protocol 以 2 倍解析度截取視窗。它絕對不碰 `%APPDATA%/stock-card`，結束時也只關掉它自己啟動的程式。執行期間螢幕上會出現視窗，在它顯示 `done` 之前請不要操作電腦。

圖片的規則：

- 用腳本產生，風格才會一致，介面改了也能重拍。新增圖片時加進腳本，不要手動截。
- 只用模擬帳戶：畫面上永遠不會出現真實的餘額、倉位或金鑰末碼。
- 一張圖一個主題，使用腳本裡的卡片尺寸，盡量在 250 KB 以內。圖片會永遠留在 git 歷史裡，所以用取代的，不要多加變體。
- 圖表類截圖中英共用。只有文字多的視窗（快捷鍵視窗）才另外有 `-zh` 版本。
- 每張圖都要有說明內容的替代文字。

## 交易程式與金鑰

- 跟錢有關的一律留在主行程（`main/trading/`）。畫面只透過 `preload/preload.js` 送出意圖，絕對不傳金鑰或已簽名的請求。
- 絕對不要把金鑰或 Secret 寫進 log、印出來、commit 或傳出去。最多只顯示末四碼。
- 金鑰以 DPAPI 加密存在 `%APPDATA%/stock-card/trading-credentials.bin`，在 repo 外面。`%APPDATA%/stock-card/` 底下的任何東西都不能複製進 repo。
- 用模擬帳戶或測試網開發。`STOCKCARD_TESTNET_REST` / `STOCKCARD_TESTNET_WS` 可以把測試網指到本機的模擬交易所；正式環境的網址不能被覆寫。
- 每一條下單路徑都要保留兩下確認和主行程取整。

## Commit

- 用英文、祈使句的標題（"Add …"、"Fix …"、"Draw …"），內文說明改了什麼、為什麼，有實測數字就寫上。
- 一個 commit 一件事。先跑 `npm test` 和 `npm run check`。
- 使用者感覺得到的改動，同時更新 `CHANGELOG.md` 和 `CHANGELOG.zh-TW.md`。
- 在多台電腦上工作時，commit 前先 `git fetch`，遠端有新的就 rebase。
