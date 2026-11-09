# 本地 Git 周报 → PushPlus 本人微信

使用已有 `weekly-report` Skill。中台每天北京时间 09:00 调用固定脚本判断中国实际工作日；每个自然周的首个工作日收集上周一至周日的 Git 提交，Codex 生成纯文本文件，再由固定发布脚本生成通知。电脑在首个工作日未开机时，可在同周之后的工作日补跑。整周均为假期则该周不触发，不自动把多周合并。

## 三阶段

1. `node workflow.ts collect settings.json`：先同步项目来源并应用忽略名单，再合并 `calendars/*.json`，休息日不调用模型。根据完整本地仓库清单，读取指定作者的全部分支、排除合并提交。首次全部仓库读取成功后原子写入 `inputs/<上周周一>.json`，提交稳定编号 `ready-<日期>` 的 `weekly.ready` 事件。同周再次执行复用该快照，不覆盖已发布周报的依据。非 Git 项目明确记为未统计；没有提交不等于没有工作。
2. Codex：权限：`edit`。规则使用 `skill: "weekly-report"`，prompt 明确现有 Skill 的绝对路径、输入日期、全部项目清单及用户已授权的自动运行模式，不询问非 Git 工作、不操作剪贴板。只写 `reports/<日期>.txt`，核实文件后通过回执提交 `written-<日期>` 的 `weekly.written` 事件。
3. `node workflow.ts publish settings.json`：只接受日期形状的 subject，从固定 reports 目录读正文，校验必需段落，以 `notice`、`fyi: true` 交给 PushPlus 通道，超过 4000 字符按 Unicode 码点完整分段。实际发送在通道里，Codex 不接触 PushPlus token，也不需要给它 full 权限。

同一来源的稳定事件编号由中台持久化去重；同一轮的重复回执不会重复创建卡片。不要另写一个直接发 PushPlus 的 Agent，否则恢复时无法复用中台的投递记录。`tell: "always"` 只发第一行摘要，不能用它代替全文发布。

## Settings 和通道

settings.json 结构：

```json
{
  "work": "/绝对路径/weekly-work",
  "author": "robin.li",
  "projectSource": { "type": "codex-desktop", "codexHome": "/用户目录/.codex" },
  "ignoredProjects": ["Tibometer", "蓝牙", "消消乐", "周报"],
  "projects": [
    { "name": "app", "path": "/绝对路径/app", "isGitRepository": true }
  ]
}
```

配置 `projectSource` 后，每次采集会只读查询 Codex 本机项目注册表，自动纳入新增项目并移除已删除项目。`codexHome` 可省略，默认 `~/.codex`。`projects` 保存最近一次成功同步的目录清单，无需手工维护；不配置 `projectSource` 则兼容原有手工项目清单。

`ignoredProjects` 可省略，按完整项目名或注册表项目 ID 精确匹配，区分大小写；手工清单按项目名匹配。忽略项目的主目录也不会通过其他项目的关联目录重新纳入。一个项目关联多个目录时全部检查，按实际 Git 仓库顶层目录去重，优先采用该目录独立登记的项目名。非 Git 和缺失目录明确标记未统计。修改配置无需重启；已有当周快照保持不变，下一份新快照采用最新范围。

仅刷新并检查清单，不生成或推送周报：

```bash
node --disable-warning=ExperimentalWarning workflow.ts sync-projects settings.json
```

读取适配使用 Node 内置 SQLite，仅查询 `codexHome` 中编号最高的 `state_*.sqlite` 的 `projects`、`project_roots` 表，不读取聊天内容或凭据。此本机表结构不属于稳定公开接口；来源缺失或结构改变时明确失败并保留上次清单，不以旧清单继续生成。更新适配后可重新同步。

在规则里登记 `pushplus` 通道，只把个人周报的通知路由到该通道。运行配置的 `channels.pushplus` 设置 `use: "pushplus"`、已有中台通道 key 和 `keychainService: "codex.pushplus.user-token"`。macOS 通道直接异步读取登录钥匙串，不依赖 launchd 继承 `~/.zshrc`；其他环境可用 `tokenEnv` 指定环境变量名。配置不存 PushPlus token。插件可以整体复制到安装目录的 `plugins/pushplus/channel.ts`，不引用引擎源码。

真实接口固定为 `https://www.pushplus.plus/send`，不设置群组 topic 或转发接收人 to。仅测试时可显式开启 `allowTestEndpoint` 使用回环 HTTP 服务。业务成功必须是整数 `code: 200` 且包含消息流水号 `data`。该流水号只证明平台受理，不证明微信已收到或已读。通用 Webhook 对未知平台只检查 HTTP 状态，不能代替这个插件。

单条标题最多 100 字、正文最多 2 万字；PushPlus 的账号频率与额度另受服务限制。正式环境按用户账号实际权限验收，业务码拒绝时保留错误码；日志不输出凭据或提供方原始错误正文。

## 日历来源与维护

2026、2027 数据快照来自 [holiday-cn](https://github.com/NateScarlet/holiday-cn)，各 JSON 的 `papers` 保留国务院原始公告链接。未列日期按周一至周五，`isOffDay: false` 的周末是补班；相邻年份一起加载。缺少已核实的年度日历时明确失败，不猜测工作日。每年新公告发布后更新相应 JSON 并运行日期测试；当前数据不覆盖 2028 年。

## 验证与运维

本地测试为 `tests/pushplus.test.ts`、`tests/weekly-report.test.ts` 和 `tests/weekly-projects.test.ts`，只使用临时项目注册表、假 token 和本地 HTTP。显式真实测试入口：

```bash
node scripts/pushplus-smoke.ts --send /绝对路径/receipt.json
```

结果文件已有成功记录则不重复发测试消息。真实发送只在本人授权时使用；普通测试不会读取真实钥匙串。

配置检查沿用 `agent-autoloop check`、`rules explain`，手动补跑用 `run <采集规则名>`，查看每轮依据用 `why <编号>`。本地运行需保持用户登录、电脑可运行且模型网络正常；登录钥匙串锁定需要本人解锁。暂时断网会由中台重试，模型失败与通知失败分开记录。PushPlus 已受理但中台确认丢失的窗口仍可能重复发送，不承诺严格恰好一次。

官方契约：[基本 API](https://www.pushplus.plus/doc/guide/api.html)、[使用限制](https://www.pushplus.plus/doc/help/limit.html)、[开放接口](https://www.pushplus.plus/doc/guide/openApi.html)。最终送达状态查询需要额外开发者权限，本方案不扩大账号权限，由本人核对微信。
