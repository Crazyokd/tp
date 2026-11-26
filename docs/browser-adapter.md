# Browser Adapter

每个 Run 一个 headless Chromium + 一页。平台不认识 Playwright。没有安装器。Session 口 `origin` 必填，是不带路径的绝对 `http`/`https`。`browser.goto` 只收以 `/` 开头的路径，拼到该 `origin`。目录是通用页面原语，不含业务文案。

## 环境

```bash
npx playwright install chromium
npm run server
```

默认 `npm run server` 加载 Browser Adapter。无 Chromium 时，依赖 Chromium 的测试跳过。

## 选择器

`selector` 是 Playwright locator 字符串，原样 `page.locator(selector)`：

- CSS：`#go`、`canvas >> nth=0`、`[aria-label="虚拟键盘"]`
- role：`role=button[name="下一步"]`
- text：`text=基本信息-1/4`；精确用引号 `text="操作完成"`
- 链式：`[aria-label="虚拟键盘"] >> role=button[name="确认"]`

超时用树上的 `Timeout`，不进口。

## 叶子

`adapter: "browser"`。`actor` 必须与 Session 一致，默认 `browser`。不规定顺序。

| key                    | kind      | 入                                                                                                                                                                                   | 成功出                                                          |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `browser.goto`         | Action    | `url`（以 `/` 开头的路径，拼到 Session `origin`）                                                                                                                                    | `{ url }`                                                       |
| `browser.click`        | Action    | `selector`；可选 `waitResponseUrl` / `waitResponseMethod` / `waitResponseStatus`                                                                                                     | `{ clicked }`；等待时带 `responseStatus`/`responseUrl`          |
| `browser.fill`         | Action    | `selector`、`value`（可空）                                                                                                                                                          | `{ filled: true }`                                              |
| `browser.expect_text`  | Condition | `selector`、`text`（大小写敏感包含）                                                                                                                                                 | `{ text }`                                                      |
| `browser.screenshot`   | Action    | `name`（`[A-Za-z0-9._-]`）                                                                                                                                                           | `{ path }`                                                      |
| `browser.canvas_probe` | Condition | `selector`；可选 `minimumWidth` / `minimumHeight` / `minimumOccupiedPixels` / `minimumCenterOccupiedPixels` / `previousHash`                                                         | `{ hash, occupiedPixels, centerOccupiedPixels, width, height }` |
| `browser.expect`       | Condition | `selector`、`assertion`（visible/hidden/enabled/disabled/checked/unchecked/value/attribute/count）；`value` 用 `expected`；`attribute` 用属性名，可选 `expected`；`count` 用 `count` | `{ matched: true }`                                             |
| `browser.expect_url`   | Condition | `regex`（RegExp 源）                                                                                                                                                                 | `{ url }`                                                       |
| `browser.reload`       | Action    | 无                                                                                                                                                                                   | `{ url }`                                                       |
| `browser.mouse`        | Action    | `action`（move/down/up/drag）、`selector`、`xRatio`/`yRatio`；`drag` 再加 `toXRatio`/`toYRatio`，可选 `steps`                                                                        | `{ done: true }`                                                |
| `browser.touch_drag`   | Action    | `selector`、`xRatio`/`yRatio`、`toXRatio`/`toYRatio`、`steps` 全部必填；坐标为元素内 0..1 比例，步数为正整数                                                                         | `{ done: true }`                                                |
| `browser.route`        | Action    | `url`（glob）、`action`（abort/fulfill/hold）；`fulfill` 必填 `status`，可选 `body`/`contentType`/`times`                                                                            | `{ routed: true }`                                              |
| `browser.unroute`      | Action    | `url`                                                                                                                                                                                | `{ unrouted: true }`                                            |
| `browser.release`      | Action    | `url`、`action`（fulfill/abort）；fulfill 口同 `route`；可选 `expectedRequestText`                                                                                                   | `{ released: true, requestBody }`                               |

`waitResponseUrl` 不含 `*` 时对响应 URL 做子串，含 `*` 时当 glob。只给 method/status、不给 url → `FAILURE`。先等响应再点，避免丢请求。 点击与响应等待共同处理：点击失败时不会留下未处理的响应等待异常。

`touch_drag` 发送真实触屏拖动事件；鼠标和触屏手势由不同原语表达。每次手势后释放触屏控制连接。

`route`+`hold` 按 glob FIFO 捏住请求；下一叶 `release` 再 fulfill/abort。同 Session 的 tick 串行，所以 `click` 不得等待被 hold 的 fetch 结束。`unroute` 会先 abort 未放行的 hold。`times` 交给 Playwright。

截图在 `data/runs/<runId>/browser/<actor>/`，平台不建模。每个 `createSession` 独立 Chromium + Context + Page；cookie / storage / route / 页面互不影响。Case 之间靠 `resourceRoot = data/runs/<runId>` 隔离。

新 Browser Session 的录屏和页面截图默认显示白色深描边小手，点击时出现 550ms 的橙色圆环；页面跳转或刷新后重新启用，iframe 子文档也显示各自的指针。指示层不接收点击或键盘焦点，内部图形使用隔离的 Shadow DOM，不增加页面的 `svg` / `button` 匹配项。`canvas_probe` 截图时临时排除此装饰，使画布 hash / 占像素仍只反映被测内容。既有录屏不回填指针。

## Session

首次存在 `(browser, actor)` 时 `chromium.launch({ headless: true })` + `newContext` + `newPage`。每个 Session 实例自己的进程与 Context，不共享 userDataDir。

| 口                         | 含义                                                    |
| -------------------------- | ------------------------------------------------------- |
| `origin`                   | 必填。绝对 `http`/`https`，不能带路径、查询、用户名密码 |
| `viewportWidth` + `Height` | 可选，必须成对；只给一个则 `createSession` 失败         |
| `locale`                   | 可选。浏览器 locale                                     |
| `timezoneId`               | 可选。IANA 时区                                         |
| `initScript`               | 可选。每次导航前注入；业务常量写在 Case 里              |

不填 viewport 则 Playwright 默认 viewport。Case 根仍必须有一行 `sessions`，且该行带 `origin`。`origin` 可以接本 Run 的黑板键，在首次创建 Session 时读取并固定。主文档导航、链接、表单和多跳 HTTP 重定向不得离开该 origin；弹出窗口不属于受控 Page，直接拒绝。跨 origin 请求发出前终止导航，并把错误记在叶子上。无全局锁，多 Run 可并行。同 Session 的 `tick` 串行。`halt` 按树 `path` 只打一片。`cleanup` 先 halt，abort 未放行 hold，再关 page/context/browser。Worker 按 Session 创建逆序清理，共用一个 deadline；Browser 关闭后才释放先前创建的资源提供方。清理失败或超时则保留更早的 Session，Run 报错；超时操作后来完成也不能继续释放提供方。

缺 `origin`、`origin` 带路径、残缺 viewport 或启动失败，`createSession` 抛错。找不到元素、断言不中、非法枚举/配套口、非法 name、错误 actor、`goto` 不是以 `/` 开头的路径、cleanup 后再 tick → `{ status: 'FAILURE', output: { error } }`。

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
      "ports": { "url": { "literal": "/" } }
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
      "ports": { "selector": { "literal": "role=button[name=\"Go\"]" } }
    },
    {
      "type": "Condition",
      "adapter": "browser",
      "actor": "browser",
      "capability": "browser.expect",
      "ports": { "selector": { "literal": "#out" }, "assertion": { "literal": "visible" } }
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

上面是 `main` 树。根文档还要 `sessions: [{ "adapter": "browser", "actor": "browser", "ports": { "origin": { "literal": "http://127.0.0.1:5173" } } }]`。viewport / locale / `initScript` 写在同一行的 `ports` 里。
