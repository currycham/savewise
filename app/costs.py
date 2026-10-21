"""成本记账、全站每日预算、每个用户每日调用次数。"""
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from .config import DAILY_BUDGET_YUAN, USER_DAILY_CALLS, TIMEZONE
from .db import get_conn

log = logging.getLogger(__name__)


class BudgetExceeded(RuntimeError):
    pass


def today_start_utc() -> str:
    now = datetime.now(ZoneInfo(TIMEZONE))
    start = now.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(ZoneInfo("UTC"))
    return start.strftime("%Y-%m-%d %H:%M:%S")


def today_cost() -> float:
    with get_conn() as conn:
        return conn.execute("SELECT COALESCE(SUM(cost), 0) FROM llm_usage WHERE at >= ?",
                            (today_start_utc(),)).fetchone()[0]


def check_budget() -> None:
    if DAILY_BUDGET_YUAN > 0 and today_cost() >= DAILY_BUDGET_YUAN:
        raise BudgetExceeded(f"今日 AI 预算（¥{DAILY_BUDGET_YUAN:g}）已用完，明天零点恢复")


def calls_today(actor: str) -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) FROM llm_usage WHERE actor = ? AND at >= ?",
                            (actor, today_start_utc())).fetchone()[0]


def check_user(actor: str) -> None:
    if USER_DAILY_CALLS > 0 and calls_today(actor) >= USER_DAILY_CALLS:
        raise BudgetExceeded(f"今天的 AI 次数（{USER_DAILY_CALLS} 次）用完了，明天再来")


def record(task: str, actor: str, cost: float, prompt: int = 0, cached: int = 0, completion: int = 0) -> None:
    try:
        with get_conn() as conn:
            conn.execute("INSERT INTO llm_usage (task, actor, prompt_tokens, cached_tokens, completion_tokens, cost)"
                         " VALUES (?, ?, ?, ?, ?, ?)", (task, actor, prompt, cached, completion, cost))
    except Exception:
        log.exception("record usage failed")  # 记账失败不影响主流程


EMAILS_PER_DAY = 5


def check_user_email(actor: str) -> None:
    """「发到我的邮箱」每人每天最多几封，防止被拿来刷邮件。只记次数，记在 llm_usage 里（成本 0）。"""
    with get_conn() as conn:
        n = conn.execute("SELECT COUNT(*) FROM llm_usage WHERE task = 'recap-email' AND actor = ? AND at >= ?",
                         (actor, today_start_utc())).fetchone()[0]
    if n >= EMAILS_PER_DAY:
        raise BudgetExceeded(f"今天已经发了 {EMAILS_PER_DAY} 封，明天再发")
    record("recap-email", actor, 0)
