"""服务器存的东西（没有任何明文的流水、汇总或复盘）：
- 账号（邮箱 + 由密码在浏览器里派生出的登录口令的哈希，服务器拿不到密码本身）、复盘周期和提醒邮件开关
- 云同步密文（流水、计划、复盘都在浏览器里加密，密钥不离开浏览器，服务器解不开）
- AI 调用记账（次数和成本，用于预算和限流；不记发送的内容）
"""
import sqlite3
from contextlib import contextmanager

from .config import ADMIN_EMAILS, DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    auth_hash TEXT NOT NULL,
    weekly_email INTEGER DEFAULT 1,    -- 复盘邮件开关（最早只有每周复盘，列名沿用）
    cadence TEXT DEFAULT 'month',      -- 复盘周期：week / month / quarter
    reminded_week TEXT DEFAULT '',     -- 最近一次发“账单还没导入”提醒的期，避免重复发
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
-- 以前存在服务器上的复盘，只用于迁移：用户登录时浏览器取走、存进加密数据后删掉。新的复盘不再存这里
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
    ("users", "cadence", "TEXT DEFAULT 'month'"),
]


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        conn.execute("DROP TABLE IF EXISTS snapshots")  # 以前定时复盘用的明文汇总快照，已不再需要
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
