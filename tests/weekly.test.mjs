// 每周复盘与云同步的测试：node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveKeys, mergeBundles, seal, unseal } from "../static/js/account.js";
import { opportunities, overview, totalSaving } from "../static/js/analyze.js";
import { demoTransactions } from "../static/js/demo.js";
import { cardLedger, defaultPlan } from "../static/js/plan.js";
import { addDays, evalGoal, goalCandidates, lastFullWeek, mondayOf, weekStats, weeklyContext } from "../static/js/weekly.js";

function demoState() {
  const txs = demoTransactions();
  const ov = overview(txs);
  const opps = opportunities(txs);
  const plan = defaultPlan(txs, ov, totalSaving(txs, opps), {}, opps);
  return { txs, ov, opps, plan, kinds: {}, statuses: {}, reviews: {}, cooling: [], weekly: [], goalChecks: {},
    ledger: cardLedger(txs, plan), settings: { shareMerchants: false } };
}

test("周的计算：周一开始，数据最后一天不是周日就复盘上一周", () => {
  assert.equal(mondayOf("2026-10-19"), "2026-10-19");
  assert.equal(mondayOf("2026-10-25"), "2026-10-19");
  assert.equal(lastFullWeek("2026-10-25"), "2026-10-19");
  assert.equal(lastFullWeek("2026-10-24"), "2026-10-12");
  assert.equal(addDays("2026-12-28", 7), "2027-01-04");
});

test("每周汇总：上周合计、和前 8 周比、按分类", () => {
  const S = demoState();
  const week = lastFullWeek(S.ov.window.last);
  const st = weekStats(S.txs, S.kinds, S.plan, week);
  assert.equal(st.weeks, 8);
  assert.equal(st.trend.length, 9);
  assert.ok(st.total > 0 && st.avg > 0);
  assert.ok(Math.abs(st.quota - (S.plan.cardMonthly * 12) / 52) < 1e-6);
  const sumCats = st.byCat.reduce((s, c) => s + c.week, 0);
  assert.ok(Math.abs(sumCats - st.total) < 0.01, "分类加起来等于合计");
});

test("目标候选：都能判定，金额上限低于平均，次数目标是整数", () => {
  const S = demoState();
  const week = lastFullWeek(S.ov.window.last);
  const st = weekStats(S.txs, S.kinds, S.plan, week);
  const cands = goalCandidates(S, st);
  assert.ok(cands.length >= 4);
  assert.equal(new Set(cands.map((c) => c.id)).size, cands.length, "id 不重复");
  for (const c of cands.filter((c) => c.id.startsWith("cap|"))) {
    const cat = st.byCat.find((x) => x.cat === c.scope.cat);
    assert.ok(c.limit < cat.avg, `${c.text} 应低于平均`);
  }
  for (const c of cands.filter((c) => c.metric === "count")) assert.ok(Number.isInteger(c.limit));
  // 自动判定：把上限设成上周实际值，正好达成；再低 1 块就没达成
  const card = cands.find((c) => c.id === "card");
  const e = evalGoal({ ...card, limit: st.daily }, S.txs, S.kinds, week, {}, S.ov.window.last);
  assert.equal(e.done, true);
  assert.equal(e.final, true);
  assert.equal(evalGoal({ ...card, limit: st.daily - 1 }, S.txs, S.kinds, week).done, false);
  // 一次性动作看勾选
  const manual = { id: "m", type: "manual", text: "x" };
  assert.equal(evalGoal(manual, S.txs, S.kinds, week, { [`${week}|m`]: true }).done, true);
});

test("每周汇总发给 AI：不含逐笔流水，不超过服务器上限，带上周目标结果", () => {
  const S = demoState();
  const week = lastFullWeek(S.ov.window.last);
  S.weekly = [{ week: addDays(week, -7), goals: [{ id: "card", type: "cap", scope: { kind: "daily" }, metric: "amount", limit: 1, text: "消费卡" }] }];
  const ctx = weeklyContext(S, week);
  const text = JSON.stringify(ctx);
  assert.ok(text.length < 40000, `汇总 ${text.length} 字`);
  assert.equal(ctx.lastWeekGoals[0].result, "没达成");
  assert.ok(!/"merchant"/.test(text), "关掉“包含商户名”后不发商户");
  assert.ok(!/"id":"[a-z0-9]{8,}"/.test(text), "不发交易 ID");
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
});
