"""后台管理接口：仅管理员（或带 X-Admin-Token 的脚本）可用，其他人一律 404。
只看账号和用量，看不到流水：云端只有密文，快照和复盘的内容也不在后台展示。"""
import threading
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import costs, notify, weekly
from .auth import admin_user, send_reset
from .config import ADMIN_EMAILS, DAILY_BUDGET_YUAN, DEEPSEEK_API_KEY, TIMEZONE, USER_DAILY_CALLS, WEEKLY_RUN_TIME
from .db import get_conn

router = APIRouter(prefix="/api/admin", dependencies=[Depends(admin_user)])

TASKS = {"review": "月度复盘", "chat": "AI 提问", "classify": "AI 归类", "weekly-app": "每周复盘（页面生成）",
         "weekly-job": "每周复盘（周一定时）"}


def _local(utc: str | None) -> str | None:
    if not utc:
        return None
    t = datetime.strptime(utc[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZoneInfo("UTC"))
    return t.astimezone(ZoneInfo(TIMEZONE)).strftime("%Y-%m-%d %H:%M")


def _utc_days_ago(days: int) -> str:
    """北京时间 N 天前零点，换算成 UTC 字符串（库里时间都存 UTC）。"""
    tz = ZoneInfo(TIMEZONE)
    start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days)
    return start.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%d %H:%M:%S")


# ---------- 概览 ----------

_balance_cache: dict = {"at": 0.0, "result": None}


def _balance() -> dict | None:
    """DeepSeek 余额，缓存 10 分钟。"""
    if not DEEPSEEK_API_KEY:
        return None
    if time.time() - _balance_cache["at"] < 600:
        return _balance_cache["result"]
    try:
        r = httpx.get("https://api.deepseek.com/user/balance",
                      headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}"}, timeout=15)
        r.raise_for_status()
        infos = r.json().get("balance_infos") or []
        cny = next((b for b in infos if b.get("currency") == "CNY"), infos[0] if infos else {})
        result = {"balance": round(float(cny.get("total_balance") or 0), 2), "error": None}
    except Exception as e:
        result = {"balance": None, "error": str(e)[:200]}
    _balance_cache.update(at=time.time(), result=result)
    return result


@router.get("/overview")
def overview():
    today, week = _utc_days_ago(0), _utc_days_ago(6)
    with get_conn() as conn:
        n = lambda sql, *a: conn.execute(sql, a).fetchone()[0]  # noqa: E731
        stats = [
            ["用户总数", n("SELECT COUNT(*) FROM users")],
            ["近 7 天新注册", n("SELECT COUNT(*) FROM users WHERE created_at >= ?", week)],
            ["近 7 天活跃", n("SELECT COUNT(*) FROM users WHERE last_seen_at >= ?", week)],
            ["开启云同步", n("SELECT COUNT(*) FROM vaults")],
            ["开启每周邮件", n("SELECT COUNT(*) FROM users WHERE weekly_email = 1 AND banned = 0")],
            ["今日 AI 调用", n("SELECT COUNT(*) FROM llm_usage WHERE at >= ?", today)],
            ["近 7 天成本（估算）", f"¥{n('SELECT COALESCE(SUM(cost), 0) FROM llm_usage WHERE at >= ?', week):.2f}"],
            ["累计成本（估算）", f"¥{n('SELECT COALESCE(SUM(cost), 0) FROM llm_usage'):.2f}"],
        ]
        by_task = [dict(r) for r in conn.execute(
            "SELECT task, COUNT(*) AS calls, COUNT(DISTINCT actor) AS users, SUM(prompt_tokens) AS input,"
            " SUM(completion_tokens) AS output, SUM(cost) AS cost FROM llm_usage WHERE at >= ? GROUP BY task"
            " ORDER BY cost DESC", (week,))]
        by_day = [dict(r) for r in conn.execute(
            "SELECT substr(datetime(at, '+8 hours'), 1, 10) AS day, COUNT(*) AS calls, COUNT(DISTINCT actor) AS users,"
            " SUM(cost) AS cost FROM llm_usage WHERE at >= ? GROUP BY day ORDER BY day DESC", (_utc_days_ago(13),))]
    for t in by_task:
        t["name"] = TASKS.get(t["task"], t["task"])
    return {"stats": stats, "by_task": by_task, "by_day": by_day, "balance": _balance(),
            "budget": {"used": costs.today_cost(), "limit": DAILY_BUDGET_YUAN, "user_calls": USER_DAILY_CALLS}}


# ---------- 用户 ----------

@router.get("/users")
def users():
    month = _utc_days_ago(29)
    with get_conn() as conn:
        rows = [dict(r) for r in conn.execute(
            """SELECT u.id, u.email, u.role, u.banned, u.weekly_email, u.created_at, u.last_seen_at,
                 v.updated_at AS synced_at, COALESCE(LENGTH(v.data), 0) AS vault_size,
                 (SELECT COUNT(*) FROM weekly_reports w WHERE w.user_id = u.id) AS reports,
                 (SELECT COUNT(*) FROM llm_usage x WHERE x.actor = 'u' || u.id AND x.at >= ?) AS calls_30d,
                 (SELECT COALESCE(SUM(cost), 0) FROM llm_usage x WHERE x.actor = 'u' || u.id) AS cost_total
               FROM users u LEFT JOIN vaults v ON v.user_id = u.id ORDER BY u.id DESC""", (month,))]
    for r in rows:
        for k in ("created_at", "last_seen_at", "synced_at"):
            r[k] = _local(r[k])
        r["pinned_admin"] = r["email"] in ADMIN_EMAILS
    return {"users": rows, "email_enabled": notify.enabled()}


class RoleIn(BaseModel):
    role: str


class BanIn(BaseModel):
    banned: bool


def _target(conn, user_id: int, admin: dict) -> dict:
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(404, "用户不存在")
    if row["id"] == admin["id"]:
        raise HTTPException(400, "不能修改自己的角色或状态")
    return dict(row)


@router.post("/users/{user_id}/role")
def set_role(user_id: int, body: RoleIn, admin: dict = Depends(admin_user)):
    with get_conn() as conn:
        u = _target(conn, user_id, admin)
        if body.role != "admin" and u["email"] in ADMIN_EMAILS:
            raise HTTPException(400, "该用户在 .env 的 ADMIN_EMAILS 里，需先从配置中移除")
        conn.execute("UPDATE users SET role = ? WHERE id = ?", ("admin" if body.role == "admin" else "user", user_id))
    return {"ok": True}


@router.post("/users/{user_id}/ban")
def set_banned(user_id: int, body: BanIn, admin: dict = Depends(admin_user)):
    with get_conn() as conn:
        _target(conn, user_id, admin)
        conn.execute("UPDATE users SET banned = ? WHERE id = ?", (1 if body.banned else 0, user_id))
        if body.banned:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    return {"ok": True}


@router.post("/users/{user_id}/send-reset")
def send_reset_link(user_id: int, admin: dict = Depends(admin_user)):
    """密码只有用户自己知道（数据用它加密），管理员不能代设，只能把重设链接发到对方邮箱。"""
    if not notify.enabled():
        raise HTTPException(503, "服务器还没有配置邮件")
    with get_conn() as conn:
        u = _target(conn, user_id, admin)
    if u["banned"]:
        raise HTTPException(400, "账号已停用，先恢复再发")
    send_reset(u["id"], u["email"])
    return {"ok": True}


# ---------- 每周复盘 ----------

_run_state: dict = {"running": False, "error": None}


@router.get("/weekly")
def weekly_stats():
    last = weekly.last_week()
    with get_conn() as conn:
        weeks = [dict(r) for r in conn.execute(
            "SELECT week, COUNT(*) AS reports, SUM(source = 'app') AS by_app, SUM(source = 'job') AS by_job,"
            " SUM(emailed_at IS NOT NULL) AS emailed FROM weekly_reports GROUP BY week ORDER BY week DESC LIMIT 12")]
        pending = conn.execute(
            """SELECT SUM(s.week = ?) AS ready, SUM(s.week < ?) AS stale,
                 SUM(s.user_id IS NULL) AS no_snapshot, COUNT(*) AS subscribed
               FROM users u LEFT JOIN snapshots s ON s.user_id = u.id
               WHERE u.weekly_email = 1 AND u.banned = 0""", (last, last)).fetchone()
        reminded = conn.execute("SELECT COUNT(*) FROM users WHERE reminded_week = ?", (last,)).fetchone()[0]
    return {"last_week": last, "run_time": WEEKLY_RUN_TIME, "email_enabled": notify.enabled(), "weeks": weeks,
            "subscribers": {**{k: v or 0 for k, v in dict(pending).items()}, "reminded": reminded},
            "run": {**_run_state, "last": weekly.last_result}}


@router.post("/weekly-run")
def weekly_run():
    """手动补跑周一的定时任务（已经发过的不会重复发）。逐个用户调 AI，比较慢，放到后台跑。"""
    if _run_state["running"]:
        raise HTTPException(409, "正在运行")

    def work():
        try:
            weekly.run()
        except Exception as e:
            _run_state["error"] = str(e)[:200]
        finally:
            _run_state["running"] = False

    _run_state.update(running=True, error=None)
    threading.Thread(target=work, daemon=True).start()
    return {"ok": True}
