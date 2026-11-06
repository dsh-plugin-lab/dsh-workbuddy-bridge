# src/llm/ — 文件索引

职责：见 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)

- adapter.ts
- loopback.ts
- shim.ts

## 排障：抓「上游真正收到的」请求

`11-128` 这类按**内容**判定的拦截，只能靠被拒的那次请求定位（issue #25 / #28 / #29 / #30 都卡在没有它）。
[capture.ts](capture.ts) 提供这个诊断，**默认关**（body 含整段对话）。

| 开法 | 怎么开 | 何时用 |
|---|---|---|
| 标记文件 | 建 `$DSH_HOME/.workbuddy-capture.on` | 本机排障。每个请求现读，**建完即刻生效、删文件即关，不用重启** |
| 环境变量 | `WORKBUDDY_CAPTURE_BODY=<日志路径>` | 宿主启动前就要抓；脚本 / CI |

落点：`$DSH_HOME/.workbuddy-captures.jsonl`，**一个请求一行**：

- `headers` —— 实际发出的请求头（`Authorization` / `Cookie` / 任何含 `token` 的一律 `[redacted]`，日志要能直接贴进 issue）
- `body` —— `prepareChatBody()` **之后**的字节，即上游真正收到的那份
- `status` / `message` —— 这次请求的结论

三条判据在 [tests/capture.spec.ts](../../tests/capture.spec.ts)：默认不落盘、一个请求恰好一条记录、凭据永不落盘。

为什么头部与 body 同等重要：2026-11-06 把抓到的 body 原样重放是 **200**，而宿主自己发的同一份 body 是 **400** ——
差异只能在头部（身份解析），所以记录必须成对。这也说明**只抓 body 会得出错误结论**。

变更影响路由：改本目录 → 同步根 [AGENTS.md](../../AGENTS.md) 的待办与活跃坑；设计变化写 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
