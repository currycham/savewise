// 定期复盘与云同步的测试：node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveKeys, mergeBundles, seal, unseal } from "../static/js/account.js";
import { opportunities, overview, totalSaving } from "../static/js/analyze.js";
import { demoTransactions } from "../static/js/demo.js";
import { cardLedger, defaultPlan } from "../static/js/plan.js";
import { addDays, evalGoal, goalCandidates, lastFullPeriod, lastFullWeek, mondayOf, periodContext, periodEnd, periodName, periodOf, periodStart, periodStats, shiftPeriod } from "../static/js/review.js";

const TODAY = "2026-10-21";
function demoState() {
  const txs = demoTransactions();
  const ov = overview(txs);
  const opps = opportunities(txs);
  const plan = defaultPlan(txs, ov, totalSaving(txs, opps), {}, opps);
  return { txs, ov, opps, plan, kinds: {}, statuses: {}, reviews: {}, cooling: [], recaps: [], goalChecks: {},
    ledger: cardLedger(txs, plan), settings: { shareMerchants: false, bigMin: 2000 } };
}

test("周的计算：周一开始，数据最后一天不是周日就复盘上一周", () => {
  assert.equal(mondayOf("2026-10-19"), "2026-10-19");
  assert.equal(mondayOf("2026-10-25"), "2026-10-19");
  assert.equal(lastFullWeek("2026-10-25"), "2026-10-19");
  assert.equal(lastFullWeek("2026-10-24"), "2026-10-12");
  assert.equal(addDays("2026-12-28", 7), "2027-01-04");
});

test("月和季度：起止、前后、名字；数据到月底前 3 天、且这个月已过完才算完整", () => {
  assert.equal(periodOf("2026-08-15", "quarter"), "2026-Q3");
  assert.deepEqual([periodStart("2026-Q3"), periodEnd("2026-Q3")], ["2026-07-01", "2026-09-30"]);
  assert.deepEqual([periodStart("2026-02"), periodEnd("2026-02")], ["2026-02-01", "2026-02-28"]);
  assert.equal(shiftPeriod("2026-01", -1), "2025-12");
  assert.equal(shiftPeriod("2026-Q1", -1), "2025-Q4");
  assert.equal(shiftPeriod("2025-Q4", 1), "2026-Q1");
  assert.equal(periodName("2026-Q3"), "2026 年第 3 季度");
  assert.equal(lastFullPeriod("2026-10-19", "month", TODAY), "2026-09");
  assert.equal(lastFullPeriod("2026-09-28", "month", TODAY), "2026-09", "28 号也算导完了");
  assert.equal(lastFullPeriod("2026-09-20", "month", TODAY), "2026-08");
  assert.equal(lastFullPeriod("2026-10-30", "month", "2026-10-30"), "2026-09", "这个月还没过完");
  assert.equal(lastFullPeriod("2026-10-19", "quarter", TODAY), "2026-Q3");
});

test("按月复盘：和前 6 个月比、和去年同月比，分类加起来等于合计", () => {
  const S = demoState();
  const key = lastFullPeriod(S.ov.window.last, "month", TODAY);
  const st = periodStats(S.txs, S.kinds, S.plan, key);
  assert.equal(st.periods, 6);
  assert.equal(st.trend.length, 7);
  assert.equal(st.yoyKey, "2025-09");
  assert.ok(st.yoy > 0 && st.avg > 0);
  assert.ok(Math.abs(st.quota - S.plan.cardMonthly) < 1e-6, "按月的消费卡额度就是月额度");
  assert.ok(Math.abs(st.byCat.reduce((s, c) => s + c.cur, 0) - st.total) < 0.01);
  const wk = periodStats(S.txs, S.kinds, S.plan, lastFullWeek(S.ov.window.last));
  assert.equal(wk.periods, 8);
  assert.equal(wk.yoy, null, "按周不看去年同期");
  assert.ok(Math.abs(wk.quota - (S.plan.cardMonthly * 12) / 52) < 1e-6);
  const q = periodStats(S.txs, S.kinds, S.plan, "2026-Q3");
  assert.ok(Math.abs(q.quota - S.plan.cardMonthly * 3) < 1e-6);
});

test("目标候选：都能判定，金额上限低于平均，次数目标是整数，文字跟周期走", () => {
  const S = demoState();
  const key = lastFullPeriod(S.ov.window.last, "month", TODAY);
  const st = periodStats(S.txs, S.kinds, S.plan, key);
  const cands = goalCandidates(S, st);
  assert.ok(cands.length >= 4);
  assert.equal(new Set(cands.map((c) => c.id)).size, cands.length, "id 不重复");
  assert.ok(cands.every((c) => !c.text.includes("这周")), "按月的目标不说“这周”");
  for (const c of cands.filter((c) => c.id.startsWith("cap|"))) {
    const cat = st.byCat.find((x) => x.cat === c.scope.cat);
    assert.ok(c.limit < cat.avg, `${c.text} 应低于平均`);
  }
  for (const c of cands.filter((c) => c.metric === "count")) assert.ok(Number.isInteger(c.limit));
  // 自动判定：把上限设成实际值，正好达成；再低 1 块就没达成
  const card = cands.find((c) => c.id === "card");
  const e = evalGoal({ ...card, limit: st.daily }, S.txs, S.kinds, key, {}, S.ov.window.last);
  assert.equal(e.done, true);
  assert.equal(e.final, true);
  assert.equal(evalGoal({ ...card, limit: st.daily - 1 }, S.txs, S.kinds, key).done, false);
  // 这个月还在进行中
  assert.equal(evalGoal(card, S.txs, S.kinds, shiftPeriod(key, 1), {}, S.ov.window.last).final, false);
  const manual = { id: "m", type: "manual", text: "x" };
  assert.equal(evalGoal(manual, S.txs, S.kinds, key, { [`${key}|m`]: true }).done, true);
});

test("复盘汇总发给 AI：不含逐笔流水，不超过服务器上限，带上一期目标结果", () => {
  const S = demoState();
  for (const cad of ["week", "month", "quarter"]) {
    const key = lastFullPeriod(S.ov.window.last, cad, TODAY);
    S.recaps = [{ period: shiftPeriod(key, -1), goals: [{ id: "card", type: "cap", scope: { kind: "daily" }, metric: "amount", limit: 1, text: "消费卡" }] }];
    const ctx = periodContext(S, key);
    const text = JSON.stringify(ctx);
    assert.equal(ctx.cadence, cad);
    assert.ok(text.length < 40000, `汇总 ${text.length} 字`);
    assert.equal(ctx.lastGoals[0].result, "没达成");
    assert.ok(!/"merchant"/.test(text), "关掉“包含商户名”后不发商户");
    assert.ok(!/"id":"[a-z0-9]{8,}"/.test(text), "不发交易 ID");
  }
});

test("加密同步：同一个密码解得开，换个密码解不开；登录口令和数据密钥不同", async () => {
  const a = await deriveKeys("Me@Example.com ", "correct horse");
  const b = await deriveKeys("me@example.com", "correct horse");
  assert.equal(a.auth, b.auth, "邮箱大小写和空格不影响");
  assert.match(a.auth, /^[0-9a-f]{64}$/);
  const data = { datasets: [{ id: "d1" }], tx: { d1: demoTransactions().slice(0, 500) } };
  const sealed = await seal(data, a.key);
  assert.ok(!sealed.data.includes("美团"), "密文里看不到明文");
  assert.deepEqual(await unseal(sealed, b.key), data);
  const wrong = await deriveKeys("me@example.com", "wrong");
  await assert.rejects(unseal(sealed, wrong.key), /解不开/);
});

test("合并两台设备的数据：流水按 ID 去重，本机优先，手动改过的计划优先", () => {
  const t = (id, date = "2026-01-01") => ({ id, date, amount: 1 });
  const local = { datasets: [{ id: "L", count: 2 }, { id: "S" }], tx: { L: [t("a"), t("b")], S: [t("x")] },
    statuses: { o1: "doing" }, cooling: [{ id: "c1", status: "skipped" }], plan: { auto: true, target: 1 } };
  const cloud = { datasets: [{ id: "C" }, { id: "S" }], tx: { C: [t("b"), t("c")], S: [t("x")] },
    statuses: { o1: "ignored", o2: "doing" }, cooling: [{ id: "c1", status: "waiting" }, { id: "c2" }], plan: { auto: false, target: 2 } };
  const m = mergeBundles(local, cloud);
  const ids = Object.values(m.tx).flat().map((x) => x.id).sort();
  assert.deepEqual(ids, ["a", "b", "c", "x"]);
  assert.equal(m.datasets.find((d) => d.id === "L").count, 1, "本机数据集只留云端没有的交易");
  assert.deepEqual(m.statuses, { o1: "doing", o2: "doing" });
  assert.equal(m.cooling.find((c) => c.id === "c1").status, "skipped");
  assert.equal(m.cooling.length, 2);
  assert.equal(m.plan.target, 2, "云端手动改过的计划优先于本机自动生成的");
  const r = mergeBundles({ recaps: [{ period: "2026-09", headline: "本机" }] }, { recaps: [{ period: "2026-09", headline: "云端" }, { period: "2026-08" }] });
  assert.deepEqual(r.recaps.map((x) => x.headline || x.period).sort(), ["2026-08", "本机"], "复盘按期合并，本机优先");
});
