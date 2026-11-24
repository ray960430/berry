import os
import re
import secrets
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, render_template, request, session

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "change-this-secret-key-before-public-deployment")
BASE_DIR = Path(__file__).resolve().parent
# Render's filesystem is ephemeral unless a persistent disk is mounted. Set DATABASE_PATH
# to a path on that disk to retain bookings and dashboard settings across deploys.
DB_PATH = Path(os.environ.get("DATABASE_PATH", str(BASE_DIR / "farm.db")))
PIN = os.environ.get("ADMIN_PIN", "1688")  # Demo default; set ADMIN_PIN in production.
SLOTS = ["08:30", "10:30", "13:00", "15:00"]
TAIPEI = ZoneInfo("Asia/Taipei")
AREAS = ["香水高架A區", "香水高架B區", "美姬溫室區", "豐香特區", "戀香高架區"]
STATUS = {
    "green": {"label": "綠燈・大果充沛", "description": "全園成熟紅果量充足，歡迎自由採摘"},
    "yellow": {"label": "黃燈・採量受限", "description": "以中小型果為主，優先接待已預約顧客"},
    "red": {"label": "紅燈・養果休園", "description": "花期轉換／雨天養果中，請勿白跑一趟"},
}


def taipei_now():
    return datetime.now(TAIPEI)


def taipei_today():
    return taipei_now().date()


def connect_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout = 15000")
    return db


def init_db():
    with connect_db() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS dashboard (
            id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL,
            price INTEGER NOT NULL, areas TEXT NOT NULL, updated_at TEXT NOT NULL)""")
        db.execute("""CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
            visit_date TEXT NOT NULL, slot TEXT NOT NULL, name TEXT NOT NULL,
            phone TEXT NOT NULL, people INTEGER NOT NULL, cars INTEGER NOT NULL,
            created_at TEXT NOT NULL)""")
        db.execute("CREATE INDEX IF NOT EXISTS idx_bookings_date_slot ON bookings(visit_date, slot)")
        if not db.execute("SELECT 1 FROM dashboard WHERE id=1").fetchone():
            db.execute("INSERT INTO dashboard VALUES (1, ?, ?, ?, ?)",
                       ("green", 650, ",".join(AREAS[:2] + [AREAS[2]]), taipei_now().isoformat(timespec="minutes")))


init_db()


def dashboard_data():
    with connect_db() as db:
        row = db.execute("SELECT * FROM dashboard WHERE id=1").fetchone()
    return {"status": row["status"], "status_info": STATUS[row["status"]], "price": row["price"],
            "areas": row["areas"].split(",") if row["areas"] else [], "updated_at": row["updated_at"].replace("T", " ")}


def availability(day):
    with connect_db() as db:
        rows = db.execute("SELECT slot, COUNT(*) count FROM bookings WHERE visit_date=? GROUP BY slot", (day,)).fetchall()
    counts = {r["slot"]: r["count"] for r in rows}
    return [{"slot": slot, "booked": counts.get(slot, 0), "remaining": max(0, 15-counts.get(slot, 0))} for slot in SLOTS]


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/admin")
def admin():
    return render_template("admin.html")


@app.get("/api/dashboard")
def api_dashboard():
    return jsonify(dashboard_data())


@app.get("/api/availability")
def api_availability():
    day = request.args.get("date", "")
    try:
        parsed = date.fromisoformat(day)
    except ValueError:
        return jsonify(error="日期格式不正確。"), 400
    if parsed < taipei_today() or parsed > taipei_today() + timedelta(days=14):
        return jsonify(error="請選擇今日起 14 天內的日期。"), 400
    return jsonify(date=day, slots=availability(day))


@app.post("/api/bookings")
def create_booking():
    data = request.get_json(silent=True) or {}
    try:
        visit_date = date.fromisoformat(str(data.get("date", "")))
        people, cars = int(data.get("people", 0)), int(data.get("cars", 0))
    except (ValueError, TypeError):
        return jsonify(error="請確認日期、人數與車輛數。"), 400
    slot, name, phone = str(data.get("slot", "")), str(data.get("name", "")).strip(), str(data.get("phone", "")).strip()
    if visit_date < taipei_today() or visit_date > taipei_today() + timedelta(days=14):
        return jsonify(error="預約日期需在今日起 14 天內。"), 400
    if slot not in SLOTS or not name or len(name) > 40:
        return jsonify(error="請填寫姓名並選擇有效梯次。"), 400
    if not re.fullmatch(r"09\d{8}", phone):
        return jsonify(error="請輸入 09 開頭的 10 碼手機號碼。"), 400
    if not 1 <= people <= 30 or not 1 <= cars <= 15:
        return jsonify(error="到訪人數需為 1–30 人，車輛數需為 1–15 輛。"), 400
    code = "DH-" + str(secrets.randbelow(9000) + 1000)
    try:
        with connect_db() as db:
            db.execute("BEGIN IMMEDIATE")
            count = db.execute("SELECT COUNT(*) FROM bookings WHERE visit_date=? AND slot=?", (visit_date.isoformat(), slot)).fetchone()[0]
            if count >= 15:
                db.rollback()
                return jsonify(error="此梯次已額滿，請選擇其他時段。"), 409
            # Keep each code unique even if a random value collides.
            while db.execute("SELECT 1 FROM bookings WHERE code=?", (code,)).fetchone():
                code = "DH-" + str(secrets.randbelow(9000) + 1000)
            db.execute("INSERT INTO bookings(code,visit_date,slot,name,phone,people,cars,created_at) VALUES(?,?,?,?,?,?,?,?)",
                       (code, visit_date.isoformat(), slot, name, phone, people, cars, taipei_now().isoformat(timespec="minutes")))
    except sqlite3.OperationalError:
        return jsonify(error="系統忙碌中，請稍後再試。"), 503
    return jsonify(message="預約成功，請保留入園憑證。", code=code, date=visit_date.isoformat(), slot=slot), 201


def authorized():
    return session.get("admin") is True


@app.post("/api/admin/login")
def admin_login():
    data = request.get_json(silent=True) or {}
    if secrets.compare_digest(str(data.get("pin", "")), PIN):
        session["admin"] = True
        session.permanent = True
        return jsonify(ok=True)
    return jsonify(error="PIN 碼不正確。"), 401


@app.post("/api/admin/logout")
def admin_logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/admin/today")
def admin_today():
    if not authorized():
        return jsonify(error="請先輸入管理 PIN。"), 401
    today = taipei_today().isoformat()
    with connect_db() as db:
        rows = db.execute("SELECT code,slot,name,phone,people,cars FROM bookings WHERE visit_date=? ORDER BY slot,created_at", (today,)).fetchall()
    return jsonify(date=today, bookings=[dict(r) for r in rows], counts={slot: sum(1 for r in rows if r["slot"] == slot) for slot in SLOTS})


@app.post("/api/admin/dashboard")
def update_dashboard():
    if not authorized():
        return jsonify(error="登入逾期，請重新輸入 PIN。"), 401
    data = request.get_json(silent=True) or {}
    status, areas = data.get("status"), data.get("areas")
    try:
        price = int(data.get("price"))
    except (ValueError, TypeError):
        return jsonify(error="請輸入有效價格。"), 400
    if status not in STATUS or not 1 <= price <= 10000:
        return jsonify(error="燈號或價格無效。"), 400
    if not isinstance(areas, list) or any(a not in AREAS for a in areas) or len(set(areas)) != len(areas):
        return jsonify(error="開放區域資料無效。"), 400
    updated = taipei_now().isoformat(timespec="minutes")
    with connect_db() as db:
        db.execute("UPDATE dashboard SET status=?,price=?,areas=?,updated_at=? WHERE id=1", (status, price, ",".join(areas), updated))
    return jsonify(ok=True, updated_at=updated.replace("T", " "))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
