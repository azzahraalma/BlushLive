'use strict';

const FILTERS = [
  {id:'none',       label:'Original',      css:''},
  {id:'brightness', label:'Brightness',    css:'brightness(1.6)'},
  {id:'mono',       label:'Monochrome',    css:'grayscale(1) contrast(1.1)'},
  {id:'sepia',      label:'Sepia',         css:'sepia(0.75) contrast(1.05) brightness(1.05)'},
  {id:'invert',     label:'Invert',        css:'invert(1)'},
  {id:'blur',       label:'Soft Blur',     css:'blur(3px)'},
  {id:'pinky',      label:'Pink Soft',     css:'saturate(1.4) brightness(1.12) hue-rotate(-8deg) contrast(0.95)'},
  {id:'vintage',    label:'Vintage',       css:'sepia(0.35) saturate(1.3) contrast(1.1) brightness(1.05)'},
  {id:'hicon',      label:'High Contrast', css:'contrast(1.6) brightness(1.05)'},
];

const ASPECTS = {
  '3:4':  {label:'3:4',  css:'3 / 4',  w:720,  h:960},
  '16:9': {label:'16:9', css:'16 / 9', w:1280, h:720},
  '9:16': {label:'9:16', css:'9 / 16', w:720,  h:1280},
};
let currentAspect = '3:4';

const MIRROR_OPTIONS = [
  {id:false, label:'Mirror Off'},
  {id:true,  label:'Mirror On'},
];
let mirrorOn = false;

let currentMode = 'video'; 

const LAYOUTS = {
  single: {label:'Single 1x', shots:1, cols:1},
  strip3: {label:'Strip 3x',  shots:3, cols:1},
  strip4: {label:'Strip 4x',  shots:4, cols:1},
  grid4:  {label:'Grid 2x2',  shots:4, cols:2},
};
let currentLayout = 'strip3';
let capturedPhotos = []; 
let resultCanvas = document.createElement('canvas');

let uiState = 'idle';
let currentFilter = FILTERS[0];
let mainStream = null, cameraReady = false;
let isMuted = false;

let audioCtx = null;
let mediaRecorder = null, recChunks = [], recBlobUrl = null;
let renderActive = false;
let renderCanvas = document.createElement('canvas');

let recAnalyser = null, recDataArray = null, recVizActive = false;
let recTimerInterval = null, recStartTime = 0;
let statusHideTimer = null;

const video = document.getElementById('video');
const playbackVideo = document.getElementById('playbackVideo');
const playbackPhoto = document.getElementById('playbackPhoto');
const flashOverlay = document.getElementById('flashOverlay');
const statusOverlay = document.getElementById('statusOverlay');
const camStatusText = document.getElementById('camStatusText');
const micStatusText = document.getElementById('micStatusText');
const camBox = document.getElementById('camBox');
const camColumn = document.getElementById('camColumn');
const vizCanvas = document.getElementById('vizCanvas');
const recTimer = document.getElementById('recTimer');
const captureCount = document.getElementById('captureCount');
const countdownNum = document.getElementById('countdownNum');

const openCamBtn = document.getElementById('openCamBtn');
const muteBtn = document.getElementById('muteBtn');
const recordBtn = document.getElementById('recordBtn');
const captureBtn = document.getElementById('captureBtn');
const recordingActions = document.getElementById('recordingActions');
const resultActions = document.getElementById('resultActions');
const frameBlock = document.getElementById('frameBlock');
const boothControls = document.getElementById('boothControls');

const modeTabs = document.getElementById('modeTabs');
const modeTabVideo = document.getElementById('modeTabVideo');
const modeTabPhoto = document.getElementById('modeTabPhoto');
const voiceEffectBlock = document.getElementById('voiceEffectBlock');
const layoutBlock = document.getElementById('layoutBlock');
const layoutPreview = document.getElementById('layoutPreview');

const downloadVideoBtn = document.getElementById('downloadVideoBtn');
const downloadStripBtn = document.getElementById('downloadStripBtn');
const downloadGifBtn = document.getElementById('downloadGifBtn');
const retakeBtn = document.getElementById('retakeBtn');
const stopBtn = document.getElementById('stopBtn');

function setText(el, text){
  if(!el) return;
  const span = el.querySelector('.txt');
  if(span) span.textContent = text; else el.textContent = text;
}

function setUIState(state){
  uiState = state;
  const busy = (state === 'recording' || state === 'capturing');

  openCamBtn.style.display = (state === 'idle') ? 'inline-flex' : 'none';
  recordBtn.style.display  = (state === 'ready' && currentMode === 'video') ? 'inline-flex' : 'none';
  captureBtn.style.display = (state === 'ready' && currentMode === 'photo') ? 'inline-flex' : 'none';
  muteBtn.style.display    = ((state === 'ready' || state === 'recording') && currentMode === 'video') ? 'inline-flex' : 'none';

  recordingActions.style.display = (state === 'recording') ? 'flex' : 'none';
  resultActions.classList.toggle('show', state === 'result');

  downloadVideoBtn.style.display = (state === 'result' && currentMode === 'video') ? 'inline-flex' : 'none';
  downloadStripBtn.style.display = (state === 'result' && currentMode === 'photo') ? 'inline-flex' : 'none';
  downloadGifBtn.style.display   = (state === 'result' && currentMode === 'photo' && capturedPhotos.length > 1) ? 'inline-flex' : 'none';

  frameBlock.style.display    = (busy || state === 'result') ? 'none' : 'block';
  boothControls.style.display = (busy || state === 'result') ? 'none' : 'block';
  modeTabs.classList.toggle('locked', busy);
  modeTabs.style.display = (state === 'result') ? 'none' : 'flex';

  vizCanvas.style.display = (currentMode === 'video' && (state === 'ready' || state === 'recording')) ? 'block' : 'none';
  recTimer.style.display  = (state === 'recording' && currentMode === 'video') ? 'flex' : 'none';
  captureCount.style.display = (state === 'capturing') ? 'flex' : 'none';

  video.style.display = (state === 'result') ? 'none' : 'block';
  playbackVideo.style.display = (state === 'result' && currentMode === 'video') ? 'block' : 'none';
  playbackPhoto.style.display = (state === 'result' && currentMode === 'photo') ? 'block' : 'none';

  camColumn.classList.toggle('result-wide', state === 'result');
}

function lockControls(){
  document.querySelectorAll('#filterRow .filter-chip').forEach(c => c.disabled = true);
  document.querySelectorAll('#mirrorRow .filter-chip').forEach(c => c.disabled = true);
  document.querySelectorAll('#layoutRow .filter-chip').forEach(c => c.disabled = true);
  document.getElementById('voiceEffectSelect').disabled = true;
  boothControls.classList.add('locked');
  modeTabs.classList.add('locked');
}
function unlockControls(){
  document.querySelectorAll('#filterRow .filter-chip').forEach(c => c.disabled = false);
  document.querySelectorAll('#mirrorRow .filter-chip').forEach(c => c.disabled = false);
  document.querySelectorAll('#layoutRow .filter-chip').forEach(c => c.disabled = false);
  document.getElementById('voiceEffectSelect').disabled = false;
  boothControls.classList.remove('locked');
  modeTabs.classList.remove('locked');
}

function switchMode(mode){
  if(uiState !== 'idle' && uiState !== 'ready') return; 
  currentMode = mode;
  modeTabVideo.classList.toggle('active', mode === 'video');
  modeTabPhoto.classList.toggle('active', mode === 'photo');
  voiceEffectBlock.style.display = (mode === 'video') ? 'block' : 'none';
  layoutBlock.style.display = (mode === 'photo') ? 'block' : 'none';
  micStatusText.style.display = (mode === 'video') ? 'flex' : 'none';
  if(mode === 'photo') renderLayoutPreview();
  setUIState(uiState);
}
modeTabVideo.onclick = () => switchMode('video');
modeTabPhoto.onclick = () => switchMode('photo');

function showStatusOverlay(temporary){
  statusOverlay.classList.remove('hide');
  clearTimeout(statusHideTimer);
  if(temporary){
    statusHideTimer = setTimeout(()=> statusOverlay.classList.add('hide'), 3500);
  }
}

function pickMime(list){
  for(const m of list){ if(window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; }
  return '';
}

function drawVideoCover(cx, vid, w, h){
  const vw = vid.videoWidth, vh = vid.videoHeight;
  if(!vw || !vh) return;
  const vr = vw/vh, cr = w/h;
  let sx, sy, sw, sh;
  if(vr > cr){ sh = vh; sw = vh*cr; sx = (vw-sw)/2; sy = 0; }
  else { sw = vw; sh = vw/cr; sx = 0; sy = (vh-sh)/2; }
  cx.drawImage(vid, sx, sy, sw, sh, 0, 0, w, h);
}

function formatElapsed(ms){
  const totalSec = Math.floor(ms/1000);
  const m = Math.floor(totalSec/60);
  const s = totalSec%60;
  return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}

function wait(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

const filterRow = document.getElementById('filterRow');
FILTERS.forEach(f=>{
  const chip = document.createElement('button');
  chip.className = 'filter-chip' + (f.id==='none' ? ' active' : '');
  chip.textContent = f.label;
  chip.onclick = ()=>{
    if(chip.disabled) return;
    document.querySelectorAll('#filterRow .filter-chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = f;
    video.style.filter = f.css;
  };
  filterRow.appendChild(chip);
});

const mirrorRow = document.getElementById('mirrorRow');
MIRROR_OPTIONS.forEach(opt=>{
  const chip = document.createElement('button');
  chip.className = 'filter-chip' + (opt.id === mirrorOn ? ' active' : '');
  chip.textContent = opt.label;
  chip.onclick = ()=>{
    if(chip.disabled) return;
    document.querySelectorAll('#mirrorRow .filter-chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    mirrorOn = opt.id;
    applyMirror();
  };
  mirrorRow.appendChild(chip);
});
function applyMirror(){
  video.style.transform = mirrorOn ? 'scaleX(-1)' : 'none';
}
applyMirror();

const layoutRow = document.getElementById('layoutRow');
Object.keys(LAYOUTS).forEach(key=>{
  const spec = LAYOUTS[key];
  const chip = document.createElement('button');
  chip.className = 'filter-chip' + (key === currentLayout ? ' active' : '');
  chip.textContent = spec.label;
  chip.onclick = ()=>{
    if(chip.disabled) return;
    document.querySelectorAll('#layoutRow .filter-chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    currentLayout = key;
    renderLayoutPreview();
  };
  layoutRow.appendChild(chip);
});

function renderLayoutPreview(){
  if(!layoutPreview) return;
  const layout = LAYOUTS[currentLayout];
  const spec = ASPECTS[currentAspect];
  layoutPreview.innerHTML = '';
  layoutPreview.style.gridTemplateColumns = `repeat(${layout.cols}, 1fr)`;
  for(let i=0; i<layout.shots; i++){
    const cell = document.createElement('div');
    cell.className = 'layout-preview-cell';
    cell.style.aspectRatio = spec.css;
    cell.innerHTML = '<i class="fa-solid fa-image"></i>';
    layoutPreview.appendChild(cell);
  }
}

const aspectRow = document.getElementById('aspectRow');
Object.keys(ASPECTS).forEach(key=>{
  const spec = ASPECTS[key];
  const chip = document.createElement('button');
  chip.className = 'filter-chip' + (key===currentAspect ? ' active' : '');
  chip.textContent = spec.label;
  chip.onclick = ()=>{
    document.querySelectorAll('#aspectRow .filter-chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    currentAspect = key;
    camBox.style.aspectRatio = spec.css;
    renderLayoutPreview();
  };
  aspectRow.appendChild(chip);
});
camBox.style.aspectRatio = ASPECTS[currentAspect].css;
renderLayoutPreview();

async function startCamera(){
  if(cameraReady) return true;
  try{
    mainStream = await navigator.mediaDevices.getUserMedia({
      video:{ width:{ideal:1280}, height:{ideal:960}, facingMode:'user' },
      audio:true
    });

    video.muted = true;
    video.srcObject = mainStream;
    video.onloadedmetadata = () => { video.play().catch(()=>{}); };
    try { await video.play(); } catch(e) { console.warn('video.play() failed: ' + e.message); }

    cameraReady = true;

    setText(camStatusText, 'Camera successfully accessed');
    camStatusText.classList.remove('off','warn'); camStatusText.classList.add('on');

    if(mainStream.getAudioTracks().length){
      setText(micStatusText, 'Microphone active');
      micStatusText.classList.remove('off','warn'); micStatusText.classList.add('on');
    }

    showStatusOverlay(true);
    setUIState('ready');

    startPreviewVisualizer();

    setTimeout(()=>{
      if(video.videoWidth === 0){
        setText(camStatusText, 'Permission granted, but no video available — check: webcam covered? being used by another app (Zoom/Teams/OBS)? try refreshing the page.');
        camStatusText.classList.remove('on'); camStatusText.classList.add('warn');
        showStatusOverlay(false);
      }
    }, 2500);

    return true;
  }catch(err){
    setText(camStatusText, 'Camera error: ' + err.message);
    camStatusText.classList.remove('on'); camStatusText.classList.add('warn');
    showStatusOverlay(false);
    return false;
  }
}
openCamBtn.onclick = startCamera;

muteBtn.onclick = ()=>{
  if(!mainStream) return;
  isMuted = !isMuted;
  mainStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const icon = muteBtn.querySelector('i');
  if(icon) icon.className = isMuted ? 'fa-solid fa-microphone-slash' : 'fa-solid fa-microphone';
  setText(muteBtn, isMuted ? 'Unmute' : 'Mute');
  muteBtn.classList.toggle('active', isMuted);
};

function makeDistortionCurve(amount){
  const n = 44100; const curve = new Float32Array(n); const deg = Math.PI/180;
  for(let i=0;i<n;i++){
    const x = i*2/n - 1;
    curve[i] = (3+amount)*x*20*deg / (Math.PI + amount*Math.abs(x));
  }
  return curve;
}

function buildVoiceGraph(effectId){
  if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state === 'suspended') audioCtx.resume();

  const track = mainStream.getAudioTracks()[0];
  const source = audioCtx.createMediaStreamSource(new MediaStream([track]));
  const dest = audioCtx.createMediaStreamDestination();
  let outNode = source;

  if(effectId === 'robot'){
    const osc = audioCtx.createOscillator(); osc.type='sine'; osc.frequency.value=45;
    const ring = audioCtx.createGain(); ring.gain.value = 0;
    source.connect(ring);
    osc.connect(ring.gain);
    osc.start();
    outNode = ring;
  } else if(effectId === 'echo'){
    const delay = audioCtx.createDelay(); delay.delayTime.value = 0.28;
    const fb = audioCtx.createGain(); fb.gain.value = 0.35;
    const mix = audioCtx.createGain();
    source.connect(mix);
    source.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(mix);
    outNode = mix;
  } else if(effectId === 'deep'){
    const lp = audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=750;
    const g = audioCtx.createGain(); g.gain.value = 1.4;
    source.connect(lp); lp.connect(g);
    outNode = g;
  } else if(effectId === 'radio'){
    const bp = audioCtx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1600; bp.Q.value=5;
    const shaper = audioCtx.createWaveShaper(); shaper.curve = makeDistortionCurve(12); shaper.oversample='4x';
    source.connect(bp); bp.connect(shaper);
    outNode = shaper;
  }

  outNode.connect(dest);
  return dest.stream;
}

/* =========================================================
   RENDER LOOP (video + filter + mirror + crop-per-aspect ke canvas)
   dipakai buat recording (video mode) DAN capture (photo mode)
   ========================================================= */
function startRenderLoop(){
  const spec = ASPECTS[currentAspect];
  renderCanvas.width = spec.w;
  renderCanvas.height = spec.h;
  renderActive = true;
  const cx = renderCanvas.getContext('2d');
  (function loop(){
    if(!renderActive) return;
    cx.filter = currentFilter.css;
    cx.save();
    if(mirrorOn){ cx.translate(renderCanvas.width,0); cx.scale(-1,1); }
    drawVideoCover(cx, video, renderCanvas.width, renderCanvas.height);
    cx.restore();
    requestAnimationFrame(loop);
  })();
}

function startPreviewVisualizer(){
  if(recVizActive) return;
  if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  const track = mainStream.getAudioTracks()[0];
  const src = audioCtx.createMediaStreamSource(new MediaStream([track]));
  recAnalyser = audioCtx.createAnalyser();
  recAnalyser.fftSize = 2048;
  recDataArray = new Uint8Array(recAnalyser.frequencyBinCount);
  src.connect(recAnalyser);
  recVizActive = true;
  drawRecordingViz();
}
function stopPreviewVisualizer(){
  recVizActive = false;
}
function drawRecordingViz(){
  if(!recVizActive) return;
  requestAnimationFrame(drawRecordingViz);
  recAnalyser.getByteTimeDomainData(recDataArray);

  const cx = vizCanvas.getContext('2d');
  cx.fillStyle = '#fff0f6';
  cx.fillRect(0, 0, vizCanvas.width, vizCanvas.height);
  cx.lineWidth = 3;
  cx.strokeStyle = '#e6408a';
  cx.beginPath();

  const slice = vizCanvas.width / recDataArray.length;
  let x = 0;
  for(let i=0; i<recDataArray.length; i++){
    const v = recDataArray[i] / 128.0;
    const y = (v * vizCanvas.height) / 2;
    if(i === 0) cx.moveTo(x, y); else cx.lineTo(x, y);
    x += slice;
  }
  cx.lineTo(vizCanvas.width, vizCanvas.height/2);
  cx.stroke();
}

function startRecTimer(){
  recStartTime = Date.now();
  setText(recTimer, '00:00');
  recTimerInterval = setInterval(()=>{
    setText(recTimer, formatElapsed(Date.now() - recStartTime));
  }, 250);
}
function stopRecTimer(){
  clearInterval(recTimerInterval);
  recTimerInterval = null;
}

recordBtn.onclick = async ()=>{
  if(!cameraReady || uiState !== 'ready') return;

  statusOverlay.classList.add('hide');
  lockControls();

  startRenderLoop();
  const videoStream = renderCanvas.captureStream(30);
  const effectId = document.getElementById('voiceEffectSelect').value;
  const audioOut = buildVoiceGraph(effectId);
  const combined = new MediaStream([...videoStream.getVideoTracks(), ...audioOut.getAudioTracks()]);

  const mime = pickMime(['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm']) || 'video/webm';
  mediaRecorder = new MediaRecorder(combined, {mimeType: mime});
  recChunks = [];
  mediaRecorder.ondataavailable = e=>{ if(e.data && e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = ()=>{
    renderActive = false;
    stopRecTimer();
    const blob = new Blob(recChunks, {type:'video/webm'});
    recBlobUrl = URL.createObjectURL(blob);
    playbackVideo.src = recBlobUrl;
    setUIState('result');
  };

  mediaRecorder.start();
  flashOverlay.style.opacity = '0.7';
  setTimeout(()=> flashOverlay.style.opacity = '0', 150);

  setUIState('recording');
  startRecTimer();
};

stopBtn.onclick = ()=>{
  if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
};

downloadVideoBtn.onclick = ()=>{
  if(!recBlobUrl) return;
  const a = document.createElement('a');
  a.download = 'blushlive-video-' + Date.now() + '.webm';
  a.href = recBlobUrl;
  a.click();
};

async function runCountdown(n){
  countdownNum.style.display = 'flex';
  for(let i=n; i>0; i--){
    countdownNum.textContent = i;
    await wait(700);
  }
  countdownNum.style.display = 'none';
}

captureBtn.onclick = async ()=>{
  if(!cameraReady || uiState !== 'ready') return;

  statusOverlay.classList.add('hide');
  lockControls();
  capturedPhotos = [];
  startRenderLoop();
  setUIState('capturing');

  const layout = LAYOUTS[currentLayout];

  for(let i=0; i<layout.shots; i++){
    setText(captureCount, `${i+1}/${layout.shots}`);
    await runCountdown(3);

    flashOverlay.style.opacity = '0.7';
    setTimeout(()=> flashOverlay.style.opacity = '0', 150);

    const shot = document.createElement('canvas');
    shot.width = renderCanvas.width;
    shot.height = renderCanvas.height;
    shot.getContext('2d').drawImage(renderCanvas, 0, 0);
    capturedPhotos.push(shot);

    await wait(450);
  }

  renderActive = false;
  buildResultStrip();
  setUIState('result');
};

function buildResultStrip(){
  const shots = capturedPhotos;
  const sw = shots[0].width, sh = shots[0].height;
  const pad = 20, gap = 14, footer = 64;
  const cols = LAYOUTS[currentLayout].cols;
  const rows = Math.ceil(shots.length / cols);

  const W = pad*2 + cols*sw + (cols-1)*gap;
  const H = pad*2 + rows*sh + (rows-1)*gap + footer;
  resultCanvas.width = W;
  resultCanvas.height = H;

  const cx = resultCanvas.getContext('2d');
  cx.fillStyle = '#fff0f6';
  cx.fillRect(0, 0, W, H);

  shots.forEach((shot, i)=>{
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + col*(sw+gap);
    const y = pad + row*(sh+gap);
    cx.drawImage(shot, x, y);
  });

  cx.fillStyle = '#e6408a';
  cx.font = "600 26px 'Poppins', sans-serif";
  cx.textAlign = 'center';
  cx.fillText('blush live', W/2, H - footer/2 + 8);

  playbackPhoto.src = resultCanvas.toDataURL('image/png');
}

downloadStripBtn.onclick = ()=>{
  if(!capturedPhotos.length) return;
  const a = document.createElement('a');
  a.download = 'blushlive-strip-' + Date.now() + '.png';
  a.href = resultCanvas.toDataURL('image/png');
  a.click();
};

downloadGifBtn.onclick = ()=>{
  if(capturedPhotos.length < 2 || typeof GIF === 'undefined') return;

  downloadGifBtn.disabled = true;
  const txt = downloadGifBtn.querySelector('.txt');
  const originalLabel = txt ? txt.textContent : downloadGifBtn.textContent;
  setText(downloadGifBtn, 'Rendering GIF...');

  const maxW = 480;
  const srcW = capturedPhotos[0].width, srcH = capturedPhotos[0].height;
  const scale = Math.min(1, maxW / srcW);
  const gifW = Math.round(srcW * scale);
  const gifH = Math.round(srcH * scale);

  const gif = new GIF({
    workers: Math.min(4, navigator.hardwareConcurrency || 2),
    quality: 20,
    width: gifW,
    height: gifH,
    workerScript: 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js'
  });

  capturedPhotos.forEach(shot=>{
    if(scale < 1){
      const small = document.createElement('canvas');
      small.width = gifW; small.height = gifH;
      small.getContext('2d').drawImage(shot, 0, 0, gifW, gifH);
      gif.addFrame(small, {delay: 700});
    } else {
      gif.addFrame(shot, {delay: 700});
    }
  });

  gif.on('finished', (blob)=>{
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = 'blushlive-photobooth-' + Date.now() + '.gif';
    a.href = url;
    a.click();
    downloadGifBtn.disabled = false;
    setText(downloadGifBtn, originalLabel);
  });

  gif.render();
};

retakeBtn.onclick = ()=>{
  if(recBlobUrl){ URL.revokeObjectURL(recBlobUrl); recBlobUrl = null; }
  playbackVideo.pause();
  playbackVideo.removeAttribute('src');
  playbackPhoto.removeAttribute('src');
  capturedPhotos = [];

  unlockControls();
  setUIState('ready');
};

document.getElementById('navToggle').onclick = ()=>{
  document.getElementById('navLinks').classList.toggle('show');
};
document.querySelectorAll('.nav-links a').forEach(a=>{
  a.onclick = ()=> document.getElementById('navLinks').classList.remove('show');
});

switchMode('video');
setUIState('idle');
showStatusOverlay(true);