/**
 * dsh-session-inspect — 会话日志读取层自检（不依赖 DSH，不需要真实会话）。
 *
 *   node scripts/check-session-log.mjs
 *
 * 重点验证三件事：
 *   1. **多帧 zstd 是真的坑，且我们绕过了它** —— 断言常规 API 只出第一帧（把坑写成断言，
 *      以后 Node 改了行为会立刻被测出来），同时断言 decompressFrames 拿得到全部内容；
 *   2. **自愈切帧**：在真帧之间塞一个伪 magic，解压仍须完整；
 *   3. 归纳逻辑：JSONL 坏行、user-role 的 source.kind 归类、检索、会话挑选。
 *
 * 临时目录：`DSH_SESSION_INSPECT_CHECK_DIR`，未设置则用系统临时目录。
 * 退出码：0 = 全过，1 = 有断言失败。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import {
  SESSION_FILE,
  decompressFrames,
  findInText,
  listSessions,
  parseRecords,
  pickSession,
  readSessionFile,
  resolveConfig,
  resolveDshHome,
  summarizeRecords,
} from '../lib/session-log.js';

let failed = 0;
let passed = 0;

function assert(condition, label, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

const work = process.env.DSH_SESSION_INSPECT_CHECK_DIR || join(process.env.TEMP || '/tmp', 'dsh-session-inspect-check');
const sandbox = join(work, 'log-probe');
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(sandbox, { recursive: true });

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 造一个多帧 zstd 文件：每段各自压成一帧再首尾相接（这正是 DSH 的写法）。 */
function multiFrame(parts) {
  return Buffer.concat(parts.map((text) => zstdCompressSync(Buffer.from(text, 'utf8'))));
}

console.log('dsh-session-inspect 读取层自检\n');
console.log(`临时目录：${sandbox}\n`);

// ---------------------------------------------------------------- 1. 多帧这个坑

console.log('[1] 多帧 zstd：把坑写成断言');

const seg1 = '{"type":"session","id":"abc","cwd":"E:\\\\project"}\n';
const seg2 = '{"type":"user/message","seq":1,"data":{"message":{"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"你好"}]}}}\n';
const seg3 = '{"type":"user/message","seq":2,"data":{"message":{"role":"user","source":{"kind":"agent-instructions","form":"instructions"},"content":[{"type":"text","text":"注入内容"}]}}}\n';
const threeFrame = multiFrame([seg1, seg2, seg3]);

assert(threeFrame.subarray(0, 4).equals(MAGIC), '生成的文件以 zstd magic 开头');

const naive = zstdDecompressSync(threeFrame).toString('utf8');
assert(naive === seg1, '常规 zstdDecompressSync(整文件) 只解出第一帧（这就是那个坑）', `实际拿到 ${naive.length} 字符`);
assert(!naive.includes('agent-instructions'), '常规解压**静默丢失**了后面的帧，且不报错');

const healed = decompressFrames(threeFrame);
assert(healed.text === seg1 + seg2 + seg3, 'decompressFrames 拿得到全部三帧', `${healed.text.length} 字符`);
assert(healed.frames === 3, '报告帧数 = 3', String(healed.frames));
assert(healed.falseMagics === 0 && healed.allBytesConsumed === true && healed.trailingBytes === 0, '无伪 magic、字节全被消费、无尾余');

// ---------------------------------------------------------------- 2. 自愈切帧

console.log('\n[2] 自愈切帧：伪 magic 不该毁掉解压');
// 在帧 1 与帧 2 之间插入一段「长得像帧头」的垃圾。
// 朴素做法会把它当帧起点，于是帧 1 被截断、解压失败；自愈做法会往后延到真帧。
const bogus = Buffer.concat([MAGIC, Buffer.from('this-is-not-a-real-frame')]);
const frame1 = zstdCompressSync(Buffer.from(seg1, 'utf8'));
const frame2 = zstdCompressSync(Buffer.from(seg2, 'utf8'));
const withBogus = Buffer.concat([frame1, bogus, frame2]);

const naiveBogus = (() => {
  try {
    return zstdDecompressSync(withBogus).toString('utf8');
  } catch {
    return '(抛错)';
  }
})();
assert(naiveBogus === seg1, '常规解压在含伪 magic 的文件上仍只出第一帧', String(naiveBogus).slice(0, 40));

const healedBogus = decompressFrames(withBogus);
assert(healedBogus.text === seg1 + seg2, '自愈解压完整拿到两帧内容', `${healedBogus.text.length} 字符`);
assert(healedBogus.frames === 2, '帧数仍计为 2（伪 magic 不算帧）', String(healedBogus.frames));
assert(healedBogus.falseMagics >= 1, `识别出伪 magic（${healedBogus.falseMagics} 个）`);

// ---------------------------------------------------------------- 3. 边界输入

console.log('\n[3] 边界输入');
const plain = Buffer.from('{"type":"session"}\n{"type":"turn/start"}\n', 'utf8');
const asPlain = decompressFrames(plain);
assert(asPlain.text === plain.toString('utf8') && asPlain.frames === 0, '非 zstd 输入按纯文本原样返回');
const empty = decompressFrames(Buffer.alloc(0));
assert(empty.text === '' && empty.frames === 0, '空输入不炸');
// **本插件最重要的边界，写成断言防止以后误判**：
// 截断的帧**不会**让 zstd 报错，它的表现**取决于切在帧内哪个位置**：
//   - 有时安静地解出半截内容（frames 照数、allBytesConsumed=true）→ **完全察觉不到**；
//   - 有时整帧解不出来（frames 少一、allBytesConsumed=false）→ 表现为 partialTail。
// 所以「没有 partialTail」**不能**推断内容完整。可靠信号只有 readSessionFile 的 mutatedDuringRead。
const wholeFrame = zstdCompressSync(Buffer.from(seg1, 'utf8'));
const truncated = wholeFrame.subarray(0, Math.max(6, Math.floor(wholeFrame.length / 2)));
assert(truncated.length < wholeFrame.length, '截断样本确实比原帧短');
const partial = decompressFrames(truncated);
assert(partial.text !== seg1, '截断帧还原不出完整原文（这条必然成立）');
assert(partial.frames <= 1, '截断帧至多被当成一帧', String(partial.frames));
console.log(`     本次截断的实际表现：frames=${partial.frames} textLen=${partial.text.length} allBytesConsumed=${partial.allBytesConsumed}`);
console.log(`     ${partial.allBytesConsumed ? '→ 安静解出（察觉不到截断）' : '→ 整帧解不出（表现为 partialTail）'}；换个切点结果可能相反`);

// ---------------------------------------------------------------- 4. 配置解析

console.log('\n[4] 配置解析（跨机器）');
const savedHome = process.env.DSH_HOME;
delete process.env.DSH_HOME;
const homeDefault = resolveConfig({});
assert(homeDefault.dshHomeSource === '默认 ~/.dsh', '没配也没环境变量时退到 ~/.dsh', homeDefault.dshHomeSource);
process.env.DSH_HOME = sandbox;
const fromEnv = resolveConfig({});
assert(fromEnv.dshHome === sandbox && fromEnv.dshHomeSource === 'DSH_HOME 环境变量', 'DSH_HOME 环境变量生效', fromEnv.dshHomeSource);
const explicit = resolveConfig({ dshHome: join(sandbox, 'custom') });
assert(explicit.dshHomeSource === '配置项 dshHome', '显式配置优先于环境变量', explicit.dshHomeSource);
assert(explicit.sessionsDir === join(sandbox, 'custom', 'sessions'), 'sessionsDir 由 dshHome 推导', explicit.sessionsDir);
const explicitSessions = resolveConfig({ sessionsDir: join(sandbox, 'elsewhere') });
assert(explicitSessions.sessionsDirSource === '配置项 sessionsDir', '显式 sessionsDir 优先', explicitSessions.sessionsDirSource);
if (savedHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = savedHome;
assert(resolveDshHome('  ') !== '', '空白字符串不被当成显式配置');

// ---------------------------------------------------------------- 5. 会话发现

console.log('\n[5] 会话发现（还原真实目录布局）');
const sessionsRoot = join(sandbox, 'sessions');
const topDir = join(sessionsRoot, '--E-project--', 'session-aaaa1111');
const subDir = join(sessionsRoot, '--E-project--', 'bbbb2222');
mkdirSync(topDir, { recursive: true });
mkdirSync(subDir, { recursive: true });
writeFileSync(join(topDir, SESSION_FILE), threeFrame);
writeFileSync(join(subDir, SESSION_FILE), multiFrame([seg1]));
// 该被忽略：没有 session 文件的目录、以及多余的文件
mkdirSync(join(sessionsRoot, '--E-project--', 'empty-dir'), { recursive: true });
writeFileSync(join(sessionsRoot, 'loose.txt'), 'x');

const cfg = resolveConfig({ sessionsDir: sessionsRoot });
const found = listSessions(cfg);
assert(found.length === 2, '只认带 session 文件的目录，忽略其它', `找到 ${found.length}`);
assert(found.some((s) => s.id === 'aaaa1111' && !s.isSubagentDir), '顶层会话识别正确（session- 前缀）');
assert(found.some((s) => s.id === 'bbbb2222' && s.isSubagentDir), '子智能体会话识别正确（裸 uuid）');

const pickedDefault = pickSession(cfg, '');
assert(pickedDefault.session !== null, '不指定时挑最近一个');
const pickedById = pickSession(cfg, 'aaaa1111');
assert(pickedById.session?.id === 'aaaa1111', '按 id 精确挑中');
const pickedByPrefix = pickSession(cfg, 'aaaa');
assert(pickedByPrefix.session?.id === 'aaaa1111', '按 id 前缀挑中');
const pickedMissing = pickSession(cfg, 'no-such-session');
assert(pickedMissing.session === null && typeof pickedMissing.reason === 'string', '挑不到时给出原因而不是抛错');

// ---------------------------------------------------------------- 6. 解析与归纳

console.log('\n[6] JSONL 解析与归纳');
const withBadLine = `${seg1}这不是 JSON\n${seg2}`;
const parsed = parseRecords(withBadLine);
assert(parsed.records.length === 2 && parsed.malformed === 1, '坏行单独计数，不丢掉整个会话', `records=${parsed.records.length} bad=${parsed.malformed}`);

const multi = `{"type":"session","id":"x","cwd":"E:\\\\p","origin":"subagent","agentPreset":"cordis"}\n` +
  '{"type":"turn/start","seq":1}\n{"type":"step/start","seq":2}\n{"type":"step/start","seq":3}\n' +
  `${seg2}${seg3}` +
  '{"type":"user/message","seq":3,"data":{"message":{"role":"user","source":{"kind":"runtime-context","form":"snapshot"},"content":[{"type":"text","text":"策略快照"}]}}}\n' +
  '{"type":"assistant/message","seq":4,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"好的"}]}}}\n';
const summary = summarizeRecords(parseRecords(multi).records);
assert(summary.turns === 1 && summary.steps === 2, 'turn / step 计数正确', `turns=${summary.turns} steps=${summary.steps}`);
assert(summary.meta?.agentPreset === 'cordis' && summary.meta?.origin === 'subagent', '会话元信息被提取');
assert(summary.sources.user === 1 && summary.sources['agent-instructions'] === 1 && summary.sources['runtime-context'] === 1, 'user-role 消息按 source.kind 归类', JSON.stringify(summary.sources));
assert(Object.keys(summary.sources).length === 3, '只统计 user-role，assistant 不计入 sources', JSON.stringify(summary.sources));
assert(summary.roles.assistant === 1, 'roles 另行统计（含 assistant）');
assert(summary.userMessages.every((m) => typeof m.body === 'string'), '每条 user 消息都带正文');

// ---------------------------------------------------------------- 7. 检索

console.log('\n[7] 文本检索');
const hits = findInText(multi, '策略快照', { max: 3 });
assert(hits.length === 1, '找得到命中', `命中 ${hits.length}`);
assert(hits[0].before.includes('runtime-context') || hits[0].before.includes('"seq":3'), '命中带上下文');
assert(findInText(multi, '不存在的词').length === 0, '找不到时返回空数组');

// ---------------------------------------------------------------- 8. 真实文件（可选）

console.log('\n[8] 真实会话文件（有就跑，没有跳过）');
console.log('    注意：这里读的可能是**正在被写入**的会话（比如当前这个会话本身），');
console.log('    所以不断言 complete —— 末尾出现未写完的帧是正常现象，只要求它被如实标注。');
const realCfg = resolveConfig({});
const real = listSessions(realCfg);
if (real.length === 0) {
  console.log(`  （${realCfg.sessionsDir} 下没有会话，跳过）`);
} else {
  const target = real.reduce((a, b) => (a.bytes > b.bytes ? a : b));
  const read = readSessionFile(target.file);
  assert(read.frames > 0, `真实文件解出 ${read.frames} 帧`, String(read.frames));
  assert(read.partialTail === !read.allBytesConsumed, 'partialTail 与 allBytesConsumed 互补');
  assert(read.text.length > read.bytes / 10, '解压后内容量远大于压缩体积（说明不是只出了第一帧）', `${read.bytes} → ${read.text.length}`);
  assert(typeof read.mutatedDuringRead === 'boolean', '如实报告"读取期间文件是否变化过"');
  const realSummary = summarizeRecords(parseRecords(read.text).records);
  assert(realSummary.recordCount > 0, `真实会话有 ${realSummary.recordCount} 条记录`);
  console.log(`     样本：${target.dirName}（${read.frames} 帧 / ${read.text.length} 字符）`);
  console.log(`     读取期间文件变化过：${read.mutatedDuringRead}${read.mutatedDuringRead ? '（会话正在写入，本次内容只是快照）' : ''}`);
  console.log(`     来源分布：${Object.entries(realSummary.sources).map(([k, v]) => `${k}×${v}`).join('、')}`);

  // 把「截断不可察觉」在真实文件上再验一次 —— 这是本插件存在的意义的反面：光看解压结果看不出少了东西。
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
  const rawBuf = readFileSync(target.file);
  const frameStarts = [];
  for (let i = 0; i + 3 < rawBuf.length; i += 1) {
    if (rawBuf[i] === MAGIC[0] && rawBuf[i + 1] === MAGIC[1] && rawBuf[i + 2] === MAGIC[2] && rawBuf[i + 3] === MAGIC[3]) frameStarts.push(i);
  }
  if (frameStarts.length >= 2) {
    const lastStart = frameStarts[frameStarts.length - 1];
    const lastLen = rawBuf.length - lastStart;
    const cutHalf = decompressFrames(rawBuf.subarray(0, lastStart + Math.floor(lastLen / 2)));
    const halfParsed = parseRecords(cutHalf.text);
    assert(cutHalf.text.length < read.text.length, '截断后拿到的内容比完整文件少');
    assert(cutHalf.frames <= read.frames, '截断后帧数不会变多', `${cutHalf.frames} vs ${read.frames}`);
    // 不硬编码结论 —— 实际表现取决于切点，两种都可能，如实打印
    const silent = cutHalf.frames === read.frames && cutHalf.allBytesConsumed === true;
    console.log(`     截断实验：最后一帧砍掉一半（${lastLen} → ${Math.floor(lastLen / 2)} 字节）`);
    console.log(`              记录 ${halfParsed.records.length}（完整 ${realSummary.recordCount}）｜坏行 ${halfParsed.malformed}｜帧 ${cutHalf.frames}（完整 ${read.frames}）｜allBytesConsumed=${cutHalf.allBytesConsumed}`);
    console.log(
      silent
        ? '              ⇒ 安静解出：帧数照数、无坏行、看不出少了记录 —— **这种情况截断完全不可察觉**'
        : '              ⇒ 整帧解不出：帧数少一、allBytesConsumed=false —— 这种情况能察觉（但换个切点可能就察觉不到）',
    );
  }
}

rmSync(sandbox, { recursive: true, force: true });
console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} 项断言失败（通过 ${passed} 项）`);
  process.exit(1);
}
// 空跑即失败：passed + failed 就是断言被调用的次数。为 0 说明一条都没跑
// （脚本被清空 / 提前退出 / 循环体没进），那种「绿」比红更危险。
if (passed + failed === 0) {
  console.error('✗ 空跑：一条断言都没执行 —— 判为失败（不是通过）');
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过 —— 多帧 zstd 处理正确，归纳与检索正常`);
