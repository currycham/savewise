// 定期复盘：按周、按月或按季度（用户选，默认按月）。上一期花了多少、和前几期比、和去年同期比、
// 消费卡额度、上一期目标完成了没有，以及这一期的目标候选。
// 目标都能用流水自动判定（或者是用户自己打勾的一次性动作），AI 只从候选里挑 3 个、说明理由。
// 期的键：周 "2026-10-12"（周一）、月 "2026-09"、季度 "2026-Q3"。
import { DEFAULTS, isSpend, kindOf, spend } from "./analyze.js";
import { addMonths, groupBy, pad, round, sum, toDate, ymd, yuan } from "./util.js";

export const CADENCES = {
  week: { name: "按周", unit: "周", cur: "这周", last: "上周", prior: 8, perYear: 52 },
  month: { name: "按月", unit: "月", cur: "这个月", last: "上个月", prior: 6, perYear: 12 },
  quarter: { name: "按季度", unit: "季度", cur: "这个季度", last: "上个季度", prior: 4, perYear: 4 },
};

export function addDays(date, k) { const d = toDate(date); d.setDate(d.getDate() + k); return ymd(d); }
export function mondayOf(date) { const d = toDate(date); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); }

export const cadenceOf = (key) => (key.includes("Q") ? "quarter" : key.length === 7 ? "month" : "week");

export function periodOf(date, cadence) {
  if (cadence === "week") return mondayOf(date);
  if (cadence === "month") return date.slice(0, 7);
  return `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
}

const quarterMonth = (key) => `${key.slice(0, 4)}-${pad((Number(key.slice(6)) - 1) * 3 + 1)}`;
export function periodStart(key) {
  const c = cadenceOf(key);
  return c === "week" ? key : c === "month" ? `${key}-01` : `${quarterMonth(key)}-01`;
}
export function periodEnd(key) {
  const c = cadenceOf(key);
  if (c === "week") return addDays(key, 6);
  const next = c === "month" ? addMonths(key, 1) : addMonths(quarterMonth(key), 3);
  return addDays(`${next}-01`, -1);
}
export function shiftPeriod(key, k) {
  const c = cadenceOf(key);
  if (c === "week") return addDays(key, 7 * k);
  if (c === "month") return addMonths(key, k);
  return periodOf(`${addMonths(quarterMonth(key), 3 * k)}-01`, "quarter");
}

// 数据里最近一个完整的期。周：数据要到周日；月、季度：数据到期末前 3 天以内、且这一期已经过完
export function lastFullPeriod(lastDate, cadence, today = ymd(new Date())) {
  const p = periodOf(lastDate, cadence), end = periodEnd(p);
  const full = cadence === "week" ? lastDate === end : lastDate >= addDays(end, -3) && end < today;
  return full ? p : shiftPeriod(p, -1);
}
export const lastFullWeek = (lastDate) => lastFullPeriod(lastDate, "week");

// 10/12–10/18 · 2026 年 9 月 · 2026 年第 3 季度
export function periodName(key) {
  const c = cadenceOf(key);
  if (c === "month") return `${key.slice(0, 4)} 年 ${Number(key.slice(5))} 月`;
  if (c === "quarter") return `${key.slice(0, 4)} 年第 ${key.slice(6)} 季度`;
  const e = addDays(key, 6);
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8))}–${Number(e.slice(5, 7))}/${Number(e.slice(8))}`;
}
// 图表横轴上的短标签
export function periodTick(key) {
  const c = cadenceOf(key);
  if (c === "month") return `${key.slice(2, 4)}/${key.slice(5)}`;
  if (c === "quarter") return `${key.slice(2, 4)}${key.slice(5)}`;
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8))}`;
}

const inPeriod = (t, key) => t.date >= periodStart(key) && t.date <= periodEnd(key);
const BIG_EXCLUDE = /旅游|度假/; // 旅行有自己的年度预算，不算进“这期不买大件”

// 目标的范围：{cat:"餐饮/外卖"} 一个二级分类；{kind:"daily"} 一个象限；{big:2000} 非刚性的大额单笔
function matches(t, scope, kinds) {
  if (!isSpend(t)) return false;
  if (scope.cat) return `${t.cat1}/${t.cat2}` === scope.cat;
  if (scope.kind) return kindOf(t, kinds) === scope.kind;
  if (scope.big) return t.type === "expense" && t.amount >= scope.big && kindOf(t, kinds) !== "rigid" && !BIG_EXCLUDE.test(t.cat2);
  return false;
}

// 一个目标在某一期的完成情况。dataUntil 早于期末时 final=false（还在进行中）
export function evalGoal(g, txs, kinds, key, checks = {}, dataUntil = "") {
  const final = dataUntil >= periodEnd(key);
  if (g.type === "manual") return { done: !!checks[`${key}|${g.id}`], actual: null, final: true };
  const ts = txs.filter((t) => inPeriod(t, key) && matches(t, g.scope || {}, kinds));
  const actual = g.metric === "count" ? ts.filter((t) => t.type === "expense").length : sum(ts, spend);
  return { done: actual <= g.limit, actual, final };
}

export const goalActual = (g, e) => (e.actual === null ? "" : g.metric === "count" ? `${e.actual} 次` : yuan(e.actual));

export function periodStats(txs, kinds, plan, key, { bigMin = DEFAULTS.bigMin } = {}) {
  const cadence = cadenceOf(key), C = CADENCES[cadence];
  const spendTx = txs.filter(isSpend);
  const first = spendTx.reduce((m, t) => (t.date < m ? t.date : m), "9999");
  // 前面最多 N 个完整期（第一期的数据不满就不算）
  const prior = [];
  for (let k = 1; k <= C.prior; k++) { const p = shiftPeriod(key, -k); if (periodStart(p) < first) break; prior.push(p); }
  const cur = spendTx.filter((t) => inPeriod(t, key));
  const priorTx = prior.length ? spendTx.filter((t) => t.date >= periodStart(prior[prior.length - 1]) && t.date < periodStart(key)) : [];
  const n = prior.length || 1;
  const byPeriod = groupBy(priorTx, (t) => periodOf(t.date, cadence));
  const priorTotals = prior.map((p) => sum(byPeriod.get(p) || [], spend));
  // 月、季度再看去年同期
  const yoyKey = cadence === "week" ? null : shiftPeriod(key, cadence === "month" ? -12 : -4);
  const yoy = yoyKey && periodStart(yoyKey) >= first ? sum(spendTx.filter((t) => inPeriod(t, yoyKey)), spend) : null;

  const cats = new Map();
  const cat = (t) => {
    const k = `${t.cat1}/${t.cat2}`;
    if (!cats.has(k)) cats.set(k, { cat: k, cat2: t.cat2, kind: kindOf(t, kinds), cur: 0, count: 0, prior: 0, priorCount: 0 });
    return cats.get(k);
  };
  for (const t of cur) { const c = cat(t); c.cur += spend(t); if (t.type === "expense") c.count++; }
  for (const t of priorTx) { const c = cat(t); c.prior += spend(t); if (t.type === "expense") c.priorCount++; }
  const byCat = [...cats.values()].map((c) => ({ ...c, avg: c.prior / n, avgCount: c.priorCount / n }))
    .filter((c) => c.cur > 0 || c.avg >= 50).sort((a, b) => b.cur - a.cur || b.avg - a.avg);
  const isBig = (t) => matches(t, { big: bigMin }, kinds);

  return {
    key, cadence, start: periodStart(key), end: periodEnd(key), total: sum(cur, spend), count: cur.filter((t) => t.type === "expense").length,
    daily: sum(cur.filter((t) => kindOf(t, kinds) === "daily"), spend),
    quota: plan ? (plan.cardMonthly * 12) / C.perYear : 0,
    avg: prior.length ? sum(priorTotals) / prior.length : null, periods: prior.length, yoy, yoyKey,
    trend: [...prior].reverse().map((p, i) => ({ key: p, total: priorTotals[prior.length - 1 - i] })).concat({ key, total: sum(cur, spend) }),
    byCat, bigMin, big: cur.filter(isBig).sort((a, b) => b.amount - a.amount),
    bigAvg: priorTx.filter(isBig).length / n,
  };
}

// 这一期的目标候选：消费卡、无感支出的上限（金额或次数）、少买大件，加上几个一次性动作
export function goalCandidates({ plan, opps, statuses, cooling }, stats) {
  const C = CADENCES[stats.cadence], u = C.cur;
  const out = [];
  const st = (o) => statuses[o.id] || "todo";
  if (plan?.cardMonthly > 0) {
    const limit = round(stats.quota, 10);
    out.push({ id: "card", type: "cap", scope: { kind: "daily" }, metric: "amount", limit,
      text: `消费卡：高频弹性支出${u}不超过 ${yuan(limit)}`, basis: `${C.last} ${yuan(stats.daily)}，月额度 ${yuan(plan.cardMonthly)}` });
  }
  for (const o of opps.filter((o) => o.type === "small" && st(o) !== "ignored")) {
    const c = stats.byCat.find((x) => x.cat === o.key);
    if (!c || c.avg <= 0) continue;
    const limit = round(c.avg * (1 - o.cut), 10);
    out.push({ id: `cap|${o.key}`, type: "cap", scope: { cat: o.key }, metric: "amount", limit,
      text: `${c.cat2}${u}不超过 ${yuan(limit)}`, basis: `前 ${stats.periods} 个${C.unit}平均 ${yuan(c.avg)}，${C.last} ${yuan(c.cur)}`, saving: round((c.avg - limit) * C.perYear) });
    if (c.avgCount >= 3) {
      const cnt = Math.floor(c.avgCount * (1 - o.cut));
      out.push({ id: `count|${o.key}`, type: "cap", scope: { cat: o.key }, metric: "count", limit: cnt,
        text: `${c.cat2}${u}不超过 ${cnt} 次`, basis: `前 ${stats.periods} 个${C.unit}平均 ${c.avgCount.toFixed(1)} 次，${C.last} ${c.count} 次` });
    }
  }
  const big = opps.find((o) => o.type === "big");
  if (big) {
    // 一周不买大件做得到；一个月、一个季度就按往期少三成
    const limit = stats.cadence === "week" ? 0 : Math.floor(stats.bigAvg * 0.7);
    out.push({ id: "nobig", type: "cap", scope: { big: stats.bigMin }, metric: "count", limit,
      text: limit ? `${u} ${yuan(stats.bigMin)} 以上的非必需品不超过 ${limit} 笔，真想买先放进冷静期` : `${u}不买 ${yuan(stats.bigMin)} 以上的非必需品，真想买先放进冷静期`,
      basis: `前 ${stats.periods} 个${C.unit}平均 ${stats.bigAvg.toFixed(1)} 笔，${C.last} ${stats.big.length} 笔` });
    const left = big.detail.items.filter((t) => !t.review).length;
    if (left) out.push({ id: "review-big", type: "manual", text: `在「可砍清单」里复盘 ${Math.min(left, 5)} 笔大额支出：值不值？`, basis: `还有 ${left} 笔没复盘` });
  }
  for (const o of opps.filter((o) => o.type === "subscription" && st(o) === "doing")) {
    out.push({ id: `cancel|${o.key}`, type: "manual", text: `取消「${o.title}」的自动续费`, basis: `一年 ${yuan(o.saving)}`, saving: round(o.saving) });
  }
  // 同一个分类可能既是单价审计又是分类膨胀，只出一条
  const audits = opps.filter((o) => (o.type === "audit" || o.type === "inflate") && st(o) !== "ignored").filter((o, i, xs) => xs.findIndex((x) => x.key === o.key) === i);
  for (const o of audits.slice(0, 3)) {
    const name = o.key.split("/").pop();
    out.push({ id: `audit|${o.key}`, type: "manual", text: `花 20 分钟过一遍「${name}」：重复的、用不上的、能找平替的`, basis: o.title, saving: round(o.saving) });
  }
  const ready = cooling.filter((c) => c.status === "waiting" && Date.now() - c.at >= 72 * 3600e3);
  if (ready.length) out.push({ id: "cooling", type: "manual", text: `冷静期里有 ${ready.length} 件到期了，决定买还是不买`, basis: ready.map((c) => c.item).join("、").slice(0, 60) });
  return out;
}

// 发给 AI（以及定时任务）的复盘汇总。只有汇总，没有逐笔流水。
export function periodContext(S, key) {
  const cadence = cadenceOf(key);
  const stats = periodStats(S.txs, S.kinds, S.plan, key, { bigMin: S.settings.bigMin });
  const r = (n) => round(n);
  const prev = S.recaps.find((x) => x.period === shiftPeriod(key, -1)); // 上上期的复盘定的就是上一期的目标
  const month = periodEnd(key).slice(0, 7);
  const card = S.ledger.find((x) => x.month === month);
  return {
    period: key, cadence, periodName: periodName(key), range: `${stats.start} ~ ${stats.end}`, dataUntil: S.ov.window.last,
    summary: { total: r(stats.total), count: stats.count, cardSpend: r(stats.daily), cardQuota: r(stats.quota),
      avgPrevPeriods: stats.avg === null ? null : r(stats.avg), prevPeriods: stats.periods, sameLastYear: stats.yoy === null ? null : r(stats.yoy) },
    byCategory: stats.byCat.slice(0, 15).map((c) => ({ category: c.cat, amount: r(c.cur), times: c.count, avg: r(c.avg), timesAvg: Number(c.avgCount.toFixed(1)) })),
    bigPurchases: stats.big.slice(0, 8).map((t) => ({ date: t.date, amount: r(t.amount), category: t.cat2,
      ...(S.settings.shareMerchants ? { merchant: t.merchant, note: t.note.slice(0, 30) } : {}) })),
    trend: stats.trend.map((x) => ({ period: x.key, total: r(x.total) })),
    lastGoals: (prev?.goals || []).map((g) => {
      const e = evalGoal(g, S.txs, S.kinds, key, S.goalChecks, S.ov.window.last);
      return { goal: g.text, result: e.done ? "达成" : "没达成", ...(e.actual === null ? {} : { actual: goalActual(g, e) }) };
    }),
    ...(cadence === "week" && card ? { monthCard: { month, quota: r(card.quota), spentSoFar: r(card.spent) } } : {}),
    plan: S.plan && { annualTarget: S.plan.target, baseline: S.plan.baseline, monthlyCard: S.plan.cardMonthly },
    candidates: goalCandidates(S, stats),
  };
}
