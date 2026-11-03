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

// ukuran video hasil kompositing untuk tiap rasio
const RATIOS = {
  '16:9': { w: 1280, h: 720 },
  '9:16': { w: 720,  h: 1280 },
  '3:4':  { w: 720,  h: 960 }
};

// filter (dipakai lewat ctx.filter di canvas; Safari belum support)
const FILTERS = [
  { id: 'none',  label: 'Normal', css: 'none' },
  { id: 'blush', label: 'Blush',  css: 'sepia(0.25) saturate(1.5) hue-rotate(310deg) brightness(1.08)' },
  { id: 'warm',  label: 'Warm',   css: 'sepia(0.35) saturate(1.3) hue-rotate(-10deg) brightness(1.05)' },
  { id: 'cool',  label: 'Cool',   css: 'saturate(1.1) hue-rotate(15deg) brightness(1.05) contrast(1.05)' },
  { id: 'vivid', label: 'Vivid',  css: 'saturate(1.6) contrast(1.1)' },
  { id: 'soft',  label: 'Soft',   css: 'brightness(1.1) contrast(0.9) saturate(1.1)' },
  { id: 'sepia', label: 'Sepia',  css: 'sepia(0.9)' },
  { id: 'bw',    label: 'B&W',    css: 'grayscale(1)' }
];
const FILTER_OK = (typeof CanvasRenderingContext2D !== 'undefined') && ('filter' in CanvasRenderingContext2D.prototype);

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
const stSrcScreen = document.getElementById('stSrcScreen');
const stSourceRow = document.getElementById('stSourceRow');
const stFileBlock = document.getElementById('stFileBlock');
const stFileChoose = document.getElementById('stFileChoose');
const stFileInput = document.getElementById('stFileInput');
const stFileName = document.getElementById('stFileName');
const stLoop = document.getElementById('stLoop');
const stFilePlayBtn = document.getElementById('stFilePlayBtn');

const stCamBtn = document.getElementById('stCamBtn');
const stMuteBtn = document.getElementById('stMuteBtn');
const stRatioRow = document.getElementById('stRatioRow');
const stFilterBlock = document.getElementById('stFilterBlock');
const stFilterRow = document.getElementById('stFilterRow');
const stFxSelect = document.getElementById('stFxSelect');

const TOKEN_PLACEHOLDER = '— — — —';

let sourceMode = 'camera'; // 'camera' | 'file' | 'screen'
let chosenFile = null;

// pengaturan yang dipilih user (dipakai sebelum start dan bisa diubah saat live)
const settings = { ratio: '16:9', filter: 'none', fx: 'none', muted: false, cam: false };

let socket = null;
let bc = null; // active broadcast
let vw = null; // active viewer session

function setStatus(el, text, kind){
  el.textContent = text;
  el.className = 'stream-status' + (kind ? ' ' + kind : '');
}

// atur bentuk kotak video mengikuti rasio (16:9 lebar penuh, 9:16 / 3:4 lebih sempit)
function fitBox(video, w, h){
  const box = video && video.parentElement;
  if(!box || !w || !h) return;
  box.style.aspectRatio = w + ' / ' + h;
  box.style.width = h > w ? 'min(100%, ' + Math.round(600 * w / h) + 'px)' : '100%';
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
// Signaling lewat PeerJS Cloud (hanya sebagai "kurir" pesan signaling).
// Objek ini meniru API socket.io (on / off / emit / id) dengan event yang SAMA
// (join-room, join-as-viewer, viewer-joined, offer, answer, ice-candidate, leave-room).
// Media tetap dikirim langsung lewat WebRTC (RTCPeerConnection).
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
        peer.on('open', id => { api.id = id; console.log('[stream] broadcaster ready:', id); fire('signal-ready', {}); });
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
          console.log('[stream] viewer connecting to blush-' + roomId);
          const conn = peer.connect('blush-' + roomId, { serialization: 'json', reliable: true });
          trackConn(conn);
          conn.on('open', () => { conns[conn.peer] = conn; console.log('[stream] connected to broadcaster'); });
        });
        peer.on('error', onPeerError);
      }
      else if(ev === 'offer' || ev === 'answer'){
        const c = conns[payload.target];
        if(c && c.open) c.send({ t: ev, sdp: clean(payload.sdp) });
      }
      else if(ev === 'ice-candidate'){
        // kirim ke target tertentu saja (bukan ke semua koneksi)
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
//  - PeerJS dulu  -> token yang sama jalan di localhost MAUPUN di Vercel
//                    (sebelumnya localhost pakai Socket.IO dan Vercel pakai PeerJS,
//                     jadi broadcaster & viewer di dua tempat berbeda tidak ketemu)
//  - kalau PeerJS tidak bisa dimuat (mis. LAN tanpa internet) -> cadangan Socket.IO
// ---------------------------------------------------------------
let signalingReady = null;
function prepareSignaling(){
  if(signalingReady) return signalingReady;
  signalingReady = (async () => {
    const ok = await loadPeerJS();
    if(ok){
      socket = createPeerSignaling();
      return socket;
    }
    if(typeof io !== 'undefined'){
      socket = io();
      socket.isPeer = false;
      return socket;
    }
    return null;
  })();
  return signalingReady;
}

const NO_SERVER_MSG = 'stream server not reachable — check your internet connection (PeerJS could not be loaded), or open this page from the blush live server.';

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

// ===== MEDIA SOURCE =====
// Semua sumber (kamera / share screen / video file) digambar ke <canvas>, jadi
// rasio, filter, dan bubble kamera ikut terkirim ke viewer. Audio lewat Web Audio
// (mute + voice effect). Return { stream, cleanup, endedTrack, fileEl, warning, ctl }.
function waitForVideos(list, ms){
  return new Promise(resolve => {
    const t0 = Date.now();
    (function check(){
      if(list.every(v => v.videoWidth) || Date.now() - t0 > (ms || 3000)) resolve();
      else setTimeout(check, 50);
    })();
  });
}

async function createSource(mode, file){
  const hasDisplay = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  if(mode === 'screen' && !hasDisplay) throw new Error('screen share is not supported in this browser');

  // ---- audio graph ----
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();                       // dibuat di awal (masih dalam klik user) supaya tidak "suspended"
  try{ ac.resume(); }catch(e){}
  const dest = ac.createMediaStreamDestination();
  const master = ac.createGain();            // tombol mute
  const mediaGain = ac.createGain();         // suara layar / file
  const micGain = ac.createGain();           // suara mic (setelah voice effect)
  const fxIn = ac.createGain();              // pintu masuk mic ke voice effect
  master.gain.value = settings.muted ? 0 : 1;
  mediaGain.connect(master);
  micGain.connect(master);
  master.connect(dest);

  let fxNodes = [], oscs = [];
  function setFx(name){
    try{ fxIn.disconnect(); }catch(e){}
    oscs.forEach(o => { try{ o.stop(); }catch(e){} });
    fxNodes.forEach(n => { try{ n.disconnect(); }catch(e){} });
    oscs = []; fxNodes = [];

    if(name === 'echo'){
      const delay = ac.createDelay(1); delay.delayTime.value = 0.28;
      const fb = ac.createGain(); fb.gain.value = 0.4;
      const wet = ac.createGain(); wet.gain.value = 0.6;
      fxIn.connect(micGain);
      fxIn.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(micGain);
      fxNodes.push(delay, fb, wet);
    }else if(name === 'robot'){
      const ring = ac.createGain(); ring.gain.value = 0;
      const osc = ac.createOscillator(); osc.type = 'sine'; osc.frequency.value = 55;
      osc.connect(ring.gain); osc.start();
      fxIn.connect(ring); ring.connect(micGain);
      fxNodes.push(ring); oscs.push(osc);
    }else if(name === 'deep'){
      // suara dibuat lebih "berat" (bass naik, treble turun) — bukan pitch shift asli
      const low = ac.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 220; low.gain.value = 12;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
      const g = ac.createGain(); g.gain.value = 0.9;
      fxIn.connect(low); low.connect(lp); lp.connect(g); g.connect(micGain);
      fxNodes.push(low, lp, g);
    }else if(name === 'radio'){
      const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 450;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      const shaper = ac.createWaveShaper();
      const k = 20, n = 256, curve = new Float32Array(n);
      for(let i = 0; i < n; i++){
        const x = i * 2 / n - 1;
        curve[i] = (3 + k) * x * 20 * Math.PI / 180 / (Math.PI + k * Math.abs(x));
      }
      shaper.curve = curve;
      fxIn.connect(hp); hp.connect(lp); lp.connect(shaper); shaper.connect(micGain);
      fxNodes.push(hp, lp, shaper);
    }else{
      fxIn.connect(micGain);
    }
  }
  setFx(settings.fx);

  const addMic = stream => {
    if(stream && stream.getAudioTracks().length){
      ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(fxIn);
    }
  };

  // ---- video elements (tidak dipasang di halaman) ----
  const makeVideo = () => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    return v;
  };
  const camV = makeVideo();
  let baseV = makeVideo();

  const raw = [];                 // semua MediaStream mentah, dihentikan saat cleanup
  let camStream = null, camOn = false;
  let screenStream = null, fileEl = null, fileUrl = null;
  let worker = null, fallbackTimer = null;
  let warning = '';

  const cleanup = () => {
    if(worker){ try{ worker.terminate(); }catch(e){} worker = null; }
    if(fallbackTimer){ clearInterval(fallbackTimer); fallbackTimer = null; }
    oscs.forEach(o => { try{ o.stop(); }catch(e){} });
    camV.srcObject = null;
    baseV.srcObject = null;
    if(fileEl){
      fileEl.onended = null;
      fileEl.pause();
      fileEl.removeAttribute('src');
      fileEl.load();
    }
    if(fileUrl){ URL.revokeObjectURL(fileUrl); fileUrl = null; }
    raw.forEach(st => st.getTracks().forEach(t => t.stop()));
    if(camStream) camStream.getTracks().forEach(t => t.stop());
    try{ ac.close(); }catch(e){}
  };

  // nyalakan / matikan bubble kamera (untuk mode screen & file)
  async function setCam(on){
    if(mode === 'camera') return true;     // mode kamera: kamera selalu nyala
    if(on){
      if(camOn) return true;
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      camStream = s;
      camV.srcObject = s;
      try{ await camV.play(); }catch(e){}
      camOn = true;
      return true;
    }
    camOn = false;
    if(camStream){ camStream.getTracks().forEach(t => t.stop()); camStream = null; }
    camV.srcObject = null;
    return false;
  }

  try{
    if(mode === 'camera'){
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
      camStream = s;
      camOn = true;
      camV.srcObject = new MediaStream(s.getVideoTracks());
      addMic(s);
      await camV.play();
      await waitForVideos([camV]);
    }else if(mode === 'screen'){
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      raw.push(screenStream);
      baseV.srcObject = new MediaStream(screenStream.getVideoTracks());
      if(screenStream.getAudioTracks().length){
        ac.createMediaStreamSource(new MediaStream(screenStream.getAudioTracks())).connect(mediaGain);
      }
      try{
        const m = await navigator.mediaDevices.getUserMedia({ audio: true });
        raw.push(m);
        addMic(m);
      }catch(e){
        warning = 'mic permission denied — streaming without your voice.';
      }
      await baseV.play();
      await waitForVideos([baseV]);
    }else{
      fileUrl = URL.createObjectURL(file);
      fileEl = makeVideo();
      fileEl.muted = false;                  // audio lewat Web Audio, bukan lewat elemen
      fileEl.loop = stLoop.checked;
      fileEl.src = fileUrl;
      const msrc = ac.createMediaElementSource(fileEl);
      msrc.connect(mediaGain);               // ke viewer
      msrc.connect(ac.destination);          // streamer ikut dengar
      baseV = fileEl;
      await fileEl.play();
      await waitForVideos([fileEl]);
    }

    if(mode !== 'camera' && settings.cam){
      try{ await setCam(true); }
      catch(e){ warning = warning || 'camera permission denied — streaming without the cam bubble.'; settings.cam = false; }
    }
  }catch(err){
    cleanup();
    throw err;
  }

  // ---- canvas compositor ----
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let filterCss = 'none';

  function drawCover(v, W, H){
    const vw = v.videoWidth, vh = v.videoHeight;
    if(!vw || !vh) return;
    const s = Math.max(W / vw, H / vh);
    const sw = W / s, sh = H / s;
    ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, W, H);
  }
  function drawContain(v, W, H){
    const vw = v.videoWidth, vh = v.videoHeight;
    if(!vw || !vh) return;
    const s = Math.min(W / vw, H / vh);
    const dw = vw * s, dh = vh * s;
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  function draw(){
    const W = canvas.width, H = canvas.height;
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if(FILTER_OK) ctx.filter = filterCss;

    if(mode === 'camera'){
      drawCover(camV, W, H);
    }else{
      drawContain(baseV, W, H);
      if(camOn && camV.videoWidth){
        // kamera bulat kecil di pojok kanan bawah
        const r = Math.round(Math.min(W, H) * 0.15);
        const cx = W - r - Math.round(W * 0.03);
        const cy = H - r - Math.round(H * 0.04);
        const side = Math.min(camV.videoWidth, camV.videoHeight);
        const sx = (camV.videoWidth - side) / 2, sy = (camV.videoHeight - side) / 2;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(camV, sx, sy, side, side, cx - r, cy - r, r * 2, r * 2);
        ctx.restore();
        ctx.filter = 'none';
        ctx.lineWidth = Math.max(3, Math.round(r * 0.06));
        ctx.strokeStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.filter = 'none';
  }

  function setRatio(key){
    const r = RATIOS[key] || RATIOS['16:9'];
    canvas.width = r.w;
    canvas.height = r.h;
    fitBox(stLocalVideo, r.w, r.h);
    draw();
  }
  function setFilter(id){
    const f = FILTERS.find(x => x.id === id);
    filterCss = f ? f.css : 'none';
  }
  setFilter(settings.filter);
  setRatio(settings.ratio);

  // Timer lewat Web Worker: tab yang ditinggal (user pindah ke window yang dibagikan)
  // di-throttle browser, tapi timer di Worker tidak.
  try{
    const blob = new Blob(['setInterval(function(){ postMessage(0); }, 33);'], { type: 'application/javascript' });
    worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = draw;
  }catch(e){
    fallbackTimer = setInterval(draw, 33);
  }

  const out = canvas.captureStream(30);
  dest.stream.getAudioTracks().forEach(t => out.addTrack(t));

  stLocalVideo.srcObject = out;
  stLocalVideo.muted = true;       // preview dibisukan supaya tidak echo
  stLocalVideo.controls = false;

  return {
    stream: out,
    endedTrack: screenStream ? screenStream.getVideoTracks()[0] : null,
    fileEl,
    warning,
    cleanup,
    ctl: {
      setRatio,
      setFilter,
      setFx,
      setCam,
      camOn: () => camOn,
      setMuted(m){ master.gain.value = m ? 0 : 1; },
      setLoop(l){ if(fileEl) fileEl.loop = l; },
      togglePlay(){
        if(!fileEl) return false;
        if(fileEl.paused){ fileEl.play().catch(() => {}); return false; }
        fileEl.pause();
        return true;   // sekarang paused
      }
    }
  };
}

// ===== UI helpers (tombol kontrol stream) =====
function refreshCamBtn(){
  stCamBtn.classList.toggle('active', settings.cam);
  stCamBtn.innerHTML = settings.cam
    ? '<i class="fa-solid fa-video"></i> <span class="txt">Cam on</span>'
    : '<i class="fa-solid fa-video-slash"></i> <span class="txt">Cam off</span>';
}
function refreshMuteBtn(){
  stMuteBtn.classList.toggle('active', settings.muted);
  stMuteBtn.innerHTML = settings.muted
    ? '<i class="fa-solid fa-microphone-slash"></i> <span class="txt">Unmute audio</span>'
    : '<i class="fa-solid fa-microphone"></i> <span class="txt">Mute audio</span>';
}
function refreshPlayBtn(paused){
  stFilePlayBtn.innerHTML = paused
    ? '<i class="fa-solid fa-play"></i> <span class="txt">Play</span>'
    : '<i class="fa-solid fa-pause"></i> <span class="txt">Pause</span>';
}

function setSourceMode(mode){
  sourceMode = mode;
  stSrcCam.classList.toggle('active', mode === 'camera');
  stSrcFile.classList.toggle('active', mode === 'file');
  if(stSrcScreen) stSrcScreen.classList.toggle('active', mode === 'screen');
  stFileBlock.style.display = mode === 'file' ? 'flex' : 'none';
  // tombol Cam on/off hanya untuk share screen / share media (mode kamera sudah full camera)
  stCamBtn.style.display = mode === 'camera' ? 'none' : '';
  setStatus(stBroadcastStatus,
    mode === 'file'   ? 'choose a video to share, then press start. tap "Cam" if you want your face in the corner.' :
    mode === 'screen' ? 'press start, then pick a screen / window / tab to share (tick "share audio" for sound). tap "Cam" to show your face in the corner.' :
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

  if((sourceMode === 'camera' || sourceMode === 'screen') && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)){
    setStatus(stBroadcastStatus, 'camera / mic access needs https — open the https:// address of the site.', 'warn');
    stStartBtn.disabled = false;
    return;
  }
  if(sourceMode === 'file' && !chosenFile){
    setStatus(stBroadcastStatus, 'choose a video file first.', 'warn');
    stStartBtn.disabled = false;
    return;
  }

  setStatus(stBroadcastStatus,
    sourceMode === 'file'   ? 'loading your video…' :
    sourceMode === 'screen' ? 'waiting for you to pick what to share…' :
                              'asking for camera & mic…');

  let source, localStream;
  try{
    source = await createSource(sourceMode, chosenFile);
    localStream = source.stream;
  }catch(err){
    console.error(err);
    setStatus(stBroadcastStatus,
      sourceMode === 'file'   ? 'could not play that file — try another video (mp4 / webm).' :
      sourceMode === 'screen' ? 'screen share was cancelled, or is not supported here.' :
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

  // candidate dari viewer X hanya masuk ke koneksi viewer X
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
  if(source.fileEl){
    source.fileEl.onended = () => {
      refreshPlayBtn(true);
      if(bc) setStatus(stBroadcastStatus, 'video finished — press Play to watch again, or stop the broadcast.', 'warn');
    };
    stFilePlayBtn.style.display = '';
    refreshPlayBtn(false);
  }

  settings.cam = source.ctl.camOn();
  refreshCamBtn();

  stStopBtn.style.display = '';
  stStartBtn.style.display = 'none';
  stSourceRow.classList.add('locked');
  stRatioRow.classList.add('locked');
  stFileChoose.classList.add('locked');
  lockTabs();
  updateViewerCount();
  if(source.warning) setStatus(stBroadcastStatus, source.warning, 'warn');
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
  stRatioRow.classList.remove('locked');
  stFileChoose.classList.remove('locked');
  stFilePlayBtn.style.display = 'none';
  const r = RATIOS[settings.ratio];
  fitBox(stLocalVideo, r.w, r.h);

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
    setStatus(stViewerStatus, `no stream yet (${s.isPeer ? 'online' : 'local server'} mode) — check the token, or the broadcaster may not be live.`, 'warn');
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
  fitBox(stRemoteVideo, 16, 9);
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
stLoop.onchange = () => { if(bc) bc.source.ctl.setLoop(stLoop.checked); };
stFilePlayBtn.onclick = () => {
  if(!bc) return;
  refreshPlayBtn(bc.source.ctl.togglePlay());
};

// Cam on/off (bubble kamera) — bisa dinyalakan / dimatikan kapan saja saat live
stCamBtn.onclick = async () => {
  const want = !settings.cam;
  if(!bc){
    settings.cam = want;
    refreshCamBtn();
    return;
  }
  stCamBtn.disabled = true;
  try{
    settings.cam = await bc.source.ctl.setCam(want);
  }catch(err){
    console.warn(err);
    settings.cam = false;
    setStatus(stBroadcastStatus, 'could not turn on the camera — check the browser permission.', 'warn');
  }
  stCamBtn.disabled = false;
  refreshCamBtn();
};

// Mute semua suara yang keluar ke viewer
stMuteBtn.onclick = () => {
  settings.muted = !settings.muted;
  if(bc) bc.source.ctl.setMuted(settings.muted);
  refreshMuteBtn();
};

// Rasio (dikunci saat live)
stRatioRow.querySelectorAll('[data-ratio]').forEach(btn => {
  btn.onclick = () => {
    if(bc) return;
    settings.ratio = btn.dataset.ratio;
    stRatioRow.querySelectorAll('[data-ratio]').forEach(b => b.classList.toggle('active', b === btn));
    const r = RATIOS[settings.ratio];
    fitBox(stLocalVideo, r.w, r.h);
  };
});

// Filter
if(!FILTER_OK){
  stFilterBlock.style.display = 'none';   // browser tanpa ctx.filter (mis. Safari)
}else{
  FILTERS.forEach(f => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'filter-chip' + (f.id === settings.filter ? ' active' : '');
    b.textContent = f.label;
    b.onclick = () => {
      settings.filter = f.id;
      stFilterRow.querySelectorAll('.filter-chip').forEach(x => x.classList.toggle('active', x === b));
      if(bc) bc.source.ctl.setFilter(f.id);
    };
    stFilterRow.appendChild(b);
  });
}

// Voice effect (untuk mic)
stFxSelect.onchange = () => {
  settings.fx = stFxSelect.value;
  if(bc) bc.source.ctl.setFx(settings.fx);
};

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
  const roomId = stTokenInput.value.trim().toLowerCase();
  if(!roomId){ setStatus(stViewerStatus, 'enter a token first.', 'warn'); return; }
  startView(roomId);
}
stJoinBtn.onclick = joinFromInput;
stLeaveBtn.onclick = () => leaveView();
stTokenInput.addEventListener('keydown', e => { if(e.key === 'Enter') joinFromInput(); });

// kotak video viewer menyesuaikan rasio video yang masuk (16:9 / 9:16 / 3:4)
const fitRemote = () => { if(stRemoteVideo.videoWidth) fitBox(stRemoteVideo, stRemoteVideo.videoWidth, stRemoteVideo.videoHeight); };
stRemoteVideo.addEventListener('loadedmetadata', fitRemote);
stRemoteVideo.addEventListener('resize', fitRemote);

stToken.textContent = TOKEN_PLACEHOLDER;
refreshCamBtn();
refreshMuteBtn();
setSourceMode('camera');
switchStreamTab('broadcast');

// siapkan signaling dari awal (load PeerJS di background) supaya
// pas tombol Start / Join ditekan sudah siap dan user gesture tidak hilang.
prepareSignaling();
})();