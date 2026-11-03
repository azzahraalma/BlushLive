const express = require('express');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');

const port = process.env.PORT || 8080;

// ---------------------------------------------------------------
// SSL: dibuat otomatis kalau folder ssl/ belum ada.
// (selfsigned v5 itu async -> makanya pakai await)
// ---------------------------------------------------------------
const sslDir = path.join(__dirname, 'ssl');
const keyPath = path.join(sslDir, 'key.pem');
const certPath = path.join(sslDir, 'cert.pem');

function lanIPs() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
}

async function ensureSSL() {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return;
  fs.mkdirSync(sslDir, { recursive: true });
  const selfsigned = require('selfsigned');
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lanIPs().map(ip => ({ type: 7, ip }))
  ];
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    { days: 365, keySize: 2048, extensions: [{ name: 'subjectAltName', altNames }] }
  );
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  console.log('Sertifikat SSL otomatis berhasil dibuat!');
}

async function main() {
  await ensureSSL();

  const app = express();
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };

  // Hanya file ini yang public. Root project juga isinya server.js,
  // ssl/key.pem, node_modules, .git — jadi folder tidak boleh di-serve utuh.
  const PUBLIC_FILES = ['index.html', 'script.js', 'stream.js', 'style.css'];
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  PUBLIC_FILES.forEach(file => {
    app.get('/' + file, (req, res) => res.sendFile(path.join(__dirname, file)));
  });

  const server = https.createServer(options, app);
  const io = new Server(server);

  // ===== Logika Signaling =====
  const hosts = new Map();     // roomId -> socket.id broadcaster
  const hostMuted = new Map(); // roomId -> bool (host mic muted)
  const histories = new Map(); // roomId -> last chat messages

  function emitCount(roomId, leaving = 0) {
    const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    io.to(roomId).emit('viewer-count', { roomId, count: Math.max(0, size - 1 - leaving) });
  }

  function endRoom(roomId) {
    io.to(roomId).emit('stream-ended', { roomId });
    hosts.delete(roomId);
    histories.delete(roomId);
    hostMuted.delete(roomId);
    io.in(roomId).socketsLeave(roomId);
  }

  io.on('connection', (socket) => {
    console.log('User terhubung:', socket.id);
    socket.emit('server-ready');

    // Broadcaster membuat room
    socket.on('join-room', (roomId) => {
      hosts.set(roomId, socket.id);
      histories.set(roomId, []);
      socket.join(roomId);
      emitCount(roomId);
    });

    // Viewer bergabung (dengan nama)
    socket.on('join-as-viewer', (payload) => {
      const roomId = typeof payload === 'string' ? payload : payload && payload.roomId;
      const name = String((payload && payload.name) || '').trim().slice(0, 20) || 'viewer-' + socket.id.slice(0, 4);
      if (!hosts.has(roomId)) { socket.emit('no-stream'); return; }
      socket.data.name = name;
      socket.join(roomId);
      socket.emit('host-mic', { roomId, muted: !!hostMuted.get(roomId) });
      socket.emit('chat-history', { roomId, messages: histories.get(roomId) || [] });
      io.to(hosts.get(roomId)).emit('viewer-joined', { viewerId: socket.id, name });
      emitCount(roomId);
    });

    // Keluar room (stop broadcast / leave stream)
    socket.on('leave-room', (roomId) => {
      if (hosts.get(roomId) === socket.id) {
        endRoom(roomId);          // broadcaster selesai -> semua viewer dikeluarkan
      } else {
        socket.leave(roomId);
        emitCount(roomId);
      }
    });

    // Host mute / unmute -> kasih tahu viewer
    socket.on('host-mic', ({ roomId, muted } = {}) => {
      if (hosts.get(roomId) !== socket.id) return;
      hostMuted.set(roomId, !!muted);
      io.to(roomId).emit('host-mic', { roomId, muted: !!muted });
    });

    // Komentar live
    socket.on('chat-message', ({ roomId, text } = {}) => {
      if (!socket.rooms.has(roomId)) return;
      text = String(text || '').trim().slice(0, 200);
      if (!text) return;
      const host = hosts.get(roomId) === socket.id;
      const msg = { roomId, text, host, name: host ? 'host' : (socket.data.name || 'viewer-' + socket.id.slice(0, 4)) };
      const hist = histories.get(roomId);
      if (hist) { hist.push(msg); if (hist.length > 100) hist.shift(); }
      io.to(roomId).emit('chat-message', msg);
    });

    // Relay offer / answer (langsung ke target)
    socket.on('offer', (p) => io.to(p.target).emit('offer', { sdp: p.sdp, broadcasterId: socket.id }));
    socket.on('answer', (p) => io.to(p.target).emit('answer', { sdp: p.sdp, viewerId: socket.id }));

    // Relay ICE candidate.
    // FIX: dikirim ke target tertentu (bukan broadcast ke seluruh room),
    // supaya kalau ada banyak viewer, candidate tidak nyasar ke koneksi lain.
    socket.on('ice-candidate', (p) => {
      if (!p) return;
      const payload = { candidate: p.candidate, senderId: socket.id };
      if (p.target) io.to(p.target).emit('ice-candidate', payload);
      else if (p.roomId) socket.to(p.roomId).emit('ice-candidate', payload); // kompatibel dgn client lama
    });

    socket.on('disconnecting', () => {
      for (const roomId of socket.rooms) {
        if (roomId === socket.id) continue;
        if (hosts.get(roomId) === socket.id) endRoom(roomId);
        else emitCount(roomId, 1);
      }
    });
  });

  server.listen(port, () => {
    console.log(`blush live (HTTPS) berjalan di https://localhost:${port}`);
    lanIPs().forEach(ip => console.log(`  atau dari device lain di jaringan sama: https://${ip}:${port}`));
  });
}

main().catch(err => {
  console.error('Gagal menjalankan server:', err);
  process.exit(1);
});