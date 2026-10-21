// 解析器与分析引擎的测试：node tests/make_fixtures.mjs && node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { CUTS, opportunities, overview, totalSaving, windowOf } from "../static/js/analyze.js";
import { demoTransactions } from "../static/js/demo.js";
import { parseCSV, parseFile, parseRows } from "../static/js/parse.js";
import { cardLedger, defaultPlan, freedomFund } from "../static/js/plan.js";
import { futureValue } from "../static/js/util.js";

const require = createRequire(import.meta.url);
const XLSX = require("../static/vendor/xlsx.full.min.js");
const fx = (name) => new URL(`../fixtures/${name}`, import.meta.url);
if (!existsSync(fx("wechat.csv"))) throw new Error("先运行 node tests/make_fixtures.mjs");
const file = (name) => ({ name, bytes: new Uint8Array(readFileSync(fx(name))) });

test("微信账单：跳过说明行、去掉 ¥、处理退款和中性交易", async () => {
  const [r] = await parseFile(file("wechat.csv"));
  assert.equal(r.source, "wechat");
  const byOrder = Object.fromEntries(r.txs.map((t) => [t.order, t]));
  assert.equal(byOrder.X1, undefined, "全额退款的不算");
  assert.equal(byOrder.X2.amount, 70, "部分退款扣掉退回的部分");
  assert.equal(byOrder.X3.type, "transfer", "零钱提现不算支出");
  assert.deepEqual([byOrder.X4.cat1, byOrder.X4.cat2], ["人情往来", "礼金红包"]);
  const takeout = r.txs.find((t) => t.merchant === "美团外卖" && t.order !== "X2");
  assert.deepEqual([takeout.cat1, takeout.cat2], ["食品酒水", "外卖"], "按商户关键词归类");
  assert.match(takeout.time, /^\d\d:\d\d$/);
});

test("支付宝账单：GBK 编码、不计收支、交易关闭", async () => {
  const [r] = await parseFile(file("alipay.csv"));
  assert.equal(r.source, "alipay");
  assert.ok(r.txs.length > 50);
  assert.equal(r.txs.find((t) => t.order === "Y1").type, "transfer");
  assert.equal(r.txs.find((t) => t.order === "Y2"), undefined);
  assert.ok(r.txs.some((t) => t.cat2 === "会员订阅"), "爱奇艺等归到会员订阅");
});

test("随手记 Excel：多个工作表、保留用户自己的分类", async () => {
  const sheets = await parseFile(file("suishouji.xlsx"), XLSX);
  assert.deepEqual(sheets.map((s) => s.sheetName), ["支出", "收入", "转账"]);
  assert.ok(sheets.every((s) => s.txs.every((t) => t.source === "suishouji")));
  const exp = sheets[0].txs;
  const demo = demoTransactions().filter((t) => t.type === "expense");
  assert.equal(exp.length, demo.length);
  assert.ok(exp.every((t) => t.type === "expense"));
  assert.equal(sheets[2].txs[0].type, "transfer");
  assert.ok(exp.some((t) => t.cat1 === "子女教育" && t.cat2 === "兴趣班"));
  assert.equal(Math.round(exp.reduce((a, t) => a + t.amount, 0)), Math.round(demo.reduce((a, t) => a + t.amount, 0)));
});

test("通用表格：负数当支出、支出/收入分两列", () => {
  const a = parseRows(parseCSV("日期,金额,备注\n2026/3/5,-35.5,星巴克\n2026/3/6,1000,退税"));
  assert.equal(a.txs[0].type, "expense");
  assert.equal(a.txs[0].amount, 35.5);
  assert.equal(a.txs[0].cat2, "咖啡奶茶");
  assert.equal(a.txs[1].type, "income");
  const b = parseRows(parseCSV("交易日期,摘要,支出金额,收入金额\n2026-03-05,滴滴出行,23.00,\n2026-03-06,工资,,30000"));
  assert.deepEqual(b.txs.map((t) => t.type), ["expense", "income"]);
});

test("CSV：引号里的逗号和换行", () => {
  assert.deepEqual(parseCSV('a,"b,c","d\ne"\n1,2,3'), [["a", "b,c", "d\ne"], ["1", "2", "3"]]);
});

const txs = demoTransactions();
const ov = overview(txs);
const opps = opportunities(txs);

test("分析窗口：最后一个月不满就往前推一个月；同比按日历年的同期", () => {
  const w = windowOf(txs);
  assert.deepEqual({ ...w, ytd: undefined }, { start: "2025-10", end: "2026-09", months: 12, scale: 1, first: "2021-01", firstFull: "2021-01", last: "2026-10-19", ytd: undefined });
  assert.deepEqual(w.ytd, { year: "2026", start: "2026-01", end: "2026-09", months: 9, prevStart: "2025-01", prevEnd: "2025-09", hasPrev: true, label: "2026 年 1–9 月" });
  assert.ok(ov.last12 > 380000 && ov.last12 < 500000, String(ov.last12));
  const sumYtd = txs.filter((t) => t.type === "expense" && t.date >= "2026-01" && t.date < "2026-10").reduce((a, t) => a + t.amount, 0);
  assert.ok(Math.abs(ov.ytd.expense - sumYtd) < 1);
  assert.ok(Math.abs(ov.cats.reduce((a, c) => a + c.ytdPrev, 0) - ov.ytd.prevExpense) < 1, "分类加起来等于去年同期合计");
});

test("1、2 月同期太短：改成去年全年对比前年全年", () => {
  const feb = txs.filter((t) => t.date < "2026-02-27");
  const y = windowOf(feb).ytd;
  assert.equal(y.label, "2025 年全年");
  assert.deepEqual([y.prevStart, y.prevEnd, y.hasPrev], ["2024-01", "2024-12", true]);
});

test("只有几个月的数据：按月份折算成一年，不做同比", () => {
  const short = txs.filter((t) => t.date >= "2026-07-01");
  const w = windowOf(short);
  assert.equal(w.start, "2026-07");
  assert.equal(w.months, 3);
  assert.equal(w.ytd.hasPrev, false);
  const o = overview(short);
  const raw = short.filter((t) => t.type === "expense" && t.date < "2026-10").reduce((a, t) => a + t.amount, 0);
  assert.ok(Math.abs(o.last12 - raw * 4) < 1);
  assert.ok(!opportunities(short).some((x) => x.type === "inflate"));
});

test("可砍清单：找到订阅（含涨过价的）、无感支出、单价审计，不把房贷、兴趣班月费当订阅", () => {
  const titles = opps.map((o) => `${o.type}:${o.title}`);
  for (const name of ["腾讯视频", "iCloud+", "威尔仕健身", "B站大会员"]) assert.ok(titles.some((t) => t.startsWith("subscription:") && t.includes(name)), name);
  assert.ok(!titles.some((t) => t.startsWith("subscription:") && /银行按揭|物业|钢琴|猫粮|体检/.test(t)), "房贷、物业、钢琴课、猫粮、体检不是订阅");
  assert.ok(titles.some((t) => t.startsWith("small:外卖")));
  assert.ok(titles.some((t) => t.startsWith("audit:兴趣班")));
  assert.ok(titles.some((t) => t.startsWith("inflate:兴趣班") && t.includes("比去年同期")));
});

test("大额支出：阈值可调，固定刚性不算，按金额从大到小", () => {
  const big = opps.find((o) => o.type === "big");
  const items = big.detail.items;
  assert.ok(items.length >= 10 && items.every((t) => t.amount >= 2000));
  assert.ok(!items.some((t) => /按揭|保险/.test(t.cat2)), "按揭、保险是固定刚性");
  assert.ok(items.every((t, i) => !i || items[i - 1].amount >= t.amount));
  const big5k = opportunities(txs, { opts: { bigMin: 5000 } }).find((o) => o.type === "big");
  assert.ok(big5k.detail.items.length < items.length && big5k.detail.items.every((t) => t.amount >= 5000));
  assert.ok(!("flags" in items[0]), "不再标深夜下单：记账时间不是消费时间");
});

test("决定去做的力度：默认不一刀砍掉，可以选", () => {
  const inf = opps.find((o) => o.type === "inflate");
  assert.equal(inf.cut, CUTS.inflate.def);
  assert.ok(inf.cut < 1, "默认只压一半涨幅");
  const full = opportunities(txs, { cuts: { [inf.id]: 1 } }).find((o) => o.id === inf.id);
  assert.ok(Math.abs(full.saving - inf.saving * 2) < 1);
  const small = opps.find((o) => o.type === "small");
  assert.ok(Math.abs(small.saving - small.annual * CUTS.small.def) < 1);
  const bogus = opportunities(txs, { cuts: { [small.id]: 0.77 } }).find((o) => o.id === small.id);
  assert.equal(bogus.cut, CUTS.small.def, "不在选项里的值回到默认");
});

test("合计可省：同一笔交易只算一次，忽略的不算，复盘为不值的计入", () => {
  const all = totalSaving(txs, opps);
  assert.ok(all > 20000 && all < 100000, String(all));
  assert.ok(all <= opps.reduce((a, o) => a + o.saving, 0) + 1);
  const one = opps.find((o) => o.type === "small");
  assert.ok(Math.abs(totalSaving(txs, [one]) - one.saving) < 1, "单独一条就等于它自己的可省");
  const ignored = Object.fromEntries(opps.map((o) => [o.id, "ignored"]));
  assert.equal(totalSaving(txs, opps, ignored), 0);
  const big = opps.find((o) => o.type === "big");
  const t = big.detail.items[0];
  const reviewed = opportunities(txs, { reviews: { [t.id]: "no" } }).find((o) => o.type === "big");
  assert.equal(reviewed.saving, t.amount);
});

test("消费卡：超支最多扣 30%，额度不会被扣到 0", () => {
  const plan = { ...defaultPlan(txs, ov, 80000, {}, opps), cardMonthly: 3000 };
  const ledger = cardLedger(txs, plan);
  assert.ok(ledger.length >= 12);
  assert.ok(ledger.every((r) => r.quota >= 3000 * 0.7 - 0.01));
});

test("自由基金：年金终值", () => {
  assert.equal(Math.round(futureValue(100000, 0.1, 10)), 1593742);
  const plan = { ...defaultPlan(txs, ov, 80000, {}, opps), goalAmount: 500000 };
  const f = freedomFund(txs, plan, ov, []);
  assert.ok(f.yearsToGoal > 0 && f.yearsToGoal < 10);
});
