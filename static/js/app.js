import * as acct from "./account.js";
import * as ai from "./ai.js";
import { KINDS, TAXONOMY, defaultKind } from "./categorize.js";
import { barChart, ledgerChart, lineChart, stackBar } from "./charts.js";
import { demoTransactions } from "./demo.js";
import { $, $$, download, esc, hash } from "./dom.js";
import { readFiles } from "./files.js";
import { isSpend, opportunities, overview, spend, totalSaving } from "./analyze.js";
import { SOURCES, txKey } from "./parse.js";
import { cardLedger, defaultPlan, freedomFund, lumpyStatus } from "./plan.js";
import * as store from "./store.js";
import { addMonths, daysBetween, groupBy, monthOf, pct, round, sum, ymd, yuan } from "./util.js";
import { addDays, evalGoal, goalActual, goalCandidates, lastFullWeek, mondayOf, weekLabel, weekStats, weeklyContext } from "./weekly.js";

// ---------- 状态 ----------
// datasets: [{id, name, source, fileName, importedAt, count, from, to}]，流水按数据集存 tx:<id>
// account: 登录后 {email, version(已同步的云端版本), dirty(本机有没同步的改动), syncedAt}；key: 数据密钥（不离开浏览器）
const blank = () => ({ kinds: {}, statuses: {}, reviews: {}, catOverrides: {}, plan: null, cooling: [], reports: [], chatLog: [], weekly: [], goalChecks: {} });
const S = {
  datasets: [], raw: [], txs: [], demo: false, ...blank(),
  settings: { shareMerchants: true, deviceId: "", consent: false },
  config: { ai_enabled: false, invite_required: false, email_enabled: false },
  account: null, key: null, me: null, sync: { state: "", error: "" },
  ov: null, opps: [], ledger: [], lumpy: [], fund: null, saving: 0,
};
// weekly（每周复盘）以服务器为准，不进云同步的密文；settings 只在本机
const SYNCED = ["kinds", "statuses", "reviews", "catOverrides", "plan", "cooling", "reports", "chatLog", "goalChecks"];
const PERSIST = [...SYNCED, "weekly", "settings"];
async function save(k) {
  if (S.demo) return;
  await store.set(k, S[k]);
  if (SYNCED.includes(k)) markDirty();
}

const KIND_SLOT = { rigid: 1, fixedFlex: 2, daily: 3, lumpy: 4 };
const OPP_TYPES = {
  subscription: "订阅黑洞", small: "无感支出", impulse: "冲动大额", inflate: "分类膨胀", lumpy: "偶发大额", audit: "单价审计",
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
  S.settings = { ...S.settings, ...((await store.get("settings")) || {}) };
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
  S.opps = opportunities(S.txs, { kinds: S.kinds, reviews: S.reviews });
  S.saving = totalSaving(S.txs, S.opps, S.statuses);
  // 用户没改过计划时，数据变了就按新数据重新给建议
  if (!S.plan || S.plan.auto) S.plan = { ...defaultPlan(S.txs, S.ov, S.saving, S.kinds, S.opps), auto: true };
  S.ledger = cardLedger(S.txs, S.plan, S.kinds);
  S.lumpy = lumpyStatus(S.txs, S.plan, S.opps, S.kinds);
  S.fund = freedomFund(S.txs, S.plan, S.ov, S.ledger);
}

const overrideKey = (t) => `${t.merchant}|${t.note}`.slice(0, 80);

function route() {
  const has = S.txs.length > 0;
  $("#landing").classList.toggle("hidden", has);
  $("#app").classList.toggle("hidden", !has);
  $("#nav").classList.toggle("hidden", !has);
  $("#btn-import").classList.toggle("hidden", !has || S.demo);
  $("#demo-bar").classList.toggle("hidden", !S.demo);
  if (!has) return;
  const tab = (location.hash || "#overview").slice(1);
  const views = { overview: viewOverview, opps: viewOpps, plan: viewPlan, weekly: viewWeekly, cooling: viewCooling, coach: viewCoach, data: viewData };
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
  S.cooling = [{ id: "c1", item: "儿童平衡车（第二辆）", price: 1299, why: "邻居家孩子有", mood: "焦虑", at: Date.now() - 80 * 3600e3, status: "waiting" },
    { id: "c2", item: "空气炸锅升级款", price: 899, why: "直播间限时价", mood: "冲动", at: Date.now() - 10 * 3600e3, status: "waiting" }];
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

function viewOverview() {
  const { ov } = S;
  const w = ov.window;
  const change = ov.prev12 ? (ov.last12 - ov.prev12) / ov.prev12 : null;
  const saveRate = ov.income12 ? (ov.income12 - ov.last12) / ov.income12 : null;
  const k = ov.kindTotals;
  const manageable = k.daily + k.lumpy + k.fixedFlex;
  const doable = S.opps.filter((o) => S.statuses[o.id] !== "ignored").length;
  const years = ov.byYear.slice(-6);
  const partial = (y) => y.months < 12;
  return `${shortData()}
  <section class="kpis">
    ${tile(`${span()}支出`, yuan(ov.last12), change === null ? `${w.start} ~ ${w.end}` : `比前 12 个月 ${change >= 0 ? "+" : ""}${pct(change)}`, change > 0.05 ? "up" : "")}
    ${tile("结余率", saveRate === null ? "—" : pct(saveRate), ov.income12 ? `收入 ${yuan(ov.income12)}` : "没有收入记录")}
    ${tile("可砍空间（保守估计）", yuan(S.saving), `${doable} 条可砍项 · 约占支出 ${pct(S.saving / ov.last12)}`, "good")}
    ${tile("节流目标", yuan(S.plan.target), `每年少花 ${yuan(S.plan.baseline - S.plan.target)}`)}
  </section>

  <section class="card insight">
    <p>${span()}（${w.start} ~ ${w.end}）你花了 <b>${yuan(ov.last12)}</b>。其中 <b>${yuan(k.rigid)}</b> 是房租、阿姨、保险这类固定刚性支出——这是生活品质的基石，不建议砍，只优化单价。剩下的 <b>${yuan(manageable)}</b> 才是可以管理的部分。</p>
    <p>我们在里面找到了 <b>${doable} 条可砍项</b>，保守估计一年能省 <b>${yuan(S.saving)}</b>。${S.saving >= 50000 ? "不需要牺牲生活品质，只需要让“无意识”的花费变成“有意识”。" : ""} <a href="#opps">去看可砍清单 →</a></p>
  </section>

  <section class="card">
    <div class="card-head"><h2>支出四象限 <span class="muted small">${span()}</span></h2></div>
    ${stackBar(Object.entries(k).map(([kind, v]) => ({ label: KINDS[kind].name, value: v, slot: KIND_SLOT[kind] })), yuan)}
    <div class="kind-legend">
      ${Object.entries(k).map(([kind, v]) => `<div><i class="sw" style="background:var(--series-${KIND_SLOT[kind]})"></i><b>${KINDS[kind].name}</b> ${yuan(v)} <span class="muted">${pct(v / ov.last12)}</span><div class="muted small">${KINDS[kind].how}</div></div>`).join("")}
    </div>
    <p class="muted small">分类归到哪个象限可以在「数据 → 分类归属」里改。</p>
  </section>

  <div class="two-col">
    <section class="card">
      <div class="card-head"><h2>每年支出</h2></div>
      ${barChart(years.map((y) => ({ label: partial(y) ? `${y.year}*` : y.year, value: y.expense, muted: partial(y), tip: `${y.year} 年：支出 ${yuan(y.expense)}${y.income ? `，收入 ${yuan(y.income)}` : ""}${partial(y) ? `（只有 ${y.months} 个月的数据）` : ""}` })), { fmt: yuan, label: "每年支出", width: chartWidth(true) })}
      <p class="muted small">* 不满 12 个月的年份</p>
    </section>
    <section class="card">
      <div class="card-head"><h2>每月支出</h2></div>
      ${lineChart(ov.trend.map((p) => ({ label: p.month, value: p.expense })), { fmt: yuan, label: "每月支出趋势", width: chartWidth(true) })}
      <p class="muted small">尖峰通常是旅行、保险、年终人情这类偶发大额。</p>
    </section>
  </div>

  <section class="card">
    <div class="card-head"><h2>分类逐年对比</h2><span class="muted small">点一行展开二级分类 · 红色表示比前 12 个月多花 20% 以上</span></div>
    <div class="tbl"><table>
      <thead><tr><th>分类</th>${years.map((y) => `<th class="num">${y.year}${partial(y) ? "*" : ""}</th>`).join("")}<th class="num">${S.ov.window.months === 12 ? "过去12月" : "折合一年"}</th><th class="num">同比</th></tr></thead>
      <tbody>${ov.cats.map((c, i) => catRow(c, years, i)).join("")}</tbody>
    </table></div>
  </section>`;
}

function tile(k, v, sub, cls = "") {
  return `<div class="stat ${cls}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="sub">${esc(sub)}</div></div>`;
}

function changeCell(last, before) {
  if (!before) return `<td class="num muted">新</td>`;
  const c = (last - before) / before;
  return `<td class="num ${c >= 0.2 && last - before > 2000 ? "bad" : c <= -0.1 ? "good-text" : ""}">${c >= 0 ? "+" : ""}${pct(c)}</td>`;
}

function catRow(c, years, i) {
  const sub = c.subs.map((s) => `<tr class="sub-row hidden" data-parent="${i}"><td>　${esc(s.cat2)} <span class="tag">${KINDS[s.kind].name}</span></td>${years.map(() => "<td></td>").join("")}<td class="num">${yuan(s.last)}</td>${changeCell(s.last, s.before)}</tr>`).join("");
  return `<tr class="cat-row" data-row="${i}"><td><b>${esc(c.cat1)}</b> <span class="muted small">${c.subs.length > 1 ? `▸ ${c.subs.length}` : ""}</span></td>${years.map((y) => `<td class="num">${c.perYear[y.year] ? yuan(c.perYear[y.year]) : "—"}</td>`).join("")}<td class="num"><b>${yuan(c.last)}</b></td>${changeCell(c.last, c.before)}</tr>${sub}`;
}

// 数据不满一年时，金额都是按已有月份折算成一年的
const span = () => (S.ov.window.months === 12 ? "过去 12 个月" : `近 ${S.ov.window.months} 个月折合一年`);
const shortData = () => S.ov.window.months < 12
  ? `<p class="card warn-card small">目前只有 ${S.ov.window.months} 个完整月的数据，金额按比例折算成一年，订阅和年度对比可能不全。导入更长时间的账单（随手记全部历史、支付宝一次可导 1 年）会准很多。</p>` : "";

const bind = {};
bind.viewOverview = () => {
  $$(".cat-row").forEach((r) => (r.onclick = () => $$(`.sub-row[data-parent="${r.dataset.row}"]`).forEach((x) => x.classList.toggle("hidden"))));
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

// 订阅合成一张卡（一条条列出来太长）；冲动大额要人工复盘，放在第二位，别沉到最底下
function arrange(opps) {
  const subs = opps.filter((o) => o.type === "subscription");
  const list = opps.filter((o) => o.type !== "subscription" && o.type !== "impulse");
  if (subs.length) list.push({ type: "subGroup", subs, saving: sum(subs, (o) => o.saving) });
  list.sort((a, b) => b.saving - a.saving);
  const imp = opps.find((o) => o.type === "impulse");
  if (imp) list.splice(Math.min(1, list.length), 0, imp);
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
  const extra = o.type === "impulse" ? impulseList(o) : o.type === "small" && o.detail.top ? `<p class="muted small">主要是：${o.detail.top.map(([m, v]) => `${esc(m)} ${yuan(v)}`).join("、")}</p>` : "";
  const savingText = o.type === "impulse"
    ? (o.saving ? `复盘为“不值”的 ${yuan(o.saving)}` : "复盘后才能算")
    : `预计一年省 ${yuan(o.saving)}`;
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
      <span class="actions">${o.type === "impulse" ? "" : `
        ${st === "todo" ? `<button class="primary" data-status="doing">决定去做</button><button data-status="ignored">忽略</button>` : ""}
        ${st === "doing" ? `<span class="tag ok">✓ 决定去做</span><button class="ghost" data-status="todo">撤销</button>` : ""}
        ${st === "ignored" ? `<span class="tag">已忽略</span><button class="ghost" data-status="todo">恢复</button>` : ""}`}
      </span>
    </div>
  </article>`;
}

function impulseList(o) {
  const items = o.detail.items;
  const done = items.filter((t) => t.review).length;
  return `<div class="impulse">
    <div class="bar"><i style="width:${(done / items.length) * 100}%"></i></div>
    <table><tbody>${items.map((t) => `<tr>
      <td class="num">${t.date.slice(2)} ${t.time ? `<span class="muted">${t.time}</span>` : ""}</td>
      <td class="num"><b>${yuan(t.amount)}</b></td>
      <td>${esc(t.cat2)}${t.merchant ? ` · ${esc(t.merchant)}` : ""}${t.note ? `<div class="muted small">${esc(t.note)}</div>` : ""}${t.flags.length ? `<div>${t.flags.map((f) => `<span class="tag warn">${f}</span>`).join(" ")}</div>` : ""}</td>
      <td class="review" data-tx="${esc(t.id)}">
        ${["yes", "no", "unsure"].map((v) => `<button class="mini ${t.review === v ? "on " + v : ""}" data-review="${v}">${{ yes: "值得", no: "不值", unsure: "说不清" }[v]}</button>`).join("")}
      </td></tr>`).join("")}</tbody></table>
    <p class="muted small">判断标准：这笔钱带来了持续的价值，还是只缓解了当时的焦虑？</p>
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

  <section class="card">
    <div class="card-head"><h2>⑤ 每月复盘提醒</h2></div>
    <p class="muted">每月 1 号花 10 分钟：导出上个月的账单拖进来，看看消费卡执行得怎么样，让 AI 教练写一份月度复盘。</p>
    <button id="ics">添加到日历（每月 1 号 20:00）</button>
  </section>`;
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
  $("#ics").onclick = () => calendar("MONTHLY;BYMONTHDAY=1", "月度节流复盘", "导出上个月的微信/支付宝/随手记账单拖进来，看消费卡执行情况，生成月度复盘。");
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
let aiBusy = false;
function viewCoach() {
  const months = S.ov.trend.map((p) => p.month).reverse().slice(0, 12);
  const def = S.ov.window.end;
  const report = S.reports[S.reports.length - 1];
  return `
  ${S.config.ai_enabled ? "" : `<p class="card warn-card">服务器还没有配置 AI，这一页暂时用不了；其他功能都在本地运行，不受影响。</p>`}
  ${S.account ? "" : loginCard("AI 教练需要登录", "内测期间凭邀请码注册。登录后还能每周一收到复盘邮件，多台设备加密同步。")}
  <section class="card">
    <div class="card-head"><h2>月度复盘</h2>
      <span class="actions"><select id="r-month">${months.map((m) => `<option ${m === def ? "selected" : ""}>${m}</option>`).join("")}</select>
      <button class="primary" id="r-go" ${aiBusy ? "disabled" : ""}>${aiBusy ? "生成中…" : "生成复盘"}</button></span></div>
    <details class="peek"><summary>查看将发送给 AI 的内容</summary><pre id="peek"></pre></details>
    ${report ? reportCard(report) : `<p class="muted">像教练一样看一遍这个月：哪里做得好、哪里要注意、下个月具体做哪 3 件事。</p>`}
    ${S.reports.length > 1 ? `<details><summary>以前的复盘（${S.reports.length - 1}）</summary>${S.reports.slice(0, -1).reverse().map(reportCard).join("")}</details>` : ""}
  </section>
  <section class="card chatbox">
    <div class="card-head"><h2>问问教练</h2>${S.chatLog.length ? `<button class="ghost small" id="chat-clear">清空</button>` : ""}</div>
    <div class="chat-body" id="chat-body">
      ${S.chatLog.length ? S.chatLog.map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join("") : `<p class="muted">数字都来自你的汇总数据，教练只负责解释和出主意。</p>`}
    </div>
    <div class="chips">${["这个月哪里花超了？", "外卖比去年多了多少？", "如果砍掉订阅和外卖，一年能省多少？", "我离 60 万的目标还差什么？", "旅行怎么花得更值？"].map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    <form class="chat-form" id="chat-form"><input id="chat-input" placeholder="问一个关于你支出的问题" maxlength="500" autocomplete="off"><button class="primary" ${aiBusy ? "disabled" : ""}>发送</button></form>
  </section>`;
}

function reportCard(r) {
  return `<div class="report">
    <div class="muted small">${esc(r.month)} 复盘 · 生成于 ${new Date(r.at).toLocaleDateString("zh-CN")}</div>
    <h3>${esc(r.headline)}</h3>
    <div class="two-col">
      <div><h4>👍 做得好</h4><ul>${(r.wins || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
      <div><h4>👀 要注意</h4><ul>${(r.watch || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    </div>
    <h4>下个月做这 3 件事</h4>
    <ol>${(r.actions || []).map((a) => `<li><b>${esc(a.do)}</b>${a.saving ? ` <span class="tag ok">一年约省 ${yuan(Number(a.saving) || 0)}</span>` : ""}<div class="muted small">${esc(a.why)}</div></li>`).join("")}</ol>
    ${r.question ? `<p class="question">🤔 ${esc(r.question)}</p>` : ""}
  </div>`;
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
  const peek = () => { $("#peek").textContent = JSON.stringify(ai.buildContext(S, { month: $("#r-month").value }), null, 1); };
  $(".peek").ontoggle = peek;
  $("#r-month").onchange = () => $(".peek").open && peek();
  $("#r-go").onclick = async () => {
    if (!needAccount() || !(await needConsent())) return;
    aiBusy = true; route();
    try {
      const month = $("#r-month")?.value || S.ov.window.end;
      const out = await ai.review(ai.buildContext(S, { month }));
      S.reports.push({ ...out, month, at: Date.now() });
      await save("reports");
    } catch (e) { toast(e.message, 5000); }
    aiBusy = false; route();
  };
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
    <label class="check"><input type="checkbox" id="s-consent" ${S.settings.consent ? "checked" : ""}> 同意把支出汇总发送给 AI 处理</label>
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
      <li>每周一早上 8 点，把上周复盘和这周 3 个目标发到你的邮箱</li>
      <li>多台设备同步。流水在浏览器里用你的密码加密后再上传，服务器只存密文，解不开</li>
      <li>不登录也能用全部本地分析</li>
    </ul></section>`;
  const sy = S.sync;
  const status = sy.state === "error" ? `<span class="bad">同步失败：${esc(sy.error)}</span>`
    : sy.state === "syncing" ? "同步中…"
    : S.account.syncedAt ? `已同步 · ${new Date(S.account.syncedAt).toLocaleString("zh-CN")}` : "已登录";
  return `<section class="card" id="account">
    <div class="card-head"><h2>账号</h2><span class="muted small">${esc(S.account.email)}</span></div>
    <p class="small">☁️ ${status}${S.me?.vault_size ? `<span class="muted"> · 云端密文 ${(S.me.vault_size / 1048576).toFixed(1)}MB</span>` : ""}</p>
    <label class="check"><input type="checkbox" id="s-weekly" ${S.me?.weekly_email ? "checked" : ""} ${S.me ? "" : "disabled"}> 每周一早上 8 点发每周复盘邮件${S.config.email_enabled ? "" : "<span class=\"muted small\">（服务器还没配置邮件，暂时只能在「每周复盘」页查看）</span>"}</label>
    <p class="muted small">开启后，每次数据变化会把最近一周的汇总（和发给 AI 的一样，不含逐笔流水）存到服务器，用于周一自动生成复盘；关掉就删除。</p>
    <div class="actions">
      <button id="a-pw">修改密码</button>
      <button id="a-logout">退出登录</button>
      <button id="a-delete" class="ghost danger">注销账号</button>
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
    if (on && !(await needConsent())) { e.target.checked = false; return; }
    try {
      await acct.api("PUT", "/api/settings", { weekly_email: on });
      S.me.weekly_email = on;
      if (on) pushSnapshot();
      toast(on ? "开启了：每周一早上 8 点发复盘邮件" : "关掉了，服务器上的每周汇总已删除");
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

// ---------- 每周复盘 ----------
// 复盘“最近一个完整周”（week），定下“本周”（week + 7）的 3 个目标；下周复盘时自动判定完成了没有
function viewWeekly() {
  const last = S.ov.window.last;
  const week = lastFullWeek(last), next = addDays(week, 7);
  const stats = weekStats(S.txs, S.kinds, S.plan, week);
  const rep = S.weekly.find((r) => r.week === week);
  const prev = S.weekly.find((r) => r.week === addDays(week, -7));
  const lag = daysBetween(last, ymd(new Date()));
  const diff = stats.avg ? (stats.total - stats.avg) / stats.avg : null;
  const prevGoals = (prev?.goals || []).map((g) => ({ g, e: evalGoal(g, S.txs, S.kinds, week, S.goalChecks, last) }));
  const cands = goalCandidates(S, stats);
  return `
  ${S.account ? "" : loginCard("每周一早上，把复盘发到你的邮箱", "登录后：每周一 8 点收到上周复盘和这周 3 个目标，下周自动判定完成了没有。内测期间凭邀请码注册。")}
  ${lag > 8 ? `<section class="card warn-card"><b>最新的数据到 ${last}（${lag} 天前）。</b> 导入最近的账单，才能复盘上周。
    <span class="muted small">微信：我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单，时间选“上周”；收到的 zip 直接拖进来。</span>
    ${S.demo ? "" : `<button class="primary" data-action="import">导入账单</button>`}</section>` : ""}

  <section class="card">
    <div class="card-head"><h2>这周的 3 个目标 <span class="muted small">${weekLabel(next)}</span></h2>${rep ? `<span class="muted small">${last >= next ? `按截至 ${last.slice(5)} 的数据` : "导入这周的账单后自动判定"}</span>` : ""}</div>
    ${rep ? `<div class="wgoals">${rep.goals.map((g) => goalRow(g, next, last)).join("")}</div>`
      : `<p class="muted">生成上周的复盘后，教练会从下面 ${cands.length} 个候选里挑 3 个最值得做的，作为这周的目标。每个目标都能用流水自动判定完成了没有。</p>
         <details><summary class="small">看看候选目标</summary><ul class="small">${cands.map((c) => `<li>${esc(c.text)} <span class="muted">${esc(c.basis || "")}</span></li>`).join("")}</ul></details>`}
  </section>

  <section class="card">
    <div class="card-head"><h2>上周复盘 <span class="muted small">${weekLabel(week)}</span></h2>
      <span class="actions"><button class="${rep ? "" : "primary"}" id="w-go" ${aiBusy || S.demo && !S.account ? "disabled" : ""}>${aiBusy ? "生成中…" : rep ? "重新生成" : "生成复盘"}</button></span></div>
    <section class="kpis compact">
      ${tile("上周支出", yuan(stats.total), stats.avg === null ? `${stats.count} 笔` : `前 ${stats.weeks} 周平均 ${yuan(stats.avg)}（${diff >= 0 ? "+" : ""}${pct(diff)}）`, diff > 0.15 ? "up" : diff < -0.1 ? "good" : "")}
      ${tile("消费卡", `${yuan(stats.daily)} / ${yuan(stats.quota)}`, stats.daily > stats.quota ? `超了 ${yuan(stats.daily - stats.quota)}` : `剩 ${yuan(stats.quota - stats.daily)}`, stats.daily > stats.quota ? "up" : "good")}
      ${tile("上周的目标", prevGoals.length ? `${prevGoals.filter((x) => x.e.done).length} / ${prevGoals.length}` : "—", prevGoals.length ? "达成" : "还没有定过目标")}
    </section>
    ${prevGoals.length ? `<div class="wgoals">${prevGoals.map(({ g, e }) => `<div class="wgoal ${e.done ? "done" : "miss"}"><span class="mark">${e.done ? "✓" : "✗"}</span><div>${esc(g.text)}${e.actual !== null ? ` <span class="muted small">实际 ${goalActual(g, e)}</span>` : ""}</div></div>`).join("")}</div>` : ""}
    ${barChart(stats.trend.map((x, i) => ({ label: weekLabel(x.week).split("–")[0], value: x.total, muted: i < stats.trend.length - 1, tip: `${weekLabel(x.week)}：${yuan(x.total)}` })), { fmt: yuan, label: "每周支出", width: chartWidth() })}
    <details class="peek"><summary>查看将发送给 AI 的内容</summary><pre id="w-peek"></pre></details>
    ${rep ? weeklyCard(rep) : `<p class="muted">教练会看上周花在哪、和前几周比怎么样、上周的目标完成了没有，然后定这周的 3 个目标。${S.me?.weekly_email ? "每周一早上 8 点也会自动生成并发到你的邮箱。" : ""}</p>`}
  </section>

  <section class="card">
    <div class="card-head"><h2>上周花在哪</h2><span class="muted small">和前 ${stats.weeks || "几"} 周平均比</span></div>
    <div class="tbl"><table>
      <thead><tr><th>分类</th><th class="num">上周</th><th class="num">次数</th><th class="num">每周平均</th><th class="num">差</th></tr></thead>
      <tbody>${stats.byCat.filter((c) => c.week > 0 || c.kind === "daily").slice(0, 12).map((c) => { const d = c.week - c.avg; return `<tr><td>${esc(c.cat2)} <span class="tag">${KINDS[c.kind].name}</span></td><td class="num">${yuan(c.week)}</td><td class="num">${c.count}</td><td class="num muted">${yuan(c.avg)}</td><td class="num ${d > 200 && d > c.avg * 0.3 ? "bad" : d < -100 ? "good-text" : ""}">${yuan(d, { sign: true })}</td></tr>`; }).join("")}</tbody>
    </table></div>
    ${stats.big.length ? `<p class="small">大额：${stats.big.map((t) => `${t.date.slice(5)} ${esc(t.cat2)} <b>${yuan(t.amount)}</b>`).join("，")}</p>` : ""}
  </section>

  ${S.weekly.filter((r) => r.week !== week).length ? `<section class="card"><details><summary>以前的每周复盘（${S.weekly.filter((r) => r.week !== week).length}）</summary>
    ${S.weekly.filter((r) => r.week !== week).slice().reverse().map((r) => `<div class="muted small" style="margin-top:14px">${weekLabel(r.week)}</div>${weeklyCard(r)}`).join("")}</details></section>` : ""}

  ${S.me?.weekly_email ? "" : `<p class="muted small center">不用邮件的话，也可以 <a href="#" id="w-ics">把“每周一 20:00 复盘”加到日历</a>。</p>`}`;
}

function goalRow(g, week, last) {
  if (g.type === "manual") {
    const k = `${week}|${g.id}`;
    return `<label class="wgoal check ${S.goalChecks[k] ? "done" : ""}"><input type="checkbox" data-goal="${esc(k)}" ${S.goalChecks[k] ? "checked" : ""} ${S.demo ? "disabled" : ""}><div>${esc(g.text)}${g.why ? `<div class="muted small">${esc(g.why)}</div>` : ""}</div></label>`;
  }
  const started = last >= week;
  const e = evalGoal(g, S.txs, S.kinds, week, S.goalChecks, last);
  const ratio = g.limit > 0 ? e.actual / g.limit : e.actual > 0 ? 2 : 0;
  return `<div class="wgoal ${started && !e.done ? "miss" : ""}"><span class="mark">${!started ? "○" : e.done ? (e.final ? "✓" : "…") : "✗"}</span><div class="grow">
    <div>${esc(g.text)}</div>
    ${started ? `<div class="bar"><i class="${e.done ? "" : "warn"}" style="width:${Math.min(100, ratio * 100)}%"></i></div><div class="small muted">已经 ${goalActual(g, e)} / ${g.metric === "count" ? `${g.limit} 次` : yuan(g.limit)}</div>` : ""}
    ${g.why ? `<div class="muted small">${esc(g.why)}</div>` : ""}</div></div>`;
}

function weeklyCard(r) {
  return `<div class="report">
    <h3>${esc(r.headline)}</h3>
    <div class="two-col">
      ${r.wins?.length ? `<div><h4>👍 做得好</h4><ul>${r.wins.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      ${r.watch?.length ? `<div><h4>👀 要注意</h4><ul>${r.watch.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    </div>
    <h4>这周的目标</h4><ol>${(r.goals || []).map((g) => `<li><b>${esc(g.text)}</b>${g.why ? `<div class="muted small">${esc(g.why)}</div>` : ""}</li>`).join("")}</ol>
    ${r.tip ? `<p class="question">💡 ${esc(r.tip)}</p>` : ""}
  </div>`;
}

bind.viewWeekly = () => {
  const week = lastFullWeek(S.ov.window.last);
  $("#w-peek").closest("details").ontoggle = () => { $("#w-peek").textContent = JSON.stringify(weeklyContext(S, week), null, 1); };
  $("#w-go").onclick = async () => {
    if (!needAccount() || !(await needConsent())) return;
    aiBusy = true; route();
    try {
      const rep = await ai.weeklyReview(weeklyContext(S, week));
      S.weekly = S.weekly.filter((r) => r.week !== week).concat(rep).sort((a, b) => (a.week < b.week ? -1 : 1));
      await store.set("weekly", S.weekly);
    } catch (e) { toast(e.message, 5000); }
    aiBusy = false; route();
  };
  $$("[data-goal]").forEach((c) => (c.onchange = async () => {
    if (c.checked) S.goalChecks[c.dataset.goal] = true; else delete S.goalChecks[c.dataset.goal];
    await save("goalChecks");
    route();
  }));
  if ($("#w-ics")) $("#w-ics").onclick = (e) => { e.preventDefault(); calendar("WEEKLY;BYDAY=MO", "每周节流复盘", "导出上周的微信/支付宝账单拖进来，生成每周复盘，定这周的 3 个目标。"); };
};

// 日历提醒（.ics）：rule 是 RRULE 的 FREQ 部分
function calendar(rule, title, desc) {
  const first = rule.startsWith("WEEKLY") ? addDays(mondayOf(ymd(new Date())), 7) : `${addMonths(ymd(new Date()).slice(0, 7), 1)}-01`;
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SaveWise//CN", "BEGIN:VEVENT",
    `UID:savewise-${rule.slice(0, 6).toLowerCase()}-${S.settings.deviceId}`, `DTSTART;TZID=Asia/Shanghai:${first.replaceAll("-", "")}T200000`, "DURATION:PT20M",
    `RRULE:FREQ=${rule}`, `SUMMARY:SaveWise ${title}`, `DESCRIPTION:${desc} ${location.origin}`,
    "BEGIN:VALARM", "TRIGGER:-PT0M", "ACTION:DISPLAY", `DESCRIPTION:${title}`, "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  download(`savewise-${title}.ics`, ics, "text/calendar");
}

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
    pushSnapshot();
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
  } catch (e) {
    if (e.status === 401) sessionLost(); else setSync("error", "连不上服务器");
    return;
  }
  if (!S.key) return sessionLost();
  try {
    if (S.me.vault_version > S.account.version) await pullVault(S.account.dirty);
    else if (S.me.vault_version < S.account.version) { S.account.version = S.me.vault_version; S.account.dirty = hasLocalData(); } // 云端被清过（重设密码）
    if (S.account.dirty) await pushVault(); else { setSync("ok"); pushSnapshot(); }
  } catch (e) { setSync("error", e.message); }
  await loadWeekly();
}

async function loadWeekly() {
  try {
    const { reports } = await acct.api("GET", "/api/weekly");
    S.weekly = reports.sort((a, b) => (a.week < b.week ? -1 : 1));
    await store.set("weekly", S.weekly);
    if (location.hash === "#weekly" && !S.demo) route();
  } catch { /* 离线时用本机缓存 */ }
}

// 每周汇总快照：周一的定时任务用它生成复盘（只在开了每周邮件、同意过发送汇总时上传）
function pushSnapshot() {
  if (!S.me?.weekly_email || !S.settings.consent || S.demo || !S.ov) return;
  acct.api("PUT", "/api/weekly/snapshot", { context: weeklyContext(S, lastFullWeek(S.ov.window.last)) }).catch(() => {});
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
  // 云端已有数据：本机没数据就直接用云端的，有就合并
  if (S.me.vault_version) await pullVault(hasLocalData());
  if (S.account.dirty) await pushVault(); else setSync("ok");
  await loadWeekly();
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
  S.weekly = [];
  await store.set("weekly", []);
  setSync("");
  route();
}

async function deleteAccount() {
  if (prompt(`注销账号会删除云端的加密数据、每周复盘和账号本身，不能恢复。本机数据会保留。\n\n确认的话，输入你的邮箱：`)?.trim().toLowerCase() !== S.account.email) return;
  try {
    await acct.api("DELETE", "/api/account");
  } catch (e) { return toast(e.message, 5000); }
  await store.del("account");
  await store.del("dataKey");
  S.account = S.key = S.me = null;
  S.weekly = [];
  await store.set("weekly", []);
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
      toast(mode === "register" ? "注册好了。去「每周复盘」看看上周吧" : "已登录，数据已同步");
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
  if (!el) { tip.classList.add("hidden"); $$(".line-chart .focus").forEach((f) => f.classList.add("hidden")); return; }
  tip.textContent = el.dataset.tip;
  tip.classList.remove("hidden");
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY + 14}px`;
  if (el.dataset.x) {
    const f = el.closest("svg").querySelector(".focus");
    f.setAttribute("cx", el.dataset.x); f.setAttribute("cy", el.dataset.y); f.classList.remove("hidden");
  }
});

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});

boot();
