**English** | [繁體中文](vanishing-cards.zh-TW.md)

# Troubleshooting "vanishing" cards

TapeCard (formerly StockCard) cards are Electron windows that are **transparent, frameless, always-on-top and kept off the taskbar**. Together these four properties make a card far more likely than an ordinary window to "look like it vanished":

| Property | Problem it brings |
| --- | --- |
| Transparent (`transparent: true`) | The window is still there, but as soon as its content goes wrong the whole thing is transparent and looks as if it doesn't exist |
| Frameless (`frame: false`) | There is no title bar to grab and no system menu |
| Always-on-top (`alwaysOnTop`) | Windows has only **one** topmost layer; other programs can also get to the top, or take your always-on-top away |
| Off the taskbar (`skipTaskbar: true`) | Once covered or minimized, there is **no button at all to click it back** |

So when a user says "the card is gone", the window itself is almost always still there; it has only been hidden, covered or minimized, or its content has gone wrong. Below is every case seen so far: the symptom, the real cause, how to confirm it, and how to fix it.

This document is written for this project, and also for other projects that build desktop widgets (transparent always-on-top windows). The quick reference table in section 1 can be reused as is.

---

## 1. Quick reference

| # | Symptom | Real cause | Status |
| --- | --- | --- | --- |
| A | After starting a game or certain programs the card is gone, the shortcut won't bring it back, only restarting the app does | Windows **cleared the card's topmost flag**, and the watchdog mistook it for the user turning it off | Fixed |
| B | The card gets covered while viewing pictures or watching videos | Another program is also always-on-top and is ordered **above** the card (the card's flag is still set) | Fixed |
| C | After watching a video or pressing `Win+M` the card is gone; pressing the shortcut once does nothing, twice brings it back | The card was **minimized from outside**, and the shortcut's "toggle" picked the wrong direction | Fixed |
| D | The card suddenly disappears; actually an accidental keypress | **Hide all** was triggered (`Ctrl+Alt+S` clashes with JetBrains and other software, or the tray icon was clicked) | Fixed (logging and a hint added) |
| E | After clicking an option lower down in the settings panel, the card turns into an empty translucent frame | CSS `overflow: hidden` let the card **scroll**, and the title bar and chart were scrolled out of view | Fixed |
| F | No window on startup, lots of GPU / cache errors in the terminal | **Two instances** were running at once, and the second fought the first for resources | Fixed |
| G | The card can't be seen at all while a game is full screen | While a full-screen game is in the foreground, other windows' topmost flags are **cleared continually** (measured: gone again within 1 second of being restored) | Can't be fixed; use borderless windowed instead |
| H | The card is gone after a monitor is unplugged or swapped | The window's coordinates are on a monitor that no longer exists | Corrected **at startup** only |

Causes ruled out by experiment (see section 4): a **GPU process crash** does not make the card vanish, and a **renderer process crash** freezes the picture rather than making it vanish.

---

## 2. Fixed cases

### A. Topmost flag cleared by Windows (starting a game)

**Symptom**
After starting a game (tested with Warcraft III in windowed mode), the card is gone. Pressing `Ctrl+Alt+S` doesn't help; only restarting the app brings it back.

**Cause**
When the game started, Windows removed the card's `WS_EX_TOPMOST`, the card became an ordinary window again, and the game covered it.

The app already had a watchdog that restored always-on-top every 3 seconds, but it was written like this:

```js
// Wrong: asking the window "are you on top right now?"
if (!win.isAlwaysOnTop() || !win.isVisible()) continue;
win.setAlwaysOnTop(true, 'floating');
```

Once the flag is cleared, `isAlwaysOnTop()` also returns `false`, so the watchdog assumed "the user turned always-on-top off" and skipped the window. **It skipped exactly the one case it was there to fix.** "Show" on `Ctrl+Alt+S` goes through the same function, so it couldn't fix it either.

**How to confirm**
The window is visible and not minimized, but `WS_EX_TOPMOST` is `False` (see the diagnostic script in section 5 for how to check). What was actually found at the time:

```
TapeCard    visible=True  minimized=False  topmost=False  1551,816 365x235
Warcraft III foreground window                            288,0 1344x1040
```

**Fix** (`reassertAlwaysOnTop` and `wantsOnTop` in `main/windows.js`)
When deciding whether to restore always-on-top, look at **the user's setting**, not at the window's current state:

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

// in the watchdog
if (!wantsOnTop(win) || !win.isVisible()) continue;
if (!win.isAlwaysOnTop()) console.log('[visibility] Windows dropped always-on-top from a card; restoring it');
win.setAlwaysOnTop(true, 'floating');
win.moveTop();
```

**Verification**
Always-on-top was removed from outside with `SetWindowPos(hwnd, HWND_NOTOPMOST, …)` to simulate what the game does:

- Before the fix: after 7 seconds, `topmost` was still `False`.
- After the fix: back to `True` within one watchdog cycle (under 3 seconds).
- When the user turns always-on-top off with 📌, it is **not** forced back on.

> **Lesson for other projects:** in "repair" logic, the condition must use **the user's intent** (the settings file), not **the window's current state**. The current state is exactly the thing that may have been broken.

---

### B. Covered by another always-on-top program (flag still set)

**Symptom**
While viewing pictures or watching videos, the card ends up behind them.

**Cause**
Windows has no multi-level window ordering like macOS; **`HWND_TOPMOST` is a single layer**. When another program also sets itself always-on-top, or goes full screen, it is ordered above the card and stays there. In this case the card's flag has **not** been cleared and `isAlwaysOnTop()` still returns `true`, so Electron notices nothing wrong.

**Fix**
- Every 3 seconds the watchdog calls `setAlwaysOnTop(true, 'floating')` plus `moveTop()`.
  - `setAlwaysOnTop` fixes "the flag was removed" (case A).
  - `moveTop` fixes "ordered behind others within the topmost layer" (case B).
  - Both are needed.
- `showAll()` runs it once immediately, so `Ctrl+Alt+S` works as a manual repair.

---

### C. Minimized from outside

**Symptom**
After watching a video, pressing `Win+M` or "Show desktop", the card is gone. Pressing `Ctrl+Alt+S` once does nothing; the second press brings it back. Many people give up after the first press and restart the app.

**Cause**
1. The card is `skipTaskbar`, so once minimized there is **no taskbar button** to click it back.
2. The watchdog only handled "covered". A minimized window still has `isVisible()` returning `true`, and `moveTop()` can't bring it back either. In testing, the card was still minimized after 7 seconds.
3. **The shortcut picked the wrong direction**: the app still thought the cards were "showing", so the first press ran **hide**. Nothing changed on screen, so it looked as if nothing happened.

**Fix** (`main/windows.js`)
- Card and Board windows are set to `minimizable: false`.
- Listen for the `minimize` event and restore the window as soon as it is minimized. Use `showInactive()`, **not** `restore()`, because `restore()` steals focus and interrupts the video the user is watching or the game they are playing:

  ```js
  win.on('minimize', () => {
    if (state.quitting || state.allHidden) return;
    setImmediate(() => {
      if (!win.isDestroyed() && win.isMinimized()) win.showInactive();
    });
  });
  ```

- The watchdog adds one more safeguard: any card it finds minimized is restored.
- The show/hide toggle now works like this: **if any card is not on screen, always run "show"**.

  ```js
  function toggleShowAll(reason) {
    const missing = contentWindows().some((w) => w.isMinimized() || !w.isVisible());
    if (state.allHidden || missing) showAll(reason);
    else hideAll(reason);
  }
  ```

**Verification**
- Minimizing the card with `ShowWindow(hwnd, SW_MINIMIZE)`: after the fix it is restored within 0.3 seconds.
- Hiding the card from outside with `ShowWindow(hwnd, SW_HIDE)`: after the fix one press of `Ctrl+Alt+S` brings it back.
- In normal use, pressing once to hide and again to show behaves as before.

> **Lesson for other projects:** for "toggle" actions, don't decide the direction from an internal flag alone; check the actual state first. The moment the internal flag disagrees with reality is exactly when the user needs this key.

---

### D. "Hide all" triggered by accident

**Symptom**
The card suddenly disappears, but the window is intact; it has only been hidden.

**Cause**
- `Ctrl+Alt+S` is also a shortcut in other software (for example Settings in JetBrains IDEs), and a global shortcut intercepts the keypress.
- Left-clicking the tray icon also toggles show/hide, which is easy to do by accident.
- Previously nothing was logged, and cards added while hidden didn't show either, so it looked as if the app were broken.

**Fix**
- Every hide and show writes a log line starting with `[visibility]`, stating what triggered it.
- Adding a card first cancels hide all.
- The tray tooltip says when the cards are currently hidden.

---

### E. CSS scrolling pushes the content out of view

**Symptom**
After clicking an option lower down in the settings panel (for example "Show volume pane"), the card turns into an empty translucent frame: no title bar, no chart, and no close button.

**Cause**
`.card` used to be `overflow: hidden`. `hidden` **still makes the element a scroll container**; it only hides the scrollbar. The settings panel has about 620px of content squeezed into a 222px-tall card; when focus lands on an option lower down, the browser scrolls `.card` to bring it into view, and the title bar and chart are scrolled out with it (measured: `scrollTop` was 261 and the title bar ended up at -260). With no scrollbar, the user has no way to scroll back.

**Fix**
Use `overflow: clip` instead. `clip` is not a scroll container, so the content can't be pushed away. The settings panel itself keeps `overflow-y: auto` and scrolls on its own.

> **Lesson for other projects:** if a small window holds content taller than the window, use `overflow: clip` on the outer element, not `hidden`.

---

### F. Two instances fighting over resources

**Symptom**
No window at all after startup, and the terminal shows:

```
[shortcuts] failed to bind toggleShow: taken
Unable to move the cache: (0x5)
Gpu Cache Creation failed: -2
```

It looks like a GPU problem, but it is only **two instances running at once**.

**Cause**
When `app.requestSingleInstanceLock()` fails to get the lock, the code does call `app.quit()`, but that **doesn't stop** `app.whenReady()` from continuing. So the second instance, already doomed to exit, still registers the shortcuts, creates the tray and opens the Chromium cache, all of which the first instance already holds.

**Fix**
Add `if (!gotLock) return;` at the very start of the ready handler. The second instance then exits quietly, and the first brings the cards to the front through the `second-instance` event.

> Note: those GPU error lines only mean the shader disk cache directory was locked; they have nothing to do with drawing.

---

## 3. Cases that can't be fixed or aren't handled yet

### G. Full-screen games (OS and game limitation)

When a game runs **full screen**, the card can't stay above it. Always-on-top doesn't help; the same goes for every desktop widget and even most overlays.

**Measured (Warcraft III full screen 1920×1080, in the foreground):**

| Action | Result |
| --- | --- |
| Set topmost directly with Win32 `SetWindowPos(hwnd, HWND_TOPMOST, …)` | Returns success, reads back `topmost=True` immediately |
| Read again **1 second later** | Back to `topmost=False` |
| Watchdog restores it every 3 seconds | Restored every time, then cleared right away (the log recorded "dropped always-on-top" 29 times in 90 seconds) |

In other words, while a game is full screen in the foreground, other windows' topmost flags are cleared continually, and no amount of restoring makes them stick. With the same game in **windowed mode** (1344×1040), the card floats above it normally.

This also affects range alerts (and price alerts): in full screen the card's glow can't be seen, the taskbar is covered by the game, and Windows notifications are held back by Focus Assist. The only things that could get through are **sound** or **phone push notifications**, and neither has been built yet.

**Workaround:** in the game's settings, switch to "**borderless windowed**" or "windowed mode". With case A fixed, the card floats above the game.

### H. Monitors changed while running

`store.normalizeBounds()` checks only **at startup** whether a card's coordinates still fall on an existing monitor. If an external monitor is unplugged while the app is running, cards that were on it stay at coordinates that no longer exist until the next restart.

**Not handled yet.** To handle it, listen for `screen.on('display-removed')` and `screen.on('display-metrics-changed')` and reapply `normalizeBounds` to every window.

---

## 4. Causes ruled out by experiment

These two are the most common guesses for "a video or game made the card vanish". Both were tested, and **neither is the cause**:

| Hypothesis | Experiment | Result |
| --- | --- | --- |
| GPU process crash (video decoding, driver reset) | Killed `electron.exe --type=gpu-process` directly | Chromium started a new GPU process immediately, the card kept updating prices normally, **it did not vanish** |
| The card's renderer process crashed | Crashed the card renderer with CDP's `Page.crash` | The card **stayed on its last frame** (picture frozen, desktop behind it changing as usual), **it did not vanish** |

The Windows event log was also checked: no display driver reset (TDR, event 4101) and no Electron application errors.

> If you do one day see "picture frozen, prices not moving", that is a renderer process problem. There is currently no automatic reload; consider listening for `webContents.on('render-process-gone')` and calling `reload()`.

---

## 5. Diagnostics

### 5.1 Read the log

The main process's `console.log` prints to the terminal under both `npm start` and `npm run dev`. Visibility-related entries all start with `[visibility]`:

```
[visibility] all cards hidden (show/hide shortcut); Ctrl+Alt+S or the tray icon brings them back
[visibility] showing all cards (tray icon click)
[visibility] a card was minimized from outside; restoring it
[visibility] Windows dropped always-on-top from a card; restoring it
```

When a card vanishes, look at the last few `[visibility]` lines first; in most cases they tell you which case it is.

### 5.2 Query the window state directly (PowerShell)

When the card is gone but the app is still running, run the snippet below to see the real state of every card. It **only reads and changes nothing**:

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
# The callback is called by Windows, and strings output inside it are discarded, so collect first and print at the end.
$found = New-Object System.Collections.ArrayList
[W]::EnumWindows({ param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256; [W]::GetWindowText($h, $sb, 256) | Out-Null
  if ($sb.ToString() -eq 'TapeCard') { [void]$found.Add($h) }
  return $true }, [IntPtr]::Zero) | Out-Null
foreach ($h in $found) {
  $r = New-Object W+RECT; [W]::GetWindowRect($h, [ref]$r) | Out-Null
  "visible={0} minimized={1} topmost={2} rect={3},{4} {5}x{6}" -f `
    [W]::IsWindowVisible($h), [W]::IsIconic($h), [bool]([W]::GetWindowLong($h, -20) -band 0x8), `
    $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T)
}
if (-not $found.Count) { 'No window found: the app is not running, or the title is not TapeCard' }
```

Run against a normally working app, the output looks like this:

```
visible=True minimized=False topmost=True rect=1551,816 365x235
```

Replace `'TapeCard'` with your window title (that is, the HTML `<title>`) to use it in other projects.

| Result | What it means |
| --- | --- |
| `visible=False` | Hidden (case D, or hidden from outside) |
| `minimized=True` | Minimized (case C) |
| `topmost=False`, but the user has always-on-top on | Topmost flag cleared (case A) |
| `topmost=True`, but still not visible | Covered by another always-on-top window (case B), or exclusive full screen (case G) |
| `rect` is not within any monitor | Coordinates off screen (case H) |
| All of the above normal, but the card is empty | A content problem (case E), or the renderer process crashed (section 4) |
| Window not found | The app isn't running, or two instances conflicted (case F) |

### 5.3 Reproducing by simulation (on a test instance)

Start a **separate test instance** with a different `--user-data-dir` so the real settings and cards aren't touched:

```bash
./node_modules/electron/dist/electron.exe . --remote-debugging-port=9333 --user-data-dir=<temp folder>
```

Then simulate what outside programs do with the Win32 API:

| Case to simulate | Call |
| --- | --- |
| Minimized (C) | `ShowWindow(hwnd, 6)`, i.e. `SW_MINIMIZE` |
| Hidden from outside | `ShowWindow(hwnd, 0)`, i.e. `SW_HIDE` |
| Always-on-top removed (A) | `SetWindowPos(hwnd, (IntPtr)(-2), 0, 0, 0, 0, 0x13)`, i.e. `HWND_NOTOPMOST` plus `NOMOVE\|NOSIZE\|NOACTIVATE` |
| GPU process crash | Run `Stop-Process` on the `electron.exe` with `--type=gpu-process` |
| Renderer process crash | CDP's `Page.crash` |

> **Note:** global shortcuts (such as `Ctrl+Alt+S`) are registered only by the **first** instance started. If the real app is also open, a shortcut you send to the test instance actually acts on the real app.

---

## 6. Checklist for other projects

If your Electron app has windows that are **transparent, always-on-top and off the taskbar**, check each item:

- [ ] **Base the always-on-top repair on the settings file, not on `isAlwaysOnTop()`.** Windows clears the flag, and once cleared `isAlwaysOnTop()` returns `false` too. (Case A)
- [ ] **Periodically call both `setAlwaysOnTop(true, 'floating')` and `moveTop()`.** The first fixes the flag, the second fixes the ordering; both are needed. (Cases A, B)
- [ ] **Set `skipTaskbar` windows to `minimizable: false`, and listen for the `minimize` event and restore with `showInactive()`.** Don't use `restore()`; it steals focus. (Case C)
- [ ] **Have the show/hide toggle check the actual state first.** If any window is not on screen, always run show. (Case C)
- [ ] **Log every hide and show, stating what triggered it.** (Case D)
- [ ] **Keep global shortcuts away from common combinations**, or let the user customize them. (Case D)
- [ ] **Use `overflow: clip` on the outer element of small windows, not `hidden`.** (Case E)
- [ ] **When `requestSingleInstanceLock()` fails, `return` inside `whenReady`.** (Case F)
- [ ] **At startup, check that coordinates are still on an existing monitor**; ideally also listen for monitor changes while running. (Case H)
- [ ] **Explain the exclusive full-screen limitation to users**, and suggest borderless windowed mode instead. (Case G)
- [ ] **Provide a rescue entry point that works without seeing the window**, such as a tray menu or a global shortcut.
