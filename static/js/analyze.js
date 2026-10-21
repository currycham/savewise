// 支出审计：全部是确定性计算，AI 不参与任何金额。
//   overview()       年度收支、结余率、今年同期对比、分类逐年 / 逐月、四象限占比
//   opportunities()  可砍清单：订阅、无感支出、单价审计、大额支出、分类膨胀、偶发大额
//   totalSaving()    各项可省金额合计（按交易去重，避免同一笔钱算两次）
import { defaultKind } from "./categorize.js";
import { addMonths, daysBetween, groupBy, median, monthOf, monthRange, round, sum, yuan } from "./util.js";

export const DEFAULTS = {
  smallMax: 200,          // 无感支出：单笔中位数不超过
  smallPerMonth: 8,       // 无感支出：每月平均笔数不少于
  bigMin: 2000,           // 大额支出：单笔不少于（用户可以改）
  inflateRate: 0.2,       // 分类膨胀：同比涨幅不少于
  inflateMin: 3000,       // 分类膨胀：同比多花不少于（折合一年）
};

// “决定去做”的力度：不是一刀砍到底，而是少花一部分、或者把涨幅压下来。v 是对 base 的比例。
const third = 0.33;
export const CUTS = {
  subscription: { opts: [1], def: 1, label: () => "取消" },
  small: { opts: [0.1, 0.2, 0.3], def: 0.2, label: (v) => `少花 ${Math.round(v * 100)}%` },
  audit: { opts: [0.1, 0.15, 0.2, 0.3], def: 0.15, label: (v) => `省 ${Math.round(v * 100)}%` },
  inflate: { opts: [third, 0.5, 1], def: 0.5, label: (v) => (v === 1 ? "回到去年同期" : v === 0.5 ? "涨幅减半" : "涨幅少 1/3") },
  inflateRigid: { opts: [0.2, third, 0.5], def: 0.2, label: (v) => `涨幅少 ${v === third ? "1/3" : `${Math.round(v * 100)}%`}` },
  lumpy: { opts: [third, 0.5, 1], def: 0.5, label: (v) => (v === 1 ? "回到往年水平" : v === 0.5 ? "超出部分减半" : "超出部分少 1/3") },
};
function pickCut(kind, id, cuts) {
  const c = CUTS[kind];
  const v = c.opts.find((x) => Math.abs(x - (cuts[id] ?? c.def)) < 0.005) ?? c.def;
  return { cut: v, cuts: c.opts.map((x) => ({ v: x, label: c.label(x) })), cutLabel: c.label(v) };
}

// 支出（退款冲减）
export const spend = (t) => (t.type === "expense" ? t.amount : t.type === "refund" ? -t.amount : 0);
export const isSpend = (t) => t.type === "expense" || t.type === "refund";

// 分析窗口：最近 12 个完整月（最后一个月不满 25 天、第一个月从 5 号以后才开始的都不算完整），用来估算“一年”的量。
// 只导入了几个月微信账单时，窗口就是这几个月，金额按 12/months 折算成一年（scale）。
// 同期对比（ytd）按日历年：今年 1 月到最近一个完整月，对比去年同样的月份。
export function windowOf(txs) {
  const dates = txs.filter(isSpend).map((t) => t.date).sort();
  if (!dates.length) return null;
  const first = dates[0], last = dates[dates.length - 1];
  let end = monthOf(last);
  if (Number(last.slice(8)) < 25) end = addMonths(end, -1);
  let firstFull = monthOf(first);
  if (Number(first.slice(8)) > 5) firstFull = addMonths(firstFull, 1);
  if (firstFull > end) { firstFull = monthOf(first); end = monthOf(last); } // 不到一个完整月，有多少算多少
  const start = addMonths(end, -11) > firstFull ? addMonths(end, -11) : firstFull;
  const months = monthRange(start, end).length;
  return { start, end, months, scale: 12 / months, first: monthOf(first), firstFull, last, ytd: ytdOf(firstFull, end) };
}

// 今年不满 3 个完整月（1、2 月）时同期太短，改成去年全年对比前年全年
function ytdOf(firstFull, end) {
  const span = (to) => {
    const from = `${to.slice(0, 4)}-01` < firstFull ? firstFull : `${to.slice(0, 4)}-01`;
    return from > to ? null : { from, to };
  };
  let p = Number(end.slice(5)) < 3 ? span(`${Number(end.slice(0, 4)) - 1}-12`) : null;
  p ||= span(end);
  const prevStart = addMonths(p.from, -12), prevEnd = addMonths(p.to, -12);
  return {
    year: p.to.slice(0, 4), start: p.from, end: p.to, months: monthRange(p.from, p.to).length,
    prevStart, prevEnd, hasPrev: prevStart >= firstFull, label: periodLabel(p.from, p.to),
  };
}

// 2026 年 1–9 月 / 2025 年全年 / 2026 年 3 月
export function periodLabel(a, b) {
  const y = a.slice(0, 4), m1 = Number(a.slice(5)), m2 = Number(b.slice(5));
  if (m1 === 1 && m2 === 12) return `${y} 年全年`;
  return m1 === m2 ? `${y} 年 ${m1} 月` : `${y} 年 ${m1}–${m2} 月`;
}

const inRange = (t, a, b) => { const m = monthOf(t.date); return m >= a && m <= b; };

export function kindOf(t, kinds = {}) {
  return kinds[`${t.cat1}/${t.cat2}`] || kinds[t.cat1] || defaultKind(t.cat1, t.cat2);
}

// ---------- 总览 ----------
export function overview(txs, kinds = {}) {
  const w = windowOf(txs);
  if (!w) return null;
  const y = w.ytd;
  const years = [...new Set(txs.map((t) => t.date.slice(0, 4)))].sort();
  const byYear = years.map((yr) => {
    const ts = txs.filter((t) => t.date.startsWith(yr));
    const expense = sum(ts, spend), income = sum(ts.filter((t) => t.type === "income"), (t) => t.amount);
    const months = new Set(ts.filter(isSpend).map((t) => monthOf(t.date))).size;
    return { year: yr, expense, income, saveRate: income ? (income - expense) / income : null, months };
  });
  const spendTx = txs.filter(isSpend);
  const cur = spendTx.filter((t) => inRange(t, w.start, w.end));
  const curIncome = sum(txs.filter((t) => t.type === "income" && inRange(t, w.start, w.end)), (t) => t.amount);
  const inYtd = (t) => inRange(t, y.start, y.end), inPrev = (t) => y.hasPrev && inRange(t, y.prevStart, y.prevEnd);

  // 一级 / 二级分类：最近 12 个月（折合一年）、今年同期 vs 去年同期、每个自然年
  const stats = (ts) => ({
    last: sum(ts.filter((t) => inRange(t, w.start, w.end)), spend) * w.scale,
    ytd: sum(ts.filter(inYtd), spend), ytdPrev: sum(ts.filter(inPrev), spend),
    perYear: Object.fromEntries(years.map((yr) => [yr, sum(ts.filter((t) => t.date.startsWith(yr)), spend)])),
  });
  const cats = [...groupBy(spendTx, (t) => t.cat1)].map(([cat1, ts]) => {
    const subs = [...groupBy(ts, (t) => t.cat2)].map(([cat2, s]) => ({ cat2, kind: kindOf(s[0], kinds), ...stats(s) }))
      .sort((a, b) => b.ytd - a.ytd || b.last - a.last);
    return { cat1, ...stats(ts), subs };
  }).sort((a, b) => b.ytd - a.ytd || b.last - a.last);

  const kindTotals = { rigid: 0, fixedFlex: 0, daily: 0, lumpy: 0 };
  for (const t of cur) kindTotals[kindOf(t, kinds)] += spend(t) * w.scale;

  // 月度趋势（全部月份）：合计，以及每个一级分类、二级分类（键是 cat1 或 cat1/cat2）
  const allMonths = monthRange(w.first, monthOf(w.last));
  const monthly = groupBy(spendTx, (t) => monthOf(t.date));
  const trend = allMonths.map((m) => ({ month: m, expense: sum(monthly.get(m) || [], spend) }));
  const byCatMonth = {};
  for (const t of spendTx) {
    const m = monthOf(t.date);
    for (const k of [t.cat1, `${t.cat1}/${t.cat2}`]) (byCatMonth[k] ||= {})[m] = (byCatMonth[k][m] || 0) + spend(t);
  }

  const ytdIncome = sum(txs.filter((t) => t.type === "income" && inYtd(t)), (t) => t.amount);
  return {
    window: w, years, byYear, cats, kindTotals, trend, months: allMonths, byCatMonth,
    // 窗口不满 12 个月时 last12 / income12 是折算成一年的数
    last12: sum(cur, spend) * w.scale, income12: curIncome * w.scale,
    ytd: { ...y, expense: sum(spendTx.filter(inYtd), spend), prevExpense: sum(spendTx.filter(inPrev), spend), income: ytdIncome },
    txCount: txs.length,
  };
}

// ---------- 可砍清单 ----------
// 每条：{ id, type, title, key, annual(过去一年花了), saving(预计一年可省), cut/cuts(力度), action, detail, risk, txIds }
export function opportunities(txs, { kinds = {}, reviews = {}, cuts = {}, opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const w = windowOf(txs);
  if (!w) return [];
  const cur = txs.filter((t) => t.type === "expense" && inRange(t, w.start, w.end));
  const months = w.months;
  const out = [];

  // 1. 订阅黑洞：同一商户、金额基本固定、按月或按年重复扣款，最近还在扣
  const subKeys = new Set();
  const allExp = txs.filter((t) => t.type === "expense" && t.merchant);
  for (const [key, ts] of groupBy(allExp, (t) => `${t.merchant}|${t.cat2}`)) {
    if (ts.length < 2) continue;
    const kind = kindOf(ts[0], kinds);
    if (kind === "rigid") continue; // 房租、阿姨这类固定刚性不算订阅
    const sorted = [...ts].sort((a, b) => (a.date < b.date ? -1 : 1));
    // 看最近 6 次：涨过价的订阅（iCloud 升级容量）也认得出来
    const recent = sorted.slice(-6);
    const med = median(recent.map((t) => t.amount));
    if (med > 6000) continue;
    if (!recent.every((t) => Math.abs(t.amount - med) <= med * 0.1 + 1)) continue;
    const gaps = recent.slice(1).map((t, i) => daysBetween(recent[i].date, t.date));
    if (!gaps.length) continue;
    const g = median(gaps);
    let period = null;
    if (g >= 25 && g <= 35 && recent.length >= 3 && gaps.filter((x) => x >= 20 && x <= 40).length >= gaps.length - 1) period = "monthly";
    else if (g >= 340 && g <= 390 && recent.length >= 2) period = "yearly";
    if (!period) continue;
    // 按年扣的，要么是会员/年卡类分类，要么备注里写着会员、年费：免得把每年双 11 买的东西当成订阅
    const subLike = /会员|年费|年卡|续费|订阅|包月|包年/.test(sorted.map((t) => t.note).join(" "));
    if (period === "yearly" && kind !== "fixedFlex" && !subLike) continue;
    // 每月 500 以上的（钢琴课、托管班）是服务费，不是“忘了取消的订阅”，除非备注里写着会员、订阅
    if (period === "monthly" && !subLike && med > 500) continue;
    const lastDate = sorted[sorted.length - 1].date;
    const stale = daysBetween(lastDate, w.last);
    if (stale > (period === "monthly" ? 45 : 400)) continue; // 已经停了
    const latest = sorted[sorted.length - 1].amount;
    const annual = period === "monthly" ? latest * 12 : latest;
    const sinceMonths = Math.max(1, monthRange(monthOf(sorted[0].date), monthOf(lastDate)).length);
    const total = sum(sorted, (t) => t.amount);
    subKeys.add(key);
    out.push({
      id: `sub|${key}`, type: "subscription", key,
      title: `${sorted[0].merchant}${sorted[sorted.length - 1].note ? `（${sorted[sorted.length - 1].note}）` : ""}`,
      annual, saving: annual, ...pickCut("subscription", "", {}),
      action: `过去 3 个月用过吗？没用就取消自动续费。${period === "monthly" ? `每月 ${yuan(latest)}` : `每年 ${yuan(latest)}`}，已经扣了 ${sinceMonths} 个月，累计 ${yuan(total)}。`,
      detail: { period, latest, since: sorted[0].date, lastDate, count: sorted.length, total },
      risk: "低：取消后想用随时可以再开",
      txIds: cur.filter((t) => `${t.merchant}|${t.cat2}` === key).map((t) => t.id),
    });
  }

  // 2. 无感支出：单笔不大、但一个月出现很多次（按二级分类看，外卖不分美团还是饿了么）
  const small = cur.filter((t) => kindOf(t, kinds) === "daily" && !subKeys.has(`${t.merchant}|${t.cat2}`));
  for (const [key, ts] of groupBy(small, (t) => `${t.cat1}/${t.cat2}`)) {
    const perMonth = ts.length / months;
    const med = median(ts.map((t) => t.amount));
    if (med > o.smallMax || perMonth < o.smallPerMonth) continue;
    const annual = sum(ts, (t) => t.amount) * w.scale;
    if (annual < 1500) continue;
    const id = `small|${key}`, c = pickCut("small", id, cuts);
    const cap = round((annual / 12) * (1 - c.cut), 50);
    const top = [...groupBy(ts, (t) => t.merchant || "（无商户）")].map(([m, x]) => [m, sum(x, (t) => t.amount)]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    out.push({
      id, type: "small", key,
      title: `${ts[0].cat2}：每月 ${perMonth.toFixed(0)} 次，单笔约 ${yuan(med)}`,
      annual, saving: annual * c.cut, ...c,
      action: `单笔不心疼，一年加起来 ${yuan(annual)}。不用戒掉，给它设一个月上限 ${yuan(cap)}（现在月均 ${yuan(annual / 12)}，${c.cutLabel}），用完就停。`,
      detail: { perMonth, median: med, cap, cat2: ts[0].cat2, top },
      risk: "低：不是不花，是从“无感”变成“有感”",
      txIds: ts.map((t) => t.id),
    });
  }

  // 2b. 固定弹性的大项（保健品、兴趣班、课程）：不一定砍，先做一次比价和必要性审计
  for (const [key, ts] of groupBy(cur.filter((t) => kindOf(t, kinds) === "fixedFlex" && !subKeys.has(`${t.merchant}|${t.cat2}`)), (t) => `${t.cat1}/${t.cat2}`)) {
    const annual = sum(ts, (t) => t.amount) * w.scale;
    if (annual < 10000) continue;
    const id = `audit|${key}`, c = pickCut("audit", id, cuts);
    out.push({
      id, type: "audit", key,
      title: `${ts[0].cat2}：一年 ${yuan(annual)}，月均 ${yuan(annual / 12)}`,
      annual, saving: annual * c.cut, ...c,
      action: `逐项过一遍：有没有重复的、用不上的、只是“怕不够”买的？同样的东西找平替、团购、年卡，通常能省 10%–30%。`,
      detail: { count: ts.length },
      risk: "低：先审计再决定，不影响真正用得上的部分",
      txIds: ts.map((t) => t.id),
    });
  }

  // 3. 大额支出：单笔 ≥ 阈值（默认 2000，用户可调），固定刚性之外。逐笔复盘值不值，“不值”的金额算可省
  const big = cur.filter((t) => t.amount >= o.bigMin && kindOf(t, kinds) !== "rigid");
  if (big.length) {
    const reviewed = big.filter((t) => reviews[t.id]);
    const notWorth = sum(big.filter((t) => reviews[t.id] === "no"), (t) => t.amount);
    const total = sum(big, (t) => t.amount);
    out.push({
      id: "big", type: "big", key: "big",
      title: `${yuan(o.bigMin)} 以上的支出 ${big.length} 笔，共 ${yuan(total)}`,
      annual: total * w.scale, saving: notWorth * w.scale, cut: 0, cuts: [],
      action: reviewed.length < big.length
        ? `逐笔看一遍：这笔钱带来了持续的价值吗？已复盘 ${reviewed.length}/${big.length} 笔。复盘为“不值”的金额，就是明年可以不花的钱。`
        : `复盘完了：不值的 ${yuan(notWorth)}，明年同类的先进 72 小时冷静期。`,
      detail: { min: o.bigMin, items: [...big].sort((a, b) => b.amount - a.amount).map((t) => ({ ...t, review: reviews[t.id] || "" })) },
      risk: "持续有价值的保留，不值的明年少花",
      txIds: big.filter((t) => reviews[t.id] === "no").map((t) => t.id),
    });
  }

  // 4. 分类膨胀：二级分类今年同期比去年同期涨了很多（需要去年同期的数据）
  const y = w.ytd;
  if (y.hasPrev) {
    const ytdScale = 12 / y.months;
    const exp = txs.filter((t) => t.type === "expense");
    const prevBy = groupBy(exp.filter((t) => inRange(t, y.prevStart, y.prevEnd)), (t) => `${t.cat1}/${t.cat2}`);
    for (const [key, ts] of groupBy(exp.filter((t) => inRange(t, y.start, y.end)), (t) => `${t.cat1}/${t.cat2}`)) {
      const last = sum(ts, (t) => t.amount);
      const before = sum(prevBy.get(key) || [], (t) => t.amount);
      if (!before) continue;
      const delta = last - before;
      if (delta * ytdScale < o.inflateMin || delta / before < o.inflateRate) continue;
      const kind = kindOf(ts[0], kinds);
      const id = `inflate|${key}`, c = pickCut(kind === "rigid" ? "inflateRigid" : "inflate", id, cuts);
      const saving = delta * ytdScale * c.cut;
      out.push({
        id, type: "inflate", key,
        title: `${ts[0].cat2}：${y.label}比去年同期多花 ${yuan(delta)}（+${Math.round((delta / before) * 100)}%）`,
        annual: last * ytdScale, saving, ...c,
        action: kind === "rigid"
          ? `这是固定刚性支出，不砍项目：比价、换渠道、年缴/团购，把单价降下来，${c.cutLabel}一年约省 ${yuan(saving)}。`
          : `去年同期 ${yuan(before)}，今年 ${yuan(last)}。${c.cut === 1 ? "回到去年同期的水平" : `不用退回去年，${c.cutLabel}`}，一年约省 ${yuan(saving)}。`,
        detail: { before, last, kind, months: y.months },
        risk: kind === "rigid" ? "只动单价，不动生活品质" : "中：先看多出来的部分花在了哪",
        txIds: ts.map((t) => t.id),
      });
    }
  }

  // 5. 偶发大额：旅行、人情、数码这类，没有年度预算就容易越花越多
  const yearsBack = [1, 2, 3].map((k) => ({ a: addMonths(w.start, -12 * k), b: addMonths(w.end, -12 * k) }));
  for (const [cat2, ts] of groupBy(cur.filter((t) => kindOf(t, kinds) === "lumpy"), (t) => t.cat2)) {
    const last = sum(ts, (t) => t.amount);
    const hist = yearsBack.map(({ a, b }) => sum(txs.filter((t) => t.type === "expense" && t.cat2 === cat2 && inRange(t, a, b)), (t) => t.amount)).filter((x) => x > 0);
    if (hist.length < 2) continue;
    const usual = round(median(hist), 1000);
    const delta = last - usual;
    if (delta < o.inflateMin) continue;
    if (out.some((x) => x.type === "inflate" && x.key.endsWith(`/${cat2}`))) continue;
    const id = `lumpy|${cat2}`, c = pickCut("lumpy", id, cuts);
    const budget = round(last - delta * c.cut, 1000);
    out.push({
      id, type: "lumpy", key: cat2,
      title: `${cat2}：过去一年 ${yuan(last)}，往年中位数 ${yuan(usual)}`,
      annual: last, saving: delta * c.cut, ...c,
      action: `年初就把${cat2}的年度预算定在 ${yuan(budget)} 左右（${c.cutLabel}），提前订、少临时加。`,
      detail: { budget, usual, hist },
      risk: "中：不是不去，是年初定好次数和预算",
      txIds: ts.map((t) => t.id),
    });
  }

  return out.sort((a, b) => b.saving - a.saving);
}

// 合计可省（一年）：每条机会把它的 saving 按金额摊到自己的交易上，
// 同一笔交易被多条覆盖时只取摊得最多的那条，避免重复计算
export function totalSaving(txs, opps, statuses = {}, { only = null } = {}) {
  const byId = new Map(txs.map((t) => [t.id, t]));
  const weight = new Map();
  let extra = 0;
  for (const op of opps) {
    const st = statuses[op.id] || "todo";
    if (st === "ignored") continue;
    if (only && st !== only) continue;
    const base = sum(op.txIds, (id) => byId.get(id)?.amount || 0);
    if (!base) { extra += op.saving; continue; }
    const k = op.saving / base;
    for (const id of op.txIds) weight.set(id, Math.max(weight.get(id) || 0, k));
  }
  let s = 0;
  for (const [id, k] of weight) s += (byId.get(id)?.amount || 0) * k;
  return s + extra;
}
