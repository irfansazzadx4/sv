/**
 * NID Service Bot - WhatsApp Cloud API Version
 * Fast MongoDB backup, recharge/deduct, font embed, 10min file delete
 */

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const FormData = require("form-data");

// ========== CONFIG ==========
const CONFIG = {
  PORT: process.env.PORT || 3000,
  ADMIN_PASS: process.env.ADMIN_PASS || "admin123",

  WA_TOKEN: process.env.WHATSAPP_TOKEN,
  WA_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  WA_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || "myVerifyToken123",
  WA_API_VERSION: "v21.0",

  API_EXTRACT_URL: "https://auto.onlinebd.top/Signtonid_api_one.php",
  API_GENERATE_URL: "https://auto.onlinebd.top/bot/nid-bn.php",
  PDF_API_URL: process.env.PDF_API_URL,
  PDF_API_SECRET: process.env.PDF_API_SECRET,

  BASE_URL: process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || "https://nidservicebd.onrender.com",
  STORAGE_DIR: path.join(__dirname, "storage"),
  DATA_DIR: path.join(__dirname, "data"),

  // MongoDB Atlas (fast backup)
  MONGO_URI: process.env.MONGO_URI, // mongodb+srv://user:pass@cluster.mongodb.net/nidbot
};

if (!fs.existsSync(CONFIG.STORAGE_DIR)) fs.mkdirSync(CONFIG.STORAGE_DIR, { recursive: true });
if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

const USERS_FILE    = path.join(CONFIG.DATA_DIR, "users.json");
const STATS_FILE    = path.join(CONFIG.DATA_DIR, "stats.json");
const SETTINGS_FILE = path.join(CONFIG.DATA_DIR, "settings.json");

// ========== HELPERS ==========
const loadJSON = (f, def) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; }
};
const saveJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

const getUsers    = () => loadJSON(USERS_FILE,    []);
const saveUsers   = (u) => saveJSON(USERS_FILE,   u);
const getStats    = () => loadJSON(STATS_FILE,    {});
const saveStats   = (s) => saveJSON(STATS_FILE,   s);
const getSettings = () => loadJSON(SETTINGS_FILE, { cardPrice: 0 });
const saveSettings= (s) => saveJSON(SETTINGS_FILE, s);

function normalizeNumber(num) {
  let n = String(num).replace(/\D/g, "");
  if (n.startsWith("0")) n = "880" + n.slice(1);
  if (!n.startsWith("880") && n.length === 10) n = "880" + n;
  return n;
}

function isAllowed(number) {
  const users = getUsers();
  if (users.length === 0) return false;
  const u = users.find(x => normalizeNumber(x.number) === normalizeNumber(number));
  return u && u.active !== false;
}

function getUserBalance(number) {
  const u = getUsers().find(x => normalizeNumber(x.number) === normalizeNumber(number));
  return u ? (u.balance || 0) : 0;
}

function deductBalance(number) {
  const users = getUsers();
  const price = getSettings().cardPrice || 0;
  const idx = users.findIndex(x => normalizeNumber(x.number) === normalizeNumber(number));
  if (idx === -1) return false;
  if ((users[idx].balance || 0) < price) return false;
  users[idx].balance = (users[idx].balance || 0) - price;
  saveUsers(users);
  return true;
}

function recordStat(number) {
  const stats = getStats();
  const key = normalizeNumber(number);
  if (!stats[key]) stats[key] = { count: 0, lastUsed: null };
  stats[key].count++;
  stats[key].lastUsed = new Date().toISOString();
  saveStats(stats);
}

// ========== MONGODB BACKUP (fast, instant) ==========
// MongoDB REST API (Data API) ব্যবহার করা হচ্ছে — npm package দরকার নেই
// Render এ MONGO_URI env variable সেট করুন
// Format: mongodb+srv://user:pass@cluster.mongodb.net/nidbot

let mongoClient = null;

async function getMongoClient() {
  if (mongoClient) return mongoClient;
  if (!CONFIG.MONGO_URI) return null;
  try {
    const { MongoClient } = require("mongodb");
    mongoClient = new MongoClient(CONFIG.MONGO_URI);
    await mongoClient.connect();
    console.log("✅ MongoDB connected");
    return mongoClient;
  } catch (e) {
    console.error("MongoDB connect error:", e.message);
    return null;
  }
}

async function saveToMongo(collection, key, data) {
  try {
    const client = await getMongoClient();
    if (!client) return;
    const db = client.db("nidbot");
    await db.collection(collection).replaceOne({ _id: key }, { _id: key, data }, { upsert: true });
  } catch (e) {
    console.error("MongoDB save error:", e.message);
  }
}

async function loadFromMongo(collection, key) {
  try {
    const client = await getMongoClient();
    if (!client) return null;
    const db = client.db("nidbot");
    const doc = await db.collection(collection).findOne({ _id: key });
    return doc ? doc.data : null;
  } catch (e) {
    console.error("MongoDB load error:", e.message);
    return null;
  }
}

// ✅ Fast backup — সাথে সাথে MongoDB এ save হয়
async function backupData() {
  try {
    await Promise.all([
      saveToMongo("backups", "users",    getUsers()),
      saveToMongo("backups", "stats",    getStats()),
      saveToMongo("backups", "settings", getSettings()),
    ]);
    console.log("✅ MongoDB backup done");
  } catch (e) {
    console.error("Backup error:", e.message);
  }
}

// ✅ Restore from MongoDB on startup
async function restoreData() {
  try {
    const [users, stats, settings] = await Promise.all([
      loadFromMongo("backups", "users"),
      loadFromMongo("backups", "stats"),
      loadFromMongo("backups", "settings"),
    ]);
    if (users    && !fs.existsSync(USERS_FILE))    saveUsers(users);
    if (stats    && !fs.existsSync(STATS_FILE))    saveStats(stats);
    if (settings && !fs.existsSync(SETTINGS_FILE)) saveSettings(settings);
    if (users || stats || settings) console.log("✅ Data restored from MongoDB");
    else console.log("ℹ️ No MongoDB data found — starting fresh");
  } catch (e) {
    console.error("Restore error:", e.message);
  }
}

// ========== WHATSAPP CLOUD API ==========
const WA_BASE    = `https://graph.facebook.com/${CONFIG.WA_API_VERSION}/${CONFIG.WA_PHONE_ID}`;
const WA_HEADERS = { Authorization: `Bearer ${CONFIG.WA_TOKEN}`, "Content-Type": "application/json" };

async function sendText(to, body) {
  try {
    await axios.post(`${WA_BASE}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body }
    }, { headers: WA_HEADERS });
  } catch (e) { console.error("sendText error:", e.response?.data || e.message); }
}

async function markRead(messageId) {
  try {
    await axios.post(`${WA_BASE}/messages`, {
      messaging_product: "whatsapp", status: "read", message_id: messageId
    }, { headers: WA_HEADERS });
  } catch {}
}

async function uploadMedia(buffer, filename, mimetype) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mimetype });
  form.append("type", mimetype);
  const res = await axios.post(`${WA_BASE}/media`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${CONFIG.WA_TOKEN}` },
    maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  return res.data.id;
}

async function sendDocument(to, mediaId, filename, caption) {
  try {
    await axios.post(`${WA_BASE}/messages`, {
      messaging_product: "whatsapp", to, type: "document",
      document: { id: mediaId, filename, caption }
    }, { headers: WA_HEADERS });
  } catch (e) { console.error("sendDocument error:", e.response?.data || e.message); }
}

async function downloadMedia(mediaId) {
  const meta = await axios.get(`https://graph.facebook.com/${CONFIG.WA_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` }
  });
  const fileRes = await axios.get(meta.data.url, {
    headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` },
    responseType: "arraybuffer"
  });
  return { buffer: Buffer.from(fileRes.data), mimetype: meta.data.mime_type };
}

// ========== NID EXTRACTION ==========
function mapAPIData(d) {
  return {
    nid:        d.nationalId || d.nid || d.NID || d.national_id || "",
    pin:        d.pin || "",
    pin_status: "disabled",
    nameBangla: d.nameBangla || d.name_bn || "",
    nameEnglish:d.nameEnglish || d.name_en || "",
    dob:        d.dateOfBirth || d.dob || "",
    nameFather: d.fatherName || d.father_name || "",
    nameMother: d.motherName || d.mother_name || "",
    fulladdress:d.address || d.permanent_address || "",
    birthPlace: d.birthPlace || d.birth_place || "",
    bloodGroup: d.bloodGroup || d.blood_group || "",
    issueDate:  d.dateOfToday || "",
    imageUrl12: d.userIMG || d.imageUrl12 || "",
    imageUrl22: d.signIMG || d.imageUrl22 || "",
  };
}

async function extractNIDFromPDF(buffer) {
  const form = new FormData();
  form.append("pdf", buffer, { filename: "nid.pdf", contentType: "application/pdf" });
  try {
    const res = await axios.post(CONFIG.API_EXTRACT_URL, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 60000,
    });
    console.log("📦 FULL API Response:", JSON.stringify(res.data, null, 2));
    const raw = (res.data?.data) ? res.data.data : res.data;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return mapAPIData(parsed);
  } catch (err) {
    console.error("❌ Extract API failed:", err.response?.status, JSON.stringify(err.response?.data), err.message);
    throw new Error("Extract API: " + (err.response?.data?.message || err.message));
  }
}

// ========== PATH FIX ==========
function fixRelativePaths(html) {
  const BASE = "https://auto.onlinebd.top/bot";
  const patterns = [
    [/(src\s*=\s*["'])(assets\/)/gi,    `$1${BASE}/assets/`],
    [/(href\s*=\s*["'])(assets\/)/gi,   `$1${BASE}/assets/`],
    [/(src\s*=\s*["'])(photo\/)/gi,     `$1${BASE}/photo/`],
    [/(src\s*=\s*)(assets\/)/gi,        `$1${BASE}/assets/`],
    [/(href\s*=\s*)(assets\/)/gi,       `$1${BASE}/assets/`],
    [/(src\s*=\s*)(photo\/)/gi,         `$1${BASE}/photo/`],
    [/(url\s*\(\s*["']?)(assets\/)/gi,  `$1${BASE}/assets/`],
    [/(url\s*\(\s*["']?)(photo\/)/gi,   `$1${BASE}/photo/`],
    [/(url\s*\(\s*["']?)(\/fonts\/)/gi, `$1https://auto.onlinebd.top/fonts/`],
  ];
  for (const [r, rep] of patterns) html = html.replace(r, rep);
  const doubled = new RegExp(BASE.replace(/\./g, '\\.') + '/' + BASE.replace(/\./g, '\\.').replace('https://', ''), 'g');
  html = html.replace(doubled, BASE);
  return html;
}

// ========== FONT EMBED ==========
async function embedFontsInHTML(html) {
  const fonts = [
    { url: "https://auto.onlinebd.top/fonts/Bangla.ttf", family: "Bangla", weight: "normal" },
    { url: "https://auto.onlinebd.top/fonts/Arial.ttf",  family: "Arial",  weight: "normal" },
  ];
  let fontCSS = "";
  for (const font of fonts) {
    try {
      const res = await axios.get(font.url, { responseType: "arraybuffer", timeout: 15000 });
      const b64 = Buffer.from(res.data).toString("base64");
      fontCSS += `\n@font-face{font-family:'${font.family}';src:url('data:font/truetype;base64,${b64}') format('truetype');font-weight:${font.weight};font-style:normal;}`;
      console.log(`✅ Font embedded: ${font.family} — ${Math.round(res.data.byteLength / 1024)}KB`);
    } catch (e) {
      console.log(`⚠️ Font skip: ${font.url} — ${e.message}`);
    }
  }
  const overrideCSS = `${fontCSS}\n*{font-family:Bangla,Arial,sans-serif!important;}.bn{font-family:Bangla,sans-serif!important;}.sans{font-family:Arial,sans-serif!important;}`;
  if (html.includes("</head>")) {
    html = html.replace("</head>", `<style id="embedded-fonts">${overrideCSS}</style>\n</head>`);
  } else {
    html = `<style id="embedded-fonts">${overrideCSS}</style>\n` + html;
  }
  return html;
}

async function fetchHTMLFromData(data) {
  const params = new URLSearchParams();
  Object.entries(data).forEach(([k, v]) => params.append(k, v || ""));
  const res = await axios.post(CONFIG.API_GENERATE_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 60000,
  });
  return fixRelativePaths(res.data);
}

async function buildAndSaveHTML(data) {
  const html = await fetchHTMLFromData(data);
  const filename = `nid_${data.nid || Date.now()}_${Date.now()}.html`;
  const filepath = path.join(CONFIG.STORAGE_DIR, filename);
  fs.writeFileSync(filepath, html);

  // ✅ 10 মিনিট পর file delete
  setTimeout(() => {
    fs.unlink(filepath, (err) => {
      if (!err) console.log(`🗑️ Deleted: ${filename}`);
    });
  }, 10 * 60 * 1000);

  return `${CONFIG.BASE_URL}/storage/${filename}`;
}

async function generatePDFFromMapped(data) {
  let html = await fetchHTMLFromData(data);
  html = await embedFontsInHTML(html);
  console.log(`✅ Fonts embedded, HTML: ${html.length} chars`);
  const res = await axios.post(`${CONFIG.PDF_API_URL}/pdf`, {
    secret: CONFIG.PDF_API_SECRET, html
  }, { timeout: 90000 });
  const base64 = res.data.pdf || res.data.base64 || res.data;
  return Buffer.from(base64, "base64");
}

// ========== MESSAGE HANDLER ==========
async function handleIncoming(msg, contact) {
  const from  = msg.from;
  const msgId = msg.id;
  markRead(msgId);

  if (msg.type === "text") {
    const text = msg.text.body.trim().toLowerCase();
    if (text === ".ping" || text === "ping") return sendText(from, "🟢 Pong! Bot সচল আছে।");
    if (text === ".status" || text === "status") {
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");
      const bal   = getUserBalance(from);
      const price = getSettings().cardPrice || 0;
      return sendText(from, `✅ আপনি authorized।\n💰 Balance: ${bal} টাকা\n💳 Card Price: ${price} টাকা`);
    }
    return sendText(from, "📄 NID Card বানাতে আপনার NID PDF টা এই chat এ পাঠান।\n\nCommands:\n.ping - bot check\n.status - balance check");
  }

  if (msg.type === "document") {
    const doc = msg.document;
    if (!doc.mime_type?.includes("pdf")) return sendText(from, "❌ শুধু PDF file পাঠাতে হবে।");
    if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");

    const price = getSettings().cardPrice || 0;
    if (price > 0 && getUserBalance(from) < price) {
      return sendText(from, `❌ Balance কম! কমপক্ষে ${price} টাকা থাকতে হবে।\nCurrent balance: ${getUserBalance(from)} টাকা`);
    }

    await sendText(from, "⏳ আপনার NID PDF process হচ্ছে... একটু wait করুন।");

    try {
      const { buffer: pdfBuf } = await downloadMedia(doc.id);
      const data = await extractNIDFromPDF(pdfBuf);
      if (!data.nid) throw new Error("NID extract করতে পারিনি");

      if (price > 0) deductBalance(from);

      const [htmlUrl, pdfBuffer] = await Promise.all([
        buildAndSaveHTML(data),
        generatePDFFromMapped(data),
      ]);

      recordStat(from);
      backupData(); // ✅ instant MongoDB backup

      const filename = `nid-${data.nid}.pdf`;
      const caption  = `✅ আপনার NID Card তৈরি হয়েছে!\n\n👤 নাম: ${data.nameBangla || data.nameEnglish}\n🆔 NID: ${data.nid}\n🎂 DOB: ${data.dob}\n${price > 0 ? `💰 Remaining Balance: ${getUserBalance(from)} টাকা\n` : ""}🖨️ Print করতে (১০ মিনিট): ${htmlUrl}`;

      const mediaId = await uploadMedia(pdfBuffer, filename, "application/pdf");
      await sendDocument(from, mediaId, filename, caption);
    } catch (err) {
      console.error("Process error:", err.message);
      await sendText(from, `❌ Error: ${err.message}\nআবার চেষ্টা করুন বা admin কে জানান।`);
    }
  }
}

// ========== EXPRESS SERVER ==========
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === CONFIG.WA_VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const entry    = req.body.entry?.[0];
    const change   = entry?.changes?.[0]?.value;
    const messages = change?.messages || [];
    const contacts = change?.contacts || [];
    for (const msg of messages) {
      await handleIncoming(msg, contacts[0]);
    }
  } catch (e) { console.error("Webhook error:", e.message); }
});

app.get("/privacy", (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;">
    <h1>Privacy Policy</h1>
    <p>NID Service Bot collects only the NID PDF you send. We process it to generate a card and do not share your data with any third party except the NID extraction service required for processing.</p>
    <p>Data is stored temporarily and deleted automatically.</p>
  </body></html>`);
});

app.use("/storage", express.static(CONFIG.STORAGE_DIR));
app.get("/", (req, res) => res.send("✅ NID Bot (Cloud API) is running"));

// ========== ADMIN PANEL ==========
const adminSessions = new Set();

function adminAuth(req, res, next) {
  const sess = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("admin_sess="))?.split("=")[1];
  if (sess && adminSessions.has(sess)) return next();
  res.redirect("/admin/login");
}

app.get("/admin/login", (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;padding:30px;background:#f5f5f5;border-radius:8px;">
    <h2>🔐 Admin Login</h2>
    <form method="POST" action="/admin/login">
      <input name="password" type="password" placeholder="Password" style="width:100%;padding:10px;margin:10px 0;" required/>
      <button type="submit" style="width:100%;padding:10px;background:#0078d4;color:#fff;border:0;border-radius:4px;cursor:pointer;">Login</button>
    </form>
  </body></html>`);
});

app.post("/admin/login", (req, res) => {
  if (req.body.password === CONFIG.ADMIN_PASS) {
    const tok = crypto.randomBytes(16).toString("hex");
    adminSessions.add(tok);
    res.setHeader("Set-Cookie", `admin_sess=${tok}; HttpOnly; Path=/; Max-Age=86400`);
    return res.redirect("/admin");
  }
  res.send("❌ Wrong password. <a href='/admin/login'>Try again</a>");
});

app.get("/admin/logout", (req, res) => {
  const cookie = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("admin_sess="));
  if (cookie) adminSessions.delete(cookie.split("=")[1]);
  res.setHeader("Set-Cookie", "admin_sess=; Max-Age=0; Path=/");
  res.redirect("/admin/login");
});

app.get("/admin", adminAuth, (req, res) => {
  const users    = getUsers();
  const stats    = getStats();
  const settings = getSettings();
  const rows = users.map(u => {
    const s = stats[normalizeNumber(u.number)] || { count: 0, lastUsed: "—" };
    return `<tr>
      <td>${u.number}</td>
      <td>${u.name || "—"}</td>
      <td style="color:${(u.balance||0) < 0 ? 'red' : 'green'};font-weight:bold">${u.balance || 0} ৳</td>
      <td>${u.active !== false ? "✅" : "❌"}</td>
      <td>${s.count}</td>
      <td style="font-size:11px">${s.lastUsed || "—"}</td>
      <td>
        <form method="POST" action="/admin/recharge" style="display:inline;white-space:nowrap">
          <input type="hidden" name="number" value="${u.number}"/>
          <input name="amount" placeholder="টাকা" type="number" style="width:65px;padding:3px"/>
          <button name="type" value="add" style="background:#28a745;color:#fff;border:0;padding:4px 8px;border-radius:3px;cursor:pointer">+Add</button>
          <button name="type" value="remove" style="background:#dc3545;color:#fff;border:0;padding:4px 8px;border-radius:3px;cursor:pointer">-Remove</button>
        </form>
        <form method="POST" action="/admin/toggle" style="display:inline">
          <input type="hidden" name="number" value="${u.number}"/>
          <button style="padding:4px 8px;cursor:pointer">Toggle</button>
        </form>
        <form method="POST" action="/admin/delete" style="display:inline">
          <input type="hidden" name="number" value="${u.number}"/>
          <button onclick="return confirm('Delete?')" style="background:#dc3545;color:#fff;border:0;padding:4px 8px;border-radius:3px;cursor:pointer">🗑️</button>
        </form>
      </td>
    </tr>`;
  }).join("");

  const mongoStatus = CONFIG.MONGO_URI ? "✅ MongoDB" : "❌ MongoDB না (MONGO_URI set করুন)";

  res.send(`<html><head><style>
    body{font-family:sans-serif;max-width:1200px;margin:30px auto;padding:20px}
    table{width:100%;border-collapse:collapse;margin:15px 0}
    th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:13px}
    th{background:#0078d4;color:#fff}
    .card{background:#f9f9f9;padding:15px;margin:10px 0;border-radius:6px;border:1px solid #ddd}
    button{padding:5px 10px;cursor:pointer}
    .status{padding:8px 15px;border-radius:5px;background:#e8f5e9;border:1px solid #c8e6c9;font-size:13px;margin-bottom:10px}
  </style></head><body>
    <h1>📊 NID Bot Admin Panel</h1>
    <div style="text-align:right"><a href="/admin/logout">Logout</a></div>
    <div class="status">Backup: ${mongoStatus}</div>

    <div class="card">
      <h3>⚙️ Settings</h3>
      <form method="POST" action="/admin/settings">
        Card Price (৳): <input name="cardPrice" value="${settings.cardPrice || 0}" style="width:80px" type="number"/>
        <button>Save</button>
      </form>
    </div>

    <div class="card">
      <h3>➕ Add User</h3>
      <form method="POST" action="/admin/add">
        <input name="number" placeholder="WhatsApp Number (880...)" required/>
        <input name="name" placeholder="Name"/>
        <input name="balance" placeholder="Initial balance" value="0" type="number" style="width:100px"/>
        <button>Add</button>
      </form>
    </div>

    <div class="card">
      <form method="POST" action="/admin/backup" style="display:inline">
        <button style="background:#17a2b8;color:#fff;border:0;padding:8px 16px;border-radius:4px;cursor:pointer">☁️ MongoDB Backup Now</button>
      </form>
    </div>

    <h3>👥 Users (${users.length})</h3>
    <table>
      <tr><th>Number</th><th>Name</th><th>Balance</th><th>Active</th><th>Cards</th><th>Last Used</th><th>Actions</th></tr>
      ${rows}
    </table>
  </body></html>`);
});

app.post("/admin/add", adminAuth, (req, res) => {
  const users = getUsers();
  const { number, name, balance } = req.body;
  const n = normalizeNumber(number);
  if (!users.find(u => normalizeNumber(u.number) === n)) {
    users.push({ number: n, name: name || "", balance: parseFloat(balance) || 0, active: true });
    saveUsers(users);
    backupData();
  }
  res.redirect("/admin");
});

// ✅ Recharge — Add (+) এবং Remove (-) দুটোই
app.post("/admin/recharge", adminAuth, (req, res) => {
  const users  = getUsers();
  const { number, amount, type } = req.body;
  const i      = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(number));
  const amt    = parseFloat(amount) || 0;
  if (i !== -1 && amt > 0) {
    if (type === "remove") {
      users[i].balance = (users[i].balance || 0) - amt;
    } else {
      users[i].balance = (users[i].balance || 0) + amt;
    }
    saveUsers(users);
    backupData(); // instant backup
  }
  res.redirect("/admin");
});

app.post("/admin/toggle", adminAuth, (req, res) => {
  const users = getUsers();
  const i     = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(req.body.number));
  if (i !== -1) { users[i].active = users[i].active === false; saveUsers(users); backupData(); }
  res.redirect("/admin");
});

app.post("/admin/delete", adminAuth, (req, res) => {
  saveUsers(getUsers().filter(u => normalizeNumber(u.number) !== normalizeNumber(req.body.number)));
  backupData();
  res.redirect("/admin");
});

app.post("/admin/settings", adminAuth, (req, res) => {
  saveSettings({ cardPrice: parseFloat(req.body.cardPrice) || 0 });
  backupData();
  res.redirect("/admin");
});

app.post("/admin/backup", adminAuth, async (req, res) => {
  await backupData();
  res.redirect("/admin");
});

// ========== STARTUP CLEANUP ==========
function cleanupOldFiles() {
  try {
    const tenMin = 10 * 60 * 1000;
    fs.readdirSync(CONFIG.STORAGE_DIR).forEach(f => {
      if (!f.endsWith(".html")) return;
      const fp  = path.join(CONFIG.STORAGE_DIR, f);
      const age = Date.now() - fs.statSync(fp).mtimeMs;
      if (age > tenMin) { fs.unlinkSync(fp); console.log(`🗑️ Cleaned: ${f}`); }
    });
  } catch (e) {}
}

// ========== START ==========
(async () => {
  await restoreData(); // MongoDB থেকে data restore
  cleanupOldFiles();

  app.listen(CONFIG.PORT, () => {
    console.log(`🚀 NID Bot running on port ${CONFIG.PORT}`);
    console.log(`📡 Webhook: ${CONFIG.BASE_URL}/webhook`);
    console.log(`🔐 Admin: ${CONFIG.BASE_URL}/admin`);
  });

  // Self-ping
  setInterval(() => { axios.get(CONFIG.BASE_URL).catch(() => {}); }, 14 * 60 * 1000);
})();
