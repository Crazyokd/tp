# TP

Generic test platform. The server exposes adapter capabilities, workers execute behavior trees, and adapter sessions operate external resources. The platform core stays adapter-neutral.

| Document                | Purpose                   |
| ----------------------- | ------------------------- |
| [AGENTS.md](AGENTS.md)  | Repository rules          |
| [DESIGN.md](DESIGN.md)  | UI design identity        |
| [docs/](docs/README.md) | Adapter and runtime notes |

## Run

Requires Node.js 22.12 or later and npm. Browser runs require Chromium:

```bash
npm ci
npx playwright install chromium
HOST=127.0.0.1 npm run server  # :3000, loads Browser adapter
npm run dev             # :5173, proxies /api to :3000
```

In another shell, create a Browser smoke case and start a Batch:

```bash
CASE_ID=$(
  curl -fsS -X POST http://127.0.0.1:3000/api/cases \
    -H 'content-type: application/json' \
    --data '{
      "name": "Browser smoke",
      "description": "Verify that the TP page loads",
      "definition": {
        "main": "Main",
        "sessions": [
          {
            "adapter": "browser",
            "actor": "browser",
            "ports": { "origin": { "literal": "http://127.0.0.1:5173" } }
          }
        ],
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
                  "url": { "literal": "/" }
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

BATCH_ID=$(
  curl -fsS -X POST http://127.0.0.1:3000/api/batches \
    -H 'content-type: application/json' \
    --data "{\"caseIds\":[\"$CASE_ID\"],\"trigger\":{\"kind\":\"ci\"}}" \
    | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).id'
)

curl -fsS "http://127.0.0.1:3000/api/batches/$BATCH_ID"
```

Refresh the Batch until its `status` is `passed`. In the Runs page you can expand its member Run to see the behavior tree and the Browser recording.

To serve the built UI and API on port 3000:

```bash
npm run build
HOST=127.0.0.1 npm start
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
| Retention | 7 days                  | `TP_RUN_RETENTION_DAYS`   |
| Adapter   | `TP_ADAPTER_MODULES`    | startup-only registration |

API documentation is available at `/swagger` and `/openapi.json`. Paginated lists use `{ items, total }` with paired `limit` and `offset`. The Server prunes terminal Batches and their Run artifacts after the retention period.

## MCP

The project includes Codex, Cursor, and generic MCP launch configs that run `npm run mcp`. Start `npm run server` first. For a non-default server URL, set `TP_BASE_URL`, for example:

```bash
TP_BASE_URL=http://127.0.0.1:3000 npm run mcp
```

## Architecture

- The Server registers adapter capabilities, stores Cases, Groups and Batches, and queues Runs. Each Worker executes one behavior tree at a time.
- A Case defines `{ main, trees, sessions }`. Each Run gets its own adapter sessions for the `(adapter, actor)` pairs in its tree. Session ports can reference the Run blackboard.
- A Group references existing Cases. Starting a Batch from a Group or a list of Cases snapshots the selection and creates one Run for each selected Case.
- The UI pages through Batches and watches expanded Runs over server-sent events. Cancel a Batch or a single Run from the Runs page.
- The Server stores data in `data/tp.json`. Active Runs interrupted by a restart finish with an error. The Batch and session APIs supersede the earlier Browser case payload and Run creation endpoint.

To upgrade from the earlier public version, start the new version in a fresh checkout. Keep the earlier checkout’s `data/` directory as an archive of its cases, runs, and artifacts.
