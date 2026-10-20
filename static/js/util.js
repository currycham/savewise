// 通用小工具：日期、金额、统计。浏览器和 Node（测试）都能用。

export const DAY = 86400000;

export function pad(n) { return String(n).padStart(2, "0"); }

export function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// 'YYYY-MM-DD' -> 本地零点的 Date（只用于算天数差，不涉及时区）
export function toDate(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }

export function daysBetween(a, b) { return Math.round((toDate(b) - toDate(a)) / DAY); }

export function monthOf(date) { return date.slice(0, 7); }

export function addMonths(ym, k) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

export function monthRange(from, to) {
  const out = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function sum(arr, f = (x) => x) { let s = 0; for (const x of arr) s += f(x); return s; }

export function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

export function round(n, step = 1) { return Math.round(n / step) * step; }

// ¥12.3万 / ¥8,600 这种给人看的金额
export function yuan(n, { sign = false } = {}) {
  const s = sign && n > 0 ? "+" : n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 10000) return `${s}¥${(a / 10000).toFixed(a >= 100000 ? 1 : 2).replace(/\.?0+$/, "")}万`;
  return `${s}¥${Math.round(a).toLocaleString("en-US")}`;
}

export function pct(x, digits = 0) { return `${(x * 100).toFixed(digits)}%`; }

// 可复现的伪随机数（演示数据要每次一样）
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 年金终值：每年末投入 annual，年化 rate，投 years 年
export function futureValue(annual, rate, years) {
  if (!rate) return annual * years;
  return annual * ((1 + rate) ** years - 1) / rate;
}
