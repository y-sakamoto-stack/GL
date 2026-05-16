const displayEl = document.getElementById('display');
const minutesEl = document.getElementById('minutes');
const secondsEl = document.getElementById('seconds');
const inputsEl = document.getElementById('inputs');
const startBtn = document.getElementById('start-btn');
const pauseBtn = document.getElementById('pause-btn');
const resetBtn = document.getElementById('reset-btn');
const statusEl = document.getElementById('status');

let remaining = 0;
let intervalId = null;
let running = false;

function pad(n) {
  return String(n).padStart(2, '0');
}

function updateDisplay() {
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  displayEl.textContent = `${pad(m)}:${pad(s)}`;
}

function beep() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  [0, 0.3, 0.6, 1.0].forEach(offset => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = offset === 1.0 ? 1046 : 880;
    gain.gain.setValueAtTime(0.4, ctx.currentTime + offset);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.25);
    osc.start(ctx.currentTime + offset);
    osc.stop(ctx.currentTime + offset + 0.25);
  });
}

function start() {
  if (running) return;

  if (remaining === 0) {
    const m = Math.max(0, parseInt(minutesEl.value) || 0);
    const s = Math.max(0, Math.min(59, parseInt(secondsEl.value) || 0));
    remaining = m * 60 + s;
    if (remaining === 0) {
      statusEl.textContent = '時間を設定してください';
      return;
    }
  }

  running = true;
  statusEl.textContent = '';
  displayEl.classList.remove('finished');
  inputsEl.classList.add('hidden');
  startBtn.classList.add('hidden');
  pauseBtn.classList.remove('hidden');

  intervalId = setInterval(() => {
    remaining--;
    updateDisplay();
    if (remaining <= 0) {
      clearInterval(intervalId);
      intervalId = null;
      running = false;
      displayEl.classList.add('finished');
      statusEl.textContent = '時間になりました！';
      pauseBtn.classList.add('hidden');
      startBtn.classList.remove('hidden');
      beep();
    }
  }, 1000);
}

function pause() {
  if (!running) return;
  clearInterval(intervalId);
  intervalId = null;
  running = false;
  pauseBtn.classList.add('hidden');
  startBtn.classList.remove('hidden');
  statusEl.textContent = '一時停止中';
}

function reset() {
  clearInterval(intervalId);
  intervalId = null;
  running = false;
  remaining = 0;
  minutesEl.value = 0;
  secondsEl.value = 0;
  displayEl.textContent = '00:00';
  displayEl.classList.remove('finished');
  inputsEl.classList.remove('hidden');
  startBtn.classList.remove('hidden');
  pauseBtn.classList.add('hidden');
  statusEl.textContent = '';
}

startBtn.addEventListener('click', start);
pauseBtn.addEventListener('click', pause);
resetBtn.addEventListener('click', reset);

minutesEl.addEventListener('input', () => {
  if (!running && remaining === 0) updateFromInputs();
});
secondsEl.addEventListener('input', () => {
  if (!running && remaining === 0) updateFromInputs();
});

function updateFromInputs() {
  const m = Math.max(0, parseInt(minutesEl.value) || 0);
  const s = Math.max(0, Math.min(59, parseInt(secondsEl.value) || 0));
  displayEl.textContent = `${pad(m)}:${pad(s)}`;
}
