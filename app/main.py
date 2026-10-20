"""TrimWise 后端：只做两件事——提供静态页面，以及代理 AI 调用（预算、限流、记账）。
流水的解析、分析、存储全部在用户浏览器里完成，服务器不接收也不保存原始流水。"""
import hashlib
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import costs, llm
from .config import ACCESS_CODE, ADMIN_TOKEN, BASE_DIR, DAILY_BUDGET_YUAN, DEEPSEEK_API_KEY, DEVICE_DAILY_CALLS, MODEL_DISCLOSURE
from .db import get_conn, init_db
from .prompts import CHAT_SYSTEM, CLASSIFY_SYSTEM, REVIEW_SYSTEM

logging.basicConfig(level=logging.INFO)
MAX_CONTEXT_CHARS = 40_000  # 汇总上下文的上限，防止误传原始流水或刷成本


@asynccontextmanager
async def lifespan(_app):
    init_db()
    yield


app = FastAPI(title="TrimWise", lifespan=lifespan, docs_url=None, redoc_url=None)

# 内容安全策略：页面只能连本站，浏览器里的流水不可能被脚本发到别的域名
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/api/public-config")
def public_config():
    return {
        "ai_enabled": bool(DEEPSEEK_API_KEY),
        "access_code_required": bool(ACCESS_CODE),
        "device_daily_calls": DEVICE_DAILY_CALLS,
        "model_disclosure": MODEL_DISCLOSURE,
    }


def guard(device: str, access_code: str) -> str:
    """校验访问码、预算和设备次数，返回设备 ID 的哈希（服务器不存原始设备 ID）。"""
    if ACCESS_CODE and access_code.strip() != ACCESS_CODE:
        raise HTTPException(403, "访问码不正确")
    if not DEEPSEEK_API_KEY:
        raise HTTPException(503, "服务器还没有配置 AI")
    dev = hashlib.sha256(f"trimwise|{device}".encode()).hexdigest()[:16] if device else "anon"
    try:
        costs.check_budget()
        costs.check_device(dev)
    except costs.BudgetExceeded as e:
        raise HTTPException(429, str(e)) from e
    return dev


def context_text(context: dict) -> str:
    text = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    if len(text) > MAX_CONTEXT_CHARS:
        raise HTTPException(413, "汇总数据太大了")
    return text


def call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except llm.BudgetError as e:
        raise HTTPException(429, str(e)) from e
    except llm.LLMError as e:
        logging.warning("llm failed: %s", e)
        raise HTTPException(502, "AI 暂时没有响应，请稍后再试") from e


class ReviewBody(BaseModel):
    context: dict


@app.post("/api/ai/review")
def ai_review(body: ReviewBody, x_device: str = Header(""), x_access_code: str = Header("")):
    dev = guard(x_device, x_access_code)
    messages = [{"role": "system", "content": REVIEW_SYSTEM},
                {"role": "user", "content": "我的支出汇总：\n" + context_text(body.context)}]
    return call(llm.chat_json, messages, temperature=0.4, max_tokens=1500, task="review", device=dev)


class ChatMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=2000)


class ChatBody(BaseModel):
    context: dict
    messages: list[ChatMessage] = Field(min_length=1, max_length=20)


@app.post("/api/ai/chat")
def ai_chat(body: ChatBody, x_device: str = Header(""), x_access_code: str = Header("")):
    dev = guard(x_device, x_access_code)
    messages = [{"role": "system", "content": CHAT_SYSTEM + "\n\n支出汇总：\n" + context_text(body.context)}]
    messages += [m.model_dump() for m in body.messages[-10:]]
    return {"reply": call(llm.chat, messages, temperature=0.5, max_tokens=800, task="chat", device=dev)}


class ClassifyBody(BaseModel):
    items: list[str] = Field(min_length=1, max_length=150)
    taxonomy: dict[str, list[str]]


@app.post("/api/ai/classify")
def ai_classify(body: ClassifyBody, x_device: str = Header(""), x_access_code: str = Header("")):
    dev = guard(x_device, x_access_code)
    taxonomy = "\n".join(f"{k}: {'、'.join(v)}" for k, v in body.taxonomy.items())
    lines = "\n".join(f"{i}. {s[:60]}" for i, s in enumerate(body.items))
    messages = [{"role": "system", "content": CLASSIFY_SYSTEM.format(taxonomy=taxonomy)},
                {"role": "user", "content": lines}]
    out = call(llm.chat_json, messages, temperature=0, max_tokens=4000, task="classify", device=dev)
    valid = []
    for it in out.get("items", []):
        try:
            i, c1, c2 = int(it["i"]), str(it["cat1"]), str(it["cat2"])
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= i < len(body.items) and c2 in body.taxonomy.get(c1, []):
            valid.append({"i": i, "cat1": c1, "cat2": c2})
    return {"items": valid}


@app.get("/api/admin/stats")
def admin_stats(token: str = ""):
    if not ADMIN_TOKEN or token != ADMIN_TOKEN:
        raise HTTPException(404, "Not Found")
    with get_conn() as conn:
        days = [dict(r) for r in conn.execute(
            "SELECT date(at, '+8 hours') AS day, task, COUNT(*) AS calls, COUNT(DISTINCT device) AS devices,"
            " ROUND(SUM(cost), 4) AS cost FROM llm_usage GROUP BY day, task ORDER BY day DESC, task LIMIT 200")]
    return {"today_cost": round(costs.today_cost(), 4), "daily_budget": DAILY_BUDGET_YUAN, "days": days}


STATIC = BASE_DIR / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/sw.js")
def service_worker():
    # Service Worker 要放在根路径，才能管住整个站点
    return FileResponse(STATIC / "sw.js", media_type="text/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
