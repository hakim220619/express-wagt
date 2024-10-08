const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
const port = 3000;

// Middleware untuk mengizinkan semua origin
app.use(cors());
// Middleware untuk parsing JSON
app.use(express.json());

// Variabel global untuk menyimpan instance client
let clients = {};

// Fungsi untuk menghasilkan string acak sepanjang 30 karakter
function generateRandomString(length = 30) {
  return crypto.randomBytes(length).toString("hex").slice(0, length);
}

// Fungsi untuk menginisialisasi client
function initializeClient(sessionId, sessionPath) {
  return new Promise((resolve, reject) => {
    const client = new Client({
      authStrategy: new LocalAuth({
          dataPath: sessionPath, // Path to store session data
      }),
      puppeteer: {
          headless: true,
          executablePath: '/usr/bin/chromium-browser',
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
  });

    client.on("qr", async (qr) => {
      try {
        // Convert QR code to base64
        const qrBase64 = await qrcode.toDataURL(qr);
        resolve({ qr: qrBase64, status: 'qr' }); // Resolve dengan QR code dalam base64
      } catch (err) {
        reject(err);
      }
    });

    client.on("ready", () => {
      console.log(`Client with session ID ${sessionId} is ready!`);
      resolve({ status: 'ready' });
    });

    client.on("authenticated", () => {
      console.log(`Client with session ID ${sessionId} authenticated!`);
    });

    client.on("auth_failure", (msg) => {
      console.error(`Authentication failed for session ID ${sessionId}:`, msg);
      reject(new Error(`Authentication failed: ${msg}`));
    });

    client.on("disconnected", (reason) => {
      console.log(`Client with session ID ${sessionId} was logged out`, reason);
      client.destroy();
      delete clients[sessionId]; // Hapus client dari pool
    });

    client.initialize();
    clients[sessionId] = client;
  });
}

app.post("/start-session", async (req, res) => {
  try {
    const sessionId = generateRandomString();
    const sessionPath = path.join(__dirname, ".wwebjs_auth", sessionId);

    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const qrCode = await initializeClient(sessionId, sessionPath);
    res.json({ sessionId, qr: qrCode.qr }); // Mengirimkan QR code dalam base64
  } catch (error) {
    res.status(500).json({ status: false, message: error.message });
  }
});

// Endpoint untuk mengirim pesan menggunakan sesi tertentu
app.post("/send-message", async (req, res) => {
  const { sessionId, number, message } = req.body;

  if (!sessionId || !number || !message) {
    return res.status(400).json({
      status: false,
      message: "Session ID, nomor, dan pesan harus disertakan",
    });
  }

  if (!clients[sessionId]) {
    return res.status(404).json({
      status: false,
      message: "Session ID tidak ditemukan atau tidak terhubung",
    });
  }

  const client = clients[sessionId];

  try {
    // Nomor harus dalam format internasional tanpa tanda +, misalnya: 6281234567890
    const chatId = `${number}@c.us`;

    await client.sendMessage(chatId, message);

    res.status(200).json({
      status: true,
      message: "Pesan berhasil dikirim",
    });
  } catch (error) {
    console.error("Error saat mengirim pesan:", error);
    res.status(500).json({
      status: false,
      message: "Gagal mengirim pesan",
      error: error.message,
    });
  }
});

// Endpoint untuk memeriksa status koneksi dari sesi tertentu
app.get("/check-session/:sessionId", (req, res) => {
  const { sessionId } = req.params;

  if (!clients[sessionId]) {
    return res.status(404).json({
      status: false,
      message: "Session ID tidak ditemukan atau tidak terhubung",
    });
  }

  const client = clients[sessionId];

  if (client.info && client.info.wid) {
    // Jika client sudah siap dan terhubung, kirim nomor dan nama pengguna
    const userNumber = client.info.wid.user; // Ambil hanya nomor
    const userName = client.info.pushname;

    return res.status(200).json({
      status: true,
      message: "Client is connected",
      number: userNumber, // Nomor telepon hanya angka
      name: userName,
    });
  } else {
    // Jika client tidak terhubung atau sedang terputus
    return res.status(200).json({
      status: false,
      message: "Client is disconnected or not ready",
    });
  }
});

// Endpoint untuk reconnect manual
app.post("/reconnect-session", async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({
      status: false,
      message: "Session ID harus disertakan",
    });
  }

  const sessionPath = path.join(__dirname, ".wwebjs_auth", sessionId);

  // Cek apakah folder untuk sessionId tersebut ada
  if (!fs.existsSync(sessionPath)) {
    return res.status(404).json({
      status: false,
      message: "Session ID tidak ditemukan di folder .wwebjs_auth",
    });
  }

  // Jika client sudah ada di memory, hapus client yang ada sebelum reconnect
  if (clients[sessionId]) {
    clients[sessionId].destroy();
    delete clients[sessionId];
  }

  try {
    // Inisialisasi ulang client dan cek hasilnya
    const result = await initializeClient(sessionId, sessionPath);

    if (result.status === 'ready') {
      return res.status(200).json({
        status: true,
        message: `Reconnect berhasil untuk session ${sessionId} dan klien siap digunakan.`,
      });
    } else if (result.status === 'qr') {
      return res.status(200).json({
        status: true,
        message: `Reconnect berhasil untuk session ${sessionId}. QR code dihasilkan.`,
        qr: result.qr // Kirim QR code jika dihasilkan
      });
    }
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: `Gagal reconnect untuk session ${sessionId}`,
      error: error.message,
    });
  }
});

// Endpoint untuk mendapatkan daftar sesi yang aktif
app.get("/list-sessions", (req, res) => {
  const sessionList = Object.keys(clients).map((sessionId) => {
    const client = clients[sessionId];
    return {
      sessionId: sessionId,
      number: client.info ? client.info.wid.user : "N/A",
      name: client.info ? client.info.pushname : "N/A"
    };
  });

  res.json(sessionList);
});

// Endpoint untuk serve file index.html
const { resolve } = require('path');
app.get("/", (req, res) => {
  res.sendFile(resolve(__dirname, "index.html"));
});

// Menjalankan server di port yang ditentukan
app.listen(port, () => {
  console.log(`Server berjalan di http://localhost:${port}`);
});
