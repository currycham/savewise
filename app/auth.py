"""账号。浏览器用密码派生出两把钥匙：一把是登录口令（发给服务器，这里再加盐哈希），
另一把是数据密钥（只留在浏览器里加密云同步的数据）。服务器拿不到密码，也就解不开数据。"""
import hashlib
import secrets
import time
from collections import defaultdict

from fastapi import Cookie, HTTPException, Request, Response

from .db import get_conn

SESSION_DAYS = 90
_fails: dict[str, list[float]] = defaultdict(list)


def hash_pw(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000).hex()
    return f"{salt}${digest}"


def verify_pw(password: str, stored: str) -> bool:
    salt, _ = stored.split("$", 1)
    return secrets.compare_digest(hash_pw(password, salt), stored)


def check_attempts(email: str) -> None:
    """同一个邮箱 15 分钟内输错 10 次就先锁住（单进程运行，存在内存里就够了）。"""
    now = time.time()
    _fails[email] = [t for t in _fails[email] if now - t < 900]
    if len(_fails[email]) >= 10:
        raise HTTPException(429, "密码输错次数太多，请 15 分钟后再试")


def record_fail(email: str) -> None:
    _fails[email].append(time.time())


def user_from_session(session: str | None) -> dict | None:
    if not session:
        return None
    with get_conn() as conn:
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.token = ? AND s.created_at >= datetime('now', ?)", (session, f"-{SESSION_DAYS} day")).fetchone()
        if row and not row["banned"]:
            conn.execute("UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?"
                         " AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-10 minutes'))", (row["id"],))
    return dict(row) if row and not row["banned"] else None


def current_user(session: str | None = Cookie(default=None)) -> dict:
    user = user_from_session(session)
    if not user:
        raise HTTPException(401, "请先登录")
    return user


def login_session(request: Request, response: Response, user_id: int) -> None:
    token = secrets.token_urlsafe(32)
    with get_conn() as conn:
        conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    response.set_cookie("session", token, httponly=True, samesite="lax", secure=request.url.scheme == "https",
                        max_age=60 * 60 * 24 * SESSION_DAYS)
