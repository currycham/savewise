import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

# 注册邀请码（内测）：留空表示开放注册。不登录也能用本地分析，AI 教练和每周复盘需要登录
INVITE_CODE = os.getenv("INVITE_CODE", "").strip()
SITE_URL = os.getenv("SITE_URL", "https://trimwise.waywise.tech").rstrip("/")
# 后台统计接口 /api/admin/stats 的口令；留空则关闭该接口
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "").strip()
# 页面底部公示的模型与备案/登记信息（上线前按网信办登记结果填写）
MODEL_DISCLOSURE = os.getenv("MODEL_DISCLOSURE", "AI 功能由 DeepSeek 大模型提供")

# DeepSeek 单价（元 / 百万 tokens），只用于成本估算，以控制台账单为准
DEEPSEEK_PRICE_INPUT = float(os.getenv("DEEPSEEK_PRICE_INPUT", "2"))
DEEPSEEK_PRICE_CACHED = float(os.getenv("DEEPSEEK_PRICE_CACHED", "0.2"))
DEEPSEEK_PRICE_OUTPUT = float(os.getenv("DEEPSEEK_PRICE_OUTPUT", "3"))

# ---------- 成本控制 ----------
# 全站每日成本上限（元，北京时间零点重置），0 表示不限
DAILY_BUDGET_YUAN = float(os.getenv("DAILY_BUDGET_YUAN", "5"))
# 每个用户每天最多调用 AI 几次（复盘、提问、归类都算；周一的定时复盘不算）
USER_DAILY_CALLS = int(os.getenv("USER_DAILY_CALLS", "30"))
TIMEZONE = "Asia/Shanghai"

# ---------- 每周复盘 ----------
# 每周一几点生成上周复盘并发邮件（北京时间）
WEEKLY_RUN_TIME = os.getenv("WEEKLY_RUN_TIME", "08:00")
# 云同步的密文上限（MB）。6 年流水压缩加密后通常不到 2MB
VAULT_MAX_MB = float(os.getenv("VAULT_MAX_MB", "12"))

# 邮件（每周复盘、找回密码）。腾讯云封了 25 端口，用 465（SSL）或 587（STARTTLS）
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "465"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", "")

DB_PATH = Path(os.getenv("DB_PATH", BASE_DIR / "data" / "trimwise.db"))
