const statusEl = document.getElementById('status');
const textEl = document.getElementById('config-text');
const btnLoad = document.getElementById('btn-load');
const btnSave = document.getElementById('btn-save');
const targetEl = document.getElementById('config-target');

function setStatus(msg, ok = true) {
  statusEl.textContent = msg;
  statusEl.style.color = ok ? '#0a7' : '#c00';
}

function getApiPath() {
  return targetEl.value === 'banking-devices'
    ? '/api/banking-devices'
    : '/api/config';
}

async function loadConfig() {
  setStatus('Đang tải...', true);
  try {
    const res = await fetch(`${getApiPath()}?raw=1`);
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(raw || 'Không tải được config');
    }
    textEl.value = raw;
    setStatus('Đã tải', true);
  } catch (err) {
    setStatus(err.message, false);
  }
}

async function saveConfig() {
  setStatus('Đang lưu...', true);
  try {
    let parsed;
    try {
      parsed = JSON.parse(textEl.value || '{}');
    } catch (e) {
      throw new Error('JSON không hợp lệ');
    }
    const res = await fetch(getApiPath(), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: textEl.value,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Không lưu được config');
    }
    setStatus('Đã lưu', true);
  } catch (err) {
    setStatus(err.message, false);
  }
}

btnLoad.addEventListener('click', loadConfig);
btnSave.addEventListener('click', saveConfig);
targetEl.addEventListener('change', loadConfig);

loadConfig();
