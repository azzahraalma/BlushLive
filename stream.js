(function(){
'use strict';

const ICE_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

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
const stSourceRow = document.getElementById('stSourceRow');
const stFileBlock = document.getElementById('stFileBlock');
const stFileInput = document.getElementById('stFileInput');
const stFileName = document.getElementById('stFileName');
const stLoop = document.getElementById('stLoop');

const TOKEN_PLACEHOLDER = '— — — —';

let sourceMode = 'camera'; // 'camera' | 'file'
let chosenFile = null;

let socket = null;
let bc = null; // active broadcast
let vw = null; // active viewer session

function setStatus(el, text, kind){
  el.textContent = text;
  el.className = 'stream-status' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------
// Signaling cadangan untuk hosting statis (Vercel dll.).
// Vercel tidak bisa menjalankan server Socket.IO, jadi kalau `io` tidak ada,
// kita pakai PeerJS Cloud hanya sebagai "kurir" pesan signaling.
// Objek ini meniru API socket.io (on / off / emit / id) dengan event yang SAMA
// (join-room, join-as-viewer, viewer-joined, offer, answer, ice-candidate, leave-room),
// jadi seluruh logika broadcaster & viewer di bawah tidak perlu diubah.
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
  }

  function trackConn(conn){
    conn.on('data', m => onMessage(conn.peer, m));
    conn.on('close', () => { delete conns[conn.peer]; });
    conn.on('error', err => console.warn('peer connection error:', err));
  }

  function closeAll(){
    Object.values(conns).forEach(c => { try{ c.close(); }catch(e){} });
    Object.keys(conns).forEach(k => delete conns[k]);
    if(peer){ try{ peer.destroy(); }catch(e){} }
    peer = null;
    role = null;
    api.id = null;
  }

  const api = {
    id: null,
    on(ev, fn){ (handlers[ev] = handlers[ev] || []).push(fn); return api; },
    off(ev, fn){ handlers[ev] = (handlers[ev] || []).filter(f => f !== fn); return api; },
    emit(ev, payload){
      if(ev === 'join-room'){
        closeAll();
        role = 'broadcaster';
        peer = new Peer('blush-' + payload);
        peer.on('open', id => { api.id = id; });
        peer.on('connection', conn => {
          trackConn(conn);
          conn.on('open', () => {
            conns[conn.peer] = conn;
            fire('viewer-joined', { viewerId: conn.peer });
          });
        });
        peer.on('error', err => console.warn('peer error:', err));
      }
      else if(ev === 'join-as-viewer'){
        closeAll();
        role = 'viewer';
        peer = new Peer();
        peer.on('open', id => {
          api.id = id;
          const conn = peer.connect('blush-' + payload, { serialization: 'json', reliable: true });
          trackConn(conn);
          conn.on('open', () => { conns[conn.peer] = conn; });
        });
        peer.on('error', err => console.warn('peer error:', err));
      }
      else if(ev === 'offer' || ev === 'answer'){
        const c = conns[payload.target];
        if(c && c.open) c.send({ t: ev, sdp: clean(payload.sdp) });
      }
      else if(ev === 'ice-candidate'){
        const msg = { t: 'ice', candidate: clean(payload.candidate) };
        Object.values(conns).forEach(c => { if(c.open) c.send(msg); });
      }
      else if(ev === 'leave-room'){
        closeAll();
      }
      return api;
    }
  };
  return api;
}

function getSocket(){
  if(socket) return socket;
  if(typeof io !== 'undefined'){            // server lokal (Node + Socket.IO) — cara asli
    socket = io();
    return socket;
  }
  if(typeof Peer !== 'undefined'){          // hosting statis (Vercel) — signaling via PeerJS
    socket = createPeerSignaling();
    return socket;
  }
  return null;
}

const NO_SERVER_MSG = 'stream server not reachable — open this page from the blush live server (https://<your-ip>:8080), or from the online link with internet access.';

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
// Returns { stream, cleanup }. Camera -> getUserMedia, file -> <video>.captureStream().
async function getCameraSource(){
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  stLocalVideo.muted = true;
  stLocalVideo.controls = false;
  stLocalVideo.srcObject = stream;
  return { stream, cleanup(){} };
}

async function getFileSource(file){
  const url = URL.createObjectURL(file);
  stLocalVideo.srcObject = null;
  stLocalVideo.src = url;
  stLocalVideo.loop = stLoop.checked;
  stLocalVideo.muted = false;      // the broadcaster can hear it; viewers get their own copy
  stLocalVideo.controls = true;    // play / pause / seek — viewers follow
  stLocalVideo.playsInline = true;

  // tracks only exist once the element is really playing
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

  return {
    stream,
    cleanup(){
      stLocalVideo.pause();
      stLocalVideo.removeAttribute('src');
      stLocalVideo.load();
      stLocalVideo.controls = false;
      stLocalVideo.muted = true;
      URL.revokeObjectURL(url);
    }
  };
}

function setSourceMode(mode){
  sourceMode = mode;
  stSrcCam.classList.toggle('active', mode === 'camera');
  stSrcFile.classList.toggle('active', mode === 'file');
  stFileBlock.style.display = mode === 'file' ? 'flex' : 'none';
  setStatus(stBroadcastStatus, mode === 'file'
    ? 'choose a video file, then press start.'
    : 'press start to turn on your camera and get a token.');
}

// ===== BROADCASTER =====
async function startBroadcast(){
  if(bc) return;

  const s = getSocket();
  if(!s){ setStatus(stBroadcastStatus, NO_SERVER_MSG, 'warn'); return; }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    setStatus(stBroadcastStatus, 'camera access needs https — open the https:// address of the server.', 'warn');
    return;
  }

  if(sourceMode === 'file' && !chosenFile){
    setStatus(stBroadcastStatus, 'choose a video file first.', 'warn');
    return;
  }

  stStartBtn.disabled = true;
  setStatus(stBroadcastStatus, sourceMode === 'file' ? 'loading your video…' : 'asking for camera & mic…');

  let source, localStream;
  try{
    source = sourceMode === 'file' ? await getFileSource(chosenFile) : await getCameraSource();
    localStream = source.stream;
  }catch(err){
    console.error(err);
    setStatus(stBroadcastStatus, sourceMode === 'file'
      ? 'could not play that file — try another video (mp4 / webm).'
      : 'could not open camera/mic — check the browser permission.', 'warn');
    stStartBtn.disabled = false;
    return;
  }

  const roomId = Math.random().toString(36).substring(2, 10);
  const peerConnections = {};
  stToken.textContent = roomId;

  function updateViewerCount(){
    const n = Object.values(peerConnections).filter(pc => pc.connectionState === 'connected').length;
    setStatus(stBroadcastStatus, n === 0 ? 'live — waiting for viewers…' : `live — ${n} viewer${n > 1 ? 's' : ''} watching`, 'on');
  }

  const onViewerJoined = async ({ viewerId }) => {
    console.log(`Viewer ${viewerId} joined, creating connection...`);
    const pc = new RTCPeerConnection(ICE_CONFIG);
    peerConnections[viewerId] = pc;

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = event => {
      if(event.candidate){
        s.emit('ice-candidate', { roomId, candidate: event.candidate });
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

  const onIce = ({ candidate, senderId }) => {
    Object.values(peerConnections).forEach(pc => {
      if(senderId !== s.id) addCandidate(pc, candidate);
    });
  };

  s.on('viewer-joined', onViewerJoined);
  s.on('answer', onAnswer);
  s.on('ice-candidate', onIce);
  s.emit('join-room', roomId);

  bc = { roomId, localStream, source, peerConnections, onViewerJoined, onAnswer, onIce };

  stStopBtn.style.display = '';
  stStartBtn.style.display = 'none';
  stSourceRow.classList.add('locked');
  stFileBlock.classList.add('locked');
  lockTabs();
  updateViewerCount();
}

function stopBroadcast(){
  if(!bc) return;
  const s = getSocket();
  if(s){
    s.off('viewer-joined', bc.onViewerJoined);
    s.off('answer', bc.onAnswer);
    s.off('ice-candidate', bc.onIce);
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
  setStatus(stBroadcastStatus, 'broadcast stopped.');
}

// ===== VIEWER =====
function startView(roomId){
  if(vw) return;

  const s = getSocket();
  if(!s){ setStatus(stViewerStatus, NO_SERVER_MSG, 'warn'); return; }

  const session = { roomId, pc: null, waitTimer: null };

  const onOffer = async ({ sdp, broadcasterId }) => {
    console.log('Got offer from broadcaster');
    clearTimeout(session.waitTimer);
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
        s.emit('ice-candidate', { roomId, candidate: event.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      if(pc.connectionState === 'connected') setStatus(stViewerStatus, 'connected — enjoy the stream ♡', 'on');
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
    if(session.pc && senderId !== s.id) addCandidate(session.pc, candidate);
  };

  s.on('offer', onOffer);
  s.on('ice-candidate', onIce);
  s.emit('join-as-viewer', roomId);

  session.onOffer = onOffer;
  session.onIce = onIce;
  session.waitTimer = setTimeout(() => {
    setStatus(stViewerStatus, 'no stream yet — check the token, or the broadcaster may not be live.', 'warn');
  }, 8000);
  vw = session;

  stJoinBtn.style.display = 'none';
  stLeaveBtn.style.display = '';
  stTokenInput.disabled = true;
  lockTabs();
  setStatus(stViewerStatus, 'joined — waiting for the broadcaster…');
}

function leaveView(){
  if(!vw) return;
  const s = getSocket();
  clearTimeout(vw.waitTimer);
  if(s){
    s.off('offer', vw.onOffer);
    s.off('ice-candidate', vw.onIce);
    s.emit('leave-room', vw.roomId);
  }
  if(vw.pc){ vw.pc.onconnectionstatechange = null; vw.pc.close(); }
  stRemoteVideo.srcObject = null;
  vw = null;

  stJoinBtn.style.display = '';
  stLeaveBtn.style.display = 'none';
  stTokenInput.disabled = false;
  lockTabs();
  setStatus(stViewerStatus, 'left the stream.');
}

// ===== UI wiring =====
stTabBroadcast.onclick = () => switchStreamTab('broadcast');
stTabViewer.onclick = () => switchStreamTab('viewer');

stSrcCam.onclick = () => { if(!bc) setSourceMode('camera'); };
stSrcFile.onclick = () => { if(!bc) setSourceMode('file'); };
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
stStopBtn.onclick = stopBroadcast;

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
stLeaveBtn.onclick = leaveView;
stTokenInput.addEventListener('keydown', e => { if(e.key === 'Enter') joinFromInput(); });

stToken.textContent = TOKEN_PLACEHOLDER;
switchStreamTab('broadcast');
})();