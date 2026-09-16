# TP

Generic test platform. The server exposes adapter capabilities, workers execute behavior trees, and adapter sessions operate external resources. The platform core stays adapter-neutral.

| Document                | Purpose                   |
| ----------------------- | ------------------------- |
| [AGENTS.md](AGENTS.md)  | Repository rules          |
| [DESIGN.md](DESIGN.md)  | UI design identity        |
| [docs/](docs/README.md) | Adapter and runtime notes |

## Run

Requires Node 22+ and npm. Browser runs require Chromium:

```bash
npm install
npx playwright install chromium
npm run server          # :3000, loads Browser adapter
npm run dev             # :5173, proxies /api to :3000
```

In another shell, create and run a Browser smoke case:

```bash
CASE_ID=$(
  curl -sS -X POST http://127.0.0.1:3000/api/cases \
    -H 'content-type: application/json' \
    --data '{
      "name": "Browser smoke",
      "definition": {
        "main": "Main",
        "trees": {
          "Main": {
            "type": "Sequence",
            "children": [
              {
                "type": "Action",
                "adapter": "browser",
                "actor": "browser",
                "capability": "browser.goto",
                "ports": {
                  "url": { "literal": "http://127.0.0.1:5173/" }
                }
              },
              {
                "type": "Condition",
                "adapter": "browser",
                "actor": "browser",
                "capability": "browser.expect_text",
                "ports": {
                  "selector": { "literal": "body" },
                  "text": { "literal": "TP Test Platform" }
                }
              }
            ]
          }
        }
      }
    }' \
    | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).id'
)

curl -sS -X POST http://127.0.0.1:3000/api/runs \
  -H 'content-type: application/json' \
  --data "{\"caseId\":\"$CASE_ID\"}"
```

Production-style local run:

```bash
npm run build
npm start
```

## Test

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```

`npm test` runs each workspace's `node:test` suite plus root integration tests. Browser session tests skip when Chromium is unavailable.

## Defaults

| Item      | Value                   | Override                  |
| --------- | ----------------------- | ------------------------- |
| Server    | `http://0.0.0.0:3000`   | `HOST` / `PORT`           |
| Dev UI    | `http://127.0.0.1:5173` | Vite                      |
| Data      | `data/tp.json`          | `TP_DATA_FILE`            |
| Workers   | 1                       | `TP_WORKER_THREADS`       |
| Queue cap | 1000                    | `TP_RUN_QUEUE_CAPACITY`   |
| Adapter   | `TP_ADAPTER_MODULES`    | startup-only registration |

Contracts: `/swagger`, `/openapi.json`. Lists use `{ items, total }` with paired `limit` / `offset`. Errors use `{ code, message }`.

## MCP

The project includes Codex, Cursor, and generic MCP launch configs that run `npm run mcp`. Start `npm run server` first. For a non-default server URL, set `TP_BASE_URL`, for example:

```bash
TP_BASE_URL=http://127.0.0.1:3000 npm run mcp
```

## Architecture

- **Server**: catalog, case persistence, and run queue. It does not interpret actors or touch resources.
- **Worker**: fixed in-process thread pool. One worker executes one run at a time.
- **Adapter**: typed leaf capabilities. Each run owns its own session, which interprets actors and resource semantics.
- Cases are `{ main, trees }`. Blackboard bindings are `{ key }` / `{ literal }`.
- Behavior tree execution follows BT.CPP v4 semantics. Infinite `Repeat` / `RetryUntilSuccessful` use `-1` and stop by cancellation.
- Active runs (`queued` / `running` / `canceling`) live in memory. `data/tp.json` stores terminal runs only.
- The web UI polls `GET /api/runs` and `GET /api/workers` every 2 seconds.
- Packages: `contract` / `log` / `metrics` / `server` / `web` / `adapters/<name>`. Cross-package tests live in `test/`.
