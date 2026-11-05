# ccc trace-server

Agent 动态工作流轨迹追踪系统的后端 + 可视化面板。

```
agent (span 埋点) ──HTTP batch──▶ ingest ──▶ Kafka ──▶ consumer group
                                                        │
                          ┌─────────────────────────────┤
                          ▼                             ▼
                    JSONL WAL(可回放)            流式增量聚合
                          │                             │
                          └──────▶ REST / SSE ──▶ 瀑布面板 / IDE
```

## 运行

```bash
npm install
npm run kafka:up        # 起单节点 Kafka(可跳过,用 TRACE_KAFKA=off)
npm run dev             # http://127.0.0.1:4120
TRACE_KAFKA=off npm run dev   # 无 Kafka 的本地直连模式
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TRACE_PORT` | `4120` | HTTP 端口 |
| `TRACE_KAFKA_BROKERS` | `127.0.0.1:9092` | broker 列表,逗号分隔 |
| `TRACE_KAFKA` | on | `off` 时绕过 Kafka,ingest 直接索引(本地开发) |
| `TRACE_TOPIC` | `agent.trace.spans` | span topic |
| `TRACE_GROUP_ID` | `ccc-trace-server` | consumer group |
| `TRACE_DATA_DIR` | `./data` | WAL(`spans.jsonl`)目录 |

## 接口

- `POST /v1/spans` — `{spans:[]}`,批量 ingest,202
- `GET /api/traces?limit=&before=` — trace 摘要列表(分页)
- `GET /api/traces/:id` — 单条 trace 的全部 span(瀑布数据)
- `GET /api/stats` — 聚合快照:总量、按模型、按 kind(含 p50/p95)、分钟桶
- `GET /api/events` — SSE,`span`/`trace` 事件实时推送
- `GET /health` — 模式、计数、seq gap(检测 agent 侧丢 span)

## Agent 侧对接

`ccc` 默认开启遥测并上报到 `http://127.0.0.1:4120`,环境变量:

- `AGENT_TRACE=0` 关闭;`AGENT_TRACE_URL` 改 collector 地址
- `AGENT_TRACE_BROKERS` 设置后直连 Kafka(跳过 collector ingest)
- `AGENT_TRACE_QUEUE_SIZE` / `AGENT_TRACE_BATCH_SIZE` / `AGENT_TRACE_FLUSH_MS` 调有界队列和批量

设计要点:agent 侧有界队列 drop-oldest 背压、批量+定时 flush、at-most-once
投递 + `seq` gap 检测;server 侧 Kafka 解耦 ingest 与索引、JSONL WAL 重启回放、
在线增量聚合(O(1) 读)、LRU 内存视图。
