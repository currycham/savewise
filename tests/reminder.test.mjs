// 提醒邮件内容的测试：node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { opportunities, overview } from "../static/js/analyze.js";
import { demoTransactions } from "../static/js/demo.js";
import { REMINDER_DEFAULTS, periodMid, plainGoal, reminderNote } from "../static/js/reminder.js";

const TODAY = "2026-10-08";
function demoState(cadence = "month") {
  const txs = demoTransactions();
  const goals = [
    { id: "cap|餐饮美食/外卖", type: "cap", scope: { cat: "餐饮美食/外卖" }, metric: "amount", limit: 700, text: "外卖这个月不超过 ¥700" },
    { id: "nobig", type: "cap", scope: { big: 2000 }, metric: "count", limit: 1, text: "这个月 ¥2,000 以上的非必需品不超过 1 笔，真想买先放进冷静期" },
    { id: "cancel|x", type: "manual", text: "取消「爱奇艺」的自动续费", basis: "一年 ¥248" },
  ];
  return { txs, ov: overview(txs), opps: opportunities(txs), kinds: {}, statuses: {},
    recaps: [{ period: "2026-09", goals }], settings: { cadence, bigMin: 2000 } };
}
const text = (sections) => sections.flatMap((s) => [s.title, ...s.lines]).join("\n");

test("期中那天：周四、月中、季度中", () => {
  assert.equal(periodMid("2026-10-19"), "2026-10-22");
  assert.equal(periodMid("2026-10"), "2026-10-16");
  assert.equal(periodMid("2026-02"), "2026-02-15");
  assert.equal(periodMid("2026-Q4"), "2026-11-16");
});

test("默认只带文字：有目标、续费、去年这时候，任何一行都没有金额", () => {
  const note = reminderNote(demoState(), REMINDER_DEFAULTS, TODAY);
  assert.equal(note.period, "2026-10");
  assert.equal(note.level, "text");
  const t = text(note.final);
  assert.match(t, /外卖控制在定好的上限以内/);
  assert.match(t, /少买大件/);
  assert.match(t, /取消「爱奇艺」的自动续费/);
  assert.ok(note.final.some((s) => s.title === "2026 年 11 月要留意的扣费"), t);
  assert.ok(note.final.some((s) => s.title === "去年这时候"), t);
  assert.doesNotMatch(t, /¥|\d{3,}元/, "不带金额");
  assert.equal(note.mid, null, "默认不要期中提醒");
  for (const s of note.final) {
    assert.ok(s.title.length <= 40 && s.lines.length <= 8);
    for (const x of s.lines) assert.ok(x.length <= 160, x);
  }
});

test("带金额：目标原文、续费和去年的金额都在", () => {
  const note = reminderNote(demoState(), { ...REMINDER_DEFAULTS, level: "amounts" }, TODAY);
  const t = text(note.final);
  assert.match(t, /外卖这个月不超过 ¥700/);
  assert.match(t, /¥/);
});

test("期中提醒：期中之前才有；勾掉的部分不出现", () => {
  const S = demoState();
  const prefs = { ...REMINDER_DEFAULTS, mid: true, upcoming: false, lastyear: false };
  const note = reminderNote(S, prefs, TODAY);
  assert.ok(note.mid?.length);
  assert.equal(note.final.length, 1);
  assert.equal(reminderNote(S, prefs, "2026-10-20").mid, null, "期中已经过了");
  assert.equal(reminderNote(S, { ...prefs, goals: false }, TODAY).final.length, 0);
});

test("目标是上一期的复盘定的；这期没复盘就不带目标", () => {
  const S = demoState();
  const note = reminderNote(S, REMINDER_DEFAULTS, "2026-11-03");
  assert.equal(note.period, "2026-11");
  assert.ok(!note.final.some((s) => s.title.includes("目标")));
});

test("不带金额的目标说法", () => {
  assert.equal(plainGoal({ id: "card", type: "cap", metric: "amount", text: "消费卡：高频弹性支出这个月不超过 ¥3,000" }, "月"), "消费卡：高频弹性支出这月不超出额度");
  assert.equal(plainGoal({ id: "count|x", type: "cap", metric: "count", text: "外卖这个月不超过 8 次" }, "月"), "外卖这个月不超过 8 次");
});
