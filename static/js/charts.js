// 轻量 SVG 图表（不依赖外部库）。颜色全部用 CSS 变量，深色模式自动切换。
// 悬停提示：图形元素带 data-tip，由 app.js 里的全局提示框统一显示。
// width 传容器的实际像素宽度，这样字号在手机和电脑上都是 12px，不会被整体缩放。
import { esc } from "./dom.js";


function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

// 顶部圆角、底部贴着基线的柱子
function bar(x, y, w, h, r = 4) {
  if (h <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function grid(W, max, top, bottom, left, fmt) {
  let s = "";
  for (let i = 0; i <= 2; i++) {
    const v = (max / 2) * i, y = bottom - ((bottom - top) * i) / 2;
    s += `<line x1="${left}" x2="${W}" y1="${y}" y2="${y}" class="${i ? "grid" : "axis"}"/>`;
    s += `<text x="${left - 6}" y="${y + 4}" text-anchor="end" class="tick">${esc(fmt(v))}</text>`;
  }
  return s;
}

// 竖柱图：data = [{label, value, tip, muted}]
export function barChart(data, { width: W = 640, height = 220, fmt = String, label = "" } = {}) {
  const top = 16, bottom = height - 26, left = 56;
  const max = niceMax(Math.max(...data.map((d) => d.value), 0));
  const step = (W - left) / data.length, bw = Math.min(48, step * 0.6);
  let s = grid(W, max, top, bottom, left, fmt);
  const maxIdx = data.reduce((m, d, i) => (d.value > data[m].value ? i : m), 0);
  data.forEach((d, i) => {
    const h = ((bottom - top) * Math.max(0, d.value)) / max, x = left + step * i + (step - bw) / 2, y = bottom - h;
    s += `<path d="${bar(x, y, bw, h)}" class="mark${d.muted ? " muted-mark" : ""}" data-tip="${esc(d.tip || `${d.label}：${fmt(d.value)}`)}"/>`;
    s += `<text x="${x + bw / 2}" y="${height - 8}" text-anchor="middle" class="tick">${esc(d.label)}</text>`;
    if (i === maxIdx || i === data.length - 1) s += `<text x="${x + bw / 2}" y="${y - 5}" text-anchor="middle" class="val">${esc(fmt(d.value))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${height}" class="chart" role="img" aria-label="${esc(label)}">${s}</svg>`;
}

// 折线：points = [{label, value}]，默认标签只显示每年 1 月
export function lineChart(points, { width: W = 640, height = 200, fmt = String, label = "", tickEvery = (p) => p.label.endsWith("-01"), tickText = (p) => p.label.slice(0, 4) } = {}) {
  const top = 12, bottom = height - 24, left = 56;
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const step = (W - left) / Math.max(1, points.length - 1);
  const xy = points.map((p, i) => [left + step * i, bottom - ((bottom - top) * Math.max(0, p.value)) / max]);
  let s = grid(W, max, top, bottom, left, fmt);
  s += `<path d="M${xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}" class="line"/>`;
  points.forEach((p, i) => {
    if (tickEvery(p)) s += `<text x="${xy[i][0]}" y="${height - 6}" text-anchor="middle" class="tick">${esc(tickText(p))}</text>`;
    // 每个点一条透明的竖条作为悬停区域，比点本身大得多
    s += `<rect x="${xy[i][0] - step / 2}" y="${top}" width="${Math.max(step, 2)}" height="${bottom - top}" class="hit" data-tip="${esc(`${p.label}：${fmt(p.value)}`)}" data-x="${xy[i][0]}" data-y="${xy[i][1]}"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${height}" class="chart line-chart" role="img" aria-label="${esc(label)}">${s}<circle r="4" class="focus hidden"/></svg>`;
}

// 一条 100% 横条：segments = [{label, value, slot}]，slot 是分类色序号 1~4
export function stackBar(segments, fmt = String) {
  const total = segments.reduce((a, b) => a + b.value, 0) || 1;
  const cells = segments.filter((s) => s.value > 0).map((s) =>
    `<i style="flex:${s.value / total};background:var(--series-${s.slot})" data-tip="${esc(`${s.label}：${fmt(s.value)}（${Math.round((s.value / total) * 100)}%）`)}"></i>`).join("");
  return `<div class="stack">${cells}</div>`;
}

// 消费卡：每月花了多少（柱）对比当月额度（横线）
export function ledgerChart(rows, { width: W = 640, height = 200, fmt = String } = {}) {
  const top = 14, bottom = height - 24, left = 56;
  const max = niceMax(Math.max(...rows.map((r) => Math.max(r.spent, r.quota)), 0));
  const step = (W - left) / rows.length, bw = Math.min(32, step * 0.55);
  let s = grid(W, max, top, bottom, left, fmt);
  rows.forEach((r, i) => {
    const x = left + step * i + (step - bw) / 2;
    const h = ((bottom - top) * r.spent) / max, qy = bottom - ((bottom - top) * r.quota) / max;
    const over = r.spent > r.quota;
    s += `<path d="${bar(x, bottom - h, bw, h)}" class="mark ${over ? "over" : "under"}${r.simulated ? " sim" : ""}" data-tip="${esc(`${r.month}：花了 ${fmt(r.spent)} / 额度 ${fmt(r.quota)}${r.simulated ? "（模拟）" : ""}${over ? `，超支 ${fmt(r.spent - r.quota)}` : `，结余 ${fmt(r.quota - r.spent)}`}`)}"/>`;
    s += `<line x1="${x - 4}" x2="${x + bw + 4}" y1="${qy}" y2="${qy}" class="quota"/>`;
    if (rows.length <= 14 || i % 2 === 0) s += `<text x="${x + bw / 2}" y="${height - 6}" text-anchor="middle" class="tick">${esc(r.month.slice(2).replace("-", "/"))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${height}" class="chart" role="img" aria-label="消费卡每月执行情况">${s}</svg>`;
}

// 多条折线（分类趋势）：labels = ["2026-01", ...]，series = [{label, slot, dash, values}]，共用一个纵轴。
// 悬停一列显示这个月所有分类的金额。
export function multiLineChart(labels, series, { width: W = 640, height = 220, fmt = String, label = "", tick = (l) => l.endsWith("-01") ? l.slice(0, 4) : "" } = {}) {
  const top = 12, bottom = height - 24, left = 56;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const step = (W - left) / Math.max(1, labels.length - 1);
  const X = (i) => left + step * i, Y = (v) => bottom - ((bottom - top) * Math.max(0, v)) / max;
  let s = grid(W, max, top, bottom, left, fmt);
  labels.forEach((l, i) => { const t = tick(l, i); if (t) s += `<text x="${X(i)}" y="${height - 6}" text-anchor="middle" class="tick">${esc(t)}</text>`; });
  for (const se of series) {
    s += `<path d="M${se.values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("L")}" class="s-line${se.dash ? " dash" : ""}" style="stroke:var(--series-${se.slot})"/>`;
  }
  labels.forEach((l, i) => {
    const tip = [l, ...series.map((se) => `${se.label}：${fmt(se.values[i])}`)].join("\n");
    s += `<rect x="${X(i) - step / 2}" y="${top}" width="${Math.max(step, 2)}" height="${bottom - top}" class="hit" data-tip="${esc(tip)}" data-xhair="${X(i)}"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${height}" class="chart line-chart" role="img" aria-label="${esc(label)}">${s}<line class="xhair hidden" y1="${top}" y2="${bottom}"/></svg>`;
}

// 分组柱（每年各分类）：groups = [{label, muted, tip}]，series = [{label, slot, values}]
export function groupedBarChart(groups, series, { width: W = 640, height = 220, fmt = String, label = "" } = {}) {
  const top = 16, bottom = height - 26, left = 56;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const step = (W - left) / groups.length;
  const n = series.length, gap = 2;
  const bw = Math.max(3, Math.min(22, (step * 0.8 - gap * (n - 1)) / n));
  const gw = bw * n + gap * (n - 1);
  let s = grid(W, max, top, bottom, left, fmt);
  groups.forEach((g, gi) => {
    const x0 = left + step * gi + (step - gw) / 2;
    series.forEach((se, si) => {
      const v = se.values[gi], h = ((bottom - top) * Math.max(0, v)) / max, x = x0 + si * (bw + gap);
      s += `<path d="${bar(x, bottom - h, bw, h, 3)}" class="gbar" style="fill:var(--series-${se.slot});${g.muted ? "opacity:.55" : ""}" data-tip="${esc(`${g.tip || g.label} ${se.label}：${fmt(v)}`)}"/>`;
    });
    s += `<text x="${x0 + gw / 2}" y="${height - 8}" text-anchor="middle" class="tick">${esc(g.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${height}" class="chart" role="img" aria-label="${esc(label)}">${s}</svg>`;
}

// 环形图（分类占比）：segments = [{label, value, slot}]，中间写标题和合计
export function donut(segments, { size = 150, title = "", sub = "", fmt = String } = {}) {
  const total = segments.reduce((a, b) => a + Math.max(0, b.value), 0) || 1;
  const c = size / 2, r = size / 2 - 4, ri = r * 0.62;
  let a0 = -Math.PI / 2, s = "";
  const pt = (rad, a) => `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
  for (const seg of segments) {
    if (seg.value <= 0) continue;
    const f = seg.value / total, a1 = a0 + f * Math.PI * 2 - (f >= 1 ? 1e-4 : 0), large = f > 0.5 ? 1 : 0;
    s += `<path d="M${pt(r, a0)}A${r},${r} 0 ${large} 1 ${pt(r, a1)}L${pt(ri, a1)}A${ri},${ri} 0 ${large} 0 ${pt(ri, a0)}Z" class="seg" style="fill:var(--series-${seg.slot})" data-tip="${esc(`${title} ${seg.label}：${fmt(seg.value)}（${Math.round(f * 100)}%）`)}"/>`;
    a0 = a1;
  }
  s += `<text x="${c}" y="${c - 2}" text-anchor="middle" class="center">${esc(title)}</text><text x="${c}" y="${c + 14}" text-anchor="middle" class="center-sub">${esc(sub)}</text>`;
  return `<svg viewBox="0 0 ${size} ${size}" class="chart" style="max-width:${size}px;margin:0 auto" role="img" aria-label="${esc(`${title} 分类占比`)}">${s}</svg>`;
}
