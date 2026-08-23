# Agent Note: pi-ai provider response metadata

Status: implemented

[English](2026-08-23-pi-ai-provider-response-metadata.md) | 中文

## Problem

提供方会在响应体旁边讲述一些从未到达 harness 的事实。今天真正重要的那一件是订阅计费：Codex 路由会在每次请求的响应中回答 `x-codex-primary-used-percent`、`x-codex-primary-window-minutes` 和 `x-codex-primary-reset-at` —— 也就是该套餐限流窗口的状态，每次请求都会刷新。想展示一个订阅在本周已经花掉多少的界面，没有地方可以读到它。

harness 中没有任何位置读取提供方响应 header。`stream.ts` 映射的是一个封闭的 pi-ai `AssistantMessageEvent` 联合类型，而到那时 pi-ai 已经把 HTTP 响应折叠掉了：状态码消失了，header 从一开始就没有被携带。两者唯一存在的地方是在 pi-ai 的 API 实现内部。

另一个显而易见的数据来源，是同一个后端提供的账户端点 `GET /backend-api/codex/usage`，它以 JSON 返回同样的数字。它在 harness 中无法使用：Cloudflare 会以 `cf-mitigated: challenge` 和 403 回应 Node HTTP 客户端，同时放行 `/codex/responses`。harness 能够正当获取的数据，就是搭载在它本就会发出的那些请求上的数据。

## Decision

`llm-pi-ai` 传入 pi-ai 的 `onResponse` 流选项，并把它报告的内容重新发布为一个 cordis 事件：

```
'llm-pi-ai/provider-response'(detail: {
  provider: string
  model: string
  status: number
  headers: Readonly<Record<string, string>>
}): void
```

header 原样传递、不作解读。本插件是覆盖每一条 pi-ai 路由的通用桥接层，而 header 词汇是按提供方划分的 —— 配额窗口、弃用通知、请求 id —— 因此在这里命名任何一个提供方的字段，都会把那个提供方的格式塞进通用层。由理解某条路由的监听方自行解读该路由的 header。

适配器通过 `PiAiAdapterOptions.onProviderResponse` 回调抵达该事件，与 `onReplayDegrade` 保持一致：适配器陈述观察结果，由 `index.ts` 决定它是一个事件。只有在回调存在时才把该选项传给 `streamSimple`，因此没有监听方的组合不会给请求路径增加任何东西。

emit 在接线处包裹在 try/catch 中。pi-ai 会在请求内部、读取响应体之前 `await` 这个回调，因此未被隔离的监听方异常会让它只是在旁观的那次生成失败。

## 它不承诺什么

有两处缺席属于契约，而非疏漏：

- **仅限 SSE。** pi-ai 的 WebSocket 传输没有可观察的 HTTP 响应，因此永远不会调用 `onResponse`。需要该能力的部署应固定 `transport: sse`。
- **并非每次响应。** 哪些响应会抵达 `onResponse` 由各个 pi-ai API 自行决定。Codex 路径在 `fetch` 之后、检查状态之前立即调用，因此失败会上报。OpenAI-completions 路径只在 SDK 调用完成后才调用，因此 401 永远不会到达。监听方应把事件缺席读作没有信息，绝不能读作成功。

这正是该事件服务于读数展示而非错误处理的原因：它看不到每一次失败，而观察方也无法改变一次请求的结果。

## Alternatives considered

**在这里解析 header 并发出一个带类型的限流事件。** 已否决：这会把 `x-codex-*` —— 某一家厂商的格式 —— 放进服务于每一条 pi-ai 路由的插件，而下一个带有自有计费 header 的提供方，要么被硬塞进同一个类型，要么被忽略。通用层报告传输层看到了什么；由消费方拥有词汇。

**从消费方轮询提供方自己的用量端点。** 依据证据否决：`GET /backend-api/codex/usage` 会以 Cloudflare 质询（403）回应 Node 客户端，而 HTTP/1.1 上的 curl 得到 200。要够到它就意味着挑选一个客户端去绕过运营方刻意施加的机器人管理控制。header 路径是第一方的，不需要第二次请求，不需要第二次凭据读取，并且在每一轮对话上更新，而不是按轮询间隔更新。

**用一种元数据 chunk 扩展 `StreamChunk`。** 已否决：`StreamChunk` 是模型可见的流，而这是传输元数据，绝不能进入请求或 session 日志。该 chunk 联合类型的每一个消费方都会为一件它们都不建模的东西新增一个分支。

**把事件放进 `dsh-llm`，让任何适配器族都能发出。** 已推迟：今天只有 pi-ai 这一个适配器族拥有该钩子，而 harness 的规则是抽象需要有当前的归属者。第二个适配器族出现时，把它上移是机械性的工作。

## Consequences

消费方现在无需拥有请求路径，就能读到按请求粒度的提供方元数据 —— 这正是让一个插件得以展示 Codex 配额读数的前提，而不必为了够到 Codex 提供方的 HTTP 响应而去 fork 它。

代价是一次按请求触发的通知，其送达取决于传输方式以及上游 pi-ai 的内部实现，这一点已如实记录。由于负载是无类型的 header，误读某个 header 的消费方得不到编译期帮助；另一种选择则是把某一个提供方的词汇交给一个通用包。

包 README 中的 `无法获取提供方 HTTP 状态` 是被收窄而非消失：状态可以带外观察到，但并非每次失败都有，也不在流中。

## Testing

`tests/adapter.spec.ts` 针对 mock server 覆盖了上报的状态与 header，以及监听方抛出异常时生成仍以 `stop` 结束。`tests/mock-server.ts` 现在也会把脚本化的 `headers` 应用到流式 200 分支，此前它会丢弃这些 header。
