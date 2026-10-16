const express = require('express');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const port = 8080;
const options = {
  key: fs.readFileSync(path.join(__dirname, 'ssl', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'ssl', 'cert.pem'))
};

// Only these files are public. The project root also holds server.js,
// ssl/key.pem, node_modules, .git — so we never serve the whole folder.
const PUBLIC_FILES = ['index.html', 'script.js', 'stream.js', 'style.css'];
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
PUBLIC_FILES.forEach(file => {
  app.get('/' + file, (req, res) => res.sendFile(path.join(__dirname, file)));
});

const server = https.createServer(options, app);
const io = new Server(server);

// Logika Signaling
const hosts = new Map();     // roomId -> socket.id broadcaster
const hostMuted = new Map(); // roomId -> bool (host mic muted)
const histories = new Map(); // roomId -> last chat messages

function emitCount(roomId, leaving = 0){
  const size = io.sockets.adapter.rooms.get(roomId)?.size || 0;
  io.to(roomId).emit('viewer-count', { roomId, count: Math.max(0, size - 1 - leaving) });
}

function endRoom(roomId){
  io.to(roomId).emit('stream-ended', { roomId });
  hosts.delete(roomId);
  histories.delete(roomId);
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
    if(!hosts.has(roomId)){ socket.emit('no-stream'); return; }
    socket.data.name = name;
    socket.join(roomId);
    socket.emit('host-mic', { roomId, muted: !!hostMuted.get(roomId) });
    socket.emit('chat-history', { roomId, messages: histories.get(roomId) || [] });
    io.to(hosts.get(roomId)).emit('viewer-joined', { viewerId: socket.id, name });
    emitCount(roomId);
  });

  // Keluar room (stop broadcast / leave stream)
  socket.on('leave-room', (roomId) => {
    if(hosts.get(roomId) === socket.id){
      endRoom(roomId);          // broadcaster selesai -> semua viewer dikeluarkan
    }else{
      socket.leave(roomId);
      emitCount(roomId);
    }
  });

    // Host mute / unmute -> kasih tahu viewer
  socket.on('host-mic', ({ roomId, muted } = {}) => {
    if(hosts.get(roomId) !== socket.id) return;
    hostMuted.set(roomId, !!muted);
    io.to(roomId).emit('host-mic', { roomId, muted: !!muted });
  });

  // Komentar live
  socket.on('chat-message', ({ roomId, text } = {}) => {
    if(!socket.rooms.has(roomId)) return;
    text = String(text || '').trim().slice(0, 200);
    if(!text) return;
    const host = hosts.get(roomId) === socket.id;
    const msg = { roomId, text, host, name: host ? 'host' : (socket.data.name || 'viewer-' + socket.id.slice(0, 4)) };
    const hist = histories.get(roomId);
    if(hist){ hist.push(msg); if(hist.length > 100) hist.shift(); }
    io.to(roomId).emit('chat-message', msg);
  });

  socket.on('offer', (p) => io.to(p.target).emit('offer', { sdp: p.sdp, broadcasterId: socket.id }));
  socket.on('answer', (p) => io.to(p.target).emit('answer', { sdp: p.sdp, viewerId: socket.id }));
  socket.on('ice-candidate', (p) => {
    socket.to(p.roomId).emit('ice-candidate', { candidate: p.candidate, senderId: socket.id });
  });

  socket.on('disconnecting', () => {
    for(const roomId of socket.rooms){
      if(roomId === socket.id) continue;
      if(hosts.get(roomId) === socket.id) endRoom(roomId);
      else emitCount(roomId, 1);
    }
  });
});

server.listen(port, () => {
  console.log(`blush live (HTTPS) berjalan di https://localhost:${port}`);
  Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .forEach(i => console.log(`  atau dari device lain di jaringan sama: https://${i.address}:${port}`));
});