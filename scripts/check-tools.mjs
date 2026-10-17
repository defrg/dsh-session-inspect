/**
 * dsh-session-inspect — 工具层自检（不依赖 DSH，不需要真实会话）。
 *
 *   node scripts/check-tools.mjs
 *
 * 在临时目录里**造一棵合成的 sessions 树**（多帧 zstd，还原真实布局），把 8 个工具实跑一遍：
 * 探活 / 列表 / 归纳 / 注入核对 / 检索 / 原始记录 / 导出 / 配置，外加配置路由的鉴权门。
 *
 * 其中 [4] 是**这个插件当初被写出来的那个案例**：造一个"有 AGENTS.md 注入、没有技能目录"的会话，
 * 断言 session_messages 能如实报出「只有 agent-instructions，没有任何 skill 来源」——
 * 也就是断言它能重现当初手工排查才得出的结论。
 *
 * 临时目录：`DSH_SESSION_INSPECT_CHECK_DIR`，未设置则用系统临时目录。
 * 退出码：0 = 全过，1 = 有断言失败。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { apply } from '../lib/index.js';

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

// ---------------------------------------------------------------- 假 ctx

const registered = new Map();
const routes = [];
const writes = [];
let rejection;

const ctx = {
  on() {
    return () => {};
  },
  tools: {
    register(definition) {
      registered.set(definition.name, definition);
      return () => {};
    },
  },
  settings: {
    async update(entryId, patch) {
      writes.push({ entryId, patch });
      return { layer: 'profile', entryId };
    },
  },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  connection: {
    requestRejection() {
      return rejection;
    },
  },
};

// ---------------------------------------------------------------- 合成会话树

const work = process.env.DSH_SESSION_INSPECT_CHECK_DIR || join(process.env.TEMP || '/tmp', 'dsh-session-inspect-check');
const sandbox = join(work, 'tools-probe');
rmSync(sandbox, { recursive: true, force: true });
const sessionsRoot = join(sandbox, 'sessions');
const exportDir = join(sandbox, 'exports');
mkdirSync(sessionsRoot, { recursive: true });

/**
 * 每段各压一帧再拼接 —— 与 DSH 的真实写法一致。
 * 注意**每行必须自带结尾换行**：解压后是靠换行切 JSONL 的，
 * 少一个 `\n` 就会把整个会话粘成一条非法 JSON。
 */
const multiFrame = (lines) => Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))));

const userLine = (seq, kind, form, text) =>
  JSON.stringify({ type: 'user/message', seq, data: { message: { role: 'user', source: form ? { kind, form } : { kind }, content: [{ type: 'text', text }] } } });
const assistantLine = (seq, text) =>
  JSON.stringify({ type: 'assistant/message', seq, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });

// 会话 A：模拟"有 AGENTS.md 注入、但没有任何技能目录"——本插件当初的排查对象
const sessionA = [
  JSON.stringify({ type: 'session', version: 4, id: 'aaaa1111', cwd: 'E:\\project', origin: 'subagent', parentSession: 'parent-1', agentPreset: 'cordis' }),
  JSON.stringify({ type: 'turn/start', seq: 1 }),
  userLine(2, 'user', null, '你是一台 Windows 机器上的 DSH 智能体，去验证一下。'),
  userLine(3, 'agent-instructions', 'instructions', '# 本机 DSH 用户级约定\n节点编号 node-1……'),
  userLine(4, 'runtime-context', 'snapshot', 'Current DSH file policy: danger-full-access.'),
  JSON.stringify({ type: 'step/start', seq: 5 }),
  assistantLine(6, '我先看看有哪些技能可用（available skills）。'),
  JSON.stringify({ type: 'tool/call', seq: 7, data: { name: 'skill', arguments: '{"name":"dsh-git-workflow"}' } }),
];

// 会话 B：普通顶层会话，含一个假的"技能目录"来源，用来验证按 kind 过滤
const sessionB = [
  JSON.stringify({ type: 'session', version: 4, id: 'bbbb2222', cwd: 'E:\\other' }),
  JSON.stringify({ type: 'turn/start', seq: 1 }),
  userLine(2, 'user', null, '把 npm 上的覆写掉'),
  userLine(3, 'skill-catalog', 'catalog', 'Available skills: dsh-git-workflow —— 本机 git 规程'),
  assistantLine(4, '好的，我先加载它。'),
];

mkdirSync(join(sessionsRoot, '--E-project--', 'session-aaaa1111'), { recursive: true });
mkdirSync(join(sessionsRoot, '--E-project--', 'session-bbbb2222'), { recursive: true });
writeFileSync(join(sessionsRoot, '--E-project--', 'session-aaaa1111', 'session.v4.jsonl.zstd'), multiFrame(sessionA));
writeFileSync(join(sessionsRoot, '--E-project--', 'session-bbbb2222', 'session.v4.jsonl.zstd'), multiFrame(sessionB));

apply(ctx, { sessionsDir: sessionsRoot, exportDir, maxTextChars: 60000 });

/**
 * 工具返回值必须是**可无损序列化**的 JSON：宿主对不合规的输出直接判
 * `value is not lossless JSON`，并让整次调用失败。
 *
 * 实测踩过：`session_health` 里写了 `code: missing ? "NO_SESSIONS" : undefined`，
 * `undefined` 在 JSON.stringify 时被静默丢掉 —— 静态断言全过，一上真机就报错。
 * 所以这里对**每一次**工具调用递归检查，而不是逐个字段去断言。
 */
function findNonJson(value, path = '$') {
  if (value === undefined) return `${path} 是 undefined`;
  if (typeof value === 'function') return `${path} 是函数`;
  if (typeof value === 'symbol') return `${path} 是 symbol`;
  if (typeof value === 'bigint') return `${path} 是 bigint`;
  if (typeof value === 'number' && !Number.isFinite(value)) return `${path} 是 ${value}`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const bad = findNonJson(value[i], `${path}[${i}]`);
      if (bad) return bad;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const bad = findNonJson(item, `${path}.${key}`);
      if (bad) return bad;
    }
    return null;
  }
  return null;
}

const nonJsonValues = [];

async function tool(name, args = {}) {
  const definition = registered.get(name);
  if (!definition) throw new Error(`工具未注册：${name}`);
  const value = await definition.execute(args);
  const bad = findNonJson(value);
  if (bad) nonJsonValues.push(`${name}: ${bad}`);
  return value;
}

console.log('dsh-session-inspect 工具层自检\n');
console.log(`合成会话目录：${sessionsRoot}\n`);

// ---------------------------------------------------------------- 1. 注册面

console.log('[1] 工具注册面');
const expected = ['session_health', 'session_list', 'session_inspect', 'session_messages', 'session_search', 'session_show', 'session_export', 'session_config'];
for (const toolName of expected) {
  const definition = registered.get(toolName);
  assert(Boolean(definition) && typeof definition.execute === 'function' && definition.description.length > 10, `${toolName} 已注册且带说明`);
}
assert(registered.size === expected.length, `注册数量正好 ${expected.length} 个`, `实际 ${registered.size}`);
assert(registered.get('session_search').isConcurrencySafe() === true, '只读工具声明为可并发');
assert(registered.get('session_export').isConcurrencySafe() === false, '写盘工具声明为串行');

// ---------------------------------------------------------------- 2. 探活与列表

console.log('\n[2] 探活与列表');
const health = await tool('session_health');
assert(health.ok === true, 'session_health 报可用');
assert(health.sessionsDir === sessionsRoot && health.sessionsDirSource === '配置项 sessionsDir', '报告目录与来源', health.sessionsDirSource);
assert(health.sessionCount === 2, '数到 2 个会话', String(health.sessionCount));

const list = await tool('session_list');
assert(list.ok === true && list.total === 2, 'session_list 列出 2 个');
assert(list.sessions.some((s) => s.id === 'aaaa1111' && s.kind === 'subagent'), '会话 A 识别为子代理且带 cwd', JSON.stringify(list.sessions.map((s) => [s.id, s.kind, s.cwd])));

// ---------------------------------------------------------------- 3. 归纳

console.log('\n[3] 归纳');
const inspect = await tool('session_inspect', { session: 'aaaa1111' });
assert(inspect.ok === true, 'session_inspect 成功');
assert(inspect.decompression.frames === sessionA.length, `帧数 = 写入的行数（${sessionA.length}）`, String(inspect.decompression.frames));
assert(inspect.decompression.allBytesConsumed === true, '合成文件的字节被完整消费');
assert(inspect.meta?.agentPreset === 'cordis' && inspect.meta?.parentSession === 'parent-1', '元信息含 preset 与父会话', JSON.stringify(inspect.meta));
assert(inspect.turns === 1 && inspect.steps === 1, 'turn / step 计数正确', `turns=${inspect.turns} steps=${inspect.steps}`);
assert(inspect.sources.user === 1 && inspect.sources['agent-instructions'] === 1, '来源分布含 user 与 agent-instructions', JSON.stringify(inspect.sources));

// ---------------------------------------------------------------- 4. 本插件当初的案例

console.log('\n[4] 复现当初的排查：AGENTS.md 到了、技能目录没到');
const a = await tool('session_messages', { session: 'aaaa1111' });
assert(a.ok === true, 'session_messages 成功');
assert(a.sources['agent-instructions'] === 1, 'AGENTS.md 注入**确实送达**（agent-instructions×1）');
const skillKindsA = Object.keys(a.sources).filter((kind) => /skill/i.test(kind));
assert(skillKindsA.length === 0, '**没有任何技能相关来源** —— 与当初手工排查的结论一致', skillKindsA.join(','));
// 关键：正文里确实出现过 available skills 这个词（assistant 自己说的），但按 kind 归类不会误判
assert(a.text.includes('我先看看有哪些技能可用') === false, '返回的是 user-role 消息，不含 assistant 正文');
const searchA = await tool('session_search', { query: 'available skills', session: 'aaaa1111' });
assert(searchA.sessionsWithHits === 1, '全文搜索能搜到 "available skills"（说明搜索是弱信号）');
assert(searchA.text.includes('命中 ≠ 投递'), '搜索结果的输出里带这句提醒');

// 对照：会话 B 有 skill-catalog 来源，应能被 kind 过滤出来
const b = await tool('session_messages', { session: 'bbbb2222', kind: 'skill' });
assert(b.ok === true && b.shown === 1, '按 kind=skill 过滤出 1 条', String(b.shown));
assert(b.messages[0]?.kind === 'skill-catalog', '过滤命中的是 skill-catalog', b.messages[0]?.kind);
assert(b.messages[0]?.form === 'catalog', 'form 字段一并返回', String(b.messages[0]?.form));
const bAll = await tool('session_messages', { session: 'bbbb2222' });
assert(bAll.total === 2 && bAll.shown === 2, '不过滤时返回该会话全部 2 条 user 消息', `total=${bAll.total} shown=${bAll.shown}`);

// ---------------------------------------------------------------- 5. 原始记录

console.log('\n[5] 原始记录');
const toolCalls = await tool('session_show', { session: 'aaaa1111', type: 'tool/call' });
assert(toolCalls.ok === true && toolCalls.shown === 1, '按 type=tool/call 取出 1 条', String(toolCalls.shown));
assert(toolCalls.records[0]?.data?.name === 'skill', '取出的正是那次 skill 调用', toolCalls.records[0]?.data?.name);
const byIndex = await tool('session_show', { session: 'aaaa1111', index: 0, limit: 1 });
assert(byIndex.records[0]?.type === 'session', '按序号取到第 0 条（session 元信息）', byIndex.records[0]?.type);

// ---------------------------------------------------------------- 6. 导出

console.log('\n[6] 导出');
const exported = await tool('session_export', { session: 'aaaa1111' });
assert(exported.ok === true, 'session_export 成功', exported.reason ?? '');
const text = readFileSync(exported.writtenTo, 'utf8');
const source = readFileSync(join(sessionsRoot, '--E-project--', 'session-aaaa1111', 'session.v4.jsonl.zstd'));
assert(text.split('\n').filter(Boolean).length === sessionA.length, '导出的 JSONL 行数与原始帧数一致', String(text.split('\n').filter(Boolean).length));
assert(source.length < 4096 && text.length > source.length, '导出的是解压后内容（比压缩件大）', `${source.length} → ${text.length}`);

// ---------------------------------------------------------------- 7. 配置工具

console.log('\n[7] 配置工具');
const cfgGet = await tool('session_config', { action: 'get' });
assert(cfgGet.ok === true, 'session_config get 成功');
assert(cfgGet.effective.sessionsDir === sessionsRoot, 'get 返回生效的 sessionsDir', cfgGet.effective.sessionsDir);
assert(cfgGet.text.includes('来源'), 'get 的文本里有来源标注');
const writesBefore = writes.length;
const cfgSet = await tool('session_config', { action: 'set', dshHome: 'D:/fake/.dsh' });
assert(cfgSet.ok === true, 'session_config set 成功', cfgSet.text?.slice(0, 60));
assert(writes.length === writesBefore + 1 && writes[writes.length - 1].patch.dshHome === 'D:/fake/.dsh', 'set 触发一次 settings.update 且内容正确');
assert(typeof cfgSet.writtenTo === 'string', '返回写入位置', cfgSet.writtenTo);
const cfgBad = await tool('session_config', { action: 'set' });
assert(cfgBad.ok === false && cfgBad.code === 'BAD_ARGS', 'set 不带字段时报 BAD_ARGS');
const cfgUnknown = await tool('session_config', { action: 'nope' });
assert(cfgUnknown.ok === false && cfgUnknown.code === 'BAD_ARGS', '未知 action 报 BAD_ARGS');

// ---------------------------------------------------------------- 8. 错误路径

console.log('\n[8] 错误路径');
const missing = await tool('session_inspect', { session: 'no-such-session' });
assert(missing.ok === false && missing.code === 'NO_SESSION', '挑不到会话时报 NO_SESSION');
assert(Array.isArray(missing.candidates) && missing.candidates.length === 2, 'NO_SESSION 里列出可选会话', String(missing.candidates?.length));
const emptyQuery = await tool('session_search', { query: '' });
assert(emptyQuery.ok === false && emptyQuery.code === 'BAD_ARGS', '空 query 被拒');

// ---------------------------------------------------------------- 9. 配置路由鉴权

console.log('\n[9] 配置路由鉴权');
const route = routes.find((r) => r.path === '/session-inspect/api');
assert(Boolean(route) && route.kind === 'prefix', '已注册 /session-inspect/api 路由');

function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const handlers = {};
  const req = {
    method,
    url,
    headers,
    complete: body === undefined,
    readableEnded: body === undefined,
    on(event, callback) {
      handlers[event] = callback;
      if (event === 'data' && body !== undefined) queueMicrotask(() => callback(Buffer.from(body, 'utf8')));
      if (event === 'end') queueMicrotask(() => handlers.end?.());
      return req;
    },
  };
  return req;
}
const makeRes = () => ({
  statusCode: 200,
  headers: {},
  body: undefined,
  setHeader(key, value) {
    this.headers[String(key).toLowerCase()] = value;
  },
  end(body) {
    this.body = body;
  },
});
const CONFIG_URL = '/session-inspect/api/config';

rejection = 403;
let res = makeRes();
await route.handler(makeReq({ method: 'GET', url: CONFIG_URL }), res);
assert(res.statusCode === 403, '未鉴权 GET 返回 403', String(res.statusCode));
assert(!res.body || !String(res.body).includes('sessionsDir'), '未鉴权响应体不含配置内容');

rejection = 401;
const writesBeforePost = writes.length;
res = makeRes();
await route.handler(makeReq({ method: 'POST', url: CONFIG_URL, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionsDir: 'E:/evil' }) }), res);
assert(res.statusCode === 401, '未鉴权 POST 返回 401', String(res.statusCode));
assert(writes.length === writesBeforePost, '未鉴权 POST 没有发生写入');

rejection = undefined;
res = makeRes();
await route.handler(makeReq({ method: 'GET', url: CONFIG_URL }), res);
let parsed = null;
try {
  parsed = JSON.parse(String(res.body));
} catch {
  /* 下面的断言会报出来 */
}
assert(res.statusCode === 200 && parsed?.ok === true, '鉴权通过 GET 返回 200 且是合法 JSON');
assert(typeof parsed?.result?.effective?.sessionsDir === 'string', '生效值里带 sessionsDir');

res = makeRes();
await route.handler(makeReq({ method: 'POST', url: CONFIG_URL, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dshHome: 'D:/x', maxTextChars: 5, bogus: 'y' }) }), res);
const lastWrite = writes[writes.length - 1];
assert(lastWrite?.patch?.dshHome === 'D:/x', '鉴权通过 POST 写入白名单字段', JSON.stringify(lastWrite?.patch));
assert(!('maxTextChars' in (lastWrite?.patch ?? {})) && !('bogus' in (lastWrite?.patch ?? {})), '白名单外字段未被写入', JSON.stringify(lastWrite?.patch));

res = makeRes();
await route.handler(makeReq({ method: 'POST', url: CONFIG_URL, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxTextChars: 5 }) }), res);
assert(res.statusCode === 400, '没有任何可写字段时返回 400', String(res.statusCode));

res = makeRes();
await route.handler(makeReq({ method: 'GET', url: '/session-inspect/api/nope' }), res);
assert(res.statusCode === 404, '未知路由返回 404', String(res.statusCode));

// ---------------------------------------------------------------- 10. 返回值可无损序列化

console.log('\n[10] 所有工具返回值都可无损序列化为 JSON（宿主硬要求）');
assert(nonJsonValues.length === 0, `本轮 ${passed > 0 ? '' : ''}全部工具调用的返回值都合法`, nonJsonValues.slice(0, 3).join('；'));
// 反向自检：确认这个检查器真的能抓到问题，否则"全过"毫无意义
const probeBad = findNonJson({ ok: true, code: undefined });
assert(typeof probeBad === 'string' && probeBad.includes('undefined'), '检查器本身能抓出 undefined 字段（反向自检）', String(probeBad));
assert(findNonJson({ ok: true, nested: { list: [1, 'a', null] } }) === null, '检查器对合法值不误报');
assert(findNonJson({ n: NaN }) !== null, '检查器能抓出 NaN');

// ---------------------------------------------------------------- 汇总

rmSync(sandbox, { recursive: true, force: true });
console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} 项断言失败（通过 ${passed} 项）`);
  process.exit(1);
}
// 空跑即失败：passed + failed 就是断言被调用的次数。为 0 说明一条都没跑。
if (passed + failed === 0) {
  console.error('✗ 空跑：一条断言都没执行 —— 判为失败（不是通过）');
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 项断言通过 —— 工具在合成会话上工作正常，且能复现当初的排查结论`);
