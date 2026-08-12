/* 月度用量趋势页：读采样数据 → SVG 折线 → 预测
 * 月周期视图：≥2 个月数据时，X 轴按月绘制各月用量（该月最近一次采样）
 * 单月视图：只有 1 个月数据时，退化为当月逐日曲线
 */
(() => {
  const $ = id => document.getElementById(id);

  /* 主题适配（与 popup 共用主题名） */
  const THEMES = {
    matrix:    { bg:"#050a05", c1:"#00ff9c", panel:"#0a140a" },
    glass:     { bg:"#0d0d1a", c1:"#00e5ff", panel:"#1a0b2e" },
    paper:     { bg:"#f7f4ec", c1:"#c0392b", panel:"#fdfbf4" },
    pixel:     { bg:"#1a1a2e", c1:"#00ff88", panel:"#232347" },
    cyberpunk: { bg:"#0f1420", c1:"#ff2e88", panel:"#1a1f2e" },
  };

  async function main() {
    const { oc_monthly_trend, oc_theme } = await chrome.storage.local.get(["oc_monthly_trend", "oc_theme"]);
    const theme = THEMES[oc_theme] || THEMES.glass;
    applyTheme(theme);

    const trendRaw = Array.isArray(oc_monthly_trend) ? oc_monthly_trend : [];
    // 防御：过滤掉 monthly 不是数字的脏记录（曾误存整个 usage 对象），并兼容对象形态
    const trend = trendRaw
      .map(d => ({
        date: d.date,
        month: d.month || "",
        monthly: typeof d.monthly === "number" ? d.monthly
               : (d.monthly && typeof d.monthly.usagePercent === "number" ? d.monthly.usagePercent : NaN),
      }))
      .filter(d => Number.isFinite(d.monthly) && d.month);
    if (trend.length < 1) { $("empty").style.display = "block"; return; }

    // 按月份分组（升序）
    const months = [...new Set(trend.map(d => d.month))].sort();
    const curMonth = months[months.length - 1];
    $("month-tag").textContent = curMonth.replace("-", " 年 ") + " 月";

    // 当月数据（用于预测卡）
    const curRows = trend.filter(d => d.month === curMonth).sort((a, b) => a.date.localeCompare(b.date));
    const current = curRows[curRows.length - 1].monthly;

    // 预测计算（当月线性外推）
    const now = new Date();
    const daysInMonth = daysInOf(curMonth, now);
    const today = now.getDate();
    const elapsed = Math.max(today, 1);
    const daily = current / elapsed;
    const remain = daysInMonth - today;
    const eom = Math.round(current + daily * remain);

    renderPred(current, daily, eom);

    // 月周期视图：≥2 个月；单月退化为当月逐日曲线
    if (months.length >= 2) renderMonthly(trend, months);
    else renderDaily(trend, curMonth, daysInMonth, eom);
  }

  /* 某个月份的天数（历史月份也正确，不依赖 now） */
  function daysInOf(monthKey, now) {
    const m = monthKey ? monthKey.match(/^(\d{4})-(\d{2})$/) : null;
    if (m) return new Date(+m[1], +m[2], 0).getDate();
    return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  }

  function applyTheme(t) {
    const r = document.documentElement.style;
    r.setProperty("--bg", t.bg);
    r.setProperty("--c1", t.c1);
    r.setProperty("--panel", t.panel);
  }

  function renderPred(current, daily, eom) {
    $("pred-row").style.display = "grid";
    const fmt = n => (n > 999 ? Math.round(n) : Math.round(n * 10) / 10);
    $("p-current").innerHTML = `<div class="lbl">当前用量</div><div class="val">${fmt(current)}<small>%</small></div>`;
    $("p-daily").innerHTML = `<div class="lbl">日均消耗</div><div class="val">+${fmt(daily)}<small>%/天</small></div>`;
    const eomEl = $("p-eom");
    eomEl.innerHTML = `<div class="lbl">预测月底</div><div class="val">${fmt(eom)}<small>%</small></div>`;
    eomEl.className = "pred " + (eom < 80 ? "ok" : eom <= 100 ? "warn" : "danger");
    $("p-current").className = "pred " + (current < 80 ? "ok" : current <= 100 ? "warn" : "danger");
  }

  /* ── 月周期视图：X 轴 = 月份，每月的点 = 该月最近一次采样 ── */
  function renderMonthly(trend, months) {
    const svg = $("chart");
    const W = 520, H = 220, PAD_L = 40, PAD_R = 16, PAD_T = 14, PAD_B = 26;
    const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;

    // 每月取最后一条采样（该月用量）
    const pts = months.map(m => {
      const rows = trend.filter(d => d.month === m).sort((a, b) => a.date.localeCompare(b.date));
      return { month: m, value: rows[rows.length - 1].monthly, days: rows.length };
    });

    const now = new Date();
    const curKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    const lastIsCur = pts[pts.length - 1].month === curKey;

    const values = pts.map(p => p.value);
    const maxV = Math.max(100, ...values);
    const yMax = Math.ceil(maxV / 20) * 20; // 对齐 20% 刻度
    const n = pts.length;

    const xOf = i => PAD_L + (i / (n - 1)) * iw;
    const yOf = v => PAD_T + ih - (v / yMax) * ih;

    // 网格线 + Y 轴标签
    let grid = "";
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const v = yMax / steps * i;
      const y = yOf(v);
      grid += `<line class="grid" x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}"/>`;
      grid += `<text class="axis-lbl" x="${PAD_L - 6}" y="${y + 3}" text-anchor="end">${Math.round(v)}%</text>`;
    }
    // X 轴
    grid += `<line class="axis" x1="${PAD_L}" y1="${PAD_T + ih}" x2="${W - PAD_R}" y2="${PAD_T + ih}"/>`;
    // 月份刻度（≤8 个月全标；更多则隔月标，末尾两月必标）
    const labelEvery = n <= 8 ? 1 : 2;
    pts.forEach((p, i) => {
      if (i % labelEvery === 0 || n - i <= 2) {
        const lbl = parseInt(p.month.split("-")[1], 10) + "月";
        grid += `<text class="day-lbl" x="${xOf(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${lbl}</text>`;
      }
    });

    const danger = Math.max(...values) > 100;
    const lineColor = danger ? "var(--danger)" : "var(--c1)";

    // 折线 + 面积
    const ptsStr = pts.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(" ");
    const areaPts = `${ptsStr} ${xOf(n - 1).toFixed(1)},${PAD_T + ih} ${xOf(0).toFixed(1)},${PAD_T + ih}`;

    // 当月点：高亮描边 + 「本月」小标注
    let marks = "";
    if (lastIsCur) {
      const cx = xOf(n - 1), cy = yOf(pts[n - 1].value);
      marks += `<circle class="dot last" cx="${cx}" cy="${cy}" r="4.5"/>`;
      marks += `<text class="day-lbl" x="${cx}" y="${cy - 9}" text-anchor="middle" style="fill:var(--c1)">本月</text>`;
    }

    svg.innerHTML =
      `<style>.line{stroke:${lineColor}}</style>` +
      grid +
      `<polygon class="area" points="${areaPts}"/>` +
      `<polyline class="line" points="${ptsStr}"/>` +
      pts.map((p, i) => `<circle class="dot" cx="${xOf(i).toFixed(1)}" cy="${yOf(p.value).toFixed(1)}" r="3"/>`).join("") +
      marks +
      pts.map((p, i) => `<circle data-month="${p.month}" data-val="${p.value}" data-days="${p.days}" cx="${xOf(i).toFixed(1)}" cy="${yOf(p.value).toFixed(1)}" r="9" fill="transparent" style="cursor:pointer"/>`).join("");

    $("chart-range").textContent = `${pts[0].month} ~ ${pts[n - 1].month} · 近 ${n} 个月`;

    // hover tooltip
    const tip = $("tooltip");
    const box = $("chart-box");
    svg.querySelectorAll("[data-month]").forEach(c => {
      c.addEventListener("mousemove", e => {
        const rect = box.getBoundingClientRect();
        tip.style.display = "block";
        tip.style.left = (e.clientX - rect.left + 10) + "px";
        tip.style.top = (e.clientY - rect.top - 10) + "px";
        const ym = c.dataset.month.replace("-", " 年 ") + " 月";
        const isCur = c.dataset.month === curKey;
        tip.innerHTML = `<b>${ym}</b> · 月用量 ${c.dataset.val}%${isCur ? "（本月·进行中）" : ""}`;
      });
      c.addEventListener("mouseleave", () => tip.style.display = "none");
    });
  }

  /* ── 单月视图：当月逐日曲线（原逻辑，X 按真实日期） ── */
  function renderDaily(trend, monthKey, daysInMonth, eom) {
    const svg = $("chart");
    const W = 520, H = 220, PAD_L = 40, PAD_R = 16, PAD_T = 14, PAD_B = 26;
    const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;

    const values = trend.map(d => d.monthly);
    const maxV = Math.max(100, ...values, eom || 0);
    const yMax = Math.ceil(maxV / 20) * 20; // 对齐 20% 刻度
    const n = trend.length;

    // X 坐标：按日期在当月的位置（比均匀分布更真实）
    const xOf = d => {
      const day = parseInt(d.date.split("-")[1], 10);
      return PAD_L + (day - 1) / (daysInMonth - 1) * iw;
    };
    const yOf = v => PAD_T + ih - (v / yMax) * ih;

    // 网格线 + Y 轴标签
    let grid = "";
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const v = yMax / steps * i;
      const y = yOf(v);
      grid += `<line class="grid" x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}"/>`;
      grid += `<text class="axis-lbl" x="${PAD_L - 6}" y="${y + 3}" text-anchor="end">${Math.round(v)}%</text>`;
    }
    // X 轴
    grid += `<line class="axis" x1="${PAD_L}" y1="${PAD_T + ih}" x2="${W - PAD_R}" y2="${PAD_T + ih}"/>`;
    // 日期刻度（1/5/10/15/20/25/月末）
    const marks = [1, 5, 10, 15, 20, 25, daysInMonth];
    marks.forEach(d => {
      const x = PAD_L + (d - 1) / (daysInMonth - 1) * iw;
      grid += `<text class="day-lbl" x="${x}" y="${H - 8}" text-anchor="middle">${d}</text>`;
    });

    // 折线 + 点
    const pts = trend.map(d => `${xOf(d).toFixed(1)},${yOf(d.monthly).toFixed(1)}`);
    const danger = eom > 100;
    const lineColor = danger ? "var(--danger)" : "var(--c1)";
    // 预测延伸段（虚线）
    let predict = "";
    if (eom > 0 && trend.length >= 2) {
      const last = trend[trend.length - 1];
      const lx = xOf(last), ly = yOf(last.monthly);
      const ex = PAD_L + (daysInMonth - 1) / (daysInMonth - 1) * iw;
      const ey = yOf(Math.min(eom, yMax));
      predict = `<line x1="${lx}" y1="${ly}" x2="${ex}" y2="${ey}" stroke="${lineColor}" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.6"/>`;
      // 预测终点圈
      predict += `<circle cx="${ex}" cy="${ey}" r="4" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-dasharray="2 2"/>`;
    }

    const areaPts = pts.length ? `${pts.join(" ")} ${xOf(trend[n-1]).toFixed(1)},${PAD_T + ih} ${xOf(trend[0]).toFixed(1)},${PAD_T + ih}` : "";
    svg.innerHTML =
      `<style>.line{stroke:${lineColor}}</style>` +
      grid +
      (areaPts ? `<polygon class="area" points="${areaPts}"/>` : "") +
      predict +
      (pts.length ? `<polyline class="line" points="${pts.join(" ")}"/>` : "") +
      pts.map((p, i) => `<circle class="dot${i === n-1 ? " last" : ""}" cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="3"/>`).join("") +
      pts.map((p, i) => `<circle data-day="${trend[i].date}" data-val="${trend[i].monthly}" cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="9" fill="transparent" style="cursor:pointer"/>`).join("");

    $("chart-range").textContent = `${trend[0].date} ~ ${trend[n-1].date} (${n} 天)`;

    // hover tooltip
    const tip = $("tooltip");
    const box = $("chart-box");
    svg.querySelectorAll("[data-day]").forEach(c => {
      c.addEventListener("mousemove", e => {
        const rect = box.getBoundingClientRect();
        tip.style.display = "block";
        tip.style.left = (e.clientX - rect.left + 10) + "px";
        tip.style.top = (e.clientY - rect.top - 10) + "px";
        tip.innerHTML = `<b>${c.dataset.day}</b> · 月用量 ${c.dataset.val}%`;
      });
      c.addEventListener("mouseleave", () => tip.style.display = "none");
    });
  }

  document.addEventListener("DOMContentLoaded", main);
  $("btn-back").addEventListener("click", e => {
    e.preventDefault();
    if (window.history.length > 1) window.history.back();
    else window.close();
  });
})();
