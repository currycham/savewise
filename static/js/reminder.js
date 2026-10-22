// 提醒邮件里写什么：浏览器从历史数据里算好几行字，用户看过原文、勾选后才上传。
// 服务器只存这几行字，到期发出就删掉；默认不带金额。
// 期末那封是下一期初才发出的，标题里写明哪一期，不用“这个月”“下个月”。
// 一份提醒对应“这一期”（日历上今天所在的期）：
//   期末那封（final）：这一期的目标完成了没有、下一期要留意的扣费、去年下一期的情况
//   期中那封（mid，可选）：这一期剩下的日子里要留意的扣费、目标还记得吗
import { isSpend, kindOf, spend } from "./analyze.js";
import { CADENCES, addDays, cadenceOf, periodEnd, periodName, periodOf, periodStart, shiftPeriod } from "./review.js";
import { addMonths, daysBetween, groupBy, sum, ymd, yuan } from "./util.js";

export const LEVELS = { none: "不带内容", text: "只带文字，不带金额", amounts: "带金额" };
export const PARTS = { goals: "我的目标", upcoming: "续费和到期", lastyear: "去年这时候" };
export const REMINDER_DEFAULTS = { level: "text", goals: true, upcoming: true, lastyear: true, mid: false, auto: true, everSaved: false };
// auto：保存过一次之后，每次生成复盘按同样的勾选自动更新（everSaved 之前不会自动上传任何东西）

// 期中那天：周四、每月 16 号左右、季度第 46 天左右（服务器 review.period_mid 用同样的算法）
export function periodMid(key) {
  const a = periodStart(key);
  return addDays(a, Math.floor((daysBetween(a, periodEnd(key)) + 1) / 2));
}

const lastYear = (d) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
const nextYear = (d) => `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;
const mmdd = (d) => `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8))} 日`;
const stripYuan = (s) => s.replace(/（[^）]*¥[^）]*）/g, "").replace(/\s*¥[\d,.]+万?\s*/g, "");

// 不带金额的目标说法
export function plainGoal(g, unit) {
  if (g.id === "card") return `消费卡：高频弹性支出这${unit}不超出额度`;
  if (g.id === "nobig") return `这${unit}少买大件，真想买先放进冷静期`;
  if (g.type === "cap" && g.metric === "amount" && g.scope?.cat) return `${g.scope.cat.split("/").pop()}控制在定好的上限以内`;
  return stripYuan(g.text);
}

// [a, b] 这段日子里要留意的扣费：按年续费的订阅、去年这时候交过的大额
function upcoming(S, a, b, amounts, { monthly }) {
  const lines = [];
  const subs = S.opps.filter((o) => o.type === "subscription" && (S.statuses[o.id] || "todo") !== "ignored");
  const due = subs.filter((o) => o.detail.period === "yearly").map((o) => {
    let e = nextYear(o.detail.lastDate);
    while (e < a) e = nextYear(e);
    return { o, e };
  }).filter((x) => x.e <= b).sort((x, y) => (x.e < y.e ? -1 : 1));
  for (const { o, e } of due) {
    lines.push(`${mmdd(e)}前后：${o.title}的年费${amounts ? `（去年 ${yuan(o.detail.latest)}）` : ""}要续了，不用的话先取消自动续费`);
  }
  const mon = subs.filter((o) => o.detail.period === "monthly");
  if (monthly && mon.length) {
    lines.push(`每月自动续费：${mon.slice(0, 6).map((o) => o.title).join("、")}${amounts ? `（合计每月 ${yuan(sum(mon, (o) => o.detail.latest))}）` : ""}，用不上的可以停掉`);
  }
  // 去年同一段日子里的大额：保险、学费这类固定支出今年大概率还要交
  const subKeys = new Set(subs.map((o) => o.key));
  const la = lastYear(a), lb = lastYear(b);
  const big = S.txs.filter((t) => t.type === "expense" && t.date >= la && t.date <= lb && t.amount >= S.settings.bigMin
    && kindOf(t, S.kinds) !== "daily" && !subKeys.has(`${t.merchant}|${t.cat2}`));
  // 按揭、房租这种每个月都有的不用提醒：去年一年里有大额的月份超过 3 个就跳过
  const yearBig = S.txs.filter((t) => t.type === "expense" && t.amount >= S.settings.bigMin && t.date > lastYear(lb) && t.date <= lb);
  const months = groupBy(yearBig, (t) => t.cat2);
  const fixed = [], other = [];
  for (const [cat2, ts] of groupBy(big, (t) => t.cat2)) {
    if (new Set((months.get(cat2) || []).map((t) => t.date.slice(0, 7))).size > 3) continue;
    const k = kindOf(ts[0], S.kinds);
    (k === "rigid" || k === "fixedFlex" ? fixed : other).push({ cat2, total: sum(ts, (t) => t.amount) });
  }
  const names = (xs) => xs.sort((x, y) => y.total - x.total).slice(0, 4).map((x) => `${x.cat2}${amounts ? `（${yuan(x.total)}）` : ""}`).join("、");
  if (fixed.length) lines.push(`去年这时候交过${names(fixed)}，今年大概率还要交，提前留好钱`);
  return { lines, other: other.length ? names(other) : "" };
}

// 去年同一期比当时的平时（截至那一期的 12 个月平均）多花还是少花、花在哪（按月、按季度才看）
function lastYearLine(S, key, amounts) {
  const cad = cadenceOf(key);
  if (cad === "week") return "";
  const yk = shiftPeriod(key, cad === "month" ? -12 : -4), n = cad === "month" ? 1 : 3;
  const from = `${addMonths(periodEnd(yk).slice(0, 7), -11)}-01`, to = periodEnd(yk);
  const spendTx = S.txs.filter(isSpend);
  if (!spendTx.some((t) => t.date < `${addMonths(from.slice(0, 7), 1)}-01`)) return ""; // 那一年的数据不全
  const ts = spendTx.filter((t) => t.date >= periodStart(yk) && t.date <= to);
  const total = sum(ts, spend);
  const normal = (sum(spendTx.filter((t) => t.date >= from && t.date <= to), spend) / 12) * n;
  if (!total || !normal) return "";
  const d = (total - normal) / normal;
  const top = [...groupBy(ts, (t) => t.cat1)].map(([c, xs]) => [c, sum(xs, spend)]).sort((x, y) => y[1] - x[1])[0];
  const how = Math.abs(d) < 0.1 ? "花得和平时差不多" : `比平时${d > 0 ? "多" : "少"}花 ${Math.round(Math.abs(d) * 100)}%`;
  const name = cad === "month" ? ` ${Number(yk.slice(5))} 月` : `第 ${yk.slice(6)} 季度`;
  return `去年${name}${how}${amounts ? `（${yuan(total)}）` : ""}，花得最多的是${top[0]}（占 ${Math.round((top[1] / total) * 100)}%）`;
}

// 这一份提醒的完整内容（用户在页面上看到的就是要上传的原文）
export function reminderNote(S, prefs, today = ymd(new Date())) {
  const cad = S.settings.cadence, C = CADENCES[cad], amounts = prefs.level === "amounts";
  const key = periodOf(today, cad), next = shiftPeriod(key, 1), mid = periodMid(key);
  const rep = S.recaps.find((r) => r.period === shiftPeriod(key, -1)); // 上一期的复盘定的就是这一期的目标
  const goals = (rep?.goals || []).map((g) => (amounts ? g.text : plainGoal(g, C.unit)));

  const final = [], half = [];
  if (prefs.goals && goals.length) {
    final.push({ title: `${periodName(key)}的目标，完成了没有？`, lines: [...goals, "导入账单后，网页会自动判定完成了没有"] });
    half.push({ title: `${C.cur}过半了，你定的目标`, lines: goals });
  }
  if (prefs.upcoming) {
    const u = upcoming(S, periodStart(next), periodEnd(next), amounts, { monthly: true });
    if (u.lines.length) final.push({ title: `${periodName(next)}要留意的扣费`, lines: u.lines });
    const h = upcoming(S, mid, periodEnd(key), amounts, { monthly: false });
    if (h.lines.length) half.push({ title: `${C.cur}剩下的日子里要留意`, lines: h.lines });
  }
  if (prefs.lastyear) {
    const lines = [lastYearLine(S, next, amounts)];
    const u = upcoming(S, periodStart(next), periodEnd(next), amounts, { monthly: false });
    if (u.other) lines.push(`去年这时候还花过：${u.other}`);
    if (lines.filter(Boolean).length) final.push({ title: "去年这时候", lines: lines.filter(Boolean) });
  }
  return {
    period: key, level: prefs.level, final,
    mid: prefs.mid && today < mid && half.length ? half : null, midDate: mid,
  };
}
