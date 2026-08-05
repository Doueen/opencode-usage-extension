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

/* 通过 chrome.cookies 读取 opencode 登录态（SW fetch 不带 cookie，必须手动附加） */
async function getAuthCookie() {
  let cookies = [];
  // 策略1：子域通配（匹配 .opencode.ai 及其所有子域）
  try {
    cookies = await chrome.cookies.getAll({ domain: ".opencode.ai" });
  } catch (e) { /* 权限不足时忽略 */ }
  // 策略2：精确站点（auth.opencode.ai 是登录域）
  if (!cookies.length) {
    try {
      cookies = await chrome.cookies.getAll({ url: "https://opencode.ai/" });
      if (!cookies.some(c => c.domain.includes("opencode"))) {
        const authCs = await chrome.cookies.getAll({ url: "https://auth.opencode.ai/" });
        cookies = cookies.concat(authCs);
      }
    } catch (e) { /* 忽略 */ }
  }
  // 过滤出有值的 auth/session cookie
  const relevant = cookies.filter(c => c.value && (c.name === "auth" || c.name.includes("session") || c.name.includes("token")));
  const source = relevant.length ? relevant : cookies;
  const joined = source.map(c => c.name + "=" + c.value).join("; ");
  // 调试：记录是否拿到 auth cookie
  if (!source.some(c => c.name === "auth")) {
    console.warn("[oc-usage] 未找到 auth cookie，拿到:", source.map(c => c.name).join(",") || "无");
  }
  return joined;
}

/* ── opencode 配额 ── */
async function fetchQuota() {
  const wsId = await getWsId();
  if (!wsId) throw new Error("no_wsid");
  const wsUrl = "https://opencode.ai/workspace/" + encodeURIComponent(wsId) + "/go";

  // 尝试1：手动附加 cookie 头
  const cookie = await getAuthCookie();
  let res = null;
  if (cookie) {
    res = await fetch(wsUrl, {
      credentials: "omit",
      headers: { "Cookie": cookie, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0" },
    });
  }
  // 尝试2：回退 credentials include（扩展对 host_permissions 域可能自动带 cookie）
  if (!res || res.status === 302 || res.status === 401 || res.status === 403) {
    const res2 = await fetch(wsUrl, { credentials: "include" }).catch(() => null);
    if (res2 && res2.ok) res = res2;
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
    return m ? { resetInSec: +m[1], usagePercent: +m[2] } : null;
  };

  const quota = {
    rolling: parseUsage("rolling"),
    weekly: parseUsage("weekly"),
    monthly: parseUsage("monthly"),
    fetchedAt: Date.now(),
  };
  const wm = html.match(/name:"([^"]+)",slug:null/);
  if (wm) quota.workspaceName = wm[1];
  const pm = html.match(/paymentMethodType:"([a-z]+)"/);
  if (pm) quota.paymentMethod = pm[1];
  return quota;
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
    const { ds_key } = await chrome.storage.local.get("ds_key");
    out.balance = await fetchBalance(ds_key);
    if (!ds_key) out.lastError = (out.lastError ? out.lastError + "；" : "") + "未设置 DeepSeek Key";
  } catch (e) { out.lastError = (out.lastError ? out.lastError + "；" : "") + "余额: " + e.message; }
  await chrome.storage.local.set({ oc_usage: out });
  updateBadge(out.quota);
  return out;
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
