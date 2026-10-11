// VDL 回归测试执行器：node tests/run.mjs [--filter=关键字] [--only=01,03] [--list] [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { CaseContext, RUNTIME_ROOT, TESTS_DIR, pathToFileURL } from './harness.mjs';

const args = process.argv.slice(2);
const valueOf = flag => (args.find(a => a.startsWith(`${flag}=`)) || '').split('=').slice(1).join('=');
const filter = valueOf('--filter');
const only = valueOf('--only').split(',').map(s => s.trim()).filter(Boolean);
const listOnly = args.includes('--list');
const verbose = args.includes('--verbose') || args.includes('-v');

const casesDir = path.join(TESTS_DIR, 'cases');
const files = fs.existsSync(casesDir)
  ? fs.readdirSync(casesDir).filter(f => f.endsWith('.mjs')).sort()
  : [];
const cases = [];
for (const file of files) {
  const mod = await import(pathToFileURL(path.join(casesDir, file)).href);
  if (!mod.default) throw new Error(`用例文件缺少 default 导出：${file}`);
  cases.push(mod.default);
}

const selected = cases.filter(c => {
  if (only.length) return only.includes(c.id);
  if (filter) return `${c.id} ${c.title} ${(c.covers || []).join(' ')}`.includes(filter);
  return true;
});

if (listOnly) {
  console.log('VDL 回归用例清单：');
  for (const c of cases) console.log(`  [${c.id}] ${c.title}`);
  console.log(`\n共 ${cases.length} 个用例；执行全部：node tests/run.mjs`);
  process.exit(0);
}

if (!selected.length) {
  console.log('没有匹配的用例。用 --list 查看清单。');
  process.exit(1);
}

console.log(`VDL 回归测试（${selected.length}/${cases.length} 个用例${verbose ? '，verbose' : ''}）\n`);

const started = Date.now();
const results = [];

for (const meta of selected) {
  const ctx = new CaseContext(meta, { verbose });
  const caseStart = Date.now();
  let crashed = '';
  try {
    await meta.run(ctx);
  } catch (e) {
    crashed = e.stack || e.message;
  }
  await ctx.dispose();

  const failedChecks = ctx.checks.filter(c => !c.ok);
  const status = ctx.skipReason ? 'SKIP' : (crashed || failedChecks.length ? 'FAIL' : 'PASS');
  const elapsed = ((Date.now() - caseStart) / 1000).toFixed(1);
  const passed = ctx.checks.length - failedChecks.length;
  const summary = ctx.skipReason
    ? `SKIP  ${ctx.skipReason}`
    : `${status}  ${passed}/${ctx.checks.length}${ctx.checks.length ? '' : ' 无断言'}  ${elapsed}s`;

  console.log(`[${meta.id}] ${meta.title.padEnd(34, ' ')} ${summary}`);
  for (const c of failedChecks) console.log(`      ✗ ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
  if (crashed) console.log(`      ✗ 用例异常: ${crashed.split('\n').slice(0, 4).join('\n        ')}`);
  if (status === 'FAIL') {
    const tail = ctx.logs();
    if (tail) console.log(`      · server 日志尾部：\n${tail.slice(-800)}`);
  }

  results.push({
    id: meta.id,
    title: meta.title,
    status,
    checks: ctx.checks.length,
    failed: failedChecks.length,
    elapsed: Date.now() - caseStart,
  });
}

const failedCases = results.filter(r => r.status === 'FAIL');
const skippedCases = results.filter(r => r.status === 'SKIP');
const checksTotal = results.reduce((sum, r) => sum + r.checks, 0);
const checksFailed = results.reduce((sum, r) => sum + r.failed, 0);

console.log(`\n用例 ${results.length - failedCases.length - skippedCases.length}/${results.length} 通过` +
  (skippedCases.length ? `，跳过 ${skippedCases.length}` : '') +
  `；断言 ${checksTotal - checksFailed}/${checksTotal} 通过；用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (!failedCases.length && fs.existsSync(RUNTIME_ROOT) && !fs.readdirSync(RUNTIME_ROOT).length) {
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
}

if (failedCases.length) {
  console.log(`\n失败用例：${failedCases.map(r => `[${r.id}] ${r.title}`).join('；')}`);
  console.log('提示：用例目录 .runtime-tests/ 保留现场，可加 --verbose 查看每条断言。');
  process.exit(1);
}
console.log('全部通过 ✅');
