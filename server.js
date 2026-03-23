"use strict";

/**
 * Al Burhan Messenger — Baileys Edition
 * - Multi-user: each browser session gets its own WhatsApp connection
 * - No Chromium, no Puppeteer — Baileys uses WebSocket directly
 * - 100% in-memory: no database, no file storage for campaign data
 * - CSV parsed in RAM, used, then discarded
 */

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");
const { parse } = require("csv-parse/sync");
const { v4: uuid } = require("uuid");
const pino = require("pino");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const logger = pino({ level: "silent" });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────
//  BAILEYS — loaded once via dynamic import (it's an ESM package)
// ─────────────────────────────────────────
let makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore;

async function loadBaileys() {
  const B = await import("@whiskeysockets/baileys");
  makeWASocket = B.default;
  useMultiFileAuthState = B.useMultiFileAuthState;
  DisconnectReason = B.DisconnectReason;
  fetchLatestBaileysVersion = B.fetchLatestBaileysVersion;
  makeCacheableSignalKeyStore = B.makeCacheableSignalKeyStore;
}

// ─────────────────────────────────────────
//  BUILT-IN TEMPLATES (read-only, in-memory)
// ─────────────────────────────────────────
const TEMPLATES = [
  {
    id: "t1",
    name: "Welcome Message",
    body: "Hello {{name}}! 👋 Welcome to Al Burhan. We are happy to have you with us. Feel free to reach out anytime.",
  },
  {
    id: "t2",
    name: "Registration Message",
    body: "Thank you, {{name}}, for showing your interest in the Al-Burhan Ilm-e-Deen course. Please use the link below to register. Once registered, our IT team will contact you shortly. Apply: albn.org/apply",
  },
  {
    id: "t3",
    name: "Appointment Reminder",
    body: "Hello {{name}}, this is a reminder about your upcoming appointment. Please confirm by replying YES or contact us to reschedule.",
  },
  {
    id: "t4",
    name: "Follow-up",
    body: "Hi {{name}}, hope you are doing well! We wanted to follow up and see if you need any assistance. We are here to help.",
  },
  {
    id: "t5",
    name: "Payment Reminder",
    body: "Dear {{name}}, this is a friendly reminder that your payment is due soon. Please contact us if you have any questions.",
  },
  {
    id: "t6",
    name: "Thank You",
    body: "Dear {{name}}, thank you for your trust in Al Burhan! We truly appreciate your support. 🙏",
  },
];

// ─────────────────────────────────────────
//  SESSION STORE
// ─────────────────────────────────────────
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      sock: null,
      status: "disconnected",
      qr: null,
      campaigns: [],
      activeJob: null,
      phone: null,
    });
  }
  return sessions.get(id);
}

// ─────────────────────────────────────────
//  BAILEYS CLIENT BUILDER
// ─────────────────────────────────────────
async function buildClient(sessionId) {
  const session = getSession(sessionId);

  if (session.sock) {
    try {
      session.sock.end();
    } catch (_) {}
    session.sock = null;
  }

  session.status = "initializing";
  session.qr = null;

  const authDir = path.join(__dirname, ".wa_sessions", sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ["Al Burhan Messenger", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  session.sock = sock;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.status = "qr_ready";
      session.qr = await qrcode.toDataURL(qr);
      console.log(`[${sessionId.slice(0, 8)}] QR ready`);
    }

    if (connection === "open") {
      session.status = "connected";
      session.qr = null;
      session.phone = sock.user?.id?.split(":")[0] || null;
      console.log(`[${sessionId.slice(0, 8)}] Connected ✅  ${session.phone}`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason;

      console.log(`[${sessionId.slice(0, 8)}] Disconnected — code ${code}`);

      if (code === reason.loggedOut) {
        session.status = "disconnected";
        session.qr = null;
        session.phone = null;
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
        } catch (_) {}
        return;
      }

      if (code !== reason.connectionClosed) {
        session.status = "connecting";
        setTimeout(() => buildClient(sessionId), 3000);
      } else {
        session.status = "disconnected";
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function speedMs(speed) {
  if (speed === "fast") return 600 + Math.random() * 800;
  if (speed === "medium") return 1500 + Math.random() * 2500;
  return 3500 + Math.random() * 4500;
}

function personalise(msg, contact) {
  return msg
    .replace(/\{\{name\}\}/gi, contact.name || "")
    .replace(/\{\{phone\}\}/gi, contact.phone || "")
    .replace(/\{\{group\}\}/gi, contact.group || "");
}

function parseCSV(buffer) {
  const text = buffer.toString("utf8");
  let rows;
  try {
    rows = parse(text, {
      columns: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
    });
  } catch (e) {
    throw new Error("Could not parse CSV: " + e.message);
  }

  const contacts = [];
  for (const row of rows) {
    const norm = {};
    for (const [k, v] of Object.entries(row)) {
      norm[k.toLowerCase().trim()] = (v || "").trim();
    }

    const phone =
      norm.phone ||
      norm.mobile ||
      norm.number ||
      norm.tel ||
      norm.whatsapp ||
      "";
    if (!phone) continue;

    let clean = phone.replace(/[^\d+]/g, "").replace(/(?!^\+)\+/g, "");
    if (clean.length < 7) continue;

    // Normalize to international format with 92 prefix
    if (clean.startsWith("+")) {
      clean = clean.slice(1); // strip leading +
    } else if (clean.startsWith("0092")) {
      clean = clean.slice(4); // 0092xxx → xxx
      clean = "92" + clean;
    } else if (clean.startsWith("92") && clean.length >= 12) {
      // already correct, leave as-is
    } else if (clean.startsWith("0") && clean.length >= 10) {
      clean = "92" + clean.slice(1); // 03xx → 923xx
    } else if (!clean.startsWith("92")) {
      clean = "92" + clean; // bare number, prepend 92
    }
    const name =
      norm.name ||
      norm["full name"] ||
      norm.fullname ||
      norm["first name"] ||
      norm.firstname ||
      norm.contact ||
      "";
    const group = norm.group || norm.category || norm.list || "Imported";

    contacts.push({ id: uuid(), name, phone: clean, group });
  }

  return contacts;
}

function sid(req) {
  return (
    req.query.sessionId || req.body?.sessionId || req.headers["x-session-id"]
  );
}

// ─────────────────────────────────────────
//  API ROUTES
// ─────────────────────────────────────────

app.get("/health", (_, res) => res.json({ ok: true, sessions: sessions.size }));

app.get("/api/templates", (_, res) => {
  res.set("Cache-Control", "no-store");
  res.json(TEMPLATES);
});

app.get("/api/wa/status", (req, res) => {
  const id = sid(req);
  if (!id) return res.status(400).json({ error: "sessionId required" });
  const s = getSession(id);
  res.json({ status: s.status, qr: s.qr, phone: s.phone });
});

app.post("/api/wa/connect", async (req, res) => {
  const id = sid(req);
  if (!id) return res.status(400).json({ error: "sessionId required" });
  const s = getSession(id);
  if (s.status === "connected") return res.json({ ok: true });
  await buildClient(id);
  res.json({ ok: true });
});

app.post("/api/wa/disconnect", async (req, res) => {
  const id = sid(req);
  if (!id) return res.status(400).json({ error: "sessionId required" });
  const s = getSession(id);

  if (s.sock) {
    try {
      await s.sock.logout();
    } catch (_) {}
    try {
      s.sock.end();
    } catch (_) {}
    s.sock = null;
  }

  s.status = "disconnected";
  s.qr = null;
  s.phone = null;

  const authDir = path.join(__dirname, ".wa_sessions", id);
  try {
    fs.rmSync(authDir, { recursive: true, force: true });
  } catch (_) {}

  res.json({ ok: true });
});

app.post("/api/csv/parse", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const contacts = parseCSV(req.file.buffer);
    if (!contacts.length)
      return res.status(400).json({
        error:
          'No valid phone numbers found. Make sure you have a "phone" column with country codes.',
      });
    res.json({
      ok: true,
      total: contacts.length,
      preview: contacts.slice(0, 5),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/campaigns", (req, res) => {
  const id = sid(req);
  if (!id) return res.status(400).json({ error: "sessionId required" });
  const s = getSession(id);
  res.json([...s.campaigns].reverse());
});

app.get("/api/campaigns/:campId", (req, res) => {
  const id = sid(req);
  if (!id) return res.status(400).json({ error: "sessionId required" });
  const s = getSession(id);
  const c = s.campaigns.find((c) => c.id === req.params.campId);
  return c ? res.json(c) : res.status(404).json({ error: "Not found" });
});

app.post("/api/campaigns/start", upload.single("file"), async (req, res) => {
  const id = sid(req);
  if (!id) return res.status(400).json({ error: "sessionId required" });

  const s = getSession(id);
  if (s.status !== "connected")
    return res
      .status(400)
      .json({ error: "WhatsApp is not connected. Please scan the QR first." });
  if (!req.file) return res.status(400).json({ error: "CSV file is required" });
  if (!req.body.message)
    return res.status(400).json({ error: "Message is required" });

  let contacts;
  try {
    contacts = parseCSV(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (!contacts.length)
    return res
      .status(400)
      .json({ error: "No valid phone numbers found in CSV." });

  const campaign = {
    id: uuid(),
    name: req.body.name || "Campaign",
    message: req.body.message,
    speed: req.body.speed || "slow",
    status: "running",
    total: contacts.length,
    sent: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    log: contacts.map((c) => ({
      name: c.name,
      phone: c.phone,
      status: "pending",
    })),
  };

  s.campaigns.push(campaign);
  res.json({ ok: true, id: campaign.id, total: contacts.length });

  const job = { campaignId: campaign.id, abort: false };
  s.activeJob = job;

  (async () => {
    for (let i = 0; i < contacts.length; i++) {
      if (job.abort || campaign.status === "aborted") break;

      const contact = contacts[i];
      const text = personalise(campaign.message, contact);
      const logEntry = campaign.log[i];

      try {
        const jid = contact.phone.replace(/^\+/, "") + "@s.whatsapp.net";
        await s.sock.sendMessage(jid, { text });
        logEntry.status = "sent";
        campaign.sent++;
      } catch (err) {
        console.error(`[SEND] Failed ${contact.phone}: ${err.message}`);
        logEntry.status = "failed";
        campaign.failed++;
      }

      await sleep(speedMs(campaign.speed));
    }

    if (!job.abort) {
      campaign.status = "done";
      campaign.finishedAt = new Date().toISOString();
      console.log(
        `[CAMPAIGN] "${campaign.name}" done. Sent: ${campaign.sent}, Failed: ${campaign.failed}`,
      );
    }

    s.activeJob = null;
  })();
});

app.post("/api/campaigns/:campId/abort", (req, res) => {
  const id = sid(req);
  if (!id) return res.status(400).json({ error: "sessionId required" });
  const s = getSession(id);
  const c = s.campaigns.find((c) => c.id === req.params.campId);
  if (!c) return res.status(404).json({ error: "Not found" });
  c.status = "aborted";
  if (s.activeJob?.campaignId === c.id) s.activeJob.abort = true;
  res.json({ ok: true });
});

app.get("/api/stats", (req, res) => {
  const id = sid(req);
  if (!id) return res.status(400).json({ error: "sessionId required" });
  const s = getSession(id);
  const sent = s.campaigns.reduce((a, c) => a + c.sent, 0);
  const fail = s.campaigns.reduce((a, c) => a + c.failed, 0);
  res.json({
    campaigns: s.campaigns.length,
    totalSent: sent,
    totalFailed: fail,
    deliveryRate: sent ? Math.round(((sent - fail) / sent) * 100) : 0,
  });
});

app.get("*", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);

// ─────────────────────────────────────────
//  BOOT — load Baileys first, then start server
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;

loadBaileys()
  .then(() => {
    app.listen(PORT, () =>
      console.log(
        `\n🟢  Al Burhan Messenger (Baileys)  →  http://localhost:${PORT}\n`,
      ),
    );
  })
  .catch((err) => {
    console.error("Failed to load Baileys:", err);
    process.exit(1);
  });
