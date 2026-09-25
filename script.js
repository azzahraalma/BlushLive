'use strict';

/* =========================================================
   PERCOBAAN 3: FILTERS (CSS filter + CSS transform)
   'brightness' & 'flip' below map 1:1 to the practicum's
   .brightness { filter: brightness(1.6); }
   .flip { transform: scaleX(-1); }
   ========================================================= */
const FILTERS = [
  {id:'none',       label:'Original',      css:'',                                    flip:false},
  {id:'brightness', label:'Brightness',    css:'brightness(1.6)',                     flip:false},
  {id:'flip',       label:'Flip Horizontal', css:'',                                  flip:true},
  {id:'mono',       label:'Monochrome',    css:'grayscale(1) contrast(1.1)',          flip:false},
  {id:'sepia',      label:'Sepia',         css:'sepia(0.75) contrast(1.05) brightness(1.05)', flip:false},
  {id:'invert',     label:'Invert',        css:'invert(1)',                           flip:false},
  {id:'blur',       label:'Soft Blur',     css:'blur(3px)',                           flip:false},
  {id:'pinky',      label:'Pink Soft',     css:'saturate(1.4) brightness(1.12) hue-rotate(-8deg) contrast(0.95)', flip:false},
  {id:'vintage',    label:'Vintage',       css:'sepia(0.35) saturate(1.3) contrast(1.1) brightness(1.05)', flip:false},
  {id:'hicon',      label:'High Contrast', css:'contrast(1.6) brightness(1.05)',      flip:false},
];

/* =========================================================
   STATE
   ========================================================= */
let currentFilter = FILTERS[0];
let mainStream = null, cameraReady = false;

let audioCtx = null;
let mediaRecorder = null, recChunks = [], recBlobUrl = null;
let renderActive = false;
let renderCanvas = document.createElement('canvas');

let vizActive = false, vizAnalyser = null, vizDataArray = null;

const video = document.getElementById('video');
const playbackVideo = document.getElementById('playbackVideo');
const flashOverlay = document.getElementById('flashOverlay');
const camStatusText = document.getElementById('camStatusText');
const micStatusText = document.getElementById('micStatusText');

/* =========================================================
   UTIL
   ========================================================= */
function pickMime(list){
  for(const m of list){ if(window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; }
  return '';
}

/* =========================================================
   BUILD UI: FILTER CHIPS
   ========================================================= */
const filterRow = document.getElementById('filterRow');
FILTERS.forEach(f=>{
  const chip = document.createElement('button');
  chip.className = 'filter-chip' + (f.id==='none' ? ' active' : '');
  chip.textContent = f.label;
  chip.onclick = ()=>{
    document.querySelectorAll('.filter-chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = f;
    video.style.filter = f.css;
    video.style.transform = f.flip ? 'scaleX(-1)' : 'none';
  };
  filterRow.appendChild(chip);
});

/* =========================================================
   PERCOBAAN 1: GetUserMedia
   + teks "Kamera berhasil diakses"
   PERCOBAAN 4: GetAudio
   + teks "Mikrofon aktif"
   (digabung 1 permintaan getUserMedia video+audio)
   ========================================================= */
async function startCamera(){
  if(cameraReady) return true;
  try{
    mainStream = await navigator.mediaDevices.getUserMedia({
      video:{ width:{ideal:1280}, height:{ideal:960}, facingMode:'user' },
      audio:true
    });
    video.srcObject = mainStream;
    await video.play();
    cameraReady = true;

    // Percobaan 1: status "Kamera berhasil diakses"
    camStatusText.textContent = '📷 Kamera berhasil diakses';
    camStatusText.classList.remove('off'); camStatusText.classList.add('on');

    // Percobaan 4: status "Mikrofon aktif"
    if(mainStream.getAudioTracks().length){
      micStatusText.textContent = '🎙️ Mikrofon aktif';
      micStatusText.classList.remove('off'); micStatusText.classList.add('on');
    }

    document.getElementById('recordBtn').disabled = false;
    return true;
  }catch(err){
    camStatusText.textContent = '📷 Camera error: ' + err.message;
    return false;
  }
}
document.getElementById('openCamBtn').onclick = startCamera;

/* =========================================================
   VOICE EFFECTS (optional, applied to recorded audio)
   ========================================================= */
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
   RENDER LOOP (video + filter baked into a canvas stream)
   ========================================================= */
function startRenderLoop(){
  renderCanvas.width = video.videoWidth || 640;
  renderCanvas.height = video.videoHeight || 480;
  renderActive = true;
  const cx = renderCanvas.getContext('2d');
  (function loop(){
    if(!renderActive) return;
    cx.filter = currentFilter.css;
    cx.save();
    if(currentFilter.flip){ cx.translate(renderCanvas.width,0); cx.scale(-1,1); }
    cx.drawImage(video, 0, 0, renderCanvas.width, renderCanvas.height);
    cx.restore();
    requestAnimationFrame(loop);
  })();
}

/* =========================================================
   RECORD VIDEO (menggantikan fitur foto)
   ========================================================= */
document.getElementById('recordBtn').onclick = async ()=>{
  if(!cameraReady){ const ok = await startCamera(); if(!ok) return; }

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
    const blob = new Blob(recChunks, {type:'video/webm'});
    recBlobUrl = URL.createObjectURL(blob);
    video.style.display = 'none';
    playbackVideo.style.display = 'block';
    playbackVideo.src = recBlobUrl;
    document.getElementById('recordingActions').style.display = 'none';
    document.getElementById('resultActions').classList.add('show');
  };

  mediaRecorder.start();
  flashOverlay.style.opacity = '0.7';
  setTimeout(()=> flashOverlay.style.opacity = '0', 150);

  document.getElementById('preActions').style.display = 'none';
  document.getElementById('recordingActions').style.display = 'flex';
};

document.getElementById('stopBtn').onclick = ()=>{
  if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
};

document.getElementById('downloadVideoBtn').onclick = ()=>{
  if(!recBlobUrl) return;
  const a = document.createElement('a');
  a.download = 'blushlive-video-' + Date.now() + '.webm';
  a.href = recBlobUrl;
  a.click();
};

/* =========================================================
   PERCOBAAN 2 (versi video): tombol "Ulangi"
   Menghapus/reset hasil rekaman, balik ke live preview lagi
   ========================================================= */
document.getElementById('retakeBtn').onclick = ()=>{
  if(recBlobUrl){ URL.revokeObjectURL(recBlobUrl); recBlobUrl = null; }
  playbackVideo.pause();
  playbackVideo.removeAttribute('src');
  playbackVideo.style.display = 'none';
  video.style.display = 'block';
  document.getElementById('resultActions').classList.remove('show');
  document.getElementById('preActions').style.display = 'flex';
};

/* =========================================================
   PERCOBAAN 5: AUDIO VISUALIZER
   AudioContext + AnalyserNode + Canvas, real-time
   ========================================================= */
const vizCanvas = document.getElementById('vizCanvas');
const vizCx = vizCanvas.getContext('2d');

function drawViz(){
  if(!vizActive) return;
  requestAnimationFrame(drawViz);
  vizAnalyser.getByteTimeDomainData(vizDataArray);

  vizCx.fillStyle = '#fff0f6';
  vizCx.fillRect(0, 0, vizCanvas.width, vizCanvas.height);

  vizCx.lineWidth = 3;
  vizCx.strokeStyle = '#e6408a';
  vizCx.beginPath();

  const slice = vizCanvas.width / vizDataArray.length;
  let x = 0;
  for(let i=0; i<vizDataArray.length; i++){
    const v = vizDataArray[i] / 128.0;
    const y = (v * vizCanvas.height) / 2;
    if(i === 0) vizCx.moveTo(x, y); else vizCx.lineTo(x, y);
    x += slice;
  }
  vizCx.lineTo(vizCanvas.width, vizCanvas.height/2);
  vizCx.stroke();
}

document.getElementById('startVizBtn').onclick = async ()=>{
  if(!cameraReady){ const ok = await startCamera(); if(!ok) return; }
  if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state === 'suspended') audioCtx.resume();

  const track = mainStream.getAudioTracks()[0];
  const source = audioCtx.createMediaStreamSource(new MediaStream([track]));
  vizAnalyser = audioCtx.createAnalyser();
  vizAnalyser.fftSize = 2048;
  vizDataArray = new Uint8Array(vizAnalyser.frequencyBinCount);
  source.connect(vizAnalyser);

  vizActive = true;
  drawViz();
  document.getElementById('startVizBtn').disabled = true;
  document.getElementById('stopVizBtn').disabled = false;
};

document.getElementById('stopVizBtn').onclick = ()=>{
  vizActive = false;
  vizCx.fillStyle = '#fff0f6';
  vizCx.fillRect(0, 0, vizCanvas.width, vizCanvas.height);
  document.getElementById('startVizBtn').disabled = false;
  document.getElementById('stopVizBtn').disabled = true;
};

/* =========================================================
   MOBILE NAV TOGGLE
   ========================================================= */
document.getElementById('navToggle').onclick = ()=>{
  document.getElementById('navLinks').classList.toggle('show');
};
document.querySelectorAll('.nav-links a').forEach(a=>{
  a.onclick = ()=> document.getElementById('navLinks').classList.remove('show');
});