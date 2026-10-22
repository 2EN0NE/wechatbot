# Changelog

wechatbot 仓库级变更记录（微信 ↔ pi agent 桥接产品线）。
格式参考 nano-pi-agent-creator：每个版本一个 `## vX.Y.Z` 段，`## Unreleased` 收集未发布变更。

## Unreleased

路线图见 `docs/roadmap.md`（五大主题：安全加固、稳定性与可观测性、高可用与云端互备、多进程编排、交易与事务保障）。

## v0.2.0

主题2「稳定性与可观测性」收官。

### 新增

- **发送者白名单鉴权**：入口只允许白名单 wxid 触发轮次；白名单为空时首个发消息者配对为 owner 并持久化，此后锁定。未授权消息静默丢弃、只记脱敏日志（ADR-0010）。**用户可见行为变更**。
- **journal 准入与至少一次回放**：文本轮次交给 pi 前先原子落盘 admitted，轮次终结写 settled；崩溃恢复重连时回放「已准入未结算」的记录（ADR-0011）。
- **桥指标与阈值事件**：日志新增 `journal admitted` / `journal settled` 与队列深度跨越阈值事件（`queued turns rising` / `queued turns drained`）；`/status` 追加桥侧计数行（admitted / settled / replayed / dropped / stalled）（ADR-0013）。
- **崩溃回放演练脚本**：`npm run drill` 提供「入口证据 / 恢复证据」两阶段断言，让微信平台无法 e2e 的回放路径能在真机留证。

### 决策

- ADR-0012 形态冻结：继续留在 pi coding-agent 扩展，暂不迁 pi-durable。
- ADR-0013 观测策略：日志为唯一真源，记阈值跨越事件而非定时采样，告警不占微信通道。

### 修复

- CHANGELOG 中路线图路径由 `.docs/roadmap.md` 更正为 `docs/roadmap.md`。

## v0.1.0

首个仓库级基线版本。

此前仓库无 changelog 记录，本段确立版本基线，作为后续 `## vX.Y.Z` 段的起点。
各子包保持独立版本体系（pi-agent `0.1.3`、nodejs `2.2.0` 等），仓库级版本不与子包版本耦合。
