#!/usr/bin/env node
/* 真实数据验证：fetchUsageRows 解析 /root/usage_loggedin.html（登录态真实页面） */
const fs = require('fs');
const vm = require('vm');

const bgSrc = fs.readFileSync('/root/notes/research/edge-extension/background.js', 'utf8');
const realHtml = fs.readFileSync('/root/usage_loggedin.html', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (e ? ' — ' + e : '')); } };

// 提取 fetchUsageRows（含依赖的 USAGE_ROW_LIMIT）
const m = bgSrc.match(/async function fetchUsageRows[\s\S]*?\n\}\n/);
if (!m) { console.log('fetchUsageRows 未找到'); process.exit(1); }

const sandbox = {
  fetch: async (url, opts) => ({
    status: 200, ok: true,
    async text() { return realHtml; },
  }),
  encodeURIComponent,
  console,
};
vm.createContext(sandbox);
vm.runInContext('const USAGE_ROW_LIMIT = 50;', sandbox);
vm.runInContext(m[0], sandbox);

(async () => {
  const rows = await sandbox.fetchUsageRows('wrk_01KVVTA6TNM446V0P9Q6N7FJVZ');
  console.log('== 解析结果 ==');
  ok('解析出 50 条', rows.length === 50, 'got ' + rows.length);
  ok('limited 标记 = true', rows.limited === true);
  const r0 = rows[0];
  console.log('  首条样本:', JSON.stringify(r0));
  ok('timeCreated 可解析为日期', !isNaN(new Date(r0.timeCreated).getTime()), r0.timeCreated);
  ok('model 非空', !!r0.model, r0.model);
  ok('inputTokens 为数字', typeof r0.inputTokens === 'number');
  ok('cacheWrite5mTokens 兼容 null→0', typeof r0.cacheWrite5mTokens === 'number');
  ok('cost 为数字', typeof r0.cost === 'number');
  ok('plan 非空', !!r0.plan, r0.plan);

  // 验证聚合（用真实数据）
  const aggM = bgSrc.match(/function aggUsage[\s\S]*?\n\}\n/);
  vm.runInContext(aggM[0], sandbox);
  const agg = sandbox.aggUsage(rows);
  console.log('== 真实数据聚合 ==');
  console.log('  今日:', JSON.stringify(agg.today));
  console.log('  本月:', JSON.stringify(agg.month));
  console.log('  limited:', agg.limited, ' monthKey:', agg.monthKey);
  ok('今日 tokens > 0', agg.today.tokens > 0);
  ok('本月 tokens >= 今日', agg.month.tokens >= agg.today.tokens);
  ok('今日 calls >= 1', agg.today.calls >= 1);
  ok('费用为正', agg.today.cost > 0);

  // 验证时间归属正确性：今日的调用时间都在今天
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const todayRows = rows.filter(r => r.timeCreated.slice(0, 10) === todayStr);
  ok('今日行数与聚合 calls 一致', todayRows.length === agg.today.calls,
     todayRows.length + ' vs ' + agg.today.calls);

  // 空态页面（无 usg_ 记录）
  sandbox.fetch = async () => ({ status: 200, ok: true, async text() { return '<html>发起第一个 API 调用以开始</html>'; } });
  const empty = await sandbox.fetchUsageRows('wrk_x');
  ok('空态页面 → 空数组', Array.isArray(empty) && empty.length === 0);

  // 未登录（302）→ not_logged_in
  sandbox.fetch = async () => ({ status: 302, ok: false });
  try { await sandbox.fetchUsageRows('wrk_x'); ok('302 → 抛错', false); }
  catch (e) { ok('302 → not_logged_in', e.message === 'not_logged_in', e.message); }

  console.log('');
  console.log('结果: ' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})();
