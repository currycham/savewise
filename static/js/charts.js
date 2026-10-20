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

// 折线：points = [{label, value}]，标签只显示每年 1 月
export function lineChart(points, { width: W = 640, height = 200, fmt = String, label = "", tickEvery = (p) => p.label.endsWith("-01") } = {}) {
  const top = 12, bottom = height - 24, left = 56;
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const step = (W - left) / Math.max(1, points.length - 1);
  const xy = points.map((p, i) => [left + step * i, bottom - ((bottom - top) * Math.max(0, p.value)) / max]);
  let s = grid(W, max, top, bottom, left, fmt);
  s += `<path d="M${xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}" class="line"/>`;
  points.forEach((p, i) => {
    if (tickEvery(p)) s += `<text x="${xy[i][0]}" y="${height - 6}" text-anchor="middle" class="tick">${esc(p.label.slice(0, 4))}</text>`;
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
