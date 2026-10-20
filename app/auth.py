"""账号。浏览器用密码派生出两把钥匙：一把是登录口令（发给服务器，这里再加盐哈希），
另一把是数据密钥（只留在浏览器里加密云同步的数据）。服务器拿不到密码，也就解不开数据。"""
import hashlib
import secrets
import time
from collections import defaultdict

from fastapi import Cookie, Header, HTTPException, Request, Response

from . import notify
from .config import ADMIN_TOKEN, SITE_URL
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


def admin_user(session: str | None = Cookie(default=None), token: str = Header("", alias="X-Admin-Token")) -> dict:
    """登录的管理员，或者脚本带上请求头 X-Admin-Token（放在 URL 里会进访问日志）。其他人一律 404，不暴露后台。"""
    if ADMIN_TOKEN and token and secrets.compare_digest(token, ADMIN_TOKEN):
        return {"id": 0, "email": "token"}
    user = user_from_session(session)
    if not user or user["role"] != "admin":
        raise HTTPException(404, "Not Found")
    return user


def login_session(request: Request, response: Response, user_id: int) -> None:
    token = secrets.token_urlsafe(32)
    with get_conn() as conn:
        conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    response.set_cookie("session", token, httponly=True, samesite="lax", secure=request.url.scheme == "https",
                        max_age=60 * 60 * 24 * SESSION_DAYS)


def send_reset(user_id: int, email: str) -> None:
    """生成 1 小时有效的重设密码链接发到邮箱（用户自己找回、管理员代发都走这里）。"""
    token = secrets.token_urlsafe(32)
    with get_conn() as conn:
        conn.execute("DELETE FROM password_resets WHERE user_id = ? OR expires_at < datetime('now')", (user_id,))
        conn.execute("INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))",
                     (token, user_id))
    link = f"{SITE_URL}/#reset={token}"
    notify.send(email, "SaveWise：重设密码",
                f"<p>点下面的链接重设密码（1 小时内有效）：</p><p><a href='{link}'>{link}</a></p>"
                "<p style='color:#888'>云同步的数据是用旧密码加密的，重设后云端那份会清空；"
                "用存有数据的电脑或手机登录一次，就会用新密码重新同步。</p><p style='color:#888'>不是你本人操作的话，忽略这封邮件即可。</p>",
                f"重设密码（1 小时内有效）：{link}\n云端加密数据会清空，用存有数据的设备登录一次即可重新同步。")
