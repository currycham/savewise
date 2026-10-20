// 用演示数据生成三种真实格式的导出文件，测试解析器：
//   fixtures/wechat.csv（微信支付账单，前 16 行说明）、fixtures/alipay.csv（支付宝，GBK，前 24 行说明）、
//   fixtures/suishouji.xlsx（随手记，按 支出/收入/转账 分工作表）、fixtures/wechat.zip（加密，密码 123456）
// 用法：node tests/make_fixtures.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { demoTransactions } from "../static/js/demo.js";

const require = createRequire(import.meta.url);
const XLSX = require("../static/vendor/xlsx.full.min.js");
const dir = new URL("../fixtures/", import.meta.url);
mkdirSync(dir, { recursive: true });
const all = demoTransactions();
const recent = all.filter((t) => t.date >= "2026-07-01");
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

// 微信：不区分分类，金额带 ¥，加一条全额退款、一条部分退款、一条零钱提现
const wx = [
  "微信支付账单明细,,,,,,,,", "微信昵称：[演示],,,,,,,,", "起始时间：[2026-07-01 00:00:00] 终止时间：[2026-09-30 23:59:59],,,,,,,,",
  "导出类型：[全部],,,,,,,,", "导出时间：[2026-10-01 10:00:00],,,,,,,,", ",,,,,,,,", "共1000笔记录,,,,,,,,", "收入：0笔 0.00元,,,,,,,,",
  "支出：1000笔 0.00元,,,,,,,,", "中性交易：0笔 0.00元,,,,,,,,", "注：,,,,,,,,", "1. 充值/提现/理财通购买/零钱通存取/信用卡还款等交易，将计入中性交易,,,,,,,,",
  "2. 本明细仅展示当前账单中的交易，不包括已删除的记录,,,,,,,,", "3. 本明细仅供个人对账使用,,,,,,,,", ",,,,,,,,",
  "----------------------微信支付账单明细列表--------------------,,,,,,,,",
  "交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注",
];
let n = 0;
for (const t of recent.filter((t) => t.type === "expense" && t.account === "微信")) {
  wx.push([`${t.date} ${t.time}:00`, "商户消费", t.merchant, t.note || "/", "支出", `¥${t.amount.toFixed(2)}`, "零钱", "支付成功", `42000${n++}`, `M${n}`, "/"].map(q).join(","));
}
wx.push([`2026-08-01 12:00:00`, "商户消费", "美团外卖", "/", "支出", "¥88.00", "零钱", "已全额退款", "X1", "/", "/"].map(q).join(","));
wx.push([`2026-08-02 12:00:00`, "商户消费", "美团外卖", "/", "支出", "¥100.00", "零钱", "已退款(￥30.00)", "X2", "/", "/"].map(q).join(","));
wx.push([`2026-08-03 12:00:00`, "零钱提现", "招商银行", "/", "/", "¥500.00", "零钱", "提现已到账", "X3", "/", "/"].map(q).join(","));
wx.push([`2026-08-04 12:00:00`, "微信红包", "张三", "/", "支出", "¥200.00", "零钱", "朋友已收钱", "X4", "/", "/"].map(q).join(","));
writeFileSync(new URL("wechat.csv", dir), "﻿" + wx.join("\n"));

// 支付宝：GBK 编码，有“交易分类”，有“不计收支”和“交易关闭”
const ali = [];
for (let i = 0; i < 24; i++) ali.push(i === 0 ? "支付宝交易明细" : i === 2 ? "起始时间：[2026-07-01 00:00:00]    终止时间：[2026-09-30 23:59:59]" : "------------------------------------------------------------------------------------");
ali.push("交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,");
for (const t of recent.filter((t) => t.type === "expense" && t.account === "支付宝")) {
  ali.push([`${t.date} ${t.time}:00`, "日用百货", t.merchant, "/", t.note || t.merchant, "支出", t.amount.toFixed(2), "招商银行信用卡", "交易成功", `2026${n++}`, "", ""].join(",") + ",");
}
ali.push(["2026-08-05 10:00:00", "投资理财", "余额宝", "/", "余额宝-转入", "不计收支", "1000.00", "余额", "交易成功", "Y1", "", ""].join(",") + ",");
ali.push(["2026-08-06 10:00:00", "日用百货", "淘宝", "/", "取消的订单", "支出", "59.00", "花呗", "交易关闭", "Y2", "", ""].join(",") + ",");
// Node 没有 GBK 编码器，用系统的 iconv 转码（macOS / Linux 自带）
writeFileSync(new URL("alipay.csv", dir), execFileSync("iconv", ["-f", "UTF-8", "-t", "GB18030"], { input: ali.join("\r\n") }));

// 随手记：多工作表 Excel
const head = ["交易类型", "日期", "分类", "子分类", "账户1", "账户币种", "金额", "成员", "商家", "项目分类", "项目", "记账人", "备注"];
const sheet = (type, rows) => XLSX.utils.aoa_to_sheet([head, ...rows.map((t) => [type, `${t.date} ${t.time}`, t.cat1, t.cat2, t.account, "CNY", t.amount, "", t.merchant, "", "", "我", t.note])]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, sheet("支出", all.filter((t) => t.type === "expense")), "支出");
XLSX.utils.book_append_sheet(wb, sheet("收入", all.filter((t) => t.type === "income")), "收入");
XLSX.utils.book_append_sheet(wb, sheet("转账", all.filter((t) => t.type === "transfer")), "转账");
writeFileSync(new URL("suishouji.xlsx", dir), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
execFileSync("zip", ["-q", "-j", "-P", "123456", new URL("wechat.zip", dir).pathname, new URL("wechat.csv", dir).pathname]);
console.log("fixtures written");
