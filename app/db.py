"""服务器存的东西：
- 账号（邮箱 + 由密码在浏览器里派生出的登录口令的哈希，服务器拿不到密码本身）
- 云同步密文（流水和计划在浏览器里加密，密钥不离开浏览器，服务器解不开）
- 每周汇总快照和每周复盘（按周、按分类的金额，和发给 AI 的内容一样，用户同意后才上传）
- AI 调用记账（预算和限流）"""
import sqlite3
from contextlib import contextmanager

from .config import ADMIN_EMAILS, DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    auth_hash TEXT NOT NULL,
    weekly_email INTEGER DEFAULT 1,
    reminded_week TEXT DEFAULT '',     -- 最近一次发“上周账单还没导入”提醒的周，避免重复发
    role TEXT DEFAULT 'user',          -- user / admin
    banned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vaults (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    iv TEXT NOT NULL,
    data TEXT NOT NULL,                -- base64 密文
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS snapshots (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    week TEXT NOT NULL,                -- 汇总的是哪一周（周一的日期）
    context TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS weekly_reports (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week TEXT NOT NULL,
    report TEXT NOT NULL,
    source TEXT DEFAULT 'app',         -- app：用户在页面上生成；job：周一定时生成
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    emailed_at TEXT,
    UNIQUE (user_id, week)
);
CREATE TABLE IF NOT EXISTS llm_usage (
    id INTEGER PRIMARY KEY,
    task TEXT NOT NULL,
    actor TEXT DEFAULT '',           -- u<用户ID>，或 job（定时任务）
    prompt_tokens INTEGER DEFAULT 0,
    cached_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_at ON llm_usage (at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_actor ON llm_usage (actor, at);
"""


# 已有数据库上补加的列：(表, 列, 定义)
MIGRATIONS = [
    ("users", "role", "TEXT DEFAULT 'user'"),
]


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        for table, col, ddl in MIGRATIONS:
            if col not in {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
        if ADMIN_EMAILS:
            conn.execute(f"UPDATE users SET role = 'admin' WHERE email IN ({','.join('?' * len(ADMIN_EMAILS))})",
                         ADMIN_EMAILS)


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
