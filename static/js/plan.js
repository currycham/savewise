// 节流计划：年度目标、每月消费卡（“利润薪俸制”用在支出端）、偶发大额的年度预算、自由基金。
import { isSpend, kindOf, spend, windowOf } from "./analyze.js";
import { addMonths, futureValue, groupBy, monthOf, monthRange, round, sum } from "./util.js";

export function defaultPlan(txs, ov, savingEstimate, kinds = {}, opps = []) {
  const w = ov.window;
  const daily = sum(txs.filter((t) => isSpend(t) && monthOf(t.date) >= w.start && monthOf(t.date) <= w.end && kindOf(t, kinds) === "daily"), spend) * w.scale;
  return {
    baseline: round(ov.last12, 100),                       // 定计划时过去 12 个月的支出
    target: round(ov.last12 - savingEstimate, 10000),       // 年度支出目标
    // 每月消费卡额度（高频弹性）：月均减去“无感支出”能省的部分，先定一个够得着的
    cardMonthly: round((daily - sum(opps.filter((o) => o.type === "small"), (o) => o.saving)) / 12, 500),
    startMonth: addMonths(w.end, 1),                        // 从下个月开始执行
    lumpyCaps: {},                                          // 偶发大额：二级分类 -> 年度预算
    rate: 0.06, years: 5,                                    // 自由基金：年化收益、年限
    goal: "", goalAmount: 0,                                 // 五年后想过的生活、需要多少钱
  };
}

const MAX_DEDUCT = 0.3;

// 消费卡：每月 1 号发额度，只管高频弹性支出；超支从下月扣，结余转进自由基金
export function cardLedger(txs, plan, kinds = {}) {
  const w = windowOf(txs);
  if (!w) return [];
  const lastMonth = monthOf(w.last);
  // 计划开始前的月份按“如果当时这么做”模拟，至少看过去 12 个月
  const from = plan.startMonth < w.start ? plan.startMonth : w.start;
  const byMonth = groupBy(txs.filter((t) => isSpend(t) && kindOf(t, kinds) === "daily"), (t) => monthOf(t.date));
  let carry = 0;
  return monthRange(from, lastMonth).map((m) => {
    const quota = Math.max(0, plan.cardMonthly + carry);
    const spent = sum(byMonth.get(m) || [], spend);
    const left = quota - spent;
    // 超支扣下月，但最多扣掉额度的 30%：扣太狠下个月必然再超，会越滚越大，人就放弃了
    carry = left < 0 ? Math.max(left, -plan.cardMonthly * MAX_DEDUCT) : 0;
    const banked = left > 0 ? left : 0;     // 结余进自由基金
    return { month: m, quota, spent, left, banked, partial: m === lastMonth && Number(w.last.slice(8)) < 25, simulated: m < plan.startMonth };
  });
}

// 偶发大额：本自然年已用 vs 年度预算
export function lumpyStatus(txs, plan, opps, kinds = {}) {
  const w = windowOf(txs);
  if (!w) return [];
  const year = w.last.slice(0, 4);
  const lumpy = txs.filter((t) => isSpend(t) && kindOf(t, kinds) === "lumpy");
  return [...groupBy(lumpy, (t) => t.cat2)].map(([cat2, ts]) => {
    const last12 = sum(ts.filter((t) => monthOf(t.date) >= w.start && monthOf(t.date) <= w.end), spend) * w.scale;
    const suggested = opps.find((o) => o.type === "lumpy" && o.key === cat2)?.detail.budget ?? round(last12, 1000);
    const cap = plan.lumpyCaps[cat2] ?? suggested;
    const used = sum(ts.filter((t) => t.date.startsWith(year)), spend);
    return { cat2, cat1: ts[0].cat1, last12, cap, used, year };
  }).filter((x) => x.last12 > 0 || x.used > 0).sort((a, b) => b.last12 - a.last12);
}

// 自由基金：计划每年少花的钱 + 已经兑现的节省，按年化收益复利
export function freedomFund(txs, plan, ov, ledger) {
  const annualSaving = Math.max(0, plan.baseline - plan.target);
  // 已兑现：计划开始以来，每个完整月比基线月均少花的部分
  const w = ov.window;
  const months = plan.startMonth <= w.end ? monthRange(plan.startMonth, w.end) : [];
  const byMonth = groupBy(txs.filter(isSpend), (t) => monthOf(t.date));
  const realized = sum(months, (m) => plan.baseline / 12 - sum(byMonth.get(m) || [], spend));
  const projection = [1, 3, 5, 10, 20].map((y) => ({ years: y, value: futureValue(annualSaving, plan.rate, y) }));
  // 达成目标金额需要几年
  let yearsToGoal = null;
  if (plan.goalAmount > 0 && annualSaving > 0) {
    for (let y = 1; y <= 50; y++) if (futureValue(annualSaving, plan.rate, y) >= plan.goalAmount) { yearsToGoal = y; break; }
  }
  return {
    annualSaving, realized, realizedMonths: months.length, projection, yearsToGoal,
    cardBanked: sum(ledger.filter((r) => !r.simulated), (r) => r.banked),
  };
}
