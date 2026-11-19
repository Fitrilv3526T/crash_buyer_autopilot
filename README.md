# Crash Buyer paper trader

Runs by itself on GitHub every 15 minutes. No server, no API keys. It watches Binance public data, and when BTC is down 5%+ in 24h
it looks for coins down 20%+ in 24h (the "M2c + BTC crash" rule), then runs three paper accounts (BASE, HARSH, LIVE-LIKE) that buy at the
next hourly open and sell 24h later, using 5% of equity per trade and at most 50% invested. Paper trading only: it never places real orders.

## Set up (about 10 minutes, once)
1. github.com > **New repository**, name it `crash-buyer`, **Public**, Create.
2. **uploading an existing file**, drag in everything from this folder (`.github`, `docs`, `scanner`, `config.json`, `README.md`), **Commit changes**.
   If the hidden `.github` folder does not upload: **Add file > Create new file**, name `.github/workflows/scan.yml`, paste that file's content.
3. **Settings > Pages**: Deploy from a branch, branch `main`, folder `/docs`, Save.
4. **Actions** tab: enable workflows if asked, open **crash-buyer scan**, click **Run workflow**. The first run starts the paper account.
5. Open your Pages address and bookmark it.

## Why every 15 minutes
Signals only form when an hourly candle closes, and the backtest edge shrinks fast with delay (+6.9% per trade at the next open, +3.3% one hour late with
big slippage). Runs are at minutes 2, 17, 32 and 47, so the first look comes a few minutes after each candle closes (not at :00, when GitHub is busiest).
GitHub often delays scheduled runs by 5-20 minutes. The page's Fill quality tab measures the real delay and price drift. Quiet runs take about 20 seconds.

## Settings
Edit `config.json` (pencil icon). Optional keys: `frac`, `maxExp`, `maxPos`, `startEquity`, `fee`, `slipBase`, `slipHarsh`, `slipLive`, `coinDrop`, `btcDrop`, `minVol`.
Delete the `startMs` line to restart the account.

## Things to know
- Expect few signals: about 10 crash episodes a year in the backtest. Judge the results only after 15+ closed trades across 5+ episodes (Progress tab).
- If the scheduler is down for more than about 4 hours during a crash, signals in that gap are missed. The page warns when data is old.
- GitHub may pause scheduled jobs after 60 days without repo activity. A keep-alive step is included; if the page says data is old, re-enable the workflow in Actions.
- Coins outside the 57-coin backtest are tagged NEW. Coins that vanish are counted as a total loss.
- Optional phone alerts: add repo secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
