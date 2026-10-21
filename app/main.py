"""SaveWise 后端：静态页面、账号、加密云同步、定期复盘、AI 代理（预算、限流、记账）。
流水的解析和分析在用户浏览器里完成；云同步的数据在浏览器里加密，服务器只存密文、解不开。"""
import logging
import re
from contextlib import asynccontextmanager

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import admin, costs, llm, notify, review
from .auth import check_attempts, current_user, hash_pw, login_session, record_fail, send_reset, user_from_session, verify_pw
from .config import (ADMIN_EMAILS, BASE_DIR, DEEPSEEK_API_KEY, INVITE_CODE, MODEL_DISCLOSURE, TIMEZONE, USER_DAILY_CALLS,
                     VAULT_MAX_MB, WEEKLY_RUN_TIME)
from .db import get_conn, init_db
from .prompts import CHAT_SYSTEM, CLASSIFY_SYSTEM

logging.basicConfig(level=logging.INFO)
scheduler = BackgroundScheduler(timezone=TIMEZONE)
EMAIL_RE = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"
AUTH_RE = r"^[0-9a-f]{64}$"  # 浏览器由密码派生的登录口令（PBKDF2-SHA256，十六进制）


@asynccontextmanager
async def lifespan(_app):
    init_db()
    hour, minute = WEEKLY_RUN_TIME.split(":")
    # 每天跑一次：按每个用户选的周期（周 / 月 / 季度）看上一期该不该生成复盘、发邮件或提醒
    scheduler.add_job(review.run, "cron", hour=int(hour), minute=int(minute), id="review",
                      replace_existing=True, misfire_grace_time=3600 * 6)
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="SaveWise", lifespan=lifespan, docs_url=None, redoc_url=None)
app.include_router(admin.router)

# 内容安全策略：页面只能连本站，浏览器里的流水不可能被脚本发到别的域名
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/public-config")
def public_config():
    return {
        "ai_enabled": bool(DEEPSEEK_API_KEY),
        "invite_required": bool(INVITE_CODE),
        "email_enabled": notify.enabled(),
        "user_daily_calls": USER_DAILY_CALLS,
        "model_disclosure": MODEL_DISCLOSURE,
    }


# ---------- 账号 ----------

class Credentials(BaseModel):
    email: str = Field(max_length=200, pattern=EMAIL_RE)
    auth: str = Field(pattern=AUTH_RE)
    invite_code: str = ""


def norm_email(email: str) -> str:
    return email.strip().lower()


@app.post("/api/register")
def register(body: Credentials, request: Request, response: Response):
    if INVITE_CODE and body.invite_code.strip() != INVITE_CODE:
        raise HTTPException(403, "邀请码不正确")
    email = norm_email(body.email)
    with get_conn() as conn:
        if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise HTTPException(409, "这个邮箱已经注册过了，直接登录就行")
        cur = conn.execute("INSERT INTO users (email, auth_hash, role) VALUES (?, ?, ?)",
                           (email, hash_pw(body.auth), "admin" if email in ADMIN_EMAILS else "user"))
    login_session(request, response, cur.lastrowid)
    return {"ok": True}


@app.post("/api/login")
def login(body: Credentials, request: Request, response: Response):
    email = norm_email(body.email)
    check_attempts(email)
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row or not verify_pw(body.auth, row["auth_hash"]):
        record_fail(email)
        raise HTTPException(401, "邮箱或密码不对")
    if row["banned"]:
        raise HTTPException(403, "账号已停用")
    login_session(request, response, row["id"])
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response, session: str | None = Cookie(default=None)):
    if session:
        with get_conn() as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (session,))
    response.delete_cookie("session")
    return {"ok": True}


@app.get("/api/me")
def me(user: dict = Depends(current_user)):
    with get_conn() as conn:
        vault = conn.execute("SELECT version, updated_at, LENGTH(data) AS size FROM vaults WHERE user_id = ?",
                             (user["id"],)).fetchone()
        legacy = conn.execute("SELECT COUNT(*) FROM weekly_reports WHERE user_id = ?", (user["id"],)).fetchone()[0]
    return {
        "email": user["email"], "weekly_email": bool(user["weekly_email"]), "cadence": user["cadence"] or "month",
        "is_admin": user["role"] == "admin",
        "vault_version": vault["version"] if vault else 0, "vault_updated_at": vault["updated_at"] if vault else None,
        "vault_size": vault["size"] if vault else 0, "legacy_recaps": legacy,
    }


class Settings(BaseModel):
    weekly_email: bool | None = None   # 复盘提醒邮件开关（列名沿用 weekly_email）
    cadence: str | None = Field(default=None, pattern="^(week|month|quarter)$")


@app.put("/api/settings")
def update_settings(body: Settings, user: dict = Depends(current_user)):
    with get_conn() as conn:
        if body.weekly_email is not None:
            conn.execute("UPDATE users SET weekly_email = ? WHERE id = ?", (int(body.weekly_email), user["id"]))
        if body.cadence:
            conn.execute("UPDATE users SET cadence = ? WHERE id = ?", (body.cadence, user["id"]))
    return {"ok": True}


class VaultBody(BaseModel):
    iv: str = Field(max_length=64)
    data: str


class PasswordChange(BaseModel):
    old_auth: str = Field(pattern=AUTH_RE)
    new_auth: str = Field(pattern=AUTH_RE)
    vault: VaultBody | None = None   # 用新密钥重新加密的数据；本机没有数据时为空，云端的旧密文会被删掉


def check_vault(v: VaultBody) -> None:
    if len(v.data) > VAULT_MAX_MB * 1024 * 1024 * 4 / 3:
        raise HTTPException(413, f"数据太大了（加密后超过 {VAULT_MAX_MB:g}MB）")
    if not re.fullmatch(r"[A-Za-z0-9+/=]+", v.iv) or not re.fullmatch(r"[A-Za-z0-9+/=]*", v.data[:1000]):
        raise HTTPException(400, "格式不对")


def put_vault(conn, user_id: int, v: VaultBody | None) -> int:
    cur = conn.execute("SELECT version FROM vaults WHERE user_id = ?", (user_id,)).fetchone()
    version = (cur["version"] if cur else 0) + 1
    if v is None:
        conn.execute("DELETE FROM vaults WHERE user_id = ?", (user_id,))
        return 0
    conn.execute("INSERT INTO vaults (user_id, version, iv, data) VALUES (?, ?, ?, ?) ON CONFLICT (user_id)"
                 " DO UPDATE SET version = excluded.version, iv = excluded.iv, data = excluded.data, updated_at = CURRENT_TIMESTAMP",
                 (user_id, version, v.iv, v.data))
    return version


@app.post("/api/password/change")
def change_password(body: PasswordChange, user: dict = Depends(current_user), session: str | None = Cookie(default=None)):
    if not verify_pw(body.old_auth, user["auth_hash"]):
        raise HTTPException(403, "原密码不对")
    if body.vault:
        check_vault(body.vault)
    with get_conn() as conn:
        conn.execute("UPDATE users SET auth_hash = ? WHERE id = ?", (hash_pw(body.new_auth), user["id"]))
        version = put_vault(conn, user["id"], body.vault)
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND token != ?", (user["id"], session or ""))
    return {"version": version}


class Forgot(BaseModel):
    email: str = Field(max_length=200, pattern=EMAIL_RE)


@app.post("/api/password/forgot")
def forgot_password(body: Forgot):
    if not notify.enabled():
        raise HTTPException(503, "服务器还没有配置邮件，暂时不能找回密码")
    email = norm_email(body.email)
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM users WHERE email = ? AND banned = 0", (email,)).fetchone()
    if row:
        send_reset(row["id"], email)
    return {"ok": True}  # 不透露邮箱是否注册过


@app.get("/api/password/reset/{token}")
def reset_info(token: str):
    with get_conn() as conn:
        row = conn.execute("SELECT u.email FROM password_resets r JOIN users u ON u.id = r.user_id"
                           " WHERE r.token = ? AND r.expires_at >= datetime('now')", (token,)).fetchone()
    if not row:
        raise HTTPException(404, "链接已失效，请重新申请")
    return {"email": row["email"]}


class Reset(BaseModel):
    token: str = Field(max_length=100)
    auth: str = Field(pattern=AUTH_RE)


@app.post("/api/password/reset")
def reset_password(body: Reset, request: Request, response: Response):
    with get_conn() as conn:
        row = conn.execute("SELECT user_id FROM password_resets WHERE token = ? AND expires_at >= datetime('now')",
                           (body.token,)).fetchone()
        if not row:
            raise HTTPException(404, "链接已失效，请重新申请")
        uid = row["user_id"]
        conn.execute("UPDATE users SET auth_hash = ? WHERE id = ?", (hash_pw(body.auth), uid))
        conn.execute("DELETE FROM vaults WHERE user_id = ?", (uid,))  # 旧密文用旧密码加密，已经解不开了
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (uid,))
        conn.execute("DELETE FROM password_resets WHERE user_id = ?", (uid,))
    login_session(request, response, uid)
    return {"ok": True}


@app.delete("/api/account")
def delete_account(response: Response, user: dict = Depends(current_user)):
    with get_conn() as conn:
        conn.execute("DELETE FROM users WHERE id = ?", (user["id"],))  # 级联删除会话、密文、快照、复盘
    response.delete_cookie("session")
    return {"ok": True}


# ---------- 加密云同步 ----------

@app.get("/api/vault")
def get_vault(user: dict = Depends(current_user)):
    with get_conn() as conn:
        row = conn.execute("SELECT version, iv, data, updated_at FROM vaults WHERE user_id = ?", (user["id"],)).fetchone()
    return dict(row) if row else {"version": 0}


class VaultPut(VaultBody):
    base_version: int


@app.put("/api/vault")
def save_vault(body: VaultPut, user: dict = Depends(current_user)):
    """乐观锁：base_version 不是云端最新版本，说明别的设备先改过，返回 409 让浏览器先合并。"""
    check_vault(body)
    with get_conn() as conn:
        cur = conn.execute("SELECT version FROM vaults WHERE user_id = ?", (user["id"],)).fetchone()
        if (cur["version"] if cur else 0) != body.base_version:
            raise HTTPException(409, "云端有更新的版本")
        version = put_vault(conn, user["id"], body)
    return {"version": version}


# ---------- AI ----------

def guard(user: dict) -> str:
    """校验预算和用户次数，返回记账用的 actor。"""
    if not DEEPSEEK_API_KEY:
        raise HTTPException(503, "服务器还没有配置 AI")
    actor = f"u{user['id']}"
    try:
        costs.check_budget()
        costs.check_user(actor)
    except costs.BudgetExceeded as e:
        raise HTTPException(429, str(e)) from e
    return actor


def context_text(context: dict) -> str:
    try:
        return review.context_text(context)
    except ValueError as e:
        raise HTTPException(413, str(e)) from e


def call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except llm.BudgetError as e:
        raise HTTPException(429, str(e)) from e
    except llm.LLMError as e:
        logging.warning("llm failed: %s", e)
        raise HTTPException(502, "AI 暂时没有响应，请稍后再试") from e


class ContextBody(BaseModel):
    context: dict


@app.post("/api/recaps/generate")
def recap_generate(body: ContextBody, user: dict = Depends(current_user)):
    """转给 AI 生成复盘，原样返回，汇总和复盘都不保存（复盘由浏览器加密后同步）。"""
    actor = guard(user)
    context_text(body.context)
    if not review.PERIOD_RE.fullmatch(str(body.context.get("period", ""))):
        raise HTTPException(400, "缺少复盘的期")
    return call(review.generate, body.context, "app", actor)


class RecapEmail(BaseModel):
    report: dict


@app.post("/api/recaps/email")
def recap_email(body: RecapEmail, user: dict = Depends(current_user)):
    """用户点了「发到我的邮箱」：发这一份，不保存。"""
    if not notify.enabled():
        raise HTTPException(503, "服务器还没有配置邮件")
    if len(review.context_text(body.report)) > 20_000 or not review.PERIOD_RE.fullmatch(str(body.report.get("period", ""))):
        raise HTTPException(400, "复盘内容不对")
    try:
        costs.check_user_email(f"u{user['id']}")
    except costs.BudgetExceeded as e:
        raise HTTPException(429, str(e)) from e
    review.email_report(user["email"], body.report)
    return {"ok": True}


@app.get("/api/recaps/legacy")
def recap_legacy(user: dict = Depends(current_user)):
    """以前存在服务器上的复盘：浏览器取走、存进加密数据后调 DELETE 删掉。"""
    return {"reports": review.legacy_reports(user["id"])}


@app.delete("/api/recaps/legacy")
def recap_legacy_delete(user: dict = Depends(current_user)):
    review.delete_legacy(user["id"])
    return {"ok": True}


class ChatMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=2000)


class ChatBody(BaseModel):
    context: dict
    messages: list[ChatMessage] = Field(min_length=1, max_length=20)


@app.post("/api/ai/chat")
def ai_chat(body: ChatBody, user: dict = Depends(current_user)):
    actor = guard(user)
    messages = [{"role": "system", "content": CHAT_SYSTEM + "\n\n支出汇总：\n" + context_text(body.context)}]
    messages += [m.model_dump() for m in body.messages[-10:]]
    return {"reply": call(llm.chat, messages, temperature=0.5, max_tokens=800, task="chat", actor=actor)}


class ClassifyBody(BaseModel):
    items: list[str] = Field(min_length=1, max_length=150)
    taxonomy: dict[str, list[str]]


@app.post("/api/ai/classify")
def ai_classify(body: ClassifyBody, user: dict = Depends(current_user)):
    actor = guard(user)
    taxonomy = "\n".join(f"{k}: {'、'.join(v)}" for k, v in body.taxonomy.items())
    lines = "\n".join(f"{i}. {s[:60]}" for i, s in enumerate(body.items))
    messages = [{"role": "system", "content": CLASSIFY_SYSTEM.format(taxonomy=taxonomy)},
                {"role": "user", "content": lines}]
    out = call(llm.chat_json, messages, temperature=0, max_tokens=4000, task="classify", actor=actor)
    valid = []
    for it in out.get("items", []):
        try:
            i, c1, c2 = int(it["i"]), str(it["cat1"]), str(it["cat2"])
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= i < len(body.items) and c2 in body.taxonomy.get(c1, []):
            valid.append({"i": i, "cat1": c1, "cat2": c2})
    return {"items": valid}


STATIC = BASE_DIR / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/sw.js")
def service_worker():
    # Service Worker 要放在根路径，才能管住整个站点
    return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/admin")
def admin_page(session: str | None = Cookie(default=None)):
    user = user_from_session(session)
    if not user or user["role"] != "admin":
        raise HTTPException(404, "Not Found")
    return FileResponse(STATIC / "admin.html", headers={"Cache-Control": "no-cache"})


@app.api_route("/", methods=["GET", "HEAD"])
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
