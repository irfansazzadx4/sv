/**
 * NID Service Bot — WhatsApp Cloud API
 * ✅ Self-built HTML (no PHP dependency)
 * ✅ Default version per user (.setversion v1/v2/v3)
 * ✅ Fast reply (markRead AFTER processing)
 * ✅ PDF upload → API extract → HTML build → PDF → WhatsApp
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

  API_EXTRACT_URL: "https://auto.onlinebd.top/Signtonid_api_one.php",
  SITE_BASE:       "https://dakhila-ldtax-gov-bd.rf.gd",

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

function getUser(number) {
  return getUsers().find(x => normalizeNumber(x.number) === normalizeNumber(number));
}

function isAllowed(number) {
  const users = getUsers();
  if (users.length === 0) return false;
  const u = users.find(x => normalizeNumber(x.number) === normalizeNumber(number));
  return u && u.active !== false;
}

function getUserBalance(number) {
  const u = getUser(number);
  return u ? (u.balance || 0) : 0;
}

// ── Default Version per user ──
function getUserDefaultVersion(number) {
  const u = getUser(number);
  return u ? (u.defaultVersion || 0) : 0; // 0 = no default, ask every time
}

function setUserDefaultVersion(number, version) {
  const users = getUsers();
  const idx = users.findIndex(x => normalizeNumber(x.number) === normalizeNumber(number));
  if (idx !== -1) {
    users[idx].defaultVersion = version;
    saveUsers(users);
    return true;
  }
  return false;
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

async function sendVersionChoice(to, nidName, nidNumber, currentDefault) {
  const defaultInfo = currentDefault > 0
    ? `\n\n⚙️ আপনার default: V${currentDefault} (শুধু V${currentDefault} পেতে কিছু না লিখলেও হবে)`
    : `\n\n💡 Tip: *.setversion v1* দিলে পরে automatically V1 তৈরি হবে`;

  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: `✅ NID তথ্য পাওয়া গেছে!\n\n👤 নাম: ${nidName}\n🆔 NID: ${nidNumber}\n\nকোন ভার্সনের কার্ড বানাবেন?${defaultInfo}`
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
    await sendText(to,
      `✅ NID তথ্য পাওয়া গেছে!\n👤 নাম: ${nidName}\n🆔 NID: ${nidNumber}\n\nকোন ভার্সন চান? টাইপ করুন: *v1*, *v2*, অথবা *v3*${defaultInfo}`
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
/**
 * NID Service Bot — WhatsApp Cloud API
 * ✅ Self-built HTML (no PHP dependency)
 * ✅ Default version per user (.setversion v1/v2/v3)
 * ✅ Fast reply (markRead AFTER processing)
 * ✅ PDF upload → API extract → HTML build → PDF → WhatsApp
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

  API_EXTRACT_URL: "https://auto.onlinebd.top/Signtonid_api_one.php",
  SITE_BASE:       "https://dakhila-ldtax-gov-bd.rf.gd",

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

function getUser(number) {
  return getUsers().find(x => normalizeNumber(x.number) === normalizeNumber(number));
}

function isAllowed(number) {
  const users = getUsers();
  if (users.length === 0) return false;
  const u = users.find(x => normalizeNumber(x.number) === normalizeNumber(number));
  return u && u.active !== false;
}

function getUserBalance(number) {
  const u = getUser(number);
  return u ? (u.balance || 0) : 0;
}

// ── Default Version per user ──
function getUserDefaultVersion(number) {
  const u = getUser(number);
  return u ? (u.defaultVersion || 0) : 0; // 0 = no default, ask every time
}

function setUserDefaultVersion(number, version) {
  const users = getUsers();
  const idx = users.findIndex(x => normalizeNumber(x.number) === normalizeNumber(number));
  if (idx !== -1) {
    users[idx].defaultVersion = version;
    saveUsers(users);
    return true;
  }
  return false;
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

async function sendVersionChoice(to, nidName, nidNumber, currentDefault) {
  const defaultInfo = currentDefault > 0
    ? `\n\n⚙️ আপনার default: V${currentDefault} (শুধু V${currentDefault} পেতে কিছু না লিখলেও হবে)`
    : `\n\n💡 Tip: *.setversion v1* দিলে পরে automatically V1 তৈরি হবে`;

  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: `✅ NID তথ্য পাওয়া গেছে!\n\n👤 নাম: ${nidName}\n🆔 NID: ${nidNumber}\n\nকোন ভার্সনের কার্ড বানাবেন?${defaultInfo}`
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
    await sendText(to,
      `✅ NID তথ্য পাওয়া গেছে!\n👤 নাম: ${nidName}\n🆔 NID: ${nidNumber}\n\nকোন ভার্সন চান? টাইপ করুন: *v1*, *v2*, অথবা *v3*${defaultInfo}`
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
  // Present Address এবং Permanent Address থেকে addressLine এক্সট্রাক্ট করা (স্ট্রিং বা অবজেক্ট দুটির জন্যই সেইফ হ্যান্ডলিং)
  const presentAddrStr = d.presentAddress ? (typeof d.presentAddress === "string" ? d.presentAddress : (d.presentAddress.addressLine || d.presentAddress.address || "")) : "";
  const permanentAddrStr = d.permanentAddress ? (typeof d.permanentAddress === "string" ? d.permanentAddress : (d.permanentAddress.addressLine || d.permanentAddress.address || "")) : "";

  return {
    nid:              d.nationalId || d.nid || d.NID || d.national_id || d.nationalIdNumber || "",
    pin:              d.pin || d.pinNo || d.pin_no || d.pinNumber || "",
    oldNid:           d.formNo || d.form_no || d.oldNid || d.old_nid || "",
    nameBangla:       d.nameBn || d.nameBangla || d.name_bn || d.nameBanglaHtml || "",
    nameEnglish:      d.nameEn || d.nameEnglish || d.name_en || d.nameEnglishHtml || "",
    dob:              d.dateOfBirth || d.dob || d.birthDate || "",
    birthDay:         d.birthDay || "",
    age:              d.age || "",
    father:           d.father || d.fatherName || d.father_name || "",
    mother:           d.mother || d.motherName || d.mother_name || "",
    spouse:           d.spouse || d.spouseName || d.spouse_name || "",
    gender:           d.gender || "",
    religion:         d.religion || d.faith || "",
    birthPlace:       d.birthPlace || d.birth_place || d.district || "",
    bloodGroup:       d.bloodGroup || d.blood_group || "",
    voterArea:        d.voterArea || d.vuter_area || d.voter_area || d.voterAreaName || "",
    voterNo:          d.voterNo || d.voter_no || d.voterNumber || "",
    voterAreaCode:    d.voterAreaCode || d.voter_aria_code || d.voter_area_code || "",
    slNo:             d.slNo || d.sl_no || d.serialNo || d.serial_no || "",
    upazilaCode:      d.upazilaCode || d.upazila_code || "",
    fatherNID:        d.nidFather || d.fatherNID || d.father_nid || "",
    motherNID:        d.nidMother || d.motherNID || d.mother_nid || "",
    occupation:       d.occupation || d.profession || "",
    education:        d.education || "",
    presentAddress:   presentAddrStr,
    permanentAddress: permanentAddrStr,
    photo:            d.photo || d.userIMG || d.imageUrl12 || d.image || d.photoUrl || "",
    dateOfToday:      new Date().toLocaleDateString("bn-BD", { year: "numeric", month: "long", day: "numeric" }),
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

// ─────────────────────── HTML BUILDER ──────────────────────────
function toBn(str) {
  if (!str) return "";
  const map = { "0":"০","1":"১","2":"২","3":"৩","4":"৪","5":"৫","6":"৬","7":"৭","8":"৮","9":"৯" };
  return String(str).replace(/[0-9]/g, d => map[d]);
}

// ── V1 — signtoserverv1 php exact recreation ──
function buildHTMLv1(d) {
  const presentAddr  = (d.presentAddress  || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");
  const permanentAddr = (d.permanentAddress || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");
  const qrData = encodeURIComponent(`${d.nameEnglish} ${d.nid} ${d.dob}`);

  return `<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="utf-8">
    <meta content="width=device-width, initial-scale=1.0" name="viewport">
    <title>${d.nid} - ${d.nameEnglish}</title>
    <link href="https://surokkha.gov.bd/favicon.png" rel="icon">
    <link rel="stylesheet" href="https://site-assets.fontawesome.com/releases/v6.1.1/css/all.css">
    <style>
        @import url('https://fonts.maateen.me/solaiman-lipi/font.css');
        @page {
            size: A4;
            margin: 0; 
        }
        body {
            margin: 0;
            font-family: 'Solaimanlipi', sans-serif; 
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 10vh;
            background-color: #f0f0f0; 
        }
        
        .printable-container {
            width: 750px; 
            height: 1000px;
            position: relative;
            box-shadow: 0;
            margin: 10px 0;
            flex-shrink: 0;
            background-color: lightgrey; 
        }
        
        .background {
            position: relative;
            width: 100%;
            height: 100%;
        }
        .crane {
            max-width: 100%;
            height: 100%;
        }
        
        #print-pdf-btn {
            background: linear-gradient(45deg, #FF5722, #FF9800);
            padding: 10px 20px;
            width: auto;
            height: auto;
            border: none;
            font-size: 20px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 2px 5px 10px rgba(0, 0, 0, 0.2);
            color: #fff;
            border-radius: 25px;
            margin: 25px;
            display: block;
            text-transform: uppercase;
            transition: all 0.3s ease-in-out;
            letter-spacing: 1px;
        }

        #print-pdf-btn:hover {
            background: linear-gradient(45deg, #FF9800, #FF5722);
            transform: translateY(-5px) scale(1.05);
            box-shadow: 2px 8px 15px rgba(0, 0, 0, 0.3);
        }

         @media print {
            html, body {
                width: 210mm !important;
                height: 297mm !important;
                background-color: #ffffff !important;
                margin: 0;
                padding: 0;
                zoom: 100%; 
                -webkit-print-color-adjust: exact;
                color-adjust: exact;
            }
            .print-only { display: block !important; }
            .no-print { display: none !important; }

            @page {
                margin-top: 0mm; 
                margin-bottom: 0mm; 
            }
            .printable-container {
                width: 205mm; 
                height: 295mm; 
                page-break-after: avoid; 
                margin: 0mm; 
                overflow: hidden; 
            }
            .crane {
                width: 100%;
                height: 100%;
                display: block;
            }
        }
    </style>
</head>
<body style="text-align: center;">
    <div class="no-print" style="padding: 10px; font-weight: bold;">[Version 1 Generated Template]</div>
</body>
</html>`;
}

function buildHTML(version, data) {
  if (version === 1) return buildHTMLv1(data);
  if (version === 2) return buildHTMLv2(data);
  if (version === 3) return buildHTMLv3(data);
  return buildHTMLv1(data);
}

// ─────────────────── HTML → PDF CONVERTER ──────────────────────
async function convertHTMLtoPDF(html) {
  if (!CONFIG.PDF_API_URL) throw new Error("PDF_API_URL set করা নেই!");
  const res = await axios.post(`${CONFIG.PDF_API_URL}/pdf`, {
    secret: CONFIG.PDF_API_SECRET,
    html,
  }, { timeout: 90000 });
  const base64 = res.data.pdf || res.data.base64 || res.data;
  return Buffer.from(base64, "base64");
}

// ─────────────────── PROCESS: PDF → Card → Send ────────────────
async function processNIDCard(from, data, version, msgId) {
  if (msgId) markRead(msgId);

  const html      = buildHTML(version, data);
  const pdfBuffer = await convertHTMLtoPDF(html);

  recordStat(from);
  backupData();

  const safeName = (data.nameEnglish || data.nameBangla || "NID").replace(/[/\\?%*:|"<>]/g, "").trim();
  const filename  = `${data.nid || Date.now()} - ${safeName}.pdf`;

  const price  = getSettings().cardPrice || 0;
  const defVer = getUserDefaultVersion(from);

  const captionLines = [
    `✅ NID Card (Version ${version}) তৈরি হয়েছে!`,
    ``,
    `👤 নাম: ${data.nameBangla || data.nameEnglish}`,
    `🆔 NID: ${toBn(data.nid)}`,
    `🎂 DOB: ${data.dob}`,
    price > 0 ? `💰 Remaining: ${getUserBalance(from)} টাকা` : "",
    defVer > 0 ? `⚙️ Default Version: V${defVer}` : "💡 .setversion v1 দিলে পরে auto তৈরি হবে",
  ].filter(Boolean).join("\n");

  const mediaId = await uploadMedia(pdfBuffer, filename, "application/pdf");

  await sendText(from, captionLines);
  await sendDocument(from, mediaId, filename, "");

  clearPending(from);
  console.log(`✅ Card sent to ${from} — V${version} — NID: ${data.nid}`);
}

// ─────────────────── INCOMING MESSAGE HANDLER ──────────────────
async function handleIncoming(msg, contact) {
  const from  = msg.from;
  const msgId = msg.id;

  if (msg.type === "text") {
    const rawText = msg.text.body.trim();
    const text    = rawText.toLowerCase();

    if (text.startsWith(".setversion") || text.startsWith("setversion")) {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      const parts = text.split(/\s+/);
      const arg   = parts[1] || "";
      if (arg === "v1" || arg === "1") {
        setUserDefaultVersion(from, 1);
        return sendText(from, "✅ Default version *V1* সেট হয়েছে!\nএখন থেকে PDF পাঠালে automatically V1 কার্ড তৈরি হবে।\nChange করতে: *.setversion v2* বা *.setversion off*");
      } else if (arg === "v2" || arg === "2") {
        setUserDefaultVersion(from, 2);
        return sendText(from, "✅ Default version *V2* সেট হয়েছে!\nChange করতে: *.setversion v1* বা *.setversion off*");
      } else if (arg === "v3" || arg === "3") {
        setUserDefaultVersion(from, 3);
        return sendText(from, "✅ Default version *V3* সেট হয়েছে!\nChange করতে: *.setversion v1* বা *.setversion off*");
      } else if (arg === "off" || arg === "0") {
        setUserDefaultVersion(from, 0);
        return sendText(from, "✅ Default version *বন্ধ* হয়েছে!\nএখন প্রতিবার PDF পাঠালে V1/V2/V3 choice দেখাবে।");
      } else {
        const cur = getUserDefaultVersion(from);
        return sendText(from,
          `⚙️ *Version সেটিং*\n\nআপনার current default: ${cur > 0 ? `V${cur}` : "বন্ধ (প্রতিবার choice দেখায়)"}\n\nChange করুন:\n• *.setversion v1* → সবসময় V1\n• *.setversion v2* → সবসময় V2\n• *.setversion v3* → সবসময় V3\n• *.setversion off* → প্রতিবার choice দেখাবে`
        );
      }
    }

    if (text === ".ping" || text === "ping") {
      markRead(msgId);
      return sendText(from, "🟢 Pong! Bot সচল আছে।");
    }

    if (text === ".status" || text === "status") {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      const bal    = getUserBalance(from);
      const price  = getSettings().cardPrice || 0;
      const defVer = getUserDefaultVersion(from);
      return sendText(from,
        `✅ Authorized\n💰 Balance: ${bal} টাকা\n💳 Card Price: ${price} টাকা\n⚙️ Default Version: ${defVer > 0 ? `V${defVer}` : "বন্ধ"}\n\nVersion change: *.setversion v1/v2/v3/off*`
      );
    }

    if (text === ".help" || text === "help") {
      markRead(msgId);
      return sendText(from,
        `📋 *Commands*\n\n` +
        `📄 NID PDF পাঠান → কার্ড তৈরি\n` +
        `⚙️ *.setversion v1* → সবসময় V1\n` +
        `⚙️ *.setversion v2* → সবসময় V2\n` +
        `⚙️ *.setversion v3* → সবসময় V3\n` +
        `⚙️ *.setversion off* → প্রতিবার choice\n` +
        `📊 *.status* → balance ও settings\n` +
        `🏓 *.ping* → bot check`
      );
    }

    const vMap = {
      "v1": 1, "1": 1, "ভার্সন ১": 1, "version 1": 1,
      "v2": 2, "2": 2, "ভার্সন ২": 2, "version 2": 2,
      "v3": 3, "3": 3, "ভার্সন ৩": 3, "version 3": 3,
    };
    if (vMap[text] !== undefined) {
      const pending = getPending(from);
      if (!pending) { markRead(msgId); return sendText(from, "❌ কোনো PDF পাওয়া যায়নি। আগে PDF পাঠান।"); }
      if (!isAllowed(from)) { markRead(msgId); return sendText(from, "❌ আপনি authorized নন।"); }
      const price = getSettings().cardPrice || 0;
      if (price > 0 && !deductBalance(from)) { markRead(msgId); return sendText(from, `❌ Balance কম! ${price} টাকা দরকার।`); }
      return processNIDCard(from, pending.data, vMap[text], msgId)
        .catch(e => sendText(from, `❌ Error: ${e.message}`));
    }

    markRead(msgId);
    return sendText(from,
      "📄 NID Card বানাতে আপনার NID PDF পাঠান।\n\n.help — সব commands দেখুন"
    );
  }

  if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
    const buttonId = msg.interactive.button_reply.id;
    const pending  = getPending(from);

    if (!pending) { markRead(msgId); return sendText(from, "❌ Expired! আবার PDF পাঠান।"); }
    if (!isAllowed(from)) { markRead(msgId); return sendText(from, "❌ আপনি authorized নন।"); }

    const price = getSettings().cardPrice || 0;
    if (price > 0 && !deductBalance(from)) {
      markRead(msgId);
      return sendText(from, `❌ Balance কম! ${price} টাকা দরকার।\nBalance: ${getUserBalance(from)} টাকা`);
    }

    const versionMap = { choose_v1: 1, choose_v2: 2, choose_v3: 3 };
    const version    = versionMap[buttonId];
    if (!version) { markRead(msgId); return sendText(from, "❌ অজানা choice।"); }

    return processNIDCard(from, pending.data, version, msgId)
      .catch(e => sendText(from, `❌ Error: ${e.message}`));
  }

  if (msg.type === "document") {
    const doc = msg.document;
    markRead(msgId);

    if (!doc.mime_type?.includes("pdf")) {
      return sendText(from, "❌ শুধু PDF file পাঠাতে হবে।");
    }
    if (!isAllowed(from)) {
      return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");
    }

    const defVersion = getUserDefaultVersion(from);

    try {
      const { buffer } = await downloadMedia(doc.id);
      const data       = await extractNIDFromPDF(buffer);

      if (!data.nid && !data.nameBangla) {
        throw new Error("NID তথ্য extract করা সম্ভব হয়নি।");
      }

      if (defVersion > 0) {
        const price = getSettings().cardPrice || 0;
        if (price > 0 && !deductBalance(from)) {
          return sendText(from, `❌ Balance কম! ${price} টাকা দরকার।`);
        }
        setPending(from, data);
        return processNIDCard(from, data, defVersion, null)
          .catch(e => sendText(from, `❌ Error: ${e.message}`));
      }

      setPending(from, data);
      await sendVersionChoice(from, data.nameBangla || data.nameEnglish || "অজানা", data.nid || "N/A", 0);
    } catch (err) {
      console.error("PDF Process error:", err.message);
      await sendText(from, `❌ Error: ${err.message}\nআবার চেষ্টা করুন।`);
    }
  }
}

// ──────────────────── EXPRESS SERVER ────────────────────────────
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

app.get("/",        (_, res) => res.send("✅ NID Bot is running"));
app.get("/privacy", (_, res) => res.send(`<html><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;">
  <h1>Privacy Policy</h1>
  <p>NID Service Bot processes NID PDFs temporarily and does not store personal data.</p>
</body></html>`));

// ──────────────────── ADMIN PANEL ───────────────────────────────
const adminSessions = new Set();

function adminAuth(req, res, next) {
  const sess = (req.headers.cookie || "")
    .split(";").map(s => s.trim())
    .find(s => s.startsWith("admin_sess="))?.split("=")[1];
  if (sess && adminSessions.has(sess)) return next();
  res.redirect("/admin/login");
}

app.get("/admin/login", (_, res) => {
  res.send(`<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;padding:30px;background:#f5f5f5;border-radius:8px;">
    <h2>🔐 Admin Login</h2>
    <form method="POST" action="/admin/login">
      <input name="password" type="password" placeholder="Password" style="width:100%;padding:10px;margin:10px 0;" required/>
      <button style="width:100%;padding:10px;background:#0078d4;color:#fff;border:0;border-radius:4px;cursor:pointer;">Login</button>
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
    const s   = stats[normalizeNumber(u.number)] || { count: 0, lastUsed: "—" };
    const def = u.defaultVersion > 0 ? `V${u.defaultVersion}` : "—";
    return `<tr>
      <td>${u.number}</td>
      <td>${u.name || "—"}</td>
      <td style="color:${(u.balance||0) < 0 ? 'red':'green'};font-weight:bold">${u.balance||0} ৳</td>
      <td>${u.active !== false ? "✅":"❌"}</td>
      <td style="font-weight:bold;color:#0078d4">${def}</td>
      <td>${s.count}</td>
      <td style="font-size:11px">${s.lastUsed||"—"}</td>
      <td>
        <form method="POST" action="/admin/recharge" style="display:inline;white-space:nowrap">
          <input type="hidden" name="number" value="${u.number}"/>
          <input name="amount" placeholder="টাকা" type="number" style="width:65px;padding:3px" required/>
          <button name="type" value="add"    style="background:#28a745;color:#fff;border:0;padding:4px 8px;border-radius:3px;cursor:pointer">+Add</button>
          <button name="type" value="remove" style="background:#dc3545;color:#fff;border:0;padding:4px 8px;border-radius:3px;cursor:pointer">-Remove</button>
        </form>
        <form method="POST" action="/admin/setversion" style="display:inline;white-space:nowrap">
          <input type="hidden" name="number" value="${u.number}"/>
          <select name="version" style="padding:3px">
            <option value="0" ${!u.defaultVersion||u.defaultVersion===0?'selected':''}>Auto</option>
            <option value="1" ${u.defaultVersion===1?'selected':''}>V1</option>
            <option value="2" ${u.defaultVersion===2?'selected':''}>V2</option>
            <option value="3" ${u.defaultVersion===3?'selected':''}>V3</option>
          </select>
          <button style="padding:4px 8px;cursor:pointer">Set</button>
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
    body{font-family:sans-serif;max-width:1300px;margin:30px auto;padding:20px}
    table{width:100%;border-collapse:collapse;margin:15px 0}
    th,td{border:1px solid #ddd;padding:7px;text-align:left;font-size:12px}
    th{background:#0078d4;color:#fff}
    .card{background:#f9f9f9;padding:15px;margin:10px 0;border-radius:6px;border:1px solid #ddd}
    tr:hover{background:#f5f5f5}
  </style></head><body>
    <h1>📊 NID Bot Admin Panel</h1>
    <div style="text-align:right"><a href="/admin/logout">Logout</a></div>

    <div class="card">
      <h3>⚙️ Settings</h3>
      <form method="POST" action="/admin/settings">
        Card Price (৳): <input name="cardPrice" value="${settings.cardPrice||0}" style="width:80px" type="number"/>
        <button>Save</button>
      </form>
    </div>

    <div class="card">
      <h3>🕐 Pending Version Choice (${pendingChoices.size})</h3>
      <ul>${pendingList}</ul>
    </div>

    <div class="card">
      <h3>➕ Add User</h3>
      <form method="POST" action="/admin/add">
        <input name="number" placeholder="880XXXXXXXXXX" required/>
        <input name="name"   placeholder="Name"/>
        <input name="balance" placeholder="Balance" value="0" type="number" style="width:80px"/>
        <select name="defaultVersion">
          <option value="0">Auto (choice দেখাবে)</option>
          <option value="1">V1 Default</option>
          <option value="2">V2 Default</option>
          <option value="3">V3 Default</option>
        </select>
        <button>Add</button>
      </form>
    </div>

    <div class="card">
      <form method="POST" action="/admin/backup" style="display:inline">
        <button style="background:#17a2b8;color:#fff;border:0;padding:8px 16px;border-radius:4px;cursor:pointer">☁️ MongoDB Backup</button>
      </form>
    </div>

    <h3>👥 Users (${users.length})</h3>
    <table>
      <tr><th>Number</th><th>Name</th><th>Balance</th><th>Active</th><th>Default Ver</th><th>Cards</th><th>Last Used</th><th>Actions</th></tr>
      ${rows}
    </table>
  </body></html>`);
});

app.post("/admin/add", adminAuth, (req, res) => {
  const users = getUsers();
  const { number, name, balance, defaultVersion } = req.body;
  const n = normalizeNumber(number);
  if (!users.find(u => normalizeNumber(u.number) === n)) {
    users.push({
      number: n, name: name||"",
      balance: parseFloat(balance)||0,
      active: true,
      defaultVersion: parseInt(defaultVersion)||0,
    });
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

app.post("/admin/setversion", adminAuth, (req, res) => {
  const users = getUsers();
  const i = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(req.body.number));
  if (i !== -1) {
    users[i].defaultVersion = parseInt(req.body.version) || 0;
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

function cleanupOldFiles() {
  try {
    const tenMin = 10 * 60 * 1000;
    fs.readdirSync(CONFIG.STORAGE_DIR).forEach(f => {
      const fp = path.join(CONFIG.STORAGE_DIR, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > tenMin) fs.unlinkSync(fp);
    });
  } catch {}
}

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
  try {
    await restoreData();
  } catch(e) { console.error("Restore failed:", e.message); }
  cleanupOldFiles();

  app.listen(CONFIG.PORT, "0.0.0.0", () => {
    console.log(`🚀 NID Bot running on port ${CONFIG.PORT}`);
  });
})();
