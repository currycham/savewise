// 每周复盘：上周花了多少、和前几周比、消费卡周额度、上周目标完成了没有，以及本周目标候选。
// 目标都能用流水自动判定（或者是用户自己打勾的一次性动作），AI 只从候选里挑 3 个、说明理由。
import { DEFAULTS, isSpend, kindOf, spend } from "./analyze.js";
import { groupBy, round, sum, toDate, ymd, yuan } from "./util.js";

export function addDays(date, k) { const d = toDate(date); d.setDate(d.getDate() + k); return ymd(d); }
export function mondayOf(date) { const d = toDate(date); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); }
// 数据里最近一个完整的周（周一到周日）
export function lastFullWeek(lastDate) { const m = mondayOf(lastDate); return lastDate === addDays(m, 6) ? m : addDays(m, -7); }
export const weekLabel = (w) => `${Number(w.slice(5, 7))}/${Number(w.slice(8))}–${Number(addDays(w, 6).slice(5, 7))}/${Number(addDays(w, 6).slice(8))}`;

const inWeek = (t, w) => t.date >= w && t.date <= addDays(w, 6);
const BIG_EXCLUDE = /旅游|度假/; // 和可砍清单的“冲动大额”一致：旅行有自己的年度预算

// 目标的范围：{cat:"餐饮/外卖"} 一个二级分类；{kind:"daily"} 一个象限；{big:2000} 非刚性的大额单笔
function matches(t, scope, kinds) {
  if (!isSpend(t)) return false;
  if (scope.cat) return `${t.cat1}/${t.cat2}` === scope.cat;
  if (scope.kind) return kindOf(t, kinds) === scope.kind;
  if (scope.big) return t.type === "expense" && t.amount >= scope.big && kindOf(t, kinds) !== "rigid" && !BIG_EXCLUDE.test(t.cat2);
  return false;
}

// 一个目标在某一周的完成情况。dataUntil 早于周日时 final=false（还在进行中）
export function evalGoal(g, txs, kinds, week, checks = {}, dataUntil = "") {
  const final = dataUntil >= addDays(week, 6);
  if (g.type === "manual") return { done: !!checks[`${week}|${g.id}`], actual: null, final: true };
  const ts = txs.filter((t) => inWeek(t, week) && matches(t, g.scope || {}, kinds));
  const actual = g.metric === "count" ? ts.filter((t) => t.type === "expense").length : sum(ts, spend);
  return { done: actual <= g.limit, actual, final };
}

export const goalActual = (g, e) => (e.actual === null ? "" : g.metric === "count" ? `${e.actual} 次` : yuan(e.actual));

export function weekStats(txs, kinds, plan, week) {
  const spendTx = txs.filter(isSpend);
  const first = spendTx.reduce((m, t) => (t.date < m ? t.date : m), "9999");
  // 前面最多 8 个完整周（第一周的数据不满一周就不算）
  const prior = [];
  for (let k = 1; k <= 8; k++) { const w = addDays(week, -7 * k); if (w < first) break; prior.push(w); }
  const cur = spendTx.filter((t) => inWeek(t, week));
  const priorTx = prior.length ? spendTx.filter((t) => t.date >= prior[prior.length - 1] && t.date < week) : [];
  const n = prior.length || 1;
  const byWeek = groupBy(priorTx, (t) => mondayOf(t.date));
  const priorTotals = prior.map((w) => sum(byWeek.get(w) || [], spend));

  const cats = new Map();
  const cat = (t) => {
    const k = `${t.cat1}/${t.cat2}`;
    if (!cats.has(k)) cats.set(k, { cat: k, cat2: t.cat2, kind: kindOf(t, kinds), week: 0, count: 0, prior: 0, priorCount: 0 });
    return cats.get(k);
  };
  for (const t of cur) { const c = cat(t); c.week += spend(t); if (t.type === "expense") c.count++; }
  for (const t of priorTx) { const c = cat(t); c.prior += spend(t); if (t.type === "expense") c.priorCount++; }
  const byCat = [...cats.values()].map((c) => ({ ...c, avg: c.prior / n, avgCount: c.priorCount / n }))
    .filter((c) => c.week > 0 || c.avg >= 50).sort((a, b) => b.week - a.week || b.avg - a.avg);

  return {
    week, end: addDays(week, 6), total: sum(cur, spend), count: cur.filter((t) => t.type === "expense").length,
    daily: sum(cur.filter((t) => kindOf(t, kinds) === "daily"), spend),
    quota: plan ? (plan.cardMonthly * 12) / 52 : 0,
    avg: prior.length ? sum(priorTotals) / prior.length : null, weeks: prior.length,
    trend: [...prior].reverse().map((w, i) => ({ week: w, total: priorTotals[prior.length - 1 - i] })).concat({ week, total: sum(cur, spend) }),
    byCat, big: cur.filter((t) => matches(t, { big: DEFAULTS.bigMin }, kinds)).sort((a, b) => b.amount - a.amount),
  };
}

// 本周目标候选：消费卡、无感支出的周上限（金额或次数）、不买大件，加上几个一次性动作
export function goalCandidates({ kinds, plan, opps, statuses, cooling }, stats) {
  const out = [];
  const st = (o) => statuses[o.id] || "todo";
  if (plan?.cardMonthly > 0) {
    const limit = round(stats.quota, 10);
    out.push({ id: "card", type: "cap", scope: { kind: "daily" }, metric: "amount", limit,
      text: `消费卡：高频弹性支出这周不超过 ${yuan(limit)}`, basis: `上周 ${yuan(stats.daily)}，月额度 ${yuan(plan.cardMonthly)} 折合每周 ${yuan(limit)}` });
  }
  for (const o of opps.filter((o) => o.type === "small" && st(o) !== "ignored")) {
    const c = stats.byCat.find((x) => x.cat === o.key);
    if (!c || c.avg <= 0) continue;
    const limit = round(c.avg * (1 - DEFAULTS.smallCut), 10);
    out.push({ id: `cap|${o.key}`, type: "cap", scope: { cat: o.key }, metric: "amount", limit,
      text: `${c.cat2}这周不超过 ${yuan(limit)}`, basis: `前 ${stats.weeks} 周平均每周 ${yuan(c.avg)}，上周 ${yuan(c.week)}`, saving: round((c.avg - limit) * 52) });
    if (c.avgCount >= 3) {
      const cnt = Math.floor(c.avgCount * (1 - DEFAULTS.smallCut));
      out.push({ id: `count|${o.key}`, type: "cap", scope: { cat: o.key }, metric: "count", limit: cnt,
        text: `${c.cat2}这周不超过 ${cnt} 次`, basis: `前 ${stats.weeks} 周平均每周 ${c.avgCount.toFixed(1)} 次，上周 ${c.count} 次` });
    }
  }
  const imp = opps.find((o) => o.type === "impulse");
  if (imp) {
    out.push({ id: "nobig", type: "cap", scope: { big: DEFAULTS.bigMin }, metric: "count", limit: 0,
      text: `这周不买 ${yuan(DEFAULTS.bigMin)} 以上的非必需品，真想买先放进冷静期`, basis: `过去一年这样的消费 ${imp.detail.items.length} 笔，共 ${yuan(imp.annual)}；上周 ${stats.big.length} 笔` });
    const left = imp.detail.items.filter((t) => !t.review).length;
    if (left) out.push({ id: "review-impulse", type: "manual", text: `在「可砍清单」里复盘 ${Math.min(left, 5)} 笔大额消费：值不值？`, basis: `还有 ${left} 笔没复盘` });
  }
  for (const o of opps.filter((o) => o.type === "subscription" && st(o) === "doing")) {
    out.push({ id: `cancel|${o.key}`, type: "manual", text: `取消「${o.title}」的自动续费`, basis: `一年 ${yuan(o.saving)}`, saving: round(o.saving) });
  }
  for (const o of opps.filter((o) => (o.type === "audit" || o.type === "inflate") && st(o) !== "ignored").slice(0, 3)) {
    const name = o.key.split("/").pop();
    out.push({ id: `audit|${o.key}`, type: "manual", text: `花 20 分钟过一遍「${name}」：重复的、用不上的、能找平替的`, basis: o.title, saving: round(o.saving) });
  }
  const ready = cooling.filter((c) => c.status === "waiting" && Date.now() - c.at >= 72 * 3600e3);
  if (ready.length) out.push({ id: "cooling", type: "manual", text: `冷静期里有 ${ready.length} 件到期了，决定买还是不买`, basis: ready.map((c) => c.item).join("、").slice(0, 60) });
  return out;
}

// 发给 AI（以及周一定时任务）的每周汇总。和月度复盘一样，只有汇总，没有逐笔流水。
export function weeklyContext(S, week) {
  const stats = weekStats(S.txs, S.kinds, S.plan, week);
  const r = (n) => round(n);
  const prev = S.weekly.find((x) => x.week === addDays(week, -7)); // 上上周的复盘定的就是上周的目标
  const month = addDays(week, 6).slice(0, 7);
  const card = S.ledger.find((x) => x.month === month);
  return {
    week, weekRange: `${week} ~ ${addDays(week, 6)}`, dataUntil: S.ov.window.last,
    lastWeek: { total: r(stats.total), count: stats.count, cardSpend: r(stats.daily), cardWeeklyQuota: r(stats.quota),
      avgPrevWeeks: stats.avg === null ? null : r(stats.avg), prevWeeks: stats.weeks },
    byCategory: stats.byCat.slice(0, 15).map((c) => ({ category: c.cat, thisWeek: r(c.week), times: c.count, weeklyAvg: r(c.avg), timesAvg: Number(c.avgCount.toFixed(1)) })),
    bigPurchases: stats.big.slice(0, 8).map((t) => ({ date: t.date, time: t.time, amount: r(t.amount), category: t.cat2,
      ...(S.settings.shareMerchants ? { merchant: t.merchant, note: t.note.slice(0, 30) } : {}) })),
    trend: stats.trend.map((x) => ({ week: x.week, total: r(x.total) })),
    lastWeekGoals: (prev?.goals || []).map((g) => {
      const e = evalGoal(g, S.txs, S.kinds, week, S.goalChecks, S.ov.window.last);
      return { goal: g.text, result: e.done ? "达成" : "没达成", ...(e.actual === null ? {} : { actual: goalActual(g, e) }) };
    }),
    monthCard: card && { month, quota: r(card.quota), spentSoFar: r(card.spent) },
    plan: S.plan && { annualTarget: S.plan.target, baseline: S.plan.baseline, monthlyCard: S.plan.cardMonthly },
    candidates: goalCandidates(S, stats),
  };
}
