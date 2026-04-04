from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import Response
from fastapi.templating import Jinja2Templates
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel
from typing import Optional
import psycopg2, psycopg2.extras, json, os, uuid, urllib.parse, random, string
import httpx
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()
API_KEY = os.environ.get("API_KEY", "")
SELLER_PIN = os.environ.get("SELLER_PIN", "")
DATABASE_URL = os.environ.get("DATABASE_URL")
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
            "script-src 'self' 'unsafe-inline'; "
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

def get_db():
    return psycopg2.connect(DATABASE_URL)

def init_db():
    con = get_db()
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sketches (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            customer TEXT,
            data TEXT NOT NULL,
            thumbnail TEXT,
            share_code TEXT UNIQUE,
            created_at TEXT,
            updated_at TEXT
        )
    """)
    # Safe to re-run: adds share_code column to any pre-existing table
    cur.execute("""
        ALTER TABLE sketches ADD COLUMN IF NOT EXISTS share_code TEXT UNIQUE
    """)
    con.commit()
    cur.close()
    con.close()

init_db()

class AuthIn(BaseModel):
    pin: str

@app.post("/api/auth")
def auth_endpoint(body: AuthIn):
    """Verify SELLER_PIN and return the API key. Never expose the key in page HTML."""
    if not SELLER_PIN or body.pin != SELLER_PIN:
        raise HTTPException(status_code=401, detail="Feil PIN")
    return {"key": API_KEY}

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
    con = get_db()
    cur = con.cursor()
    cur.execute("SELECT id,name,customer,created_at,updated_at FROM sketches ORDER BY updated_at DESC")
    rows = cur.fetchall()
    cur.close()
    con.close()
    return [{"id": r[0], "name": r[1], "customer": r[2], "created_at": r[3], "updated_at": r[4]} for r in rows]

@app.get("/api/sketches/{sid}", dependencies=[Depends(require_api_key)])
def get_sketch(sid: str):
    con = get_db()
    cur = con.cursor()
    cur.execute("SELECT id,name,customer,data,thumbnail,created_at,updated_at FROM sketches WHERE id=%s", (sid,))
    row = cur.fetchone()
    cur.close()
    con.close()
    if not row:
        raise HTTPException(404, "Not found")
    return {"id": row[0], "name": row[1], "customer": row[2], "data": json.loads(row[3]), "thumbnail": row[4], "created_at": row[5], "updated_at": row[6]}

@app.post("/api/sketches", dependencies=[Depends(require_api_key)])
def create_sketch(s: SketchIn):
    sid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    con = get_db()
    cur = con.cursor()
    cur.execute(
        "INSERT INTO sketches (id,name,customer,data,thumbnail,share_code,created_at,updated_at) VALUES (%s,%s,%s,%s,%s,NULL,%s,%s)",
        (sid, s.name, s.customer, json.dumps(s.data), s.thumbnail, now, now)
    )
    con.commit()
    cur.close()
    con.close()
    return {"id": sid}

@app.put("/api/sketches/{sid}", dependencies=[Depends(require_api_key)])
def update_sketch(sid: str, s: SketchUpdate):
    con = get_db()
    cur = con.cursor()
    cur.execute("SELECT id,name,customer,data,thumbnail FROM sketches WHERE id=%s", (sid,))
    row = cur.fetchone()
    if not row:
        cur.close()
        con.close()
        raise HTTPException(404, "Not found")
    name = s.name or row[1]
    customer = s.customer if s.customer is not None else row[2]
    data = json.dumps(s.data) if s.data else row[3]
    thumb = s.thumbnail if s.thumbnail is not None else row[4]
    now = datetime.now(timezone.utc).isoformat()
    cur.execute(
        "UPDATE sketches SET name=%s,customer=%s,data=%s,thumbnail=%s,updated_at=%s WHERE id=%s",
        (name, customer, data, thumb, now, sid)
    )
    con.commit()
    cur.close()
    con.close()
    return {"ok": True}

@app.delete("/api/sketches/{sid}", dependencies=[Depends(require_api_key)])
def delete_sketch(sid: str):
    con = get_db()
    cur = con.cursor()
    cur.execute("DELETE FROM sketches WHERE id=%s", (sid,))
    con.commit()
    cur.close()
    con.close()
    return {"ok": True}

@app.post("/api/sketches/{sid}/share", dependencies=[Depends(require_api_key)])
def share_sketch(sid: str):
    """Generate (or return existing) a 6-char share code for a sketch."""
    con = get_db()
    cur = con.cursor()
    cur.execute("SELECT share_code FROM sketches WHERE id=%s", (sid,))
    row = cur.fetchone()
    if not row:
        cur.close()
        con.close()
        raise HTTPException(404, "Not found")
    if row[0]:
        cur.close()
        con.close()
        return {"code": row[0]}
    # Generate a unique 6-char uppercase alphanumeric code
    chars = string.ascii_uppercase + string.digits
    while True:
        code = ''.join(random.choices(chars, k=6))
        cur.execute("SELECT 1 FROM sketches WHERE share_code=%s", (code,))
        if not cur.fetchone():
            break
    cur.execute("UPDATE sketches SET share_code=%s WHERE id=%s", (code, sid))
    con.commit()
    cur.close()
    con.close()
    return {"code": code}

@app.get("/public/{code}")
def public_sketch(code: str):
    """Public read endpoint — no API key required. Used by share-code feature."""
    con = get_db()
    cur = con.cursor()
    cur.execute(
        "SELECT id,name,customer,data FROM sketches WHERE share_code=%s",
        (code.upper(),)
    )
    row = cur.fetchone()
    cur.close()
    con.close()
    if not row:
        raise HTTPException(404, "Not found")
    return {"id": row[0], "name": row[1], "customer": row[2], "data": json.loads(row[3])}

R2_BASE = "https://pub-27fd45166dba4be8a488b48df57742df.r2.dev"
_r2_cache: dict = {}
R2_CACHE_MAX = 200

@app.get("/r2/{filename}")
async def proxy_r2(filename: str, v: str = ""):
    # v is a cache-bust query param (e.g. ?v=2) — included in cache key so that
    # bumping v forces a fresh fetch from R2, bypassing both this cache and the CDN.
    cache_key = f"{filename}:{v}"
    # Assets are immutable for a given v= param — cache aggressively in the browser.
    # Bumping v= in the frontend forces a fresh fetch, bypassing both this cache and the browser.
    cache_headers = {"Cache-Control": "public, max-age=86400"}
    if cache_key in _r2_cache:
        data, content_type = _r2_cache[cache_key]
        return Response(content=data, media_type=content_type, headers=cache_headers)
    # Percent-encode the filename so non-ASCII chars (e.g. Norwegian ø in EnviroPac-Kjøler.glb)
    # survive the HTTP request to R2. urllib does not encode Unicode automatically.
    url = f"{R2_BASE}/{urllib.parse.quote(filename)}"
    try:
        # async httpx so a slow R2 fetch never blocks the FastAPI event loop for other requests
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            resp.raise_for_status()
            data = resp.content
            content_type = resp.headers.get("content-type", "application/octet-stream")
    except Exception:
        raise HTTPException(404, "Not found")
    if len(_r2_cache) < R2_CACHE_MAX:
        _r2_cache[cache_key] = (data, content_type)
    return Response(content=data, media_type=content_type, headers=cache_headers)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/{full_path:path}")
def serve_spa(request: Request, full_path: str = ""):
    # Only tell the frontend whether a PIN is required — never expose the key or PIN value.
    # Sellers authenticate via POST /api/auth (PIN → key) and store the key in sessionStorage.
    # Share-link visitors (?code=) never see a PIN prompt.
    is_share = bool(request.query_params.get("code"))
    pin_required = "true" if (bool(SELLER_PIN) and not is_share) else "false"
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"request": request, "pin_required": pin_required},
    )

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app:app", host="0.0.0.0", port=port)
