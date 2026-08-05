/* OpenCode 用量监控 · popup 渲染逻辑 v3 */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

/* ═══ 设置弹出框 ═══ */
$("btn-settings").onclick = () => { $("modal").style.display = "flex"; };
$("btn-close").onclick = () => { $("modal").style.display = "none"; };
$("modal").addEventListener("click", e => { if (e.target === $("modal")) $("modal").style.display = "none"; });
document.addEventListener("keydown", e => { if (e.key === "Escape") $("modal").style.display = "none"; });

/* ═══ 更新频率（秒为单位，支持任意自定义值）═══ */
const FREQS = [30, 60, 300, 600, 1800];  // 快捷档位
const MIN_SEC = 1;                        // 允许的最小秒数（popup 内可用）

function fmtFreqLabel(s) {
  if (s < 60) return "每 " + s + " 秒";
  if (s % 60 === 0) {
    const m = s / 60;
    if (m < 60) return "每 " + m + " 分钟";
    return "每 " + (m / 60) + " 小时";
  }
  return "每 " + s + " 秒";
}
function setFreqSec(sec) {
  const s = Math.max(Math.round(parseFloat(sec)) || 30, MIN_SEC);
  document.querySelectorAll(".fbtn").forEach(b => b.classList.toggle("on", parseInt(b.dataset.f) === s));
  $("freq-label").textContent = fmtFreqLabel(s);
  chrome.runtime.sendMessage({ type: "set_interval", sec: s }, (resp) => {
    /* popup 打开期间按真实秒数刷新（后台 alarm 最低 30s 兜底） */
    if (window._fTimer) clearInterval(window._fTimer);
    window._fTimer = setInterval(refresh, s * 1000);
    chrome.storage.local.set({ oc_interval_sec: s });
  });
}
document.querySelectorAll(".fbtn").forEach(b => {
  b.onclick = () => setFreqSec(b.dataset.f);
});
/* 自定义秒数 */
$("freq-apply").onclick = () => {
  const v = parseInt($("freq-input").value);
  if (v && v >= MIN_SEC) setFreqSec(v);
};
$("freq-input").addEventListener("keydown", e => { if (e.key === "Enter") $("freq-apply").click(); });
function loadFreq() {
  chrome.storage.local.get("oc_interval_sec", ({ oc_interval_sec }) => {
    const s = parseInt(oc_interval_sec) >= MIN_SEC ? parseInt(oc_interval_sec) : 30;
    document.querySelectorAll(".fbtn").forEach(b => b.classList.toggle("on", parseInt(b.dataset.f) === s));
    $("freq-input").placeholder = "自定义秒数 (当前 " + s + ")";
    $("freq-label").textContent = fmtFreqLabel(s);
    if (window._fTimer) clearInterval(window._fTimer);
    window._fTimer = setInterval(refresh, s * 1000);
  });
}

/* ═══ Workspace ID 配置 ═══ */
function saveWs() {
  const id = $("ws-input").value.trim();
  if (!id) { $("ws-input").placeholder = "请输入工作区 ID"; return; }
  chrome.storage.local.set({ oc_wsid: id }, () => {
    $("ws-input").placeholder = "已保存: " + id;
    $("ws-input").value = "";
    updateGoLink(id);
    refresh();
  });
}
$("ws-save").onclick = saveWs;
$("ws-input").addEventListener("keydown", e => { if (e.key === "Enter") saveWs(); });
/* 自动检测：从当前 opencode 标签页提取 */
$("ws-detect").onclick = () => {
  $("ws-detect").textContent = "检测中...";
  chrome.runtime.sendMessage({ type: "detect_ws" }, (resp) => {
    if (resp && resp.found && resp.wsid) {
      chrome.storage.local.set({ oc_wsid: resp.wsid }, () => {
        $("ws-input").placeholder = "已保存: " + resp.wsid;
        updateGoLink(resp.wsid);
        refresh();
        $("ws-detect").textContent = "✓ 已自动填入 " + resp.wsid.slice(0, 12) + "...";
        setTimeout(() => { $("ws-detect").textContent = "自动检测"; }, 2500);
      });
    } else {
      $("ws-detect").textContent = "未找到，请先打开 opencode.ai 页面";
      setTimeout(() => { $("ws-detect").textContent = "自动检测"; }, 2500);
    }
  });
};
function loadWs() {
  chrome.storage.local.get("oc_wsid", ({ oc_wsid }) => {
    if (oc_wsid) $("ws-input").placeholder = "当前: " + oc_wsid;
    updateGoLink(oc_wsid);
  });
}

/* ═══ Badge 角标配置 ═══ */
const BADGE_MODES = ["rolling", "weekly", "monthly", "weekly_remain", "off"];
function setBadge(mode) {
  document.querySelectorAll(".bbtn").forEach(b => b.classList.toggle("on", b.dataset.b === mode));
  chrome.runtime.sendMessage({ type: "set_badge", mode });
}
document.querySelectorAll(".bbtn").forEach(b => {
  b.onclick = () => setBadge(b.dataset.b);
});
function loadBadge() {
  chrome.runtime.sendMessage({ type: "get_badge" }, mode => {
    const m = BADGE_MODES.includes(mode) ? mode : "rolling";
    document.querySelectorAll(".bbtn").forEach(b => b.classList.toggle("on", b.dataset.b === m));
  });
}

/* ═══ 主题切换 ═══ */
const THEMES = ["cyber", "matrix", "glass", "paper", "pixel"];
function applyTheme(t) {
  if (!THEMES.includes(t)) t = "cyber";
  document.body.dataset.theme = t;
  document.querySelectorAll(".tbtn").forEach(b => b.classList.toggle("on", b.dataset.t === t));
  chrome.storage.local.set({ oc_theme: t });
}
document.querySelectorAll(".tbtn").forEach(b => {
  b.onclick = () => applyTheme(b.dataset.t);
});

async function saveKey() {
  const key = $("key-input").value.trim();
  chrome.runtime.sendMessage({ type: "save_key", key }, () => {
    $("key-input").value = "";
    $("key-input").placeholder = key ? "已保存" : "已清除";
    refresh();
  });
}

/* ═══ 配额渲染（天/时/分倒计时）═══ */
function renderQuota(q) {
  const body = $("q-body");
  if (!q || !q.rolling) {
    body.innerHTML = '<div class="hint">配额数据不可用（未登录 opencode 或已过期）</div>';
    $("q-ws").textContent = "-";
    return;
  }
  $("q-ws").textContent = q.workspaceName || "";
  const rows = [
    ["滚动周期", q.rolling],
    ["周周期", q.weekly],
    ["月周期", q.monthly],
  ];
  const nowS = Math.floor(Date.now() / 1000);
  const fetchedS = Math.floor((q.fetchedAt || Date.now()) / 1000);
  const fmtDur = (sec) => {
    sec = Math.max(sec, 0);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d > 0) return d + "天 " + h + "小时 " + m + "分";
    if (h > 0) return h + "小时 " + m + "分";
    if (m > 0) return m + "分 " + s + "秒";
    return s + "秒";
  };
  body.innerHTML = rows.map(([name, u]) => {
    const pct = u ? u.usagePercent : 0;
    const remain = (u ? u.resetInSec : 0) - (nowS - fetchedS);
    return '<div class="qrow">' +
      '<span class="qname">' + name + '</span>' +
      '<span class="qval">' + pct + '%</span>' +
      '<div class="qbar"><i style="transform:scaleX(' + Math.min(pct / 100, 1) + ')"' + (pct > 80 ? ' class="warn"' : '') + '></i></div>' +
      '<span class="qreset">' + fmtDur(remain) + ' 后重置</span>' +
      '</div>';
  }).join("");
  /* 状态点：任一周期 >80% 预警 */
  const warn = rows.some(([, u]) => u && u.usagePercent > 80);
  const dot = $("status-dot");
  dot.classList.toggle("warn", warn);
  dot.classList.remove("err");
}

/* ═══ 余额渲染（数字滚动动画）═══ */
let lastBalance = null;
function animateNum(el, from, to, dur = 700) {
  const start = performance.now();
  const step = (t) => {
    const p = Math.min((t - start) / dur, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = "¥" + (from + (to - from) * ease).toFixed(2);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function renderBalance(b, hasKey) {
  const body = $("ds-body"), st = $("ds-st");
  if (!b) { body.innerHTML = '<div class="hint">余额获取失败</div>'; st.textContent = "ERR"; return; }
  if (b.error === "no_key" || !hasKey) {
    body.innerHTML = '<div class="hint">可选：在设置中填写 DeepSeek API Key 后显示余额</div>';
    st.textContent = "OPTIONAL";
    return;
  }
  if (!b.balances || !b.balances.length) { body.innerHTML = '<div class="hint">无余额数据</div>'; st.textContent = "ERR"; return; }
  st.textContent = b.available ? "OK" : "OFF";
  const x = b.balances[0];
  const prev = (lastBalance && lastBalance.balances && lastBalance.balances[0]) ? parseFloat(lastBalance.balances[0].total) || 0 : null;
  const cur = parseFloat(x.total) || 0;
  body.innerHTML =
    '<div class="brow"><span class="bcur">' + esc(x.currency) + ' 总余额</span><span class="bamt" id="bamt"></span></div>' +
    '<div class="bsub">充值 ' + esc(x.topped_up) + ' · 赠送 ' + esc(x.granted) + '</div>';
  const el = $("bamt");
  if (prev !== null && prev !== cur) animateNum(el, prev, cur);
  else el.textContent = "¥" + cur.toFixed(2);
  lastBalance = b;
}

/* 友好错误提示（未登录/未配置） */
function friendlyError(err) {
  if (!err) return "";
  if (err.includes("no_wsid")) return '<div class="errbox">⚠ 未设置工作区 ID：点 ⚙ 设置 → WORKSPACE 填入你的 OpenCode 工作区 ID</div>';
  if (err.includes("not_logged_in")) return '<div class="errbox">⚠ 未登录 opencode.ai：请先在浏览器中登录 opencode 官网</div>';
  return '<div class="errbox">⚠ ' + esc(err) + '</div>';
}

/* ═══ 总渲染 ═══ */
function render(data) {
  $("time").textContent = new Date().toTimeString().slice(0, 8);
  $("status").textContent = data && data.updatedAt
    ? "更新于 " + new Date(data.updatedAt).toTimeString().slice(0, 8)
    : "等待数据...";
  if (data && data.lastError) {
    $("status-dot").classList.add("err");
  }
  renderQuota(data ? data.quota : null);
  chrome.storage.local.get("ds_key").then(({ ds_key }) => {
    renderBalance(data ? data.balance : null, !!ds_key);
  });
  const err = friendlyError(data && data.lastError);
  $("errbox").innerHTML = err;
}

function refresh() {
  chrome.runtime.sendMessage({ type: "refresh" }, render);
}

$("key-save").onclick = saveKey;
$("key-input").addEventListener("keydown", e => { if (e.key === "Enter") saveKey(); });

/* 官网完整用量页入口（动态 Workspace ID） */
function updateGoLink(wsId) {
  const id = (wsId || "").trim();
  $("go-site").href = id
    ? "https://opencode.ai/workspace/" + encodeURIComponent(id) + "/usage"
    : "https://opencode.ai/workspace";
  $("go-site").querySelector("b").textContent = id ? "Go" : "→ 打开官网";
}

/* 恢复上次主题 */
chrome.storage.local.get("oc_theme", ({ oc_theme }) => applyTheme(oc_theme || "cyber"));

/* 恢复 Workspace ID */
loadWs();

/* 恢复上次更新频率 */
loadFreq();

/* 恢复上次 Badge 配置 */
loadBadge();

/* 打开即读缓存 → 再刷新 */
chrome.runtime.sendMessage({ type: "get" }, data => {
  render(data);
  refresh();
});
