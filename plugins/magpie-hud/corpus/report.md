# DSH 转录语料 EDA

生成时间：2026-11-15T08:40:07.340Z
根目录：C:\Users\Administrator\.dsh\sessions

## 规模

- 文件：197，压缩后 283.1 MB，解压后文本 1225.3 MB
- 解码总耗时：126368 ms（纯 JS fzstd，全量解码）
- zstd 帧：135801，多帧文件：197/197
- 事件：415674，坏行：0，seq 缺口：0

## 等待 episode

- 总数：77（审批 76，提问 1，仍开着 0）
- 时长分位（ms）：{"all":{"p50":81954,"p90":1551909,"p95":5654143,"p99":64033402},"approval":{"p50":91778,"p90":1551909,"p95":5654143,"p99":64033402},"question":{"p50":75164,"p90":75164,"p95":75164,"p99":75164}}

## 事件类型（Top 30）

| 事件 | 次数 |
|---|---|
| `tool/result` | 54425 |
| `tool/call` | 52413 |
| `step/start` | 51650 |
| `step/end` | 51648 |
| `assistant/message` | 51288 |
| `tool/ptc-dispatch-start` | 45892 |
| `tool/ptc-dispatch` | 45890 |
| `session-log-deepseek/delivery-accepted` | 11431 |
| `job/registered` | 7538 |
| `job/settled` | 7532 |
| `agent/inbox/spliced` | 6799 |
| `user/message` | 6594 |
| `plugin:translator/request` | 2539 |
| `plugin:translator/result` | 2536 |
| `turn/start` | 2310 |
| `turn/end` | 2307 |
| `compaction/prune` | 2014 |
| `workspace/changes` | 1239 |
| `assistant/attempt` | 1142 |
| `request/header` | 1050 |
| `llm/retry` | 850 |
| `llm/retry-started` | 842 |
| `session/title` | 647 |
| `session/title-llm-request` | 554 |
| `system/message` | 434 |
| `compaction/start` | 372 |
| `compaction/end` | 372 |
| `todo/write` | 326 |
| `request/context` | 306 |
| `sandbox/mode` | 284 |
