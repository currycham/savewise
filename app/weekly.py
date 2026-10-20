"""每周复盘：用浏览器算好的上周汇总（快照）让 AI 写复盘、从候选里挑 3 个本周目标，存下来并发邮件。

- 用户在「每周复盘」页点生成：立刻生成（同时更新快照）。
- 每周一早上的定时任务：上周的复盘还没生成、快照正好是上周的，就生成并发邮件；
  快照还停在更早的周（上周账单还没导入），就发一封提醒，列出上周定的目标，请用户导入账单看结果。"""
import json
import logging
from datetime import date, datetime, timedelta
from html import escape
from zoneinfo import ZoneInfo

from . import llm, notify
from .config import SITE_URL, TIMEZONE
from .db import get_conn
from .prompts import WEEKLY_SYSTEM

log = logging.getLogger(__name__)
MAX_CONTEXT_CHARS = 40_000
last_result: dict | None = None  # 最近一次定时任务的结果，后台查看用（重启后清空）


def context_text(context: dict) -> str:
    text = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    if len(text) > MAX_CONTEXT_CHARS:
        raise ValueError("汇总数据太大了")
    return text


def generate(user_id: int, context: dict, source: str, actor: str) -> dict:
    """调用 AI 生成复盘；目标只认候选里的 id，不够 3 个就按候选顺序补齐。"""
    week = str(context.get("week", ""))[:10]
    messages = [{"role": "system", "content": WEEKLY_SYSTEM},
                {"role": "user", "content": "上周的支出汇总：\n" + context_text(context)}]
    out = llm.chat_json(messages, temperature=0.4, max_tokens=1200, task=f"weekly-{source}", actor=actor)
    candidates = {str(c.get("id")): c for c in context.get("candidates", []) if isinstance(c, dict) and c.get("id")}
    goals, manual = [], 0
    for g in out.get("goals", []):
        c = candidates.get(str(g.get("id")) if isinstance(g, dict) else "")
        if not c or any(x["id"] == c["id"] for x in goals) or (c.get("type") == "manual" and manual):
            continue
        manual += c.get("type") == "manual"
        goals.append({**c, "why": str(g.get("why", ""))[:120]})
    for c in candidates.values():
        if len(goals) >= 3:
            break
        if not any(x["id"] == c["id"] for x in goals) and not (c.get("type") == "manual" and manual):
            manual += c.get("type") == "manual"
            goals.append({**c, "why": ""})
    report = {
        "week": week,
        "headline": str(out.get("headline", ""))[:120],
        "wins": [str(x)[:200] for x in out.get("wins", [])][:3],
        "watch": [str(x)[:200] for x in out.get("watch", [])][:3],
        "goals": goals[:3],
        "tip": str(out.get("tip", ""))[:200],
        "stats": context.get("lastWeek", {}),
        "lastWeekGoals": context.get("lastWeekGoals", []),
    }
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO weekly_reports (user_id, week, report, source) VALUES (?, ?, ?, ?)"
            " ON CONFLICT (user_id, week) DO UPDATE SET report = excluded.report, source = excluded.source,"
            " created_at = CURRENT_TIMESTAMP",
            (user_id, week, json.dumps(report, ensure_ascii=False), source))
    return report


def save_snapshot(user_id: int, context: dict) -> None:
    text = context_text(context)
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO snapshots (user_id, week, context) VALUES (?, ?, ?)"
            " ON CONFLICT (user_id) DO UPDATE SET week = excluded.week, context = excluded.context, updated_at = CURRENT_TIMESTAMP",
            (user_id, str(context.get("week", ""))[:10], text))


def reports(user_id: int, limit: int = 26) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT report, created_at, source FROM weekly_reports WHERE user_id = ? ORDER BY week DESC LIMIT ?",
                            (user_id, limit)).fetchall()
    return [{**json.loads(r["report"]), "createdAt": r["created_at"], "source": r["source"]} for r in rows]


# ---------- 周一定时任务 ----------

def last_week(today: date | None = None) -> str:
    today = today or date.today()
    return (today - timedelta(days=today.weekday() + 7)).isoformat()


def run(today: date | None = None) -> dict:
    week = last_week(today)
    stats = {"week": week, "generated": 0, "emailed": 0, "reminded": 0, "skipped": 0, "failed": 0}
    with get_conn() as conn:
        users = conn.execute("SELECT * FROM users WHERE weekly_email = 1 AND banned = 0").fetchall()
    for user in users:
        try:
            stats[_run_user(dict(user), week)] += 1
        except Exception:
            log.exception("weekly review failed for user %s", user["id"])
            stats["failed"] += 1
    log.info("weekly job: %s", stats)
    global last_result
    last_result = {**stats, "at": datetime.now(ZoneInfo(TIMEZONE)).strftime("%Y-%m-%d %H:%M")}
    return stats


def _run_user(user: dict, week: str) -> str:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM weekly_reports WHERE user_id = ? AND week = ?", (user["id"], week)).fetchone()
        snap = conn.execute("SELECT * FROM snapshots WHERE user_id = ?", (user["id"],)).fetchone()
    if not snap and not row:
        return "skipped"  # 还没导入过数据，或者没同意上传汇总
    result = "emailed"
    if row:
        if row["emailed_at"]:
            return "skipped"
        report = json.loads(row["report"])
    elif snap and snap["week"] == week:
        try:
            report = generate(user["id"], json.loads(snap["context"]), "job", "job")
            result = "generated"
        except llm.LLMError as e:
            log.warning("weekly generate failed for user %s: %s", user["id"], e)
            report = None
    else:
        report = None
    if not notify.enabled():
        return "generated" if result == "generated" else "skipped"
    if report:
        notify.send(user["email"], f"SaveWise 每周复盘 {_range(week)}：{report['headline']}", _html(report), _text(report))
        with get_conn() as conn:
            conn.execute("UPDATE weekly_reports SET emailed_at = CURRENT_TIMESTAMP WHERE user_id = ? AND week = ?",
                         (user["id"], week))
        return result
    if user["reminded_week"] == week:
        return "skipped"
    goals = _goals_for(user["id"], week)
    notify.send(user["email"], f"SaveWise：导入上周的账单，看看目标完成了没有（{_range(week)}）",
                _reminder_html(goals), _reminder_text(goals))
    with get_conn() as conn:
        conn.execute("UPDATE users SET reminded_week = ? WHERE id = ?", (week, user["id"]))
    return "reminded"


def _goals_for(user_id: int, week: str) -> list[dict]:
    """上上周的复盘里定的目标，就是上周要做的。"""
    prev = (date.fromisoformat(week) - timedelta(days=7)).isoformat()
    with get_conn() as conn:
        row = conn.execute("SELECT report FROM weekly_reports WHERE user_id = ? AND week = ?", (user_id, prev)).fetchone()
    return json.loads(row["report"]).get("goals", []) if row else []


# ---------- 邮件 ----------

def yuan(n) -> str:
    n = float(n or 0)
    if abs(n) >= 10000:
        return f"¥{n / 10000:.{1 if abs(n) >= 100000 else 2}f}".rstrip("0").rstrip(".") + "万"
    return f"¥{round(n):,}"


def _range(week: str) -> str:
    d = date.fromisoformat(week)
    return f"{d.month}/{d.day}–{(d + timedelta(days=6)).month}/{(d + timedelta(days=6)).day}"


def _stats_line(s: dict) -> str:
    parts = [f"上周支出 {yuan(s.get('total'))}"]
    if s.get("avgPrevWeeks"):
        parts.append(f"前 {s.get('prevWeeks')} 周平均 {yuan(s['avgPrevWeeks'])}")
    if s.get("cardWeeklyQuota"):
        parts.append(f"消费卡 {yuan(s.get('cardSpend'))} / 周额度 {yuan(s['cardWeeklyQuota'])}")
    return " · ".join(parts)


STYLE = "font-family:-apple-system,'PingFang SC',sans-serif;max-width:600px;line-height:1.7;color:#222"
FOOT = (f"<p style='margin-top:24px'><a href='{SITE_URL}/#weekly' style='color:#0f7b6c'>打开 SaveWise 查看每周复盘 →</a></p>"
        "<p style='color:#999;font-size:12px'>复盘由 AI 根据你的支出汇总生成，金额来自规则计算，仅供参考，不构成投资建议。"
        "不想收到可以在网站「数据 → 账号」里关闭每周邮件。</p>")


def _html(r: dict) -> str:
    last = "".join(
        f"<li>{'✅' if g.get('result') == '达成' else '⬜'} {escape(str(g.get('goal', '')))}"
        f"{'（' + escape(str(g['actual'])) + '）' if g.get('actual') else ''}</li>" for g in r.get("lastWeekGoals", []))
    goals = "".join(
        f"<li style='margin-bottom:6px'><b>{escape(g.get('text', ''))}</b>"
        f"{'<br><span style=color:#777;font-size:13px>' + escape(g['why']) + '</span>' if g.get('why') else ''}</li>"
        for g in r.get("goals", []))
    bullets = lambda xs: "".join(f"<li>{escape(x)}</li>" for x in xs)  # noqa: E731
    return f"""<div style="{STYLE}">
<p style="color:#888;font-size:13px;margin:0">SaveWise 每周复盘 · {_range(r['week'])}</p>
<h2 style="margin:4px 0 8px">{escape(r['headline'])}</h2>
<p style="color:#555">{escape(_stats_line(r.get('stats', {})))}</p>
{f"<h3>上周的目标</h3><ul>{last}</ul>" if last else ""}
{f"<h3>👍 做得好</h3><ul>{bullets(r['wins'])}</ul>" if r.get('wins') else ""}
{f"<h3>👀 要注意</h3><ul>{bullets(r['watch'])}</ul>" if r.get('watch') else ""}
<h3 style="color:#0f7b6c">这周做这 3 件事</h3><ol>{goals}</ol>
{f"<p style='background:#f2f8f6;padding:10px 12px;border-radius:8px'>💡 {escape(r['tip'])}</p>" if r.get('tip') else ""}
{FOOT}</div>"""


def _text(r: dict) -> str:
    lines = [f"SaveWise 每周复盘 {_range(r['week'])}", r["headline"], _stats_line(r.get("stats", {})), ""]
    if r.get("lastWeekGoals"):
        lines += ["上周的目标："] + [f"  {'✓' if g.get('result') == '达成' else '✗'} {g.get('goal')}" for g in r["lastWeekGoals"]] + [""]
    lines += ["这周做这 3 件事："] + [f"  {i + 1}. {g.get('text')}" for i, g in enumerate(r.get("goals", []))]
    if r.get("tip"):
        lines += ["", f"小做法：{r['tip']}"]
    return "\n".join(lines) + f"\n\n{SITE_URL}/#weekly"


HOWTO = ("微信：我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单，时间选上周；"
         "支付宝：我的 → 账单 → ··· → 开具交易流水证明。收到的 zip 直接拖进网页，输入密码即可。")


def _reminder_html(goals: list[dict]) -> str:
    items = "".join(f"<li>{escape(g.get('text', ''))}</li>" for g in goals)
    return f"""<div style="{STYLE}">
<h2 style="margin:0 0 8px">上周的账单还没导入</h2>
<p>SaveWise 还看不到上周花了多少。花 3 分钟导入上周的账单，就能看到目标完成了没有，并拿到这周的 3 个目标。</p>
{f"<h3>上周你定的目标</h3><ul>{items}</ul>" if items else ""}
<p style="color:#555;font-size:14px">{escape(HOWTO)}</p>
{FOOT}</div>"""


def _reminder_text(goals: list[dict]) -> str:
    lines = ["上周的账单还没导入。花 3 分钟导入上周的账单，就能看到目标完成了没有，并拿到这周的 3 个目标。", ""]
    if goals:
        lines += ["上周你定的目标："] + [f"  - {g.get('text')}" for g in goals] + [""]
    return "\n".join(lines + [HOWTO, f"{SITE_URL}/#weekly"])
