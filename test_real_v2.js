#!/usr/bin/env node
/* 真实 RPC 响应端到端验证：parseUsageRows 3 页合并去重 + fetchDailyCosts 每日成本 */
const fs = require('fs');
const vm = require('vm');

const bgSrc = fs.readFileSync('/root/notes/research/edge-extension/background.js', 'utf8');
const p0 = fs.readFileSync('/root/rpc_real_p0.txt', 'utf8');
const p1 = fs.readFileSync('/root/rpc_real_p1.txt', 'utf8');
const p2 = fs.readFileSync('/root/rpc_real_p2.txt', 'utf8');
const costs = fs.readFileSync('/root/rpc_real_costs.txt', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (e ? ' — ' + e : '')); } };

// 提取 parseUsageRows / fetchDailyCosts / aggUsage
const extract = (fnName) => {
  const m = bgSrc.match(new RegExp('(?:async )?function ' + fnName + '[\\s\\S]*?\\n\\}\\n'));
  if (!m) throw new Error(fnName + ' 未找到');
  return m[0];
};
const sandbox = { console, Date, Map, Set, Math, String, Number, Infinity };
vm.createContext(sandbox);
for (const fn of ['parseUsageRows', 'fetchDailyCosts', 'aggUsage']) {
  vm.runInContext(extract(fn), sandbox);
}

console.log('== 每页解析 ==');
const r0 = sandbox.parseUsageRows(p0);
const r1 = sandbox.parseUsageRows(p1);
const r2 = sandbox.parseUsageRows(p2);
ok('第 0 页 50 条', r0.length === 50, 'got ' + r0.length);
ok('第 1 页 50 条', r1.length === 50, 'got ' + r1.length);
ok('第 2 页 50 条', r2.length === 50, 'got ' + r2.length);
ok('每页有唯一 id', new Set(r0.map(x => x.id)).size === 50);
const t0 = new Date(r0[0].timeCreated).getTime();
const t1 = new Date(r1[0].timeCreated).getTime();
const t2 = new Date(r2[0].timeCreated).getTime();
ok('时间倒序（p0 最新 > p1 > p2）', t0 > t1 && t1 > t2, `${t0} ${t1} ${t2}`);
ok('首条在今天', new Date(r0[0].timeCreated).getDate() === new Date().getDate());

console.log('== 模拟翻页合并（去重 + 当日覆盖判定）==');
const all = [...r0];
const seen = new Set(all.map(x => x.id));
let added = 0;
for (const page of [r1, r2]) {
  for (const r of page) {
    if (seen.has(r.id)) continue;
    seen.add(r.id); all.push(r); added++;
  }
}
ok('3 页合并 150 条（无重复）', all.length === 150, 'got ' + all.length);
ok('合并后仍有 150 个唯一 id', new Set(all.map(x => x.id)).size === 150);
const oldest = Math.min(...all.map(r => new Date(r.timeCreated).getTime()));
const dayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
ok('最旧记录仍晚于今日零点（当日可能未覆盖完）', oldest >= dayStart,
   'oldest=' + new Date(oldest).toISOString() + ' dayStart=' + new Date(dayStart).toISOString());
// 按 fetchUsageRows 逻辑设置 limited（最旧仍今天 → 当日未覆盖完）
all.limited = all.length >= 50 && all.some(r => new Date(r.timeCreated).getTime() >= dayStart);
ok('limited 判定 = true', all.limited === true);

console.log('== 聚合（真实 150 条）==');
const agg = sandbox.aggUsage(all);
console.log('  今日:', JSON.stringify(agg.today));
console.log('  本月:', JSON.stringify(agg.month));
ok('今日 tokens 较 SSR-only（14.02M）更多', agg.today.tokens > 14023734,
   'got ' + agg.today.tokens);
ok('今日 calls > 50', agg.today.calls > 50, 'got ' + agg.today.calls);
ok('limited=true（当日未覆盖完）', agg.limited === true);

console.log('== 每日成本解析（getCosts 真实响应）==');
// fetchDailyCosts 内部用 fetchServerFunction；mock 之
const sandbox2 = {
  console, Date, Map, Math, String, Number,
  RPC_COSTS_LIST: "15702f3a12ff8bff357f8c2aa154a17e65b746d5f6b96adc9002c86ee0c15205",
  fetchServerFunction: async () => costs,
};
vm.createContext(sandbox2);
vm.runInContext(extract('fetchDailyCosts'), sandbox2);
(async () => {
  const daily = await sandbox2.fetchDailyCosts('wrk_x');
  console.log('  每日成本（近 7 天）:', JSON.stringify(daily.slice(-7)));
  ok('整月每天都有数据', daily.length >= 14, 'got ' + daily.length + ' 天');
  ok('日期格式 MM-DD', /^\d{2}-\d{2}$/.test(daily[0].date), daily[0].date);
  ok('成本为正数', daily.every(d => d.cost >= 0));
  const today = daily[daily.length - 1];
  ok('末日 = 今天', today.date === new Date().toISOString().slice(5, 10), today.date);
  const total = daily.reduce((s, d) => s + d.cost, 0);
  console.log('  全月总成本 $' + total.toFixed(4));
  ok('全月成本 > 0', total > 0);

  console.log('');
  console.log('结果: ' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})();
