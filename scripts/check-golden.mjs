/**
 * dsh-session-inspect — golden 差分自检。
 *
 *   node scripts/check-golden.mjs           比对
 *   node scripts/check-golden.mjs --update  重新生成基线
 *
 * ## 为什么要它
 *
 * 「断言全过」只证明**我们想到的那几条**没坏。而 `summarizeRecords` 这类归纳函数
 * 最容易在重构时**悄悄改变没被断言的字段**（例如某个 source.kind 的归类、空数组 vs undefined）。
 * 所以另冻一份**完整输出快照**，要求**逐字节**一致 —— 任何一处语义被改动都会立刻报红。
 *
 * 这就是把 dsh-tavern 的 golden 差分做法搬过来的版本：那边冻的是提示词产物，
 * 这边冻的是会话归纳结果。
 *
 * ## 边界（别把它当全覆盖）
 *
 * - 只覆盖 `parseRecords` / `summarizeRecords` 这一层**数据**输出。
 * - **不**覆盖 `lib/index.js` 里的文本渲染、工具参数校验、路由鉴权 —— 那些有各自的断言。
 * - 也**不**覆盖多帧 zstd 解压的字节级行为（压缩输出随 Node 版本变，冻了只会带来假红）。
 *
 * ## 空跑判据
 *
 * 用例数为 0 判**失败**。另外脚本会做一次**反向自检**：故意篡改一份期望值，
 * 确认比对器真的能抓到差异 —— 一个永远不会报错的比对器等于没有。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecords, summarizeRecords } from '../lib/session-log.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'golden-summary.json');
const UPDATE = process.argv.includes('--update');

/**
 * 用例：每条给出 JSONL 行（字符串数组），实际输入 = 这些行用换行拼接。
 * 期望值是**整份** summarizeRecords 输出的冻结快照。
 */
const CASES = [
  {
    name: '有 AGENTS.md 注入、无技能目录（当初排查的那个形态）',
    note: 'agent-instructions 在、任何 skill 来源都不在 —— 这正是那次的结论形态',
    lines: [
      '{"type":"session","version":4,"id":"case-1","cwd":"E:\\\\project","origin":"subagent","parentSession":"parent-1","agentPreset":"cordis"}',
      '{"type":"turn/start","seq":1}',
      '{"type":"user/message","seq":2,"data":{"message":{"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"去验证一下"}]}}}',
      '{"type":"user/message","seq":3,"data":{"message":{"role":"user","source":{"kind":"agent-instructions","form":"instructions"},"content":[{"type":"text","text":"# 本机约定"}]}}}',
      '{"type":"user/message","seq":4,"data":{"message":{"role":"user","source":{"kind":"runtime-context","form":"snapshot"},"content":[{"type":"text","text":"策略快照"}]}}}',
      '{"type":"step/start","seq":5}',
      '{"type":"assistant/message","seq":6,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"好的"}]}}}',
    ],
  },
  {
    name: '有技能目录来源',
    note: 'skill-catalog 这个 kind 必须被如实归入 sources',
    lines: [
      '{"type":"session","version":4,"id":"case-2","cwd":"E:\\\\other"}',
      '{"type":"user/message","seq":1,"data":{"message":{"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"加载技能"}]}}}',
      '{"type":"user/message","seq":2,"data":{"message":{"role":"user","source":{"kind":"skill-catalog","form":"catalog"},"content":[{"type":"text","text":"Available skills: a, b"}]}}}',
    ],
  },
  {
    name: '坏行容错',
    note: '中间夹一行非 JSON：坏行单独计数，不能丢掉整个会话',
    lines: [
      '{"type":"session","version":4,"id":"case-3"}',
      '{"type":"turn/start","seq":1}',
      '这不是 JSON',
      '{"type":"user/message","seq":2,"data":{"message":{"role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"还能读到这条"}]}}}',
    ],
  },
  {
    name: '多次 turn / step 与元信息',
    note: 'turn 与 step 的计数口径一旦被改，这里会红',
    lines: [
      '{"type":"session","version":4,"id":"case-4","cwd":"D:\\\\work","origin":"user","agentPreset":"default","delegationDepth":0}',
      '{"type":"turn/start","seq":1}',
      '{"type":"step/start","seq":2}',
      '{"type":"step/start","seq":3}',
      '{"type":"turn/start","seq":4}',
      '{"type":"step/start","seq":5}',
      '{"type":"tool/call","seq":6,"data":{"name":"read","arguments":"{}"}}',
      '{"type":"tool/result","seq":7,"data":{"message":{"role":"tool","content":[{"type":"text","text":"ok"}]}}}',
    ],
  },
  {
    name: '只有元信息的空会话',
    note: '全零的直方图也要稳定（空对象 vs 缺字段是两种不同的回归）',
    lines: ['{"type":"session","version":4,"id":"case-5"}'],
  },
];

/** 键排序后的稳定序列化 —— 否则对象键序变化会造成假红。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 跑一个用例，返回冻结用的结果。 */
function runCase(testCase) {
  const text = testCase.lines.join('\n');
  const parsed = parseRecords(text);
  const summary = summarizeRecords(parsed.records);
  return { malformed: parsed.malformed, summary };
}

const actual = CASES.map((testCase) => ({ name: testCase.name, note: testCase.note, expected: runCase(testCase) }));

// ---------------------------------------------------------------- --update

if (UPDATE) {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
  console.log(`已写入基线：${FIXTURE}（${actual.length} 个用例）`);
  process.exit(0);
}

// ---------------------------------------------------------------- 比对

let failed = 0;
let assertions = 0;

function assert(condition, label, detail) {
  assertions += 1;
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 找出第一处差异的人类可读位置，便于定位。 */
function firstDifference(a, b) {
  const sa = canonical(a);
  const sb = canonical(b);
  if (sa === sb) return null;
  let i = 0;
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i += 1;
  return { at: i, expected: sa.slice(Math.max(0, i - 40), i + 60), actual: sb.slice(Math.max(0, i - 40), i + 60) };
}

console.log('dsh-session-inspect golden 差分\n');

if (!existsSync(FIXTURE)) {
  console.error(`✗ 找不到基线文件：${FIXTURE}`);
  console.error('  先跑一次 node scripts/check-golden.mjs --update 生成');
  process.exit(1);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(FIXTURE, 'utf8'));
} catch (error) {
  console.error(`✗ 基线文件不是合法 JSON：${error?.message ?? error}`);
  process.exit(1);
}
if (!Array.isArray(baseline)) {
  console.error('✗ 基线文件结构不对：期望是数组');
  process.exit(1);
}

console.log(`基线：${FIXTURE}`);
console.log(`用例：代码里 ${actual.length} 个，基线里 ${baseline.length} 个\n`);

console.log('[1] 用例集合一致');
assert(baseline.length === actual.length, `用例数相同（${actual.length}）`, `基线 ${baseline.length}`);
const baselineNames = baseline.map((c) => c.name);
const actualNames = actual.map((c) => c.name);
assert(
  baselineNames.join('|') === actualNames.join('|'),
  '用例名称与顺序一致',
  `缺：${actualNames.filter((n) => !baselineNames.includes(n)).join(',') || '无'}｜多：${baselineNames.filter((n) => !actualNames.includes(n)).join(',') || '无'}`,
);

console.log('\n[2] 逐用例逐字节比对');
for (let i = 0; i < actual.length; i += 1) {
  const current = actual[i];
  const expected = baseline[i];
  if (!expected) {
    assert(false, `${current.name}：基线里没有这个用例`);
    continue;
  }
  assert(canonical(current.expected) === canonical(expected.expected), current.name, firstDifference(expected.expected, current.expected)?.actual);
  const diff = firstDifference(expected.expected, current.expected);
  if (diff) {
    console.log(`      首个差异在偏移 ${diff.at}`);
    console.log(`      基线: …${diff.expected}…`);
    console.log(`      实际: …${diff.actual}…`);
  }
}

console.log('\n[3] 比对器反向自检（一个永不报错的比对器等于没有）');
const tampered = JSON.parse(JSON.stringify(baseline));
if (tampered[0]?.expected?.summary) {
  // 故意改一个字段值
  const before = tampered[0].expected.summary.recordCount;
  tampered[0].expected.summary.recordCount = Number(before) + 1;
  assert(canonical(tampered[0].expected) !== canonical(actual[0].expected), '改动一个字节能被抓到', '比对器没报出差异！');
  tampered[0].expected.summary.recordCount = before;
  assert(canonical(tampered[0].expected) === canonical(actual[0].expected), '还原后不再报差异（不误报）');
} else {
  assert(false, '基线结构不含 summary，无法做反向自检');
}

// ---------------------------------------------------------------- 汇总

console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} 项断言失败（通过 ${assertions - failed} 项）`);
  console.error('  若这是有意的行为变更：跑 --update 重冻基线，并在提交信息里说明为什么变。');
  console.error('  若这是意外：说明归纳逻辑被改了 —— 这正是这套差分要抓的东西。');
  process.exit(1);
}
// 空跑判据
if (assertions === 0) {
  console.error('✗ 空跑：一条断言都没执行 —— 判为失败（不是通过）');
  process.exit(1);
}
console.log(`✓ golden 差分通过：${actual.length} 个用例的输出与基线逐字节一致（${assertions} 项断言）`);
