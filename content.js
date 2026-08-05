/* OpenCode 用量监控 · Content Script
 * 运行在 opencode.ai 页面上下文中：同源 fetch 天然带登录态 cookie、无 CORS 限制
 * background 通过 tabs.sendMessage 调用这里抓取配额数据
 */
(function () {
  if (window.__ocUsageInjected) return;
  window.__ocUsageInjected = true;

  /* 解析 SSR 页面中的配额数据（与 background 逻辑一致） */
  function parseQuota(html) {
    const parseUsage = (kind) => {
      const m = html.match(new RegExp(kind + 'Usage:\\$R\\[\\d+\\]=\\{status:"[a-z]+",resetInSec:(\\d+),usagePercent:(\\d+)\\}'));
      return m ? { resetInSec: parseInt(m[1]), usagePercent: parseInt(m[2]) } : null;
    };
    const rolling = parseUsage("rolling");
    if (!rolling) return null;
    const weekly = parseUsage("weekly");
    const monthly = parseUsage("monthly");
    const wsName = (html.match(/workspaceName:"([^"]+)"/) || [])[1] || "";
    const plan = (html.match(/planName:"([^"]+)"/) || [])[1] || "";
    return { rolling, weekly, monthly, workspaceName: wsName, plan, fetchedAt: Date.now() };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "oc_fetch_quota") {
      const wsId = (msg.wsid || "").trim();
      if (!wsId) { sendResponse({ ok: false, error: "no_wsid" }); return; }
      const wsUrl = "https://opencode.ai/workspace/" + encodeURIComponent(wsId) + "/go";
      fetch(wsUrl, { credentials: "include" })
        .then(r => {
          if (r.status === 302 || r.status === 401 || r.status === 403) throw new Error("not_logged_in");
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.text();
        })
        .then(html => {
          if (html.includes("Continue with GitHub") || html.includes("Continue with Google")) {
            sendResponse({ ok: false, error: "not_logged_in" });
            return;
          }
          const quota = parseQuota(html);
          if (quota) sendResponse({ ok: true, quota });
          else sendResponse({ ok: false, error: "parse_failed" });
        })
        .catch(e => sendResponse({ ok: false, error: e.message || String(e) }));
      return true; // 异步响应
    }
  });
})();
