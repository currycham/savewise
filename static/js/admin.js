// 后台：概览、用户、复盘。只看账号和用量，看不到任何人的流水
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const yuan = (v) => `¥${Number(v || 0).toFixed(2)}`;
const num = (v) => Number(v || 0).toLocaleString();
const mb = (bytes) => (bytes ? `${(bytes / 1048576).toFixed(1)}MB` : "");

async function api(path, opts = {}) {
  const init = { credentials: "same-origin", ...opts };
  if (opts.json !== undefined) {
    init.method = "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, init);
  if (res.status === 401 || res.status === 404 && path === "/api/admin/overview") { location.href = "/"; throw new Error("无权限"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `请求失败 ${res.status}`);
  return data;
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), 4000);
}

const table = (head, rows) =>
  `<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
   <tbody>${rows.join("") || `<tr><td colspan="${head.length}" class="muted">暂无数据</td></tr>`}</tbody></table></div>`;

// ---------- 概览 ----------
async function viewOverview() {
  const d = await api("/api/admin/overview");
  const b = d.budget;
  const pct = b.limit > 0 ? Math.min(100, (b.used / b.limit) * 100) : 0;
  const bal = d.balance;
  return `
    <section class="card">
      <div class="card-head"><h2>今日 AI 预算</h2><span class="num">${yuan(b.used)} / ${b.limit > 0 ? yuan(b.limit) : "不限"}</span></div>
      <div class="bar"><i class="${pct >= 80 ? "warn" : ""}" style="width:${pct}%"></i></div>
      <p class="muted small">北京时间零点重置，用完后当天暂停 AI 功能（本地分析不受影响）。每人每天 ${b.user_calls || "不限"} 次。上限在 .env 的 DAILY_BUDGET_YUAN / USER_DAILY_CALLS 设置。</p>
      <p class="small">DeepSeek 余额：${!bal ? '<span class="muted">没有配置 DEEPSEEK_API_KEY</span>'
        : bal.error ? `<span class="bad">查询失败</span> <span class="muted">${esc(bal.error)}</span>`
        : `<b class="${bal.balance < 10 ? "bad" : ""}">${yuan(bal.balance)}</b>`}
        <a href="https://platform.deepseek.com/top_up" target="_blank" rel="noopener">去充值 →</a> <span class="muted">（每 10 分钟最多查一次）</span></p>
    </section>
    <div class="kpis compact">${d.stats.map(([k, v]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join("")}</div>
    <div class="two-col">
      <section class="card"><h2>近 7 天按功能</h2>${table(["功能", "调用", "用户", "输入 tokens", "输出 tokens", "成本"], d.by_task.map((t) => `
        <tr><td>${esc(t.name)}</td><td class="num">${num(t.calls)}</td><td class="num">${num(t.users)}</td><td class="num">${num(t.input)}</td>
          <td class="num">${num(t.output)}</td><td class="num">${yuan(t.cost)}</td></tr>`))}</section>
      <section class="card"><h2>近 14 天按日</h2>${table(["日期（北京时间）", "调用", "用户", "成本"], d.by_day.map((r) => `
        <tr><td class="num">${r.day}</td><td class="num">${num(r.calls)}</td><td class="num">${num(r.users)}</td><td class="num">${yuan(r.cost)}</td></tr>`))}</section>
    </div>
    <p class="muted small">成本按 .env 中 DEEPSEEK_PRICE_* 单价估算，实际以 DeepSeek 控制台账单为准。</p>`;
}

// ---------- 用户 ----------
async function viewUsers() {
  const d = await api("/api/admin/users");
  return `
    <section class="card">${table(["用户", "角色", "云同步", "提醒邮件", "近 30 天 AI", "累计成本", "注册", "最近访问", "操作"], d.users.map((u) => `
      <tr class="${u.banned ? "muted" : ""}">
        <td><b>${esc(u.email)}</b> <span class="muted small">#${u.id}</span>${u.banned ? ' <span class="badge t-big">已停用</span>' : ""}</td>
        <td>${u.role === "admin" ? `<span class="badge">管理员</span>${u.pinned_admin ? ' <span class="muted small" title="在 .env 的 ADMIN_EMAILS 中">固定</span>' : ""}` : '<span class="muted">用户</span>'}</td>
        <td class="num small">${u.synced_at ? `${esc(u.synced_at)}<br><span class="muted">${mb(u.vault_size)}</span>` : '<span class="muted">—</span>'}</td>
        <td>${u.weekly_email ? "开" : '<span class="muted">关</span>'}</td>
        <td class="num">${num(u.calls_30d)} 次</td>
        <td class="num">${yuan(u.cost_total)}</td>
        <td class="num small">${esc(u.created_at)}</td>
        <td class="num small">${esc(u.last_seen_at || "")}</td>
        <td><span class="actions">
          <button class="small" data-act="role" data-id="${u.id}" data-role="${u.role === "admin" ? "user" : "admin"}">${u.role === "admin" ? "取消管理员" : "设为管理员"}</button>
          <button class="small" data-act="reset" data-id="${u.id}" data-name="${esc(u.email)}" ${d.email_enabled && !u.banned ? "" : "disabled"}>发重设密码邮件</button>
          <button class="small ${u.banned ? "" : "danger"}" data-act="ban" data-id="${u.id}" data-banned="${u.banned ? 0 : 1}" data-name="${esc(u.email)}">${u.banned ? "恢复" : "停用"}</button>
        </span></td>
      </tr>`))}</section>
    <p class="muted small">停用会立即踢下线，数据保留。密码只有用户自己知道（云端数据用它加密），管理员不能代设密码，只能把重设链接发到对方邮箱${d.email_enabled ? "" : "（服务器还没配置邮件，暂时不能发）"}；重设后对方云端的密文会清空，用存有数据的设备登录一次即可重新同步。</p>`;
}

const userActions = {
  async role(b) { await api(`/api/admin/users/${b.dataset.id}/role`, { json: { role: b.dataset.role } }); toast("角色已更新"); },
  async ban(b) {
    const banning = b.dataset.banned === "1";
    if (banning && !confirm(`停用「${b.dataset.name}」？对方会被立即踢下线。`)) return false;
    await api(`/api/admin/users/${b.dataset.id}/ban`, { json: { banned: banning } });
    toast(banning ? "已停用" : "已恢复");
  },
  async reset(b) {
    if (!confirm(`给「${b.dataset.name}」发一封重设密码的邮件？链接 1 小时内有效。`)) return false;
    await api(`/api/admin/users/${b.dataset.id}/send-reset`, { method: "POST" });
    toast("已发送");
    return false;
  },
};

// ---------- 复盘 ----------
const CAD = { week: "按周", month: "按月", quarter: "按季度" };
async function viewWeekly() {
  const d = await api("/api/admin/weekly");
  const run = d.run, last = run.last;
  if (run.running) setTimeout(() => location.hash === "#weekly" && render(), 5000);
  return `
    <section class="card">
      <div class="card-head"><h2>每日提醒任务</h2>
        <button class="primary" data-act="run" ${run.running ? "disabled" : ""}>${run.running ? "运行中…" : "立即补跑"}</button></div>
      <p class="small">每天 ${esc(d.run_time)}（北京时间）按每个用户选的周期，上一期刚过完（按周 ${esc(d.last.week)} 那一周 · 按月 ${esc(d.last.month)} · 按季度 ${esc(d.last.quarter)}）就发一封提醒邮件，不含任何金额。复盘在用户浏览器里生成、加密同步，服务器上没有。${d.email_enabled ? "" : '<span class="bad">服务器还没配置邮件，不会发提醒。</span>'}</p>
      <p class="small">${last ? `最近一次运行：${esc(last.at)} · 发提醒 ${last.reminded} · 跳过 ${last.skipped}${last.failed ? ` · <span class="bad">失败 ${last.failed}</span>` : ""}`
        : '<span class="muted">服务启动以来还没运行过</span>'}${run.error ? ` <span class="bad">${esc(run.error)}</span>` : ""}</p>
      <p class="muted small">补跑不会重复发：每期只提醒一次。订阅周期：${Object.entries(d.by_cadence).map(([c, n]) => `${CAD[c] || esc(c)} ${n}`).join(" · ") || "—"}</p>
    </section>
    <div class="kpis compact">
      <div class="stat"><div class="v">${d.subscribed}</div><div class="k">开启提醒邮件</div></div>
      <div class="stat"><div class="v">${d.reminded}</div><div class="k">本期已提醒</div></div>
      <div class="stat"><div class="v">${d.legacy}</div><div class="k">服务器上待迁移的旧复盘</div></div>
    </div>`;
}

const weeklyActions = {
  async run() {
    if (!confirm("现在补跑每天的提醒任务？本期还没提醒过的用户会收到一封提醒邮件。")) return false;
    await api("/api/admin/weekly-run", { method: "POST" });
    toast("已开始，在后台运行");
  },
};

// ---------- 路由 ----------
const VIEWS = { overview: [viewOverview, {}], users: [viewUsers, userActions], weekly: [viewWeekly, weeklyActions] };

async function render() {
  const tab = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : "overview";
  document.querySelectorAll("[data-tab]").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
  const [view, actions] = VIEWS[tab];
  try {
    $("#view").innerHTML = await view();
  } catch (e) { $("#view").innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  $("#view").querySelectorAll("[data-act]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      if ((await actions[b.dataset.act](b)) !== false) return render();
    } catch (e) { toast(e.message); }
    b.disabled = false;
  }));
}

window.addEventListener("hashchange", render);
render();
