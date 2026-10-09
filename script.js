const video = document.getElementById('video');
const canvasElement = document.getElementById('output');
const canvas = document.getElementById('myCanvas');
const canvasCtx = canvasElement.getContext('2d');
const pulseValue = document.getElementById('pulseValue');
const status = document.getElementById('status');
const pulseChart = document.getElementById('pulseChart');
const chartCtx = pulseChart.getContext('2d');
const isMobileDevice = /Android|webOS|iPhone|iPad|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);


var OpenCameraMeshBlud = false

let distancethingy = 0;

// --- rPPG (see rppg.js) ---
const WAVE_SECONDS = 6;      // length of the live pulse trace
const BPM_SMOOTHING = 5;     // show the median of the last N readings
const MIN_QUALITY = 0.25;    // share of face patches that must agree on the BPM
const rppg = new RppgEngine();
let lastAnalysis = 0;
let frameTimestamp = 0;      // when the frame being processed was captured
let bpmHistory = [];

// Off-screen canvas used to read the camera pixels for the rPPG signal.
// (The visible #output canvas is cleared every frame, so it can't be sampled.)
const sampleCanvas = document.createElement('canvas');
const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

const faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});
faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });

faceMesh.onResults((results) => {
    canvasElement.width = video.videoWidth;
    canvasElement.height = video.videoHeight;
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // A frame that was already in flight when Stop was pressed.
    if (!OpenCameraMeshBlud) return;

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        
        const xCoords = landmarks.map(l => l.x);
        const yCoords = landmarks.map(l => l.y);
        
        const minX = Math.min(...xCoords) * canvasElement.width;
        const maxX = Math.max(...xCoords) * canvasElement.width;
        const minY = Math.min(...yCoords) * canvasElement.height;
        const maxY = Math.max(...yCoords) * canvasElement.height;
        
        // --- Distance Checker Logic ---
        const faceWidthPixels = maxX - minX;
        // Estimated distance: using 15cm as average face width
        const estimatedDistanceCm = (640 * 15) / faceWidthPixels;
        
        let color = "#00FF00"; // Green by default
        let message = "Signal: Strong";
        distancethingy = estimatedDistanceCm
        

        if (estimatedDistanceCm < 25) {
            color = "#FF0000"; // Red
            message = "Too Close! Move back.";
        } else if (estimatedDistanceCm > 65) {
            color = "#FFFF00"; // Yellow
            message = "Too Far! Move closer.";
        }

        // Draw Bounding Box with dynamic color
        if (OpenCameraMeshBlud == true) {
            canvasCtx.strokeStyle = color;
            canvasCtx.lineWidth = 3;
            canvasCtx.strokeRect(minX, minY, maxX - minX, maxY - minY);
            
            
        } 
        
        // Update UI
        document.getElementById('signalQuality').innerText = message;
        
        if (isMobileDevice) {
            let mobiledistance = distancethingy / 2
            document.getElementById('fps').innerText = String(mobiledistance.toFixed(1)) + "cm";
        } else {
            document.getElementById('fps').innerText = String(distancethingy.toFixed(1)) + "cm";
        }

        // --- Heart rate (rPPG) ---
        // Read the pixels of the very frame FaceMesh just analysed, so the
        // landmarks and the colours line up.
        const src = results.image || video;
        const iw = src.videoWidth || src.width;
        const ih = src.videoHeight || src.height;
        if (sampleCanvas.width !== iw || sampleCanvas.height !== ih) {
            sampleCanvas.width = iw;
            sampleCanvas.height = ih;
        }
        sampleCtx.drawImage(src, 0, 0, iw, ih);
        const frame = sampleCtx.getImageData(0, 0, iw, ih);

        const ts = frameTimestamp || performance.now();
        if (rppg.addFrame(landmarks, frame, iw, ih, ts)) {
            clearReadout(); // face was gone for a while: the old signal is useless
        }

        const now = performance.now();
        if (now - lastAnalysis >= rppg.cfg.updateEveryMs) {
            lastAnalysis = now;
            updateReadout(rppg.analyze());
        }
        drawWave(rppg.getWaveform(WAVE_SECONDS));
    } else {
        document.getElementById('signalQuality').innerText = "No Face Detected";
        if (OpenCameraMeshBlud) status.innerText = "👀 Looking for your face...";
    }
});


function clearReadout() {
    bpmHistory = [];
    pulseValue.innerText = '--';
}

function median(values) {
    const s = values.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Turns an rppg.analyze() result into what the person sees.
function updateReadout(r) {
    if (r.state === 'collecting') {
        status.innerText = `📡 Reading pulse... ${Math.round(r.progress * 100)}% (hold still)`;
        return;
    }
    if (r.state === 'lowfps') {
        status.innerText = `⚠ Camera is too slow (${r.fps.toFixed(0)} fps) for a pulse reading`;
        return;
    }

    // Practical hints, most important first.
    let hint = '';
    if (r.brightness < 45) hint = ' · too dark, face a light';
    else if (r.brightness > 245) hint = ' · too bright / overexposed';
    else if (r.motion > 0.012) hint = ' · hold still';

    if (r.state === 'ok' && r.quality >= MIN_QUALITY) {
        bpmHistory.push(r.bpm);
        if (bpmHistory.length > BPM_SMOOTHING) bpmHistory.shift();
        pulseValue.innerText = median(bpmHistory).toFixed(1);
        status.innerText = `✅ Pulse locked · signal ${Math.round(r.quality * 100)}%` + hint;
    } else {
        // Don't show a number we don't trust; keep the last good one on screen.
        status.innerText = '⚠ Weak signal, keep still in even lighting' + (hint || '');
    }
}

// Draws the live pulse trace (face-average colour -> POS -> band-pass).
function drawWave(data) {
    const w = pulseChart.clientWidth, h = pulseChart.clientHeight;
    if (!w || !h) return;
    if (pulseChart.width !== w) pulseChart.width = w;
    if (pulseChart.height !== h) pulseChart.height = h;
    chartCtx.clearRect(0, 0, w, h);
    if (!data || data.length < 2) return;

    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    if (peak < 1e-9) return;

    chartCtx.beginPath();
    chartCtx.strokeStyle = "#00ff41";
    chartCtx.lineWidth = 3;
    for (let i = 0; i < data.length; i++) {
        const x = (i / (data.length - 1)) * w;
        const y = h / 2 - (data[i] / peak) * (h * 0.4);
        i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y);
    }
    chartCtx.stroke();
}

const camera = new Camera(video, {
    onFrame: async () => { 
        if (OpenCameraMeshBlud == true) {
            frameTimestamp = performance.now(); // capture time, before FaceMesh latency
            await faceMesh.send({ image: video });
        }
    },
    width: 640,
    height: 480
});
function onOpenCvReady() { status.innerText = "✅ OpenCV Ready"; document.getElementById('startBtn').disabled = false; }
document.getElementById('startBtn').addEventListener('click', () => {
    OpenCameraMeshBlud = true;
    rppg.reset();
    clearReadout();
    status.innerText = "📡 Reading pulse... 0% (hold still)";
    camera.start();
    console.log(OpenCameraMeshBlud);
    document.getElementById('startBtn').disabled = true;
});
document.getElementById('stopBtn').addEventListener('click', () => {
    OpenCameraMeshBlud = false;
    document.getElementById('startBtn').disabled = false;
    canvasCtx.reset();
    rppg.reset();
    clearReadout();
    drawWave(null);
    status.innerText = "⏹ Stopped";
    console.log("Camera stopped successfully.");
});
document.getElementById('resetBtn').addEventListener('click', () => location.reload());
