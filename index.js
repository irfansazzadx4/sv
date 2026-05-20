/**
 * NID Service Bot — WhatsApp Cloud API
 * ✅ Database-free (শুধু bot এর জন্য)
 * ✅ PDF upload → API extract → V1/V2/V3 choice → HTML template → PDF → WhatsApp
 *
 * আপনার site: dakhila-ldtax-gov-bd.rf.gd
 * Template URLs:
 *   V1 → https://dakhila-ldtax-gov-bd.rf.gd/pages/server_download_v1.php
 *   V2 → https://dakhila-ldtax-gov-bd.rf.gd/pages/server_download_v2.php
 *   V3 → https://dakhila-ldtax-gov-bd.rf.gd/pages/server_download_v3.php
 *
 * ENV variables (Render/Railway):
 *   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_VERIFY_TOKEN
 *   PDF_API_URL, PDF_API_SECRET
 *   ADMIN_PASS, MONGO_URI (optional)
 *   PORT, RENDER_EXTERNAL_URL
 */

const express  = require("express");
const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const crypto   = require("crypto");
const FormData = require("form-data");

// ─────────────────────────── CONFIG ───────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3000,
  ADMIN_PASS: process.env.ADMIN_PASS || "admin123",

  WA_TOKEN:        process.env.WHATSAPP_TOKEN,
  WA_PHONE_ID:     process.env.WHATSAPP_PHONE_ID,
  WA_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || "myVerifyToken123",
  WA_API_VERSION:  "v21.0",

  // আপনার site এর NID extraction API
  API_EXTRACT_URL: "https://auto.onlinebd.top/Signtonid_api_one.php",

  // আপনার site এর template URL base
  // template গুলো GET params দিয়ে call করা হবে
  SITE_BASE: "https://dakhila-ldtax-gov-bd.rf.gd",

  // HTML→PDF API (আপনার নিজের বা external)
  PDF_API_URL:    process.env.PDF_API_URL,
  PDF_API_SECRET: process.env.PDF_API_SECRET,

  BASE_URL:    process.env.RENDER_EXTERNAL_URL || "https://nidservicebd.onrender.com",
  STORAGE_DIR: path.join(__dirname, "storage"),
  DATA_DIR:    path.join(__dirname, "data"),

  MONGO_URI: process.env.MONGO_URI,
};

if (!fs.existsSync(CONFIG.STORAGE_DIR)) fs.mkdirSync(CONFIG.STORAGE_DIR, { recursive: true });
if (!fs.existsSync(CONFIG.DATA_DIR))    fs.mkdirSync(CONFIG.DATA_DIR,    { recursive: true });

const USERS_FILE    = path.join(CONFIG.DATA_DIR, "users.json");
const STATS_FILE    = path.join(CONFIG.DATA_DIR, "stats.json");
const SETTINGS_FILE = path.join(CONFIG.DATA_DIR, "settings.json");

// ─────────────────────────── HELPERS ───────────────────────────
const loadJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
const saveJSON = (f, d)   => fs.writeFileSync(f, JSON.stringify(d, null, 2));

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
  if (price === 0) return true;
  const idx = users.findIndex(x => normalizeNumber(x.number) === normalizeNumber(number));
  if (idx === -1) return false;
  if ((users[idx].balance || 0) < price) return false;
  users[idx].balance = (users[idx].balance || 0) - price;
  saveUsers(users);
  return true;
}

function recordStat(number) {
  const stats = getStats();
  const key   = normalizeNumber(number);
  if (!stats[key]) stats[key] = { count: 0, lastUsed: null };
  stats[key].count++;
  stats[key].lastUsed = new Date().toISOString();
  saveStats(stats);
}

// ─────────────────────── PENDING STATE ────────────────────────
// user কে V1/V2/V3 choose করতে বলার পর data এখানে রাখা হয়
// format: { [whatsapp_number]: { data: {...}, timestamp: Date } }
const pendingChoices = new Map();

function setPending(number, extractedData) {
  pendingChoices.set(normalizeNumber(number), {
    data:      extractedData,
    timestamp: Date.now(),
  });
}

function getPending(number) {
  return pendingChoices.get(normalizeNumber(number)) || null;
}

function clearPending(number) {
  pendingChoices.delete(normalizeNumber(number));
}

// ─────────────────────────── MONGODB ───────────────────────────
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
    await client.db("nidbot").collection(collection)
      .replaceOne({ _id: key }, { _id: key, data }, { upsert: true });
  } catch (e) { console.error("MongoDB save error:", e.message); }
}

async function loadFromMongo(collection, key) {
  try {
    const client = await getMongoClient();
    if (!client) return null;
    const doc = await client.db("nidbot").collection(collection).findOne({ _id: key });
    return doc ? doc.data : null;
  } catch (e) { return null; }
}

async function backupData() {
  try {
    await Promise.all([
      saveToMongo("backups", "users",    getUsers()),
      saveToMongo("backups", "stats",    getStats()),
      saveToMongo("backups", "settings", getSettings()),
    ]);
    console.log("✅ MongoDB backup done");
  } catch (e) { console.error("Backup error:", e.message); }
}

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
    else console.log("ℹ️ No MongoDB data — starting fresh");
  } catch (e) { console.error("Restore error:", e.message); }
}

// ─────────────────────── WHATSAPP API ──────────────────────────
const WA_BASE    = () => `https://graph.facebook.com/${CONFIG.WA_API_VERSION}/${CONFIG.WA_PHONE_ID}`;
const WA_HEADERS = () => ({ Authorization: `Bearer ${CONFIG.WA_TOKEN}`, "Content-Type": "application/json" });

async function sendText(to, body) {
  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body }
    }, { headers: WA_HEADERS() });
  } catch (e) { console.error("sendText error:", e.response?.data || e.message); }
}

async function markRead(messageId) {
  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp", status: "read", message_id: messageId
    }, { headers: WA_HEADERS() });
  } catch {}
}

// ✅ Interactive buttons — V1/V2/V3 choice
async function sendVersionChoice(to, nidName, nidNumber) {
  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: `✅ NID তথ্য পাওয়া গেছে!\n\n👤 নাম: ${nidName}\n🆔 NID: ${nidNumber}\n\nকোন ভার্সনের কার্ড বানাবেন?`
        },
        action: {
          buttons: [
            { type: "reply", reply: { id: "choose_v1", title: "📄 Version 1" } },
            { type: "reply", reply: { id: "choose_v2", title: "📄 Version 2" } },
            { type: "reply", reply: { id: "choose_v3", title: "📄 Version 3" } },
          ]
        }
      }
    }, { headers: WA_HEADERS() });
  } catch (e) {
    console.error("sendVersionChoice error:", e.response?.data || e.message);
    // fallback: text message
    await sendText(to,
      `✅ NID তথ্য পাওয়া গেছে!\n👤 নাম: ${nidName}\n🆔 NID: ${nidNumber}\n\nকোন ভার্সন চান?\nটাইপ করুন: *v1*, *v2*, অথবা *v3*`
    );
  }
}

async function uploadMedia(buffer, filename, mimetype) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mimetype });
  form.append("type", mimetype);
  const res = await axios.post(`${WA_BASE()}/media`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${CONFIG.WA_TOKEN}` },
    maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  return res.data.id;
}

async function sendDocument(to, mediaId, filename, caption) {
  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp", to, type: "document",
      document: { id: mediaId, filename, caption }
    }, { headers: WA_HEADERS() });
  } catch (e) { console.error("sendDocument error:", e.response?.data || e.message); }
}

async function downloadMedia(mediaId) {
  const meta = await axios.get(
    `https://graph.facebook.com/${CONFIG.WA_API_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` } }
  );
  const fileRes = await axios.get(meta.data.url, {
    headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` },
    responseType: "arraybuffer",
  });
  return { buffer: Buffer.from(fileRes.data), mimetype: meta.data.mime_type };
}

// ─────────────────────── NID EXTRACTION ────────────────────────
function mapAPIData(d) {
  return {
    nid:         d.nationalId || d.nid || d.NID || d.national_id || "",
    pin:         d.pin || "",
    nameBangla:  d.nameBangla || d.nameBn || d.name_bn || "",
    nameEnglish: d.nameEnglish || d.nameEn || d.name_en || "",
    dob:         d.dateOfBirth || d.dob || "",
    father:      d.fatherName || d.father || d.father_name || "",
    mother:      d.motherName || d.mother || d.mother_name || "",
    spouse:      d.spouse || d.spouseName || "",
    gender:      d.gender || "",
    religion:    d.religion || "",
    birthPlace:  d.birthPlace || d.birth_place || "",
    bloodGroup:  d.bloodGroup || d.blood_group || "",
    voterArea:   d.voterArea || "",
    voterNo:     d.voterNo || "",
    occupation:  d.occupation || "",
    education:   d.education || "",
    presentAddress:   (typeof d.presentAddress   === "string") ? d.presentAddress   : (d.presentAddress?.addressLine   || d.address || ""),
    permanentAddress: (typeof d.permanentAddress === "string") ? d.permanentAddress : (d.permanentAddress?.addressLine || ""),
    photo:       d.userIMG || d.photo || d.imageUrl12 || "",
    dateOfToday: new Date().toISOString().slice(0, 10),
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
    console.log("📦 API Response:", JSON.stringify(res.data).slice(0, 300));
    const raw    = res.data?.data ? res.data.data : res.data;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return mapAPIData(parsed);
  } catch (err) {
    console.error("❌ Extract API failed:", err.response?.status, JSON.stringify(err.response?.data), err.message);
    throw new Error("NID extract করতে পারিনি: " + (err.response?.data?.message || err.message));
  }
}

// ──────────────────── TEMPLATE URL BUILDER ─────────────────────
// আপনার site এ GET params দিয়ে template call করা হবে
// server_download_v1.php, v2.php, v3.php — এগুলো include করে "pages/server-copys-v1.php" etc.
// সেই PHP file গুলো $_GET বা $_POST থেকে data নেয় কিনা সেটার উপর নির্ভর করে।
// যদি না নেয়, নিচে দেখুন ALTERNATIVE — আমরা নিজেই HTML build করবো।

function buildTemplateURL(version, data) {
  const base = `${CONFIG.SITE_BASE}/pages/server_download_v${version}.php`;
  const params = new URLSearchParams({
    nid:              data.nid,
    pin:              data.pin,
    nameBangla:       data.nameBangla,
    nameEnglish:      data.nameEnglish,
    dob:              data.dob,
    father:           data.father,
    mother:           data.mother,
    spouse:           data.spouse,
    gender:           data.gender,
    religion:         data.religion,
    birthPlace:       data.birthPlace,
    bloodGroup:       data.bloodGroup,
    voterArea:        data.voterArea,
    voterNo:          data.voterNo,
    occupation:       data.occupation,
    education:        data.education,
    presentAddress:   data.presentAddress,
    permanentAddress: data.permanentAddress,
    photo:            data.photo,
    dateOfToday:      data.dateOfToday,
    bot:              "1",  // bot=1 flag — PHP side এ দরকার হলে check করতে পারবেন
  });
  return `${base}?${params.toString()}`;
}

// ─────────────── ALTERNATIVE: নিজেই HTML fetch করা ────────────
// আপনার existing API generate URL (sv.php যেটা nid-bn.php call করে)
const API_GENERATE_URL = "https://auto.onlinebd.top/bot/nid-bn.php";

function fixRelativePaths(html, base) {
  const patterns = [
    [/(src\s*=\s*["'])(assets\/)/gi,   `$1${base}/assets/`],
    [/(href\s*=\s*["'])(assets\/)/gi,  `$1${base}/assets/`],
    [/(src\s*=\s*["'])(photo\/)/gi,    `$1${base}/photo/`],
    [/(url\s*\(\s*["']?)(assets\/)/gi, `$1${base}/assets/`],
    [/(url\s*\(\s*["']?)(photo\/)/gi,  `$1${base}/photo/`],
  ];
  for (const [r, rep] of patterns) html = html.replace(r, rep);
  return html;
}

async function embedFonts(html) {
  const fonts = [
    { url: "https://auto.onlinebd.top/fonts/Bangla.ttf", family: "Bangla" },
    { url: "https://auto.onlinebd.top/fonts/Arial.ttf",  family: "Arial"  },
  ];
  let css = "";
  for (const f of fonts) {
    try {
      const res = await axios.get(f.url, { responseType: "arraybuffer", timeout: 15000 });
      const b64 = Buffer.from(res.data).toString("base64");
      css += `@font-face{font-family:'${f.family}';src:url('data:font/truetype;base64,${b64}') format('truetype');}\n`;
      console.log(`✅ Font embedded: ${f.family}`);
    } catch { console.log(`⚠️ Font skip: ${f.family}`); }
  }
  const override = css + `*{font-family:Bangla,Arial,sans-serif!important;}`;
  return html.includes("</head>")
    ? html.replace("</head>", `<style>${override}</style>\n</head>`)
    : `<style>${override}</style>\n` + html;
}

// ── আপনার site এর template URL থেকে সরাসরি HTML fetch ──
async function fetchHTMLFromSite(version, data) {
  const url = buildTemplateURL(version, data);
  console.log(`📄 Fetching template V${version}: ${url.slice(0, 100)}...`);
  try {
    const res = await axios.get(url, { timeout: 30000 });
    return fixRelativePaths(res.data, CONFIG.SITE_BASE);
  } catch (err) {
    console.error(`Template fetch failed (V${version}):`, err.message);
    // Fallback: auto.onlinebd.top/bot/nid-bn.php দিয়ে generate
    return await fetchHTMLFromGenerateAPI(data);
  }
}

// Fallback — পুরনো generate API
async function fetchHTMLFromGenerateAPI(data) {
  const params = new URLSearchParams();
  // sv.php → nid-bn.php এর field mapping
  Object.entries({
    nid:              data.nid,
    pin:              data.pin,
    nameBn:           data.nameBangla,
    nameEn:           data.nameEnglish,
    dateOfBirth:      data.dob,
    fatherName:       data.father,
    motherName:       data.mother,
    spouse:           data.spouse,
    gender:           data.gender,
    religion:         data.religion,
    birthPlace:       data.birthPlace,
    bloodGroup:       data.bloodGroup,
    voterArea:        data.voterArea,
    voterNo:          data.voterNo,
    occupation:       data.occupation,
    education:        data.education,
    Presentaddress:   data.presentAddress,
    Permanentaddress: data.permanentAddress,
    imageUrl12:       data.photo,
    dateOfToday:      data.dateOfToday,
  }).forEach(([k, v]) => params.append(k, v || ""));

  const res = await axios.post(API_GENERATE_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 60000,
  });
  return fixRelativePaths(res.data, "https://auto.onlinebd.top/bot");
}

// ─────────────────── HTML → PDF CONVERTER ──────────────────────
async function convertHTMLtoPDF(html) {
  if (!CONFIG.PDF_API_URL) throw new Error("PDF_API_URL set করা নেই!");
  html = await embedFonts(html);
  const res = await axios.post(`${CONFIG.PDF_API_URL}/pdf`, {
    secret: CONFIG.PDF_API_SECRET,
    html,
  }, { timeout: 90000 });
  const base64 = res.data.pdf || res.data.base64 || res.data;
  return Buffer.from(base64, "base64");
}

// ─────────────────── PROCESS: PDF → Card → Send ────────────────
async function processNIDCard(from, data, version) {
  await sendText(from, `⏳ Version ${version} কার্ড তৈরি হচ্ছে...`);

  // 1. Template HTML fetch
  const html = await fetchHTMLFromSite(version, data);

  // 2. HTML → PDF
  const pdfBuffer = await convertHTMLtoPDF(html);

  // 3. Stats
  recordStat(from);
  backupData();

  // 4. WhatsApp এ পাঠানো
  const filename = `nid-v${version}-${data.nid || Date.now()}.pdf`;
  const price    = getSettings().cardPrice || 0;
  const caption  = [
    `✅ NID Card (Version ${version}) তৈরি হয়েছে!`,
    ``,
    `👤 নাম: ${data.nameBangla || data.nameEnglish}`,
    `🆔 NID: ${data.nid}`,
    `🎂 DOB: ${data.dob}`,
    price > 0 ? `💰 Remaining: ${getUserBalance(from)} টাকা` : "",
  ].filter(Boolean).join("\n");

  const mediaId = await uploadMedia(pdfBuffer, filename, "application/pdf");
  await sendDocument(from, mediaId, filename, caption);

  clearPending(from);
  console.log(`✅ Card sent to ${from} — V${version} — NID: ${data.nid}`);
}

// ─────────────────── INCOMING MESSAGE HANDLER ──────────────────
async function handleIncoming(msg, contact) {
  const from  = msg.from;
  const msgId = msg.id;
  markRead(msgId);

  // ── TEXT MESSAGE ──
  if (msg.type === "text") {
    const text = msg.text.body.trim().toLowerCase();

    // ping / status
    if (text === ".ping" || text === "ping") {
      return sendText(from, "🟢 Pong! Bot সচল আছে।");
    }
    if (text === ".status" || text === "status") {
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      const bal   = getUserBalance(from);
      const price = getSettings().cardPrice || 0;
      return sendText(from, `✅ Authorized\n💰 Balance: ${bal} টাকা\n💳 Card Price: ${price} টাকা`);
    }

    // V1 / V2 / V3 text fallback (যদি interactive buttons কাজ না করে)
    if (["v1", "1", "ভার্সন ১", "version 1"].includes(text)) {
      const pending = getPending(from);
      if (!pending) return sendText(from, "❌ কোনো PDF পাওয়া যায়নি। আগে PDF পাঠান।");
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      const price = getSettings().cardPrice || 0;
      if (price > 0 && !deductBalance(from)) return sendText(from, `❌ Balance কম! ${price} টাকা দরকার।`);
      return processNIDCard(from, pending.data, 1).catch(e => sendText(from, `❌ Error: ${e.message}`));
    }
    if (["v2", "2", "ভার্সন ২", "version 2"].includes(text)) {
      const pending = getPending(from);
      if (!pending) return sendText(from, "❌ কোনো PDF পাওয়া যায়নি। আগে PDF পাঠান।");
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      const price = getSettings().cardPrice || 0;
      if (price > 0 && !deductBalance(from)) return sendText(from, `❌ Balance কম! ${price} টাকা দরকার।`);
      return processNIDCard(from, pending.data, 2).catch(e => sendText(from, `❌ Error: ${e.message}`));
    }
    if (["v3", "3", "ভার্সন ৩", "version 3"].includes(text)) {
      const pending = getPending(from);
      if (!pending) return sendText(from, "❌ কোনো PDF পাওয়া যায়নি। আগে PDF পাঠান।");
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      const price = getSettings().cardPrice || 0;
      if (price > 0 && !deductBalance(from)) return sendText(from, `❌ Balance কম! ${price} টাকা দরকার।`);
      return processNIDCard(from, pending.data, 3).catch(e => sendText(from, `❌ Error: ${e.message}`));
    }

    return sendText(from,
      "📄 NID Card বানাতে আপনার NID PDF এই chat এ পাঠান।\n\n" +
      "Commands:\n.ping - bot check\n.status - balance check"
    );
  }

  // ── INTERACTIVE BUTTON REPLY (V1/V2/V3 choice) ──
  if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
    const buttonId = msg.interactive.button_reply.id;
    const pending  = getPending(from);

    if (!pending) return sendText(from, "❌ Expired! আবার PDF পাঠান।");
    if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");

    const price = getSettings().cardPrice || 0;
    if (price > 0 && !deductBalance(from)) {
      return sendText(from, `❌ Balance কম! ${price} টাকা দরকার।\nBalance: ${getUserBalance(from)} টাকা`);
    }

    const versionMap = { choose_v1: 1, choose_v2: 2, choose_v3: 3 };
    const version    = versionMap[buttonId];
    if (!version) return sendText(from, "❌ অজানা choice। আবার চেষ্টা করুন।");

    return processNIDCard(from, pending.data, version)
      .catch(e => sendText(from, `❌ Error: ${e.message}`));
  }

  // ── DOCUMENT (PDF) ──
  if (msg.type === "document") {
    const doc = msg.document;
    if (!doc.mime_type?.includes("pdf")) {
      return sendText(from, "❌ শুধু PDF file পাঠাতে হবে।");
    }
    if (!isAllowed(from)) {
      return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");
    }

    await sendText(from, "⏳ PDF প্রক্রিয়াকরণ চলছে... একটু অপেক্ষা করুন।");

    try {
      const { buffer } = await downloadMedia(doc.id);
      const data       = await extractNIDFromPDF(buffer);

      if (!data.nid && !data.nameBangla) {
        throw new Error("NID তথ্য extract করা সম্ভব হয়নি।");
      }

      // Pending এ রাখো, version choice চাও
      setPending(from, data);
      await sendVersionChoice(from, data.nameBangla || data.nameEnglish || "অজানা", data.nid || "N/A");
    } catch (err) {
      console.error("PDF Process error:", err.message);
      await sendText(from, `❌ Error: ${err.message}\nআবার চেষ্টা করুন বা admin কে জানান।`);
    }
  }
}

// ──────────────────── EXPRESS SERVER ────────────────────────────
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Webhook verify
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

// Webhook receiver
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

app.get("/", (req, res) => res.send("✅ NID Bot (DB-Free) is running"));

app.get("/privacy", (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;">
    <h1>Privacy Policy</h1>
    <p>NID Service Bot collects only the NID PDF you send, processes it to generate a card, and does not store or share your data.</p>
  </body></html>`);
});

// ──────────────────── ADMIN PANEL ───────────────────────────────
const adminSessions = new Set();

function adminAuth(req, res, next) {
  const sess = (req.headers.cookie || "")
    .split(";").map(s => s.trim())
    .find(s => s.startsWith("admin_sess="))?.split("=")[1];
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
  const c = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("admin_sess="));
  if (c) adminSessions.delete(c.split("=")[1]);
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
      <td style="color:${(u.balance||0) < 0 ? 'red':'green'};font-weight:bold">${u.balance||0} ৳</td>
      <td>${u.active !== false ? "✅":"❌"}</td>
      <td>${s.count}</td>
      <td style="font-size:11px">${s.lastUsed||"—"}</td>
      <td>
        <form method="POST" action="/admin/recharge" style="display:inline;white-space:nowrap">
          <input type="hidden" name="number" value="${u.number}"/>
          <input name="amount" placeholder="টাকা" type="number" style="width:65px;padding:3px"/>
          <button name="type" value="add"    style="background:#28a745;color:#fff;border:0;padding:4px 8px;border-radius:3px;cursor:pointer">+Add</button>
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

  const pendingList = [...pendingChoices.entries()]
    .map(([num, p]) => `<li>${num} — ${p.data.nameBangla || "?"} (NID: ${p.data.nid || "?"})</li>`)
    .join("") || "<li>কেউ নেই</li>";

  res.send(`<html><head><style>
    body{font-family:sans-serif;max-width:1200px;margin:30px auto;padding:20px}
    table{width:100%;border-collapse:collapse;margin:15px 0}
    th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:13px}
    th{background:#0078d4;color:#fff}
    .card{background:#f9f9f9;padding:15px;margin:10px 0;border-radius:6px;border:1px solid #ddd}
  </style></head><body>
    <h1>📊 NID Bot Admin Panel (DB-Free)</h1>
    <div style="text-align:right"><a href="/admin/logout">Logout</a></div>

    <div class="card">
      <h3>⚙️ Settings — Card Price</h3>
      <form method="POST" action="/admin/settings">
        Card Price (৳): <input name="cardPrice" value="${settings.cardPrice||0}" style="width:80px" type="number"/>
        <button>Save</button>
      </form>
    </div>

    <div class="card">
      <h3>🕐 Pending Version Choice (${pendingChoices.size})</h3>
      <ul>${pendingList}</ul>
      <small>এরা PDF পাঠিয়েছেন, এখনো V1/V2/V3 choose করেননি।</small>
    </div>

    <div class="card">
      <h3>➕ Add User</h3>
      <form method="POST" action="/admin/add">
        <input name="number" placeholder="WhatsApp Number (880...)" required/>
        <input name="name" placeholder="Name"/>
        <input name="balance" placeholder="Balance" value="0" type="number" style="width:100px"/>
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
    users.push({ number: n, name: name||"", balance: parseFloat(balance)||0, active: true });
    saveUsers(users); backupData();
  }
  res.redirect("/admin");
});

app.post("/admin/recharge", adminAuth, (req, res) => {
  const users = getUsers();
  const { number, amount, type } = req.body;
  const i   = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(number));
  const amt = parseFloat(amount) || 0;
  if (i !== -1 && amt > 0) {
    users[i].balance = (users[i].balance || 0) + (type === "remove" ? -amt : amt);
    saveUsers(users); backupData();
  }
  res.redirect("/admin");
});

app.post("/admin/toggle", adminAuth, (req, res) => {
  const users = getUsers();
  const i     = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(req.body.number));
  if (i !== -1) { users[i].active = !users[i].active; saveUsers(users); backupData(); }
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

// ────────────────────── STARTUP ─────────────────────────────────
function cleanupOldFiles() {
  try {
    const tenMin = 10 * 60 * 1000;
    fs.readdirSync(CONFIG.STORAGE_DIR).forEach(f => {
      const fp = path.join(CONFIG.STORAGE_DIR, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > tenMin) {
        fs.unlinkSync(fp);
        console.log(`🗑️ Cleaned: ${f}`);
      }
    });
  } catch {}
}

// Pending choices expire করা (15 মিনিট পর)
setInterval(() => {
  const limit = 15 * 60 * 1000;
  for (const [num, p] of pendingChoices.entries()) {
    if (Date.now() - p.timestamp > limit) {
      pendingChoices.delete(num);
      console.log(`⏰ Pending expired: ${num}`);
    }
  }
}, 5 * 60 * 1000);

(async () => {
  await restoreData();
  cleanupOldFiles();

  app.listen(CONFIG.PORT, () => {
    console.log(`🚀 NID Bot running on port ${CONFIG.PORT}`);
    console.log(`📡 Webhook: ${CONFIG.BASE_URL}/webhook`);
    console.log(`🔐 Admin: ${CONFIG.BASE_URL}/admin`);
    console.log(`🌐 Site Base: ${CONFIG.SITE_BASE}`);
  });

  // Self-ping (Render sleep prevention)
  setInterval(() => { axios.get(CONFIG.BASE_URL).catch(() => {}); }, 14 * 60 * 1000);
})();
