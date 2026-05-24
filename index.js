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

  API_EXTRACT_URL: "https://onlinebd.top/api_proxy_server.php",
  SITE_BASE:       "https://dakhila-ldtax-gov-bd.rf.gd",
  ASSETS:          "https://onlinebd.top",

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

function getUserDefaultVersion(number) {
  const u = getUser(number);
  return u ? (u.defaultVersion || 0) : 0;
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

function toBn(num) {
  if (num === undefined || num === null) return "";
  const digits = String(num);
  const bnDigits = {
    '0': '০', '1': '১', '2': '২', '3': '৩', '4': '৪',
    '5': '৫', '6': '৬', '7': '৭', '8': '৮', '9': '৯'
  };
  return digits.replace(/[0-9]/g, d => bnDigits[d]);
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
  return {
    nid: d.nationalId || d.nid || d.NID || d.national_id || "",
    pin: d.pin || "",
    oldNid:
      d.formNo ||
      d.form_number ||
      d.oldNid ||
      d.old_nid ||
      "",
    nameBangla:
      d.nameBn ||
      d.nameBangla ||
      d.name_bn ||
      "",
    nameEnglish:
      d.nameEn ||
      d.nameEnglish ||
      d.name_en ||
      "",
    dob:
      d.dateOfBirth ||
      d.dob ||
      "",
    father:
      d.father ||
      d.fatherName ||
      d.father_name ||
      "",
    mother:
      d.mother ||
      d.motherName ||
      d.mother_name ||
      "",
    spouse:
      d.spouse ||
      d.spouseName ||
      "N/A",
    gender:
      d.gender ||
      "",
    religion:
      d.religion ||
      "",
    birthPlace:
      d.birthPlace ||
      d.birth_place ||
      "",
    bloodGroup:
      d.bloodGroup ||
      d.blood_group ||
      "N/A",
    occupation:
      d.occupation ||
      "N/A",
    education:
      d.education ||
      "N/A",
    voterArea:
      d.voterArea ||
      d.voter_area ||
      d.voterAreaName ||
      "",
    voterNo:
      d.voterNo ||
      d.voter_no ||
      "",
    voterAreaCode:
      d.voterAreaCode ||
      d.voter_area_code ||
      "",
    slNo:
      d.slNo ||
      d.sl_no ||
      "",
    upazilaCode:
      d.upazilaCode ||
      d.upazila_code ||
      "",
    fatherNID:
      d.nidFather ||
      d.fatherNID ||
      d.father_nid ||
      "N/A",
    motherNID:
      d.nidMother ||
      d.motherNID ||
      d.mother_nid ||
      "N/A",
    presentAddress:
      typeof d.presentAddress === "string"
        ? d.presentAddress
        : (d.presentAddress?.addressLine || d.presentAddress?.address || ""),
    permanentAddress:
      typeof d.permanentAddress === "string"
        ? d.permanentAddress
        : (d.permanentAddress?.addressLine || d.permanentAddress?.address || ""),
    photo:
      d.photo ||
      d.userIMG ||
      d.imageUrl12 ||
      "",
    dateOfToday:
      d.dateOfToday ||
      new Date().toLocaleDateString("bn-BD", {
        year: "numeric",
        month: "long",
        day: "numeric"
      })
  };
}

async function extractNIDFromPDF(buffer) {
  try {
    const form = new FormData();
    form.append("pdf", buffer, { 
      filename: "document.pdf",
      contentType: "application/pdf"
    });

    const res = await axios.post(CONFIG.API_EXTRACT_URL, form, {
      headers: form.getHeaders(),
    });

    if (res.data && res.data.success === true) {
      return mapAPIData(res.data.data);
    } else {
      throw new Error(res.data.message || "API থেকে সঠিক রেসপন্স পাওয়া যায়নি।");
    }
  } catch (error) {
    console.error("API Extraction Error:", error.message);
    throw new Error(error.response?.data?.message || error.message || "API থেকে Data Extract করতে সমস্যা হয়েছে।");
  }
}

// ─────────────────────── HTML BUILDERS ────────────────────────

// ─────────────────────── HTML BUILDERS ────────────────────────

function buildHTMLv1(d) {
  const presentAddr   = (d.presentAddress  || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");
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
        @page { size: A4; margin: 0; }
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
        .background { position: relative; width: 100%; height: 100%; }
        .crane { max-width: 100%; height: 100%; }
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
        @media print {
            html, body {
                width: 210mm !important;
                height: 297mm !important;
                background-color: #ffffff !important;
                margin: 0;
                padding: 0;
                -webkit-print-color-adjust: exact;
                color-adjust: exact;
            }
            .no-print { display: none !important; }
            @page { margin-top: 0mm; margin-bottom: 0mm; }
            .printable-container {
                width: 205mm;
                height: 295mm;
                page-break-after: avoid;
                margin: 0mm;
                overflow: hidden;
            }
            .crane { width: 100%; height: 100%; display: block; }
        }
    </style>
</head>
<body style="text-align: center;">
    <div class="printable-container">
        <img class="crane" src="https://dakhila-ldtax-gov-bd.rf.gd/assets/images/server_unofficialV1.jpg" height="1000px" width="750px">

        <div style="position: absolute; left: 30%; top: 8%; width: auto; font-size: 16px; color: rgb(255 224 0);"><b>National Identity Registration Wing (NIDW)</b></div>
        <div style="position: absolute; left: 37%; top: 11%; width: auto; font-size: 14px; color: rgb(255, 47, 161);"><b>Select Your Search Category</b></div>
        <div style="position: absolute; left: 45%; top: 12.8%; width: auto; font-size: 12px; color: rgb(8, 121, 4);">Search By NID / Voter No.</div>
        <div style="position: absolute; left: 45%; top: 14.3%; width: auto; font-size: 12px; color: rgb(7, 119, 184);">Search By Form No.</div>
        <div style="position: absolute; left: 30%; top: 16.9%; width: auto; font-size: 12px; color: rgb(252, 0, 0);"><b>NID or Voter No*</b></div>
        <div style="position: absolute; left: 45%; top: 16.9%; width: auto; font-size: 12px; color: rgb(143, 143, 143);">${d.nid}</div>
        <div style="position: absolute; left: 62.9%; top: 17.1%; width: auto; font-size: 11px; color: rgb(255 255 255);">Submit</div>
        <div style="position: absolute; left: 89%; top: 11.55%; width: auto; font-size: 11px; color: #fff;">Home</div>

        <div style="position: absolute; left: 37%; top: 27%; font-size: 17px;"><b>জাতীয় পরিচিতি তথ্য</b></div>
        <div style="position: absolute; left: 37%; top: 29.7%; font-size: 14px;">জাতীয় পরিচয় পত্র নম্বর</div>
        <div style="position: absolute; left: 55%; top: 29.7%; font-size: 14px;">${d.nid}</div>

        <div style="position: absolute; left: 37%; top: 32.5%; font-size: 14px;">পিন নম্বর</div>
        <div style="position: absolute; left: 55%; top: 32.5%; font-size: 14px;">${d.pin}</div>

        <div style="position: absolute; left: 37%; top: 35%; font-size: 14px;">ফরম নাম্বার</div>
        <div style="position: absolute; left: 55%; top: 35%; font-size: 14px;">${d.oldNid}</div>

        <div style="position: absolute; left: 37%; top: 37.5%; font-size: 14px;">ভোটার নাম্বার</div>
        <div style="position: absolute; left: 55%; top: 37.5%; font-size: 14px;">${d.voterNo}</div>

        <div style="position: absolute; left: 37%; top: 40.2%; font-size: 14px;">ভোটার এলাকা</div>
        <div style="position: absolute; left: 55%; top: 40.2%; font-size: 14px;">${d.voterArea}</div>

        <div style="position: absolute; left: 37%; top: 43%; font-size: 17px;"><b>ব্যক্তিগত তথ্য</b></div>
        <div style="position: absolute; left: 37%; top: 45.6%; font-size: 14px;">নাম (বাংলা)</div>
        <div style="position: absolute; left: 55%; top: 45.6%; font-size: 14px;"><b>${d.nameBangla}</b></div>

        <div style="position: absolute; left: 37%; top: 48.5%; font-size: 14px;">নাম (ইংরেজি)</div>
        <div style="position: absolute; left: 55%; top: 48.5%; font-size: 14px;">${d.nameEnglish}</div>

        <div style="position: absolute; left: 37%; top: 51%; font-size: 14px;">জন্ম তারিখ</div>
        <div style="position: absolute; left: 55%; top: 51%; font-size: 14px;">${d.dob}</div>

        <div style="position: absolute; left: 37%; top: 53.7%; font-size: 14px;">পিতার নাম</div>
        <div style="position: absolute; left: 55%; top: 53.7%; font-size: 14px;">${d.father}</div>

        <div style="position: absolute; left: 37%; top: 56.2%; font-size: 14px;">মাতার নাম</div>
        <div style="position: absolute; left: 55%; top: 56.2%; font-size: 14px;">${d.mother}</div>

        <div style="position: absolute; left: 37%; top: 59%; font-size: 14px;">স্বামী/স্ত্রীর নাম</div>
        <div style="position: absolute; left: 55%; top: 59%; font-size: 14px;">${d.spouse}</div>

        <div style="position: absolute; left: 37%; top: 61.8%; font-size: 17px;"><b>অন্যান্য তথ্য</b></div>

        <div style="position: absolute; left: 37%; top: 65%; font-size: 14px;">লিঙ্গ</div>
        <div style="position: absolute; left: 55%; top: 65%; font-size: 14px;">${d.gender}</div>

        <div style="position: absolute; left: 37%; top: 67.6%; font-size: 14px;">জন্মস্থান</div>
        <div style="position: absolute; left: 55%; top: 67.6%; font-size: 14px;">${d.birthPlace}</div>

        <div style="position: absolute; left: 37%; top: 70.3%; font-size: 14px;">রক্তের গ্রুপ</div>
        <div style="position: absolute; left: 55%; top: 70.3%; font-size: 14px; color: rgb(252, 0, 0);">${d.bloodGroup}</div>

        <div style="position: absolute; left: 37%; top: 72.8%; font-size: 14px;">পেশা</div>
        <div style="position: absolute; left: 55%; top: 72.8%; font-size: 14px;">${d.occupation}</div>

        <div style="position: absolute; left: 37%; top: 75.6%; font-size: 17px;"><b>বর্তমান ঠিকানা</b></div>
        <div style="position: absolute; left: 37%; top: 78.3%; width: 48%; font-size: 13px; text-align: left; white-space: normal;">${presentAddr}</div>

        <div style="position: absolute; left: 37%; top: 84.4%; font-size: 17px;"><b>স্থায়ী ঠিকানা</b></div>
        <div style="position: absolute; left: 37%; top: 87.3%; width: 48%; font-size: 13px; text-align: left; white-space: normal;">${permanentAddr}</div>

        <div style="position: absolute; top: 94.8%; width: 100%; font-size: 14px; text-align: center; color: rgb(255, 0, 0);">উপরে প্রদর্শিত তথ্যসমূহ জাতীয় পরিচয়পত্র সংশ্লিষ্ট, ভোটার তালিকার সাথে সরাসরি সম্পর্কযুক্ত নয়।</div>
        <div style="position: absolute; top: 96.5%; width: 100%; text-align: center; font-size: 12px; color: rgb(3, 3, 3);">This is Software Generated Report From Bangladesh Election Commission, Signature &amp; Seal Aren't Required.</div>

        <div style="position: absolute; left: 16%; top: 25.8%;">
            <img src="${d.photo}" height="140px" width="121px" style="border-radius: 10px;" onerror="this.onerror=null; this.src='https://dakhila-ldtax-gov-bd.rf.gd/assets/media/card/blank.png';">
        </div>

        <div style="position: absolute; left: 17.7%; top: 44.2%;">
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${qrData}" height="95px" width="95px">
        </div>

        <div style="position: absolute; display: flex; font-weight: bold; left: 15.5%; top: 39.8%; height: 32px; width: 130px; font-size: 13px; color: rgb(7, 7, 7); margin: auto; align-items: center;" align="center">
            <div style="flex: 1;">${d.nameEnglish}</div>
        </div>
    </div>
</body>
</html>`;
}

// ── V2: PHP signToServerV2 এর exact structure ──
function buildHTMLv2(d) {
  const A = CONFIG.ASSETS;
  const presentAddr   = (d.presentAddress  || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");
  const permanentAddr = (d.permanentAddress || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");

  return `<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${d.nid} - ${d.nameEnglish}</title>
    <link href="https://fonts.maateen.me/solaiman-lipi/font.css" rel="stylesheet">
    <style>
        @font-face {
            font-family: 'Solaimanlipi';
            src: url('https://fonts.maateen.me/solaiman-lipi/SolaimanLipi.woff2') format('woff2');
        }
        * { box-sizing: border-box; }
        body {
            font-family: 'Solaimanlipi', 'Solaiman Lipi', sans-serif;
            margin: auto;
            padding: 0;
            background-color: #f4f4f9;
            width: 210mm;
        }
        @page { size: 210mm 297mm; margin: 0; }
        @media print {
            * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            body { background: white; margin: 0; padding: 0; }
            .container { margin: 0 !important; }
        }
        .container {
            margin: auto;
            background: white;
            padding-left: 20px;
            padding-right: 20px;
        }
        .header_top {
            text-align: center;
            border-bottom: 1px solid #c2c2c2;
        }
        p.text { line-height: 7px; }
        img#user_img {
            width: 110px;
            margin-top: 10px;
            border-radius: 10px;
            box-shadow: rgba(0, 0, 0, 0.35) 0px 2px 10px;
            height: 120px;
            margin-bottom: 20px;
        }
        .user_photo { text-align: center; }
        .sub_container { margin: 5px 0 !important; padding: 0 10px; }
        .section { margin-bottom: 1px; }
        .section-title {
            font-size: 17px !important;
            font-family: 'Solaimanlipi', sans-serif;
            font-weight: bold;
            background: #bbe6ed;
            color: black;
            padding: 5px;
            margin-bottom: 3px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
        }
        colgroup col { width: 40%; }
        colgroup col:last-child { width: 60%; }
        table, td { border: 1px solid #EAEAEA; }
        td {
            font-size: 14px !important;
            font-family: 'Solaimanlipi', sans-serif;
            padding: 2px 5px !important;
            text-align: left;
        }
        td:first-child { font-weight: Normal; color: #000; }
        strong { font-weight: normal !important; }
        .footer_text { margin-top: 5px !important; }
        #footer_english {
            text-align: center;
            margin-top: -16px;
            font-size: 13px;
            font-weight: bold;
            font-family: Arial;
            letter-spacing: -0.2px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header_top">
                <img src="${A}/assets/server/img/logo-server-copy.svg" alt="" style="width: 50px; margin-top: 10px;" onerror="this.onerror=null; this.src='https://surokkha.gov.bd/favicon.png';">
                <p class="text_one text" style="font-size: 16px;">বাংলাদেশ নির্বাচন কমিশন</p>
                <p class="text_two text" style="font-size: 16px;">নির্বাচন কমিশন সচিবালয়</p>
                <p class="text_three text" style="font-size: 16px; margin-bottom: 10px;">জাতীয় পরিচয় নিবন্ধন অনুবিভাগ</p>
            </div>
            <div class="user_photo">
                <img src="${d.photo}" alt="" id="user_img" onerror="this.onerror=null; this.src='https://dakhila-ldtax-gov-bd.rf.gd/assets/media/card/blank.png';">
            </div>
        </div>
        <div class="sub_container">

            <div class="section">
                <div class="section-title">জাতীয় পরিচিতি তথ্য</div>
                <div class="section-content">
                    <table>
                        <colgroup><col><col></colgroup>
                        <tr><td>জাতীয় পরিচয় পত্র নম্বর</td><td><strong>${d.nid || "N/A"}</strong></td></tr>
                        <tr><td>পিন নম্বর</td><td><strong>${d.pin || "N/A"}</strong></td></tr>
                        <tr><td>ভোটার নম্বর</td><td><strong>${d.voterNo || "N/A"}</strong></td></tr>
                        <tr><td>ভোটার এরিয়া কোড</td><td><strong>${d.voterAreaCode || "N/A"}</strong></td></tr>
                        <tr><td>ভোটার এলাকা</td><td><strong>${d.voterArea || "N/A"}</strong></td></tr>
                        <tr><td>ফরম নম্বর</td><td><strong>${d.oldNid || "N/A"}</strong></td></tr>
                        <tr><td>পিতার এনআইডি</td><td><strong>${d.fatherNID || "N/A"}</strong></td></tr>
                        <tr><td>মাতার এনআইডি</td><td><strong>${d.motherNID || "N/A"}</strong></td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">ব্যক্তিগত তথ্য</div>
                <div class="section-content">
                    <table>
                        <colgroup><col><col></colgroup>
                        <tr><td>নাম (বাংলা)</td><td><strong>${d.nameBangla || "N/A"}</strong></td></tr>
                        <tr><td>নাম (ইংরেজি)</td><td><strong>${d.nameEnglish || "N/A"}</strong></td></tr>
                        <tr><td>জন্ম তারিখ</td><td><strong>${d.dob || "N/A"}</strong></td></tr>
                        <tr><td>পিতার নাম</td><td><strong>${d.father || "N/A"}</strong></td></tr>
                        <tr><td>মাতার নাম</td><td><strong>${d.mother || "N/A"}</strong></td></tr>
                        <tr><td>স্বামী/স্ত্রীর নাম</td><td><strong>${d.spouse || "N/A"}</strong></td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">অন্যান্য তথ্য</div>
                <div class="section-content">
                    <table>
                        <colgroup><col><col></colgroup>
                        <tr><td>রক্তের গ্রুপ</td><td><strong>${d.bloodGroup || "N/A"}</strong></td></tr>
                        <tr><td>পেশা</td><td><strong>${d.occupation || "N/A"}</strong></td></tr>
                        <tr><td>শিক্ষাগত যোগ্যতা</td><td><strong>${d.education || "N/A"}</strong></td></tr>
                        <tr><td>লিঙ্গ</td><td><strong>${d.gender || "N/A"}</strong></td></tr>
                        <tr><td>ধর্ম</td><td><strong>${d.religion || "N/A"}</strong></td></tr>
                        <tr><td>জন্মস্থান</td><td><strong>${d.birthPlace || "N/A"}</strong></td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">বর্তমান ঠিকানা</div>
                <div class="section-content">
                    <table><colgroup><col></colgroup>
                        <tr><td>${presentAddr || "N/A"}</td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">স্থায়ী ঠিকানা</div>
                <div class="section-content">
                    <table><colgroup><col></colgroup>
                        <tr><td>${permanentAddr || "N/A"}</td></tr>
                    </table>
                </div>
            </div>

            <div class="footer_text">
                <p style="text-align: center; color: red;">উপরে প্রদর্শিত তথ্যসমূহ জাতীয় পরিচয়পত্র সংশ্লিষ্ট, ভোটার তালিকার সাথে সরাসরি সম্পর্কযুক্ত নয়।</p>
                <p id="footer_english">This is Software Generated Report From Bangladesh Election Commission, Signature &amp; Seal Aren't Required.</p>
            </div>
        </div>
    </div>
</body>
</html>`;
}

// ── V3: PHP signToServerV3 এর exact structure ──
function buildHTMLv3(d) {
  const A = CONFIG.ASSETS;
  const presentAddr   = (d.presentAddress  || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");
  const permanentAddr = (d.permanentAddress || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${d.nid} - ${d.nameEnglish}</title>
    <link href="https://fonts.maateen.me/solaiman-lipi/font.css" rel="stylesheet">
    <style>
        @font-face {
            font-family: 'Solaimanlipi';
            src: url('https://fonts.maateen.me/solaiman-lipi/SolaimanLipi.woff2') format('woff2');
        }
        * { box-sizing: border-box; }
        body {
            font-family: 'Solaimanlipi', 'Solaiman Lipi', sans-serif;
            margin: auto;
            padding: 0;
            background-color: #f4f4f9;
            width: 210mm;
        }
        @page { size: 210mm 297mm; margin: 0; }
        @media print {
            * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            body { background: white; margin: 0; padding: 0; }
            .container { margin: 0 !important; }
        }
        .container {
            margin: auto;
            background: white;
            padding-left: 20px;
            padding-right: 20px;
        }
        .header_top {
            text-align: center;
            border-bottom: 1px solid #c2c2c2;
        }
        p.text { line-height: 10px; }
        img#user_img {
            width: 110px;
            margin-top: 1px;
            border-radius: 10px;
            box-shadow: rgba(0, 0, 0, 0.35) 0px 2px 10px;
            height: 120px;
        }
        .name {
            border: 1px solid #eaeaea;
            padding: 1px;
            font-size: 15px;
            font-weight: bold;
        }
        .user_photo {
            text-align: center;
            margin-top: 5px;
            background-color: #bbe6ed;
            margin-bottom: 8px;
        }
        .sub_container {
            padding-left: 100px;
            padding-right: 100px;
        }
        .section { background-color: #bbe6ed; }
        .section-title {
            font-size: 17px !important;
            font-family: 'Solaimanlipi', sans-serif;
            font-weight: bold;
            background: #bbe6ed;
            color: black;
            padding: 5px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
        }
        colgroup col { width: 40%; }
        colgroup col:last-child { width: 60%; }
        table, td { border: 1px solid #EAEAEA; }
        td {
            font-size: 14px !important;
            font-family: 'Solaimanlipi', sans-serif;
            padding: 2px 5px !important;
            text-align: left;
        }
        td:first-child { color: #000; font-weight: normal; }
        strong { font-weight: normal !important; }
        .footer_text { margin-top: 15px; }
        #footer_english {
            text-align: center;
            margin-top: -16px;
            font-size: 13px;
            font-weight: bold;
            font-family: Arial;
            letter-spacing: -0.2px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="sub_container">
            <div class="header">
                <div class="header_top">
                    <img src="${A}/assets/server/img/logo-server-copy.svg" alt="" style="width: 50px; margin-top: 10px;" onerror="this.onerror=null; this.src='https://surokkha.gov.bd/favicon.png';">
                    <p class="text_one text" style="font-size: 16px;">বাংলাদেশ নির্বাচন কমিশন</p>
                    <p class="text_two text" style="font-size: 16px;">নির্বাচন কমিশন সচিবালয়</p>
                    <p class="text_three text" style="font-size: 16px; margin-bottom: 10px;">জাতীয় পরিচয় নিবন্ধন অনুবিভাগ</p>
                </div>
                <div class="user_photo">
                    <img src="${d.photo}" alt="" id="user_img" onerror="this.onerror=null; this.src='https://dakhila-ldtax-gov-bd.rf.gd/assets/media/card/blank.png';">
                    <div class="name">${d.nameEnglish}</div>
                </div>
            </div>

            <div class="section">
                <div class="section-title">জাতীয় পরিচিতি তথ্য</div>
                <div class="section-content">
                    <table>
                        <colgroup><col><col></colgroup>
                        <tr><td>জাতীয় পরিচয় পত্র নম্বর</td><td><strong>${d.nid || "N/A"}</strong></td></tr>
                        <tr><td>পিন নম্বর</td><td><strong>${d.pin || "N/A"}</strong></td></tr>
                        <tr><td>পূর্ববর্তী এনআইডি নম্বর</td><td><strong>${d.oldNid || "N/A"}</strong></td></tr>
                        <tr><td>জন্ম নিবন্ধন নম্বর</td><td><strong>${d.voterNo || "N/A"}</strong></td></tr>
                        <tr><td>ভোটার এলাকা</td><td><strong>${d.voterArea || "N/A"}</strong></td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">ব্যক্তিগত তথ্য</div>
                <div class="section-content">
                    <table>
                        <colgroup><col><col></colgroup>
                        <tr><td>নাম (বাংলা)</td><td><strong>${d.nameBangla || "N/A"}</strong></td></tr>
                        <tr><td>নাম (ইংরেজি)</td><td><strong>${d.nameEnglish || "N/A"}</strong></td></tr>
                        <tr><td>জন্ম তারিখ</td><td><strong>${d.dob || "N/A"}</strong></td></tr>
                        <tr><td>পিতার নাম</td><td><strong>${d.father || "N/A"}</strong></td></tr>
                        <tr><td>মাতার নাম</td><td><strong>${d.mother || "N/A"}</strong></td></tr>
                        <tr><td>স্বামী/স্ত্রীর নাম</td><td><strong>${d.spouse || "N/A"}</strong></td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">অন্যান্য তথ্য</div>
                <div class="section-content">
                    <table>
                        <colgroup><col><col></colgroup>
                        <tr><td>পেশা</td><td><strong>${d.occupation || "N/A"}</strong></td></tr>
                        <tr><td>রক্তের গ্রুপ</td><td><strong>${d.bloodGroup || "N/A"}</strong></td></tr>
                        <tr><td>ধর্ম</td><td><strong>${d.religion || "N/A"}</strong></td></tr>
                        <tr><td>লিঙ্গ</td><td><strong>${d.gender || "N/A"}</strong></td></tr>
                        <tr><td>শিক্ষাগত যোগ্যতা</td><td><strong>${d.education || "N/A"}</strong></td></tr>
                        <tr><td>জন্মস্থান</td><td><strong>${d.birthPlace || "N/A"}</strong></td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">বর্তমান ঠিকানা</div>
                <div class="section-content">
                    <table><colgroup><col></colgroup>
                        <tr><td>${presentAddr || "N/A"}</td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">স্থায়ী ঠিকানা</div>
                <div class="section-content">
                    <table><colgroup><col></colgroup>
                        <tr><td>${permanentAddr || "N/A"}</td></tr>
                    </table>
                </div>
            </div>
        </div>

        <div class="footer_text">
            <p style="text-align: center; color: red; font-size: 16px;">উপরে প্রদর্শিত তথ্যসমূহ জাতীয় পরিচয়পত্র সংশ্লিষ্ট, ভোটার তালিকার সাথে সরাসরি সম্পর্কযুক্ত নয়।</p>
            <p id="footer_english">This is Software Generated Report From Bangladesh Election Commission, Signature &amp; Seal Aren't Required.</p>
        </div>
    </div>
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
// Font embed এখন PDF server (pdf-server.js) এ হয়।
// index.js থেকে plain HTML পাঠালেই হবে।
async function convertHTMLtoPDF(html) {
  if (!CONFIG.PDF_API_URL) throw new Error("PDF_API_URL set করা নেই!");

  let res;
  try {
    res = await axios.post(`${CONFIG.PDF_API_URL}/pdf`, {
      secret: CONFIG.PDF_API_SECRET,
      html,
    }, {
      timeout: 90000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      responseType: "arraybuffer",
    });
  } catch (e) {
    throw new Error("PDF server connect error: " + e.message);
  }

  // ✅ arraybuffer → string → JSON parse
  let parsed;
  try {
    const raw = Buffer.from(res.data).toString("utf8");
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("PDF server response parse failed");
  }

  if (!parsed.success) {
    throw new Error("PDF server error: " + (parsed.error || "Unknown"));
  }

  const base64 = parsed.pdf;
  if (!base64 || typeof base64 !== "string") {
    throw new Error("PDF base64 পাওয়া যায়নি");
  }

  // ✅ Decode
  const buffer = Buffer.from(base64, "base64");

  // ✅ Size check
  if (buffer.length !== parsed.size) {
    console.warn(`⚠️ Size mismatch: got ${buffer.length}, expected ${parsed.size}`);
  }

  // ✅ Header check
  const header = buffer.slice(0, 4).toString("ascii");
  if (header !== "%PDF") {
    throw new Error(`Invalid PDF header: "${header}"`);
  }

  console.log("✅ PDF OK — Size:", buffer.length);
  return buffer;
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
