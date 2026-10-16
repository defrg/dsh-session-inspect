/**
 * dsh-session-inspect — Host half.
 *
 * 把 DSH 的会话日志（`<DSH_HOME>/sessions/` 下各工作区分桶里的 `session.v4.jsonl.zstd`）
 * 接成工具，用来回答 **"某个东西到底有没有投递到这个会话"** 这类问题。
 *
 * 为什么需要它：这类问题靠读代码或推测答不准 —— 只有翻日志才算证据。本插件就是为了让
 * "翻日志"变成一次工具调用，而不是写一堆临时脚本。（它本身就是从一次真实的排查里长出来的：
 * 当时为了确认技能目录有没有投递到会话，手工解压了父子两个会话的日志。）
 *
 * 头号技术坑在 `lib/session-log.js` 里：**会话日志是多帧 zstd 拼接**，
 * `zstdDecompressSync(整个文件)` 与 `createZstdDecompress()` 流式解压**都只出第一帧**，
 * 且**不报错** —— 安静地少给你 99.9% 的内容（实测 397 KB 的文件只拿到 264 字节）。
 */
import Schema from "@deepseek-ai/schemastery";
import {
  DEFAULTS,
  exportSession,
  findInText,
  listSessions,
  parseRecords,
  pickSession,
  readSessionFile,
  resolveConfig,
  summarizeRecords,
} from "./session-log.js";

export const name = "dsh-session-inspect";

/** tools 注册工具；settings 写回配置；webServer + connection 给设置卡片一条带鉴权的路由。 */
export const inject = ["tools", "settings", "webServer", "connection"];

export const Config = Schema.object({
  dshHome: Schema.string()
    .description("DSH 数据根。留空 = 依次尝试 DSH_HOME 环境变量、~/.dsh")
    .default("")
    .volatile(),
  sessionsDir: Schema.string()
    .description("会话日志目录。留空 = <dshHome>/sessions")
    .default("")
    .volatile(),
  exportDir: Schema.string()
    .description("session_export 导出解压后 JSONL 的目录。留空 = <dshHome>/session-exports")
    .default("")
    .volatile(),
  maxTextChars: Schema.number()
    .description("工具返回文本的截断上限（字符）")
    .default(20000)
    .volatile(),
  maxSessions: Schema.number()
    .description("session_list 最多列出多少个会话（按修改时间倒序）")
    .default(200)
    .volatile(),
});

/** 只读工具可并发；session_export 会写盘，串行。 */
const READ_ONLY = new Set(["session_health", "session_list", "session_inspect", "session_messages", "session_search", "session_show"]);

function unwrapVolatile(value) {
  return value && typeof value.get === "function" ? value.get() : value;
}

function truncate(text, limit) {
  if (typeof text !== "string") return text;
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符；可用 maxTextChars 调大）` : text;
}

function asText(value, limit) {
  if (typeof value === "string") return truncate(value, limit);
  try {
    return truncate(JSON.stringify(value, null, 2), limit);
  } catch {
    return truncate(String(value), limit);
  }
}

function contentText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .map((block) => (block && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

const preview = (text, n = 160) => (text.length > n ? `${text.slice(0, n).replace(/\s+/g, " ")}…` : text.replace(/\s+/g, " "));

/**
 * 正在写入的会话给出的只是某一瞬间的快照，末尾可能缺整帧，而 zstd **不会报错**（会安静少给内容）。
 * 所以只要 `mutatedDuringRead` 为真，就必须明确提醒"别据此下否定结论"。
 */
const SNAPSHOT_WARNING =
  "\n\n⚠️ 警告：读取期间该文件仍在变化 —— 这只是某一瞬间的快照，**末尾可能缺少尚未写入的记录**。" +
  "\n   zstd 对截断的帧不报错（实测把真实会话最后一帧截到 20%/50%/80%/95%，四种输出完全相同），" +
  "\n   所以这里无法保证内容完整。要断言某个注入「没送达」，请在一个已结束、不再变化的会话上复核" +
  "（例如子智能体会话或历史会话）。";

export function apply(ctx, config) {
  const snapshot = () => {
    const raw = config && typeof config === "object" ? config : {};
    const plain = {};
    for (const [key, value] of Object.entries(raw)) plain[key] = unwrapVolatile(value);
    return resolveConfig(plain);
  };

  let cfg = snapshot();
  ctx.on("loader/volatile-update", () => {
    cfg = snapshot();
  });

  const define = (spec) =>
    ctx.tools.register({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [{ type: "text", text: value && typeof value.text === "string" ? value.text : asText(value, cfg.maxTextChars) }],
      },
      isConcurrencySafe: () => READ_ONLY.has(spec.name),
      timeoutMs: spec.timeoutMs ?? 120000,
      presentCall: () => ({ card: "terminal", title: spec.title, description: cfg.sessionsDir }),
      presentResult: (_args, result) => ({ card: "terminal", title: spec.title, output: contentText(result) }),
      async execute(args) {
        const value = await spec.execute(args ?? {});
        return { ...value, text: value.text ?? asText(value, cfg.maxTextChars) };
      },
    });

  /** 读一个会话并归纳；所有工具共用。 */
  const load = (selector) => {
    const picked = pickSession(cfg, selector);
    if (!picked.session) {
      return {
        error: {
          ok: false,
          code: "NO_SESSION",
          reason: picked.reason,
          candidates: picked.sessions.map((s) => ({ id: s.id, dirName: s.dirName, mtime: new Date(s.mtimeMs).toISOString() })),
          text:
            `${picked.reason}\n会话目录：${cfg.sessionsDir}\n` +
            (picked.sessions.length ? `可选的最近会话：\n${picked.sessions.slice(0, 10).map((s) => `  ${s.id}  ${new Date(s.mtimeMs).toISOString().slice(0, 19)}  ${(s.bytes / 1024).toFixed(0)}KB`).join("\n")}` : "（该目录下没有任何会话）"),
        },
      };
    }
    const read = readSessionFile(picked.session.file);
    const parsed = parseRecords(read.text);
    const summary = summarizeRecords(parsed.records);
    return { session: picked.session, sessions: picked.sessions, read, parsed, summary };
  };

  // ================================================================ 探活

  define({
    name: "session_health",
    title: "会话日志探活",
    description:
      "检查会话日志目录是否可用：返回 DSH 数据根与 sessions 目录**最终解析到哪、来自哪一级**、目录是否存在、共有多少会话。" +
      "换机器后路径配得对不对，先调它。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const sessions = listSessions(cfg);
      const totalBytes = sessions.reduce((sum, s) => sum + s.bytes, 0);
      const missing = sessions.length === 0;
      // 注意：工具返回值必须是**可无损序列化**的 JSON —— 放一个 `code: undefined` 进去，
      // 序列化时会被丢掉，宿主会直接判 `value is not lossless JSON` 并让整次调用失败。
      // 可选字段一律"有才放"，不要留 undefined 占位。
      return {
        ok: !missing,
        ...(missing ? { code: "NO_SESSIONS" } : {}),
        dshHome: cfg.dshHome,
        dshHomeSource: cfg.dshHomeSource,
        sessionsDir: cfg.sessionsDir,
        sessionsDirSource: cfg.sessionsDirSource,
        exportDir: cfg.exportDir,
        sessionCount: sessions.length,
        totalBytes,
        text:
          (missing ? "没有找到任何会话。\n" : "会话日志可用。\n") +
          `DSH 数据根：${cfg.dshHome}（来源：${cfg.dshHomeSource}）\n` +
          `会话目录  ：${cfg.sessionsDir}（来源：${cfg.sessionsDirSource}）\n` +
          `导出目录  ：${cfg.exportDir}\n` +
          `会话数量  ：${sessions.length} 个，压缩后合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB\n` +
          (missing
            ? `\n如果数据根不对，请在「设置 → 插件 → dsh-session-inspect」里配置 dshHome 或 sessionsDir。`
            : `\n最近一个：${sessions[0].dirName}（${new Date(sessions[0].mtimeMs).toISOString().slice(0, 19)}）`),
      };
    },
  });

  // ================================================================ 列表

  define({
    name: "session_list",
    title: "会话列表",
    description:
      "列出会话日志（按修改时间倒序）：会话 id、工作区、创建时间、是否子智能体会话、压缩大小。" +
      "先用它拿到 id，再喂给其它 session_* 工具。",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "最多列出多少个，默认 20" } },
      additionalProperties: false,
    },
    async execute(args) {
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 20;
      const all = listSessions(cfg);
      const shown = all.slice(0, limit);
      const rows = [];
      for (const session of shown) {
        let cwd = null;
        let origin = null;
        try {
          const read = readSessionFile(session.file);
          const { records } = parseRecords(read.text);
          const meta = records.find((r) => r.type === "session");
          cwd = meta?.cwd ?? null;
          origin = meta?.origin ?? null;
        } catch {
          /* 读不动就留空，不影响列表 */
        }
        rows.push({
          id: session.id,
          dirName: session.dirName,
          kind: session.isSubagentDir || origin === "subagent" ? "subagent" : "top-level",
          cwd,
          mtime: new Date(session.mtimeMs).toISOString(),
          bytes: session.bytes,
        });
      }
      return {
        ok: true,
        sessionsDir: cfg.sessionsDir,
        total: all.length,
        shown: rows.length,
        sessions: rows,
        text:
          `会话目录：${cfg.sessionsDir}\n共 ${all.length} 个，列出最近 ${rows.length} 个：\n` +
          rows
            .map((r) => `  ${r.id}  [${r.kind === "subagent" ? "子代理" : "顶层"}]  ${r.mtime.slice(0, 19)}  ${(r.bytes / 1024).toFixed(0)}KB  ${r.cwd ?? ""}`)
            .join("\n"),
      };
    },
  });

  // ================================================================ 归纳（核心）

  define({
    name: "session_inspect",
    title: "会话归纳",
    description:
      "解压一个会话并归纳：会话元信息（cwd / origin / parentSession / agentPreset）、记录类型直方图、" +
      "turn/step 数，以及 **user-role 消息的来源分布**。\n" +
      "`sources` 是回答『某个注入有没有送达』的关键 —— harness 自己投递的内容都带 source.kind" +
      "（agent-instructions / runtime-context / compact-checkpoint / subagent-settled 等），人说的话是 user。" +
      "**某个 kind 一次都没出现，就等于那个东西没投递到这个会话。**",
    parameters: {
      type: "object",
      properties: { session: { type: "string", description: "会话 id / 目录名 / 文件路径子串；省略 = 最近一个" } },
      additionalProperties: false,
    },
    async execute(args) {
      const loaded = load(args.session);
      if (loaded.error) return loaded.error;
      const { session, read, parsed, summary } = loaded;
      const typeRows = Object.entries(summary.types).sort((a, b) => b[1] - a[1]);
      const sourceRows = Object.entries(summary.sources).sort((a, b) => b[1] - a[1]);
      return {
        ok: true,
        session: { id: session.id, dirName: session.dirName, file: session.file },
        decompression: {
          bytes: read.bytes,
          frames: read.frames,
          falseMagics: read.falseMagics,
          trailingBytes: read.trailingBytes,
          partialTail: read.partialTail,
          allBytesConsumed: read.allBytesConsumed,
          mutatedDuringRead: read.mutatedDuringRead,
          textChars: read.text.length,
        },
        meta: summary.meta,
        recordCount: summary.recordCount,
        malformedLines: parsed.malformed,
        types: summary.types,
        roles: summary.roles,
        sources: summary.sources,
        turns: summary.turns,
        steps: summary.steps,
        text:
          `会话：${session.dirName}\n` +
          `解压：${read.bytes} 字节 → ${read.frames} 帧 → ${read.text.length} 字符` +
          (read.falseMagics ? `（跳过 ${read.falseMagics} 个伪 magic）` : "") +
          (read.partialTail ? `（末尾 ${read.trailingBytes} 字节连一帧都没解出来）` : "") +
          "\n" +
          (summary.meta
            ? `元信息：cwd=${summary.meta.cwd ?? "-"}｜origin=${summary.meta.origin ?? "-"}｜preset=${summary.meta.agentPreset ?? "-"}` +
              (summary.meta.parentSession ? `｜父会话=${summary.meta.parentSession}` : "") +
              "\n"
            : "") +
          `规模：${summary.recordCount} 条记录（坏行 ${parsed.malformed}）｜${summary.turns} turn｜${summary.steps} step\n` +
          `\n**user-role 消息来源分布**（判断注入是否送达的关键）：\n` +
          (sourceRows.length ? sourceRows.map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join("\n") : "  （没有任何 user-role 消息）") +
          `\n\n记录类型：\n` +
          typeRows.map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`).join("\n") +
          (read.mutatedDuringRead ? SNAPSHOT_WARNING : ""),
      };
    },
  });

  // ================================================================ 注入核对（最有用的一个）

  define({
    name: "session_messages",
    title: "会话注入核对",
    description:
      "列出某个会话的**全部 user-role 消息**及其 `source.kind`，可选按 kind 过滤、可选展开正文。\n" +
      "这是回答『AGENTS.md 注入了吗』『技能目录送达了吗』『某个 system-reminder 到了吗』的**直接证据** —— " +
      "别用全文搜索代替：harness 注入的内容里可能含有某些词，而工具描述里也可能有同样的词，" +
      "**搜到不等于送到**。按 source.kind 归类才是强证据。",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "会话 id / 目录名 / 文件路径子串；省略 = 最近一个" },
        kind: { type: "string", description: "只看某个 source.kind（子串匹配），如 agent-instructions" },
        full: { type: "boolean", description: "展开每条消息的完整正文（默认只给前 300 字符）" },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const loaded = load(args.session);
      if (loaded.error) return loaded.error;
      const { session, summary, read } = loaded;
      const filter = typeof args.kind === "string" && args.kind.trim() !== "" ? args.kind.trim() : null;
      const messages = summary.userMessages
        .map((message, index) => ({ index: index + 1, ...message }))
        .filter((message) => !filter || message.kind.includes(filter));

      const limit = cfg.maxTextChars;
      const body = messages
        .map((message) => {
          const shown = args.full === true ? message.body : preview(message.body, 300);
          return `--- #${message.index}  seq=${message.seq}  source.kind=${message.kind}${message.form ? `  form=${message.form}` : ""}  ${message.body.length} 字符\n${shown}`;
        })
        .join("\n\n");

      const kinds = Object.entries(summary.sources).sort((a, b) => b[1] - a[1]);
      return {
        ok: true,
        session: { id: session.id, dirName: session.dirName },
        total: summary.userMessages.length,
        shown: messages.length,
        filter,
        sources: summary.sources,
        messages: messages.map((message) => ({ index: message.index, seq: message.seq, kind: message.kind, form: message.form, chars: message.body.length })),
        text:
          `会话：${session.dirName}｜user-role 消息共 ${summary.userMessages.length} 条` +
          (filter ? `，匹配 kind≈"${filter}" 的 ${messages.length} 条` : "") +
          "\n全部来源分布：" +
          (kinds.length ? kinds.map(([k, v]) => `${k}×${v}`).join("、") : "（无）") +
          "\n\n" +
          truncate(body, limit) +
          (read.mutatedDuringRead ? SNAPSHOT_WARNING : ""),
      };
    },
  });

  // ================================================================ 跨会话检索

  define({
    name: "session_search",
    title: "会话检索",
    description:
      "在会话日志里搜文本（默认搜最近若干个会话），返回带上下文的命中片段。\n" +
      "**注意这是弱信号**：只能证明『这个词出现过』，不能证明『那个东西被投递了』 —— " +
      "工具描述、你自己的回复里都可能含有同样的词。要判定投递，请用 `session_messages` 看 source.kind。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜的字符串（区分大小写的字面匹配）" },
        session: { type: "string", description: "只看某个会话；省略 = 搜最近若干个" },
        maxSessions: { type: "number", description: "最多搜多少个会话，默认 5" },
        maxHitsPerSession: { type: "number", description: "每个会话最多返回几处命中，默认 3" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args) {
      const query = String(args.query ?? "");
      if (query === "") return { ok: false, code: "BAD_ARGS", text: "query 不能为空" };
      const maxSessions = Number.isFinite(Number(args.maxSessions)) && Number(args.maxSessions) > 0 ? Math.floor(Number(args.maxSessions)) : 5;
      const maxHits = Number.isFinite(Number(args.maxHitsPerSession)) && Number(args.maxHitsPerSession) > 0 ? Math.floor(Number(args.maxHitsPerSession)) : 3;

      const targets = args.session ? [pickSession(cfg, args.session).session].filter(Boolean) : listSessions(cfg).slice(0, maxSessions);
      if (targets.length === 0) return { ok: false, code: "NO_SESSION", text: `没有可搜的会话（会话目录：${cfg.sessionsDir}）` };

      const results = [];
      for (const session of targets) {
        let read;
        try {
          read = readSessionFile(session.file);
        } catch (error) {
          results.push({ id: session.id, dirName: session.dirName, error: error?.message ?? String(error), hits: [] });
          continue;
        }
        const hits = findInText(read.text, query, { max: maxHits });
        results.push({ id: session.id, dirName: session.dirName, frames: read.frames, chars: read.text.length, hitCount: hits.length, hits });
      }

      const withHits = results.filter((r) => (r.hitCount ?? 0) > 0);
      return {
        ok: true,
        query,
        searched: results.length,
        sessionsWithHits: withHits.length,
        results,
        text:
          `搜索："${query}"｜扫了 ${results.length} 个会话，${withHits.length} 个有命中\n` +
          `（提醒：命中 ≠ 投递。判定投递请看 session_messages 的 source.kind）\n\n` +
          results
            .map((r) => {
              if (r.error) return `### ${r.dirName}\n  读取失败：${r.error}`;
              if (r.hitCount === 0) return `### ${r.dirName}\n  （无命中，${r.frames} 帧 / ${r.chars} 字符）`;
              return (
                `### ${r.dirName}（${r.hitCount} 处）\n` +
                r.hits.map((h) => `  …${preview(h.before, 160)}【${h.match}】${preview(h.after, 160)}…`).join("\n")
              );
            })
            .join("\n\n"),
      };
    },
  });

  // ================================================================ 原始记录

  define({
    name: "session_show",
    title: "会话原始记录",
    description:
      "按类型或序号取出会话里的原始记录（JSON）。用于查看某类事件的完整结构，" +
      "例如 `type=tool/call` 看这一轮调了哪些工具、`type=request/header` 看实际发出去的请求头。",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "会话 id / 目录名 / 文件路径子串；省略 = 最近一个" },
        type: { type: "string", description: "只看这个 type 的记录（精确匹配），如 tool/call、user/message、request/header" },
        index: { type: "number", description: "只看第 index 条记录（0 起，按文件顺序）" },
        limit: { type: "number", description: "最多返回多少条，默认 5" },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const loaded = load(args.session);
      if (loaded.error) return loaded.error;
      const { session, parsed } = loaded;
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 5;

      let selected;
      if (Number.isFinite(Number(args.index))) {
        const record = parsed.records[Math.floor(Number(args.index))];
        selected = record ? [record] : [];
      } else if (args.type) {
        selected = parsed.records.filter((r) => r.type === args.type).slice(0, limit);
      } else {
        selected = parsed.records.slice(0, limit);
      }

      const rendered = selected.map((r) => JSON.stringify(r));
      return {
        ok: true,
        session: { id: session.id, dirName: session.dirName },
        total: parsed.records.length,
        shown: selected.length,
        records: selected,
        text:
          `会话：${session.dirName}｜共 ${parsed.records.length} 条记录，取出 ${selected.length} 条` +
          (args.type ? `（type=${args.type}）` : "") +
          "\n\n" +
          truncate(rendered.join("\n"), cfg.maxTextChars),
      };
    },
  });

  // ================================================================ 导出

  define({
    name: "session_export",
    title: "导出会话",
    description: "把会话解压成普通 JSONL 写到磁盘（默认 <dshHome>/session-exports），便于用别的工具处理。**会写盘，串行执行。**",
    parameters: {
      type: "object",
      properties: { session: { type: "string", description: "会话 id / 目录名 / 文件路径子串；省略 = 最近一个" } },
      additionalProperties: false,
    },
    async execute(args) {
      const loaded = load(args.session);
      if (loaded.error) return loaded.error;
      const { session, read } = loaded;
      try {
        const written = exportSession(cfg, session, read.text);
        return {
          ok: true,
          session: { id: session.id, dirName: session.dirName },
          writtenTo: written.file,
          chars: read.text.length,
          text: `已导出：${written.file}\n来源：${session.file}\n${read.frames} 帧 / ${read.text.length} 字符`,
        };
      } catch (error) {
        return { ok: false, code: "WRITE_FAILED", reason: error?.message ?? String(error), text: `导出失败：${error?.message ?? String(error)}` };
      }
    },
  });

  // ================================================================ 配置读写（设置卡片与 session_config 共用）

  const EDITABLE_KEYS = ["dshHome", "sessionsDir", "exportDir"];

  const currentConfig = () => {
    const raw = config && typeof config === "object" ? config : {};
    const values = {};
    for (const [key, value] of Object.entries(raw)) values[key] = unwrapVolatile(value);
    const resolved = snapshot();
    return {
      values,
      effective: {
        dshHome: resolved.dshHome,
        dshHomeSource: resolved.dshHomeSource,
        sessionsDir: resolved.sessionsDir,
        sessionsDirSource: resolved.sessionsDirSource,
        exportDir: resolved.exportDir,
        maxTextChars: resolved.maxTextChars,
        maxSessions: resolved.maxSessions,
      },
    };
  };

  const writeConfig = async (patch) => {
    const tried = [];
    for (const entryId of [`include:${name}`, name]) {
      try {
        await ctx.settings.update(entryId, patch);
        return entryId;
      } catch (error) {
        tried.push(`${entryId}: ${error?.message ?? String(error)}`);
      }
    }
    throw new Error(`写入配置失败（试过 ${tried.join("；")}）`);
  };

  const sanitizePatch = (input) => {
    const patch = {};
    if (!input || typeof input !== "object") return patch;
    for (const key of EDITABLE_KEYS) {
      if (key in input && typeof input[key] === "string") patch[key] = input[key];
    }
    return patch;
  };

  const sendJson = (res, status, payload) => {
    let body;
    try {
      body = JSON.stringify(payload);
    } catch {
      body = JSON.stringify({ ok: false, error: "响应不可序列化" });
    }
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(body);
  };

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      if (req.readableEnded === true || req.complete === true) {
        resolve({});
        return;
      }
      let raw = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("读取请求体超时"));
      }, 5000);
      req.on("data", (chunk) => {
        raw += chunk.toString("utf8");
        if (raw.length > 64 * 1024 && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("请求体过大（>64KB）"));
        }
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (raw.trim() === "") {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`请求体不是合法 JSON：${error?.message ?? error}`));
        }
      });
      req.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });

  // webServer 载体自身不拥有认证与 Origin 策略：少了这道检查，任何能访问本端口的页面
  // 都能盲发 POST 改写 sessionsDir —— 下一次调用就会去读攻击者指定的目录。
  ctx.webServer.register({
    kind: "prefix",
    path: "/session-inspect/api",
    handler: async (req, res) => {
      try {
        const rejection = ctx.connection.requestRejection(req);
        if (rejection !== undefined) {
          res.statusCode = rejection;
          res.end();
          return;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.replace(/\/+$/, "");
        if (path !== "/session-inspect/api/config") return sendJson(res, 404, { ok: false, error: "未知路由" });
        if (req.method === "GET") return sendJson(res, 200, { ok: true, result: currentConfig() });
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "只支持 GET / POST" });
        const patch = sanitizePatch(await readJson(req));
        if (Object.keys(patch).length === 0) return sendJson(res, 400, { ok: false, error: `没有可写字段（${EDITABLE_KEYS.join(" / ")}）` });
        const writtenTo = await writeConfig(patch);
        cfg = snapshot();
        return sendJson(res, 200, { ok: true, result: { ...currentConfig(), writtenTo } });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
      }
    },
  });

  // ================================================================ 配置工具

  define({
    name: "session_config",
    title: "会话插件配置",
    description:
      "读取或修改本插件的配置。action=get 返回界面值与**生效值**（含数据根最终解析到哪、来自哪一级）；" +
      "action=set 走官方 settings.update() 写进本 profile 覆盖层，volatile 值即时更新、**无需重启**。" +
      `可写字段：${EDITABLE_KEYS.join(" / ")}。字段传空串 = 恢复自动探测/默认。`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"], description: "get 读取，set 写入" },
        dshHome: { type: "string", description: "DSH 数据根；空串 = DSH_HOME 环境变量或 ~/.dsh" },
        sessionsDir: { type: "string", description: "会话日志目录；空串 = <dshHome>/sessions" },
        exportDir: { type: "string", description: "导出目录；空串 = <dshHome>/session-exports" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args) {
      const describe = () => {
        const current = currentConfig();
        const e = current.effective;
        return (
          `界面值：dshHome=${current.values.dshHome ?? ""} · sessionsDir=${current.values.sessionsDir ?? ""} · exportDir=${current.values.exportDir ?? ""}\n` +
          `生效值：\n` +
          `  数据根  ：${e.dshHome}（来源：${e.dshHomeSource}）\n` +
          `  会话目录：${e.sessionsDir}（来源：${e.sessionsDirSource}）\n` +
          `  导出目录：${e.exportDir}（来源：配置项 exportDir 或由 dshHome 推导）\n` +
          `  会话数  ：${listSessions({ ...cfg, ...e }).length} · 截断=${e.maxTextChars} · 上限=${e.maxSessions}`
        );
      };
      if (args.action === "get") return { ok: true, ...currentConfig(), text: describe() };
      if (args.action !== "set") return { ok: false, code: "BAD_ARGS", text: `未知 action：${args.action}（只支持 get / set）` };
      const patch = sanitizePatch(args);
      if (Object.keys(patch).length === 0) {
        return { ok: false, code: "BAD_ARGS", text: `set 至少要给一个字段（${EDITABLE_KEYS.join(" / ")}）。空串也算给了值——它表示恢复默认。` };
      }
      try {
        const writtenTo = await writeConfig(patch);
        cfg = snapshot();
        return { ok: true, writtenTo, patch, ...currentConfig(), text: `已写入 ${writtenTo}：${JSON.stringify(patch)}\n（volatile 值即时生效，无需重启）\n\n${describe()}` };
      } catch (error) {
        return { ok: false, code: "WRITE_FAILED", reason: error?.message ?? String(error), text: `写入配置失败：${error?.message ?? String(error)}` };
      }
    },
  });
}

export { DEFAULTS };
