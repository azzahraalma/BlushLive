(function(){
'use strict';

const ICE_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const $ = id => document.getElementById(id);
const TOKEN_PLACEHOLDER = '— — — —';
const NO_SERVER_MSG = 'stream server not reachable — open this page from the blush live server (https://<your-ip>:8080)';
const VOICES = [['none','Original'],['robot','Robot'],['echo','Echo'],['deep','Deep'],['radio','Radio']];

// page switch (booth <-> stream)
const boothSec = $('booth'), streamSec = $('stream'), pageSwitch = $('pageSwitch');

// stream tabs + panels
const streamTabs = $('streamTabs'), stTabBroadcast = $('stTabBroadcast'), stTabViewer = $('stTabViewer');
const stBroadcastPanel = $('stBroadcastPanel'), stViewerPanel = $('stViewerPanel');
const boxB = $('stBoxB'), boxV = $('stBoxV');

const stLocalVideo = $('stLocalVideo'), stRemoteVideo = $('stRemoteVideo');
const stToken = $('stToken'), stStartBtn = $('stStartBtn'), stStopBtn = $('stStopBtn');
const stNameInput = $('stNameInput'), stTokenInput = $('stTokenInput'), stJoinBtn = $('stJoinBtn'), stLeaveBtn = $('stLeaveBtn');
const stBroadcastStatus = $('stBroadcastStatus'), stViewerStatus = $('stViewerStatus');

const stMirrorBtn = $('stMirrorBtn'), stCamBtn = $('stCamBtn'), stMicBtn = $('stMicBtn');
const stFilterBtn = $('stFilterBtn'), stVoiceBtn = $('stVoiceBtn'), stPop = $('stPop');
const stViewerMuteBtn = $('stViewerMuteBtn');
const stMutedNote = $('stMutedNote'), stEnded = $('stEnded'), stHostMuted = $('stHostMuted');

let socket = null;
let bc = null; // active broadcast
let vw = null; // active viewer session

function setStatus(el, text, kind){
  el.textContent = text;
  el.className = 'stream-status' + (kind ? ' ' + kind : '');
}

/* ================= PAGE SWITCH ================= */
function isLive(){ return !!(bc || vw); }

function showPage(which){
  if(which === 'booth' && isLive()){
    setStatus(bc ? stBroadcastStatus : stViewerStatus,
      bc ? 'end your broadcast first to go back to the booth.' : 'leave the stream first to go back to the booth.', 'warn');
    return false;
  }
  boothSec.style.display = which === 'booth' ? '' : 'none';
  streamSec.style.display = which === 'stream' ? '' : 'none';
  pageSwitch.dataset.page = which;
  pageSwitch.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.page === which));
  return true;
}

function lockUI(){
  const live = isLive();
  streamTabs.classList.toggle('locked', live);
  pageSwitch.classList.toggle('locked', live);
}

pageSwitch.querySelectorAll('button').forEach(b => {
  b.addEventListener('click', () => {
    if(showPage(b.dataset.page)) $(b.dataset.page).scrollIntoView({ behavior: 'smooth' });
  });
});
// nav links + hero button
document.querySelectorAll('a[href="#booth"], a[href="#stream"]').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    const target = a.getAttribute('href').slice(1);
    if(showPage(target)) $(target).scrollIntoView({ behavior: 'smooth' });
  });
});

function switchStreamTab(which){
  const toViewer = which === 'viewer';
  if(toViewer && bc){ setStatus(stBroadcastStatus, 'end your broadcast first to switch to Watch.', 'warn'); return; }
  if(!toViewer && vw){ setStatus(stViewerStatus, 'leave the stream first to switch to Broadcast.', 'warn'); return; }
  stTabBroadcast.classList.toggle('active', !toViewer);
  stTabViewer.classList.toggle('active', toViewer);
  stBroadcastPanel.style.display = toViewer ? 'none' : 'flex';
  stViewerPanel.style.display = toViewer ? 'flex' : 'none';
}

/* ================= OVERLAY HELPERS ================= */
function setCount(box, n){
  box.querySelector('.vc').textContent = `${n} viewer${n === 1 ? '' : 's'}`;
}
function addChat(box, m){
  const list = box.querySelector('.st-chat');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const el = document.createElement('div');
  if(m.system){
    el.className = 'st-msg sys';
    el.textContent = m.text;
  }else{
    el.className = 'st-msg' + (m.host ? ' host' : '');
    const b = document.createElement('b'); b.textContent = m.name;
    const t = document.createElement('span'); t.textContent = ' ' + m.text;
    el.append(b, t);
  }
  list.appendChild(el);
  while(list.children.length > 300) list.firstChild.remove();
  if(atBottom) list.scrollTop = list.scrollHeight; // stay pinned unless the user scrolled up
}
function clearOverlay(box){
  box.querySelector('.st-chat').innerHTML = '';
  setCount(box, 0);
}
function setLiveBox(box, on){ box.classList.toggle('live', on); }

function wireChat(form, getSession){
  form.addEventListener('submit', e => {
    e.preventDefault();
    const input = form.querySelector('input');
    const text = input.value.trim();
    const sess = getSession();
    if(!text || !sess || !socket) return;
    socket.emit('chat-message', { roomId: sess.roomId, text });
    input.value = '';
  });
}
wireChat($('stChatFormB'), () => bc);
wireChat($('stChatFormV'), () => vw);

function setRail(btn, icon, label, state){
  btn.querySelector('i').className = 'fa-solid ' + icon;
  btn.querySelector('span').textContent = label;
  btn.classList.remove('on', 'off');
  if(state) btn.classList.add(state);
}

/* ================= SOCKET ================= */
function getSocket(){
  if(socket) return socket;
  if(typeof io === 'undefined') return null;
  socket = io();

  // warn when the node server is still the old version
  let serverReady = false;
  socket.on('server-ready', () => { serverReady = true; });
  setTimeout(() => {
    if(serverReady) return;
    const msg = 'server is outdated — stop it (Ctrl+C) and run node server.js again.';
    if(bc) setStatus(stBroadcastStatus, msg, 'warn');
    else if(vw) setStatus(stViewerStatus, msg, 'warn');
  }, 2500);

  socket.on('viewer-count', ({ roomId, count }) => {
    const sess = bc || vw;
    if(!sess || sess.roomId !== roomId) return;
    setCount(bc ? boxB : boxV, count);
    if(bc) setStatus(stBroadcastStatus, count === 0 ? 'live — waiting for viewers…' : `live — ${count} viewer${count > 1 ? 's' : ''} watching`, 'on');
  });
  socket.on('chat-message', m => {
    const sess = bc || vw;
    if(!sess || sess.roomId !== m.roomId) return;
    addChat(bc ? boxB : boxV, m);
  });
  socket.on('chat-history', ({ roomId, messages }) => {
    if(!vw || vw.roomId !== roomId) return;
    messages.forEach(m => addChat(boxV, m));
  });
    socket.on('host-mic', ({ roomId, muted }) => {
    if(vw && vw.roomId === roomId) stHostMuted.hidden = !muted;
  });
  socket.on('stream-ended', ({ roomId }) => {
    if(vw && vw.roomId === roomId){
      leaveView();
      stEnded.hidden = false; // overlay "live has ended"
      setStatus(stViewerStatus, 'the live has ended.', 'warn');
    }
  });
  socket.on('no-stream', () => {
    if(vw){
      leaveView();
      setStatus(stViewerStatus, 'no live stream with that token.', 'warn');
    }
  });
  return socket;
}

async function addCandidate(pc, candidate){
  if(!pc.remoteDescription){ (pc._pending = pc._pending || []).push(candidate); return; }
  try{ await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
  catch(err){ console.warn('addIceCandidate failed:', err); }
}
async function flushCandidates(pc){
  const list = pc._pending || [];
  pc._pending = [];
  for(const c of list) await addCandidate(pc, c);
}

/* ================= BROADCAST PIPELINE =================
   camera -> canvas (filter + mirror) -> captureStream  (video)
   mic -> effect chain -> master gain (mute) -> destination (audio)
   Viewers receive the processed stream, so effects are seen/heard live. */
async function buildPipeline(raw, ac){
  const W = 1280, H = 720;
  const camVideo = document.createElement('video');
  camVideo.muted = true; camVideo.playsInline = true; camVideo.srcObject = raw;
  try{ await camVideo.play(); }catch(e){}

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const cx = canvas.getContext('2d');

  const st = { mirror: false, camOn: true, micOn: true, filter: 'none', voice: 'none' };
  let frozen = null; // blurred last frame, shown while the camera is off
  const filterCss = () => (FILTERS.find(f => f.id === st.filter) || FILTERS[0]).css || 'none';

  function draw(){
    cx.save();
    cx.filter = 'none';
    cx.fillStyle = '#000';
    cx.fillRect(0, 0, W, H);
    if(st.camOn && camVideo.videoWidth){
      const sc = Math.max(W / camVideo.videoWidth, H / camVideo.videoHeight); // cover: fill the whole frame
      const dw = camVideo.videoWidth * sc, dh = camVideo.videoHeight * sc;
      cx.filter = filterCss();
      if(st.mirror){ cx.translate(W, 0); cx.scale(-1, 1); }
      cx.drawImage(camVideo, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }else if(!st.camOn){
      if(frozen){
        cx.drawImage(frozen, 0, 0, W, H);
      }else{
        const g = cx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, '#ffb3d1'); g.addColorStop(1, '#ff5fa2');
        cx.fillStyle = g;
        cx.fillRect(0, 0, W, H);
      }
      cx.fillStyle = 'rgba(255,255,255,0.18)';
      cx.fillRect(0, 0, W, H);
      cx.shadowColor = 'rgba(0,0,0,0.45)';
      cx.shadowBlur = 14;
      cx.fillStyle = '#fff';
      cx.font = '600 40px Poppins, sans-serif';
      cx.textAlign = 'center';
      cx.textBaseline = 'middle';
      cx.fillText('camera off ♡', W / 2, H / 2);
    }
    cx.restore();
  }

  // take the last drawn frame and blur it (shrink + stretch, works in every browser)
  function freezeFrame(){
    frozen = null;
    if(!camVideo.videoWidth) return;
    try{
      const tiny = document.createElement('canvas');
      tiny.width = 64; tiny.height = 36;
      const tcx = tiny.getContext('2d');
      tcx.imageSmoothingEnabled = true; tcx.imageSmoothingQuality = 'high';
      tcx.drawImage(canvas, 0, 0, 64, 36);
      const big = document.createElement('canvas');
      big.width = W; big.height = H;
      const bcx = big.getContext('2d');
      bcx.imageSmoothingEnabled = true; bcx.imageSmoothingQuality = 'high';
      bcx.drawImage(tiny, 0, 0, W, H);
      frozen = big;
    }catch(e){ frozen = null; }
  }
  draw();
  const timer = setInterval(draw, 1000 / 30); // interval (not rAF) so it keeps running in a background tab

  // audio
  const src = ac.createMediaStreamSource(new MediaStream(raw.getAudioTracks()));
  const master = ac.createGain();
  const dest = ac.createMediaStreamDestination();
  master.connect(dest);
  let chain = [];

  function setVoice(id){
    st.voice = id;
    chain.forEach(n => { try{ n.disconnect(); }catch(e){} if(n.stop){ try{ n.stop(); }catch(e){} } });
    chain = [];
    src.disconnect();
    let out = src;
    if(id === 'robot'){
      const osc = ac.createOscillator(); osc.type = 'sine'; osc.frequency.value = 45;
      const ring = ac.createGain(); ring.gain.value = 0;
      src.connect(ring); osc.connect(ring.gain); osc.start();
      chain.push(osc, ring); out = ring;
    }else if(id === 'echo'){
      const delay = ac.createDelay(); delay.delayTime.value = 0.28;
      const fb = ac.createGain(); fb.gain.value = 0.35;
      const mix = ac.createGain();
      src.connect(mix); src.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(mix);
      chain.push(delay, fb, mix); out = mix;
    }else if(id === 'deep'){
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 750;
      const g = ac.createGain(); g.gain.value = 1.4;
      src.connect(lp); lp.connect(g);
      chain.push(lp, g); out = g;
    }else if(id === 'radio'){
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 5;
      const sh = ac.createWaveShaper(); sh.curve = makeDistortionCurve(12); sh.oversample = '4x';
      src.connect(bp); bp.connect(sh);
      chain.push(bp, sh); out = sh;
    }
    out.connect(master);
  }
  setVoice('none');

  const outStream = new MediaStream([
    ...canvas.captureStream(30).getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  return {
    st, outStream, setVoice,
    setCam(on){
      if(!on && st.camOn) freezeFrame();
      st.camOn = on;
      raw.getVideoTracks().forEach(t => t.enabled = on);
    },
    setMic(on){ st.micOn = on; master.gain.value = on ? 1 : 0; },
    destroy(){
      clearInterval(timer);
      raw.getTracks().forEach(t => t.stop());
      camVideo.srcObject = null;
      try{ ac.close(); }catch(e){}
    }
  };
}

/* ================= BROADCASTER ================= */
async function startBroadcast(){
  if(bc || vw) return;
  const s = getSocket();
  if(!s){ setStatus(stBroadcastStatus, NO_SERVER_MSG, 'warn'); return; }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    setStatus(stBroadcastStatus, 'camera access needs https — open the https:// address of the server.', 'warn');
    return;
  }

  stStartBtn.disabled = true;
  setStatus(stBroadcastStatus, 'asking for camera & mic…');

  const ac = new (window.AudioContext || window.webkitAudioContext)(); // created inside the click so audio isn't blocked
  if(ac.resume) ac.resume();

  let raw;
  try{
    raw = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }catch(err){
    console.error(err);
    try{ ac.close(); }catch(e){}
    let msg = 'could not open camera/mic — check the browser permission.';
    if(err && err.name === 'NotAllowedError') msg = 'camera/mic blocked — click the lock icon next to the address bar, allow Camera & Microphone, then reload.';
    else if(err && err.name === 'NotFoundError') msg = 'no camera or mic found on this device.';
    else if(err && (err.name === 'NotReadableError' || err.name === 'AbortError')) msg = 'camera/mic is being used by another app or tab — close it and try again.';
    setStatus(stBroadcastStatus, msg, 'warn');
    stStartBtn.disabled = false;
    return;
  }

  let fx;
  try{
    fx = await buildPipeline(raw, ac);
  }catch(err){
    console.error(err);
    raw.getTracks().forEach(t => t.stop());
    try{ ac.close(); }catch(e){}
    setStatus(stBroadcastStatus, 'something went wrong starting the stream — try again.', 'warn');
    stStartBtn.disabled = false;
    return;
  }
  const localStream = fx.outStream;
  stLocalVideo.srcObject = localStream;
  stLocalVideo.play().catch(() => {});

  const roomId = Math.random().toString(36).substring(2, 10);
  const peerConnections = {};
  stToken.textContent = roomId;

  const onViewerJoined = async ({ viewerId, name }) => {
    addChat(boxB, { system: true, text: `${name || 'someone'} joined live` });
    if(peerConnections[viewerId]) peerConnections[viewerId].close();
    const pc = new RTCPeerConnection(ICE_CONFIG);
    peerConnections[viewerId] = pc;
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = event => {
      if(event.candidate) s.emit('ice-candidate', { roomId, candidate: event.candidate });
    };
    pc.onconnectionstatechange = () => {
      if(pc.connectionState === 'closed' || pc.connectionState === 'failed') delete peerConnections[viewerId];
    };
    try{
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      s.emit('offer', { target: viewerId, sdp: offer });
    }catch(err){ console.error('offer failed:', err); }
  };

  const onAnswer = async ({ sdp, viewerId }) => {
    const pc = peerConnections[viewerId];
    if(!pc) return;
    try{
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushCandidates(pc);
    }catch(err){ console.error('answer failed:', err); }
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

  bc = { roomId, fx, peerConnections, onViewerJoined, onAnswer, onIce };

  // reset controls
  setRail(stMirrorBtn, 'fa-left-right', 'Mirror off');
  setRail(stCamBtn, 'fa-video', 'Cam on', 'on');
  setRail(stMicBtn, 'fa-microphone', 'Mic on', 'on');
  closePop(); refreshChips();

  setLiveBox(boxB, true);
  clearOverlay(boxB);
  stStopBtn.style.display = '';
  stStartBtn.style.display = 'none';
  lockUI();
  setStatus(stBroadcastStatus, 'live — waiting for viewers…', 'on');
}

function stopBroadcast(){
  if(!bc) return;
  if(socket){
    socket.off('viewer-joined', bc.onViewerJoined);
    socket.off('answer', bc.onAnswer);
    socket.off('ice-candidate', bc.onIce);
    socket.emit('leave-room', bc.roomId); // server tells viewers the stream ended
  }
  Object.values(bc.peerConnections).forEach(pc => { pc.onconnectionstatechange = null; pc.close(); });
  bc.fx.destroy();
  stLocalVideo.srcObject = null;
  bc = null;

  closePop();
  setLiveBox(boxB, false);
  clearOverlay(boxB);
  stToken.textContent = TOKEN_PLACEHOLDER;
  stStopBtn.style.display = 'none';
  stStartBtn.style.display = '';
  stStartBtn.disabled = false;
  lockUI();
  setStatus(stBroadcastStatus, 'broadcast ended.');
}

/* ---- broadcaster controls (right rail) ---- */
stMirrorBtn.onclick = () => {
  if(!bc) return;
  const on = !bc.fx.st.mirror;
  bc.fx.st.mirror = on;
  setRail(stMirrorBtn, 'fa-left-right', on ? 'Mirror on' : 'Mirror off', on ? 'on' : '');
};
stCamBtn.onclick = () => {
  if(!bc) return;
  const on = !bc.fx.st.camOn;
  bc.fx.setCam(on);
  setRail(stCamBtn, on ? 'fa-video' : 'fa-video-slash', on ? 'Cam on' : 'Cam off', on ? 'on' : 'off');
};
stMicBtn.onclick = () => {
  if(!bc) return;
  const on = !bc.fx.st.micOn;
  bc.fx.setMic(on);
  if(socket) socket.emit('host-mic', { roomId: bc.roomId, muted: !on }); // tell viewers
  setRail(stMicBtn, on ? 'fa-microphone' : 'fa-microphone-slash', on ? 'Mic on' : 'Muted', on ? 'on' : 'off');
};

// filter / voice popover
let popKind = null;
function closePop(){ popKind = null; stPop.hidden = true; stPop.innerHTML = ''; }
function refreshChips(){
  stPop.querySelectorAll('.filter-chip').forEach(c => {
    const cur = popKind === 'filter' ? (bc && bc.fx.st.filter) : (bc && bc.fx.st.voice);
    c.classList.toggle('active', c.dataset.id === cur);
  });
}
function openPop(kind){
  if(!bc) return;
  if(popKind === kind){ closePop(); return; }
  popKind = kind;
  stPop.innerHTML = '';
  const items = kind === 'filter' ? FILTERS.map(f => [f.id, f.label]) : VOICES;
  items.forEach(([id, label]) => {
    const chip = document.createElement('button');
    chip.className = 'filter-chip';
    chip.dataset.id = id;
    chip.textContent = label;
    chip.onclick = () => {
      if(!bc) return;
      if(kind === 'filter') bc.fx.st.filter = id; else bc.fx.setVoice(id);
      refreshChips();
    };
    stPop.appendChild(chip);
  });
  stPop.hidden = false;
  refreshChips();
}
stFilterBtn.onclick = () => openPop('filter');
stVoiceBtn.onclick = () => openPop('voice');

/* ================= VIEWER ================= */
function startView(roomId, name){
  if(vw || bc) return;
  const s = getSocket();
  if(!s){ setStatus(stViewerStatus, NO_SERVER_MSG, 'warn'); return; }

  const session = { roomId, pc: null, waitTimer: null };

  const onOffer = async ({ sdp, broadcasterId }) => {
    clearTimeout(session.waitTimer);
    if(session.pc) session.pc.close();
    const pc = new RTCPeerConnection(ICE_CONFIG);
    session.pc = pc;

    pc.ontrack = event => {
      if(stRemoteVideo.srcObject !== event.streams[0]){
        stRemoteVideo.srcObject = event.streams[0];
        stRemoteVideo.play().catch(() => { stRemoteVideo.muted = true; syncViewerMute(); }); // sound blocked by browser -> start muted
      }
    };
    pc.onicecandidate = event => {
      if(event.candidate) s.emit('ice-candidate', { roomId, candidate: event.candidate });
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
  s.emit('join-as-viewer', { roomId, name });

  session.onOffer = onOffer;
  session.onIce = onIce;
  session.waitTimer = setTimeout(() => {
    setStatus(stViewerStatus, 'no stream yet — check the token, or the broadcaster may not be live.', 'warn');
  }, 8000);
  vw = session;

  stEnded.hidden = true;
  stHostMuted.hidden = true;
  stRemoteVideo.muted = false; // join is a click, so sound is normally allowed
  syncViewerMute();

  setLiveBox(boxV, true);
  clearOverlay(boxV);
  stHostMuted.hidden = true;
  stJoinBtn.style.display = 'none';
  stLeaveBtn.style.display = '';
  stTokenInput.disabled = true;
  stNameInput.disabled = true;
  lockUI();
  setStatus(stViewerStatus, 'joined — waiting for the broadcaster…');
}

function leaveView(){
  if(!vw) return;
  clearTimeout(vw.waitTimer);
  if(socket){
    socket.off('offer', vw.onOffer);
    socket.off('ice-candidate', vw.onIce);
    socket.emit('leave-room', vw.roomId);
  }
  if(vw.pc){ vw.pc.onconnectionstatechange = null; vw.pc.close(); }
  stRemoteVideo.srcObject = null;
  vw = null;

  setLiveBox(boxV, false);
  clearOverlay(boxV);
  stHostMuted.hidden = true;
  stJoinBtn.style.display = '';
  stLeaveBtn.style.display = 'none';
  stTokenInput.disabled = false;
  stNameInput.disabled = false;
  lockUI();
  setStatus(stViewerStatus, 'left the stream.');
}

function syncViewerMute(){
  const m = stRemoteVideo.muted;
  stMutedNote.hidden = !m;
  setRail(stViewerMuteBtn, m ? 'fa-volume-xmark' : 'fa-volume-high', m ? 'Muted' : 'Sound on', m ? 'off' : 'on');
}
stViewerMuteBtn.onclick = () => { stRemoteVideo.muted = !stRemoteVideo.muted; syncViewerMute(); };

/* ================= UI wiring ================= */
stTabBroadcast.onclick = () => switchStreamTab('broadcast');
stTabViewer.onclick = () => switchStreamTab('viewer');
stStartBtn.onclick = startBroadcast;
stStopBtn.onclick = stopBroadcast;

stToken.onclick = () => {
  if(!bc) return;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(bc.roomId).then(() => setStatus(stBroadcastStatus, 'token copied!', 'on')).catch(() => {});
  }
};

function joinFromInput(){
  const name = stNameInput.value.trim().slice(0, 20);
  const roomId = stTokenInput.value.trim();
  if(!name){ setStatus(stViewerStatus, 'enter your name first.', 'warn'); stNameInput.focus(); return; }
  if(!roomId){ setStatus(stViewerStatus, 'enter a token first.', 'warn'); stTokenInput.focus(); return; }
  try{ localStorage.setItem('blushlive-name', name); }catch(e){}
  startView(roomId, name);
}
stJoinBtn.onclick = joinFromInput;
stLeaveBtn.onclick = leaveView;
stTokenInput.addEventListener('keydown', e => { if(e.key === 'Enter') joinFromInput(); });
stNameInput.addEventListener('keydown', e => { if(e.key === 'Enter') joinFromInput(); });
try{ stNameInput.value = localStorage.getItem('blushlive-name') || ''; }catch(e){}

window.addEventListener('beforeunload', () => { if(bc) stopBroadcast(); });

stToken.textContent = TOKEN_PLACEHOLDER;
switchStreamTab('broadcast');
syncViewerMute();
showPage(location.hash === '#stream' ? 'stream' : 'booth');
})();