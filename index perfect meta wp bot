/**
 * NID Service Bot - WhatsApp Cloud API Version
 * Migrated from Baileys to Meta Cloud API for 100% ban-free operation
 */

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const FormData = require("form-data");
const { execSync } = require("child_process");

// ========== CONFIG ==========
const CONFIG = {
  PORT: process.env.PORT || 3000,
  ADMIN_PASS: process.env.ADMIN_PASS || "admin123",

  // WhatsApp Cloud API
  WA_TOKEN: process.env.WHATSAPP_TOKEN,
  WA_PHONE_ID: process.env.WHATSAPP_PHONE_ID,
  WA_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || "myVerifyToken123",
  WA_API_VERSION: "v21.0",

  // External APIs
  API_EXTRACT_URL: "https://auto.onlinebd.top/Signtonid_api_one.php",
  API_GENERATE_URL: "https://auto.onlinebd.top/bot/nid-bn.php",
  PDF_API_URL: process.env.PDF_API_URL,
  PDF_API_SECRET: process.env.PDF_API_SECRET,

  BASE_URL: process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || "https://nidservicebd.onrender.com",
  STORAGE_DIR: path.join(__dirname, "storage"),
  DATA_DIR: path.join(__dirname, "data"),

  // GitHub backup
  GITHUB_REPO: process.env.GITHUB_REPO,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || "main",
};

if (!fs.existsSync(CONFIG.STORAGE_DIR)) fs.mkdirSync(CONFIG.STORAGE_DIR, { recursive: true });
if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

const USERS_FILE = path.join(CONFIG.DATA_DIR, "users.json");
const STATS_FILE = path.join(CONFIG.DATA_DIR, "stats.json");
const SETTINGS_FILE = path.join(CONFIG.DATA_DIR, "settings.json");

// ========== HELPERS ==========
const loadJSON = (f, def) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; }
};
const saveJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

const getUsers = () => loadJSON(USERS_FILE, []);
const saveUsers = (u) => saveJSON(USERS_FILE, u);
const getStats = () => loadJSON(STATS_FILE, {});
const saveStats = (s) => saveJSON(STATS_FILE, s);
const getSettings = () => loadJSON(SETTINGS_FILE, { cardPrice: 0 });
const saveSettings = (s) => saveJSON(SETTINGS_FILE, s);

// Normalize number to E.164 without +
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

// ========== GITHUB BACKUP ==========
function pushDataToGitHub() {
  if (!CONFIG.GITHUB_REPO || !CONFIG.GITHUB_TOKEN) return;
  try {
    const repoUrl = `https://${CONFIG.GITHUB_TOKEN}@github.com/${CONFIG.GITHUB_REPO}.git`;
    const tmp = "/tmp/databackup_" + Date.now();
    execSync(`git clone --depth 1 -b ${CONFIG.GITHUB_BRANCH} ${repoUrl} ${tmp}`, { stdio: "ignore" });
    ["users.json", "stats.json", "settings.json"].forEach(f => {
      const src = path.join(CONFIG.DATA_DIR, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
    });
    execSync(`cd ${tmp} && git config user.email bot@bot.com && git config user.name bot && git add -A && git commit -m "data backup" || true && git push`, { stdio: "ignore" });
    execSync(`rm -rf ${tmp}`);
    console.log("✅ Data pushed to GitHub");
  } catch (e) {
    console.error("GitHub push error:", e.message);
  }
}

function restoreDataFromGitHub() {
  if (!CONFIG.GITHUB_REPO || !CONFIG.GITHUB_TOKEN) return;
  try {
    ["users.json", "stats.json", "settings.json"].forEach(f => {
      const local = path.join(CONFIG.DATA_DIR, f);
      if (fs.existsSync(local)) return;
      const url = `https://raw.githubusercontent.com/${CONFIG.GITHUB_REPO}/${CONFIG.GITHUB_BRANCH}/${f}`;
      axios.get(url, { headers: { Authorization: `token ${CONFIG.GITHUB_TOKEN}` } })
        .then(r => fs.writeFileSync(local, JSON.stringify(r.data, null, 2)))
        .catch(() => {});
    });
  } catch (e) { console.error("Restore error:", e.message); }
}

// ========== WHATSAPP CLOUD API FUNCTIONS ==========
const WA_BASE = `https://graph.facebook.com/${CONFIG.WA_API_VERSION}/${CONFIG.WA_PHONE_ID}`;
const WA_HEADERS = { Authorization: `Bearer ${CONFIG.WA_TOKEN}`, "Content-Type": "application/json" };

// Send text message
async function sendText(to, body) {
  try {
    await axios.post(`${WA_BASE}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    }, { headers: WA_HEADERS });
  } catch (e) {
    console.error("sendText error:", e.response?.data || e.message);
  }
}

// Mark message as read (shows blue tick)
async function markRead(messageId) {
  try {
    await axios.post(`${WA_BASE}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId
    }, { headers: WA_HEADERS });
  } catch {}
}

// Upload media to WhatsApp servers and get media_id
async function uploadMedia(buffer, filename, mimetype) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mimetype });
  form.append("type", mimetype);
  const res = await axios.post(`${WA_BASE}/media`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${CONFIG.WA_TOKEN}` },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  return res.data.id;
}

// Send document (PDF) with caption
async function sendDocument(to, mediaId, filename, caption) {
  try {
    await axios.post(`${WA_BASE}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { id: mediaId, filename, caption }
    }, { headers: WA_HEADERS });
  } catch (e) {
    console.error("sendDocument error:", e.response?.data || e.message);
  }
}

// Download media from WhatsApp by media_id
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

// ========== NID EXTRACTION & CARD GENERATION ==========
function mapAPIData(d) {
  // Keys must exactly match PHP $_POST variable names in nid-bn.php
  return {
    nid:        d.nationalId || d.nid || d.NID || d.national_id || "",
    pin:        d.pin || "",
    pin_status: "disabled",                          // always show NID, not PIN
    nameBangla: d.nameBangla || d.name_bn || "",
    nameEnglish:d.nameEnglish || d.name_en || "",
    dob:        d.dateOfBirth || d.dob || "",        // $_POST['dob']
    nameFather: d.fatherName || d.father_name || "", // $_POST['nameFather']
    nameMother: d.motherName || d.mother_name || "", // $_POST['nameMother']
    fulladdress:d.address || d.permanent_address || "", // $_POST['fulladdress']
    birthPlace: d.birthPlace || d.birth_place || "", // $_POST['birthPlace']
    bloodGroup: d.bloodGroup || d.blood_group || "", // $_POST['bloodGroup']
    issueDate:  d.dateOfToday || "",                 // $_POST['issueDate'] (প্রদানের তারিখ)
    imageUrl12: d.userIMG || d.imageUrl12 || "",     // user photo URL
    imageUrl22: d.signIMG || d.imageUrl22 || "",     // signature URL
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
    // API wraps data inside { status: "success", data: { ... } }
    const raw = (res.data?.data) ? res.data.data : res.data;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return mapAPIData(parsed);
  } catch (err) {
    console.error("❌ Extract API failed:", err.response?.status, JSON.stringify(err.response?.data), err.message);
    throw new Error("Extract API: " + (err.response?.data?.message || err.message));
  }
}

// API generates HTML with relative paths like "assets/css/nid_css.css"
// Inject <base> tag so browser resolves them against the PHP server
const PHP_BASE = "https://auto.onlinebd.top/bot/";

function fixRelativePaths(html) {
  // If <head> exists, inject base tag
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head><base href="${PHP_BASE}">`);
  }
  // Fallback: prepend base tag
  return `<base href="${PHP_BASE}">` + html;
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
  fs.writeFileSync(path.join(CONFIG.STORAGE_DIR, filename), html);
  return `${CONFIG.BASE_URL}/storage/${filename}`;
}

async function embedFontsInHTML(html) {
  return html;
}

async function generatePDFFromMapped(data) {
  let html = await fetchHTMLFromData(data);
  html = await embedFontsInHTML(html);
  const res = await axios.post(`${CONFIG.PDF_API_URL}/pdf`, {
    secret: CONFIG.PDF_API_SECRET,
    html
  }, { timeout: 90000 });
  const base64 = res.data.pdf || res.data.base64 || res.data;
  return Buffer.from(base64, "base64");
}

// ========== INCOMING MESSAGE HANDLER ==========
async function handleIncoming(msg, contact) {
  const from = msg.from;
  const msgId = msg.id;
  await markRead(msgId);

  if (msg.type === "text") {
    const text = msg.text.body.trim().toLowerCase();
    if (text === ".ping" || text === "ping") {
      return sendText(from, "🟢 Pong! Bot সচল আছে।");
    }
    if (text === ".status" || text === "status") {
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");
      const bal = getUserBalance(from);
      const price = getSettings().cardPrice || 0;
      return sendText(from, `✅ আপনি authorized।\n💰 Balance: ${bal} টাকা\n💳 Card Price: ${price} টাকা`);
    }
    return sendText(from, "📄 NID Card বানাতে আপনার NID PDF টা এই chat এ পাঠান।\n\nCommands:\n.ping - bot check\n.status - balance check");
  }

  if (msg.type === "document") {
    const doc = msg.document;
    if (!doc.mime_type?.includes("pdf")) {
      return sendText(from, "❌ শুধু PDF file পাঠাতে হবে।");
    }
    if (!isAllowed(from)) {
      return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");
    }

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
      pushDataToGitHub();

      const filename = `NID_${data.nid}.pdf`;
      const caption = `✅ আপনার NID Card তৈরি হয়েছে!\n\n👤 নাম: ${data.nameBangla || data.nameEnglish}\n🆔 NID: ${data.nid}\n🎂 DOB: ${data.dob}\n${price > 0 ? `💰 Remaining Balance: ${getUserBalance(from)} টাকা\n` : ""}🖨️ Print করতে: ${htmlUrl}`;

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
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
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
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const messages = change?.messages || [];
    const contacts = change?.contacts || [];
    for (const msg of messages) {
      await handleIncoming(msg, contacts[0]);
    }
  } catch (e) {
    console.error("Webhook error:", e.message);
  }
});

app.get("/privacy", (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;">
    <h1>Privacy Policy</h1>
    <p>NID Service Bot collects only the NID PDF you send. We process it to generate a card and do not share your data with any third party except the NID extraction service required for processing.</p>
    <p>Data is stored temporarily and deleted automatically. Contact admin for data deletion requests.</p>
  </body></html>`);
});

app.use("/storage", express.static(CONFIG.STORAGE_DIR));

app.get("/", (req, res) => res.send("✅ NID Bot (Cloud API) is running"));

// ========== ADMIN PANEL ==========
const adminSessions = new Set();

function adminAuth(req, res, next) {
  const sess = req.cookies?.admin_sess || (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("admin_sess="))?.split("=")[1];
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
  const users = getUsers();
  const stats = getStats();
  const settings = getSettings();
  const rows = users.map(u => {
    const s = stats[normalizeNumber(u.number)] || { count: 0, lastUsed: "—" };
    return `<tr>
      <td>${u.number}</td><td>${u.name || "—"}</td>
      <td>${u.balance || 0}</td>
      <td>${u.active !== false ? "✅" : "❌"}</td>
      <td>${s.count}</td><td>${s.lastUsed || "—"}</td>
      <td>
        <form method="POST" action="/admin/recharge" style="display:inline">
          <input type="hidden" name="number" value="${u.number}"/>
          <input name="amount" placeholder="৳" style="width:60px"/>
          <button>Recharge</button>
        </form>
        <form method="POST" action="/admin/toggle" style="display:inline">
          <input type="hidden" name="number" value="${u.number}"/>
          <button>Toggle</button>
        </form>
        <form method="POST" action="/admin/delete" style="display:inline">
          <input type="hidden" name="number" value="${u.number}"/>
          <button onclick="return confirm('Delete?')">🗑️</button>
        </form>
      </td>
    </tr>`;
  }).join("");

  res.send(`<html><head><style>
    body{font-family:sans-serif;max-width:1100px;margin:30px auto;padding:20px}
    table{width:100%;border-collapse:collapse;margin:15px 0}
    th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:13px}
    th{background:#0078d4;color:#fff}
    .card{background:#f9f9f9;padding:15px;margin:10px 0;border-radius:6px}
    button{padding:5px 10px;cursor:pointer}
  </style></head><body>
    <h1>📊 NID Bot Admin Panel</h1>
    <div style="text-align:right"><a href="/admin/logout">Logout</a></div>

    <div class="card">
      <h3>⚙️ Settings</h3>
      <form method="POST" action="/admin/settings">
        Card Price (৳): <input name="cardPrice" value="${settings.cardPrice || 0}" style="width:80px"/>
        <button>Save</button>
      </form>
    </div>

    <div class="card">
      <h3>➕ Add User</h3>
      <form method="POST" action="/admin/add">
        <input name="number" placeholder="WhatsApp Number (880...)" required/>
        <input name="name" placeholder="Name"/>
        <input name="balance" placeholder="Initial balance" value="0"/>
        <button>Add</button>
      </form>
    </div>

    <h3>👥 Users (${users.length})</h3>
    <table><tr><th>Number</th><th>Name</th><th>Balance</th><th>Active</th><th>Cards</th><th>Last Used</th><th>Actions</th></tr>${rows}</table>

    <div class="card">
      <form method="POST" action="/admin/backup"><button>📦 Backup to GitHub Now</button></form>
    </div>
  </body></html>`);
});

app.post("/admin/add", adminAuth, (req, res) => {
  const users = getUsers();
  const { number, name, balance } = req.body;
  const n = normalizeNumber(number);
  if (!users.find(u => normalizeNumber(u.number) === n)) {
    users.push({ number: n, name: name || "", balance: parseInt(balance) || 0, active: true });
    saveUsers(users);
    pushDataToGitHub();
  }
  res.redirect("/admin");
});

app.post("/admin/recharge", adminAuth, (req, res) => {
  const users = getUsers();
  const i = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(req.body.number));
  if (i !== -1) {
    users[i].balance = (users[i].balance || 0) + (parseInt(req.body.amount) || 0);
    saveUsers(users);
    pushDataToGitHub();
  }
  res.redirect("/admin");
});

app.post("/admin/toggle", adminAuth, (req, res) => {
  const users = getUsers();
  const i = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(req.body.number));
  if (i !== -1) {
    users[i].active = users[i].active === false;
    saveUsers(users);
    pushDataToGitHub();
  }
  res.redirect("/admin");
});

app.post("/admin/delete", adminAuth, (req, res) => {
  const users = getUsers().filter(u => normalizeNumber(u.number) !== normalizeNumber(req.body.number));
  saveUsers(users);
  pushDataToGitHub();
  res.redirect("/admin");
});

app.post("/admin/settings", adminAuth, (req, res) => {
  saveSettings({ cardPrice: parseInt(req.body.cardPrice) || 0 });
  pushDataToGitHub();
  res.redirect("/admin");
});

app.post("/admin/backup", adminAuth, (req, res) => {
  pushDataToGitHub();
  res.redirect("/admin");
});

// ========== START ==========
restoreDataFromGitHub();
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 NID Bot (Cloud API) running on port ${CONFIG.PORT}`);
  console.log(`📡 Webhook URL: ${CONFIG.BASE_URL}/webhook`);
  console.log(`🔐 Admin Panel: ${CONFIG.BASE_URL}/admin`);
});

// Self-ping (keep Render awake)
setInterval(() => {
  axios.get(CONFIG.BASE_URL).catch(() => {});
}, 14 * 60 * 1000);
