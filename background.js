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
    await recordDailySample(out.quota.monthly.usagePercent);
  }
  updateBadge(out.quota);
  return out;
}

/* ── 月度用量每日采样（每次刷新覆盖当日值）──
 * oc_monthly_trend: [{date:"08-05", monthly:28, month:"2026-08"}, ...]
 * 保留最近 13 个月（跨月不清空），供趋势图按月周期绘制
 */
async function recordDailySample(monthlyPercent) {
  try {
    const { oc_monthly_trend } = await chrome.storage.local.get("oc_monthly_trend");
    const trend = Array.isArray(oc_monthly_trend) ? oc_monthly_trend : [];
    const now = new Date();
    const today = String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
    const monthKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    // 只保留最近 13 个有数据的月份（防存储无限增长）
    const months = [...new Set(trend.map(d => d.month).filter(Boolean))].sort().slice(-13);
    const keep = new Set(months);
    const filtered = trend.filter(d => !d.month || keep.has(d.month));
    // 同月同日覆盖（当日只留一条采样）
    const idx = filtered.findIndex(d => d.month === monthKey && d.date === today);
    if (idx >= 0) {
      filtered[idx].monthly = monthlyPercent;
      filtered[idx].month = monthKey;
    } else {
      filtered.push({ date: today, monthly: monthlyPercent, month: monthKey });
    }
    filtered.sort((a, b) => (a.month + "-" + a.date).localeCompare(b.month + "-" + b.date));
    await chrome.storage.local.set({ oc_monthly_trend: filtered });
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

/* popup 打开时：读缓存立即渲染，再后台刷新一次 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
