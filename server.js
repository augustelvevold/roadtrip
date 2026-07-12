const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { mountMcp } = require("./mcp");

const app = express();
const PORT = process.env.PORT || 3000;
const PIN = process.env.PIN || "endre-meg";
const API_TOKEN = process.env.API_TOKEN || ""; // egen token for skript/Claude (adskilt fra innloggings-PIN)
const MCP_PATH = process.env.MCP_PATH || ""; // hemmelig sti for MCP-connector, f.eks. "/mcp/<lang-tilfeldig>"
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const CONTENT_FILE = path.join(DATA_DIR, "content.json");
const DEFAULT_CONTENT = path.join(__dirname, "default-content.json");
const SECRET_FILE = path.join(DATA_DIR, "secret");
const SESSION_DAYS = 120;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Session-secret: fra env, ellers generert én gang og lagret i data/
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  if (fs.existsSync(SECRET_FILE)) {
    SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim();
  } else {
    SECRET = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(SECRET_FILE, SECRET);
  }
}

// ---------- innhold (hele reiseplanen) ----------
if (!fs.existsSync(CONTENT_FILE)) {
  fs.copyFileSync(DEFAULT_CONTENT, CONTENT_FILE);
}
let content = JSON.parse(fs.readFileSync(CONTENT_FILE, "utf8"));
if (typeof content.rev !== "number") content.rev = 1;

let saveTimer = null;
function saveContent() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = CONTENT_FILE + ".tmp";
    fs.writeFile(tmp, JSON.stringify(content, null, 2), (err) => {
      if (!err) fs.rename(tmp, CONTENT_FILE, () => {});
    });
  }, 300);
}

// Delt logikk brukt av både HTTP-API-et og MCP-verktøyene ------
function applyCheck(id, value) {
  const searchBlocks = (blocks) => {
    for (const b of blocks || []) {
      if (b.type !== "checklist") continue;
      const item = (b.items || []).find((it) => it.id === id);
      if (item) { item.done = !!value; return true; }
    }
    return false;
  };
  for (const sec of content.sections || []) if (searchBlocks(sec.blocks)) { saveContent(); return true; }
  for (const d of content.days || []) if (searchBlocks(d.blocks)) { saveContent(); return true; }
  return false;
}
function applyRowCheck(dayId, index, value) {
  const day = (content.days || []).find((d) => d.id === dayId);
  if (!day || !Array.isArray(day.rows) || !day.rows[index]) return false;
  day.rows[index].done = !!value;
  saveContent();
  return true;
}
function applyNote(id, text) {
  content.notes = content.notes || {};
  const t = String(text || "").slice(0, 10000);
  if (t) content.notes[id] = t;
  else delete content.notes[id];
  saveContent();
}

// ---------- enkel sesjon (signert cookie) + Bearer-PIN for API/skript ----------
function sign(ts) {
  return crypto.createHmac("sha256", SECRET).update(String(ts)).digest("hex");
}
function makeToken() {
  const ts = Date.now();
  return ts + "." + sign(ts);
}
function validToken(token) {
  if (!token) return false;
  const [ts, sig] = token.split(".");
  if (!ts || !sig) return false;
  const expected = sign(ts);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Date.now() - Number(ts) < SESSION_DAYS * 24 * 3600 * 1000;
}
function getCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function safeEq(a, b) {
  a = String(a || "");
  b = String(b || "");
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function pinOk(pin) {
  return safeEq(pin, PIN);
}
function bearerOk(token) {
  token = String(token || "");
  if (!token) return false;
  if (pinOk(token)) return true;                       // PIN funker fortsatt som Bearer
  if (API_TOKEN && safeEq(token, API_TOKEN)) return true; // egen skript-token
  return false;
}
function authed(req) {
  if (validToken(getCookie(req, "rt"))) return true;
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ") && bearerOk(h.slice(7).trim())) return true; // for curl/skript/Claude
  return false;
}

const LOGIN_HTML = `<!DOCTYPE html><html lang="no"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Roadtrip 2026 – logg inn</title>
<style>body{font-family:-apple-system,sans-serif;background:#f6f4ef;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border:1px solid #e5e1d8;border-radius:16px;padding:36px 32px;text-align:center;max-width:320px;width:90%}
h1{font-size:1.3rem;color:#1f6f5c;margin:0 0 4px}p{color:#7a766c;font-size:.9rem;margin:0 0 18px}
input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #e5e1d8;border-radius:10px;font-size:1.1rem;text-align:center;margin-bottom:12px}
button{width:100%;padding:12px;background:#1f6f5c;color:#fff;border:none;border-radius:10px;font-size:1rem;cursor:pointer}
.err{color:#c2571f;font-size:.85rem;min-height:1.2em;margin-top:10px}</style></head>
<body><div class="box"><h1>🚗 Roadtrip 2026</h1><p>Skriv inn PIN-koden</p>
<form id="f"><input id="pin" type="password" autocomplete="current-password" autofocus>
<button>Logg inn</button><div class="err" id="err"></div></form>
<script>
document.getElementById('f').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const r = await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({pin:document.getElementById('pin').value})});
  if(r.ok){ location.href='/'; } else { document.getElementById('err').textContent='Feil PIN, prøv igjen'; }
});
</script></div></body></html>`;

app.post("/login", express.json(), (req, res) => {
  if (!pinOk(req.body && req.body.pin)) {
    return setTimeout(() => res.sendStatus(401), 800); // brems gjetting
  }
  res.setHeader("Set-Cookie",
    `rt=${encodeURIComponent(makeToken())}; Path=/; Max-Age=${SESSION_DAYS * 24 * 3600}; HttpOnly; SameSite=Lax`);
  res.sendStatus(204);
});

// MCP-connector: mountes FØR PIN-vakten. Den hemmelige stien (MCP_PATH)
// er selve tilgangskontrollen. Uten MCP_PATH satt er endepunktet av.
if (MCP_PATH) {
  mountMcp(app, {
    getContent: () => content,
    replaceContent: (doc) => {
      doc.rev = content.rev + 1;
      content = doc;
      saveContent();
      return content.rev;
    },
    applyCheck,
    applyNote,
  }, MCP_PATH);
  console.log(`MCP-connector aktiv på ${MCP_PATH}`);
}

// Alt under her krever gyldig sesjon eller Bearer-PIN
app.use((req, res, next) => {
  if (authed(req)) return next();
  if (req.path.startsWith("/api/")) return res.sendStatus(401);
  res.status(401).type("html").send(LOGIN_HTML);
});

// ---- Innholds-API ----
// Hele planen som JSON (også for skript/Claude: curl -H "Authorization: Bearer <PIN>")
app.get("/api/content", (_req, res) => res.json(content));

// Erstatt hele planen. Klienten sender dokumentet med den rev den bygde på;
// ved konflikt (noen andre lagret i mellomtiden) returneres 409.
app.put("/api/content", express.json({ limit: "5mb" }), (req, res) => {
  const doc = req.body;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.days)) return res.sendStatus(400);
  if (typeof doc.rev !== "number" || doc.rev !== content.rev) {
    return res.status(409).json({ error: "conflict", rev: content.rev });
  }
  doc.rev = content.rev + 1;
  content = doc;
  saveContent();
  res.json({ ok: true, rev: content.rev });
});

// Lettvekts-endepunkter for visningsmodus (ingen rev-konflikt)
app.post("/api/check", express.json(), (req, res) => {
  const { id, value } = req.body || {};
  if (typeof id !== "string") return res.sendStatus(400);
  if (applyCheck(id, value)) return res.json({ ok: true });
  res.sendStatus(404);
});

app.post("/api/rowcheck", express.json(), (req, res) => {
  const { day, index, value } = req.body || {};
  if (typeof day !== "string" || typeof index !== "number") return res.sendStatus(400);
  if (applyRowCheck(day, index, value)) return res.json({ ok: true });
  res.sendStatus(404);
});

app.post("/api/note", express.json({ limit: "200kb" }), (req, res) => {
  const { id, text } = req.body || {};
  if (typeof id !== "string" || id.length > 100) return res.sendStatus(400);
  applyNote(id, text);
  res.json({ ok: true });
});

// ---- Bildeopplasting ----
// POST /api/upload?name=bilde.jpg  med rå bildedata som body
app.post("/api/upload", express.raw({ type: () => true, limit: "25mb" }), (req, res) => {
  const orig = String(req.query.name || "bilde");
  const safe = orig.toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(-80);
  const ext = path.extname(safe) || ".jpg";
  if (![".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"].includes(ext)) return res.sendStatus(415);
  if (!req.body || !req.body.length) return res.sendStatus(400);
  const file = Date.now() + "-" + crypto.randomBytes(3).toString("hex") + ext;
  fs.writeFile(path.join(UPLOAD_DIR, file), req.body, (err) => {
    if (err) return res.sendStatus(500);
    res.json({ ok: true, url: "/uploads/" + file });
  });
});

app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "30d" }));
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`Roadtrip 2026 kjører på port ${PORT}`));
