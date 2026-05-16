const clockEl = document.getElementById('clock');
const alarmTimeEl = document.getElementById('alarm-time');
const setBtn = document.getElementById('set-btn');
const cancelBtn = document.getElementById('cancel-btn');
const statusEl = document.getElementById('alarm-status');
const modal = document.getElementById('modal');
const stopBtn = document.getElementById('stop-btn');

let alarmTime = null;
let alarmFired = false;

// Web Audio API でビープ音を生成（外部ファイル不要）
let audioCtx = null;
let beepInterval = null;

function startBeep() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  beepInterval = setInterval(() => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.4, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.4);
  }, 600);
}

function stopBeep() {
  if (beepInterval) {
    clearInterval(beepInterval);
    beepInterval = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function tick() {
  const now = new Date();
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  clockEl.textContent = `${hh}:${mm}:${ss}`;

  if (alarmTime && !alarmFired) {
    const current = `${hh}:${mm}`;
    if (current === alarmTime && now.getSeconds() === 0) {
      triggerAlarm();
    }
  }
}

function triggerAlarm() {
  alarmFired = true;
  modal.classList.remove('hidden');
  startBeep();
}

function dismissAlarm() {
  modal.classList.add('hidden');
  stopBeep();
  alarmTime = null;
  alarmFired = false;
  statusEl.textContent = 'アラームなし';
  cancelBtn.classList.add('hidden');
}

setBtn.addEventListener('click', () => {
  const val = alarmTimeEl.value;
  if (!val) {
    statusEl.textContent = '時刻を選択してください';
    return;
  }
  alarmTime = val;
  alarmFired = false;
  statusEl.textContent = `アラームセット済み: ${val}`;
  cancelBtn.classList.remove('hidden');
});

cancelBtn.addEventListener('click', () => {
  alarmTime = null;
  alarmFired = false;
  statusEl.textContent = 'アラームなし';
  cancelBtn.classList.add('hidden');
  alarmTimeEl.value = '';
});

stopBtn.addEventListener('click', dismissAlarm);

setInterval(tick, 1000);
tick();
