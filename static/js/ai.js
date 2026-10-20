// 发给 AI 的只有汇总：按月、按分类的金额，可砍清单和计划。不发逐笔流水、账户、订单号。
// 用户可以在页面上看到将要发送的完整内容。
import { api } from "./account.js";
import { TAXONOMY } from "./categorize.js";
import { isSpend, spend } from "./analyze.js";
import { addMonths, groupBy, monthOf, monthRange, round, sum } from "./util.js";

const r = (n) => round(n);

export function buildContext(S, { month } = {}) {
  const { txs, ov, opps, statuses, plan, ledger, cooling, settings } = S;
  const w = ov.window;
  const focus = month || w.end;
  const spendTx = txs.filter(isSpend);
  const byMonth = groupBy(spendTx, (t) => monthOf(t.date));
  const months = monthRange(addMonths(focus, -12), focus);
  const monthly = months.map((m) => {
    const ts = byMonth.get(m) || [];
    const cats = {};
    for (const t of ts) cats[t.cat1] = (cats[t.cat1] || 0) + spend(t);
    return { month: m, total: r(sum(ts, spend)), byCategory: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, r(v)])) };
  });
  // 关注月份的二级分类明细，以及与过去 12 个月月均的对比
  const focusTx = byMonth.get(focus) || [];
  const avgBy = {};
  for (const t of spendTx.filter((t) => monthOf(t.date) >= w.start && monthOf(t.date) <= w.end)) avgBy[`${t.cat1}/${t.cat2}`] = (avgBy[`${t.cat1}/${t.cat2}`] || 0) + spend(t) / 12;
  const focusBy = {};
  for (const t of focusTx) focusBy[`${t.cat1}/${t.cat2}`] = (focusBy[`${t.cat1}/${t.cat2}`] || 0) + spend(t);
  const focusDetail = Object.keys({ ...focusBy, ...avgBy }).map((k) => ({ category: k, thisMonth: r(focusBy[k] || 0), monthlyAvg12: r(avgBy[k] || 0) }))
    .filter((x) => x.thisMonth || x.monthlyAvg12 > 300).sort((a, b) => b.thisMonth - a.thisMonth).slice(0, 25);

  const ctx = {
    period: { last12Months: `${w.start} ~ ${w.end}`, focusMonth: focus, dataUntil: w.last },
    totals: { last12: r(ov.last12), previous12: r(ov.prev12), income12: r(ov.income12) },
    byYear: ov.byYear.map((y) => ({ year: y.year, expense: r(y.expense), income: r(y.income), months: y.months })),
    fourKinds12: Object.fromEntries(Object.entries(ov.kindTotals).map(([k, v]) => [{ rigid: "固定刚性", fixedFlex: "固定弹性", daily: "高频弹性", lumpy: "偶发大额" }[k], r(v)])),
    categories12: ov.cats.slice(0, 15).map((c) => ({ category: c.cat1, last12: r(c.last), previous12: r(c.before) })),
    monthly,
    focusMonthDetail: focusDetail,
    plan: plan && { annualTarget: plan.target, baseline: plan.baseline, monthlyCard: plan.cardMonthly, startMonth: plan.startMonth },
    card: ledger.slice(-6).map((x) => ({ month: x.month, quota: r(x.quota), spent: r(x.spent), simulated: x.simulated })),
    opportunities: opps.slice(0, 15).map((o) => ({ title: o.title, estimatedAnnualSaving: r(o.saving), status: { todo: "待处理", doing: "决定去做", ignored: "已忽略" }[statuses[o.id] || "todo"] })),
    coolingOff: cooling.slice(-10).map((c) => ({ item: c.item, price: c.price, status: c.status })),
  };
  const impulse = opps.find((o) => o.type === "impulse");
  if (impulse) {
    ctx.bigPurchases = impulse.detail.items.slice(0, 12).map((t) => ({
      date: t.date, time: t.time, amount: r(t.amount), category: t.cat2, flags: t.flags,
      ...(settings.shareMerchants ? { merchant: t.merchant, note: t.note.slice(0, 30) } : {}),
      userReview: { yes: "值得", no: "不值", unsure: "说不清" }[t.review] || "未复盘",
    }));
  }
  if (settings.shareMerchants) {
    const cur = spendTx.filter((t) => monthOf(t.date) >= w.start && monthOf(t.date) <= w.end && t.merchant);
    ctx.topMerchants12 = [...groupBy(cur, (t) => t.merchant)].map(([m, ts]) => ({ merchant: m, total: r(sum(ts, spend)), count: ts.length }))
      .sort((a, b) => b.total - a.total).slice(0, 20);
  }
  return ctx;
}

// AI 接口需要登录（内测期间凭邀请码注册），按用户限次
const post = (path, body) => api("POST", path, body);

export const review = (context) => post("/api/ai/review", { context });
export const chat = (context, messages) => post("/api/ai/chat", { context, messages });
export const weeklyReview = (context) => post("/api/weekly/review", { context });

// 未分类的商户交给 AI 归类：只发“交易对方 + 商品说明”文本，不发金额
export async function classifyMerchants(texts) {
  const out = {};
  for (let i = 0; i < texts.length; i += 120) {
    const batch = texts.slice(i, i + 120);
    const { items } = await post("/api/ai/classify", { items: batch, taxonomy: TAXONOMY });
    for (const it of items) out[batch[it.i]] = [it.cat1, it.cat2];
  }
  return out;
}
