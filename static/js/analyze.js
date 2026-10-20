// 支出审计：全部是确定性计算，AI 不参与任何金额。
//   overview()       年度收支、结余率、分类逐年对比、四象限占比
//   opportunities()  可砍清单：无感支出、订阅黑洞、冲动大额、分类膨胀、偶发大额
//   totalSaving()    各项可省金额合计（按交易去重，避免同一笔钱算两次）
import { defaultKind } from "./categorize.js";
import { addMonths, daysBetween, groupBy, median, monthOf, monthRange, round, sum, yuan } from "./util.js";

export const DEFAULTS = {
  smallMax: 200,          // 无感支出：单笔中位数不超过
  smallPerMonth: 8,       // 无感支出：每月平均笔数不少于
  smallCut: 0.3,          // 无感支出：设上限后预计少花的比例
  bigMin: 2000,           // 冲动大额：单笔不少于
  inflateRate: 0.2,       // 分类膨胀：同比涨幅不少于
  inflateMin: 3000,       // 分类膨胀：同比多花不少于
};

// 支出（退款冲减）
export const spend = (t) => (t.type === "expense" ? t.amount : t.type === "refund" ? -t.amount : 0);
export const isSpend = (t) => t.type === "expense" || t.type === "refund";

// 分析窗口：最近 12 个完整月（最后一个月不满 25 天、第一个月从 5 号以后才开始的都不算完整）。
// 只导入了几个月微信账单时，窗口就是这几个月，金额按 12/months 折算成一年（scale）。
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
  const prevStart = addMonths(start, -12);
  return {
    start, end, months, scale: 12 / months, prevStart, prevEnd: addMonths(start, -1),
    hasPrev: months === 12 && prevStart >= firstFull, first: monthOf(first), last,
  };
}

const inRange = (t, a, b) => { const m = monthOf(t.date); return m >= a && m <= b; };

export function kindOf(t, kinds = {}) {
  return kinds[`${t.cat1}/${t.cat2}`] || kinds[t.cat1] || defaultKind(t.cat1, t.cat2);
}

// ---------- 总览 ----------
export function overview(txs, kinds = {}) {
  const w = windowOf(txs);
  if (!w) return null;
  const years = [...new Set(txs.map((t) => t.date.slice(0, 4)))].sort();
  const byYear = years.map((y) => {
    const ts = txs.filter((t) => t.date.startsWith(y));
    const expense = sum(ts, spend), income = sum(ts.filter((t) => t.type === "income"), (t) => t.amount);
    const months = new Set(ts.filter(isSpend).map((t) => monthOf(t.date))).size;
    return { year: y, expense, income, saveRate: income ? (income - expense) / income : null, months };
  });
  const cur = txs.filter((t) => isSpend(t) && inRange(t, w.start, w.end));
  const prev = txs.filter((t) => isSpend(t) && inRange(t, w.prevStart, w.prevEnd));
  const curIncome = sum(txs.filter((t) => t.type === "income" && inRange(t, w.start, w.end)), (t) => t.amount);

  // 一级分类：最近 12 个月 vs 前 12 个月，以及每个自然年
  const cats = [...groupBy(txs.filter(isSpend), (t) => t.cat1)].map(([cat1, ts]) => {
    const last = sum(ts.filter((t) => inRange(t, w.start, w.end)), spend) * w.scale;
    const before = w.hasPrev ? sum(ts.filter((t) => inRange(t, w.prevStart, w.prevEnd)), spend) : 0;
    const perYear = Object.fromEntries(years.map((y) => [y, sum(ts.filter((t) => t.date.startsWith(y)), spend)]));
    const subs = [...groupBy(ts, (t) => t.cat2)].map(([cat2, s]) => ({
      cat2, kind: kindOf(s[0], kinds),
      last: sum(s.filter((t) => inRange(t, w.start, w.end)), spend) * w.scale,
      before: w.hasPrev ? sum(s.filter((t) => inRange(t, w.prevStart, w.prevEnd)), spend) : 0,
    })).sort((a, b) => b.last - a.last);
    return { cat1, last, before, perYear, subs };
  }).sort((a, b) => b.last - a.last);

  const kindTotals = { rigid: 0, fixedFlex: 0, daily: 0, lumpy: 0 };
  for (const t of cur) kindTotals[kindOf(t, kinds)] += spend(t) * w.scale;

  // 月度趋势（全部月份）
  const allMonths = monthRange(w.first, monthOf(w.last));
  const monthly = groupBy(txs.filter(isSpend), (t) => monthOf(t.date));
  const trend = allMonths.map((m) => ({ month: m, expense: sum(monthly.get(m) || [], spend) }));

  return {
    window: w, years, byYear, cats, kindTotals, trend,
    // 窗口不满 12 个月时 last12 / income12 是折算成一年的数，prev12 只在有完整前一年时才有
    last12: sum(cur, spend) * w.scale, prev12: w.hasPrev ? sum(prev, spend) : 0, income12: curIncome * w.scale,
    txCount: txs.length,
  };
}

// ---------- 可砍清单 ----------
// 每条：{ id, type, title, key, annual(过去一年花了), saving(预计一年可省), action, detail, risk, txIds, rate }
export function opportunities(txs, { kinds = {}, reviews = {}, opts = {} } = {}) {
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
    const amounts = sorted.map((t) => t.amount);
    const med = median(amounts);
    if (med > 6000) continue;
    const recent = sorted.slice(-6);
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
    if (period === "monthly" && kind !== "fixedFlex" && !subLike && med > 500) continue;
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
      annual, saving: annual, rate: 1,
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
    const cap = round((annual / 12) * (1 - o.smallCut), 50);
    const top = [...groupBy(ts, (t) => t.merchant || "（无商户）")].map(([m, x]) => [m, sum(x, (t) => t.amount)]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    out.push({
      id: `small|${key}`, type: "small", key,
      title: `${ts[0].cat2}：每月 ${perMonth.toFixed(0)} 次，单笔约 ${yuan(med)}`,
      annual, saving: annual * o.smallCut, rate: o.smallCut,
      action: `单笔不心疼，一年加起来 ${yuan(annual)}。给它设一个月上限 ${yuan(cap)}（现在月均 ${yuan(annual / 12)}），用完就停。`,
      detail: { perMonth, median: med, cap, cat2: ts[0].cat2, top },
      risk: "低：不是不花，是从“无感”变成“有感”",
      txIds: ts.map((t) => t.id),
    });
  }

  // 2b. 固定弹性的大项（保健品、早教、课程）：不一定砍，先做一次比价和必要性审计
  for (const [key, ts] of groupBy(cur.filter((t) => kindOf(t, kinds) === "fixedFlex" && !subKeys.has(`${t.merchant}|${t.cat2}`)), (t) => `${t.cat1}/${t.cat2}`)) {
    const annual = sum(ts, (t) => t.amount) * w.scale;
    if (annual < 10000) continue;
    out.push({
      id: `audit|${key}`, type: "audit", key,
      title: `${ts[0].cat2}：一年 ${yuan(annual)}，月均 ${yuan(annual / 12)}`,
      annual, saving: annual * 0.2, rate: 0.2,
      action: `逐项过一遍：有没有重复的、用不上的、只是“怕不够”买的？同样的东西找平替、团购、年卡，通常能省 20%–30%。`,
      detail: { count: ts.length },
      risk: "低：先审计再决定，不影响真正用得上的部分",
      txIds: ts.map((t) => t.id),
    });
  }

  // 3. 冲动 / 情绪大额：单笔 ≥ 2000，固定刚性之外；深夜下单、备注里有情绪词的标出来
  const big = cur.filter((t) => t.amount >= o.bigMin && kindOf(t, kinds) !== "rigid" && !/旅游|度假/.test(t.cat2));
  const emotional = /焦虑|冲动|奖励|安慰|犒劳|难过|不开心|压力|失眠|睡不着|直播|双11|双十一|618|凑满减|怕|落后|别人都/;
  const flagged = big.map((t) => {
    const hour = t.time ? Number(t.time.slice(0, 2)) : null;
    const flags = [];
    if (hour !== null && (hour >= 22 || hour < 3)) flags.push("深夜下单");
    if (emotional.test(t.note)) flags.push("备注里有情绪词");
    if (/双11|双十一|618|大促|满减/.test(t.note) || /-11-1[01]$|-06-1[78]$/.test(t.date)) flags.push("大促");
    return { t, flags };
  });
  if (flagged.length) {
    const reviewed = flagged.filter(({ t }) => reviews[t.id]);
    const notWorth = sum(flagged.filter(({ t }) => reviews[t.id] === "no"), ({ t }) => t.amount);
    const total = sum(flagged, ({ t }) => t.amount);
    out.push({
      id: "impulse", type: "impulse", key: "impulse",
      title: `${o.bigMin} 元以上的消费 ${flagged.length} 笔，其中 ${flagged.filter((x) => x.flags.length).length} 笔有冲动迹象`,
      annual: total, saving: notWorth, rate: 0,
      action: reviewed.length < flagged.length
        ? `逐笔复盘：这笔钱带来了持续的价值，还是只缓解了当时的焦虑？已复盘 ${reviewed.length}/${flagged.length} 笔。复盘为“不值”的金额，就是明年可以不花的钱。`
        : `复盘完了：不值的 ${yuan(notWorth)}，明年同类消费先进 72 小时冷静期。`,
      detail: { items: flagged.sort((a, b) => b.flags.length - a.flags.length || b.t.amount - a.t.amount).map(({ t, flags }) => ({ ...t, flags, review: reviews[t.id] || "" })) },
      risk: "持续价值保留，焦虑驱动的砍掉或降级",
      txIds: flagged.filter(({ t }) => reviews[t.id] === "no").map(({ t }) => t.id),
    });
  }

  // 4. 分类膨胀：二级分类同比涨了很多（需要至少两年的数据）
  const prev = !w.hasPrev ? [] : txs.filter((t) => t.type === "expense" && inRange(t, w.prevStart, w.prevEnd));
  const prevBy = groupBy(prev, (t) => `${t.cat1}/${t.cat2}`);
  for (const [key, ts] of groupBy(cur, (t) => `${t.cat1}/${t.cat2}`)) {
    const last = sum(ts, (t) => t.amount);
    const before = sum(prevBy.get(key) || [], (t) => t.amount);
    if (!before) continue;
    const delta = last - before;
    if (delta < o.inflateMin || delta / before < o.inflateRate) continue;
    const kind = kindOf(ts[0], kinds);
    out.push({
      id: `inflate|${key}`, type: "inflate", key,
      title: `${ts[0].cat2}：一年多花了 ${yuan(delta)}（+${Math.round((delta / before) * 100)}%）`,
      annual: last, saving: kind === "rigid" ? delta * 0.3 : delta, rate: (kind === "rigid" ? delta * 0.3 : delta) / last,
      action: kind === "rigid"
        ? "这是固定刚性支出，不砍项目：比价、换渠道、年卡/团购，把单价降下来。"
        : `前一年 ${yuan(before)} 也过得挺好。回到前一年的水平，一年省 ${yuan(delta)}。`,
      detail: { before, last, kind },
      risk: kind === "rigid" ? "只动单价，不动生活品质" : "中：先看多出来的部分花在了哪",
      txIds: ts.map((t) => t.id),
    });
  }

  // 5. 偶发大额：旅行、人情、数码这类，没有年度预算就容易越花越多
  const yearsBack = [1, 2, 3].map((k) => ({ a: addMonths(w.start, -12 * k), b: addMonths(w.end, -12 * k) }));
  for (const [cat2, ts] of groupBy(cur.filter((t) => kindOf(t, kinds) === "lumpy"), (t) => t.cat2)) {
    const last = sum(ts, (t) => t.amount);
    const hist = yearsBack.map(({ a, b }) => sum(txs.filter((t) => t.type === "expense" && t.cat2 === cat2 && inRange(t, a, b)), (t) => t.amount)).filter((x) => x > 0);
    if (hist.length < 2) continue;
    const budget = round(median(hist), 1000);
    const delta = last - budget;
    if (delta < o.inflateMin) continue;
    if (out.some((x) => x.type === "inflate" && x.key.endsWith(`/${cat2}`))) continue;
    out.push({
      id: `lumpy|${cat2}`, type: "lumpy", key: cat2,
      title: `${cat2}：过去一年 ${yuan(last)}，往年中位数 ${yuan(budget)}`,
      annual: last, saving: delta, rate: delta / last,
      action: `年初就把${cat2}的年度预算定在 ${yuan(budget)} 左右，提前订、少临时加。`,
      detail: { budget, hist },
      risk: "中：不是不去，是年初定好次数和预算",
      txIds: ts.map((t) => t.id),
    });
  }

  return out.sort((a, b) => b.saving - a.saving);
}

// 合计可省（折算成一年）：同一笔交易被多条机会覆盖时，只按最大的比例算一次
export function totalSaving(txs, opps, statuses = {}, { only = null } = {}) {
  const byId = new Map(txs.map((t) => [t.id, t]));
  const rate = new Map();
  let extra = 0;
  for (const op of opps) {
    const st = statuses[op.id] || "todo";
    if (st === "ignored") continue;
    if (only && st !== only) continue;
    if (op.type === "impulse") { extra += op.saving; continue; }
    for (const id of op.txIds) rate.set(id, Math.max(rate.get(id) || 0, op.rate));
  }
  let s = 0;
  for (const [id, r] of rate) s += (byId.get(id)?.amount || 0) * r;
  return s * (windowOf(txs)?.scale || 1) + extra;
}
