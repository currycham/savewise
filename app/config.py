import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

# 内测访问码：留空表示 AI 功能对所有人开放；填写后用 AI 需要先输入访问码（本地分析不受影响）
ACCESS_CODE = os.getenv("ACCESS_CODE", "").strip()
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
# 每台设备每天最多调用 AI 几次（月度复盘、提问、归类都算）
DEVICE_DAILY_CALLS = int(os.getenv("DEVICE_DAILY_CALLS", "30"))
TIMEZONE = "Asia/Shanghai"

DB_PATH = Path(os.getenv("DB_PATH", BASE_DIR / "data" / "trimwise.db"))
