(function(){
'use strict';

// STUN + TURN. TURN dipakai kalau 2 device beda jaringan / kena NAT ketat
// (biasanya terjadi saat lewat Vercel / internet). Ini TURN publik gratis,
// kalau mau stabil untuk produksi ganti dengan TURN punya sendiri.
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

// PeerJS dicoba dari beberapa CDN berurutan (kalau satu diblokir / lambat, lanjut ke berikutnya)
const PEERJS_CDNS = [
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js'
];

const streamTabs = document.getElementById('streamTabs');
const stTabBroadcast = document.getElementById('stTabBroadcast');
const stTabViewer = document.getElementById('stTabViewer');
const stBroadcastPanel = document.getElementById('stBroadcastPanel');
const stViewerPanel = document.getElementById('stViewerPanel');

const stLocalVideo = document.getElementById('stLocalVideo');
const stRemoteVideo = document.getElementById('stRemoteVideo');
const stToken = document.getElementById('stToken');
const stStartBtn = document.getElementById('stStartBtn');
const stStopBtn = document.getElementById('stStopBtn');
const stTokenInput = document.getElementById('stTokenInput');
const stJoinBtn = document.getElementById('stJoinBtn');
const stLeaveBtn = document.getElementById('stLeaveBtn');
const stBroadcastStatus = document.getElementById('stBroadcastStatus');
const stViewerStatus = document.getElementById('stViewerStatus');

const stSrcCam = document.getElementById('stSrcCam');
const stSrcFile = document.getElementById('stSrcFile');
const stSrcScreen = document.getElementById('stSrcScreen');   // opsional (tombol share screen)
const stSrcScreenCam = document.getElementById('stSrcScreenCam'); // opsional (share screen + kamera kecil)
const stSourceRow = document.getElementById('stSourceRow');
const stFileBlock = document.getElementById('stFileBlock');
const stFileInput = document.getElementById('stFileInput');
const stFileName = document.getElementById('stFileName');
const stLoop = document.getElementById('stLoop');

const TOKEN_PLACEHOLDER = '— — — —';

let sourceMode = 'camera'; // 'camera' | 'file' | 'screen' | 'screencam'
let chosenFile = null;

let socket = null;
let bc = null; // active broadcast
let vw = null; // active viewer session

function setStatus(el, text, kind){
  el.textContent = text;
  el.className = 'stream-status' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------
// Loader script (dipakai untuk PeerJS)
// ---------------------------------------------------------------
function loadScript(src, timeoutMs){
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    const timer = setTimeout(() => { el.remove(); reject(new Error('timeout: ' + src)); }, timeoutMs || 8000);
    el.src = src;
    el.async = true;
    el.onload = () => { clearTimeout(timer); resolve(); };
    el.onerror = () => { clearTimeout(timer); el.remove(); reject(new Error('failed: ' + src)); };
    document.head.appendChild(el);
  });
}

async function loadPeerJS(){
  if(typeof Peer !== 'undefined') return true;
  for(const url of PEERJS_CDNS){
    try{
      await loadScript(url);
      if(typeof Peer !== 'undefined') return true;
    }catch(err){
      console.warn(err.message);
    }
  }
  return false;
}

// ---------------------------------------------------------------
// Signaling cadangan untuk hosting statis (Vercel dll.).
// Vercel tidak bisa menjalankan server Socket.IO, jadi kalau `io` tidak ada,
// kita pakai PeerJS Cloud hanya sebagai "kurir" pesan signaling.
// Objek ini meniru API socket.io (on / off / emit / id) dengan event yang SAMA
// (join-room, join-as-viewer, viewer-joined, offer, answer, ice-candidate, leave-room),
// jadi logika broadcaster & viewer di bawah sama persis untuk kedua mode.
// Media tetap dikirim langsung lewat WebRTC (RTCPeerConnection) seperti biasa.
// ---------------------------------------------------------------
function createPeerSignaling(){
  const handlers = {};
  const conns = {};            // peerId -> DataConnection
  let peer = null;
  let role = null;             // 'broadcaster' | 'viewer'

  const clean = obj => JSON.parse(JSON.stringify(obj));
  const fire = (ev, data) => (handlers[ev] || []).slice().forEach(fn => fn(data));

  function onMessage(from, m){
    if(!m) return;
    if(m.t === 'offer')  fire('offer', { sdp: m.sdp, broadcasterId: from });
    if(m.t === 'answer') fire('answer', { sdp: m.sdp, viewerId: from });
    if(m.t === 'ice')    fire('ice-candidate', { candidate: m.candidate, senderId: from });
    if(m.t === 'bye')    fire('stream-ended', {});
  }

  function trackConn(conn){
    conn.on('data', m => onMessage(conn.peer, m));
    conn.on('close', () => {
      const wasActive = conns[conn.peer] === conn;
      if(wasActive) delete conns[conn.peer];
      // viewer: koneksi ke broadcaster putus = stream selesai
      if(wasActive && role === 'viewer') fire('stream-ended', {});
    });
    conn.on('error', err => console.warn('peer connection error:', err));
  }

  function closeAll(){
    const list = Object.values(conns);
    Object.keys(conns).forEach(k => delete conns[k]);   // dikosongkan dulu supaya 'close' tidak memicu stream-ended
    list.forEach(c => { try{ c.close(); }catch(e){} });
    if(peer){ try{ peer.destroy(); }catch(e){} }
    peer = null;
    role = null;
    api.id = null;
  }

  function onPeerError(err){
    console.warn('peer error:', err);
    const type = err && err.type;
    if(type === 'peer-unavailable'){ fire('no-stream', {}); return; }
    if(type === 'unavailable-id'){ fire('signal-error', { message: 'token is already in use, try again.' }); return; }
    fire('signal-error', { message: 'cannot reach the signaling service (PeerJS). check your internet connection.' });
  }

  const api = {
    id: null,
    isPeer: true,
    on(ev, fn){ (handlers[ev] = handlers[ev] || []).push(fn); return api; },
    off(ev, fn){ handlers[ev] = (handlers[ev] || []).filter(f => f !== fn); return api; },
    emit(ev, payload){
      if(ev === 'join-room'){
        closeAll();
        role = 'broadcaster';
        peer = new Peer('blush-' + payload, { config: ICE_CONFIG });
        peer.on('open', id => { api.id = id; fire('signal-ready', {}); });
        peer.on('connection', conn => {
          trackConn(conn);
          conn.on('open', () => {
            conns[conn.peer] = conn;
            fire('viewer-joined', { viewerId: conn.peer });
          });
        });
        peer.on('error', onPeerError);
      }
      else if(ev === 'join-as-viewer'){
        closeAll();
        role = 'viewer';
        const roomId = (payload && payload.roomId) || payload;
        peer = new Peer({ config: ICE_CONFIG });
        peer.on('open', id => {
          api.id = id;
          const conn = peer.connect('blush-' + roomId, { serialization: 'json', reliable: true });
          trackConn(conn);
          conn.on('open', () => { conns[conn.peer] = conn; });
        });
        peer.on('error', onPeerError);
      }
      else if(ev === 'offer' || ev === 'answer'){
        const c = conns[payload.target];
        if(c && c.open) c.send({ t: ev, sdp: clean(payload.sdp) });
      }
      else if(ev === 'ice-candidate'){
        // FIX: kirim ke target tertentu saja (bukan ke semua koneksi)
        const msg = { t: 'ice', candidate: clean(payload.candidate) };
        if(payload.target){
          const c = conns[payload.target];
          if(c && c.open) c.send(msg);
        }else{
          Object.values(conns).forEach(c => { if(c.open) c.send(msg); });
        }
      }
      else if(ev === 'leave-room'){
        if(role === 'broadcaster'){
          Object.values(conns).forEach(c => { try{ if(c.open) c.send({ t: 'bye' }); }catch(e){} });
        }
        // kasih jeda sedikit supaya pesan 'bye' sempat terkirim
        const p = peer, list = Object.values(conns);
        Object.keys(conns).forEach(k => delete conns[k]);
        peer = null; role = null; api.id = null;
        setTimeout(() => {
          list.forEach(c => { try{ c.close(); }catch(e){} });
          if(p){ try{ p.destroy(); }catch(e){} }
        }, 150);
      }
      return api;
    }
  };
  return api;
}

// ---------------------------------------------------------------
// Pilih mode signaling:
//  - ada `io`  -> server lokal (Node + Socket.IO) = cara asli
//  - tidak ada -> hosting statis (Vercel) = PeerJS
// ---------------------------------------------------------------
let signalingReady = null;
function prepareSignaling(){
  if(signalingReady) return signalingReady;
  signalingReady = (async () => {
    if(typeof io !== 'undefined'){
      socket = io();
      socket.isPeer = false;
      return socket;
    }
    const ok = await loadPeerJS();
    if(ok){
      socket = createPeerSignaling();
      return socket;
    }
    return null;
  })();
  return signalingReady;
}

const NO_SERVER_MSG = 'stream server not reachable — open this page from the blush live server (https://<your-ip>:8080), or check your internet connection (the online version needs it to load PeerJS).';

// ICE candidates can arrive before the remote description is set,
// so hold them until it is.
async function addCandidate(pc, candidate){
  if(!pc.remoteDescription){
    (pc._pending = pc._pending || []).push(candidate);
    return;
  }
  try{
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }catch(err){
    console.warn('addIceCandidate failed:', err);
  }
}
async function flushCandidates(pc){
  const list = pc._pending || [];
  pc._pending = [];
  for(const c of list) await addCandidate(pc, c);
}

function switchStreamTab(which){
  const isBroadcast = which === 'broadcast';
  stTabBroadcast.classList.toggle('active', isBroadcast);
  stTabViewer.classList.toggle('active', !isBroadcast);
  stBroadcastPanel.style.display = isBroadcast ? 'flex' : 'none';
  stViewerPanel.style.display = isBroadcast ? 'none' : 'flex';
}

function lockTabs(){
  streamTabs.classList.toggle('locked', !!(bc || vw));
}

// tunggu sampai stream punya minimal 1 track (kadang telat sedikit di beberapa browser)
function waitForTracks(stream, ms){
  return new Promise(resolve => {
    if(stream.getTracks().length > 0){ resolve(); return; }
    const done = () => { clearTimeout(t); stream.removeEventListener('addtrack', done); resolve(); };
    const t = setTimeout(done, ms || 2500);
    stream.addEventListener('addtrack', done);
  });
}

// ===== MEDIA SOURCE =====
// Return { stream, cleanup, endedTrack? }.
// camera -> getUserMedia, file -> <video>.captureStream(), screen -> getDisplayMedia,
// screencam -> layar + kamera bulat kecil (digabung lewat <canvas>).
async function getCameraSource(){
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  stLocalVideo.srcObject = stream;
  stLocalVideo.muted = true;
  stLocalVideo.controls = false;
  return { stream, cleanup(){} };
}

async function getScreenSource(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){
    throw new Error('screen share is not supported in this browser');
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stLocalVideo.srcObject = stream;
  stLocalVideo.muted = true;       // preview dibisukan supaya tidak echo
  stLocalVideo.controls = false;
  return { stream, cleanup(){}, endedTrack: stream.getVideoTracks()[0] };
}

// Share screen + kamera kecil (bulat) di pojok kanan bawah, digabung jadi 1 video lewat <canvas>.
// Audio (mic + suara tab/layar) dicampur jadi 1 track.
async function getScreenCamSource(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){
    throw new Error('screen share is not supported in this browser');
  }
  // AudioContext dibuat di awal (masih dalam klik user) supaya tidak "suspended"
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  try{ ac.resume(); }catch(e){}

  let screen = null, cam = null;
  const stopRaw = () => {
    [screen, cam].forEach(st => st && st.getTracks().forEach(t => t.stop()));
    try{ ac.close(); }catch(e){}
  };

  try{
    screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    cam = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true });
  }catch(err){
    stopRaw();
    throw err;
  }

  const makeVideo = tracks => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = new MediaStream(tracks);
    return v;
  };
  const sv = makeVideo(screen.getVideoTracks());
  const cv = makeVideo(cam.getVideoTracks());
  try{
    await Promise.all([sv.play(), cv.play()]);
    await new Promise(resolve => {
      const t0 = Date.now();
      (function check(){
        if((sv.videoWidth && cv.videoWidth) || Date.now() - t0 > 3000) resolve();
        else setTimeout(check, 50);
      })();
    });
  }catch(err){
    stopRaw();
    throw err;
  }

  // ukuran canvas mengikuti layar yang dibagikan (maks lebar 1280 biar ringan)
  const sw = sv.videoWidth || 1280, sh = sv.videoHeight || 720;
  const k = Math.min(1, 1280 / sw);
  const W = Math.round(sw * k), H = Math.round(sh * k);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  function draw(){
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    // layar (diskalakan muat, tidak terpotong)
    const vw = sv.videoWidth || W, vh = sv.videoHeight || H;
    const sc = Math.min(W / vw, H / vh);
    const dw = vw * sc, dh = vh * sc;
    ctx.drawImage(sv, (W - dw) / 2, (H - dh) / 2, dw, dh);

    // kamera bulat kecil di pojok kanan bawah
    if(cv.videoWidth){
      const r = Math.round(Math.min(W, H) * 0.14);
      const cx = W - r - Math.round(W * 0.025);
      const cy = H - r - Math.round(H * 0.04);
      const side = Math.min(cv.videoWidth, cv.videoHeight);
      const sx = (cv.videoWidth - side) / 2, sy = (cv.videoHeight - side) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(cv, sx, sy, side, side, cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
      ctx.lineWidth = Math.max(3, Math.round(r * 0.06));
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  draw();

  // Timer lewat Web Worker: tab yang ditinggal (user pindah ke window yang dibagikan)
  // di-throttle browser, tapi timer di Worker tidak.
  let worker = null, fallbackTimer = null;
  try{
    const blob = new Blob(['setInterval(function(){ postMessage(0); }, 33);'], { type: 'application/javascript' });
    worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = draw;
  }catch(e){
    fallbackTimer = setInterval(draw, 33);
  }

  const out = canvas.captureStream(30);

  // campur audio: mic + suara layar/tab
  const dest = ac.createMediaStreamDestination();
  [cam, screen].forEach(st => {
    if(st.getAudioTracks().length){
      ac.createMediaStreamSource(new MediaStream(st.getAudioTracks())).connect(dest);
    }
  });
  dest.stream.getAudioTracks().forEach(t => out.addTrack(t));

  stLocalVideo.srcObject = out;
  stLocalVideo.muted = true;       // preview dibisukan supaya tidak echo
  stLocalVideo.controls = false;

  return {
    stream: out,
    endedTrack: screen.getVideoTracks()[0],
    cleanup(){
      if(worker){ worker.terminate(); }
      if(fallbackTimer){ clearInterval(fallbackTimer); }
      sv.srcObject = null; cv.srcObject = null;
      stopRaw();
    }
  };
}

async function getFileSource(file){
  const url = URL.createObjectURL(file);
  stLocalVideo.srcObject = null;
  stLocalVideo.src = url;
  stLocalVideo.loop = stLoop.checked;
  stLocalVideo.muted = false;      // streamer bisa dengar; viewer dapat audionya sendiri
  stLocalVideo.controls = true;    // play / pause / seek — viewer ikut
  stLocalVideo.playsInline = true;

  const resetEl = () => {
    stLocalVideo.onplaying = null;
    stLocalVideo.onerror = null;
    stLocalVideo.onended = null;
    stLocalVideo.pause();
    stLocalVideo.removeAttribute('src');
    stLocalVideo.load();
    stLocalVideo.controls = false;
    stLocalVideo.muted = true;
    URL.revokeObjectURL(url);
  };

  try{
    // track baru ada setelah elemen benar-benar playing
    await new Promise((resolve, reject) => {
      stLocalVideo.onplaying = resolve;
      stLocalVideo.onerror = () => reject(new Error('cannot play this video file'));
      stLocalVideo.play().catch(reject);
    });
    stLocalVideo.onplaying = null;
    stLocalVideo.onerror = null;

    const capture = stLocalVideo.captureStream || stLocalVideo.mozCaptureStream;
    if(!capture) throw new Error('captureStream is not supported in this browser');
    const stream = capture.call(stLocalVideo);
    await waitForTracks(stream);
    if(stream.getTracks().length === 0) throw new Error('no media tracks found in this file');

    return { stream, cleanup: resetEl };
  }catch(err){
    resetEl();
    throw err;
  }
}

function setSourceMode(mode){
  sourceMode = mode;
  stSrcCam.classList.toggle('active', mode === 'camera');
  stSrcFile.classList.toggle('active', mode === 'file');
  if(stSrcScreen) stSrcScreen.classList.toggle('active', mode === 'screen');
  if(stSrcScreenCam) stSrcScreenCam.classList.toggle('active', mode === 'screencam');
  stFileBlock.style.display = mode === 'file' ? 'flex' : 'none';
  setStatus(stBroadcastStatus,
    mode === 'file'      ? 'choose a video file, then press start.' :
    mode === 'screen'    ? 'press start, then pick a screen / window / tab to share (tick "share audio" for sound).' :
    mode === 'screencam' ? 'press start, pick a screen / window / tab — your camera will show as a small bubble in the corner.' :
                           'press start to turn on your camera and get a token.');
}

// ===== BROADCASTER =====
async function startBroadcast(){
  if(bc) return;
  stStartBtn.disabled = true;
  setStatus(stBroadcastStatus, 'connecting…');

  const s = await prepareSignaling();
  if(!s){
    setStatus(stBroadcastStatus, NO_SERVER_MSG, 'warn');
    stStartBtn.disabled = false;
    return;
  }

  if(sourceMode === 'camera' && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)){
    setStatus(stBroadcastStatus, 'camera access needs https — open the https:// address of the server.', 'warn');
    stStartBtn.disabled = false;
    return;
  }
  if(sourceMode === 'file' && !chosenFile){
    setStatus(stBroadcastStatus, 'choose a video file first.', 'warn');
    stStartBtn.disabled = false;
    return;
  }

  setStatus(stBroadcastStatus,
    sourceMode === 'file' ? 'loading your video…' :
    (sourceMode === 'screen' || sourceMode === 'screencam') ? 'waiting for you to pick what to share…' :
                            'asking for camera & mic…');

  let source, localStream;
  try{
    source = sourceMode === 'file'      ? await getFileSource(chosenFile)
           : sourceMode === 'screen'    ? await getScreenSource()
           : sourceMode === 'screencam' ? await getScreenCamSource()
           :                              await getCameraSource();
    localStream = source.stream;
  }catch(err){
    console.error(err);
    setStatus(stBroadcastStatus,
      sourceMode === 'file' ? 'could not play that file — try another video (mp4 / webm).' :
      (sourceMode === 'screen' || sourceMode === 'screencam') ? 'screen share was cancelled, or the camera/mic permission was denied.' :
                              'could not open camera/mic — check the browser permission.', 'warn');
    stStartBtn.disabled = false;
    return;
  }

  const roomId = Math.random().toString(36).substring(2, 10);
  const peerConnections = {};
  const modeTag = s.isPeer ? 'online' : 'local server';
  let signalReady = !s.isPeer;
  stToken.textContent = roomId;

  function updateViewerCount(){
    if(!signalReady){ setStatus(stBroadcastStatus, 'connecting to signaling service…'); return; }
    const n = Object.values(peerConnections).filter(pc => pc.connectionState === 'connected').length;
    setStatus(stBroadcastStatus,
      n === 0 ? `live (${modeTag}) — waiting for viewers…`
              : `live (${modeTag}) — ${n} viewer${n > 1 ? 's' : ''} watching`, 'on');
  }

  const onViewerJoined = async ({ viewerId }) => {
    console.log(`Viewer ${viewerId} joined, creating connection...`);
    if(peerConnections[viewerId]){ try{ peerConnections[viewerId].close(); }catch(e){} }
    const pc = new RTCPeerConnection(ICE_CONFIG);
    peerConnections[viewerId] = pc;

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = event => {
      if(event.candidate){
        s.emit('ice-candidate', { roomId, target: viewerId, candidate: event.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      if(pc.connectionState === 'closed' || pc.connectionState === 'failed'){
        delete peerConnections[viewerId];
      }
      updateViewerCount();
    };

    try{
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      s.emit('offer', { target: viewerId, sdp: offer });
    }catch(err){
      console.error('offer failed:', err);
    }
  };

  const onAnswer = async ({ sdp, viewerId }) => {
    console.log(`Got answer from ${viewerId}`);
    const pc = peerConnections[viewerId];
    if(!pc) return;
    try{
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushCandidates(pc);
    }catch(err){
      console.error('answer failed:', err);
    }
  };

  // FIX: candidate dari viewer X hanya masuk ke koneksi viewer X
  const onIce = ({ candidate, senderId }) => {
    const pc = peerConnections[senderId];
    if(pc) addCandidate(pc, candidate);
  };

  const onSignalReady = () => { signalReady = true; updateViewerCount(); };
  const onSignalError = ({ message }) => setStatus(stBroadcastStatus, message, 'warn');

  s.on('viewer-joined', onViewerJoined);
  s.on('answer', onAnswer);
  s.on('ice-candidate', onIce);
  s.on('signal-ready', onSignalReady);
  s.on('signal-error', onSignalError);
  s.emit('join-room', roomId);

  bc = { roomId, localStream, source, peerConnections, onViewerJoined, onAnswer, onIce, onSignalReady, onSignalError };

  // share screen: kalau user menekan "Stop sharing" dari browser -> broadcast ikut berhenti
  if(source.endedTrack){
    source.endedTrack.addEventListener('ended', () => { if(bc) stopBroadcast('screen share ended — broadcast stopped.'); });
  }
  // file video: kalau tidak loop & sudah habis, kasih info
  if(sourceMode === 'file'){
    stLocalVideo.onended = () => {
      if(bc) setStatus(stBroadcastStatus, 'video finished — press stop, or seek back to play it again.', 'warn');
    };
  }

  stStopBtn.style.display = '';
  stStartBtn.style.display = 'none';
  stSourceRow.classList.add('locked');
  stFileBlock.classList.add('locked');
  lockTabs();
  updateViewerCount();
}

function stopBroadcast(message){
  if(!bc) return;
  const s = socket;
  if(s){
    s.off('viewer-joined', bc.onViewerJoined);
    s.off('answer', bc.onAnswer);
    s.off('ice-candidate', bc.onIce);
    s.off('signal-ready', bc.onSignalReady);
    s.off('signal-error', bc.onSignalError);
    s.emit('leave-room', bc.roomId);
  }
  Object.values(bc.peerConnections).forEach(pc => { pc.onconnectionstatechange = null; pc.close(); });
  bc.localStream.getTracks().forEach(t => t.stop());
  bc.source.cleanup();
  stLocalVideo.srcObject = null;
  bc = null;
  stSourceRow.classList.remove('locked');
  stFileBlock.classList.remove('locked');

  stToken.textContent = TOKEN_PLACEHOLDER;
  stStopBtn.style.display = 'none';
  stStartBtn.style.display = '';
  stStartBtn.disabled = false;
  lockTabs();
  setStatus(stBroadcastStatus, typeof message === 'string' ? message : 'broadcast stopped.');
}

// ===== VIEWER =====
async function startView(roomId){
  if(vw) return;

  stJoinBtn.disabled = true;
  setStatus(stViewerStatus, 'connecting…');
  const s = await prepareSignaling();
  stJoinBtn.disabled = false;
  if(!s){ setStatus(stViewerStatus, NO_SERVER_MSG, 'warn'); return; }
  if(vw) return;

  const session = { roomId, pc: null, waitTimer: null, broadcasterId: null };

  const onOffer = async ({ sdp, broadcasterId }) => {
    console.log('Got offer from broadcaster');
    clearTimeout(session.waitTimer);
    session.broadcasterId = broadcasterId;
    if(session.pc) session.pc.close();

    const pc = new RTCPeerConnection(ICE_CONFIG);
    session.pc = pc;

    pc.ontrack = event => {
      if(stRemoteVideo.srcObject !== event.streams[0]){
        stRemoteVideo.srcObject = event.streams[0];
      }
    };
    pc.onicecandidate = event => {
      if(event.candidate){
        s.emit('ice-candidate', { roomId, target: broadcasterId, candidate: event.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      if(pc.connectionState === 'connected') setStatus(stViewerStatus, 'connected — enjoy the stream ♡ (tap the speaker icon on the video to unmute)', 'on');
      else if(pc.connectionState === 'connecting') setStatus(stViewerStatus, 'connecting…');
      else if(pc.connectionState === 'disconnected' || pc.connectionState === 'failed') setStatus(stViewerStatus, 'connection lost.', 'warn');
    };

    try{
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushCandidates(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit('answer', { target: broadcasterId, sdp: answer });
    }catch(err){
      console.error('offer handling failed:', err);
      setStatus(stViewerStatus, 'could not connect to the broadcaster.', 'warn');
    }
  };

  const onIce = ({ candidate, senderId }) => {
    if(session.pc && senderId === session.broadcasterId) addCandidate(session.pc, candidate);
  };

  // token salah / broadcaster tidak live
  const onNoStream = () => {
    leaveView('no live stream with that token — check it and try again.', 'warn');
  };
  // broadcaster menghentikan stream
  const onStreamEnded = () => {
    leaveView('the broadcaster ended the stream.', 'warn');
  };
  const onSignalError = ({ message }) => {
    leaveView(message, 'warn');
  };

  s.on('offer', onOffer);
  s.on('ice-candidate', onIce);
  s.on('no-stream', onNoStream);
  s.on('stream-ended', onStreamEnded);
  s.on('signal-error', onSignalError);
  s.emit('join-as-viewer', s.isPeer ? { roomId } : roomId);

  session.onOffer = onOffer;
  session.onIce = onIce;
  session.onNoStream = onNoStream;
  session.onStreamEnded = onStreamEnded;
  session.onSignalError = onSignalError;
  session.waitTimer = setTimeout(() => {
    setStatus(stViewerStatus, 'no stream yet — check the token, or the broadcaster may not be live.', 'warn');
  }, 10000);
  vw = session;

  stJoinBtn.style.display = 'none';
  stLeaveBtn.style.display = '';
  stTokenInput.disabled = true;
  lockTabs();
  setStatus(stViewerStatus, 'joined — waiting for the broadcaster…');
}

function leaveView(message, kind){
  if(!vw) return;
  const s = socket;
  clearTimeout(vw.waitTimer);
  if(s){
    s.off('offer', vw.onOffer);
    s.off('ice-candidate', vw.onIce);
    s.off('no-stream', vw.onNoStream);
    s.off('stream-ended', vw.onStreamEnded);
    s.off('signal-error', vw.onSignalError);
    s.emit('leave-room', vw.roomId);
  }
  if(vw.pc){ vw.pc.onconnectionstatechange = null; vw.pc.close(); }
  stRemoteVideo.srcObject = null;
  vw = null;

  stJoinBtn.style.display = '';
  stLeaveBtn.style.display = 'none';
  stTokenInput.disabled = false;
  lockTabs();
  setStatus(stViewerStatus, typeof message === 'string' ? message : 'left the stream.', kind);
}

// ===== UI wiring =====
stTabBroadcast.onclick = () => switchStreamTab('broadcast');
stTabViewer.onclick = () => switchStreamTab('viewer');

stSrcCam.onclick = () => { if(!bc) setSourceMode('camera'); };
stSrcFile.onclick = () => { if(!bc) setSourceMode('file'); };
if(stSrcScreen){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){
    stSrcScreen.style.display = 'none';   // HP / browser yang tidak support share screen
  }else{
    stSrcScreen.onclick = () => { if(!bc) setSourceMode('screen'); };
  }
}
if(stSrcScreenCam){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){
    stSrcScreenCam.style.display = 'none';
  }else{
    stSrcScreenCam.onclick = () => { if(!bc) setSourceMode('screencam'); };
  }
}
stFileInput.onchange = () => {
  const f = stFileInput.files && stFileInput.files[0];
  if(!f) return;
  if(!f.type.startsWith('video/')){
    setStatus(stBroadcastStatus, 'that is not a video file.', 'warn');
    stFileInput.value = '';
    return;
  }
  chosenFile = f;
  stFileName.textContent = f.name;
  setStatus(stBroadcastStatus, 'ready — press start to go live with this video.');
};
stLoop.onchange = () => { stLocalVideo.loop = stLoop.checked; };

stStartBtn.onclick = startBroadcast;
stStopBtn.onclick = () => stopBroadcast();

stToken.onclick = () => {
  if(!bc) return;
  const done = () => setStatus(stBroadcastStatus, 'token copied!', 'on');
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(bc.roomId).then(done).catch(() => {});
  }
};

function joinFromInput(){
  const roomId = stTokenInput.value.trim();
  if(!roomId){ setStatus(stViewerStatus, 'enter a token first.', 'warn'); return; }
  startView(roomId);
}
stJoinBtn.onclick = joinFromInput;
stLeaveBtn.onclick = () => leaveView();
stTokenInput.addEventListener('keydown', e => { if(e.key === 'Enter') joinFromInput(); });

stToken.textContent = TOKEN_PLACEHOLDER;
switchStreamTab('broadcast');

// siapkan signaling dari awal (di Vercel: load PeerJS di background) supaya
// pas tombol Start / Join ditekan sudah siap dan user gesture tidak hilang.
prepareSignaling();
})();