# Browser Adapter

每个 Run 一个 headless Chromium + 一页。平台不认识 Playwright。没有安装器；Case 里填绝对 `http`/`https` URL。

## 环境

```bash
npx playwright install chromium
TP_ADAPTER_MODULES=@tp/adapter-browser npm run server
```

默认 `npm run server` 只加载 Browser。无 Chromium 时 session 测试 skip。

## 叶子

`adapter: "browser"`。`actor` 必须与 Session 一致，默认 `browser`。不规定顺序。超时用树上的 `Timeout`，不进口。

| key                   | kind      | 入                                   | 成功出              |
| --------------------- | --------- | ------------------------------------ | ------------------- |
| `browser.goto`        | Action    | `url`（绝对 http(s)）                | `{ url }`           |
| `browser.click`       | Action    | `selector`                           | `{ clicked: true }` |
| `browser.fill`        | Action    | `selector`、`value`（可空）          | `{ filled: true }`  |
| `browser.expect_text` | Condition | `selector`、`text`（大小写敏感包含） | `{ text }`          |
| `browser.screenshot`  | Action    | `name`（`[A-Za-z0-9._-]`）           | `{ path }`          |

`selector` 原样给 `page.locator`。截图在 `data/runs/<runId>/`，平台不建模。

## Session

首次碰到 `(browser, actor)` 时 `chromium.launch({ headless: true })`。无全局锁，多 Run 可并行。同 Session 的 `tick` 串行。`halt` 按树 `path` 只打一片。`cleanup` 先 halt 再关 page/browser。

启动失败抛错。找不到元素、文本不匹配、非法 name、错误 actor、非 http(s)、cleanup 后再 tick → `{ status: 'FAILURE', output: { error } }`。

## Case 骨架

```json
{
  "type": "Sequence",
  "children": [
    {
      "type": "Action",
      "adapter": "browser",
      "actor": "browser",
      "capability": "browser.goto",
      "ports": { "url": { "literal": "http://127.0.0.1:5173/" } }
    },
    {
      "type": "Action",
      "adapter": "browser",
      "actor": "browser",
      "capability": "browser.fill",
      "ports": { "selector": { "literal": "#name" }, "value": { "literal": "world" } }
    },
    {
      "type": "Action",
      "adapter": "browser",
      "actor": "browser",
      "capability": "browser.click",
      "ports": { "selector": { "literal": "#go" } }
    },
    {
      "type": "Condition",
      "adapter": "browser",
      "actor": "browser",
      "capability": "browser.expect_text",
      "ports": { "selector": { "literal": "#out" }, "text": { "literal": "hello world" } }
    },
    {
      "type": "Action",
      "adapter": "browser",
      "actor": "browser",
      "capability": "browser.screenshot",
      "ports": { "name": { "literal": "after-hello" } }
    }
  ]
}
```
