**English** | [繁體中文](CONTRIBUTING.zh-TW.md)

# Contributing

How to work on TapeCard without breaking it: the checks to run, the rules for translations and documentation, how the screenshots are made, and the safety rules around trading keys.

## Setup

```bash
npm install       # also copies lightweight-charts into renderer/vendor/
npm run dev       # run, with the renderer console in the terminal
```

Windows 10 / 11 and Node.js 22 or later. The code layout and the reasons behind it are in [Architecture](docs/design/architecture.md).

## Before every commit

```bash
npm test          # eleven suites, no network, no account
npm run check     # syntax of the whole tree + every UI string translated
```

Both must pass. A new feature comes with tests in `scripts/test-*.mjs` for its arithmetic (see the existing suites: they fake the socket and `fetch`, so nothing touches Binance), and is added to the `test` script in `package.json`.

To try a change in the real app without touching your own settings, start it on a separate profile:

```bash
./node_modules/electron/dist/electron.exe . --dev --user-data-dir=<a temp folder>
```

An explicit `--user-data-dir` always wins over the pinned `%APPDATA%/stock-card` folder, so the test instance has its own cards, drawings and trading environment.

## Interface strings

- Write UI text in Chinese inside `t('…')`; the Chinese is the key (`renderer/i18n.js`, `main/i18n.js`).
- Add the English to `renderer/i18n/en.json`. **Append new keys at the end. Never re-sort the file or rewrite existing keys**: other code and old configs depend on them, and a re-sort turns every diff into noise.
- Placeholders are `{name}` and must match on both sides. `npm run check` fails on a missing translation, an untranslated string or a placeholder mismatch.

## Documentation

| Where | What goes there |
| --- | --- |
| `README.md` | What the app is, a few screenshots, how to start, the keys to learn first, links. Keep it short |
| `docs/guide/` | How to use each feature, for people using the app |
| `docs/design/` | Why it is built this way, for people changing it |
| `docs/troubleshooting/` | Diagnosing problems |
| `CHANGELOG.md` | What changed, newest first |

- **Every page exists in English (`name.md`) and Traditional Chinese (`name.zh-TW.md`)**, with the language switcher on line 1. Change both in the same commit.
- A user-visible change updates its guide page; a change in how something works updates its design page. If a guide page explains "why" at length, the explanation belongs in `docs/design/` with a link.
- UI labels are quoted as the English interface shows them in English pages and as the Chinese interface shows them in Chinese pages.
- Check that relative links and `#anchors` still resolve after moving or renaming a heading.

## Screenshots

The images in `docs/images/` are made by a script, not by hand:

```bash
npm run shots                       # every image (about ten minutes)
npm run shots -- --only hero,walls  # some of them; --list shows the names
npm run shots -- --collect 12       # collect order flow longer before photographing it
```

`scripts/screenshots.mjs` starts the app on a **new, empty profile in the temp folder**, switches trading to the **local paper account** (it refuses to place any order unless the app reports paper), sets each card up through the same bridge the pages use, and captures the windows at 2x with the Chrome DevTools Protocol. It never touches `%APPDATA%/stock-card` and stops only the process it started. Windows appear on screen while it runs; leave the machine alone until it says `done`.

Rules for images:

- Made with the script, so they are consistent and can be remade when the UI changes. Add new images to the script, not by hand.
- Paper account only: no real balance, position or key tail ever appears.
- One subject per image, at the card sizes the script uses; aim for under 250 KB. Images stay in the git history forever, so replace rather than add variants.
- Chart images are shared by both languages. Only text-heavy windows (the shortcuts window) get a `-zh` version.
- Every image has alt text that says what it shows.

## Trading code and keys

- Anything that touches money stays in the main process (`main/trading/`). Pages send intents through `preload/preload.js`, never keys or raw signed requests.
- Never log, print, commit or send a key or secret. At most the last four characters are shown.
- Keys live DPAPI-encrypted in `%APPDATA%/stock-card/trading-credentials.bin`, outside the repository. Nothing under `%APPDATA%/stock-card/` is ever copied into the repo.
- Develop against the paper account or the testnet. `STOCKCARD_TESTNET_REST` / `STOCKCARD_TESTNET_WS` can point the testnet at a local mock; the live URLs can't be overridden.
- Every order path keeps the two-press confirmation and the main-process rounding.

## Commits

- English, imperative subject line ("Add …", "Fix …", "Draw …"), with a body that says what changed and why, including any measurements.
- One logical change per commit. Run `npm test` and `npm run check` first.
- Update `CHANGELOG.md` and `CHANGELOG.zh-TW.md` for anything a user would notice.
- If you work from more than one machine, `git fetch` before committing and rebase if the remote moved.
