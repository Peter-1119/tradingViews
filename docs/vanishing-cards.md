# 卡片「消失」排查手冊

StockCard 的卡片是**透明、無邊框、置頂、不在工作列**的 Electron 視窗。這四個特性組合起來，讓它比一般視窗更容易「看起來消失」：

| 特性 | 帶來的問題 |
| --- | --- |
| 透明 (`transparent: true`) | 視窗還在，但內容一出狀況，整塊就是透明的，看起來跟不存在一樣 |
| 無邊框 (`frame: false`) | 沒有標題列可以抓，也沒有系統選單 |
| 置頂 (`alwaysOnTop`) | Windows 只有**一層** topmost，別的程式也能搶到最上面，或把你的置頂拿掉 |
| 不在工作列 (`skipTaskbar: true`) | 被蓋住、被最小化之後，**沒有任何按鈕可以把它點回來** |

所以使用者說「卡片不見了」的時候，視窗本身幾乎都還在，只是被隱藏、被蓋住、被縮小，或是內容跑掉了。下面列出目前遇過的每一種情況：症狀是什麼、真正的原因、怎麼確認，以及怎麼修。

這份文件寫給本專案，也寫給其他做桌面小工具（透明置頂視窗）的專案。第 1 節的快速對照表可以直接拿去用。

---

## 1. 快速對照表

| # | 症狀 | 真正原因 | 狀態 |
| --- | --- | --- | --- |
| A | 開遊戲或某些程式之後卡片不見，按快捷鍵也叫不回來，重開 App 才好 | Windows 把卡片的**置頂旗標清掉了**，watchdog 又誤判成使用者自己取消的 | 已修 |
| B | 看圖片、看影片的時候卡片被蓋住 | 別的程式也是置頂，排到卡片**上面**（卡片的旗標還在） | 已修 |
| C | 看影片或按 `Win+M` 之後卡片不見，按一次快捷鍵沒反應，按兩次才出來 | 卡片被**外部最小化**，加上快捷鍵的「切換」方向判斷錯誤 | 已修 |
| D | 卡片突然不見，其實是誤觸 | 按到**全部隱藏**（`Ctrl+Alt+S` 跟 JetBrains 等軟體衝突，或點到托盤圖示） | 已修（加紀錄、加提示） |
| E | 開設定面板點了下面的選項，卡片變成一個空的半透明框 | CSS `overflow: hidden` 讓卡片被**捲動**，標題列和圖表被捲出畫面 | 已修 |
| F | 啟動沒有視窗，終端機一堆 GPU / cache 錯誤 | 同時跑了**兩個實例**，第二個跟第一個搶資源 | 已修 |
| G | 遊戲全螢幕時卡片完全看不到 | 遊戲用**獨佔全螢幕**，Windows 不允許任何視窗蓋在上面 | 作業系統限制，無法修 |
| H | 拔掉或換了螢幕之後卡片不見 | 視窗座標落在已經不存在的螢幕上 | 只有**啟動時**會修正 |

實驗排除的原因（詳見第 4 節）：**GPU 行程當掉**不會讓卡片消失，**渲染行程當掉**則是畫面凍結、不會消失。

---

## 2. 已修正的情況

### A. 置頂旗標被 Windows 清掉（開遊戲）

**症狀**
開始玩遊戲（實測是 Warcraft III 的視窗模式）後，卡片就不見了。按 `Ctrl+Alt+S` 沒用，要重開 App 才回來。

**原因**
遊戲啟動時，Windows 把卡片的 `WS_EX_TOPMOST` 拿掉了，卡片變回普通視窗，被遊戲蓋在後面。

程式本來就有每 3 秒補回置頂的 watchdog，但它是這樣寫的：

```js
// 錯誤：問視窗「你現在有沒有置頂」
if (!win.isAlwaysOnTop() || !win.isVisible()) continue;
win.setAlwaysOnTop(true, 'floating');
```

旗標被清掉之後，`isAlwaysOnTop()` 也跟著回傳 `false`，watchdog 就以為是「使用者自己取消了置頂」而跳過。**它剛好跳過了它唯一該修的那種情況。** `Ctrl+Alt+S` 的「顯示」走同一個函式，所以也修不好。

**怎麼確認**
視窗是可見、沒被最小化的，但 `WS_EX_TOPMOST` 是 `False`（查法見第 5 節的診斷腳本）。當時實際查到的結果：

```
StockCard   visible=True  minimized=False  topmost=False  1551,816 365x235
Warcraft III 前景視窗                                     288,0 1344x1040
```

**修法**（`main/windows.js` 的 `reassertAlwaysOnTop` 和 `wantsOnTop`）
判斷要不要補回置頂時，看的是**使用者的設定**，而不是視窗目前的狀態：

```js
function wantsOnTop(win) {
  if (win === state.board) return store.getBoard().alwaysOnTop;
  for (const [cardId, cardWin] of state.cards) {
    if (cardWin !== win) continue;
    const card = store.getCard(cardId);
    return !!card && card.alwaysOnTop !== false;
  }
  return false;
}

// watchdog 裡
if (!wantsOnTop(win) || !win.isVisible()) continue;
if (!win.isAlwaysOnTop()) console.log('[visibility] Windows dropped always-on-top from a card; restoring it');
win.setAlwaysOnTop(true, 'floating');
win.moveTop();
```

**驗證**
用 `SetWindowPos(hwnd, HWND_NOTOPMOST, …)` 從外部拿掉置頂來模擬遊戲的行為：

- 修正前：等了 7 秒，`topmost` 還是 `False`。
- 修正後：一個 watchdog 週期（3 秒內）就變回 `True`。
- 使用者自己按 📌 取消置頂時，**不會**被強制改回去。

> **給其他專案的教訓：** 「修復」類的邏輯，判斷條件一定要用**使用者的意圖**（設定檔），不要用**視窗目前的狀態**。目前狀態正是可能被破壞的那個東西。

---

### B. 被其他置頂程式蓋住（旗標還在）

**症狀**
看圖片、看影片時，卡片被蓋在後面。

**原因**
Windows 沒有像 macOS 那樣的多層視窗等級，**`HWND_TOPMOST` 只有一層**。另一個程式也設成置頂，或切到全螢幕時，就會排到卡片上面，而且一直停在那裡。這種情況下卡片的旗標**沒有**被清掉，`isAlwaysOnTop()` 仍然回傳 `true`，所以 Electron 不會察覺任何異狀。

**修法**
- watchdog 每 3 秒呼叫一次 `setAlwaysOnTop(true, 'floating')` 加上 `moveTop()`。
  - `setAlwaysOnTop` 負責修「旗標被拿掉」（情況 A）。
  - `moveTop` 負責修「在 topmost 那一層裡被排到後面」（情況 B）。
  - 兩者缺一不可。
- `showAll()` 會立刻執行一次，所以 `Ctrl+Alt+S` 可以當作手動修復。

---

### C. 被外部最小化

**症狀**
看影片、按了 `Win+M` 或「顯示桌面」之後，卡片不見了。按一次 `Ctrl+Alt+S` 沒反應，按第二次才出來；很多人按一次沒反應就直接重開 App。

**原因**
1. 卡片是 `skipTaskbar`，被最小化之後，工作列上**沒有按鈕**可以點回來。
2. watchdog 只處理「被蓋住」。最小化的視窗 `isVisible()` 仍然是 `true`，`moveTop()` 也救不回來。實測等了 7 秒，卡片還是縮著。
3. **快捷鍵的方向判斷錯誤**：App 還以為卡片「正在顯示」，所以第一次按執行的是**隱藏**，畫面上什麼都沒變，看起來就像沒反應。

**修法**（`main/windows.js`）
- 卡片和 Board 視窗設成 `minimizable: false`。
- 監聽 `minimize` 事件，一被縮小就立刻恢復。要用 `showInactive()`，**不要**用 `restore()`，因為 `restore()` 會搶走焦點，打斷使用者正在看的影片或正在玩的遊戲：

  ```js
  win.on('minimize', () => {
    if (state.quitting || state.allHidden) return;
    setImmediate(() => {
      if (!win.isDestroyed() && win.isMinimized()) win.showInactive();
    });
  });
  ```

- watchdog 多做一道保險：看到被最小化的卡片就恢復。
- 顯示/隱藏的切換改成：**只要有任何卡片不在畫面上，就一律執行「顯示」**。

  ```js
  function toggleShowAll(reason) {
    const missing = contentWindows().some((w) => w.isMinimized() || !w.isVisible());
    if (state.allHidden || missing) showAll(reason);
    else hideAll(reason);
  }
  ```

**驗證**
- 用 `ShowWindow(hwnd, SW_MINIMIZE)` 縮小卡片：修正後 0.3 秒內就恢復。
- 用 `ShowWindow(hwnd, SW_HIDE)` 從外部藏起卡片：修正後按一次 `Ctrl+Alt+S` 就回來。
- 正常情況下，按一次隱藏、再按一次顯示，行為不變。

> **給其他專案的教訓：** 「切換」類的操作，方向不能只依賴程式內部的旗標，要先看實際狀態。內部旗標跟現實不一致，正是使用者需要按這個鍵的時候。

---

### D. 誤觸「全部隱藏」

**症狀**
卡片突然不見，但視窗完好，其實只是被隱藏了。

**原因**
- `Ctrl+Alt+S` 同時也是別的軟體的快捷鍵（例如 JetBrains IDE 的 Settings），而全域快捷鍵會把按鍵攔截走。
- 左鍵點托盤圖示也會切換顯示/隱藏，很容易誤觸。
- 以前不會留下任何紀錄，而且隱藏期間新增的卡片也不會顯示，看起來就像 App 壞了。

**修法**
- 每次隱藏、顯示都用 `[visibility]` 開頭記一行 log，寫明是誰觸發的。
- 新增卡片時，會先解除全部隱藏。
- 托盤的 tooltip 會標示卡片目前是隱藏狀態。

---

### E. CSS 捲動把內容推出畫面

**症狀**
在設定面板點了下方的選項（例如「顯示成交量副圖」）之後，卡片變成一個空的半透明框：看不到標題列、看不到圖表，也沒有關閉鈕。

**原因**
`.card` 原本是 `overflow: hidden`。`hidden` **仍然會讓元素成為捲動容器**，它只是把捲軸藏起來而已。設定面板有大約 620px 的內容，卻塞在 222px 高的卡片裡；焦點落到下方的選項時，瀏覽器會捲動 `.card` 讓它進入視野，標題列和圖表就一起被捲出去了（實測 `scrollTop` 是 261，標題列跑到 -260 的位置）。因為沒有捲軸，使用者沒有辦法捲回來。

**修法**
改成 `overflow: clip`。`clip` 不是捲動容器，內容不會被推走。設定面板本身保留 `overflow-y: auto`，讓它自己捲動。

> **給其他專案的教訓：** 小視窗裡如果放了比視窗還高的內容，外層要用 `overflow: clip`，不要用 `hidden`。

---

### F. 兩個實例互相搶資源

**症狀**
啟動後沒有任何視窗，終端機出現：

```
[shortcuts] failed to bind toggleShow: taken
Unable to move the cache: (0x5)
Gpu Cache Creation failed: -2
```

看起來像 GPU 出問題，其實只是**同時開了兩個實例**。

**原因**
`app.requestSingleInstanceLock()` 拿不到鎖的時候雖然會呼叫 `app.quit()`，但這**擋不住** `app.whenReady()` 繼續執行。於是注定要結束的第二個實例還是去註冊快捷鍵、建立托盤、開 Chromium cache，這些資源全都已經被第一個實例佔住了。

**修法**
在 ready handler 的一開頭加上 `if (!gotLock) return;`。這樣第二個實例會安靜地結束，第一個實例則透過 `second-instance` 事件把卡片叫到前面。

> 附註：GPU 那幾行錯誤只是 shader 的磁碟快取目錄被鎖住，跟畫面繪製無關。

---

## 3. 無法修或尚未處理的情況

### G. 獨佔全螢幕（作業系統限制）

遊戲使用 **exclusive fullscreen（獨佔全螢幕）** 時，Windows 不允許任何視窗蓋在上面。置頂也沒用，所有桌面小工具、甚至大部分的 overlay 都一樣。

**解法：** 在遊戲設定裡改成「**無邊框視窗**」（borderless windowed）或「視窗模式」。修好情況 A 之後，卡片就能浮在遊戲上面。

### H. 執行中換了螢幕

`store.normalizeBounds()` 只在**啟動時**檢查卡片座標是否還落在現有的螢幕上。如果 App 執行到一半拔掉外接螢幕，原本在那台螢幕上的卡片就會留在一個不存在的座標，直到下次重開。

**尚未處理。** 要處理的話，可以監聽 `screen.on('display-removed')` 和 `screen.on('display-metrics-changed')`，對每個視窗重新套用一次 `normalizeBounds`。

---

## 4. 實驗排除的原因

這兩個是「影片或遊戲讓卡片消失」最常見的猜測，都做過實驗，**都不是原因**：

| 假設 | 實驗 | 結果 |
| --- | --- | --- |
| GPU 行程當掉（影片解碼、驅動重置） | 直接砍掉 `electron.exe --type=gpu-process` | Chromium 立刻重開新的 GPU 行程，卡片繼續正常更新價格，**不會消失** |
| 卡片的渲染行程當掉 | 用 CDP 的 `Page.crash` 讓 card renderer 當掉 | 卡片**停在最後一幀**（畫面凍結、背後桌面照常變化），**不會消失** |

另外查過 Windows 事件記錄：沒有顯示卡驅動重置（TDR，事件 4101），也沒有 Electron 的應用程式錯誤。

> 如果之後真的遇到「畫面凍結、價格不動」，那才是渲染行程的問題。目前沒有自動重載的機制，可以考慮監聽 `webContents.on('render-process-gone')` 後呼叫 `reload()`。

---

## 5. 診斷方法

### 5.1 看 log

主行程的 `console.log` 在 `npm start` 和 `npm run dev` 下都會印到終端機。跟可見性有關的紀錄都以 `[visibility]` 開頭：

```
[visibility] all cards hidden (show/hide shortcut); Ctrl+Alt+S or the tray icon brings them back
[visibility] showing all cards (tray icon click)
[visibility] a card was minimized from outside; restoring it
[visibility] Windows dropped always-on-top from a card; restoring it
```

卡片消失時，先看最後幾行 `[visibility]`，大部分情況就能判斷出是哪一種。

### 5.2 直接查視窗狀態（PowerShell）

卡片不見、但 App 還在跑的時候，執行下面這段就能看到每張卡片的真實狀態，**只讀取、不修改任何東西**：

```powershell
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
}
"@
# 回呼是由 Windows 呼叫的，在裡面直接輸出的字串會被丟掉，所以先收集、最後再印。
$found = New-Object System.Collections.ArrayList
[W]::EnumWindows({ param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256; [W]::GetWindowText($h, $sb, 256) | Out-Null
  if ($sb.ToString() -eq 'StockCard') { [void]$found.Add($h) }
  return $true }, [IntPtr]::Zero) | Out-Null
foreach ($h in $found) {
  $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null
  "visible={0} minimized={1} topmost={2} rect={3},{4} {5}x{6}" -f `
    [W]::IsWindowVisible($h), [W]::IsIconic($h), [bool]([W]::GetWindowLong($h, -20) -band 0x8), `
    $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T)
}
if (-not $found.Count) { '找不到視窗：App 沒在跑，或標題不是 StockCard' }
```

實際在正常運作的 App 上跑出來的結果長這樣：

```
visible=True minimized=False topmost=True rect=1551,816 365x235
```

把 `'StockCard'` 換成你的視窗標題（也就是 HTML 的 `<title>`），就能用在其他專案。

| 結果 | 代表的情況 |
| --- | --- |
| `visible=False` | 被隱藏了（情況 D，或被外部藏起來） |
| `minimized=True` | 被最小化（情況 C） |
| `topmost=False`，但使用者有開置頂 | 置頂旗標被清掉（情況 A） |
| `topmost=True`，但還是看不到 | 被別的置頂視窗蓋住（情況 B），或是獨佔全螢幕（情況 G） |
| `rect` 不在任何螢幕的範圍內 | 座標跑出螢幕（情況 H） |
| 以上都正常，卡片卻是空的 | 內容的問題（情況 E），或渲染行程當掉（第 4 節） |
| 找不到視窗 | App 沒在跑，或是兩個實例衝突（情況 F） |

### 5.3 模擬重現（在測試實例上做）

用另一個 `--user-data-dir` 啟動**獨立的測試實例**，就不會動到正式的設定和卡片：

```bash
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9333 --user-data-dir=<暫存資料夾>
```

接著用 Win32 API 模擬外部程式的行為：

| 要模擬的情況 | 呼叫 |
| --- | --- |
| 被最小化（C） | `ShowWindow(hwnd, 6)`，也就是 `SW_MINIMIZE` |
| 被外部隱藏 | `ShowWindow(hwnd, 0)`，也就是 `SW_HIDE` |
| 置頂被拿掉（A） | `SetWindowPos(hwnd, (IntPtr)(-2), 0, 0, 0, 0, 0x13)`，也就是 `HWND_NOTOPMOST` 加上 `NOMOVE\|NOSIZE\|NOACTIVATE` |
| GPU 行程當掉 | 對 `--type=gpu-process` 的 `electron.exe` 執行 `Stop-Process` |
| 渲染行程當掉 | CDP 的 `Page.crash` |

> **注意：** 全域快捷鍵（例如 `Ctrl+Alt+S`）只會註冊在**第一個**啟動的實例上。如果正式版也開著，對測試實例送出的快捷鍵其實會作用在正式版上。

---

## 6. 給其他專案的檢查清單

如果你的 Electron App 有**透明、置頂、不在工作列**的視窗，請逐項確認：

- [ ] **置頂的修復判斷用設定檔，不用 `isAlwaysOnTop()`。** Windows 會清掉旗標，清掉之後 `isAlwaysOnTop()` 也會回傳 `false`。（情況 A）
- [ ] **定期同時呼叫 `setAlwaysOnTop(true, 'floating')` 和 `moveTop()`。** 前者修旗標，後者修排序，缺一不可。（情況 A、B）
- [ ] **`skipTaskbar` 的視窗設成 `minimizable: false`，並監聽 `minimize` 事件後用 `showInactive()` 恢復。** 不要用 `restore()`，它會搶焦點。（情況 C）
- [ ] **顯示/隱藏的切換先看實際狀態。** 只要有視窗不在畫面上，就一律執行顯示。（情況 C）
- [ ] **每次隱藏和顯示都記 log，寫明觸發來源。**（情況 D）
- [ ] **全域快捷鍵避開常見組合**，或讓使用者可以自訂。（情況 D）
- [ ] **小視窗的外層用 `overflow: clip`，不要用 `hidden`。**（情況 E）
- [ ] **拿不到 `requestSingleInstanceLock()` 時，要在 `whenReady` 裡 `return`。**（情況 F）
- [ ] **啟動時檢查座標是否還在現有的螢幕上**；最好執行中也監聽螢幕變化。（情況 H）
- [ ] **跟使用者說明獨佔全螢幕的限制**，建議改用無邊框視窗模式。（情況 G）
- [ ] **提供一個不需要看到視窗就能用的救援入口**，例如托盤選單或全域快捷鍵。
