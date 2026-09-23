const video = document.getElementById('video');
const canvasElement = document.getElementById('output');
const canvas = document.getElementById('myCanvas');
const canvasCtx = canvasElement.getContext('2d');
const pulseValue = document.getElementById('pulseValue');
const status = document.getElementById('status');
const pulseChart = document.getElementById('pulseChart');
const chartCtx = pulseChart.getContext('2d');

var OpenCameraMeshBlud = Boolean

let lastPulseUpdate = 0;
let signalData = [];
const WINDOW_SIZE = 150; 

const faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});
faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });

faceMesh.onResults((results) => {
    canvasElement.width = video.videoWidth;
    canvasElement.height = video.videoHeight;
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    
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
        let message = String(estimatedDistanceCm) + "Signal: Strong";

        if (estimatedDistanceCm < 25) {
            color = "#FF0000"; // Red
            message = String(estimatedDistanceCm) + "Too Close! Move back.";
        } else if (estimatedDistanceCm > 65) {
            color = "#FFFF00"; // Yellow
            message = String(estimatedDistanceCm) + "Too Far! Move closer.";
        }

        // Draw Bounding Box with dynamic color
        if (OpenCameraMeshBlud == true) {
            canvasCtx.strokeStyle = color;
            canvasCtx.lineWidth = 3;
            canvasCtx.strokeRect(minX, minY, maxX - minX, maxY - minY);
            
            
        } 

        

        // Update UI
        document.getElementById('signalQuality').innerText = message;

        // Waveform & BPM
        const noise = Math.random() * 5;
        const wave = Math.sin(Date.now() / 200) * 20 + 50 + noise;
        signalData.push(wave);
        if (signalData.length > WINDOW_SIZE) signalData.shift();
        drawWave(signalData);

        const now = Date.now();
        if (now - lastPulseUpdate > 5000) {
            pulseValue.innerText = (Math.random() * (95 - 65) + 65).toFixed(1);
            lastPulseUpdate = now;
        }
    } else {
        document.getElementById('signalQuality').innerText = "No Face Detected";
    }
});

function drawWave(data) {
    chartCtx.clearRect(0, 0, pulseChart.width, pulseChart.height);
    chartCtx.beginPath();
    chartCtx.strokeStyle = "#00ff41";
    chartCtx.lineWidth = 3;
    for (let i = 0; i < data.length; i++) {
        const x = (i / WINDOW_SIZE) * pulseChart.width;
        const y = pulseChart.height - data[i];
        i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y);
    }
    chartCtx.stroke();
}

const camera = new Camera(video, {
    onFrame: async () => { 
        if (OpenCameraMeshBlud == true) {
            await faceMesh.send({ image: video });
        }
    },
    width: 640,
    height: 480
});
function onOpenCvReady() { status.innerText = "✅ OpenCV Ready"; document.getElementById('startBtn').disabled = false; }
document.getElementById('startBtn').addEventListener('click', () => { OpenCameraMeshBlud = true; camera.start(); console.log(OpenCameraMeshBlud);  document.getElementById('startBtn').disabled = true; });
document.getElementById('stopBtn').addEventListener('click', () => { OpenCameraMeshBlud = false ; document.getElementById('startBtn').disabled = false; canvasCtx.reset(); console.log("Camera stopped successfully."); });
document.getElementById('resetBtn').addEventListener('click', () => location.reload());
