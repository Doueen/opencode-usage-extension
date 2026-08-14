/* OpenCode 用量监控 · 后台 Service Worker
 * 每 30 秒抓取：opencode 官网配额（自动带登录态）+ DeepSeek 余额
 * 结果缓存到 chrome.storage.local，popup 打开时读取渲染
 */
const DEFAULT_WS = "";  // 不再硬编码私有 ID；用户在设置中填写自己的
const DS_BALANCE_API = "https://api.deepseek.com/user/balance";
const ALARM_NAME = "oc-usage-refresh";

async function getWsId() {
  const { oc_wsid } = await chrome.storage.local.get("oc_wsid");
  return (oc_wsid || "").trim();
}

/* ── 通过 content script 同源抓取（推荐：无 CORS、天然带登录态）── */
async function fetchQuotaViaContent(wsId) {
  const tabs = await chrome.tabs.query({ url: ["https://opencode.ai/*", "https://*.opencode.ai/*"] });
  for (const tab of tabs) {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: "oc_fetch_quota", wsid: wsId });
      if (resp && resp.ok && resp.quota) return resp.quota;
    } catch (e) { /* 该标签页无 content script，继续下一个 */ }
  }
  return null;
}

/* 自动打开 opencode 标签页承载 content script（首次抓取时） */
async function ensureContentTab(wsId) {
  const tabs = await chrome.tabs.query({ url: ["https://opencode.ai/*", "https://*.opencode.ai/*"] });
  if (tabs.length) return true;  // 已有标签页
  try {
    const url = wsId
      ? "https://opencode.ai/workspace/" + encodeURIComponent(wsId) + "/go"
      : "https://opencode.ai/";
    await chrome.tabs.create({ url, active: false });
    // 等 content script 注入
    await new Promise(r => setTimeout(r, 3000));
    return true;
  } catch (e) { return false; }
}

/* ── opencode 配额 ──
 * 主路径：credentials include（MV3 扩展对 host_permissions 域会自动携带 cookie，v1.0.0 实测可用）
 * 兜底：content script 同源抓取（无 CORS 问题）
 */
async function fetchQuota() {
  const wsId = await getWsId();
  if (!wsId) throw new Error("no_wsid");
  const wsUrl = "https://opencode.ai/workspace/" + encodeURIComponent(wsId) + "/go";

  // 主路径：简单 fetch + credentials include
  let res = await fetch(wsUrl, { credentials: "include" }).catch(() => null);

  // 兜底：主路径失败（302/网络）时走 content script 同源抓取
  if (!res || res.status === 302 || res.status === 401 || res.status === 403) {
    const viaContent = await fetchQuotaViaContent(wsId);
    if (viaContent) return viaContent;
    // content script 也没有 → 尝试自动开标签页
    const opened = await ensureContentTab(wsId);
    if (opened) {
      const retry = await fetchQuotaViaContent(wsId);
      if (retry) return retry;
    }
  }

  if (!res) throw new Error("not_logged_in");
  if (res.status === 302 || res.status === 401 || res.status === 403) throw new Error("not_logged_in");
  if (!res.ok) throw new Error("HTTP " + res.status);
  const html = await res.text();
  if (html.includes("Continue with GitHub") || html.includes("Continue with Google")) {
    throw new Error("not_logged_in");
  }

  const parseUsage = (kind) => {
    const m = html.match(new RegExp(kind + 'Usage:\\$R\\[\\d+\\]=\\{status:"[a-z]+",resetInSec:(\\d+),usagePercent:(\\d+)\\}'));
    return m ? { resetInSec: parseInt(m[1]), usagePercent: parseInt(m[2]) } : null;
  };
  const rolling = parseUsage("rolling");
  if (!rolling) throw new Error("parse_failed");
  const weekly = parseUsage("weekly");
  const monthly = parseUsage("monthly");
  const wsName = (html.match(/workspaceName:"([^"]+)"/) || [])[1] || "";
  const plan = (html.match(/planName:"([^"]+)"/) || [])[1] || "";
  return { rolling, weekly, monthly, workspaceName: wsName, plan, fetchedAt: Date.now() };
}

/* ── DeepSeek 余额 ── */
async function fetchBalance(key) {
  if (!key) return { available: false, error: "no_key" };
  const res = await fetch(DS_BALANCE_API, { headers: { Authorization: "Bearer " + key } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const d = await res.json();
  return {
    available: !!d.is_available,
    balances: (d.balance_infos || []).map(i => ({
      currency: i.currency, total: i.total_balance,
      granted: i.granted_balance, topped_up: i.topped_up_balance,
    })),
  };
}

/* ── 刷新主流程 ── */
async function refresh() {
  const out = { quota: null, balance: null, lastError: null, updatedAt: Date.now() };
  try { out.quota = await fetchQuota(); }
  catch (e) { out.lastError = "配额: " + e.message; }
  try {
    const { ds_key, ds_enabled } = await chrome.storage.local.get(["ds_key", "ds_enabled"]);
    if (ds_enabled === false) {
      // 用户关闭了 DeepSeek 余额显示：跳过抓取
      out.balance = { disabled: true };
    } else {
      out.balance = await fetchBalance(ds_key);
      if (!ds_key) out.lastError = (out.lastError ? out.lastError + "；" : "") + "未设置 DeepSeek Key";
    }
  } catch (e) { out.lastError = (out.lastError ? out.lastError + "；" : "") + "余额: " + e.message; }
  await chrome.storage.local.set({ oc_usage: out });
  if (out.quota && out.quota.monthly && typeof out.quota.monthly.usagePercent === "number") {
    const r = out.quota.monthly;
    await recordDailySample(r.usagePercent, typeof r.resetInSec === "number" ? r.resetInSec : null);
  }
  updateBadge(out.quota);
  return out;
}

/* ── 月度用量每日采样（每次刷新覆盖当日值）──
 * oc_monthly_trend: [{date:"08-05", monthly:28, month:"2026-08", resetInSec:1234567}, ...]
 * resetInSec: 采样时距月度配额重置的剩余秒数（趋势图用它计算真实剩余/预测，适配任意重置规则）
 * 保留最近 13 个月（跨月不清空），供趋势图按月周期绘制
 */
async function recordDailySample(monthlyPercent, resetInSec) {
  try {
    const { oc_monthly_trend } = await chrome.storage.local.get("oc_monthly_trend");
    const trend = Array.isArray(oc_monthly_trend) ? oc_monthly_trend : [];
    const now = new Date();
    const today = String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
    const monthKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    // 同月同日覆盖（当日只留一条采样）
    const idx = trend.findIndex(d => d.month === monthKey && d.date === today);
    let next;
    if (idx >= 0) {
      next = trend.slice();
      next[idx] = { ...next[idx], monthly: monthlyPercent, month: monthKey };
      if (resetInSec !== null && resetInSec !== undefined) next[idx].resetInSec = resetInSec;
    } else {
      const row = { date: today, monthly: monthlyPercent, month: monthKey };
      if (resetInSec !== null && resetInSec !== undefined) row.resetInSec = resetInSec;
      next = [...trend, row];
    }
    // 写入后再截断：只保留最近 13 个有数据的月份（防存储无限增长）
    const months = [...new Set(next.map(d => d.month).filter(Boolean))].sort().slice(-13);
    const keep = new Set(months);
    next = next.filter(d => !d.month || keep.has(d.month));
    next.sort((a, b) => (a.month + "-" + a.date).localeCompare(b.month + "-" + b.date));
    await chrome.storage.local.set({ oc_monthly_trend: next });
  } catch (e) { /* 采样失败不影响主流程 */ }
}

/* ── 工具栏角标：可配置显示内容 ──
 * oc_badge 配置：'rolling'|'weekly'|'monthly'|'rolling_remain'|'weekly_remain'|'off'
 */
async function updateBadge(quota) {
  try {
    const { oc_badge } = await chrome.storage.local.get("oc_badge");
    const mode = oc_badge || "rolling";
    if (!quota || !quota.rolling || mode === "off") {
      chrome.action.setBadgeText({ text: "" });
      return;
    }
    let pct = null;
    if (mode === "rolling") pct = quota.rolling.usagePercent;
    else if (mode === "weekly") pct = quota.weekly ? quota.weekly.usagePercent : null;
    else if (mode === "monthly") pct = quota.monthly ? quota.monthly.usagePercent : null;
    else if (mode === "rolling_remain") pct = 100 - quota.rolling.usagePercent;
    else if (mode === "weekly_remain") pct = quota.weekly ? 100 - quota.weekly.usagePercent : null;
    if (pct === null) { chrome.action.setBadgeText({ text: "" }); return; }
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    chrome.action.setBadgeText({ text: String(pct) + "%" });
    const color = pct > 80 ? "#e5484d" : pct > 50 ? "#ffb000" : "#12b886";
    chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) { /* badge 不可用时静默 */ }
}

/* ── alarms：MV3 最小周期 30s；自定义秒数存真实值，popup 打开时按真实秒刷新 ── */
async function setupAlarm() {
  const { oc_interval_sec } = await chrome.storage.local.get("oc_interval_sec");
  const sec = Math.max(parseInt(oc_interval_sec) || 30, 30);   // alarm 下限 30s
  const minutes = sec / 60;
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
  return sec;
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM_NAME) refresh(); });
chrome.runtime.onInstalled.addListener(async () => { await setupAlarm(); refresh(); });
chrome.runtime.onStartup.addListener(async () => { await setupAlarm(); refresh(); });

/* ═══ 实际用量明细（官网 server function 直调）═══
 * 协议（SolidStart 新版，2026-08 实测）：
 *   POST https://opencode.ai/_server  （URL 无参数）
 *   headers: x-server-id=<RPC hash> / x-server-instance=server-fn:N / Content-Type: application/json
 *   body: {"t":{"t":9,"i":0,"l":<n>,"a":[{"t":1,"s":"字符串"} | {"t":0,"s":数字}...],"o":0},"f":31,"m":[]}
 *   响应: ";0x<hex>;((self.$R=...)($R=>$R[0]=<JS 序列化数据>)(...))"，记录字段与 SSR 内嵌一致
 * RPC:
 *   usage.list  bfd684bf...  [wsid, page] 每页 50 条逐次调用明细（timeCreated/model/各 tokens/cost）
 *   costs.list  15702f3a...  [wsid, year, month(0-based), tzOffset("+08:00")] 每日成本（date/model/totalCost）
 * 本模块：翻页聚合当日全部 tokens；getCosts 取整月每日成本。popup 打开时按需拉取，5 分钟缓存。
 * 隔离新增：失败/未登录时静默降级，不影响既有配额抓取。
 */
const USAGE_DETAIL_TTL = 5 * 60 * 1000;  // 明细缓存 5 分钟（避免高频请求）
const USAGE_PAGE_SIZE = 50;
const USAGE_MAX_PAGES = 20;             // 翻页防呆上限（1000 条）
const RPC_USAGE_LIST = "bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c";
const RPC_COSTS_LIST = "15702f3a12ff8bff357f8c2aa154a17e65b746d5f6b96adc9002c86ee0c15205";

/* SolidStart 新协议：参数序列化 + RPC 调用，返回原始 JS 序列化文本 */
async function fetchServerFunction(rid, args) {
  const a = args.map(x => {
    if (typeof x === "string") return { t: 1, s: x };
    if (typeof x === "boolean") return { t: 2, s: x ? 1 : 0 };
    return { t: 0, s: x };
  });
  const body = { t: { t: 9, i: 0, l: a.length, a, o: 0 }, f: 31, m: [] };
  const res = await fetch("https://opencode.ai/_server", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "x-server-id": rid,
      "x-server-instance": "server-fn:0",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const txt = await res.text();
  if (!txt.includes("$R")) throw new Error("parse_failed");
  return txt;
}

/* 解析 usage.list 序列化文本 → 记录数组（正则逐条，与 SSR 字段顺序一致） */
function parseUsageRows(txt) {
  const rows = [];
  const re = /\{id:"usg_[^"]*",workspaceID:"[^"]*",timeCreated:\$R\[\d+\]=new Date\("([^"]+)"\),timeUpdated:\$R\[\d+\]=new Date\("[^"]+"\),timeDeleted:[^,]*,model:"([^"]*)",provider:"[^"]*",inputTokens:(\d+),outputTokens:(\d+),reasoningTokens:(\d+),cacheReadTokens:(\d+),cacheWrite5mTokens:(null|\d+),cacheWrite1hTokens:(null|\d+),cost:(\d+),keyID:"[^"]*",sessionID:"[^"]*",enrichment:\$R\[\d+\]=\{plan:"([^"]*)"\}/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    rows.push({
      id: m[0].match(/id:"(usg_[^"]+)"/)[1],
      timeCreated: m[1], model: m[2],
      inputTokens: +m[3], outputTokens: +m[4], reasoningTokens: +m[5],
      cacheReadTokens: +m[6],
      cacheWrite5mTokens: m[7] === "null" ? 0 : +m[7],
      cacheWrite1hTokens: m[8] === "null" ? 0 : +m[8],
      cost: +m[9], plan: m[10],
    });
  }
  // 兜底：字段顺序若被官网调整，宽松正则提取核心字段
  if (!rows.length) {
    const loose = /timeCreated:\$R\[\d+\]=new Date\("([^"]+)"\),[^}]*?inputTokens:(\d+),[^}]*?outputTokens:(\d+),[^}]*?cost:(\d+)/g;
    while ((m = loose.exec(txt)) !== null) {
      rows.push({ id: "", timeCreated: m[1], model: "", inputTokens: +m[2], outputTokens: +m[3],
                  reasoningTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
                  cost: +m[4], plan: "" });
    }
  }
  return rows;
}

/* 抓取全部调用明细：SSR 50 条（基础）+ 新协议翻页补全直到覆盖当日或上限 */
async function fetchUsageRows(wsId) {
  const usageUrl = "https://opencode.ai/workspace/" + encodeURIComponent(wsId) + "/usage";
  let res = await fetch(usageUrl, { credentials: "include" }).catch(() => null);
  if (!res || res.status === 302 || res.status === 401 || res.status === 403) throw new Error("not_logged_in");
  if (!res.ok) throw new Error("HTTP " + res.status);
  const html = await res.text();
  if (html.includes("Continue with GitHub") || html.includes("Continue with Google")) {
    throw new Error("not_logged_in");
  }
  // SSR 内嵌（第 0 页）→ 基础数据
  const rows = html.includes('id:"usg_') ? parseUsageRows(html) : [];

  // 翻页补全（新协议）：直到最旧记录早于今日零点 或 页不满 50 条 或 达上限
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const seen = new Set(rows.map(r => r.id).filter(Boolean));
  for (let page = 1; page < USAGE_MAX_PAGES; page++) {
    let txt;
    try { txt = await fetchServerFunction(RPC_USAGE_LIST, [wsId, page]); }
    catch (e) { break; }  // 翻页失败静默：SSR 数据仍可用
    const pageRows = parseUsageRows(txt);
    if (!pageRows.length) break;
    let oldestT = Infinity, added = 0;
    for (const r of pageRows) {
      if (r.id && seen.has(r.id)) continue;
      if (r.id) { seen.add(r.id); }
      rows.push(r); added++;
      const t = r.timeCreated ? new Date(r.timeCreated).getTime() : 0;
      if (t && t < oldestT) oldestT = t;
    }
    if (added === 0 || pageRows.length < USAGE_PAGE_SIZE || oldestT < dayStart) break;
  }
  rows.limited = rows.length >= USAGE_PAGE_SIZE &&
    rows.some(r => r.timeCreated && new Date(r.timeCreated).getTime() >= dayStart);
  return rows;
}

/* 每日成本（getCosts：整月 date/model/totalCost）→ 按日聚合 [{date:"08-01", cost:美元}] */
async function fetchDailyCosts(wsId) {
  const now = new Date();
  const tz = (() => {
    const off = -now.getTimezoneOffset();
    const s = (off >= 0 ? "+" : "-") + String(Math.abs(Math.floor(off / 60))).padStart(2, "0") +
              ":" + String(Math.abs(off % 60)).padStart(2, "0");
    return s;
  })();
  const txt = await fetchServerFunction(RPC_COSTS_LIST, [wsId, now.getFullYear(), now.getMonth(), tz]);
  const re = /\{date:"([^"]+)",model:"[^"]*",totalCost:(\d+),keyId:"[^"]*",plan:(null|"[^"]*")\}/g;
  const byDay = new Map();
  let m;
  while ((m = re.exec(txt)) !== null) {
    const cost = (+m[2]) / 1e8;
    byDay.set(m[1], (byDay.get(m[1]) || 0) + cost);
  }
  return [...byDay.entries()]
    .map(([date, cost]) => ({ date: date.slice(5), cost }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* 按 今日 / 本月 聚合 tokens 与费用（cost 原始单位 = 金额 × 1e8，与官网展示一致） */
function aggUsage(rows) {
  const now = new Date();
  const monthKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  const sum = {
    today:  { tokens: 0, cost: 0, calls: 0 },
    month:  { tokens: 0, cost: 0, calls: 0 },
    monthKey, sampledAt: Date.now(),
    limited: !!(rows && rows.limited),
  };
  for (const r of rows) {
    const t = r && r.timeCreated ? new Date(r.timeCreated) : null;
    if (!t || isNaN(t.getTime())) continue;
    const tokens = (r.inputTokens || 0) + (r.outputTokens || 0) + (r.reasoningTokens || 0) +
                   (r.cacheReadTokens || 0) + (r.cacheWrite5mTokens || 0) + (r.cacheWrite1hTokens || 0);
    const cost = (typeof r.cost === "number" && isFinite(r.cost)) ? r.cost / 1e8 : 0;
    const rowMonth = t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0");
    const isToday = rowMonth === monthKey && t.getDate() === now.getDate();
    if (isToday) { sum.today.tokens += tokens; sum.today.cost += cost; sum.today.calls++; }
    if (rowMonth === monthKey) { sum.month.tokens += tokens; sum.month.cost += cost; sum.month.calls++; }
  }
  return sum;
}

async function getUsageDetail() {
  const { oc_usage_detail, oc_wsid } = await chrome.storage.local.get(["oc_usage_detail", "oc_wsid"]);
  const wsId = (oc_wsid || "").trim();
  if (!wsId) return { error: "no_wsid", wsId: "", updatedAt: Date.now() };
  // 缓存新鲜（含失败结果，避免 popup 反复重试）→ 直接返回
  if (oc_usage_detail && oc_usage_detail.wsId === wsId && oc_usage_detail.updatedAt &&
      Date.now() - oc_usage_detail.updatedAt < USAGE_DETAIL_TTL) {
    return oc_usage_detail;
  }
  try {
    const rows = await fetchUsageRows(wsId);
    const out = Object.assign(aggUsage(rows), { wsId, updatedAt: Date.now() });
    // 每日成本（失败不影响主数据）
    try { out.dailyCosts = await fetchDailyCosts(wsId); }
    catch (e) { /* 每日成本可选 */ }
    await chrome.storage.local.set({ oc_usage_detail: out });
    return out;
  } catch (e) {
    const out = { error: e.message || String(e), wsId, updatedAt: Date.now() };
    await chrome.storage.local.set({ oc_usage_detail: out });
    return out;
  }
}

/* popup 打开时：读缓存立即渲染，再后台刷新一次 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "get_usage_detail") {
    getUsageDetail().then(sendResponse);
    return true;
  }
  if (msg.type === "get") {
    chrome.storage.local.get("oc_usage").then(d => sendResponse(d.oc_usage || null));
    return true;
  }
  if (msg.type === "refresh") {
    refresh().then(sendResponse);
    return true;
  }
  if (msg.type === "save_key") {
    chrome.storage.local.set({ ds_key: msg.key }).then(() => refresh()).then(sendResponse);
    return true;
  }
  if (msg.type === "set_interval") {
    const sec = Math.max(parseInt(msg.sec) || 30, 1);  // 保存真实秒数（≥1s）
    chrome.storage.local.set({ oc_interval_sec: sec }).then(setupAlarm).then(() => {
      updateBadgeRef();  // 刷新 badge（可能刚改了配置）
      sendResponse({ saved: sec });
    });
    return true;
  }
  if (msg.type === "get_interval") {
    setupAlarm().then(sendResponse);
    return true;
  }
  if (msg.type === "set_badge") {
    chrome.storage.local.set({ oc_badge: msg.mode }).then(() => {
      chrome.storage.local.get("oc_usage").then(d => updateBadge(d.oc_usage ? d.oc_usage.quota : null));
      sendResponse({ saved: msg.mode });
    });
    return true;
  }
  if (msg.type === "get_badge") {
    chrome.storage.local.get("oc_badge").then(d => sendResponse(d.oc_badge || "rolling"));
    return true;
  }
  /* 自动检测：从当前活动标签页的 opencode URL 提取工作区 ID */
  if (msg.type === "detect_ws") {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => {
      const tab = tabs[0];
      const url = tab && tab.url ? tab.url : "";
      const m = url.match(/opencode\.ai\/workspace\/(wrk_[A-Za-z0-9]+)/);
      sendResponse({ found: !!m, wsid: m ? m[1] : null, url });
    });
    return true;
  }
});

async function updateBadgeRef() {
  const { oc_usage } = await chrome.storage.local.get("oc_usage");
  updateBadge(oc_usage ? oc_usage.quota : null);
}
