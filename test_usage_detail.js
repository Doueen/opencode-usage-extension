#!/usr/bin/env node
/* 单测：background.js 的 aggUsage / fetchUsageRows 边界 + popup.js 的 fmtTokens / renderDetail
 * 从源文件提取函数（vm 求值），不 mock chrome API —— 只测纯函数 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const DIR = '/root/notes/research/edge-extension';
const bgSrc = fs.readFileSync(path.join(DIR, 'background.js'), 'utf8');
const popupSrc = fs.readFileSync(path.join(DIR, 'popup.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

/* ── 提取并求值 background.js 的纯函数 ── */
function extract(src, fnName) {
  const re = new RegExp('function\\s+' + fnName + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('函数未找到: ' + fnName);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(m[0], sandbox);
  return sandbox[fnName];
}

const aggUsage = extract(bgSrc, 'aggUsage');
const fmtTokens = extract(popupSrc, 'fmtTokens');
const renderDetail = extract(popupSrc, 'renderDetail');

/* ── mock DOM：renderDetail 需要 document.getElementById ── */
const el = { innerHTML: '', textContent: '' };
const fakeDoc = { getElementById: () => el };
vm.createContext(globalThis); // 复用全局
vm.runInContext('globalThis.__doc = ' + JSON.stringify({}) , vm.createContext({}));

console.log('== aggUsage：日期归属与聚合 ==');
const now = new Date();
const todayISO = now.toISOString();
const yesterday = new Date(now.getTime() - 86400e3).toISOString();
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString();
const rows = [
  { timeCreated: todayISO, inputTokens: 1000, outputTokens: 500, cost: 3e8 },
  { timeCreated: todayISO, inputTokens: 200, outputTokens: 300, reasoningTokens: 100, cost: 6e7 },
  { timeCreated: yesterday, inputTokens: 9999, outputTokens: 1, cost: 1e8 },
  { timeCreated: lastMonth, inputTokens: 88888, outputTokens: 2, cost: 5e7 },
  { timeCreated: 'garbage', inputTokens: 1, cost: 1 },
];
const agg = aggUsage(rows);
ok('今日 tokens = 2100', agg.today.tokens === 2100, 'got ' + agg.today.tokens);
ok('今日费用 = 3.6（3e8+6e7 /1e8）', Math.abs(agg.today.cost - 3.6) < 1e-9, 'got ' + agg.today.cost);
ok('今日调用 = 2', agg.today.calls === 2, 'got ' + agg.today.calls);
ok('本月 tokens 含今天+昨天、不含上月 = 12100', agg.month.tokens === 2100 + 10000, 'got ' + agg.month.tokens);
ok('本月费用 = 4.6', Math.abs(agg.month.cost - 4.6) < 1e-9, 'got ' + agg.month.cost);
ok('本月调用 = 3（脏行不计）', agg.month.calls === 3, 'got ' + agg.month.calls);
ok('monthKey 格式 yyyy-mm', /^\d{4}-\d{2}$/.test(agg.monthKey), agg.monthKey);
ok('空数组安全', aggUsage([]).today.tokens === 0);
ok('null 行安全', aggUsage([null, undefined]).month.calls === 0);

console.log('== aggUsage：cache 字段计入 ==');
const cacheRow = [{ timeCreated: todayISO, cacheReadTokens: 5000, cacheWrite5mTokens: 500, outputTokens: 10 }];
const agg2 = aggUsage(cacheRow);
ok('cacheRead+Write+output = 5510', agg2.today.tokens === 5510, 'got ' + agg2.today.tokens);

console.log('== fmtTokens ==');
ok('0 → "0"', fmtTokens(0) === '0');
ok('999 → "999"', fmtTokens(999) === '999');
ok('1000 → "1.0K"', fmtTokens(1000) === '1.0K', fmtTokens(1000));
ok('1234567 → "1.23M"', fmtTokens(1234567) === '1.23M', fmtTokens(1234567));
ok('2.5e9 → "2.50B"', fmtTokens(2.5e9) === '2.50B', fmtTokens(2.5e9));
ok('负数容错', fmtTokens(-5) === '0' || fmtTokens(-5) === '-5');

console.log('== renderDetail（mock DOM）==');
const _els = {};
const mockDoc = { getElementById: (id) => (_els[id] = _els[id] || { innerHTML: '', textContent: '' }) };
const sandbox2 = { document: mockDoc, Date, Math, Number, String, esc: s => String(s ?? '') };
vm.createContext(sandbox2);
vm.runInContext('const $ = id => document.getElementById(id);', sandbox2);
vm.runInContext('const fmtTokens = ' + fmtTokens.toString() + ';', sandbox2);
const renderDailyCosts = extract(popupSrc, 'renderDailyCosts');
vm.runInContext('const renderDailyCosts = ' + renderDailyCosts.toString() + ';', sandbox2);
vm.runInContext(renderDetail.toString(), sandbox2);
const dBody = mockDoc.getElementById('detail-body'), dSt = mockDoc.getElementById('detail-st');
const callRender = (d) => vm.runInContext('renderDetail(' + JSON.stringify(d) + ')', sandbox2);
callRender({ today: { tokens: 1234, cost: 0.42, calls: 7 }, month: { tokens: 2.5e6, cost: 88.1234, calls: 150 }, monthKey: '2026-08', updatedAt: Date.now() });
ok('渲染包含 今日 行', dBody.innerHTML.includes('今日'), dBody.innerHTML.slice(0, 80));
ok('渲染包含 本月 行', dBody.innerHTML.includes('本月'));
ok('今日 tokens 缩写 1.2K', dBody.innerHTML.includes('1.2K'), dBody.innerHTML.match(/今日.{0,80}/)?.[0]);
ok('本月 tokens 缩写 2.50M', dBody.innerHTML.includes('2.50M'), dBody.innerHTML.match(/本月.{0,80}/)?.[0]);
ok('费用 4 位小数', dBody.innerHTML.includes('0.4200') && dBody.innerHTML.includes('88.1234'));
ok('状态 OK', dSt.textContent === 'OK', dSt.textContent);
callRender({ error: 'no_wsid', updatedAt: Date.now() });
ok('no_wsid → 提示文案', dBody.innerHTML.includes('设置工作区 ID'), dBody.innerHTML.slice(0, 80));
ok('no_wsid → 状态 —', dSt.textContent === '—');
callRender({ error: 'HTTP 401', updatedAt: Date.now() });
ok('错误 → 显示错误', dBody.innerHTML.includes('HTTP 401'));
ok('错误 → 状态 ERR', dSt.textContent === 'ERR');
callRender(null);
ok('null → 获取中', dBody.innerHTML.includes('获取中'));

console.log('');
console.log('结果: ' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
