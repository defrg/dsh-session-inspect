/**
 * dsh-session-inspect — 会话日志读取层（零第三方依赖）。
 *
 * DSH 把每个会话的完整事件流写在
 *   <DSH_HOME>/sessions/<工作区分桶>/<会话目录>/session.v4.jsonl.zstd
 * 里。这个模块负责把它读出来并做结构化归纳，用于回答"某个东西到底有没有投递到这个会话"
 * 这类问题 —— 靠读代码或猜是答不准的，只有翻日志才算证据。
 *
 * **本模块存在的头号理由：这个文件是多帧 zstd 拼接的。**
 * append-only 日志每写一段就追加一个独立 zstd 帧，而：
 *   - `zstdDecompressSync(整个文件)` 只解出**第一帧**（实测 397 KB 的文件只拿到 264 字节）；
 *   - `zlib.createZstdDecompress()` 流式解压**同样只出第一帧**（实测一致）；
 *   - 常规的"解压失败"根本不会发生 —— 它安静地少给你 99.9% 的内容。
 * 所以必须自己切帧。切帧靠 zstd magic（28 B5 2F FD），但 magic **可能出现在压缩数据内部**，
 * 于是这里用**自愈**策略：若按某个 magic 切出来的片段解不开，就说明它是伪 magic，
 * 把片段往后延到下一个 magic 重试（见 decompressFrames）。
 */
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
export const SESSION_FILE = "session.v4.jsonl.zstd";

/** DSH 数据根：显式配置 → `$DSH_HOME` → `~/.dsh`。 */
export function resolveDshHome(configured) {
  const explicit = typeof configured === "string" ? configured.trim() : "";
  if (explicit) return explicit;
  const fromEnv = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  if (fromEnv) return fromEnv;
  return join(homedir(), ".dsh");
}

export const DEFAULTS = {
  dshHome: "",
  sessionsDir: "",
  exportDir: "",
  maxTextChars: 20000,
  maxSessions: 200,
};

export function resolveConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : fallback);
  const dshHome = resolveDshHome(cfg.dshHome);
  return {
    dshHome,
    dshHomeSource: text(cfg.dshHome) ? "配置项 dshHome" : process.env.DSH_HOME ? "DSH_HOME 环境变量" : "默认 ~/.dsh",
    sessionsDir: text(cfg.sessionsDir) || join(dshHome, "sessions"),
    sessionsDirSource: text(cfg.sessionsDir) ? "配置项 sessionsDir" : "由 dshHome 推导",
    exportDir: text(cfg.exportDir) || join(dshHome, "session-exports"),
    maxTextChars: num(cfg.maxTextChars, DEFAULTS.maxTextChars),
    maxSessions: num(cfg.maxSessions, DEFAULTS.maxSessions),
  };
}

function isDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 找出 buffer 里所有 zstd 帧起始候选（magic 出现的位置）。 */
function frameCandidates(buffer) {
  const starts = [];
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1] && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) {
      starts.push(i);
    }
  }
  return starts;
}

/**
 * 逐帧解压。**自愈**，同时扛两种坏情况：
 *
 *   1. **伪 magic 在帧内部** —— 按它切出来的片段会截断真帧、解压失败。
 *      处理：把片段尾部往后延到再下一个候选重试，直到解开（此时中间跳过的候选都是伪 magic）。
 *   2. **垃圾夹在帧之间** —— 从它开始无论怎么延长都解不开（因为它根本不是帧起点）。
 *      处理：判定该候选不是帧起点，**跳过它**继续找下一个。
 *
 * 只做 (1) 是不够的：那样一旦遇到 (2) 就会停在那里、把后面的内容全丢掉。
 * 循环必然终止 —— 每轮要么 i 前进到 next（> i），要么 i += 1。
 *
 * @returns {{ text: string, frames: number, falseMagics: number,
 *             trailingBytes: number, partialTail: boolean, allBytesConsumed: boolean }}
 *
 * **`allBytesConsumed` 只说"没有剩余字节"，不等于"内容完整"** —— 这是实测得出的重要边界：
 * zstd 对**被截断的帧不报错**，而是安静地少给内容（实测把真实会话最后一帧截到 20% / 50% /
 * 80% / 95%，四种情况的输出**完全相同**：帧数照数、无坏行、只是少 3 条记录）。
 * 也就是说**尾部缺失在文本层面不可察觉**。要判定"这个会话是否还在写入"，请看
 * `readSessionFile` 的 `mutatedDuringRead`，不要去猜内容完不完整。
 */
export function decompressFrames(buffer) {
  const nothing = { text: "", frames: 0, falseMagics: 0, trailingBytes: 0, partialTail: false, allBytesConsumed: true };
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return nothing;
  const isZstd = buffer.length >= 4 && buffer[0] === ZSTD_MAGIC[0] && buffer[1] === ZSTD_MAGIC[1] && buffer[2] === ZSTD_MAGIC[2] && buffer[3] === ZSTD_MAGIC[3];
  // 非 zstd（例如已被外部解开的 .jsonl）就原样当文本返回
  if (!isZstd) return { ...nothing, text: buffer.toString("utf8") };

  const starts = frameCandidates(buffer);
  const parts = [];
  let frames = 0;
  let falseMagics = 0;
  let covered = 0;
  let i = 0;

  while (i < starts.length) {
    let decoded = null;
    let endOffset = 0;
    let next = i;
    for (let j = i + 1; j <= starts.length; j += 1) {
      const from = starts[i];
      const to = j < starts.length ? starts[j] : buffer.length;
      try {
        decoded = zstdDecompressSync(buffer.subarray(from, to));
        endOffset = to;
        next = j;
        break;
      } catch {
        /* 片段还不完整（或本就不是帧起点），继续往后延 */
      }
    }
    if (decoded === null) {
      // 情况 (2)：这个候选怎么延都解不开 ⇒ 它不是帧起点，跳过
      falseMagics += 1;
      i += 1;
      continue;
    }
    // 情况 (1)：中间被跳过的候选都是伪 magic
    falseMagics += next - i - 1;
    parts.push(decoded.toString("utf8"));
    frames += 1;
    covered = endOffset;
    i = next;
  }

  const trailingBytes = Math.max(0, buffer.length - covered);
  return {
    text: parts.join(""),
    frames,
    falseMagics,
    trailingBytes,
    // 末尾有剩余字节 = 连一帧都没解出来的尾部碎片（例如刚写入 4 字节 magic）。这是**能**察觉的残缺。
    // 但请注意：能解出内容却被截断的帧**察觉不到**（见上方说明）。
    partialTail: trailingBytes > 0,
    allBytesConsumed: trailingBytes === 0,
  };
}

/**
 * 读一个会话文件。
 *
 * **为什么要 stat 两次**：会话是 append-only 的，正在写入时读到的内容只是某一瞬间的快照，
 * 末尾可能缺失整帧，而 zstd 对此**不报错**（见 `decompressFrames` 说明）。前后各取一次
 * stat 就能如实暴露"这份内容不是稳定快照"——`mutatedDuringRead` 为真时，
 * 调用方**不该**据这次读取下"某东西没送到"的结论（可能是记录还没写进来）。
 */
export function readSessionFile(file) {
  const before = statSync(file);
  const buffer = readFileSync(file);
  const after = statSync(file);
  const result = decompressFrames(buffer);
  return {
    ...result,
    bytes: buffer.length,
    mtimeMs: after.mtimeMs,
    mutatedDuringRead: before.size !== after.size || before.mtimeMs !== after.mtimeMs,
  };
}

/**
 * 列出所有会话。
 *
 * 目录布局是两层：`<sessions>/<工作区分桶>/<会话目录>/session.v4.jsonl.zstd`。
 * 会话目录名有两种：顶层会话是 `session-<uuid>`，子智能体会话就是裸 `<uuid>`。
 * 工作区分桶名（如 `--E-project--`）是 cwd 转义来的，不如会话记录里的 `cwd` 字段可靠，
 * 所以真实工作区以记录为准、分桶名只作兜底。
 */
export function listSessions(cfg) {
  const root = cfg.sessionsDir;
  if (!isDirectory(root)) return [];
  const found = [];
  for (const bucket of readdirSync(root)) {
    const bucketPath = join(root, bucket);
    if (!isDirectory(bucketPath)) continue;
    for (const entry of readdirSync(bucketPath)) {
      const dir = join(bucketPath, entry);
      if (!isDirectory(dir)) continue;
      const file = join(dir, SESSION_FILE);
      if (!isFile(file)) continue;
      const stat = statSync(file);
      found.push({
        id: entry.replace(/^session-/, ""),
        dirName: entry,
        dir,
        file,
        bucket,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        isSubagentDir: !entry.startsWith("session-"),
      });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, cfg.maxSessions);
}

/** 按 id / 目录名 / 路径子串挑一个会话；不传则取最近的。 */
export function pickSession(cfg, selector) {
  const sessions = listSessions(cfg);
  if (sessions.length === 0) return { session: null, sessions, reason: "没有找到任何会话" };
  const needle = typeof selector === "string" ? selector.trim() : "";
  if (!needle) return { session: sessions[0], sessions };
  const hit =
    sessions.find((s) => s.id === needle) ??
    sessions.find((s) => s.dirName === needle) ??
    sessions.find((s) => s.file === needle) ??
    sessions.find((s) => s.id.startsWith(needle)) ??
    sessions.find((s) => s.dirName.includes(needle));
  if (!hit) return { session: null, sessions, reason: `没有匹配 "${needle}" 的会话` };
  return { session: hit, sessions };
}

/** JSONL → 记录数组。坏行单独计数，不因一行解析失败丢掉整个会话。 */
export function parseRecords(text) {
  const records = [];
  let malformed = 0;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

/** 取一条 user/message 记录里的正文与来源。 */
function userMessageOf(record) {
  if (record?.type !== "user/message") return null;
  const message = record.data?.message ?? record.data ?? {};
  const source = message.source ?? {};
  const body = (message.content ?? [])
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("");
  return { seq: record.seq, kind: source.kind ?? "(无来源)", form: source.form ?? null, body };
}

/**
 * 归纳一个会话：会话元信息、记录类型直方图、以及 **user-role 消息的来源分布**。
 *
 * `sources` 是回答"某个注入有没有送达"的关键：harness 自己投递的内容都带 `source.kind`
 * （例如 `agent-instructions`、`runtime-context`、`compact-checkpoint`、`subagent-settled`），
 * 而人说的话是 `user`。**某个 kind 一次都没出现，就等于那个东西没投递到该会话。**
 */
export function summarizeRecords(records) {
  const types = {};
  const sources = {};
  const roles = {};
  let meta = null;
  let turns = 0;
  let steps = 0;
  const userMessages = [];

  for (const record of records) {
    types[record.type] = (types[record.type] ?? 0) + 1;
    if (record.type === "session") meta = record;
    if (record.type === "turn/start") turns += 1;
    if (record.type === "step/start") steps += 1;
    const message = record.data?.message;
    if (message?.role) roles[message.role] = (roles[message.role] ?? 0) + 1;
    const user = userMessageOf(record);
    if (user) {
      sources[user.kind] = (sources[user.kind] ?? 0) + 1;
      userMessages.push(user);
    }
  }

  return {
    meta: meta
      ? {
          id: meta.id,
          version: meta.version,
          createdAt: meta.createdAt ?? null,
          cwd: meta.cwd ?? null,
          parentSession: meta.parentSession ?? null,
          origin: meta.origin ?? null,
          delegationDepth: meta.delegationDepth ?? null,
          agentPreset: meta.agentPreset ?? null,
        }
      : null,
    types,
    roles,
    sources,
    turns,
    steps,
    recordCount: records.length,
    userMessages,
  };
}

/** 在文本里找 needle，返回带上下文的片段。 */
export function findInText(text, needle, { before = 240, after = 240, max = 5 } = {}) {
  const hits = [];
  if (!needle) return hits;
  let index = text.indexOf(needle);
  while (index !== -1 && hits.length < max) {
    hits.push({
      offset: index,
      before: text.slice(Math.max(0, index - before), index),
      match: needle,
      after: text.slice(index + needle.length, index + needle.length + after),
    });
    index = text.indexOf(needle, index + needle.length);
  }
  return hits;
}

/** 把解压后的会话文本写到磁盘（默认落到 exportDir）。 */
export function exportSession(cfg, session, text) {
  const dir = cfg.exportDir;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${session.dirName}.jsonl`);
  writeFileSync(file, text, "utf8");
  return { file, dir: dirname(file) };
}
