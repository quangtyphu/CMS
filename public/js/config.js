const statusEl = document.getElementById('status');
const textEl = document.getElementById('config-text');
const btnLoad = document.getElementById('btn-load');
const btnSave = document.getElementById('btn-save');
const targetEl = document.getElementById('config-target');
const hintEl = document.getElementById('config-hint');

const HINTS = {
  lc79: 'LC79 — toàn bộ config.json (chia tiền, nạp, slot, …).',
  xoso66:
    'XOSO66 — file LC79/xoso66_standalone/xoso66_config.json (cùng python main.py). ' +
    'Chỉ các key trong file; hardcode còn lại: xoso66_config_util.py. ' +
    'Sau khi lưu: restart python main.py.',
  'banking-devices': 'Banking — devices.json.',
};

function setStatus(msg, ok = true) {
  statusEl.textContent = msg;
  statusEl.style.color = ok ? '#0a7' : '#c00';
}

function updateHint() {
  if (hintEl) {
    hintEl.textContent = HINTS[targetEl.value] || '';
  }
}

function getApiPath() {
  const t = targetEl.value;
  if (t === 'banking-devices') return '/api/banking-devices';
  if (t === 'xoso66') return '/api/xoso66-config';
  return '/api/config';
}

function applyTargetFromQuery() {
  const q = new URLSearchParams(window.location.search);
  const target = q.get('target');
  if (target && targetEl.querySelector(`option[value="${target}"]`)) {
    targetEl.value = target;
  }
}

function parseFetchError(raw, status) {
  if (raw && raw.includes('Cannot GET /api/xoso66-config')) {
    return (
      'CMS chưa có API xoso66-config — restart Node trong thư mục CMS: '
      + 'node server.js (tắt process cũ trước).'
    );
  }
  if (raw && raw.trim().startsWith('<!')) {
    return `HTTP ${status}: server trả HTML (thường là 404 — restart CMS hoặc sai URL API).`;
  }
  return raw || `HTTP ${status}`;
}

async function loadConfig() {
  setStatus('Đang tải...', true);
  updateHint();
  try {
    const res = await fetch(`${getApiPath()}?raw=1`);
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(parseFetchError(raw, res.status));
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
    try {
      JSON.parse(textEl.value || '{}');
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
      const raw = typeof data.error === 'string' ? data.error : '';
      throw new Error(data.error || parseFetchError(raw, res.status) || 'Không lưu được config');
    }
    const pathNote = data.path ? ` (${data.path})` : '';
    setStatus(`Đã lưu${pathNote}`, true);
    if (targetEl.value === 'xoso66') {
      setStatus(`Đã lưu — restart python main.py để áp dụng${pathNote}`, true);
    }
  } catch (err) {
    setStatus(err.message, false);
  }
}

btnLoad.addEventListener('click', loadConfig);
btnSave.addEventListener('click', saveConfig);
targetEl.addEventListener('change', loadConfig);

applyTargetFromQuery();
loadConfig();
