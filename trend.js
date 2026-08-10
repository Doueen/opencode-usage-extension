/* 月度用量趋势页：读采样数据 → SVG 折线 → 预测 */
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

    const trend = Array.isArray(oc_monthly_trend) ? oc_monthly_trend : [];
    if (trend.length < 1) { $("empty").style.display = "block"; return; }

    // 月份标签
    const month = trend[0].month || "";
    $("month-tag").textContent = month ? month.replace("-", " 年 ") + " 月" : "当月";

    // 预测计算
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const current = trend[trend.length - 1].monthly;
    // 用首条记录的日期推断已过天数（用当天日期更准）
    const today = now.getDate();
    const elapsed = Math.max(today, 1);
    const daily = current / elapsed;
    const remain = daysInMonth - today;
    const eom = Math.round(current + daily * remain);

    renderPred(current, daily, eom);
    renderChart(trend, eom);
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

  function renderChart(trend, eom) {
    const svg = $("chart");
    const W = 520, H = 220, PAD_L = 40, PAD_R = 16, PAD_T = 14, PAD_B = 26;
    const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;

    const values = trend.map(d => d.monthly);
    const maxV = Math.max(100, ...values, eom || 0);
    const yMax = Math.ceil(maxV / 20) * 20; // 对齐 20% 刻度
    const n = trend.length;

    // X 坐标：按日期在当月的位置（比均匀分布更真实）
    const now = new Date();
    const month = now.getMonth();
    const year = now.getFullYear();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
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
