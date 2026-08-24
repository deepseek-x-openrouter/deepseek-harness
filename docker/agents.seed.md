# This machine

You are running inside a container image built for this deployment. It is
yours: nothing here is shared with the host, and a mistake costs a rebuild.

You are the user `dsh` (uid 10001). There is no root and no `sudo`.

## Where things live

| Path | |
|---|---|
| `/workspace` | your working directory, and the only place to put files you want kept |
| `/data` | the harness's own home — sessions, settings, credentials |
| `/opt/dsh` | the harness installation, read-only to you |

Everything outside those two volumes is reset when the container is recreated,
including anything you install.

## What is installed

- **Node 26** (`node`, `npm`, `npx`, `pnpm`) and **Bun 1.4** (`bun`, `bunx`).
- **Python 3.14** in a virtualenv at `/opt/venv`, already on `PATH` — `python`
  and `pip` are that venv's. It holds pandas, polars, numpy, pyarrow, duckdb,
  scipy, statsmodels, scikit-learn, matplotlib, plotly, requests, httpx, rich,
  IPython, visidata, and the market packages below.
- **DuckDB** (`duckdb`), `sqlite3`, and `psql` with `psycopg` for Postgres.
- The usual shell tooling: `rg`, `fd`, `jq`, `yq`, `git`, `curl`, `wget`,
  `tmux`, `htop`, `tree`, `rsync`, `ssh`, `dig`, `nc`, `socat`, plus a C/C++
  toolchain (`gcc`, `g++`, `make`, `pkg-config`).

Install more when you need it — `pip install X`, `uv pip install X` (much
faster), `uv tool install X` for a standalone CLI, `npm i -g X`, `bun add -g X`.
All of it works without root and all of it disappears on the next recreate, so
say so if something ought to be added to the image instead.

There is no display. Charts must be written to files (`matplotlib` is already
set to the `Agg` backend); put them under `/workspace` so they can be opened.

## Working with tabular and market data

Reach for **DuckDB** before pandas on anything file-shaped or large. It queries
CSV, Parquet, JSON and SQLite in place, out of core, without a load step:

```sh
duckdb -c "select count(*), min(ts), max(ts) from read_parquet('bars/*.parquet')"
```

Its window functions cover most of what price data asks for — returns,
rolling volatility, drawdown, resampling to another bar size — in one query,
and `COPY (…) TO 'out.parquet'` writes the result back out. Use pandas or
polars when the next step is Python (indicators, models, plots), and hand large
inputs to polars rather than pandas.

### If a Postgres database is configured

`PGHOST` and the other `PG*` variables carry it, so all three routes connect
with no connection string at all:

```sh
psql -c '\dt'                                   # the client, interactively
duckdb -c "ATTACH '' AS pg (TYPE postgres, READ_ONLY); show all tables"
```

```python
import psycopg                                   # from Python
with psycopg.connect() as cx: ...
```

The DuckDB route is usually the one you want for analysis: attached tables
join against local Parquet and CSV in the same query, so a pull-then-analyze
step disappears. `READ_ONLY` on the attachment is the habit to keep — and
check `echo $PGHOST` before assuming a database exists at all.

For markets specifically: `yfinance` fetches equity, ETF and FX history,
`ccxt` reaches roughly a hundred crypto exchanges through one API, and `ta`
computes the standard indicator set over a pandas frame. `vd <file>` opens any
of it as a terminal spreadsheet when eyeballing beats querying.

Prices are money. State the window, the timezone and the bar size you used,
never silently forward-fill a gap, and be explicit when a result is a
backtest rather than a measurement.
