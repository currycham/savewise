// 把各种导出文件解析成统一的交易记录：
//   { id, date:'YYYY-MM-DD', time:'HH:MM', amount:正数, type:'expense'|'income'|'transfer'|'refund',
//     cat1, cat2, merchant, note, account, member, source }
// 支持：随手记（Excel，多个工作表）、微信支付账单（CSV/xlsx）、支付宝账单（CSV，GBK）、通用 CSV/Excel。
// 只在浏览器里跑：原始流水不上传到服务器。
import { classify } from "./categorize.js";
import { pad } from "./util.js";

export const SOURCES = { suishouji: "随手记", wechat: "微信支付", alipay: "支付宝", generic: "通用表格", demo: "演示数据" };

// 各字段可能的列名（不同版本、不同 App 叫法不一样）
const COLS = {
  date: ["交易时间", "日期", "时间", "交易日期", "记账时间", "记账日期", "交易创建时间", "付款时间", "Date"],
  amount: ["金额(元)", "金额（元）", "金额", "交易金额", "人民币金额", "Amount"],
  direction: ["收/支", "收支", "收支类型", "交易类型", "类型", "记录类型"],
  cat1: ["一级分类", "分类", "交易分类", "类别", "Category"],
  cat2: ["二级分类", "子分类", "子类别"],
  merchant: ["交易对方", "商家", "对方", "商户", "商户名称", "对方户名"],
  goods: ["商品", "商品说明", "商品名称"],
  note: ["备注", "摘要", "说明", "Note"],
  account: ["账户", "账户1", "支出账户", "支付方式", "收/付款方式", "收付款方式", "账户名称"],
  status: ["当前状态", "交易状态"],
  order: ["交易单号", "交易订单号", "关联Id", "关联ID", "流水号"],
  member: ["成员"],
  txType: ["交易类型"],
  expenseCol: ["支出金额", "支出"],
  incomeCol: ["收入金额", "收入"],
};

const norm = (s) => String(s ?? "").replace(/[\s　﻿]/g, "").replace(/（/g, "(").replace(/）/g, ")");

function findCol(header, names) {
  const h = header.map(norm);
  for (const n of names) {
    const i = h.indexOf(norm(n));
    if (i !== -1) return i;
  }
  return -1;
}

// 在前 60 行里找表头：命中已知列名最多的那一行
function findHeader(rows) {
  const known = new Set(Object.values(COLS).flat().map(norm));
  let best = -1, bestHits = 0;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const hits = rows[i].filter((c) => known.has(norm(c))).length;
    if (hits > bestHits) { best = i; bestHits = hits; }
  }
  return bestHits >= 2 ? best : -1;
}

export function detectSource(header, preamble = "") {
  const h = new Set(header.map(norm));
  if (h.has("交易对方") && h.has("收/支") && h.has("当前状态")) return "wechat";
  if (h.has("交易对方") && h.has("收/支") && (h.has("交易状态") || h.has("商品说明"))) return "alipay";
  if (/微信支付账单/.test(preamble)) return "wechat";
  if (/支付宝/.test(preamble)) return "alipay";
  if (h.has("交易类型") && (h.has("分类") || h.has("一级分类")) && (h.has("子分类") || h.has("二级分类"))) return "suishouji";
  return "generic";
}

function parseAmount(v) {
  if (typeof v === "number") return v;
  const s = String(v ?? "").replace(/[¥￥,\s元]/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

// 日期：Date 对象、Excel 序列号、"2024-03-05 12:31:00"、"2024/3/5 12:31"、"2024年3月5日"
function parseDateTime(v) {
  if (v instanceof Date && !isNaN(v)) {
    return { date: `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`, time: `${pad(v.getHours())}:${pad(v.getMinutes())}` };
  }
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const ms = Math.round((v - 25569) * 86400000);
    const d = new Date(ms);
    return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
  }
  const m = String(v ?? "").trim().match(/(\d{4})\D(\d{1,2})\D(\d{1,2})日?(?:\s*(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, time: m[4] ? `${pad(m[4])}:${m[5]}` : "" };
}

function directionOf(raw, sheetName) {
  const s = String(raw ?? "").trim();
  if (/^支出$|^支$|消费/.test(s)) return "expense";
  if (/^收入$|^收$/.test(s)) return "income";
  if (/转账|不计收支|余额变更|负债变更|债权变更|还款|代付|^\/$|中性/.test(s)) return "transfer";
  if (/退款/.test(s)) return "refund";
  if (sheetName) return directionOf(sheetName.replace(/[\s\d]/g, ""), "");
  return "";
}

// 解析一张表（二维数组）。返回 { source, txs, skipped, header }
export function parseRows(rows, { sheetName = "", source: forced = "" } = {}) {
  rows = rows.filter((r) => r && r.some((c) => String(c ?? "").trim() !== ""));
  const hi = findHeader(rows);
  if (hi === -1) return { source: forced || "generic", txs: [], skipped: rows.length, header: [], error: "没找到表头（需要至少包含日期和金额两列）" };
  const header = rows[hi].map((c) => String(c ?? "").trim());
  const preamble = rows.slice(0, hi).flat().join(" ");
  const source = forced || detectSource(header, preamble);
  const col = Object.fromEntries(Object.entries(COLS).map(([k, names]) => [k, findCol(header, names)]));
  if (col.date === -1 || (col.amount === -1 && col.expenseCol === -1)) {
    return { source, txs: [], skipped: rows.length - hi - 1, header, error: "缺少日期或金额列" };
  }
  const get = (row, k) => (col[k] === -1 ? "" : row[col[k]]);
  const txs = [];
  let skipped = 0;
  for (const row of rows.slice(hi + 1)) {
    const dt = parseDateTime(get(row, "date"));
    let amount = parseAmount(get(row, "amount"));
    let type = directionOf(get(row, "direction"), sheetName);
    // 只有“支出金额 / 收入金额”两列的表（银行流水常见）
    if (!Number.isFinite(amount) && col.expenseCol !== -1) {
      const e = parseAmount(get(row, "expenseCol")), inc = parseAmount(get(row, "incomeCol"));
      if (e > 0) { amount = e; type = "expense"; } else if (inc > 0) { amount = inc; type = "income"; }
    }
    if (!dt || !Number.isFinite(amount) || amount === 0) { skipped++; continue; }
    if (!type) type = amount < 0 ? "expense" : "income"; // 通用表格：负数当支出
    amount = Math.abs(amount);

    const merchant = String(get(row, "merchant") ?? "").trim().replace(/^\/$/, "");
    const goods = String(get(row, "goods") ?? "").trim().replace(/^\/$/, "");
    const rawNote = String(get(row, "note") ?? "").trim().replace(/^\/$/, "");
    const note = [goods, rawNote].filter(Boolean).join(" · ");
    const status = String(get(row, "status") ?? "");
    const txType = String(get(row, "txType") ?? "");

    if (source === "wechat" || source === "alipay") {
      if (/交易关闭|失败|已关闭|对方已退还|已全额退款|全额退款/.test(status)) { skipped++; continue; }
      // 部分退款：“已退款(￥12.00)”“已退款￥12.00”，金额里扣掉退回的部分
      const part = status.match(/退款.*?[¥￥]?\s*([\d.]+)/);
      if (part && type === "expense") amount = Math.max(0, amount - parseFloat(part[1]));
      if (/退款/.test(txType + note) && type === "income") type = "refund";
      if (/零钱提现|零钱充值|理财通|余额宝|信用卡还款|转入零钱通|转出/.test(txType + merchant + goods)) type = "transfer";
      if (amount === 0) { skipped++; continue; }
    }

    let cat1 = String(get(row, "cat1") ?? "").trim();
    let cat2 = String(get(row, "cat2") ?? "").trim();
    if (source === "wechat" || source === "alipay" || (!cat1 && type === "expense")) {
      const hint = cat1;
      [cat1, cat2] = classify(`${merchant} ${goods} ${rawNote}`, hint);
      if (cat1 === "其他" && /微信红包|红包/.test(txType)) [cat1, cat2] = ["人情往来", "礼金红包"];
      else if (cat1 === "其他" && /转账/.test(txType)) [cat1, cat2] = ["其他", "个人转账"];
    }
    if (!cat2) cat2 = cat1;

    txs.push({
      date: dt.date, time: dt.time, amount: Math.round(amount * 100) / 100, type, cat1: cat1 || "其他", cat2: cat2 || "未分类",
      merchant, note, account: String(get(row, "account") ?? "").trim(), member: String(get(row, "member") ?? "").trim(),
      source, order: String(get(row, "order") ?? "").trim(),
    });
  }
  return { source, txs, skipped, header };
}

// 去重用的键：有订单号用订单号，否则用时间+金额+商户+备注
export function txKey(t) {
  return t.order ? `${t.source}|${t.order}|${t.type}` : `${t.source}|${t.date} ${t.time}|${t.amount}|${t.merchant}|${t.note}|${t.cat2}|${t.type}`;
}

// CSV 文本 -> 二维数组（支持引号、引号内换行）
export function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

// 字节 -> 文本：先按 UTF-8，出现乱码再按 GB18030（支付宝账单是 GBK）
export function decodeText(bytes) {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("�")) return utf8.replace(/^﻿/, "");
  return new TextDecoder("gb18030").decode(bytes);
}

// 读一个文件（浏览器 File 或 {name, bytes}），返回每张表的解析结果
export async function parseFile(file, XLSX) {
  const name = file.name || "";
  // 注意：新版浏览器的 File 自带 bytes() 方法，不能用 file.bytes 判断
  const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(await file.arrayBuffer());
  if (/\.(xlsx|xls|xlsm|et)$/i.test(name)) {
    if (!XLSX) throw new Error("Excel 解析库还没加载");
    const wb = XLSX.read(bytes, { type: "array", cellDates: true });
    const results = [];
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: "" });
      const r = parseRows(rows, { sheetName });
      if (r.txs.length) results.push({ ...r, sheetName });
    }
    // 随手记的多个工作表里有一张认出来是随手记，其余的（比如“转账”表）也按随手记算
    if (results.some((r) => r.source === "suishouji")) for (const r of results) for (const t of r.txs) t.source = "suishouji";
    return results;
  }
  return [{ ...parseRows(parseCSV(decodeText(bytes))), sheetName: "" }];
}
