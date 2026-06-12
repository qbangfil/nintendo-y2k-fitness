// Nintendo Fitness Y2K Core Logic Engine (v1.2 Policy Standard)

// --- STATE MANAGEMENT ---
let currentView = 'running';
let activeWorkout = null; // 'running', 'squat', or null
let webhookQueue = JSON.parse(localStorage.getItem('y2k_webhook_queue') || '[]');

// Running Tracker State
let gpsWatchId = null;
let lastGpsPoint = null;
let gpsPointsList = [];
let runStartTime = null;
let runDurationSeconds = 0;
let runTimerInterval = null;
let simulatedTunnelActive = false;
let gpsAccumulatedDistance = 0; // in km

// Squat Sensor State
let isSquatting = false;
let sensorNormHistory = [];
const SENSOR_HISTORY_LIMIT = 150; // 1.5 seconds at ~100Hz
let squatCount = 0;
let lowPassFilteredNorm = 0;
let baseThreshold = 1.1; // v1.2 Policy relaxed to 1.1m/s2 for general tests // Dynamic Standard Deviation Threshold base
let dynamicThresholdHigh = 1.5;
let dynamicThresholdLow = -1.5;
let squatPeakDetected = false;
let squatPeakTime = 0;
let lastSquatCountTime = 0;
let motionState = 'READY'; // READY, DOWN, UP, COOLDOWN
let wakeLock = null;

// Graph Settings
const canvas = document.getElementById('motion-canvas');
const ctx = canvas.getContext('2d');
let graphData = new Array(80).fill(0);

// Rating Selection
// System logs metrics
let peakAccNorm = 0;
let tiltWarningCount = 0;

// --- VIEW NAVIGATION ---
function switchView(viewName) {
  document.querySelectorAll('.app-view').forEach(view => {
    view.classList.remove('active');
  });
  document.querySelectorAll('.nav-tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  
  document.getElementById(`view-${viewName}`).classList.add('active');
  const clickedBtn = Array.from(document.querySelectorAll('.nav-tab-btn')).find(
    btn => btn.innerText.toLowerCase() === viewName.toLowerCase()
  );
  if (clickedBtn) clickedBtn.classList.add('active');
  currentView = viewName;
  
  if (viewName === 'squat') {
    resizeCanvas();
  }
}

function resizeCanvas() {
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;
}
window.addEventListener('resize', resizeCanvas);

// --- TOAST NOTIFICATION ---
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.innerText = message;
  toast.style.display = 'block';
  setTimeout(() => {
    toast.style.display = 'none';
  }, 3000);
}

// --- GPS LOGIC: RUNNING (v1.2 policy) ---
function startRunning() {
  if (activeWorkout) {
    showToast('END ACTIVE SESSION FIRST');
    return;
  }
  
  if (!navigator.geolocation) {
    showToast('GPS NOT SUPPORTED ON THIS DEVICE');
    return;
  }
  
  // Request GPS Wake Lock if supported
  requestWakeLock();
  
  activeWorkout = 'running';
  runStartTime = Date.now();
  runDurationSeconds = 0;
  gpsAccumulatedDistance = 0;
  gpsPointsList = [];
  lastGpsPoint = null;
  
  document.getElementById('gps-status').innerHTML = '<span class="status-indicator green"></span>RUNNING';
  document.getElementById('gps-distance').innerText = '0.00 km';
  document.getElementById('gps-pace').innerText = '--:--';
  document.getElementById('gps-time').innerText = '00:00';
  document.getElementById('btn-run-start').disabled = true;
  document.getElementById('btn-run-stop').disabled = false;
  
  // Adaptive GPS options
  const gpsOptions = {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 5000
  };
  
  gpsWatchId = navigator.geolocation.watchPosition(handleGpsUpdate, handleGpsError, gpsOptions);
  
  // UI Throttled Timer (Every 3 seconds per Policy v1.2)
  runTimerInterval = setInterval(() => {
    runDurationSeconds += 3;
    document.getElementById('gps-time').innerText = formatTime(runDurationSeconds);
    
    // Evaluate simulated tunnel active
    simulatedTunnelActive = document.getElementById('sim-gps-drop').checked;
    if (simulatedTunnelActive) {
      document.getElementById('gps-status').innerHTML = '<span class="status-indicator orange"></span>TUNNEL IMP.';
      applyDeadReckoning();
    }
    
    updateRunningUI();
  }, 3000);
  
  startRunnerAnimation();
  showToast('GPS TRACKING STARTED');
}

function handleGpsUpdate(position) {
  if (simulatedTunnelActive) return; // Ignore real coordinates in simulated tunnel

  const rawAccuracy = position.coords.accuracy;
  const lat = position.coords.latitude;
  const lon = position.coords.longitude;
  const speed = position.coords.speed || 0; // m/s
  const timestamp = position.timestamp;
  
  // Policy 3.1: Accuracy Filter (If indoor or accuracy is poor, relax to 50m to show coordinates)
  if (rawAccuracy > 50) {
    console.warn('GPS dropped due to poor accuracy: ' + rawAccuracy + 'm');
    return;
  }
  
  const currentPoint = { lat, lon, speed, timestamp };
  
  if (lastGpsPoint) {
    // Policy 3.1: Time filter (Skip updates under 0.5s)
    const timeDelta = (timestamp - lastGpsPoint.timestamp) / 1000;
    if (timeDelta < 0.5) return;
    
    // Calculate speed Spike
    const distanceMeters = calculateHaversineDistance(lastGpsPoint, currentPoint);
    const calculatedSpeedKmh = (distanceMeters / timeDelta) * 3.6;
    
    // Policy 3.1: Spike filter (Speed > 50km/h is anomaly)
    if (calculatedSpeedKmh > 50) {
      console.warn('GPS spike detected: ' + calculatedSpeedKmh + ' km/h');
      return;
    }
    
    // Accumulate distance
    gpsAccumulatedDistance += (distanceMeters / 1000);
  }
  
  lastGpsPoint = currentPoint;
  gpsPointsList.push(currentPoint);
  document.getElementById('gps-status').innerHTML = '<span class="status-indicator green"></span>GPS STABLE';
}

function handleGpsError(err) {
  console.error(err);
  document.getElementById('gps-status').innerHTML = '<span class="status-indicator orange"></span>GPS LOST';
  applyDeadReckoning();
}

// Policy 4.1: Dead Reckoning (10s interpolation on signal drop)
let lastDeadReckoningTime = null;
let deadReckoningLimitSeconds = 0;

function applyDeadReckoning() {
  if (gpsPointsList.length < 3) return;
  
  const now = Date.now();
  if (!lastDeadReckoningTime) {
    lastDeadReckoningTime = now;
    deadReckoningLimitSeconds = 0;
    return;
  }
  
  const elapsed = (now - lastDeadReckoningTime) / 1000;
  lastDeadReckoningTime = now;
  
  // Interpolation limit check (up to 10 seconds)
  if (deadReckoningLimitSeconds < 10) {
    deadReckoningLimitSeconds += elapsed;
    
    // Get average velocity of last 3 points
    const last3 = gpsPointsList.slice(-3);
    const averageSpeed = last3.reduce((sum, p) => sum + (p.speed || 0), 0) / 3; // m/s
    
    const addedDistanceKm = (averageSpeed * elapsed) / 1000;
    gpsAccumulatedDistance += addedDistanceKm;
    console.log('Dead Reckoning Applied: +' + addedDistanceKm.toFixed(4) + ' km');
  } else {
    document.getElementById('gps-status').innerHTML = '<span class="status-indicator red"></span>GPS TIMEOUT';
  }
}

function stopRunning() {
  try {
    if (gpsWatchId !== null) {
      try {
        navigator.geolocation.clearWatch(gpsWatchId);
      } catch(e) {}
      gpsWatchId = null;
    }
  } catch(e) {}
  
  try {
    if (runTimerInterval !== null) {
      clearInterval(runTimerInterval);
      runTimerInterval = null;
    }
  } catch(e) {}
  
  try {
    releaseWakeLock();
  } catch(e) {}
  
  // Calculate average pace
  const finalDistance = gpsAccumulatedDistance;
  const finalTime = runDurationSeconds;
  
  try {
    stopRunnerAnimation();
  } catch(e) {}
  
  activeWorkout = null;
  document.getElementById('gps-status').innerHTML = '<span class="status-indicator"></span>STANDBY';
  document.getElementById('btn-run-start').disabled = false;
  document.getElementById('btn-run-stop').disabled = true;
  
  // Trigger feedback popup
  openFeedbackModal('RUNNING', `${finalDistance.toFixed(2)} km in ${formatTime(finalTime)}`);
}

function updateRunningUI() {
  document.getElementById('gps-distance').innerText = gpsAccumulatedDistance.toFixed(2) + ' km';
  
  if (gpsAccumulatedDistance > 0 && runDurationSeconds > 0) {
    const rawPace = (runDurationSeconds / 60) / gpsAccumulatedDistance; // mins/km
    const paceMins = Math.floor(rawPace);
    const paceSecs = Math.floor((rawPace - paceMins) * 60);
    document.getElementById('gps-pace').innerText = `${paceMins}:${paceSecs.toString().padStart(2, '0')}`;
  } else {
    document.getElementById('gps-pace').innerText = '--:--';
  }
}

// Distance Helper (Haversine Formula)
function calculateHaversineDistance(p1, p2) {
  const R = 6371e3; // Earth radius in meters
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLon = (p2.lon - p1.lon) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// --- MOTION SENSOR LOGIC: SQUATS (v1.2 policy) ---
function toggleSquat() {
  if (isSquatting) {
    stopSquat();
  } else {
    startSquat();
  }
}

function startSquat() {
  if (activeWorkout) {
    showToast('END ACTIVE SESSION FIRST');
    return;
  }
  
  // Check hardware eligibility (Policy 6.1)
  if (!window.DeviceMotionEvent) {
    showToast('DEVICE MOTION NOT SUPPORTED ON THIS BROWSER');
    document.getElementById('squat-sensor-status').innerText = 'ERROR';
    return;
  }
  
  // Request iOS permission if on iOS (handled gracefully in PWA context)
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission()
      .then(permissionState => {
        if (permissionState === 'granted') {
          initSquatSensors();
        } else {
          showToast('MOTION SENSOR PERMISSION DENIED');
        }
      })
      .catch(console.error);
  } else {
    // Android or Chrome desktop
    initSquatSensors();
  }
}

function initSquatSensors() {
  requestWakeLock();
  activeWorkout = 'squat';
  isSquatting = true;
  squatCount = 0;
  peakAccNorm = 0;
  tiltWarningCount = 0;
  sensorNormHistory = [];
  lastSquatCountTime = Date.now();
  
  document.getElementById('squat-count').innerText = '000';
  document.getElementById('squat-motion-state').innerText = 'READY';
  document.getElementById('btn-squat-toggle').innerText = 'STOP SQUAT';
  document.getElementById('btn-squat-toggle').classList.add('btn-red');
  
  window.addEventListener('devicemotion', handleDeviceMotion, true);
  showToast('SQUAT TRACKING READY');
}

// Low Pass Filter implementation: Cut-off frequency 3Hz at ~100Hz sampling
// Filter coefficient alpha = dt / (RC + dt)
const filterAlpha = 0.15; 

function handleDeviceMotion(e) {
  // Use accelerationIncludingGravity or linearAcceleration depending on availability
  let ax = e.acceleration?.x;
  let ay = e.acceleration?.y;
  let az = e.acceleration?.z;
  
  // Fallback if acceleration without gravity is missing
  if (ax === null || ax === undefined) {
    ax = e.accelerationIncludingGravity?.x || 0;
    ay = (e.accelerationIncludingGravity?.y || 0) - 9.8; // Rough gravity subtraction
    az = e.accelerationIncludingGravity?.z || 0;
  }
  
  // Policy 5.2: 3-Axis Norm calculation
  const rawNorm = Math.sqrt(ax*ax + ay*ay + az*az);
  
  // Low-Pass Filter (LPF)
  lowPassFilteredNorm = lowPassFilteredNorm + filterAlpha * (rawNorm - lowPassFilteredNorm);
  
  // Gym angles: Check gyro tilt
  let rRate = e.rotationRate;
  if (rRate) {
    // Gyro values
    const pitch = Math.abs(rRate.beta || 0); 
    const roll = Math.abs(rRate.alpha || 0);
    const maxTilt = Math.max(pitch, roll);
    
    // Policy 5.2: Gyro warning threshold (30 degrees tilt)
    if (maxTilt > 30) {
      tiltWarningCount++;
      document.getElementById('squat-tilt').innerHTML = `<span style="color: var(--color-primary)">TILT (${Math.round(maxTilt)}°)</span>`;
      document.getElementById('squat-tilt').classList.add('blink');
    } else {
      document.getElementById('squat-tilt').innerText = `OK (${Math.round(maxTilt)}°)`;
      document.getElementById('squat-tilt').classList.remove('blink');
    }
  }

  // Track Peak
  if (lowPassFilteredNorm > peakAccNorm) {
    peakAccNorm = lowPassFilteredNorm;
  }
  
  // Update motion gauge bar height (instead of canvas graph draw)
  const gaugePercent = Math.min(100, Math.max(0, (lowPassFilteredNorm - dynamicThresholdLow) / (dynamicThresholdHigh - dynamicThresholdLow) * 100));
  const gaugeBar = document.getElementById('squat-gauge-bar');
  if (gaugeBar) {
    gaugeBar.style.height = gaugePercent + '%';
  }

  // Push to history for dynamic standard deviation threshold computation
  sensorNormHistory.push(lowPassFilteredNorm);
  if (sensorNormHistory.length > SENSOR_HISTORY_LIMIT) {
    sensorNormHistory.shift();
  }
  
  // Push value to graph array
  graphData.push(lowPassFilteredNorm);
  if (graphData.length > 80) graphData.shift();
  
  // Running Squat Peak-Valley Tracker (Policy 5.3)
  detectSquatCycle();
}

function detectSquatCycle() {
  if (sensorNormHistory.length < 50) return; // Wait to accumulate buffer
  
  // Policy 5.3: Compute dynamic thresholds based on signal deviation
  const avg = sensorNormHistory.reduce((s, x) => s + x, 0) / sensorNormHistory.length;
  const sqDiffSum = sensorNormHistory.reduce((s, x) => s + Math.pow(x - avg, 2), 0);
  const stdDev = Math.sqrt(sqDiffSum / sensorNormHistory.length);
  
  // Adaptive threshold calculation
  dynamicThresholdHigh = avg + Math.max(baseThreshold, stdDev * 1.2);
  dynamicThresholdLow = avg - Math.max(baseThreshold, stdDev * 1.2);
  
  const now = Date.now();
  const currentVal = lowPassFilteredNorm;
  
  // Peak-Valley Matching state machine
  if (motionState === 'READY' && currentVal > dynamicThresholdHigh) {
    motionState = 'DOWN';
    squatPeakTime = now;
    document.getElementById('squat-motion-state').innerText = 'DOWN';
  } 
  else if (motionState === 'DOWN') {
    if (currentVal < dynamicThresholdLow) {
      // Valley reached (turning point back to rising)
      const duration = (now - squatPeakTime) / 1000;
      
      // Policy 5.3 Step 3: Duration window 0.6s to 2.2s
      if (duration >= 0.6 && duration <= 2.2) {
        motionState = 'UP';
        document.getElementById('squat-motion-state').innerText = 'UP';
      } else {
        // Reset due to invalid duration
        motionState = 'READY';
        document.getElementById('squat-motion-state').innerText = 'READY';
      }
    }
    // Timeout backup if stuck down too long
    else if ((now - squatPeakTime) > 2500) {
      motionState = 'READY';
      document.getElementById('squat-motion-state').innerText = 'READY';
    }
  }
  else if (motionState === 'UP') {
    // Normalization recovery
    if (currentVal >= (avg - 0.2) && currentVal <= (avg + 0.2)) {
      squatCount++;
      document.getElementById('squat-count').innerText = squatCount.toString().padStart(3, '0');
      
      // Play 8-bit retro sound
      playRetroBeep();
      
      // Enter cooldown to avoid double count (Policy 5.3 Step 4: 0.8s)
      motionState = 'COOLDOWN';
      document.getElementById('squat-motion-state').innerText = 'HOLD';
      lastSquatCountTime = now;
    }
  }
  else if (motionState === 'COOLDOWN') {
    if ((now - lastSquatCountTime) > 800) {
      motionState = 'READY';
      document.getElementById('squat-motion-state').innerText = 'READY';
    }
  }
}

function stopSquat() {
  window.removeEventListener('devicemotion', handleDeviceMotion, true);
  isSquatting = false;
  activeWorkout = null;
  releaseWakeLock();
  
  document.getElementById('btn-squat-toggle').innerText = 'START SQUAT';
  document.getElementById('btn-squat-toggle').classList.remove('btn-red');
  document.getElementById('squat-motion-state').innerText = 'READY';
  
  const finalSquat = squatCount;
  openFeedbackModal('SQUAT', `${finalSquat} reps completed`);
}

// 8-bit Retro sound effect generator using Web Audio API
function playRetroBeep() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc.type = 'triangle'; // triangle has that nice retro game console warmth
    osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
    osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.08); // A5 (upward leap)
    
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
    
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.2);
  } catch(e) {
    console.error('Audio beep failed', e);
  }
}

// Draw Oscilloscope Motion Graph
function drawGraph() {
  if (!isSquatting) return;
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#8be03a';
  ctx.lineWidth = 2;
  
  ctx.beginPath();
  const step = canvas.width / 80;
  
  for (let i = 0; i < graphData.length; i++) {
    // Map values around center line
    const val = graphData[i];
    const y = (canvas.height / 2) - (val * 8);
    const x = i * step;
    
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  
  // Draw adaptive high/low lines as dotted green
  ctx.strokeStyle = 'rgba(139, 224, 58, 0.2)';
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(0, (canvas.height / 2) - (dynamicThresholdHigh * 8));
  ctx.lineTo(canvas.width, (canvas.height / 2) - (dynamicThresholdHigh * 8));
  ctx.moveTo(0, (canvas.height / 2) - (dynamicThresholdLow * 8));
  ctx.lineTo(canvas.width, (canvas.height / 2) - (dynamicThresholdLow * 8));
  ctx.stroke();
  ctx.setLineDash([]); // Reset
  
  requestAnimationFrame(drawGraph);
}

// --- WAKE LOCK API (Ensure Screen On) ---
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Screen Wake Lock active');
    }
  } catch (err) {
    console.warn(`${err.name}, ${err.message}`);
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release().then(() => {
      wakeLock = null;
    });
  }
}

// --- SYNC ENGINE: GOOGLE SHEETS & LOCALSTORAGE QUEUE ---
function openFeedbackModal(type, summaryText) {
  document.getElementById('feedback-workout-summary').innerText = `[${type}] ${summaryText}`;
  document.getElementById('feedback-comment').value = '';
  document.getElementById('feedback-modal').style.display = 'flex';
  
  // Set default active stars
  // rateSession removed
  
  // Create temp session storage
  localStorage.setItem('temp_workout_session', JSON.stringify({
    workout_type: type,
    metrics: summaryText,
    device_model: navigator.userAgent.includes('Android') ? 'Android Device' : 'iOS/Web Device'
  }));
}

function rateSession(stars) {
  // stars rating removed
  const starsList = document.querySelectorAll('.star-btn');
  starsList.forEach((btn, idx) => {
    if (idx < stars) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function closeFeedback() {
  document.getElementById('feedback-modal').style.display = 'none';
  localStorage.removeItem('temp_workout_session');
}

function submitFeedback() {
  const tempSessionRaw = localStorage.getItem('temp_workout_session');
  if (!tempSessionRaw) {
    closeFeedback();
    return;
  }
  
  const tempSession = JSON.parse(tempSessionRaw);
  const comment = document.getElementById('feedback-comment').value;
  
  const feedbackData = {
    ...tempSession,
    comment: comment,
    timestamp: new Date().toISOString()
  };
  
  // Add to Queue
  webhookQueue.push(feedbackData);
  localStorage.setItem('y2k_webhook_queue', JSON.stringify(webhookQueue));
  updateQueueUI();
  
  closeFeedback();
  showToast('FEEDBACK SAVED TO QUEUE');
  
  // Try sending immediately
  syncQueue();
}

function updateQueueUI() {
  document.getElementById('queue-count').innerText = webhookQueue.length;
}

// Webhook dispatcher
function syncQueue() {
  const sheetUrl = 'https://script.google.com/macros/s/AKfycby4RS17W3lZBXdrfgrFga0vwiAinuwGM8NO9wm7CkCIGHiiutQfoouRrtWQDaqlT09FDg/exec';
  
  if (webhookQueue.length === 0) {
    showToast('NO PENDING DATA TO SYNC');
    return;
  }
  
  // Using hardcoded URL
  
  showToast('SYNCING...');
  let completedCount = 0;
  const queueToProcess = [...webhookQueue];
  
  queueToProcess.forEach((item, index) => {
    fetch(sheetUrl, {
      method: 'POST',
      mode: 'no-cors', // standard cross-domain webhook trigger
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(item)
    })
    .then(() => {
      // Remove from memory queue
      webhookQueue = webhookQueue.filter(q => q.timestamp !== item.timestamp);
      localStorage.setItem('y2k_webhook_queue', JSON.stringify(webhookQueue));
      completedCount++;
      
      if (index === queueToProcess.length - 1 || webhookQueue.length === 0) {
        showToast(`SYNC COMPLETE! (${completedCount} LOGS SENT)`);
        updateQueueUI();
      }
    })
    .catch(err => {
      console.error(err);
      showToast('SYNC ERROR: DATA STORED OFFLINE');
    });
  });
}

// Format utilities
function formatTime(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Load configurations and set network monitors
window.addEventListener('load', () => {
  // Fixed Sheet Integration
  
  updateQueueUI();
  
  // Network online status indicators
  const updateOnlineStatus = () => {
    const isOnline = navigator.onLine;
    const indicator = document.getElementById('connection-status');
    if (isOnline) {
      indicator.innerText = 'ONLINE';
      indicator.style.backgroundColor = 'var(--color-amber)';
      indicator.style.color = 'var(--color-carbon)';
      syncQueue(); // Auto sync when network is restored
    } else {
      indicator.innerText = 'OFFLINE';
      indicator.style.backgroundColor = 'var(--color-primary)';
      indicator.style.color = 'var(--color-on-primary)';
    }
  };
  
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus(); // initial trigger
});

// Manual feedback submission inside settings
function submitFeedbackDirect() {
  const commentInput = document.getElementById('feedback-comment');
  const commentText = commentInput.value.trim();
  
  if (!commentText) {
    showToast('PLEASE ENTER A COMMENT FIRST');
    return;
  }
  
  const feedbackData = {
    workout_type: 'FEEDBACK',
    metrics: 'User text feedback',
    device_model: navigator.userAgent.includes('Android') ? 'Android Device' : 'iOS/Web Device',
    comment: commentText,
    timestamp: new Date().toISOString()
  };
  
  webhookQueue.push(feedbackData);
  localStorage.setItem('y2k_webhook_queue', JSON.stringify(webhookQueue));
  updateQueueUI();
  
  commentInput.value = '';
  showToast('FEEDBACK SAVED TO QUEUE');
  
  syncQueue();
}

// Running character frames
let runnerAnimInterval = null;
const runnerFrames = [
  '\\\\o-[===]',
  '|o-[===]',
  '/o-[===]',
  '-o-[===]'
];
let currentRunnerFrameIdx = 0;

function startRunnerAnimation() {
  try {
    if (runnerAnimInterval !== null) {
      clearInterval(runnerAnimInterval);
      runnerAnimInterval = null;
    }
  } catch(e) {}
  
  runnerAnimInterval = setInterval(() => {
    currentRunnerFrameIdx = (currentRunnerFrameIdx + 1) % runnerFrames.length;
    const runnerEl = document.getElementById('running-runner-character');
    if (runnerEl) {
      runnerEl.innerText = runnerFrames[currentRunnerFrameIdx];
    }
  }, 250);
}

function stopRunnerAnimation() {
  if (runnerAnimInterval) {
    clearInterval(runnerAnimInterval);
    runnerAnimInterval = null;
  }
  const runnerEl = document.getElementById('running-runner-character');
  if (runnerEl) {
    runnerEl.innerText = 'o-[===]';
  }
}
