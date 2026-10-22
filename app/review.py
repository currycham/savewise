"""定期复盘（按周 / 月 / 季度，用户选，默认按月）。

服务器不保存任何明文的支出数据：
- 生成复盘：浏览器把上一期的汇总发过来，这里转给 AI，校验目标后原样返回；汇总和复盘都不落盘。
  复盘由浏览器存进加密的云同步数据里，服务器解不开。
- 每天早上的定时任务：只看每个用户选的周期，上一期刚过完就发一封提醒邮件，
  请用户导入账单、打开网页在浏览器里生成复盘。每期只提醒一次。
  邮件里能带几行有用的提醒（目标、要续费的订阅、去年这时候的大额），是浏览器预先算好、
  用户看过原文勾选后上传的（reminder_notes，默认不带金额）；期末那封发出后就删掉。
  用户选了期中提醒的，期中那天再发一封。
- 用户在页面上点「发到我的邮箱」时，才把那一份复盘发一次邮件，发完不保存。
- 以前存在服务器上的复盘（weekly_reports）只用于迁移：浏览器取走、存进加密数据后就删掉。

期的键：周 "2026-10-12"（周一）、月 "2026-09"、季度 "2026-Q3"。"""
import json
import logging
import re
from datetime import date, datetime, timedelta
from html import escape
from zoneinfo import ZoneInfo

from . import llm, notify
from .config import SITE_URL, TIMEZONE
from .db import get_conn
from .prompts import REVIEW_SYSTEM

log = logging.getLogger(__name__)
MAX_CONTEXT_CHARS = 40_000
CADENCES = {"week": "周", "month": "月", "quarter": "季度"}
WORDS = {"week": ("上周", "这周"), "month": ("上个月", "这个月"), "quarter": ("上个季度", "这个季度")}
PERIOD_RE = re.compile(r"\d{4}-(\d{2}-\d{2}|\d{2}|Q[1-4])")
last_result: dict | None = None  # 最近一次定时任务的结果，后台查看用（重启后清空）


def context_text(context: dict) -> str:
    text = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    if len(text) > MAX_CONTEXT_CHARS:
        raise ValueError("汇总数据太大了")
    return text


def cadence_of(key: str) -> str:
    return "quarter" if "Q" in key else "month" if len(key) == 7 else "week"


def last_period(cadence: str, today: date | None = None) -> str:
    """今天之前最近一个过完的期。"""
    today = today or date.today()
    if cadence == "week":
        return (today - timedelta(days=today.weekday() + 7)).isoformat()
    if cadence == "month":
        d = today.replace(day=1) - timedelta(days=1)
        return f"{d.year}-{d.month:02d}"
    q = (today.month - 1) // 3
    return f"{today.year - 1}-Q4" if q == 0 else f"{today.year}-Q{q}"


def period_name(key: str) -> str:
    c = cadence_of(key)
    if c == "month":
        return f"{key[:4]} 年 {int(key[5:])} 月"
    if c == "quarter":
        return f"{key[:4]} 年第 {key[6:]} 季度"
    d = date.fromisoformat(key)
    e = d + timedelta(days=6)
    return f"{d.month}/{d.day}–{e.month}/{e.day}"


def current_period(cadence: str, today: date | None = None) -> str:
    """今天所在的期。"""
    today = today or date.today()
    if cadence == "week":
        return (today - timedelta(days=today.weekday())).isoformat()
    if cadence == "month":
        return f"{today.year}-{today.month:02d}"
    return f"{today.year}-Q{(today.month - 1) // 3 + 1}"


def period_bounds(key: str) -> tuple[date, date]:
    c = cadence_of(key)
    if c == "week":
        a = date.fromisoformat(key)
        return a, a + timedelta(days=6)
    y, m = int(key[:4]), (int(key[6]) - 1) * 3 + 1 if c == "quarter" else int(key[5:])
    a = date(y, m, 1)
    n = 3 if c == "quarter" else 1
    b = date(y + (m + n - 1) // 12, (m + n - 1) % 12 + 1, 1) - timedelta(days=1)
    return a, b


def period_mid(key: str) -> date:
    """期中那天，和浏览器 reminder.js 的 periodMid 一样。"""
    a, b = period_bounds(key)
    return a + timedelta(days=((b - a).days + 1) // 2)


def generate(context: dict, source: str, actor: str) -> dict:
    """调用 AI 生成复盘；目标只认候选里的 id，不够 3 个就按候选顺序补齐。不保存。"""
    key = str(context.get("period", ""))[:10]
    messages = [{"role": "system", "content": REVIEW_SYSTEM},
                {"role": "user", "content": f"上一{CADENCES[cadence_of(key)]}的支出汇总：\n" + context_text(context)}]
    out = llm.chat_json(messages, temperature=0.4, max_tokens=1200, task=f"review-{source}", actor=actor)
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
        "period": key,
        "headline": str(out.get("headline", ""))[:120],
        "wins": [str(x)[:200] for x in out.get("wins", [])][:3],
        "watch": [str(x)[:200] for x in out.get("watch", [])][:3],
        "goals": goals[:3],
        "tip": str(out.get("tip", ""))[:200],
        "stats": context.get("summary", {}),
        "lastGoals": context.get("lastGoals", []),
    }
    return report


def legacy_reports(user_id: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT week, report FROM weekly_reports WHERE user_id = ?", (user_id,)).fetchall()
    return [{**json.loads(r["report"]), "period": r["week"]} for r in rows]


def delete_legacy(user_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM weekly_reports WHERE user_id = ?", (user_id,))


# ---------- 提醒邮件里的几行字 ----------

def save_note(user_id: int, period: str, level: str, final: list, mid: list | None) -> None:
    with get_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO reminder_notes (user_id, period, level, final, mid) VALUES (?, ?, ?, ?, ?)",
                     (user_id, period, level, json.dumps(final, ensure_ascii=False),
                      json.dumps(mid, ensure_ascii=False) if mid else None))


def get_note(user_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM reminder_notes WHERE user_id = ?", (user_id,)).fetchone()
    if not row:
        return None
    return {"period": row["period"], "level": row["level"], "final": json.loads(row["final"]),
            "mid": json.loads(row["mid"]) if row["mid"] else None, "created_at": row["created_at"]}


def delete_note(user_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM reminder_notes WHERE user_id = ?", (user_id,))


# ---------- 每天早上的定时任务：只发提醒 ----------

def run(today: date | None = None) -> dict:
    stats = {"reminded": 0, "with_note": 0, "mid": 0, "skipped": 0, "failed": 0}
    if not notify.enabled():
        return stats
    today = today or date.today()
    with get_conn() as conn:
        users = conn.execute("SELECT id, email, cadence, reminded_week FROM users WHERE weekly_email = 1 AND banned = 0").fetchall()
    for user in users:
        cadence = user["cadence"] or "month"
        key = last_period(cadence, today)
        note = get_note(user["id"])
        if note and cadence_of(note["period"]) != cadence:
            delete_note(user["id"])
            note = None
        try:
            # 期中那封：这一期过半了，用户又选了期中提醒
            if note and note["mid"] and note["period"] == current_period(cadence, today) and today >= period_mid(note["period"]):
                notify.send(user["email"], f"SaveWise：{period_name(note['period'])}过半了，看看你的目标",
                            _mid_html(note), _mid_text(note))
                with get_conn() as conn:
                    conn.execute("UPDATE reminder_notes SET mid = NULL WHERE user_id = ?", (user["id"],))
                stats["mid"] += 1
            if user["reminded_week"] == key:
                stats["skipped"] += 1
                continue
            sections = note["final"] if note and note["period"] == key else []
            notify.send(user["email"], f"SaveWise：{period_name(key)}过完了，来复盘一下",
                        _reminder_html(key, sections, note and note["level"]), _reminder_text(key, sections, note and note["level"]))
            with get_conn() as conn:
                conn.execute("UPDATE users SET reminded_week = ? WHERE id = ?", (key, user["id"]))
                if note and note["period"] <= key:  # 发出去了，或者是更早的期、已经用不上了
                    conn.execute("DELETE FROM reminder_notes WHERE user_id = ?", (user["id"],))
            stats["reminded"] += 1
            stats["with_note"] += bool(sections)
        except Exception:
            log.exception("review reminder failed for user %s", user["id"])
            stats["failed"] += 1
    log.info("review job: %s", stats)
    global last_result
    last_result = {**stats, "at": datetime.now(ZoneInfo(TIMEZONE)).strftime("%Y-%m-%d %H:%M")}
    return stats


def email_report(email: str, report: dict) -> None:
    """用户在页面上点了「发到我的邮箱」：发这一份，不保存。"""
    key = str(report.get("period", ""))
    subject = f"SaveWise {period_name(key)}复盘：{report.get('headline', '')}".replace("\n", " ")[:200]
    notify.send(email, subject, _html(report, key), _text(report, key))


# ---------- 邮件 ----------

def yuan(n) -> str:
    n = float(n or 0)
    if abs(n) >= 10000:
        return f"¥{n / 10000:.{1 if abs(n) >= 100000 else 2}f}".rstrip("0").rstrip(".") + "万"
    return f"¥{round(n):,}"


def _stats_line(s: dict, unit: str) -> str:
    parts = [f"支出 {yuan(s.get('total'))}"]
    if s.get("avgPrevPeriods"):
        parts.append(f"前 {s.get('prevPeriods')} 个{unit}平均 {yuan(s['avgPrevPeriods'])}")
    if s.get("sameLastYear"):
        parts.append(f"去年同期 {yuan(s['sameLastYear'])}")
    if s.get("cardQuota"):
        parts.append(f"消费卡 {yuan(s.get('cardSpend'))} / 额度 {yuan(s['cardQuota'])}")
    return " · ".join(parts)


STYLE = "font-family:-apple-system,'PingFang SC',sans-serif;max-width:600px;line-height:1.7;color:#222"
FOOT = (f"<p style='margin-top:24px'><a href='{SITE_URL}/#review' style='color:#0f7b6c'>打开 SaveWise 查看复盘 →</a></p>"
        "<p style='color:#999;font-size:12px'>复盘由 AI 根据你的支出汇总生成，金额来自规则计算，仅供参考，不构成投资建议。"
        "不想收到可以在网站「数据 → 账号」里关闭提醒邮件。</p>")


def _html(r: dict, key: str) -> str:
    unit = CADENCES[cadence_of(key)]
    last_w, cur_w = WORDS[cadence_of(key)]
    last = "".join(
        f"<li>{'✅' if g.get('result') == '达成' else '⬜'} {escape(str(g.get('goal', '')))}"
        f"{'（' + escape(str(g['actual'])) + '）' if g.get('actual') else ''}</li>" for g in r.get("lastGoals", []))
    goals = "".join(
        f"<li style='margin-bottom:6px'><b>{escape(g.get('text', ''))}</b>"
        f"{'<br><span style=color:#777;font-size:13px>' + escape(g['why']) + '</span>' if g.get('why') else ''}</li>"
        for g in r.get("goals", []))
    bullets = lambda xs: "".join(f"<li>{escape(x)}</li>" for x in xs)  # noqa: E731
    return f"""<div style="{STYLE}">
<p style="color:#888;font-size:13px;margin:0">SaveWise 复盘 · {period_name(key)}</p>
<h2 style="margin:4px 0 8px">{escape(r['headline'])}</h2>
<p style="color:#555">{escape(_stats_line(r.get('stats', {}), unit))}</p>
{f"<h3>{last_w}的目标</h3><ul>{last}</ul>" if last else ""}
{f"<h3>👍 做得好</h3><ul>{bullets(r['wins'])}</ul>" if r.get('wins') else ""}
{f"<h3>👀 要注意</h3><ul>{bullets(r['watch'])}</ul>" if r.get('watch') else ""}
<h3 style="color:#0f7b6c">{cur_w}做这 3 件事</h3><ol>{goals}</ol>
{f"<p style='background:#f2f8f6;padding:10px 12px;border-radius:8px'>💡 {escape(r['tip'])}</p>" if r.get('tip') else ""}
{FOOT}</div>"""


def _text(r: dict, key: str) -> str:
    unit = CADENCES[cadence_of(key)]
    last_w, cur_w = WORDS[cadence_of(key)]
    lines = [f"SaveWise 复盘 {period_name(key)}", r["headline"], _stats_line(r.get("stats", {}), unit), ""]
    if r.get("lastGoals"):
        lines += [f"{last_w}的目标："] + [f"  {'✓' if g.get('result') == '达成' else '✗'} {g.get('goal')}" for g in r["lastGoals"]] + [""]
    lines += [f"{cur_w}做这 3 件事："] + [f"  {i + 1}. {g.get('text')}" for i, g in enumerate(r.get("goals", []))]
    if r.get("tip"):
        lines += ["", f"小做法：{r['tip']}"]
    return "\n".join(lines) + f"\n\n{SITE_URL}/#review"


HOWTO = ("微信：我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单；"
         "支付宝：我的 → 账单 → ··· → 开具交易流水证明；随手记：网页版导入导出。收到的 zip 直接拖进网页，输入密码即可。")
PRIVACY_NOTE = ("为了保护你的隐私，这封邮件不含任何金额：你的账单和复盘只存在你的浏览器里，"
                "云端只有用你的密码加密过的数据，我们解不开。")


def privacy_note(level: str | None) -> str:
    if not level:
        return PRIVACY_NOTE
    return ("上面几行是你在 SaveWise 网页里勾选、看过原文后存下的" + ("（不含金额）" if level == "text" else "")
            + "，这封邮件发出后服务器上就删了。你的账单和复盘只存在你的浏览器里，云端只有用你的密码加密过的数据，我们解不开。"
            + "想换成别的内容或者什么都不带，在网页「复盘」页最下面改。")


def _sections_html(sections: list) -> str:
    return "".join(
        f"<h3 style='margin:18px 0 6px;font-size:16px'>{escape(str(s.get('title', '')))}</h3>"
        f"<ul style='margin:0;padding-left:20px'>{''.join(f'<li>{escape(str(x))}</li>' for x in s.get('lines', []))}</ul>"
        for s in sections)


def _sections_text(sections: list) -> list[str]:
    out = []
    for s in sections:
        out += ["", str(s.get("title", ""))] + [f"  · {x}" for x in s.get("lines", [])]
    return out


def _reminder_body(key: str) -> str:
    last, cur = WORDS[cadence_of(key)]
    return f"花 3 分钟：导入{period_name(key)}的账单，打开 SaveWise 生成复盘，看看{last}的目标完成了没有，再定{cur}的 3 个目标。"


def _reminder_html(key: str, sections: list = (), level: str | None = None) -> str:
    return f"""<div style="{STYLE}">
<h2 style="margin:0 0 8px">{period_name(key)}过完了</h2>
<p>{escape(_reminder_body(key))}</p>
{_sections_html(sections)}
<p style="color:#555;font-size:14px;margin-top:18px">{escape(HOWTO)}</p>
<p style="color:#555;font-size:14px">🔒 {escape(privacy_note(level if sections else None))}</p>
{FOOT}</div>"""


def _reminder_text(key: str, sections: list = (), level: str | None = None) -> str:
    return "\n".join([f"{period_name(key)}过完了。", _reminder_body(key), *_sections_text(sections), "", HOWTO, "",
                      privacy_note(level if sections else None), f"{SITE_URL}/#review"])


def _mid_html(note: dict) -> str:
    return f"""<div style="{STYLE}">
<h2 style="margin:0 0 8px">{period_name(note['period'])}过半了</h2>
<p>还剩一半的日子，看看定好的目标。想看进度，导入最新的账单，网页会自动算出来。</p>
{_sections_html(note['mid'])}
<p style="color:#555;font-size:14px;margin-top:18px">🔒 {escape(privacy_note(note['level']))}</p>
{FOOT}</div>"""


def _mid_text(note: dict) -> str:
    return "\n".join([f"{period_name(note['period'])}过半了。", "还剩一半的日子，看看定好的目标。", *_sections_text(note["mid"]), "",
                      privacy_note(note["level"]), f"{SITE_URL}/#review"])
