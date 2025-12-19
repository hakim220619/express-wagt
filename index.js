const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");
const puppeteer = require("puppeteer");
const multer = require("multer");
const { rimraf } = require("rimraf");

const app = express();
const port = 9000;

app.use(cors());
app.use(express.json());

let clients = {};
let sessionStatus = {};

function generateRandomString(length = 30) {
  return crypto.randomBytes(length).toString("hex").slice(0, length);
}

function setSessionStatus(sessionId, next) {
  sessionStatus[sessionId] = {
    ...(sessionStatus[sessionId] || {}),
    ...next,
    updatedAt: new Date().toISOString(),
  };
}

const puppeteerOptions = {
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--single-process",
    "--no-zygote",
    "--disable-gpu",
  ],
};

function initializeClient(sessionId, sessionPath) {
  return new Promise((resolve, reject) => {
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: sessionPath }),
      puppeteer: { headless: true, args: puppeteerOptions.args },
    });

    client.on("qr", async (qr) => {
      try {
        const qrBase64 = await qrcode.toDataURL(qr);
        setSessionStatus(sessionId, { status: "qr", qr: qrBase64 });
        resolve({ qr: qrBase64, status: "qr" });
      } catch (err) {
        setSessionStatus(sessionId, { status: "error", message: err?.message || String(err) });
        reject(err);
      }
    });

    client.on("ready", () => {
      console.log(`Client ${sessionId} ready`);
      setSessionStatus(sessionId, {
        status: "ready",
        userInfo: client?.info
          ? { number: client.info.wid?.user, name: client.info.pushname || "N/A" }
          : null,
      });
    });

    client.on("authenticated", () => {
      console.log(`Client ${sessionId} authenticated`);
      setSessionStatus(sessionId, { status: "authenticated" });
    });

    client.on("auth_failure", (msg) => {
      console.error(`Auth failure for ${sessionId}:`, msg);
      const err = new Error(`Auth failed: ${msg}`);
      setSessionStatus(sessionId, { status: "error", message: err.message });
      reject(err);
    });

    client.on("disconnected", (reason) => {
      console.log(`Client ${sessionId} disconnected`, reason);
      client.destroy();
      delete clients[sessionId];
      setSessionStatus(sessionId, { status: "disconnected", reason });
    });

    setSessionStatus(sessionId, { status: "initializing" });
    client.initialize();
    clients[sessionId] = client;
  });
}

app.post("/start-session", async (req, res) => {
  try {
    const { sessionName } = req.body;
    if (!sessionName)
      return res.status(400).json({ status: false, message: "Session name is required." });

    // Make sessionId stable and equal to auth folder name (so reconnect/list-sessions can match)
    const sessionId = `${sessionName}_${generateRandomString(12)}`;
    const sessionPath = path.join(__dirname, ".wwebjs_auth", sessionId);

    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    console.log(`Initializing session: ${sessionName} with ID: ${sessionId}`);
    const qrCode = await initializeClient(sessionId, sessionPath);

    res.json({ status: true, sessionId, sessionName, qr: qrCode.qr });
  } catch (error) {
    console.error("Error creating session:", error);
    res.status(500).json({ status: false, message: error.message });
  }
});

const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (["image/jpeg", "image/png", "application/pdf"].includes(file.mimetype)) cb(null, true);
    else cb(new Error("Format file tidak diizinkan"));
  },
});

app.post("/send-message", upload.single("file"), async (req, res) => {
  const { sessionId, number, message, buttons } = req.body;

  if (!sessionId || !number)
    return res.status(400).json({ status: false, message: "Session ID dan nomor harus disertakan" });

  if (!clients[sessionId])
    return res.status(404).json({ status: false, message: "Session ID tidak ditemukan atau tidak terhubung" });

  const client = clients[sessionId];
  try {
    const chatId = `${number}@c.us`;

    if (req.file) {
      const media = new MessageMedia(req.file.mimetype, req.file.buffer.toString("base64"), req.file.originalname);
      await client.sendMessage(chatId, media, { caption: message || "" });
    } else if (buttons && Array.isArray(buttons) && buttons.length > 0) {
      const buttonMessage = {
        header: { text: "Pilih opsi:" },
        footer: message || "",
        buttons: buttons.map((b) => ({ buttonId: b.id, buttonText: { displayText: b.text } })),
        type: 1,
      };
      await client.sendMessage(chatId, buttonMessage);
    } else if (message) {
      await client.sendMessage(chatId, message);
    } else {
      return res.status(400).json({ status: false, message: "Pesan atau file harus disertakan" });
    }

    res.status(200).json({ status: true, message: "Pesan berhasil dikirim" });
  } catch (error) {
    res.status(500).json({ status: false, message: "Gagal mengirim pesan", error: error.message });
  }
});

app.get("/check-session/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;
  const client = clients[sessionId];
  const status = sessionStatus[sessionId];

  if (status?.status === "ready" || (client?.info && status?.status === "authenticated")) {
    return res.status(200).json({
      status: true,
      message: "Sesi tersedia dan siap digunakan",
      sessionId,
      sessionStatus: status,
      userInfo: client?.info
        ? { number: client.info.wid?.user, name: client.info.pushname || "N/A" }
        : status?.userInfo || null,
    });
  } else {
    return res.status(400).json({ status: false, message: "Sesi tidak siap", sessionId, sessionStatus: status || null });
  }
});

app.post("/reconnect-session", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ status: false, message: "Session ID wajib" });

  const sessionPath = path.join(__dirname, ".wwebjs_auth", sessionId);
  if (!fs.existsSync(sessionPath))
    return res.status(404).json({ status: false, message: "Session ID tidak ditemukan di folder .wwebjs_auth" });

  if (clients[sessionId]) {
    clients[sessionId].destroy();
    delete clients[sessionId];
  }

  setSessionStatus(sessionId, { status: "reconnecting" });
  initializeClient(sessionId, sessionPath)
    .then((r) => setSessionStatus(sessionId, r))
    .catch((e) => setSessionStatus(sessionId, { status: "error", message: e.message }));

  return res.status(202).json({
    status: true,
    message: "Proses reconnect dimulai. Silakan periksa status beberapa saat lagi.",
  });
});

app.get("/session-status/:id", (req, res) => {
  const status = sessionStatus[req.params.id];
  if (!status) return res.status(404).json({ status: false, message: "Belum ada status untuk session ini" });
  res.json({ status: true, sessionStatus: status });
});

app.get("/list-sessions", (req, res) => {
  const authFolderPath = path.join(__dirname, ".wwebjs_auth");
  if (!fs.existsSync(authFolderPath)) return res.json({ sessions: [], authFiles: [] });
  fs.readdir(authFolderPath, (err, files) => {
    if (err) return res.status(500).json({ error: "Gagal membaca folder .wwebjs_auth." });

    const sessionList = Object.keys(clients).map((id) => ({
      sessionId: id,
      number: clients[id].info ? clients[id].info.wid.user : "N/A",
      name: clients[id].info ? clients[id].info.pushname : "N/A",
      status: sessionStatus[id]?.status || "unknown",
    }));

    res.json({ sessions: sessionList, authFiles: files });
  });
});

app.post("/disconnect-session", async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId)
    return res.status(400).json({ status: false, message: "Session ID harus disertakan" });

  if (!clients[sessionId])
    return res.status(404).json({ status: false, message: "Session ID tidak ditemukan atau tidak terhubung" });

  const client = clients[sessionId];
  try {
    await client.destroy();
    delete clients[sessionId];
    res.status(200).json({ status: true, message: `Sesi ${sessionId} berhasil diputuskan.` });
  } catch (error) {
    res.status(500).json({ status: false, message: "Gagal memutuskan sambungan", error: error.message });
  }
});

app.delete("/delete-auth-file/:fileName", async (req, res) => {
  const filePath = path.join(__dirname, ".wwebjs_auth", req.params.fileName);
  try {
    await rimraf(filePath);
    res.json({ message: `File ${req.params.fileName} berhasil dihapus.` });
  } catch (err) {
    res.status(500).json({ error: "Gagal menghapus file. Pastikan file tidak digunakan." });
  }
});

app.get("/list-groups/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  if (!clients[sessionId])
    return res.status(404).json({ status: false, message: "Session ID tidak ditemukan atau tidak terhubung" });

  const client = clients[sessionId];
  try {
    const chats = await client.getChats();
    const groups = chats.filter((c) => c.isGroup).map((g) => ({
      id: g.id._serialized,
      name: g.name,
      participants: g.participants.length,
    }));

    res.status(200).json({ status: true, message: "Daftar grup berhasil diambil", groups });
  } catch (error) {
    res.status(500).json({ status: false, message: "Gagal mengambil daftar grup", error: error.message });
  }
});

const { resolve } = require("path");
app.get("/", (req, res) => res.sendFile(resolve(__dirname, "index.html")));

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on localhost:${port}`);
});
