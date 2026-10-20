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
import { addMonths, groupBy, monthOf, pct, round, sum, yuan } from "./util.js";

// ---------- 状态 ----------
// datasets: [{id, name, source, fileName, importedAt, count, from, to}]，流水按数据集存 tx:<id>
const S = {
  datasets: [], raw: [], txs: [], demo: false,
  kinds: {}, statuses: {}, reviews: {}, catOverrides: {}, plan: null, cooling: [], reports: [], chatLog: [],
  settings: { shareMerchants: true, accessCode: "", deviceId: "", consent: false },
  config: { ai_enabled: false, access_code_required: false },
  ov: null, opps: [], ledger: [], lumpy: [], fund: null, saving: 0,
};
const PERSIST = ["kinds", "statuses", "reviews", "catOverrides", "plan", "cooling", "reports", "chatLog", "settings"];
const save = (k) => (S.demo ? Promise.resolve() : store.set(k, S[k]));

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
  for (const k of PERSIST) S[k] = (await store.get(k)) ?? S[k];
  if (!S.settings.deviceId) { S.settings.deviceId = crypto.randomUUID?.() || String(Math.random()).slice(2); await save("settings"); }
  S.datasets = (await store.get("datasets")) || [];
  S.raw = [];
  for (const d of S.datasets) S.raw.push(...((await store.get(`tx:${d.id}`)) || []));
  fetch("/api/public-config").then((r) => r.json()).then((c) => {
    S.config = c;
    if (c.model_disclosure) $("#disclosure").textContent = c.model_disclosure;
  }).catch(() => {});
  if (!(await store.persistent())) toast("浏览器不允许本地存储（可能是隐私模式），刷新后数据会丢失", 6000);
  if (location.hash === "#demo") return enterDemo();
  compute();
  route();
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
  const views = { overview: viewOverview, opps: viewOpps, plan: viewPlan, cooling: viewCooling, coach: viewCoach, data: viewData };
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
  for (const k of ["kinds", "statuses", "reviews", "catOverrides", "cooling", "reports", "chatLog"]) S[k] = Array.isArray(S[k]) ? [] : {};
  S.plan = null;
  S.cooling = [{ id: "c1", item: "儿童平衡车（第二辆）", price: 1299, why: "邻居家孩子有", mood: "焦虑", at: Date.now() - 80 * 3600e3, status: "waiting" },
    { id: "c2", item: "空气炸锅升级款", price: 899, why: "直播间限时价", mood: "冲动", at: Date.now() - 10 * 3600e3, status: "waiting" }];
  compute();
  if (location.hash === "#demo") history.replaceState(null, "", "#overview");
  route();
}

async function exitDemo() {
  S.demo = false;
  await exitDemoSilently();
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
  $("#ics").onclick = () => {
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TrimWise//CN", "BEGIN:VEVENT",
      `UID:trimwise-monthly-${S.settings.deviceId}`, "DTSTART;TZID=Asia/Shanghai:20261101T200000", "DURATION:PT20M",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=1", "SUMMARY:TrimWise 月度节流复盘",
      `DESCRIPTION:导出上个月的微信/支付宝/随手记账单，拖进 ${location.origin} 看消费卡执行情况，生成月度复盘。`,
      "BEGIN:VALARM", "TRIGGER:-PT0M", "ACTION:DISPLAY", "DESCRIPTION:月度节流复盘", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    download("trimwise-月度复盘.ics", ics, "text/calendar");
  };
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
  ${S.config.access_code_required && !S.settings.accessCode ? `<section class="card"><h2>内测访问码</h2><p class="muted">AI 教练在内测中，请输入访问码。</p><div class="form-row"><label>访问码<input id="ac" autocomplete="off"></label><button class="primary" id="ac-save">保存</button></div></section>` : ""}
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
  if ($("#ac-save")) $("#ac-save").onclick = async () => { S.settings.accessCode = $("#ac").value.trim(); await store.set("settings", S.settings); route(); };
  $("#r-go").onclick = async () => {
    if (!(await needConsent())) return;
    aiBusy = true; route();
    try {
      const month = $("#r-month")?.value || S.ov.window.end;
      const out = await ai.review(ai.buildContext(S, { month }), S.settings);
      S.reports.push({ ...out, month, at: Date.now() });
      await save("reports");
    } catch (e) { toast(e.message, 5000); }
    aiBusy = false; route();
  };
  const ask = async (q) => {
    if (!q || aiBusy || !(await needConsent())) return;
    S.chatLog.push({ role: "user", content: q });
    aiBusy = true; route();
    const body = $("#chat-body");
    body.insertAdjacentHTML("beforeend", `<div class="msg assistant pending">思考中…</div>`);
    body.scrollTop = body.scrollHeight;
    try {
      const { reply } = await ai.chat(ai.buildContext(S), S.chatLog.slice(-10), S.settings);
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
    <p class="muted small">共 ${S.txs.length} 笔，${S.ov.window.first} ~ ${S.ov.window.last}。所有数据只存在这台设备的浏览器里；换设备请用下面的“导出备份”。</p>
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

  <section class="card">
    <h2>设置</h2>
    <label class="check"><input type="checkbox" id="s-merchants" ${S.settings.shareMerchants ? "checked" : ""}> 发给 AI 的汇总里包含商户名称（关掉后建议会更笼统）</label>
    <label class="check"><input type="checkbox" id="s-consent" ${S.settings.consent ? "checked" : ""}> 同意把支出汇总发送给 AI 处理</label>
    ${S.config.access_code_required ? `<label>AI 内测访问码<input id="s-ac" value="${esc(S.settings.accessCode)}"></label>` : ""}
    <div class="actions">
      <button id="backup" ${S.demo ? "disabled" : ""}>导出备份</button>
      <button id="restore" ${S.demo ? "disabled" : ""}>从备份恢复</button>
      <button id="wipe" class="danger" ${S.demo ? "disabled" : ""}>清空本机所有数据</button>
    </div>
    <input type="file" id="restore-file" accept=".json" hidden>
  </section>`;
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
    rerender();
  }));
  if ($("#ai-classify")) $("#ai-classify").onclick = async () => {
    if (!(await needConsent())) return;
    const keys = [...new Set(S.txs.filter((t) => t.cat2 === "未分类").map(overrideKey))].slice(0, 600);
    aiBusy = true; route();
    try {
      const map = await ai.classifyMerchants(keys, S.settings);
      Object.assign(S.catOverrides, map);
      await save("catOverrides");
      toast(`归类了 ${Object.keys(map).length} 个商户`);
    } catch (e) { toast(e.message, 5000); }
    aiBusy = false; rerender();
  };
  $("#s-merchants").onchange = async (e) => { S.settings.shareMerchants = e.target.checked; await store.set("settings", S.settings); };
  $("#s-consent").onchange = async (e) => { S.settings.consent = e.target.checked; await store.set("settings", S.settings); };
  if ($("#s-ac")) $("#s-ac").onchange = async (e) => { S.settings.accessCode = e.target.value.trim(); await store.set("settings", S.settings); };
  $("#backup").onclick = async () => {
    const data = { app: "trimwise", version: 1, exportedAt: new Date().toISOString(), datasets: S.datasets, tx: {} };
    for (const d of S.datasets) data.tx[d.id] = await store.get(`tx:${d.id}`);
    for (const k of PERSIST) if (k !== "settings") data[k] = S[k];
    download(`trimwise-备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data));
  };
  $("#restore").onclick = () => $("#restore-file").click();
  $("#restore-file").onchange = async (e) => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (data.app !== "trimwise") throw new Error("不是 TrimWise 的备份文件");
      if (!confirm("恢复会覆盖本机现有的数据，继续？")) return;
      await store.clearAll();
      for (const d of data.datasets) await store.set(`tx:${d.id}`, data.tx[d.id] || []);
      await store.set("datasets", data.datasets);
      for (const k of PERSIST) if (k !== "settings" && data[k] !== undefined) await store.set(k, data[k]);
      await store.set("settings", S.settings);
      location.reload();
    } catch (err) { toast(err.message, 5000); }
  };
  $("#wipe").onclick = async () => {
    if (!confirm("清空这台设备上的所有流水、计划和复盘？清空前建议先导出备份。")) return;
    await store.clearAll();
    location.hash = "";
    location.reload();
  };
};

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
  if (S.demo) { S.demo = false; await exitDemoSilently(); }
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
  $("#dlg-import").close();
  pending = [];
  compute();
  toast(added ? `导入了 ${added} 笔新记录` : "没有新记录（都已经导入过了）");
  location.hash = "#overview";
  route();
}

async function exitDemoSilently() {
  for (const k of PERSIST) S[k] = (await store.get(k)) ?? (Array.isArray(S[k]) ? [] : k === "plan" ? null : k === "settings" ? S.settings : {});
  S.raw = [];
  for (const d of S.datasets) S.raw.push(...((await store.get(`tx:${d.id}`)) || []));
}

// ---------- 全局事件 ----------
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-action]");
  if (a) {
    e.preventDefault();
    if (a.dataset.action === "import") openImport();
    if (a.dataset.action === "demo") enterDemo();
    if (a.dataset.action === "exit-demo") exitDemo();
  }
  const c = e.target.closest("dialog [data-close]");
  if (c) c.closest("dialog").close();
});
$("#btn-import").onclick = openImport;
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
