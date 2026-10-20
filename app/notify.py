"""发邮件：每周复盘、找回密码。"""
import smtplib
from email.message import EmailMessage
from email.utils import formataddr

from .config import SMTP_FROM, SMTP_HOST, SMTP_PASSWORD, SMTP_PORT, SMTP_USER


def enabled() -> bool:
    return bool(SMTP_HOST and SMTP_USER and SMTP_PASSWORD)


def send(to: str, subject: str, html: str, text: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("TrimWise 节流教练", SMTP_FROM or SMTP_USER))
    msg["To"] = to
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    # 腾讯云等云服务器封了 25 端口，默认走 465（SSL）；587 走 STARTTLS
    if SMTP_PORT == 465:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=30) as s:
            s.login(SMTP_USER, SMTP_PASSWORD)
            s.send_message(msg)
    else:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as s:
            s.starttls()
            s.login(SMTP_USER, SMTP_PASSWORD)
            s.send_message(msg)
