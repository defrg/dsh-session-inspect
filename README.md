# dsh-session-inspect

DSH（DeepSeek Harness）插件：把**会话日志**接成工具，用来回答一类特定问题 ——

> **某个东西到底有没有投递到这个会话？**

这类问题靠读代码或推测答不准，只有翻日志才算证据。本插件把"翻日志"变成一次工具调用。

它本身就是从一次真实排查里长出来的：当时为了确认**技能目录有没有送达会话**，手工解压了父子两个会话的日志，才发现下面这两个坑。

## 两个坑（本插件的核心价值）

### 坑一：会话日志是多帧 zstd 拼接，常规解压**只给你第一帧**

DSH 的 append-only 日志每写一段就追加一个**独立 zstd 帧**。于是：

```js
zstdDecompressSync(整个文件)        // 只解出第一帧（实测 397 KB 的文件只拿到 264 字节）
zlib.createZstdDecompress()         // 流式同样只出第一帧（实测一致）
```

**而且都不报错** —— 安静地少给你 99.9% 的内容。你只会觉得"这个会话怎么这么短"。

本插件自己切帧：按 zstd magic（`28 B5 2F FD`）找候选起点，并**自愈**两种情况：

- **伪 magic 在帧内部** → 切片会截断真帧、解压失败 → 把片段尾部往后延到下一个候选重试；
- **垃圾夹在帧之间** → 从它开始怎么延都解不开 → 判定它不是帧起点，**跳过**继续找。

两种都要处理：只做前者的话，一旦遇到后者就会停在那里、把后面的内容全丢掉。

### 坑二：截断**不一定**能察觉

zstd 对被截断的帧不报错。实测把真实会话的最后一帧截到 20% / 50% / 80% / 95%，表现**取决于切点**：

| 切点运气 | 表现 | 能否察觉 |
| --- | --- | --- |
| 好 | 安静解出半截内容，帧数照数、无坏行、`allBytesConsumed=true` | ❌ **完全察觉不到** |
| 差 | 整帧解不出来，帧数少一、`allBytesConsumed=false` | ✅ 表现为 `partialTail` |

**所以"没有 partialTail"不能推断内容完整。** 本插件的对策不是猜，而是**如实暴露读取环境**：
`readSessionFile` 在读前读后各取一次 stat，`mutatedDuringRead` 为真就说明"你读到的是某一瞬间的快照，
末尾可能缺记录"，工具输出里会打出警告，提醒你**不要据此下否定结论**。

要断言某个注入「没送达」，请在**已结束、不再变化**的会话上复核（子智能体会话、历史会话）。

## 工具

| 工具 | 用途 |
| --- | --- |
| `session_health` | 探活：DSH 数据根与会话目录**解析到哪、来自哪一级**、会话数量 |
| `session_list` | 会话列表（id / 类型 / cwd / 时间 / 大小），按修改时间倒序 |
| `session_inspect` | 归纳一个会话：元信息、记录类型直方图、turn/step、**user-role 来源分布** |
| `session_messages` | **注入核对**：列出全部 user-role 消息及其 `source.kind`，可按 kind 过滤 |
| `session_search` | 跨会话文本检索（带上下文片段） |
| `session_show` | 按 type / 序号取原始记录 JSON |
| `session_export` | 解压成普通 JSONL 落盘 |
| `session_config` | 读 / 写本插件配置 |

### 为什么 `session_messages` 比全文搜索可靠

harness 自己投递的内容都带 `source.kind`（`agent-instructions`、`runtime-context`、`compact-checkpoint`、
`subagent-settled`…），人说的话是 `user`。**某个 kind 一次都没出现，就等于那个东西没投递。**

全文搜索是**弱信号**，实测会骗你：搜 `available skills` 在"技能目录并未投递"的会话里**有 5 处命中** ——
那些命中来自 `skill` 工具自身的描述文本。**搜到 ≠ 送到。**

## 配置

「设置 → 插件 → dsh-session-inspect」里的配置卡片，或 `git_config` 式的 `session_config` 工具，
或直接写 `cordis.patch.yml`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dshHome` | 空（`DSH_HOME` → `~/.dsh`） | DSH 数据根 |
| `sessionsDir` | 空（`<dshHome>/sessions`） | 会话日志目录 |
| `exportDir` | 空（`<dshHome>/session-exports`） | `session_export` 落盘目录 |
| `maxTextChars` | 20000 | 返回文本截断上限 |
| `maxSessions` | 200 | `session_list` 最多列多少个 |

**插件自身的 `cordis.patch.yml` 里刻意不带任何本机路径**，同一份 patch 在任何机器上都能用。

## 会话日志的目录布局（读代码得出的，供参考）

```
<DSH_HOME>/sessions/
  <工作区分桶>/                     如 --E-project--（由 cwd 转义而来，不如记录里的 cwd 可靠）
    session-<uuid>/                 顶层会话
      session.v4.jsonl.zstd
    <uuid>/                         子智能体会话（目录名没有 session- 前缀）
      session.v4.jsonl.zstd
```

关键记录类型：`session`（元信息：cwd / origin / parentSession / agentPreset）、`user/message`
（带 `source.kind`）、`assistant/message`、`tool/call`、`tool/result`、`turn/start`、`step/start`、
`request/header`、`compact-checkpoint` 等。

## 安全边界

- **配置路由带鉴权**：`/session-inspect/api/config` 套了 `ctx.connection.requestRejection(req)`。
  `webServer` 载体自身不拥有认证与 Origin 策略 —— 少了它，任何能访问该端口的页面都能盲发 POST
  改写 `sessionsDir`，下次调用就会去读攻击者指定的目录。写入还被收窄成字段白名单。
- **只读工具才并发**，`session_export` 写盘故串行。
- **只读日志，不改日志**：本插件对会话文件只做读取。

## 自测

```powershell
node scripts/check-session-log.mjs   # 读取层：45 项断言
node scripts/check-tools.mjs         # 工具层：60 项断言
```

读取层自检**把坑本身写成了断言**（例如断言"常规 API 只出第一帧"），所以以后 Node 改了行为会立刻被测出来。
工具层自检在临时目录里造一棵合成 sessions 树（多帧 zstd，还原真实布局），把 8 个工具实跑一遍，
其中专门造了一个"**有 AGENTS.md 注入、没有技能目录**"的会话，断言它能复现当初那个排查结论。

临时目录：`DSH_SESSION_INSPECT_CHECK_DIR`，未设置则用系统临时目录。

## 已知边界

- 需要 zstd 支持，即 Node ≥ 22.15 / 24（`node:zlib` 的 `zstdDecompressSync`）。
- **读取活跃会话得到的是快照**，末尾可能缺记录且无法可靠察觉 —— 见坑二。
- 全文检索是字面匹配，不做分词或大小写折叠。
- 只处理 DSH 自己的会话格式（`session.v4.jsonl.zstd`）；格式变更会让解析退化，届时看 `malformedLines`。

## 许可

MIT
