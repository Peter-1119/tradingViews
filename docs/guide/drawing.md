**English** | [繁體中文](drawing.zh-TW.md)

# Drawing

Horizontal levels, trend lines, Fib retracements, rectangles and the measure gesture, plus colours, hiding and undo. The volume-profile tools are in [Levels & volume profiles](levels.md).

## Where drawings are kept

- **Per symbol, not per card or interval.** A level on BTCUSDT appears on every BTCUSDT card and stays put when you switch between 1m, 15m and 1d. Levels at the same price are de-duplicated.
- **Shared by spot and perp.** Levels, trend lines, Fibs, rectangles and range volume profiles are kept per symbol regardless of market: the basis between BTCUSDT spot and perp is usually a basis point or two, so a support level holds on both, and the undo history carries over too. Contracts with scaled prices (`1000PEPEUSDT`) are different symbols and keep their own drawings; prices a thousand times apart could not be shared anyway.
- Fib anchors, trend-line ends and rectangle corners are stored as **{time, price}**, not bar indices. An index only means something within the bars currently loaded and points at a different bar after a timeframe change.

## Horizontal levels

| Action | How |
| --- | --- |
| Add | **Double-click** empty chart space, in any mode (`Ctrl` snaps to the nearest OHLC). Or pick the horizontal line tool and click |
| Move | Drag the line (`Ctrl` snaps) |
| Delete | Double-click the line |

## Trend lines

Pick **trend line** (the diagonal icon), then **drag** from one point to another, or **click** each end (the line follows the mouse in between; `Esc` cancels). It is a solid segment between the two points, not a ray.

- `Ctrl` snaps to OHLC. Holding `Shift` makes it **horizontal or vertical**, whichever way the mouse has moved more; this also applies when dragging an end or the whole line, and while the trend tool is selected `Shift` no longer measures.
- Drag an end to adjust it, drag the body to move the line, double-click to delete.

## Fib retracements

Pick Fib retracement and drag across the swing. Drag the end dots to adjust; double-click a dot to delete. The retracement lines span the full chart width: on a card this small, what you want to know is how far price is from each level now.

## Rectangles

Pick rectangle and drag out a price zone with a start and end time.

- **Drag the border** to move it, **drag a corner** to resize (the opposite corner stays put), **double-click** to delete.
- Hold `Shift` while dragging to lock the direction: a corner changes only the width (time) or only the height (price), and the border moves only horizontally or only vertically.
- The inside is deliberately not grabbable, so you can still pan the chart from inside the box.

## Measure

Hold `Shift` and drag: the price difference, percentage, bar count and duration. Add `Ctrl` to snap to OHLC. The readout stays after you release; click empty space or press `Esc` to clear it.

Measuring is first of all a gesture, as TradingView's quick measure is, because on a card this size a gesture costs no screen space; the toolbar button is there for anyone who has not learned it. The box is anchored in bar coordinates rather than pixels, so it follows the bars as you pan and zoom and can sit in the empty space right of the last bar.

## Colours

**Right-click** a level, trend line or rectangle for a row of colours: default blue, **green** (support), **red** (resistance), orange, yellow, purple and white, say one for weekly levels and another for intraday ones. The current colour is ringed. The colour is saved with the drawing (across restarts, intervals and both markets) and `Ctrl+Z` undoes it. Right-clicking anywhere else still opens the settings panel.

## Hide drawings

The **eye** icon (or `Alt+H`) hides every level, trend line, Fib, rectangle and range volume profile at once for a clean chart; press it again to bring them back.

- They are only not drawn, not deleted, and the state is saved with the card (still hidden after a restart).
- Hidden drawings can't be grabbed, so you never drag a line you can't see. Picking up a drawing tool, adding a level or pressing `Ctrl+Z` while hidden shows them again, so a new line does not vanish as soon as you let go.
- Price alerts, position and order lines, opens and highs / lows are not drawings and stay visible.

## Undo

`Ctrl+Z` undoes adding, moving, recolouring and deleting levels, trend lines, Fibs, rectangles and range volume profiles, for example a line dragged by accident while dragging the time axis. Each card keeps its own history; switching symbols clears it.
