const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cors = require("cors");
const puppeteer = require("puppeteer");
const multer = require("multer");

// Express app setup
const app = express();
const port = 5000;

// Middleware untuk mengizinkan semua origin (CORS)
app.use(cors());
// Middleware untuk parsing JSON
app.use(express.json());

// Variabel global untuk menyimpan instance client
let clients = {};

// Fungsi untuk menghasilkan string acak sepanjang 30 karakter
function generateRandomString(length = 30) {
  return crypto.randomBytes(length).toString("hex").slice(0, length);
}

// Argumen Puppeteer untuk kompatibilitas di berbagai server
const puppeteerOptions = {
  headless: true,
  args: [
    "--no-sandbox", // Nonaktifkan sandboxing untuk kompatibilitas di server
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage", // Kurangi penggunaan shared memory
    "--single-process", // Jalankan dalam mode proses tunggal
    "--no-zygote",
    "--disable-gpu", // Nonaktifkan GPU untuk server tanpa antarmuka grafis
  ],
};

// Fungsi untuk menginisialisasi client
function initializeClient(sessionId, sessionPath) {
  return new Promise((resolve, reject) => {
    const client = new Client({
      authStrategy: new LocalAuth({
        dataPath: sessionPath, // Path untuk menyimpan data sesi
      }),
      puppeteer: {
        headless: true,
        // executablePath: '/usr/bin/chromium-browser',
        args: puppeteerOptions.args, // Argumen Puppeteer yang aman untuk berbagai lingkungan server
      },
    });

    client.on("qr", async (qr) => {
      try {
        // Mengubah QR code menjadi format base64 untuk ditampilkan
        const qrBase64 = await qrcode.toDataURL(qr);
        resolve({ qr: qrBase64, status: "qr" });
      } catch (err) {
        reject(err);
      }
    });

    client.on("ready", () => {
      console.log(`Client dengan Session ID ${sessionId} siap digunakan!`);
      resolve({ status: "ready" });
    });

    client.on("authenticated", () => {
      console.log(
        `Client dengan Session ID ${sessionId} telah terautentikasi!`
      );
    });

    client.on("auth_failure", (msg) => {
      console.error(`Autentikasi gagal untuk Session ID ${sessionId}:`, msg);
      reject(new Error(`Autentikasi gagal: ${msg}`));
    });

    client.on("disconnected", (reason) => {
      console.log(
        `Client dengan Session ID ${sessionId} telah terputus`,
        reason
      );
      client.destroy();
      delete clients[sessionId]; // Hapus client dari pool setelah disconnect
    });

    client.initialize();
    clients[sessionId] = client;
  });
}

app.post("/start-session", async (req, res) => {
  try {
    const { sessionName } = req.body; // Ambil nama session dari request body
    if (!sessionName) {
      return res
        .status(400)
        .json({ status: false, message: "Session name is required." });
    }

    const sessionId = generateRandomString();
    const sessionPath = path.join(
      __dirname,
      ".wwebjs_auth",
      sessionName + "_" + sessionId
    );

    // Cek apakah folder sessionPath ada, jika tidak buat folder baru
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    console.log(`Initializing session: ${sessionName} with ID: ${sessionId}`);

    // Inisialisasi client dan kirim QR code ke client
    const qrCode = await initializeClient(sessionId, sessionPath);

    // Kirim response ke client
    res.json({
      status: true,
      sessionId,
      sessionName,
      qr: qrCode.qr,
    });
  } catch (error) {
    console.error("Error creating session:", error);
    res.status(500).json({ status: false, message: error.message });
  }
});

// Endpoint untuk mengirim pesan menggunakan sesi tertentu
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  storage: multer.memoryStorage(), // Simpan di memory
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === "image/jpeg" ||
      file.mimetype === "image/png" ||
      file.mimetype === "application/pdf"
    ) {
      cb(null, true);
    } else {
      cb(new Error("Format file tidak diizinkan"));
    }
  },
});

app.post("/send-message", upload.single("file"), async (req, res) => {
  const { sessionId, number, message, buttons } = req.body;

  if (!sessionId || !number) {
    return res.status(400).json({
      status: false,
      message: "Session ID dan nomor harus disertakan",
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
    const chatId = `${number}@c.us`;

    if (req.file) {
      const media = new MessageMedia(req.file.mimetype, req.file.buffer.toString("base64"), req.file.originalname);
      await client.sendMessage(chatId, media, { caption: message || "" });
    } else if (buttons && Array.isArray(buttons) && buttons.length > 0) {
      const buttonMessage = {
        header: { text: "Pilih opsi:" },
        footer: message || "",
        buttons: buttons.map((button) => ({
          buttonId: button.id,
          buttonText: { displayText: button.text },
        })),
        type: 1,
      };

      console.log("Button Message:", JSON.stringify(buttonMessage, null, 2));
      await client.sendMessage(chatId, buttonMessage);
    } else if (message) {
      await client.sendMessage(chatId, message);
    } else {
      return res.status(400).json({
        status: false,
        message: "Pesan atau file harus disertakan",
      });
    }

    res.status(200).json({
      status: true,
      message: "Pesan berhasil dikirim",
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      message: "Gagal mengirim pesan",
      error: error.message,
    });
  }
});


app.get("/check-session/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;

  const client = clients[sessionId];

  // Check if the client is ready
  if (client.info && client.ready) {
    return res.status(200).json({
      status: true,
      message: "Sesi tersedia dan siap digunakan",
      sessionId: sessionId,
      userInfo: {
        number: client.info.wid.user,
        name: client.info.pushname || "N/A",
      },
    });
  } else {
    return res.status(400).json({
      status: false,
      message: "Sesi tidak siap",
      sessionId: sessionId,
    });
  }
});
// Endpoint 1: Trigger reconnect secara async
app.post("/reconnect-session", async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) return res.status(400).json({ status: false, message: "Session ID wajib" });

  const sessionPath = path.join(__dirname, ".wwebjs_auth", sessionId);

  if (!fs.existsSync(sessionPath)) {
    return res.status(404).json({
      status: false,
      message: "Session ID tidak ditemukan di folder .wwebjs_auth",
    });
  }

  // Destroy client lama jika ada
  if (clients[sessionId]) {
    clients[sessionId].destroy();
    delete clients[sessionId];
  }

  // Trigger proses async
  initializeClient(sessionId, sessionPath)
    .then((result) => {
      // Simpan status di memori atau database
      sessionStatus[sessionId] = result;
    })
    .catch((error) => {
      sessionStatus[sessionId] = { status: "error", message: error.message };
    });

  // Segera response ke client
  return res.status(202).json({
    status: true,
    message: "Proses reconnect dimulai. Silakan periksa status beberapa saat lagi.",
  });
});

// Endpoint 2: Cek status session
app.get("/session-status/:id", (req, res) => {
  const sessionId = req.params.id;
  const status = sessionStatus[sessionId];

  if (!status) {
    return res.status(404).json({ status: false, message: "Belum ada status untuk session ini" });
  }

  return res.json({ status: true, sessionStatus: status });
});

// Endpoint untuk mendapatkan daftar sesi aktif dan isi folder .wwebjs_auth
app.get("/list-sessions", (req, res) => {
  // Membaca isi folder .wwebjs_auth
  const authFolderPath = path.join(__dirname, ".wwebjs_auth");

  fs.readdir(authFolderPath, (err, files) => {
    if (err) {
      return res
        .status(500)
        .json({ error: "Gagal membaca folder .wwebjs_auth." });
    }

    // Mapping daftar sesi
    const sessionList = Object.keys(clients).map((sessionId) => {
      const client = clients[sessionId];

      return {
        sessionId: sessionId,
        number: client.info ? client.info.wid.user : "N/A",
        name: client.info ? client.info.pushname : "N/A",
      };
    });

    // Menggabungkan data sesi dan isi folder
    res.json({
      sessions: sessionList,
      authFiles: files,
    });
  });
});

// Endpoint untuk memutuskan sambungan sesi
app.post("/disconnect-session", async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({
      status: false,
      message: "Session ID harus disertakan",
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
    await client.destroy(); // Memutuskan sambungan client
    delete clients[sessionId]; // Menghapus client dari pool
    res.status(200).json({
      status: true,
      message: `Sesi ${sessionId} berhasil diputuskan.`,
    });
  } catch (error) {
    console.error("Error saat memutuskan sambungan:", error);
    res.status(500).json({
      status: false,
      message: "Gagal memutuskan sambungan",
      error: error.message,
    });
  }
});

// Endpoint untuk menghapus file autentikasi
const { rimraf } = require("rimraf"); // Import dengan CommonJS

// Endpoint untuk menghapus file autentikasi
app.delete("/delete-auth-file/:fileName", async (req, res) => {
  const fileName = req.params.fileName;
  const filePath = path.join(__dirname, ".wwebjs_auth", fileName);

  try {
    await rimraf(filePath); // Menghapus file secara async
    res.json({ message: `File ${fileName} berhasil dihapus.` });
  } catch (err) {
    console.error(`Gagal menghapus file ${fileName}:`, err);
    res
      .status(500)
      .json({ error: "Gagal menghapus file. Pastikan file tidak digunakan." });
  }
});

// Endpoint untuk mendapatkan daftar grup dari sesi tertentu
app.get("/list-groups/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  if (!clients[sessionId]) {
    return res.status(404).json({
      status: false,
      message: "Session ID tidak ditemukan atau tidak terhubung",
    });
  }

  const client = clients[sessionId];

  try {
    const chats = await client.getChats();
    const groups = chats
      .filter((chat) => chat.isGroup) // Filter hanya grup
      .map((group) => ({
        id: group.id._serialized,
        name: group.name,
        participants: group.participants.length,
      }));

    res.status(200).json({
      status: true,
      message: "Daftar grup berhasil diambil",
      groups,
    });
  } catch (error) {
    console.error("Error saat mengambil daftar grup:", error);
    res.status(500).json({
      status: false,
      message: "Gagal mengambil daftar grup",
      error: error.message,
    });
  }
});

// Endpoint untuk serve file index.html (optional)
const { resolve } = require("path");
app.get("/", (req, res) => {
  res.sendFile(resolve(__dirname, "index.html"));
});

// Menjalankan server di port yang ditentukan
app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on localhost:${port}`);
});
