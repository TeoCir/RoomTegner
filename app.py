from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import Response
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel
from typing import Optional
import sqlite3, json, os, uuid, urllib.request, urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()
API_KEY = os.environ.get("API_KEY", "")
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI()

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob: https://pub-27fd45166dba4be8a488b48df57742df.r2.dev https://www.grontpunkt.no; "
            "connect-src 'self' blob:; "
            "worker-src blob:;"
        )
        return response

app.add_middleware(SecurityHeadersMiddleware)

templates = Jinja2Templates(directory=str(STATIC_DIR))

def require_api_key(request: Request):
    key = request.headers.get("X-API-Key", "")
    if not API_KEY or key != API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")

DB = os.environ.get("DB_PATH", str(BASE_DIR / "sketches.db"))

def init_db():
    db_dir = os.path.dirname(DB)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    con = sqlite3.connect(DB)
    con.execute("""
        CREATE TABLE IF NOT EXISTS sketches (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            customer TEXT,
            data TEXT NOT NULL,
            thumbnail TEXT,
            created_at TEXT,
            updated_at TEXT
        )
    """)
    con.commit(); con.close()

init_db()

class SketchIn(BaseModel):
    name: str
    customer: Optional[str] = ""
    data: dict
    thumbnail: Optional[str] = ""

class SketchUpdate(BaseModel):
    name: Optional[str] = None
    customer: Optional[str] = None
    data: Optional[dict] = None
    thumbnail: Optional[str] = None

@app.get("/api/sketches", dependencies=[Depends(require_api_key)])
def list_sketches():
    con = sqlite3.connect(DB)
    rows = con.execute("SELECT id,name,customer,created_at,updated_at FROM sketches ORDER BY updated_at DESC").fetchall()
    con.close()
    return [{"id":r[0],"name":r[1],"customer":r[2],"created_at":r[3],"updated_at":r[4]} for r in rows]

@app.get("/api/sketches/{sid}", dependencies=[Depends(require_api_key)])
def get_sketch(sid: str):
    con = sqlite3.connect(DB)
    row = con.execute("SELECT * FROM sketches WHERE id=?", (sid,)).fetchone()
    con.close()
    if not row: raise HTTPException(404, "Not found")
    return {"id":row[0],"name":row[1],"customer":row[2],"data":json.loads(row[3]),"thumbnail":row[4],"created_at":row[5],"updated_at":row[6]}

@app.post("/api/sketches", dependencies=[Depends(require_api_key)])
def create_sketch(s: SketchIn):
    sid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    con = sqlite3.connect(DB)
    con.execute("INSERT INTO sketches VALUES (?,?,?,?,?,?,?)",
        (sid, s.name, s.customer, json.dumps(s.data), s.thumbnail, now, now))
    con.commit(); con.close()
    return {"id": sid}

@app.put("/api/sketches/{sid}", dependencies=[Depends(require_api_key)])
def update_sketch(sid: str, s: SketchUpdate):
    con = sqlite3.connect(DB)
    row = con.execute("SELECT * FROM sketches WHERE id=?", (sid,)).fetchone()
    if not row: raise HTTPException(404, "Not found")
    name = s.name or row[1]
    customer = s.customer if s.customer is not None else row[2]
    data = json.dumps(s.data) if s.data else row[3]
    thumb = s.thumbnail if s.thumbnail is not None else row[4]
    now = datetime.now(timezone.utc).isoformat()
    con.execute("UPDATE sketches SET name=?,customer=?,data=?,thumbnail=?,updated_at=? WHERE id=?",
        (name, customer, data, thumb, now, sid))
    con.commit(); con.close()
    return {"ok": True}

@app.delete("/api/sketches/{sid}", dependencies=[Depends(require_api_key)])
def delete_sketch(sid: str):
    con = sqlite3.connect(DB)
    con.execute("DELETE FROM sketches WHERE id=?", (sid,))
    con.commit(); con.close()
    return {"ok": True}

R2_BASE = "https://pub-27fd45166dba4be8a488b48df57742df.r2.dev"
_r2_cache: dict = {}
R2_CACHE_MAX = 200

@app.get("/r2/{filename}")
def proxy_r2(filename: str, v: str = ""):
    # v is a cache-bust query param (e.g. ?v=2) — included in cache key so that
    # bumping v forces a fresh fetch from R2, bypassing both this cache and the CDN.
    cache_key = f"{filename}:{v}"
    if cache_key in _r2_cache:
        data, content_type = _r2_cache[cache_key]
        return Response(content=data, media_type=content_type)
    # Percent-encode the filename so non-ASCII chars (e.g. Norwegian ø in EnviroPac-Kjøler.glb)
    # survive the HTTP request to R2. urllib does not encode Unicode automatically.
    url = f"{R2_BASE}/{urllib.parse.quote(filename)}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
            content_type = resp.headers.get("Content-Type", "application/octet-stream")
    except Exception:
        raise HTTPException(404, "Not found")
    if len(_r2_cache) < R2_CACHE_MAX:
        _r2_cache[cache_key] = (data, content_type)
    return Response(content=data, media_type=content_type)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/{full_path:path}")
def serve_spa(request: Request, full_path: str = ""):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"request": request, "api_key": API_KEY},
    )

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app:app", host="0.0.0.0", port=port)
