import * as acct from "./account.js";
import * as ai from "./ai.js";
import { KINDS, TAXONOMY, defaultKind } from "./categorize.js";
import { barChart, donut, groupedBarChart, ledgerChart, lineChart, multiLineChart, stackBar } from "./charts.js";
import { demoTransactions } from "./demo.js";
import { $, $$, download, esc, hash } from "./dom.js";
import { readFiles } from "./files.js";
import { clearOutbox, logUpload, readOutbox } from "./outbox.js";
import { DEFAULTS, isSpend, opportunities, overview, spend, totalSaving } from "./analyze.js";
import { SOURCES, txKey } from "./parse.js";
import { cardLedger, defaultPlan, freedomFund, lumpyStatus } from "./plan.js";
import * as store from "./store.js";
import { groupBy, pct, sum, ymd, yuan } from "./util.js";
import { CADENCES, addDays, cadenceOf, evalGoal, goalActual, goalCandidates, lastFullPeriod, mondayOf, periodContext, periodEnd, periodName, periodOf, periodStart, periodStats, periodTick, shiftPeriod } from "./review.js";

// ---------- 状态 ----------
// datasets: [{id, name, source, fileName, importedAt, count, from, to}]，流水按数据集存 tx:<id>
// account: 登录后 {email, version(已同步的云端版本), dirty(本机有没同步的改动), syncedAt}；key: 数据密钥（不离开浏览器）
// cuts：可砍项“决定去做”的力度（id -> 比例）；reports 是以前 AI 教练的月度复盘（已并入「复盘」，只保留数据）
const blank = () => ({ kinds: {}, statuses: {}, reviews: {}, cuts: {}, catOverrides: {}, plan: null, cooling: [], reports: [], chatLog: [], recaps: [], goalChecks: {} });
const S = {
  datasets: [], raw: [], txs: [], demo: false, ...blank(),
  // cadence：复盘周期（登录后以服务器为准）；bigMin：大额支出的金额线；trend：体检页分类趋势选了哪些分类
  settings: { shareMerchants: true, deviceId: "", consent: false, cadence: "month", bigMin: DEFAULTS.bigMin, trend: { keys: [], range: "2y", yearMode: "full" } },
  config: { ai_enabled: false, invite_required: false, email_enabled: false },
  account: null, key: null, me: null, sync: { state: "", error: "" },
  ov: null, opps: [], ledger: [], lumpy: [], fund: null, saving: 0,
};
// 会进云同步（加密）的数据；settings 只在本机。服务器上没有任何明文的流水、汇总或复盘
const SYNCED = ["kinds", "statuses", "reviews", "cuts", "catOverrides", "plan", "cooling", "reports", "chatLog", "recaps", "goalChecks"];
async function save(k) {
  if (S.demo) return;
  await store.set(k, S[k]);
  if (SYNCED.includes(k)) markDirty();
}

const KIND_SLOT = { rigid: 1, fixedFlex: 2, daily: 3, lumpy: 4 };
const OPP_TYPES = {
  subscription: "订阅黑洞", small: "无感支出", big: "大额支出", inflate: "分类膨胀", lumpy: "偶发大额", audit: "单价审计",
};

function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), ms);
}

// ---------- 启动 ----------
async function boot() {
  await loadLocal();
  const saved = (await store.get("settings")) || {};
  S.settings = { ...S.settings, ...saved, trend: { ...S.settings.trend, ...(saved.trend || {}) } };
  if (!S.settings.deviceId) { S.settings.deviceId = crypto.randomUUID?.() || String(Math.random()).slice(2); await store.set("settings", S.settings); }
  S.account = await store.get("account");
  S.key = await store.get("dataKey");
  fetch("/api/public-config").then((r) => r.json()).then((c) => {
    S.config = c;
    if (c.model_disclosure) $("#disclosure").textContent = c.model_disclosure;
  }).catch(() => {});
  if (!(await store.persistent())) toast("浏览器不允许本地存储（可能是隐私模式），刷新后数据会丢失", 6000);
  updateAccountUI();
  if (S.account) syncAccount();
  if (location.hash.startsWith("#reset=")) openReset(location.hash.slice(7));
  if (location.hash === "#demo") return enterDemo();
  compute();
  route();
}

// 从本机存储读出全部数据（不含 settings）
async function loadLocal() {
  const b = blank();
  for (const k of Object.keys(b)) S[k] = (await store.get(k)) ?? b[k];
  S.datasets = (await store.get("datasets")) || [];
  S.raw = [];
  for (const d of S.datasets) S.raw.push(...((await store.get(`tx:${d.id}`)) || []));
}

function compute() {
  // 用户或 AI 改过的分类覆盖掉自动分类
  S.txs = S.raw.map((t) => {
    const o = S.catOverrides[overrideKey(t)];
    return o ? { ...t, cat1: o[0], cat2: o[1] } : t;
  });
  S.ov = overview(S.txs, S.kinds);
  if (!S.ov) { S.opps = []; return; }
  S.opps = opportunities(S.txs, { kinds: S.kinds, reviews: S.reviews, cuts: S.cuts, opts: { bigMin: S.settings.bigMin } });
  S.saving = totalSaving(S.txs, S.opps, S.statuses);
  // 用户没改过计划时，数据变了就按新数据重新给建议
  if (!S.plan || S.plan.auto) S.plan = { ...defaultPlan(S.txs, S.ov, S.saving, S.kinds, S.opps), auto: true };
  S.ledger = cardLedger(S.txs, S.plan, S.kinds);
  S.lumpy = lumpyStatus(S.txs, S.plan, S.opps, S.kinds);
  S.fund = freedomFund(S.txs, S.plan, S.ov, S.ledger);
}

const overrideKey = (t) => `${t.merchant}|${t.note}`.slice(0, 80);

function route() {
  const has = S.txs.length > 0 || location.hash === "#privacy";
  $("#landing").classList.toggle("hidden", has);
  $("#app").classList.toggle("hidden", !has);
  $("#nav").classList.toggle("hidden", !S.txs.length);
  $("#btn-import").classList.toggle("hidden", !S.txs.length || S.demo);
  $("#demo-bar").classList.toggle("hidden", !S.demo);
  if (!has) return;
  let tab = (location.hash || "#overview").slice(1);
  if (tab === "weekly") tab = "review"; // 以前邮件里的链接
  const views = { overview: viewOverview, opps: viewOpps, plan: viewPlan, review: viewReview, cooling: viewCooling, coach: viewCoach, data: viewData, privacy: viewPrivacy };
  if (!S.txs.length) tab = "privacy";
  const fn = views[tab] || viewOverview;
  $$("#nav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#${views[tab] ? tab : "overview"}`));
  $("#view").innerHTML = fn();
  bind[fn.name]?.();
}
window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });

function rerender() { compute(); route(); }

// ---------- 演示 ----------
function enterDemo() {
  S.demo = true;
  S.raw = demoTransactions().map((t) => ({ ...t, id: hash(`demo|${t.id}`) }));
  Object.assign(S, blank());
  S.cooling = [{ id: "c1", item: "儿童智能手表（升级款）", price: 1599, why: "同学都换了新款", mood: "焦虑", at: Date.now() - 80 * 3600e3, status: "waiting" },
    { id: "c2", item: "露营装备一套", price: 2399, why: "朋友圈看到，周末想去", mood: "冲动", at: Date.now() - 10 * 3600e3, status: "waiting" }];
  compute();
  if (location.hash === "#demo") history.replaceState(null, "", "#overview");
  route();
}

async function exitDemo() {
  S.demo = false;
  await loadLocal();
  location.hash = "";
  rerender();
}

// ---------- 体检 ----------
// 图表按容器实际宽度画（卡片左右内边距 18px + 边框）
const chartWidth = (half = false) => {
  const full = Math.max(300, ($("#view").clientWidth || 1048) - 38);
  return half && full > 760 ? (full - 14) / 2 - 38 : full;
};

// 一级分类的颜色跟着分类走：按全部支出排序，前 7 个各有固定颜色，其余的归“其他”（灰）
function catSlots() {
  const total = (c) => sum(Object.values(c.perYear));
  return new Map([...S.ov.cats].sort((a, b) => total(b) - total(a)).slice(0, 7).map((c, i) => [c.cat1, i + 1]));
}

function viewOverview() {
  const { ov } = S;
  const y = ov.ytd;
  const change = y.hasPrev && y.prevExpense ? (y.expense - y.prevExpense) / y.prevExpense : null;
  const saveRate = y.income ? (y.income - y.expense) / y.income : null;
  const k = ov.kindTotals;
  const manageable = k.daily + k.lumpy + k.fixedFlex;
  const doable = S.opps.filter((o) => S.statuses[o.id] !== "ignored").length;
  return `${shortData()}
  <section class="kpis">
    ${tile(`${y.label}支出`, yuan(y.expense), change === null ? "没有去年同期的数据" : `比去年同期 ${change >= 0 ? "+" : ""}${pct(change)}（${yuan(y.prevExpense)}）`, change > 0.05 ? "up" : "")}
    ${tile(`${y.label}结余率`, saveRate === null ? "—" : pct(saveRate), y.income ? `收入 ${yuan(y.income)}` : "没有收入记录")}
    ${tile("可砍空间（保守估计）", yuan(S.saving), `${doable} 条可砍项 · 约占一年支出 ${pct(S.saving / ov.last12)}`, "good")}
    ${tile("节流目标", yuan(S.plan.target), `每年少花 ${yuan(S.plan.baseline - S.plan.target)}`)}
  </section>

  <section class="card insight">
    <p>${y.label}你花了 <b>${yuan(y.expense)}</b>${change === null ? "" : `，${change >= 0 ? "比去年同期多" : "比去年同期少"} <b>${yuan(Math.abs(y.expense - y.prevExpense))}</b>`}。按${span()}算，一年 <b>${yuan(ov.last12)}</b>，其中 <b>${yuan(k.rigid)}</b> 是房租房贷、保险、学费这类固定刚性支出——这是生活品质的基石，不建议砍，只优化单价。剩下的 <b>${yuan(manageable)}</b> 才是可以管理的部分。</p>
    <p>我们在里面找到了 <b>${doable} 条可砍项</b>，不用一刀砍掉，只是让涨幅慢下来、少花一部分，保守估计一年能省 <b>${yuan(S.saving)}</b>。<a href="#opps">去看可砍清单 →</a></p>
  </section>

  <section class="card">
    <div class="card-head"><h2>支出四象限 <span class="muted small">${span()}</span></h2></div>
    ${stackBar(Object.entries(k).map(([kind, v]) => ({ label: KINDS[kind].name, value: v, slot: KIND_SLOT[kind] })), yuan)}
    <div class="kind-legend">
      ${Object.entries(k).map(([kind, v]) => `<div><i class="sw" style="background:var(--series-${KIND_SLOT[kind]})"></i><b>${KINDS[kind].name}</b> ${yuan(v)} <span class="muted">${pct(v / ov.last12)}</span><div class="muted small">${KINDS[kind].how}</div></div>`).join("")}
    </div>
    <p class="muted small">分类归到哪个象限可以在「数据 → 分类归属」里改。</p>
  </section>

  ${trendCard()}
  ${shareCard()}

  <section class="card">
    <div class="card-head"><h2>分类逐年对比</h2><span class="muted small">点一行展开二级分类 · 同比是${esc(y.label)}对比去年同期，红色表示多花 20% 以上</span></div>
    ${catTable()}
  </section>`;
}

// 分类趋势：每年（分组柱）+ 每月（折线），共用一排分类选择。什么都不选就看合计
function trendCard() {
  const { ov } = S, t = S.settings.trend, y = ov.ytd;
  const slots = catSlots();
  const keys = t.keys.filter((key) => ov.byCatMonth[key]);
  const series = keys.map((key) => ({ key, label: key.includes("/") ? key.split("/")[1] : key, slot: slots.get(key.split("/")[0]) || 8, dash: key.includes("/") }));
  // 每年：全年，或者每年只算 1 月到今年最近一个完整月（同期）
  const endM = y.end.slice(5);
  const sameP = t.yearMode === "ytd";
  const yearsShown = ov.byYear.slice(-6);
  const inYear = (yr) => ov.months.filter((m) => m.startsWith(yr) && (!sameP || m.slice(5) <= endM));
  const yearVal = (key, yr) => sum(inYear(yr), (m) => (key ? ov.byCatMonth[key][m] || 0 : ov.trend.find((p) => p.month === m)?.expense || 0));
  const partial = (yr) => !sameP && yr.months < 12;
  const groups = yearsShown.map((yr) => ({ label: partial(yr) ? `${yr.year}*` : yr.year, muted: partial(yr), tip: `${yr.year} 年${sameP ? ` 1–${Number(endM)} 月` : ""}` }));
  const yearly = series.length
    ? groupedBarChart(groups, series.map((se) => ({ ...se, values: yearsShown.map((yr) => yearVal(se.key, yr.year)) })), { fmt: yuan, label: "每年分类支出", width: chartWidth(true) })
    : barChart(yearsShown.map((yr, i) => ({ label: groups[i].label, value: yearVal(null, yr.year), muted: partial(yr), tip: `${groups[i].tip}：支出 ${yuan(yearVal(null, yr.year))}` })), { fmt: yuan, label: "每年支出", width: chartWidth(true) });
  // 每月
  const months = t.range === "2y" ? ov.months.slice(-24) : ov.months;
  const tick = t.range === "2y" ? (m) => (m.endsWith("-01") || m.endsWith("-07") ? `${m.slice(2, 4)}/${m.slice(5)}` : "") : (m) => (m.endsWith("-01") ? m.slice(0, 4) : "");
  const monthly = series.length
    ? multiLineChart(months, series.map((se) => ({ ...se, values: months.map((m) => ov.byCatMonth[se.key][m] || 0) })), { fmt: yuan, label: "每月分类支出", width: chartWidth(true), tick })
    : lineChart(months.map((m) => ({ label: m, value: ov.trend.find((p) => p.month === m)?.expense || 0 })), { fmt: yuan, label: "每月支出趋势", width: chartWidth(true), tickEvery: (p) => !!tick(p.label), tickText: (p) => tick(p.label) });
  const cat1s = ov.cats.map((c) => c.cat1);
  const subs = ov.cats.flatMap((c) => c.subs.filter((x) => x.cat2 !== c.cat1).map((x) => `${c.cat1}/${x.cat2}`));
  const seg = (ctl, opts, cur) => `<span class="seg-ctl">${opts.map(([v, l]) => `<button data-${ctl}="${v}" class="${cur === v ? "on" : ""}">${l}</button>`).join("")}</span>`;
  return `<section class="card" id="trend">
    <div class="card-head"><h2>支出趋势</h2><span class="muted small">点分类对比趋势，最多 6 个${series.some((x) => x.dash) ? " · 虚线是二级分类" : ""}</span></div>
    <div class="chips">
      <button class="chip ${series.length ? "" : "on"}" data-tkey="">合计</button>
      ${cat1s.map((c) => `<button class="chip ${keys.includes(c) ? "on" : ""}" data-tkey="${esc(c)}"><i class="sw" style="background:var(--series-${slots.get(c) || 8})"></i>${esc(c)}</button>`).join("")}
      ${keys.filter((x) => x.includes("/")).map((x) => `<button class="chip on" data-tkey="${esc(x)}"><i class="sw" style="background:var(--series-${slots.get(x.split("/")[0]) || 8})"></i>${esc(x.split("/")[1])} ✕</button>`).join("")}
      <select id="t-sub" class="chip"><option value="">＋ 二级分类…</option>${subs.filter((x) => !keys.includes(x)).map((x) => `<option value="${esc(x)}">${esc(x.replace("/", " / "))}</option>`).join("")}</select>
    </div>
    <div class="two-col">
      <div>
        <div class="trend-tools"><b>每年</b>${seg("ymode", [["full", "全年"], ["ytd", `每年 1–${Number(endM)} 月`]], t.yearMode)}</div>
        ${yearly}
        <p class="muted small">${sameP ? `每年只算 1–${Number(endM)} 月，和今年同期比才公平。` : "* 不满 12 个月的年份"}</p>
      </div>
      <div>
        <div class="trend-tools"><b>每月</b>${seg("range", [["2y", "近 2 年"], ["all", "全部"]], t.range)}</div>
        ${monthly}
        <p class="muted small">${series.length ? "悬停看这个月每个分类花了多少。" : "尖峰通常是旅行、保险、年终人情这类偶发大额。"}</p>
      </div>
    </div>
  </section>`;
}

// 每年的分类占比（环形图，一年一个，颜色和趋势图一致）
function shareCard() {
  const { ov } = S, y = ov.ytd;
  const slots = catSlots();
  const years = ov.byYear.filter((yr) => yr.expense > 0).slice(-4);
  const curYear = y.end.slice(0, 4);
  const legend = [...slots].map(([c, i]) => `<span><i class="sw" style="background:var(--series-${i})"></i>${esc(c)}</span>`).join("")
    + (ov.cats.length > slots.size ? `<span><i class="sw" style="background:var(--series-other)"></i>其他</span>` : "");
  const pies = years.map((yr) => {
    const segs = [...slots].map(([c, i]) => ({ label: c, slot: i, value: ov.cats.find((x) => x.cat1 === c).perYear[yr.year] || 0 }));
    const rest = ov.cats.filter((c) => !slots.has(c.cat1)).reduce((a, c) => a + (c.perYear[yr.year] || 0), 0);
    if (rest > 0) segs.push({ label: "其他", slot: "other", value: rest });
    const total = segs.reduce((a, x) => a + x.value, 0);
    const top = [...segs].sort((a, b) => b.value - a.value).slice(0, 3);
    return `<figure>${donut(segs, { title: yr.year, sub: yuan(total), fmt: yuan })}
      <figcaption>${yr.year === curYear && yr.months < 12 ? `截至 ${S.ov.window.last.slice(5)} · ` : yr.months < 12 ? `只有 ${yr.months} 个月 · ` : ""}${top.map((x) => `${esc(x.label)} ${pct(x.value / total)}`).join(" · ")}</figcaption></figure>`;
  }).join("");
  return `<section class="card">
    <div class="card-head"><h2>每年分类占比</h2><span class="muted small">同一个分类同一个颜色，悬停看金额</span></div>
    <div class="legend">${legend}</div>
    <div class="donuts">${pies}</div>
  </section>`;
}

function catTable() {
  const { ov } = S, y = ov.ytd;
  const curYear = y.end.slice(0, 4);
  const years = ov.byYear.filter((yr) => yr.year < curYear).slice(-5);
  const head = `<thead><tr><th>分类</th>${years.map((yr) => `<th class="num">${yr.year}${yr.months < 12 ? "*" : ""}</th>`).join("")}<th class="num">${esc(y.label)}</th><th class="num">去年同期</th><th class="num">同比</th></tr></thead>`;
  const cells = (c) => `${years.map((yr) => `<td class="num">${c.perYear[yr.year] ? yuan(c.perYear[yr.year]) : "—"}</td>`).join("")}`;
  const rows = ov.cats.map((c, i) => {
    const sub = c.subs.map((x) => `<tr class="sub-row hidden" data-parent="${i}"><td>　${esc(x.cat2)} <span class="tag">${KINDS[x.kind].name}</span></td>${cells(x)}<td class="num">${yuan(x.ytd)}</td><td class="num muted">${y.hasPrev ? yuan(x.ytdPrev) : "—"}</td>${changeCell(x.ytd, x.ytdPrev)}</tr>`).join("");
    return `<tr class="cat-row" data-row="${i}"><td><b>${esc(c.cat1)}</b> <span class="muted small">${c.subs.length > 1 ? `▸ ${c.subs.length}` : ""}</span></td>${cells(c)}<td class="num"><b>${yuan(c.ytd)}</b></td><td class="num muted">${y.hasPrev ? yuan(c.ytdPrev) : "—"}</td>${changeCell(c.ytd, c.ytdPrev)}</tr>${sub}`;
  }).join("");
  return `<div class="tbl"><table>${head}<tbody>${rows}</tbody></table></div>${years.some((yr) => yr.months < 12) ? `<p class="muted small">* 不满 12 个月的年份</p>` : ""}`;
}

function tile(k, v, sub, cls = "") {
  return `<div class="stat ${cls}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="sub">${esc(sub)}</div></div>`;
}

function changeCell(last, before) {
  if (!S.ov.ytd.hasPrev) return `<td class="num muted">—</td>`;
  if (!before) return `<td class="num muted">${last ? "新" : "—"}</td>`;
  const c = (last - before) / before;
  return `<td class="num ${c >= 0.2 && last - before > 2000 ? "bad" : c <= -0.1 ? "good-text" : ""}">${c >= 0 ? "+" : ""}${pct(c)}</td>`;
}

// 数据不满一年时，金额都是按已有月份折算成一年的
const span = () => (S.ov.window.months === 12 ? "过去 12 个月" : `近 ${S.ov.window.months} 个月折合一年`);
const shortData = () => S.ov.window.months < 12
  ? `<p class="card warn-card small">目前只有 ${S.ov.window.months} 个完整月的数据，金额按比例折算成一年，订阅和年度对比可能不全。导入更长时间的账单（随手记全部历史、支付宝一次可导 1 年）会准很多。</p>` : "";

const bind = {};
bind.viewOverview = () => {
  $$(".cat-row").forEach((r) => (r.onclick = () => $$(`.sub-row[data-parent="${r.dataset.row}"]`).forEach((x) => x.classList.toggle("hidden"))));
  const t = S.settings.trend;
  const update = async (fn) => {
    fn(t);
    await store.set("settings", S.settings);
    $("#trend").outerHTML = trendCard();
    bind.viewOverview();
  };
  $$("[data-tkey]").forEach((b) => (b.onclick = () => update(() => {
    const key = b.dataset.tkey;
    if (!key) t.keys = [];
    else if (t.keys.includes(key)) t.keys = t.keys.filter((x) => x !== key);
    else if (t.keys.length >= 6) toast("最多同时对比 6 个分类");
    else t.keys = [...t.keys, key];
  })));
  $("#t-sub").onchange = (e) => e.target.value && update(() => { if (t.keys.length < 6) t.keys = [...t.keys, e.target.value]; else toast("最多同时对比 6 个分类"); });
  $$("[data-range]").forEach((b) => (b.onclick = () => update(() => (t.range = b.dataset.range))));
  $$("[data-ymode]").forEach((b) => (b.onclick = () => update(() => (t.yearMode = b.dataset.ymode))));
};

// ---------- 可砍清单 ----------
let oppFilter = "all";
function viewOpps() {
  const opps = S.opps.filter((o) => oppFilter === "all" || o.type === oppFilter);
  const doing = totalSaving(S.txs, S.opps, S.statuses, { only: "doing" });
  const types = Object.keys(OPP_TYPES).filter((t) => S.opps.some((o) => o.type === t));
  const rigid = S.ov.cats.flatMap((c) => c.subs.filter((s) => s.kind === "rigid" && s.last > 0).map((s) => ({ ...s, cat1: c.cat1 }))).sort((a, b) => b.last - a.last);
  return `
  <section class="kpis">
    ${tile("可砍空间（保守估计）", yuan(S.saving), "已排除忽略的；同一笔钱只算一次", "good")}
    ${tile("决定去做的", yuan(doing), `${S.opps.filter((o) => S.statuses[o.id] === "doing").length} 条 · 会计入节流计划`)}
    ${tile(`${span()}支出`, yuan(S.ov.last12), `去掉可砍部分 ≈ ${yuan(S.ov.last12 - S.saving)}`)}
  </section>
  <div class="chips">
    <button class="chip ${oppFilter === "all" ? "on" : ""}" data-filter="all">全部 ${S.opps.length}</button>
    ${types.map((t) => `<button class="chip ${oppFilter === t ? "on" : ""}" data-filter="${t}">${OPP_TYPES[t]} ${S.opps.filter((o) => o.type === t).length}</button>`).join("")}
  </div>
  ${opps.length ? arrange(opps).map((o) => (o.type === "subGroup" ? subGroupCard(o.subs) : oppCard(o))).join("") : `<p class="empty">这一类没有发现问题 👍</p>`}
  <section class="card rigid">
    <h2>不建议砍的：固定刚性 ${yuan(sum(rigid, (s) => s.last))}</h2>
    <p class="muted">这些是生活品质的基石。砍它们会带来更大的情绪成本；能做的是比价、换渠道、年缴、团购，把单价降下来。</p>
    <div class="rigid-list">${rigid.slice(0, 10).map((s) => `<span>${esc(s.cat2)} <b>${yuan(s.last)}</b></span>`).join("")}</div>
  </section>`;
}

// 订阅合成一张卡（一条条列出来太长）；大额支出要人工复盘，放在第二位，别沉到最底下
function arrange(opps) {
  const subs = opps.filter((o) => o.type === "subscription");
  const list = opps.filter((o) => o.type !== "subscription" && o.type !== "big");
  if (subs.length) list.push({ type: "subGroup", subs, saving: sum(subs, (o) => o.saving) });
  list.sort((a, b) => b.saving - a.saving);
  const big = opps.find((o) => o.type === "big");
  if (big) list.splice(Math.min(1, list.length), 0, big);
  return list;
}

function subGroupCard(subs) {
  const total = sum(subs, (o) => o.saving);
  const cut = sum(subs.filter((o) => S.statuses[o.id] === "doing"), (o) => o.saving);
  return `<article class="opp card">
    <div class="opp-head"><span class="badge t-subscription">订阅黑洞</span><h3>${subs.length} 个还在自动扣费的订阅，一年 ${yuan(total)}</h3><span class="opp-saving">${cut ? `决定取消的一年省 ${yuan(cut)}` : `最多一年省 ${yuan(total)}`}</span></div>
    <p>逐个问自己：过去 3 个月用过吗？没用就取消自动续费，想用了随时可以再开。</p>
    <div class="tbl"><table><tbody>${subs.map((o) => {
      const st = S.statuses[o.id] || "todo", d = o.detail;
      return `<tr class="opp-row ${st}" data-id="${esc(o.id)}">
        <td>${esc(o.title)}<div class="muted small">${d.period === "monthly" ? `每月 ${yuan(d.latest)}` : `每年 ${yuan(d.latest)}`} · 从 ${d.since.slice(0, 7)} 开始，累计 ${yuan(d.total)}</div></td>
        <td class="num">${yuan(o.saving)}/年</td>
        <td class="num"><span class="actions row-actions">${st === "todo" ? `<button class="mini" data-status="doing">取消它</button><button class="mini" data-status="ignored">保留</button>`
          : `<span class="tag ${st === "doing" ? "ok" : ""}">${st === "doing" ? "✓ 取消" : "保留"}</span><button class="mini ghost" data-status="todo">撤销</button>`}</span></td></tr>`;
    }).join("")}</tbody></table></div>
  </article>`;
}

function oppCard(o) {
  const st = S.statuses[o.id] || "todo";
  const extra = o.type === "big" ? bigList(o) : o.type === "small" && o.detail.top ? `<p class="muted small">主要是：${o.detail.top.map(([m, v]) => `${esc(m)} ${yuan(v)}`).join("、")}</p>` : "";
  const savingText = o.type === "big"
    ? (o.saving ? `复盘为“不值”的一年 ${yuan(o.saving)}` : "复盘后才能算")
    : `预计一年省 ${yuan(o.saving)}`;
  // 力度：少花一部分 / 把涨幅压下来，不是一刀砍掉
  const cutCtl = o.cuts.length > 1 && st !== "ignored"
    ? `<span class="cut-ctl">力度 <span class="seg-ctl">${o.cuts.map((c) => `<button data-cut="${c.v}" class="${c.v === o.cut ? "on" : ""}">${esc(c.label)}</button>`).join("")}</span></span>` : "";
  return `<article class="opp card ${st}" data-id="${esc(o.id)}">
    <div class="opp-head">
      <span class="badge t-${o.type}">${OPP_TYPES[o.type]}</span>
      <h3>${esc(o.title)}</h3>
      <span class="opp-saving">${savingText}</span>
    </div>
    <p>${esc(o.action)}</p>
    ${extra}
    <div class="opp-foot">
      <span class="muted small">影响：${esc(o.risk)} · ${span()} ${yuan(o.annual)}</span>
      ${cutCtl}
      <span class="actions">${o.type === "big" ? "" : `
        ${st === "todo" ? `<button class="primary" data-status="doing">决定去做</button><button data-status="ignored">忽略</button>` : ""}
        ${st === "doing" ? `<span class="tag ok">✓ 决定去做</span><button class="ghost" data-status="todo">撤销</button>` : ""}
        ${st === "ignored" ? `<span class="tag">已忽略</span><button class="ghost" data-status="todo">恢复</button>` : ""}`}
      </span>
    </div>
  </article>`;
}

function bigList(o) {
  const items = o.detail.items;
  const done = items.filter((t) => t.review).length;
  return `<div class="form-row"><label style="max-width:220px">金额不少于<input type="number" id="big-min" value="${o.detail.min}" step="500" min="500"></label></div>
  <div class="biglist">
    <div class="bar"><i style="width:${(done / items.length) * 100}%"></i></div>
    <table><tbody>${items.map((t) => `<tr>
      <td class="num">${t.date.slice(2)}</td>
      <td class="num"><b>${yuan(t.amount)}</b></td>
      <td>${esc(t.cat1)} / ${esc(t.cat2)}${t.merchant ? ` · ${esc(t.merchant)}` : ""}${t.note ? `<div class="muted small">${esc(t.note)}</div>` : ""}</td>
      <td class="review" data-tx="${esc(t.id)}">
        ${["yes", "no", "unsure"].map((v) => `<button class="mini ${t.review === v ? "on " + v : ""}" data-review="${v}">${{ yes: "值得", no: "不值", unsure: "说不清" }[v]}</button>`).join("")}
      </td></tr>`).join("")}</tbody></table>
    <p class="muted small">${span()}、固定刚性（房租房贷、保险等）之外的单笔。判断标准：这笔钱带来了持续的价值，还是当时可以不花？</p>
  </div>`;
}

bind.viewOpps = () => {
  $$("[data-filter]").forEach((b) => (b.onclick = () => { oppFilter = b.dataset.filter; route(); }));
  $$("[data-id] [data-status]").forEach((b) => (b.onclick = async () => {
    const id = b.closest("[data-id]").dataset.id;
    S.statuses[id] = b.dataset.status;
    await save("statuses");
    rerender();
  }));
  const keepScroll = () => { const y = window.scrollY; rerender(); window.scrollTo(0, y); };
  $$("[data-cut]").forEach((b) => (b.onclick = async () => {
    S.cuts[b.closest("[data-id]").dataset.id] = Number(b.dataset.cut);
    await save("cuts");
    keepScroll();
  }));
  if ($("#big-min")) $("#big-min").onchange = async (e) => {
    S.settings.bigMin = Math.max(500, Number(e.target.value) || DEFAULTS.bigMin);
    await store.set("settings", S.settings);
    keepScroll();
  };
  $$("[data-review]").forEach((b) => (b.onclick = async () => {
    const tx = b.closest("[data-tx]").dataset.tx;
    S.reviews[tx] = S.reviews[tx] === b.dataset.review ? undefined : b.dataset.review;
    await save("reviews");
    const y = window.scrollY;
    rerender();
    window.scrollTo(0, y);
  }));
};

// ---------- 节流计划 ----------
function viewPlan() {
  const p = S.plan, f = S.fund;
  const doing = totalSaving(S.txs, S.opps, S.statuses, { only: "doing" });
  const cur = S.ledger[S.ledger.length - 1];
  const lastDay = S.ov.window.last;
  const daysInMonth = new Date(Number(lastDay.slice(0, 4)), Number(lastDay.slice(5, 7)), 0).getDate();
  const daysLeft = daysInMonth - Number(lastDay.slice(8));
  const overMonths = S.ledger.filter((r) => !r.partial && r.spent > r.quota).length;
  const fullMonths = S.ledger.filter((r) => !r.partial).length;
  return `
  <section class="card">
    <div class="card-head"><h2>① 年度目标</h2></div>
    <div class="form-row">
      <label>${span()}支出（基线）<input type="number" id="p-baseline" value="${p.baseline}" step="1000"></label>
      <label>明年支出目标<input type="number" id="p-target" value="${p.target}" step="10000"></label>
      <div class="hint">
        <div>需要少花 <b>${yuan(p.baseline - p.target)}</b>（${pct((p.baseline - p.target) / p.baseline)}）</div>
        <div class="muted small">可砍清单保守估计 ${yuan(S.saving)}，其中你决定去做的 ${yuan(doing)}${doing && p.baseline - p.target > doing ? `，<b>还差 ${yuan(p.baseline - p.target - doing)}</b>，回可砍清单再挑几条` : ""}</div>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="card-head"><h2>② 每月消费卡</h2><span class="muted small">只管“高频弹性”支出：吃饭外卖、打车、日用、小东西</span></div>
    <p class="muted">每月 1 号把额度转到一张单独的消费卡上，花完就停；超支从下个月额度里扣，有结余就转进自由基金。不是不花，是让每一笔都“有感”。</p>
    <div class="form-row">
      <label>每月额度<input type="number" id="p-card" value="${p.cardMonthly}" step="500"></label>
      <label>从哪个月开始<input type="month" id="p-start" value="${p.startMonth}"></label>
      ${cur ? `<div class="hint">
        <div>${cur.month}${cur.partial ? `（截至 ${lastDay.slice(5)}）` : ""}：花了 <b>${yuan(cur.spent)}</b> / 额度 ${yuan(cur.quota)}</div>
        <div class="bar"><i class="${cur.spent > cur.quota ? "warn" : ""}" style="width:${Math.min(100, (cur.spent / Math.max(1, cur.quota)) * 100)}%"></i></div>
        <div class="small ${cur.left < 0 ? "bad" : "muted"}">${cur.left < 0 ? `⚠ 已超支 ${yuan(-cur.left)}，会从下月额度扣` : cur.partial && daysLeft > 0 ? `还剩 ${yuan(cur.left)}，接下来 ${daysLeft} 天每天 ${yuan(cur.left / daysLeft)}` : `结余 ${yuan(cur.left)}`}</div>
      </div>` : ""}
    </div>
    ${S.ledger.length ? ledgerChart(S.ledger, { fmt: yuan, width: chartWidth() }) : ""}
    <p class="muted small">柱子是当月高频弹性支出，横线是当月额度（上月超支会扣掉，最多扣 30%）。${S.ledger.some((r) => r.simulated) ? `浅色是计划开始（${p.startMonth}）之前的模拟：如果当时就用这张卡，` : ""}${fullMonths} 个完整月里有 ${overMonths} 个月会超支。</p>
  </section>

  <section class="card">
    <div class="card-head"><h2>③ 偶发大额：年初定预算</h2><span class="muted small">${S.lumpy[0]?.year || ""} 年已用 / 年度预算</span></div>
    <div class="tbl"><table>
      <thead><tr><th>分类</th><th class="num">${S.ov.window.months === 12 ? "过去12月" : "折合一年"}</th><th class="num">年度预算</th><th>今年已用</th></tr></thead>
      <tbody>${S.lumpy.map((l) => `<tr>
        <td>${esc(l.cat2)} <span class="muted small">${esc(l.cat1)}</span></td>
        <td class="num">${yuan(l.last12)}</td>
        <td class="num"><input type="number" class="cap" data-cap="${esc(l.cat2)}" value="${l.cap}" step="1000"></td>
        <td><div class="bar"><i class="${l.used > l.cap ? "warn" : ""}" style="width:${Math.min(100, (l.used / Math.max(1, l.cap)) * 100)}%"></i></div><span class="small ${l.used > l.cap ? "bad" : "muted"}">${yuan(l.used)}${l.used > l.cap ? ` · 超 ${yuan(l.used - l.cap)}` : ""}</span></td>
      </tr>`).join("")}</tbody>
    </table></div>
    <p class="muted small">旅行从“说走就走”改成“年初定 2–3 次、提前订”；人情往来年初列名单。</p>
  </section>

  <section class="card fund">
    <div class="card-head"><h2>④ 自由基金</h2><span class="muted small">节流不是牺牲，是在为想过的生活投票</span></div>
    <div class="form-row">
      <label>五年后想过的生活<input id="p-goal" value="${esc(p.goal)}" placeholder="比如：先生早点自由，全家去大理住一年"></label>
      <label>大概需要多少钱<input type="number" id="p-goal-amount" value="${p.goalAmount || ""}" step="10000" placeholder="500000"></label>
      <label>年化收益假设<input type="number" id="p-rate" value="${(p.rate * 100).toFixed(1)}" step="0.5" min="0" max="20"></label>
    </div>
    <p>每年少花 <b>${yuan(f.annualSaving)}</b> 并存进自由基金，按年化 ${(p.rate * 100).toFixed(1)}%：</p>
    <div class="kpis compact">${f.projection.map((x) => tile(`${x.years} 年后`, yuan(x.value), `本金 ${yuan(f.annualSaving * x.years)}`)).join("")}</div>
    ${p.goalAmount > 0 ? `<p class="goal">${f.yearsToGoal ? `🎯 「${esc(p.goal || "你的目标")}」需要 ${yuan(p.goalAmount)}，按这个节奏大约 <b>${f.yearsToGoal} 年</b>能攒够。` : "按现在的节流目标还攒不够，可以提高目标或拉长年限。"}</p>` : ""}
    <p class="muted small">已兑现：${f.realizedMonths ? `计划开始以来 ${f.realizedMonths} 个月，比基线少花 ${yuan(f.realized)}` : "计划从下个月开始，导入新账单后这里会显示实际少花了多少"} · 冷静期放弃购买 ${yuan(sum(S.cooling.filter((c) => c.status === "skipped"), (c) => c.price))}。收益率只是假设，不构成投资建议。</p>
  </section>
  <p class="muted small center">每${CADENCES[S.settings.cadence].unit}复盘一次消费卡和目标执行得怎么样：去 <a href="#review">「复盘」</a>。</p>`;
}

bind.viewPlan = () => {
  const num = (id) => Number($(id).value) || 0;
  const upd = async (fn) => { fn(S.plan); S.plan.auto = false; await save("plan"); rerender(); };
  $("#p-baseline").onchange = () => upd((p) => (p.baseline = num("#p-baseline")));
  $("#p-target").onchange = () => upd((p) => (p.target = num("#p-target")));
  $("#p-card").onchange = () => upd((p) => (p.cardMonthly = num("#p-card")));
  $("#p-start").onchange = () => upd((p) => (p.startMonth = $("#p-start").value || p.startMonth));
  $("#p-goal").onchange = () => upd((p) => (p.goal = $("#p-goal").value.trim()));
  $("#p-goal-amount").onchange = () => upd((p) => (p.goalAmount = num("#p-goal-amount")));
  $("#p-rate").onchange = () => upd((p) => (p.rate = Math.min(0.2, Math.max(0, num("#p-rate") / 100))));
  $$("[data-cap]").forEach((i) => (i.onchange = () => upd((p) => (p.lumpyCaps[i.dataset.cap] = Number(i.value) || 0))));
};

// ---------- 冷静期 ----------
const HOLD = 72 * 3600e3;
function viewCooling() {
  const now = Date.now();
  const waiting = S.cooling.filter((c) => c.status === "waiting");
  const decided = S.cooling.filter((c) => c.status !== "waiting").slice().reverse();
  const skipped = sum(S.cooling.filter((c) => c.status === "skipped"), (c) => c.price);
  return `
  <section class="card">
    <div class="card-head"><h2>72 小时冷静期</h2><span class="muted small">超过 ${yuan(2000)} 的、或者“突然很想买”的，先放进来</span></div>
    <p class="muted">72 小时后还想要，再买。焦虑、疲惫、深夜、直播间里做的决定，往往过三天就不想要了。放弃购买的钱记进自由基金。</p>
    <div class="form-row cooling-form">
      <label>想买什么<input id="c-item" placeholder="比如：早教课程年卡"></label>
      <label>多少钱<input id="c-price" type="number" placeholder="12800"></label>
      <label>为什么想买<input id="c-why" placeholder="比如：怕孩子落后"></label>
      <label>现在的状态<select id="c-mood"><option>平静</option><option>焦虑</option><option>疲惫</option><option>冲动</option><option>开心想奖励自己</option></select></label>
      <button class="primary" id="c-add">放进冷静期</button>
    </div>
  </section>
  <section class="kpis">${tile("冷静中", `${waiting.length} 件`, yuan(sum(waiting, (c) => c.price)))}${tile("放弃购买，省下", yuan(skipped), `${S.cooling.filter((c) => c.status === "skipped").length} 件`, "good")}${tile("冷静后还是买了", `${S.cooling.filter((c) => c.status === "bought").length} 件`, "想清楚再买，也很好")}</section>
  ${waiting.map((c) => {
    const left = c.at + HOLD - now;
    return `<article class="card cooling ${left <= 0 ? "ready" : ""}" data-c="${c.id}">
      <div class="opp-head"><h3>${esc(c.item)}</h3><span class="opp-saving">${yuan(c.price)}</span></div>
      <p class="muted small">${c.why ? `为什么：${esc(c.why)} · ` : ""}当时的状态：${esc(c.mood)} · 放进来 ${new Date(c.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
      <div class="opp-foot">
        <span>${left > 0 ? `⏳ 还要冷静 ${Math.ceil(left / 3600e3)} 小时` : "✅ 冷静期到了：现在还想要吗？"}</span>
        <span class="actions"><button data-decide="skipped" class="${left <= 0 ? "primary" : ""}">不买了</button>${left <= 0 ? `<button data-decide="bought">还是要买</button>` : ""}<button class="ghost" data-decide="delete">删除</button></span>
      </div></article>`;
  }).join("")}
  ${decided.length ? `<h2 class="section-title">已决定</h2><div class="tbl"><table><tbody>${decided.map((c) => `<tr><td>${esc(c.item)}</td><td class="num">${yuan(c.price)}</td><td>${c.status === "skipped" ? `<span class="tag ok">不买了</span>` : `<span class="tag">买了</span>`}</td><td class="muted small">${esc(c.mood)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
}

bind.viewCooling = () => {
  $("#c-add").onclick = async () => {
    const item = $("#c-item").value.trim(), price = Number($("#c-price").value);
    if (!item || !price) return toast("填一下想买什么和多少钱");
    S.cooling.push({ id: hash(item + Date.now()), item, price, why: $("#c-why").value.trim(), mood: $("#c-mood").value, at: Date.now(), status: "waiting" });
    await save("cooling");
    route();
  };
  $$("[data-decide]").forEach((b) => (b.onclick = async () => {
    const id = b.closest("[data-c]").dataset.c;
    if (b.dataset.decide === "delete") S.cooling = S.cooling.filter((c) => c.id !== id);
    else Object.assign(S.cooling.find((c) => c.id === id), { status: b.dataset.decide, decidedAt: Date.now() });
    await save("cooling");
    rerender();
  }));
};

// ---------- AI 教练 ----------
// 定期复盘在「复盘」页（按周 / 月 / 季度），这里只做问答
let aiBusy = false;
function viewCoach() {
  return `
  ${S.config.ai_enabled ? "" : `<p class="card warn-card">服务器还没有配置 AI，这一页暂时用不了；其他功能都在本地运行，不受影响。</p>`}
  ${S.account ? "" : loginCard("AI 教练需要登录", "内测期间凭邀请码注册。登录后还能定期收到复盘邮件，多台设备加密同步。")}
  <section class="card chatbox">
    <div class="card-head"><h2>问问教练</h2>${S.chatLog.length ? `<button class="ghost small" id="chat-clear">清空</button>` : ""}</div>
    <p class="muted small">定期复盘和每期的 3 个目标在 <a href="#review">「复盘」</a> 页。</p>
    <details class="peek"><summary>查看将发送给 AI 的内容</summary><pre id="peek"></pre></details>
    <div class="chat-body" id="chat-body">
      ${S.chatLog.length ? S.chatLog.map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join("") : `<p class="muted">数字都来自你的汇总数据，教练只负责解释和出主意。</p>`}
    </div>
    <div class="chips">${["今年哪里花得比去年同期多？", "外卖比去年多了多少？", "如果订阅和外卖各少花两成，一年能省多少？", "我离节流目标还差什么？", "旅行怎么花得更值？"].map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    <form class="chat-form" id="chat-form"><input id="chat-input" placeholder="问一个关于你支出的问题" maxlength="500" autocomplete="off"><button class="primary" ${aiBusy ? "disabled" : ""}>发送</button></form>
  </section>`;
}

function needAccount() {
  if (S.account) return true;
  openAccount("login", { why: "AI 功能需要登录" });
  return false;
}

function loginCard(title, text) {
  return `<section class="card login-card"><div><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p></div>
    <span class="actions"><button class="primary" data-action="register">注册</button><button data-action="login">登录</button></span></section>`;
}

async function needConsent() {
  if (S.settings.consent) return true;
  const dlg = $("#dlg-consent");
  $("#consent-check").checked = false;
  $("#consent-ok").disabled = true;
  dlg.showModal();
  return new Promise((resolve) => {
    $("#consent-ok").onclick = async () => { S.settings.consent = true; await store.set("settings", S.settings); dlg.close(); resolve(true); };
    dlg.onclose = () => resolve(S.settings.consent);
  });
}

bind.viewCoach = () => {
  $(".peek").ontoggle = () => { $("#peek").textContent = JSON.stringify(ai.buildContext(S), null, 1); };
  const ask = async (q) => {
    if (!q || aiBusy || !needAccount() || !(await needConsent())) return;
    S.chatLog.push({ role: "user", content: q });
    aiBusy = true; route();
    const body = $("#chat-body");
    body.insertAdjacentHTML("beforeend", `<div class="msg assistant pending">思考中…</div>`);
    body.scrollTop = body.scrollHeight;
    try {
      const { reply } = await ai.chat(ai.buildContext(S), S.chatLog.slice(-10));
      S.chatLog.push({ role: "assistant", content: reply });
    } catch (e) { S.chatLog.pop(); toast(e.message, 5000); }
    await save("chatLog");
    aiBusy = false; route();
    const b = $("#chat-body"); if (b) b.scrollTop = b.scrollHeight;
  };
  $("#chat-form").onsubmit = (e) => { e.preventDefault(); ask($("#chat-input").value.trim()); };
  $$("[data-q]").forEach((b) => (b.onclick = () => ask(b.dataset.q)));
  if ($("#chat-clear")) $("#chat-clear").onclick = async () => { S.chatLog = []; await save("chatLog"); route(); };
};

// ---------- 数据 ----------
function viewData() {
  const unclassified = [...groupBy(S.txs.filter((t) => isSpend(t) && t.cat2 === "未分类"), overrideKey)];
  const unAmount = sum(unclassified.flatMap(([, ts]) => ts), spend);
  const cats = [...groupBy(S.txs.filter(isSpend), (t) => `${t.cat1}/${t.cat2}`)].map(([k, ts]) => ({ k, cat1: ts[0].cat1, cat2: ts[0].cat2, total: sum(ts, spend) })).sort((a, b) => a.cat1.localeCompare(b.cat1, "zh") || b.total - a.total);
  return `
  <section class="card">
    <div class="card-head"><h2>已导入的数据</h2>${S.demo ? "" : `<button class="primary" data-action="import">导入更多</button>`}</div>
    ${S.demo ? `<p class="muted">现在是演示数据，导入你自己的账单后会替换掉。</p>` : `<div class="tbl"><table>
      <thead><tr><th>来源</th><th>文件</th><th class="num">笔数</th><th>时间范围</th><th>导入时间</th><th></th></tr></thead>
      <tbody>${S.datasets.map((d) => `<tr><td>${esc(SOURCES[d.source] || d.source)}</td><td>${esc(d.fileName)}</td><td class="num">${d.count}</td><td class="num">${d.from} ~ ${d.to}</td><td class="muted small">${new Date(d.importedAt).toLocaleString("zh-CN")}</td><td><button class="ghost danger" data-del-ds="${d.id}">删除</button></td></tr>`).join("")}</tbody>
    </table></div>`}
    <p class="muted small">共 ${S.txs.length} 笔，${S.ov.window.first} ~ ${S.ov.window.last}。${S.account ? "已登录：数据加密后同步到云端，换设备登录即可。" : "所有数据只存在这台设备的浏览器里；换设备请登录（加密同步），或用下面的“导出备份”。"}</p>
  </section>

  <section class="card">
    <div class="card-head"><h2>流水明细</h2><span class="muted small">最多显示 300 笔</span></div>
    <div class="form-row detail-filter">
      <label>关键词<input id="d-q" value="${esc(detail.q)}" placeholder="商户、备注，比如 美团"></label>
      <label>分类<select id="d-cat"><option value="">全部</option>${[...new Set(S.txs.filter(isSpend).map((t) => t.cat1))].map((c) => `<option ${detail.cat === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <label>月份<select id="d-month"><option value="">全部</option>${S.ov.trend.map((p) => p.month).reverse().map((m) => `<option ${detail.month === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
    </div>
    ${detailTable()}
  </section>

  ${unclassified.length ? `<section class="card">
    <div class="card-head"><h2>未分类 ${unclassified.length} 个商户 · ${yuan(unAmount)}</h2><button id="ai-classify" ${aiBusy ? "disabled" : ""}>${aiBusy ? "归类中…" : "让 AI 归类"}</button></div>
    <p class="muted small">微信账单没有分类，我们先按商户关键词自动归类；认不出来的可以交给 AI（只发送商户名和商品说明，不发金额），也可以自己改。</p>
    <div class="tbl"><table><tbody>${unclassified.sort((a, b) => sum(b[1], spend) - sum(a[1], spend)).slice(0, 30).map(([key, ts]) => `<tr><td>${esc(ts[0].merchant || "—")} <span class="muted small">${esc(ts[0].note.slice(0, 30))}</span></td><td class="num">${ts.length} 笔</td><td class="num">${yuan(sum(ts, spend))}</td><td>${catSelect(key)}</td></tr>`).join("")}</tbody></table></div>
  </section>` : ""}

  <section class="card">
    <div class="card-head"><h2>分类归属</h2><span class="muted small">决定每个分类按哪种方式管理</span></div>
    <div class="tbl"><table>
      <thead><tr><th>分类</th><th class="num">全部</th><th>归属</th></tr></thead>
      <tbody>${cats.map((c) => `<tr><td>${esc(c.cat1)} / ${esc(c.cat2)}</td><td class="num">${yuan(c.total)}</td><td><select data-kind="${esc(c.k)}">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${(S.kinds[c.k] || defaultKind(c.cat1, c.cat2)) === k ? "selected" : ""}>${v.name}</option>`).join("")}</select></td></tr>`).join("")}</tbody>
    </table></div>
  </section>

  ${accountSection()}

  <section class="card">
    <h2>设置</h2>
    <label class="check"><input type="checkbox" id="s-merchants" ${S.settings.shareMerchants ? "checked" : ""}> 发给 AI 的汇总里包含商户名称（关掉后建议会更笼统）</label>
    <label class="check"><input type="checkbox" id="s-consent" ${S.settings.consent ? "checked" : ""}> 同意把支出汇总发送给 AI 处理（关掉后 AI 功能不可用，其他都不受影响）</label>
    <p class="muted small">发过什么都可以在 <a href="#privacy">「隐私」页的数据流向账</a> 里逐条查看。</p>
    <div class="actions">
      <button id="backup" ${S.demo ? "disabled" : ""}>导出备份</button>
      <button id="restore" ${S.demo ? "disabled" : ""}>从备份恢复</button>
      <button id="wipe" class="danger" ${S.demo ? "disabled" : ""}>清空本机所有数据</button>
    </div>
    <p class="muted small">${S.account ? "清空本机数据不影响云端；下次在这台设备登录会重新同步回来。" : ""}</p>
    <input type="file" id="restore-file" accept=".json" hidden>
  </section>`;
}

function accountSection() {
  if (!S.account) return `<section class="card" id="account">
    <div class="card-head"><h2>账号</h2><span class="actions"><button class="primary" data-action="register">注册</button><button data-action="login">登录</button></span></div>
    <ul class="muted small benefits">
      <li>按你选的周期（周 / 月 / 季度），每期初发一封提醒邮件，不含任何金额</li>
      <li>多台设备同步。流水、计划、复盘在浏览器里用你的密码加密后再上传，服务器只存密文，解不开</li>
      <li>不登录也能用全部本地分析 · <a href="#privacy">我们怎么保护你的隐私 →</a></li>
    </ul></section>`;
  const sy = S.sync;
  const status = sy.state === "error" ? `<span class="bad">同步失败：${esc(sy.error)}</span>`
    : sy.state === "syncing" ? "同步中…"
    : S.account.syncedAt ? `已同步 · ${new Date(S.account.syncedAt).toLocaleString("zh-CN")}` : "已登录";
  return `<section class="card" id="account">
    <div class="card-head"><h2>账号</h2><span class="muted small">${esc(S.account.email)}</span></div>
    <p class="small">☁️ ${status}${S.me?.vault_size ? `<span class="muted"> · 云端密文 ${(S.me.vault_size / 1048576).toFixed(1)}MB</span>` : ""}</p>
    <label class="check"><input type="checkbox" id="s-weekly" ${S.me?.weekly_email ? "checked" : ""} ${S.me ? "" : "disabled"}> 每${CADENCES[S.settings.cadence].unit}初早上 8 点发一封复盘提醒邮件（周期在「复盘」页改）${S.config.email_enabled ? "" : "<span class=\"muted small\">（服务器还没配置邮件）</span>"}</label>
    <p class="muted small">提醒邮件不含任何金额。服务器只知道你的邮箱和复盘周期，不保存你的汇总或复盘。</p>
    <div class="actions">
      <button id="a-pw">修改密码</button>
      <button id="a-logout">退出登录</button>
      <button id="a-delete" class="ghost danger">注销账号</button>
      ${S.me?.is_admin ? '<a href="/admin" class="small">后台管理 →</a>' : ""}
    </div></section>`;
}

const detail = { q: "", cat: "", month: "" };
function detailTable() {
  if (!detail.q && !detail.cat && !detail.month) return `<p class="muted small">选一个分类、月份或输入关键词查看具体交易。</p>`;
  const q = detail.q.toLowerCase();
  const rows = S.txs.filter((t) => isSpend(t) && (!detail.cat || t.cat1 === detail.cat) && (!detail.month || t.date.startsWith(detail.month))
    && (!q || `${t.merchant} ${t.note} ${t.cat2}`.toLowerCase().includes(q))).sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
  return `<p class="small">${rows.length} 笔，合计 <b>${yuan(sum(rows, spend))}</b></p>
    <div class="tbl"><table><tbody>${rows.slice(0, 300).map((t) => `<tr><td class="num">${t.date} <span class="muted">${t.time}</span></td><td>${esc(t.cat1)} / ${esc(t.cat2)}</td><td>${esc(t.merchant)}<div class="muted small">${esc(t.note)}</div></td><td class="num ${t.type === "refund" ? "good-text" : ""}">${t.type === "refund" ? "-" : ""}${yuan(t.amount)}</td><td class="muted small">${esc(SOURCES[t.source] || "")}</td></tr>`).join("")}</tbody></table></div>`;
}

function catSelect(key) {
  return `<select data-override="${esc(key)}"><option value="">改成…</option>${Object.entries(TAXONOMY).map(([c1, subs]) => `<optgroup label="${c1}">${subs.map((c2) => `<option value="${c1}|${c2}">${c2}</option>`).join("")}</optgroup>`).join("")}</select>`;
}

bind.viewData = () => {
  const refresh = () => { const y = window.scrollY; route(); window.scrollTo(0, y); };
  $("#d-q").onchange = () => { detail.q = $("#d-q").value.trim(); refresh(); };
  $("#d-cat").onchange = () => { detail.cat = $("#d-cat").value; refresh(); };
  $("#d-month").onchange = () => { detail.month = $("#d-month").value; refresh(); };
  $$("[data-kind]").forEach((s) => (s.onchange = async () => { S.kinds[s.dataset.kind] = s.value; await save("kinds"); rerender(); }));
  $$("[data-override]").forEach((s) => (s.onchange = async () => {
    if (!s.value) return;
    S.catOverrides[s.dataset.override] = s.value.split("|");
    await save("catOverrides");
    rerender();
  }));
  $$("[data-del-ds]").forEach((b) => (b.onclick = async () => {
    const d = S.datasets.find((x) => x.id === b.dataset.delDs);
    if (!confirm(`删除「${d.fileName}」的 ${d.count} 笔记录？`)) return;
    S.datasets = S.datasets.filter((x) => x.id !== d.id);
    await store.del(`tx:${d.id}`);
    await store.set("datasets", S.datasets);
    S.raw = S.raw.filter((t) => t.ds !== d.id);
    markDirty();
    rerender();
  }));
  if ($("#ai-classify")) $("#ai-classify").onclick = async () => {
    if (!needAccount() || !(await needConsent())) return;
    const keys = [...new Set(S.txs.filter((t) => t.cat2 === "未分类").map(overrideKey))].slice(0, 600);
    aiBusy = true; route();
    try {
      const map = await ai.classifyMerchants(keys);
      Object.assign(S.catOverrides, map);
      await save("catOverrides");
      toast(`归类了 ${Object.keys(map).length} 个商户`);
    } catch (e) { toast(e.message, 5000); }
    aiBusy = false; rerender();
  };
  $("#s-merchants").onchange = async (e) => { S.settings.shareMerchants = e.target.checked; await store.set("settings", S.settings); };
  $("#s-consent").onchange = async (e) => { S.settings.consent = e.target.checked; await store.set("settings", S.settings); };
  if ($("#s-weekly")) $("#s-weekly").onchange = async (e) => {
    const on = e.target.checked;
    try {
      await acct.api("PUT", "/api/settings", { weekly_email: on });
      S.me.weekly_email = on;
      toast(on ? `开启了：每${CADENCES[S.settings.cadence].unit}初早上 8 点发提醒邮件` : "关掉了，不再发提醒邮件");
    } catch (err) { e.target.checked = !on; toast(err.message, 5000); }
  };
  if ($("#a-pw")) $("#a-pw").onclick = () => openAccount("change");
  if ($("#a-logout")) $("#a-logout").onclick = logout;
  if ($("#a-delete")) $("#a-delete").onclick = deleteAccount;
  $("#backup").onclick = async () => {
    download(`savewise-备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await bundle()));
  };
  $("#restore").onclick = () => $("#restore-file").click();
  $("#restore-file").onchange = async (e) => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (data.app !== "savewise") throw new Error("不是 SaveWise 的备份文件");
      if (!confirm(S.account ? "恢复会覆盖本机和云端现有的数据，继续？" : "恢复会覆盖本机现有的数据，继续？")) return;
      await applyBundle(data);
      if (S.account) {
        // 以备份为准覆盖云端：把基准版本对齐到云端最新，避免被当成冲突去合并
        S.me = await acct.api("GET", "/api/me");
        S.account.version = S.me.vault_version;
        await pushVault();
      }
      location.reload();
    } catch (err) { toast(err.message, 5000); }
  };
  $("#wipe").onclick = async () => {
    if (!confirm(S.account ? "清空这台设备上的数据并退出登录？云端的加密数据不受影响。" : "清空这台设备上的所有流水、计划和复盘？清空前建议先导出备份。")) return;
    if (S.account) await acct.api("POST", "/api/logout").catch(() => {});
    await store.clearAll();
    location.hash = "";
    location.reload();
  };
};

// ---------- 复盘 ----------
// 按用户选的周期（周 / 月 / 季度）复盘“最近一个完整期”（key），定下“这一期”（key 的下一期）的 3 个目标；
// 下一次复盘时自动判定完成了没有
const recapsOf = (cadence) => S.recaps.filter((r) => cadenceOf(r.period) === cadence);

function viewReview() {
  const cad = S.settings.cadence, C = CADENCES[cad];
  const last = S.ov.window.last;
  const key = lastFullPeriod(last, cad), next = shiftPeriod(key, 1);
  const stats = periodStats(S.txs, S.kinds, S.plan, key, { bigMin: S.settings.bigMin });
  const rep = S.recaps.find((r) => r.period === key);
  const prev = S.recaps.find((r) => r.period === shiftPeriod(key, -1));
  const diff = stats.avg ? (stats.total - stats.avg) / stats.avg : null;
  const yoy = stats.yoy ? (stats.total - stats.yoy) / stats.yoy : null;
  const prevGoals = (prev?.goals || []).map((g) => ({ g, e: evalGoal(g, S.txs, S.kinds, key, S.goalChecks, last) }));
  const cands = goalCandidates(S, stats);
  // 日历上已经过完的上一期，数据还没覆盖到：提醒导入
  const calLast = shiftPeriod(periodOf(ymd(new Date()), cad), -1);
  const behind = periodEnd(key) < periodEnd(calLast);
  const history = recapsOf(cad).filter((r) => r.period !== key).sort((a, b) => (a.period < b.period ? 1 : -1));
  return `
  <section class="card">
    <div class="card-head"><h2>复盘周期</h2><span class="seg-ctl">${Object.entries(CADENCES).map(([c, v]) => `<button data-cad="${c}" class="${c === cad ? "on" : ""}">${v.name}</button>`).join("")}</span></div>
    <p class="muted small">复盘、目标、提醒邮件都按这个周期。按月最省心：月初导一次账单，和每月消费卡对得上。</p>
  </section>
  ${S.account ? "" : loginCard(`每${C.unit}初提醒你复盘`, `登录后：每${C.unit}初收到一封提醒邮件（不含任何金额），复盘和目标在多台设备间加密同步。内测期间凭邀请码注册。`)}
  ${behind ? `<section class="card warn-card"><b>最新的数据到 ${last}，${periodName(calLast)}的账单还没导入。</b> 导入后才能复盘${C.last}。
    <span class="muted small">微信：我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单；收到的 zip 直接拖进来。</span>
    ${S.demo ? "" : `<button class="primary" data-action="import">导入账单</button>`}</section>` : ""}

  <section class="card">
    <div class="card-head"><h2>${C.cur}的 3 个目标 <span class="muted small">${periodName(next)}</span></h2>${rep ? `<span class="muted small">${last >= periodStart(next) ? `按截至 ${last.slice(5)} 的数据` : `导入${C.cur}的账单后自动判定`}</span>` : ""}</div>
    ${rep ? `<div class="wgoals">${rep.goals.map((g) => goalRow(g, next, last)).join("")}</div>`
      : `<p class="muted">生成${C.last}的复盘后，教练会从下面 ${cands.length} 个候选里挑 3 个最值得做的，作为${C.cur}的目标。每个目标都能用流水自动判定完成了没有。</p>
         <details><summary class="small">看看候选目标</summary><ul class="small">${cands.map((c) => `<li>${esc(c.text)} <span class="muted">${esc(c.basis || "")}</span></li>`).join("")}</ul></details>`}
  </section>

  <section class="card">
    <div class="card-head"><h2>${C.last}复盘 <span class="muted small">${periodName(key)}</span></h2>
      <span class="actions"><button class="${rep ? "" : "primary"}" id="w-go" ${aiBusy || S.demo && !S.account ? "disabled" : ""}>${aiBusy ? "生成中…" : rep ? "重新生成" : "生成复盘"}</button></span></div>
    <section class="kpis compact">
      ${tile(`${C.last}支出`, yuan(stats.total), stats.avg === null ? `${stats.count} 笔` : `前 ${stats.periods} 个${C.unit}平均 ${yuan(stats.avg)}（${diff >= 0 ? "+" : ""}${pct(diff)}）`, diff > 0.15 ? "up" : diff < -0.1 ? "good" : "")}
      ${cad === "week" ? "" : tile("去年同期", stats.yoy === null ? "—" : yuan(stats.yoy), yoy === null ? "没有去年同期的数据" : `${C.last}比去年同期 ${yoy >= 0 ? "+" : ""}${pct(yoy)}`, yoy > 0.1 ? "up" : "")}
      ${tile("消费卡", `${yuan(stats.daily)} / ${yuan(stats.quota)}`, stats.daily > stats.quota ? `超了 ${yuan(stats.daily - stats.quota)}` : `剩 ${yuan(stats.quota - stats.daily)}`, stats.daily > stats.quota ? "up" : "good")}
      ${tile(`${C.last}的目标`, prevGoals.length ? `${prevGoals.filter((x) => x.e.done).length} / ${prevGoals.length}` : "—", prevGoals.length ? "达成" : "还没有定过目标")}
    </section>
    ${prevGoals.length ? `<div class="wgoals">${prevGoals.map(({ g, e }) => `<div class="wgoal ${e.done ? "done" : "miss"}"><span class="mark">${e.done ? "✓" : "✗"}</span><div>${esc(g.text)}${e.actual !== null ? ` <span class="muted small">实际 ${goalActual(g, e)}</span>` : ""}</div></div>`).join("")}</div>` : ""}
    ${barChart(stats.trend.map((x, i) => ({ label: periodTick(x.key), value: x.total, muted: i < stats.trend.length - 1, tip: `${periodName(x.key)}：${yuan(x.total)}` })), { fmt: yuan, label: `每${C.unit}支出`, width: chartWidth() })}
    <details class="peek"><summary>查看将发送给 AI 的内容</summary><pre id="w-peek"></pre></details>
    ${rep ? `${recapCard(rep)}${S.account && S.config.email_enabled && !S.demo ? `<p class="small"><button id="w-mail" class="ghost">📧 发到我的邮箱</button> <span class="muted">邮件里会有金额、会经过你的邮箱服务商；发完我们不保存。</span></p>` : ""}`
      : `<p class="muted">教练会看${C.last}花在哪、和前几个${C.unit}${cad === "week" ? "" : "、去年同期"}比怎么样、${C.last}的目标完成了没有，然后定${C.cur}的 3 个目标。复盘只存在你的设备和加密同步里，服务器上没有。</p>`}
  </section>

  <section class="card">
    <div class="card-head"><h2>${C.last}花在哪</h2><span class="muted small">和前 ${stats.periods || "几"} 个${C.unit}平均比</span></div>
    <div class="tbl"><table>
      <thead><tr><th>分类</th><th class="num">${C.last}</th><th class="num">次数</th><th class="num">每${C.unit}平均</th><th class="num">差</th></tr></thead>
      <tbody>${stats.byCat.filter((c) => c.cur > 0 || c.kind === "daily").slice(0, 12).map((c) => { const d = c.cur - c.avg; return `<tr><td>${esc(c.cat2)} <span class="tag">${KINDS[c.kind].name}</span></td><td class="num">${yuan(c.cur)}</td><td class="num">${c.count}</td><td class="num muted">${yuan(c.avg)}</td><td class="num ${d > 200 && d > c.avg * 0.3 ? "bad" : d < -100 ? "good-text" : ""}">${yuan(d, { sign: true })}</td></tr>`; }).join("")}</tbody>
    </table></div>
    ${stats.big.length ? `<p class="small">${yuan(stats.bigMin)} 以上：${stats.big.slice(0, 10).map((t) => `${t.date.slice(5)} ${esc(t.cat2)} <b>${yuan(t.amount)}</b>`).join("，")}</p>` : ""}
  </section>

  ${history.length ? `<section class="card"><details><summary>以前的复盘（${history.length}）</summary>
    ${history.map((r) => `<div class="muted small" style="margin-top:14px">${periodName(r.period)}</div>${recapCard(r)}`).join("")}</details></section>` : ""}

  ${S.me?.weekly_email ? "" : `<p class="muted small center">不用邮件的话，也可以 <a href="#" id="w-ics">把“每${C.unit}初复盘”加到日历</a>。</p>`}`;
}

function goalRow(g, key, last) {
  if (g.type === "manual") {
    const k = `${key}|${g.id}`;
    return `<label class="wgoal check ${S.goalChecks[k] ? "done" : ""}"><input type="checkbox" data-goal="${esc(k)}" ${S.goalChecks[k] ? "checked" : ""} ${S.demo ? "disabled" : ""}><div>${esc(g.text)}${g.why ? `<div class="muted small">${esc(g.why)}</div>` : ""}</div></label>`;
  }
  const started = last >= periodStart(key);
  const e = evalGoal(g, S.txs, S.kinds, key, S.goalChecks, last);
  const ratio = g.limit > 0 ? e.actual / g.limit : e.actual > 0 ? 2 : 0;
  return `<div class="wgoal ${started && !e.done ? "miss" : ""}"><span class="mark">${!started ? "○" : e.done ? (e.final ? "✓" : "…") : "✗"}</span><div class="grow">
    <div>${esc(g.text)}</div>
    ${started ? `<div class="bar"><i class="${e.done ? "" : "warn"}" style="width:${Math.min(100, ratio * 100)}%"></i></div><div class="small muted">已经 ${goalActual(g, e)} / ${g.metric === "count" ? `${g.limit} 次` : yuan(g.limit)}</div>` : ""}
    ${g.why ? `<div class="muted small">${esc(g.why)}</div>` : ""}</div></div>`;
}

function recapCard(r) {
  const C = CADENCES[cadenceOf(r.period)];
  return `<div class="report">
    <h3>${esc(r.headline)}</h3>
    <div class="two-col">
      ${r.wins?.length ? `<div><h4>👍 做得好</h4><ul>${r.wins.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      ${r.watch?.length ? `<div><h4>👀 要注意</h4><ul>${r.watch.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    </div>
    <h4>${C.cur}的目标</h4><ol>${(r.goals || []).map((g) => `<li><b>${esc(g.text)}</b>${g.why ? `<div class="muted small">${esc(g.why)}</div>` : ""}</li>`).join("")}</ol>
    ${r.tip ? `<p class="question">💡 ${esc(r.tip)}</p>` : ""}
  </div>`;
}

bind.viewReview = () => {
  const cad = S.settings.cadence;
  const key = lastFullPeriod(S.ov.window.last, cad);
  $("#w-peek").closest("details").ontoggle = () => { $("#w-peek").textContent = JSON.stringify(periodContext(S, key), null, 1); };
  $$("[data-cad]").forEach((b) => (b.onclick = async () => {
    if (b.dataset.cad === cad) return;
    S.settings.cadence = b.dataset.cad;
    await store.set("settings", S.settings);
    route();
    if (S.account && !S.demo) {
      try {
        await acct.api("PUT", "/api/settings", { cadence: S.settings.cadence });
        if (S.me) S.me.cadence = S.settings.cadence;
      } catch (e) { toast(e.message, 5000); }
    }
  }));
  $("#w-go").onclick = async () => {
    if (!needAccount() || !(await needConsent())) return;
    aiBusy = true; route();
    try {
      const rep = await ai.recap(periodContext(S, key));
      S.recaps = S.recaps.filter((r) => r.period !== key).concat({ ...rep, at: Date.now() });
      await save("recaps");
    } catch (e) { toast(e.message, 5000); }
    aiBusy = false; route();
  };
  if ($("#w-mail")) $("#w-mail").onclick = async () => {
    const rep = S.recaps.find((r) => r.period === key);
    try {
      await ai.emailRecap(rep);
      toast(`发到 ${S.account.email} 了`);
    } catch (e) { toast(e.message, 5000); }
  };
  $$("[data-goal]").forEach((c) => (c.onchange = async () => {
    if (c.checked) S.goalChecks[c.dataset.goal] = true; else delete S.goalChecks[c.dataset.goal];
    await save("goalChecks");
    route();
  }));
  if ($("#w-ics")) $("#w-ics").onclick = (e) => { e.preventDefault(); calendar(cad); };
};

// 日历提醒（.ics）：每周一 / 每月 1 号 / 每季度第一天 20:00
function calendar(cadence) {
  const C = CADENCES[cadence], today = ymd(new Date());
  const rule = { week: "WEEKLY;BYDAY=MO", month: "MONTHLY;BYMONTHDAY=1", quarter: "MONTHLY;INTERVAL=3;BYMONTHDAY=1" }[cadence];
  const first = cadence === "week" ? addDays(mondayOf(today), 7) : periodStart(shiftPeriod(periodOf(today, cadence), 1));
  const title = `每${C.unit}节流复盘`;
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SaveWise//CN", "BEGIN:VEVENT",
    `UID:savewise-review-${cadence}-${S.settings.deviceId}`, `DTSTART;TZID=Asia/Shanghai:${first.replaceAll("-", "")}T200000`, "DURATION:PT20M",
    `RRULE:FREQ=${rule}`, `SUMMARY:SaveWise ${title}`, `DESCRIPTION:导出${C.last}的微信/支付宝/随手记账单拖进来，生成复盘，定${C.cur}的 3 个目标。 ${location.origin}`,
    "BEGIN:VALARM", "TRIGGER:-PT0M", "ACTION:DISPLAY", `DESCRIPTION:${title}`, "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  download(`savewise-${title}.ics`, ics, "text/calendar");
}

// ---------- 隐私 ----------
// 用大白话讲清楚数据在哪、谁能看到，以及用户怎么自己核对
const PRIVACY_ROWS = [
  ["逐笔流水（时间、金额、商户、备注）", "你的浏览器。登录后，云端另存一份用你的密码加密过的密文", "只有你"],
  ["计划、可砍清单的选择、复盘、目标、AI 问答记录", "同上：浏览器 + 云端密文", "只有你"],
  ["邮箱、复盘周期、提醒开关", "服务器", "我们（用来登录、发提醒）"],
  ["AI 用到的汇总（按月、按分类的金额，不含逐笔流水）", "不保存：经服务器转给 DeepSeek，拿到回答就丢掉", "DeepSeek 处理这一次请求"],
  ["复盘提醒邮件", "不含任何金额", "你的邮箱服务商"],
  ["「发到我的邮箱」的复盘", "只在你点了按钮时发一次，发完不保存", "你的邮箱服务商"],
];

let outbox = [];
function viewPrivacy() {
  const ago = (t) => new Date(t).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `
  <section class="card insight">
    <h2>你的账单，只有你看得到</h2>
    <p><b>账单在你的浏览器里解析，不上传。</b>不登录时，数据只存在这台设备上。</p>
    <p><b>登录后，数据先在你的浏览器里用你的密码加密，再同步到云端。</b>服务器只存一串密文，钥匙只在你的设备上——我们解不开，也不能替你找回。</p>
    <p><b>服务器上没有任何明文的流水、汇总或复盘。</b>AI 只在你点按钮时收到一份按月、按分类的汇总，用完就丢；提醒邮件不含任何金额。</p>
  </section>

  <section class="card">
    <h2>每样数据在哪、谁能看到</h2>
    <div class="tbl"><table>
      <thead><tr><th>数据</th><th>存在哪</th><th>谁能看到</th></tr></thead>
      <tbody>${PRIVACY_ROWS.map(([a, b, c]) => `<tr><td>${a}</td><td>${b}</td><td><b>${c}</b></td></tr>`).join("")}</tbody>
    </table></div>
  </section>

  <section class="card">
    <h2>怎么做到的</h2>
    <ul class="privacy-list">
      <li><b>在浏览器里算</b>：解析账单、找可砍项、算计划和复盘的数字，全部在你的浏览器里完成。服务器给你的只是网页本身。</li>
      <li><b>端到端加密</b>（和密码管理器 Bitwarden 同一种做法）：你的密码在浏览器里派生出两把钥匙，一把用来登录（服务器只存它的哈希），一把用来加密数据（AES-256-GCM），后者从不离开你的设备。</li>
      <li><b>网页只能连本站</b>：页面设置了内容安全策略（CSP），脚本无法把数据发到别的网站；所有代码都从本站加载，不用第三方 CDN 和统计脚本。</li>
      <li><b>AI 只看汇总</b>：发给 AI 的是“外卖这个月 ¥800、去年同期 ¥650”这样的汇总，不发逐笔流水、账户、订单号；商户名可以在「数据 → 设置」里关掉。服务器只记调用次数和成本，不记内容。</li>
      <li><b>邮件不带金额</b>：每期初的提醒只说“该复盘了”。想把复盘发到邮箱，要你自己点按钮，发完不保存。</li>
    </ul>
  </section>

  <section class="card">
    <div class="card-head"><h2>数据流向账：这台设备发出去过什么</h2>${outbox.length ? `<button class="ghost small" id="ob-clear">清空记录</button>` : ""}</div>
    <p class="muted small">每次往服务器发和支出有关的数据，这里都记一条，点开能看到发出去的原文。记录只存在这台设备上。</p>
    ${outbox.length ? `<div class="outbox">${outbox.slice().reverse().map((x) => `<details><summary><span class="tag">${esc(x.kind)}</span> ${ago(x.at)} <span class="muted small">${(x.size / 1024).toFixed(1)} KB · ${esc(x.note)}</span></summary><pre>${esc(x.content)}</pre></details>`).join("")}</div>`
      : `<p class="muted">还没有发出过任何数据。${S.account ? "" : "不登录时，除了网页本身，什么都不会离开这台设备。"}</p>`}
  </section>

  <section class="card">
    <h2>你随时可以</h2>
    <ul class="privacy-list">
      <li><b>不登录使用</b>：体检、可砍清单、计划、复盘的数字全部可用，只是没有 AI 和多设备同步。</li>
      <li><b>不用 AI</b>：在「数据 → 设置」里取消同意，不会再发出任何汇总。</li>
      <li><b>导出、清空</b>：在「数据 → 设置」里导出完整备份，或一键清空这台设备上的所有数据。</li>
      <li><b>注销账号</b>：云端的密文、账号立即删除，不能恢复。</li>
    </ul>
  </section>

  <section class="card">
    <h2>需要你知道的</h2>
    <ul class="privacy-list muted">
      <li>忘了密码，我们没法帮你解开云端数据：重设密码后云端密文会清空，在存有数据的设备上登录一次就会重新同步。</li>
      <li>用 AI 时，那一次的汇总会经过我们的服务器转给 DeepSeek，由 DeepSeek 按它的隐私政策处理。</li>
      <li>邮件会经过你的邮箱服务商，所以提醒邮件里不放金额。</li>
    </ul>
  </section>
  ${S.txs.length ? "" : `<p class="center"><a href="#" data-action="import">导入账单</a> · <a href="#" data-action="demo">先看演示数据</a> · <a href="#" id="pv-home">回首页</a></p>`}`;
}

bind.viewPrivacy = () => {
  if (!bind.viewPrivacy.loaded) {
    bind.viewPrivacy.loaded = true;
    readOutbox().then((x) => { outbox = x; if (location.hash === "#privacy") route(); bind.viewPrivacy.loaded = false; });
  }
  if ($("#ob-clear")) $("#ob-clear").onclick = async () => { await clearOutbox(); outbox = []; route(); };
  if ($("#pv-home")) $("#pv-home").onclick = (e) => { e.preventDefault(); location.hash = ""; };
};

// ---------- 账号与同步 ----------
const hasLocalData = () => S.datasets.length > 0;

async function bundle() {
  const data = { app: "savewise", version: 1, exportedAt: new Date().toISOString(), datasets: S.datasets, tx: {} };
  for (const d of S.datasets) data.tx[d.id] = (await store.get(`tx:${d.id}`)) || [];
  for (const k of SYNCED) data[k] = S[k];
  return data;
}

// 用一份完整数据替换本机数据（云端下载、从备份恢复）
async function applyBundle(b) {
  for (const k of await store.keys()) if (String(k).startsWith("tx:")) await store.del(k);
  for (const d of b.datasets || []) await store.set(`tx:${d.id}`, b.tx?.[d.id] || []);
  await store.set("datasets", b.datasets || []);
  const def = blank();
  for (const k of SYNCED) await store.set(k, b[k] ?? def[k]);
  await loadLocal();
}

function setSync(state, error = "") {
  S.sync = { state, error };
  updateAccountUI();
  if (location.hash === "#data" && $("#account")) $("#account").outerHTML = accountSection(), bind.viewData();
}

function updateAccountUI() {
  const b = $("#btn-account");
  b.textContent = S.account ? `${S.sync.state === "error" ? "⚠ " : S.sync.state === "syncing" ? "☁️ " : ""}${S.account.email.split("@")[0]}` : "登录";
  b.title = S.account ? `${S.account.email}${S.sync.error ? ` · 同步失败：${S.sync.error}` : ""}` : "登录后每周收到复盘邮件，多设备加密同步";
  $("#btn-admin").classList.toggle("hidden", !S.me?.is_admin);
}

let syncTimer;
function markDirty() {
  if (!S.account || S.demo) return;
  S.account.dirty = true;
  store.set("account", S.account);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushVault, 1500);
}

let syncBusy = false, syncAgain = false;
async function pushVault() {
  if (!S.account || !S.key || S.demo) return;
  if (syncBusy) { syncAgain = true; return; }
  syncBusy = true;
  setSync("syncing");
  try {
    for (let i = 0; ; i++) {
      try {
        const sealed = await acct.seal(await bundle(), S.key);
        logUpload("加密同步", `${sealed.data.slice(0, 600)}…（共 ${(sealed.data.length / 1048576).toFixed(1)}MB）`, "流水、计划、复盘在浏览器里用你的密码加密后上传；服务器只存这串密文，解不开");
        const { version } = await acct.api("PUT", "/api/vault", { base_version: S.account.version, ...sealed });
        Object.assign(S.account, { version, dirty: false, syncedAt: Date.now() });
        await store.set("account", S.account);
        break;
      } catch (e) {
        if (e.status !== 409 || i >= 2) throw e;
        await pullVault(true); // 别的设备先改过：合并后再传
      }
    }
    setSync("ok");
  } catch (e) {
    if (e.status === 401) sessionLost(); else setSync("error", e.message);
  }
  syncBusy = false;
  if (syncAgain) { syncAgain = false; pushVault(); }
}

// 下载云端数据；merge=true 时和本机数据合并（本机优先），否则直接用云端的
async function pullVault(merge) {
  const v = await acct.api("GET", "/api/vault");
  if (!v.version) return false;
  const cloud = await acct.unseal(v, S.key);
  await applyBundle(merge ? acct.mergeBundles(await bundle(), cloud) : cloud);
  S.account.version = v.version;
  if (merge) S.account.dirty = true;
  await store.set("account", S.account);
  if (!S.demo) rerender();
  return true;
}

// 打开页面时：云端比本机新就拉下来，本机有没传的改动就推上去
async function syncAccount() {
  try {
    S.me = await acct.api("GET", "/api/me");
    await adoptCadence();
  } catch (e) {
    if (e.status === 401) sessionLost(); else setSync("error", "连不上服务器");
    return;
  }
  if (!S.key) return sessionLost();
  try {
    if (S.me.vault_version > S.account.version) await pullVault(S.account.dirty);
    else if (S.me.vault_version < S.account.version) { S.account.version = S.me.vault_version; S.account.dirty = hasLocalData(); } // 云端被清过（重设密码）
    if (S.account.dirty) await pushVault(); else setSync("ok");
  } catch (e) { setSync("error", e.message); }
  await migrateRecaps();
}

// 以前的版本把复盘存在服务器上：取回来放进加密数据，同步成功后让服务器删掉
async function migrateRecaps() {
  if (!S.me?.legacy_recaps) return;
  try {
    const { reports } = await acct.api("GET", "/api/recaps/legacy");
    const have = new Set(S.recaps.map((r) => r.period));
    S.recaps = S.recaps.concat(reports.filter((r) => !have.has(r.period)));
    await store.set("recaps", S.recaps);
    S.account.dirty = true;
    await pushVault();
    if (!S.account.dirty) { await acct.api("DELETE", "/api/recaps/legacy"); S.me.legacy_recaps = 0; }
    if (!S.demo) rerender();
  } catch { /* 下次登录再试 */ }
}

// 复盘周期以服务器为准（定时任务按它发邮件）
async function adoptCadence() {
  if (!S.me?.cadence || S.me.cadence === S.settings.cadence) return;
  S.settings.cadence = S.me.cadence;
  await store.set("settings", S.settings);
}


async function sessionLost() {
  S.account = S.key = S.me = null;
  await store.del("account");
  await store.del("dataKey");
  setSync("");
  toast("登录已失效，请重新登录（本机数据还在）", 5000);
}

async function startSession(email, key) {
  if (S.demo) { S.demo = false; await loadLocal(); }
  S.key = key;
  S.account = { email: email.trim().toLowerCase(), version: 0, dirty: hasLocalData(), syncedAt: 0 };
  await store.set("dataKey", key);
  await store.set("account", S.account);
  S.me = await acct.api("GET", "/api/me");
  await adoptCadence();
  // 云端已有数据：本机没数据就直接用云端的，有就合并
  if (S.me.vault_version) await pullVault(hasLocalData());
  if (S.account.dirty) await pushVault(); else setSync("ok");
  await migrateRecaps();
  rerender();
}

async function logout() {
  const wipe = confirm("退出登录后，要同时清除这台设备上的数据吗？\n\n确定：清除（公用电脑建议这样做；云端有加密备份，下次登录会同步回来）\n取消：保留在这台设备上");
  if (S.account?.dirty) await pushVault();
  await acct.api("POST", "/api/logout").catch(() => {});
  await store.del("account");
  await store.del("dataKey");
  if (wipe) { await store.clearAll(); location.hash = ""; location.reload(); return; }
  S.account = S.key = S.me = null;
  setSync("");
  route();
}

async function deleteAccount() {
  if (prompt(`注销账号会删除云端的加密数据、复盘和账号本身，不能恢复。本机数据会保留。\n\n确认的话，输入你的邮箱：`)?.trim().toLowerCase() !== S.account.email) return;
  try {
    await acct.api("DELETE", "/api/account");
  } catch (e) { return toast(e.message, 5000); }
  await store.del("account");
  await store.del("dataKey");
  S.account = S.key = S.me = null;
  setSync("");
  toast("账号已注销，云端数据已删除");
  route();
}

// 登录 / 注册 / 忘记密码 / 重设密码 / 修改密码 共用一个对话框
const ACCOUNT_MODES = {
  login: { title: "登录", ok: "登录", fields: ["email", "pw"] },
  register: { title: "注册", ok: "注册", fields: ["email", "pw", "pw2", "invite"] },
  forgot: { title: "忘记密码", ok: "发送重设链接", fields: ["email"] },
  reset: { title: "重设密码", ok: "重设并登录", fields: ["email", "pw", "pw2"] },
  change: { title: "修改密码", ok: "修改", fields: ["old", "pw", "pw2"] },
};
let accountCtx = {};

function openAccount(mode, ctx = {}) {
  accountCtx = { ...ctx, mode };
  const m = ACCOUNT_MODES[mode];
  const dlg = $("#dlg-account");
  $("#acc-title").textContent = m.title;
  $("#acc-ok").textContent = m.ok;
  for (const f of ["email", "old", "pw", "pw2", "invite"]) $(`#acc-row-${f}`).classList.toggle("hidden", !m.fields.includes(f) || (f === "invite" && !S.config.invite_required));
  $("#acc-pw-label").textContent = mode === "login" ? "密码" : mode === "change" || mode === "reset" ? "新密码" : "密码（至少 8 位）";
  $("#acc-pw").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("#acc-email").readOnly = mode === "reset";
  $("#acc-email").value = ctx.email || $("#acc-email").value || "";
  for (const f of ["old", "pw", "pw2"]) $(`#acc-${f}`).value = "";
  $("#acc-error").textContent = "";
  $("#acc-sub").innerHTML = {
    login: ctx.why ? `${esc(ctx.why)}。还没有账号？<a href="#" data-mode="register">注册</a>` : `还没有账号？<a href="#" data-mode="register">注册</a>`,
    register: `已有账号？<a href="#" data-mode="login">登录</a>`,
    forgot: "我们会把重设链接发到这个邮箱。",
    reset: "设置一个新密码。",
    change: "",
  }[mode];
  $("#acc-note").innerHTML = {
    login: `<a href="#" data-mode="forgot">忘记密码？</a>`,
    register: "密码在你的浏览器里用来加密数据，我们看不到，也帮不了你找回。忘了可以重设，但云端的加密数据会清空（本机的数据不受影响，登录后会重新上传）。",
    forgot: "",
    reset: "云端的加密数据是用旧密码加密的，重设后会清空。在存有数据的设备上登录一次，就会用新密码重新同步。",
    change: "会用新密码重新加密云端的数据，其他设备需要重新登录。",
  }[mode];
  if (!dlg.open) dlg.showModal();
}

async function openReset(token) {
  history.replaceState(null, "", location.pathname);
  try {
    const { email } = await acct.api("GET", `/api/password/reset/${encodeURIComponent(token)}`);
    openAccount("reset", { email, token });
  } catch (e) { toast(e.message, 5000); }
}

async function submitAccount(e) {
  e.preventDefault();
  const { mode } = accountCtx;
  const email = $("#acc-email").value.trim().toLowerCase(), pw = $("#acc-pw").value;
  const err = (msg) => { $("#acc-error").textContent = msg; };
  if (mode !== "change" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("邮箱格式不对");
  if (["register", "reset", "change"].includes(mode)) {
    if (pw.length < 8) return err("密码至少 8 位");
    if (pw !== $("#acc-pw2").value) return err("两次输入的密码不一样");
  }
  const btn = $("#acc-ok");
  btn.disabled = true;
  err("");
  try {
    if (mode === "forgot") {
      await acct.api("POST", "/api/password/forgot", { email });
      $("#dlg-account").close();
      toast("如果这个邮箱注册过，重设链接已经发过去了（1 小时内有效）", 6000);
    } else if (mode === "change") {
      const old = await acct.deriveKeys(S.account.email, $("#acc-old").value);
      const nu = await acct.deriveKeys(S.account.email, pw);
      if (S.me && S.me.vault_version > S.account.version) await pullVault(S.account.dirty);
      const vault = await acct.seal(await bundle(), nu.key);
      const { version } = await acct.api("POST", "/api/password/change", { old_auth: old.auth, new_auth: nu.auth, vault });
      S.key = nu.key;
      Object.assign(S.account, { version, dirty: false, syncedAt: Date.now() });
      await store.set("dataKey", nu.key);
      await store.set("account", S.account);
      $("#dlg-account").close();
      toast("密码改好了，云端数据已用新密码重新加密");
    } else {
      btn.textContent = "加密计算中…";
      const { auth, key } = await acct.deriveKeys(email, pw);
      if (mode === "reset") await acct.api("POST", "/api/password/reset", { token: accountCtx.token, auth });
      else await acct.api("POST", `/api/${mode}`, { email, auth, invite_code: $("#acc-invite").value.trim() });
      $("#dlg-account").close();
      await startSession(email, key);
      toast(mode === "register" ? "注册好了。去「复盘」看看上个月吧" : "已登录，数据已同步");
    }
  } catch (ex) { err(ex.message); }
  btn.disabled = false;
  btn.textContent = ACCOUNT_MODES[mode].ok;
}

// ---------- 导入 ----------
let pending = [];
function openImport() {
  pending = [];
  $("#import-result").innerHTML = "";
  $("#import-confirm").disabled = true;
  $("#dlg-import").showModal();
}

function askPassword(name, wrong) {
  const dlg = $("#dlg-password");
  $("#pw-hint").textContent = `${name} 是加密的压缩包`;
  $("#pw-error").textContent = wrong ? "密码不对，再试一次" : "";
  $("#pw-input").value = "";
  dlg.showModal();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; dlg.close(); resolve(v); };
    $("#pw-ok").onclick = () => finish($("#pw-input").value);
    $("#pw-input").onkeydown = (e) => { if (e.key === "Enter") finish($("#pw-input").value); };
    dlg.onclose = () => finish(null);
  });
}

async function handleFiles(files) {
  if (!files.length) return;
  $("#import-result").innerHTML = `<p class="muted">正在本机解析 ${files.length} 个文件…</p>`;
  const results = await readFiles([...files], { askPassword });
  for (const r of results) for (const t of r.txs) t.id = hash(txKey(t));
  pending = pending.concat(results.filter((r) => r.txs.length));
  // 与其他来源已有数据的重叠：在两边都有数据的日期范围内，同一天、同金额的支出占多少
  const base = S.demo ? [] : S.raw;
  const existingIds = new Set(base.map((t) => t.id));
  const overlapWith = (r) => {
    const others = base.filter((t) => t.type === "expense" && t.source !== r.source);
    if (!others.length) return { ratio: 0, sources: [] };
    const keys = new Set(others.map((t) => `${t.date}|${t.amount}`));
    const days = others.map((t) => t.date).sort();
    const inRange = r.txs.filter((t) => t.type === "expense" && t.date >= days[0] && t.date <= days[days.length - 1]);
    const hits = inRange.filter((t) => keys.has(`${t.date}|${t.amount}`)).length;
    return { ratio: inRange.length >= 10 ? hits / inRange.length : 0, sources: [...new Set(others.map((t) => t.source))] };
  };
  $("#import-result").innerHTML = results.map((r) => {
    if (!r.txs.length) return `<div class="file-row err"><b>${esc(r.fileName)}</b>${r.sheetName ? ` / ${esc(r.sheetName)}` : ""}：${esc(r.error || "没有认出交易记录")}</div>`;
    const exp = r.txs.filter((t) => t.type === "expense");
    const dates = r.txs.map((t) => t.date).sort();
    const dup = r.txs.filter((t) => existingIds.has(t.id)).length;
    const { ratio: overlap, sources: crossSrc } = overlapWith(r);
    return `<div class="file-row">
      <b>${esc(r.fileName)}</b>${r.sheetName ? ` / ${esc(r.sheetName)}` : ""} <span class="tag">${esc(SOURCES[r.source])}</span>
      <div class="small">${r.txs.length} 笔（支出 ${exp.length} 笔 ${yuan(sum(exp, (t) => t.amount))}）· ${dates[0]} ~ ${dates[dates.length - 1]}${r.skipped ? ` · 跳过 ${r.skipped} 行（关闭、全额退款或空行）` : ""}${dup ? ` · ${dup} 笔已导入过，会自动跳过` : ""}</div>
      ${overlap > 0.3 ? `<div class="small bad">⚠ 在时间重叠的部分，${pct(overlap)} 的支出和已导入的${crossSrc.map((s) => SOURCES[s]).join("、")}数据同一天同金额，很可能是同一笔钱记了两次。随手记记全了的话，建议只保留随手记（可以在「数据」页删除其他来源）。</div>` : ""}
    </div>`;
  }).join("");
  $("#import-confirm").disabled = !pending.length;
}

async function confirmImport() {
  if (S.demo) { S.demo = false; await loadLocal(); }
  const existingIds = new Set(S.raw.map((t) => t.id));
  let added = 0;
  for (const r of pending) {
    const fresh = [];
    for (const t of r.txs) if (!existingIds.has(t.id)) { existingIds.add(t.id); fresh.push(t); }
    if (!fresh.length) continue;
    const id = hash(`${r.fileName}|${r.sheetName}|${Date.now()}|${Math.random()}`);
    for (const t of fresh) t.ds = id;
    const dates = fresh.map((t) => t.date).sort();
    S.datasets.push({ id, source: r.source, fileName: r.sheetName ? `${r.fileName} / ${r.sheetName}` : r.fileName, importedAt: Date.now(), count: fresh.length, from: dates[0], to: dates[dates.length - 1] });
    await store.set(`tx:${id}`, fresh);
    S.raw.push(...fresh);
    added += fresh.length;
  }
  await store.set("datasets", S.datasets);
  if (added) markDirty();
  $("#dlg-import").close();
  pending = [];
  compute();
  toast(added ? `导入了 ${added} 笔新记录` : "没有新记录（都已经导入过了）");
  location.hash = "#overview";
  route();
}

// ---------- 全局事件 ----------
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-action]");
  if (a) {
    e.preventDefault();
    if (a.dataset.action === "import") openImport();
    if (a.dataset.action === "demo") enterDemo();
    if (a.dataset.action === "exit-demo") exitDemo();
    if (a.dataset.action === "login" || a.dataset.action === "register") openAccount(a.dataset.action);
  }
  const m = e.target.closest("#dlg-account [data-mode]");
  if (m) { e.preventDefault(); openAccount(m.dataset.mode, { email: $("#acc-email").value }); }
  const c = e.target.closest("dialog [data-close]");
  if (c) c.closest("dialog").close();
});
$("#btn-import").onclick = openImport;
$("#btn-admin").onclick = () => { location.href = "/admin"; };
$("#btn-account").onclick = () => { if (!S.account) return openAccount("login"); location.hash = "#data"; setTimeout(() => $("#account")?.scrollIntoView({ behavior: "smooth" }), 50); };
$("#acc-form").onsubmit = submitAccount;
$("#pick").onclick = (e) => { e.preventDefault(); $("#file-input").click(); };
$("#file-input").onchange = (e) => { handleFiles(e.target.files); e.target.value = ""; };
$("#import-confirm").onclick = confirmImport;
$("#consent-check").onchange = (e) => ($("#consent-ok").disabled = !e.target.checked);
const drop = $("#drop");
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); handleFiles(e.dataTransfer.files); };

// 图表悬停提示
const tip = $("#tip");
document.addEventListener("pointermove", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (!el) { tip.classList.add("hidden"); $$(".line-chart .focus, .line-chart .xhair").forEach((f) => f.classList.add("hidden")); return; }
  tip.textContent = el.dataset.tip;
  tip.classList.remove("hidden");
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY + 14}px`;
  if (el.dataset.x) {
    const f = el.closest("svg").querySelector(".focus");
    f.setAttribute("cx", el.dataset.x); f.setAttribute("cy", el.dataset.y); f.classList.remove("hidden");
  }
  if (el.dataset.xhair) {
    const l = el.closest("svg").querySelector(".xhair");
    l.setAttribute("x1", el.dataset.xhair); l.setAttribute("x2", el.dataset.xhair); l.classList.remove("hidden");
  }
});

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});

boot();
