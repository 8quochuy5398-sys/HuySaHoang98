// Giao diện khung chat: đặt tên, nhắn tin và gửi ảnh thời gian thực qua SSE,
// bảng điều khiển dành cho chủ phòng.
//
// Lưu ý an toàn: mọi nội dung do người dùng nhập đều được chèn bằng
// textContent hoặc tạo phần tử DOM, không dùng innerHTML với dữ liệu lạ,
// nên không chèn được mã HTML/JS. Link chỉ bấm được khi bắt đầu bằng
// http:// hoặc https://.

const $ = (id) => document.getElementById(id);

const state = {
  token: null,
  userId: null,
  name: null,
  isOwner: false,
  muted: false,
  locked: false,
  users: [],
  eventSource: null,
  heartbeatTimer: null,
  lastTypingSent: 0,
  typingTimers: new Map(),
  maxImageMB: 2,
  pendingImage: null, // { dataUrl, name }
  uploading: false,
};

// ---------- Hàm gọi API ----------
async function postJSON(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Có lỗi xảy ra.');
  return data;
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

function hideError(el) {
  el.hidden = true;
  el.textContent = '';
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

// ---------- Tách link trong văn bản (hàm thuần, không dùng DOM) ----------
// Trả về mảng các đoạn { type: 'text' | 'link', value }. Chỉ nhận link
// http/https, bỏ dấu câu dính ở cuối link.
function splitLinks(text) {
  const parts = [];
  const re = /\bhttps?:\/\/[^\s<>"']+/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    let cut = raw.length;
    while (cut > 0 && '.,;:!?'.includes(raw[cut - 1])) cut--;
    if (cut > 0 && raw[cut - 1] === ')' && !raw.slice(0, cut).includes('(')) cut--;
    const url = raw.slice(0, cut);
    const tail = raw.slice(cut);
    if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) });
    if (url) parts.push({ type: 'link', value: url });
    if (tail) parts.push({ type: 'text', value: tail });
    last = m.index + raw.length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

function appendLinkified(el, text) {
  splitLinks(text).forEach((part) => {
    if (part.type === 'link') {
      const a = document.createElement('a');
      a.href = part.value;
      a.textContent = part.value;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      el.appendChild(a);
    } else {
      el.appendChild(document.createTextNode(part.value));
    }
  });
}

// ---------- Màn hình vào phòng ----------
async function loadConfig() {
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    document.title = cfg.roomName;
    $('roomTitleJoin').textContent = cfg.roomName;
    $('roomTitle').textContent = cfg.roomName;
    if (cfg.maxImageMB) state.maxImageMB = cfg.maxImageMB;
  } catch (_) {
    // Giữ tên mặc định nếu không tải được cấu hình.
  }
}

$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('nameInput').value;
  hideError($('joinError'));
  try {
    const data = await postJSON('/api/join', { name });
    state.token = data.token;
    state.userId = data.userId;
    state.name = data.name;
    state.locked = data.locked;
    state.users = data.users;
    enterChat(data.history);
  } catch (err) {
    showError($('joinError'), err.message);
  }
});

function enterChat(history) {
  $('joinView').hidden = true;
  $('chatView').hidden = false;
  $('messages').innerHTML = '';
  history.forEach(renderMessage);
  renderUsers();
  updateLockUI();
  connectStream();
  state.heartbeatTimer = setInterval(sendHeartbeat, 20000);
  $('msgInput').focus();
}

function backToJoin(message) {
  if (state.eventSource) state.eventSource.close();
  clearInterval(state.heartbeatTimer);
  if (state.token) {
    try {
      navigator.sendBeacon(
        '/api/leave',
        new Blob([JSON.stringify({ token: state.token })], { type: 'application/json' })
      );
    } catch (_) {}
  }
  Object.assign(state, { token: null, userId: null, name: null, isOwner: false, muted: false, locked: false, users: [], eventSource: null, pendingImage: null, uploading: false });
  document.body.classList.remove('is-owner');
  $('chatView').hidden = true;
  $('joinView').hidden = false;
  $('ownerPanel').hidden = true;
  clearImagePreview();
  if (message) showError($('joinError'), message);
}

// ---------- Luồng thời gian thực (SSE) ----------
function connectStream() {
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);
  state.eventSource = es;

  es.addEventListener('message', (e) => {
    renderMessage(JSON.parse(e.data).message);
  });
  es.addEventListener('deleted', (e) => {
    const { id } = JSON.parse(e.data);
    document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`)?.remove();
  });
  es.addEventListener('cleared', () => {
    $('messages').innerHTML = '';
  });
  es.addEventListener('users', (e) => {
    state.users = JSON.parse(e.data).users;
    renderUsers();
  });
  es.addEventListener('locked', (e) => {
    state.locked = JSON.parse(e.data).locked;
    updateLockUI();
  });
  es.addEventListener('kicked', (e) => {
    const { reason } = JSON.parse(e.data);
    backToJoin(reason || 'Bạn đã bị mời ra khỏi phòng.');
  });
  es.addEventListener('muted', (e) => {
    state.muted = JSON.parse(e.data).muted;
    updateComposerState();
    showChatError(state.muted ? 'Bạn đang bị chủ phòng khóa chat.' : 'Bạn đã được mở khóa chat.');
    if (!state.muted) setTimeout(() => hideError($('chatError')), 3000);
  });
  es.addEventListener('typing', (e) => {
    showTyping(JSON.parse(e.data).name);
  });
  es.onerror = () => {
    // EventSource tự nối lại. Nếu phiên đã hết hạn, nhịp tim sẽ báo 401
    // và giao diện quay về màn hình vào phòng.
  };
}

async function sendHeartbeat() {
  if (!state.token) return;
  try {
    const data = await postJSON('/api/ping', { token: state.token });
    state.locked = data.locked;
    state.muted = data.muted;
    updateLockUI();
    updateComposerState();
  } catch (_) {
    backToJoin('Phiên chat đã hết hạn, vui lòng vào lại phòng.');
  }
}

// ---------- Hiển thị tin nhắn & người online ----------
function renderMessage(msg) {
  const wrap = $('messages');
  const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;

  const div = document.createElement('div');
  div.className = 'message';
  div.dataset.msgId = msg.id;

  if (msg.system) {
    div.classList.add('system');
    const bubble = document.createElement('span');
    bubble.className = 'bubble';
    bubble.textContent = msg.text;
    div.appendChild(bubble);
  } else {
    if (msg.userId === state.userId) div.classList.add('mine');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = msg.owner ? `👑 ${msg.name}` : msg.name;
    meta.appendChild(nameEl);
    meta.appendChild(document.createTextNode(` · ${formatTime(msg.time)}`));
    div.appendChild(meta);

    const bubble = document.createElement('span');
    bubble.className = 'bubble';
    if (msg.kind === 'image' && msg.imageUrl) {
      const link = document.createElement('a');
      link.href = msg.imageUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.src = msg.imageUrl;
      img.alt = 'Hình ảnh do ' + msg.name + ' gửi';
      img.loading = 'lazy';
      img.className = 'chat-image';
      link.appendChild(img);
      bubble.appendChild(link);
      if (msg.text) {
        const caption = document.createElement('span');
        caption.className = 'caption';
        appendLinkified(caption, msg.text);
        bubble.appendChild(caption);
      }
    } else {
      appendLinkified(bubble, msg.text || '');
    }
    div.appendChild(bubble);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del-btn';
    del.title = 'Xóa tin nhắn này (chủ phòng)';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      try {
        await postJSON('/api/owner/delete', { token: state.token, id: msg.id });
      } catch (err) {
        showChatError(err.message);
      }
    });
    div.appendChild(del);
  }

  wrap.appendChild(div);
  if (nearBottom) wrap.scrollTop = wrap.scrollHeight;
}

function renderUsers() {
  const list = $('userList');
  list.innerHTML = '';
  $('onlineCount').textContent = `${state.users.length} người online`;

  state.users.forEach((u) => {
    const li = document.createElement('li');
    const nameEl = document.createElement('span');
    nameEl.className = 'uname';
    nameEl.textContent = u.isOwner ? `👑 ${u.name}` : u.name;
    if (u.id === state.userId) nameEl.textContent += ' (bạn)';
    if (u.muted) {
      const tag = document.createElement('span');
      tag.className = 'muted-tag';
      tag.textContent = ' · bị khóa chat';
      nameEl.appendChild(tag);
    }
    li.appendChild(nameEl);

    if (state.isOwner && u.id !== state.userId) {
      const actions = document.createElement('span');
      actions.className = 'user-actions';

      const muteBtn = document.createElement('button');
      muteBtn.type = 'button';
      muteBtn.textContent = u.muted ? 'Mở khóa' : 'Khóa chat';
      muteBtn.addEventListener('click', () => ownerMute(u));
      const kickBtn = document.createElement('button');
      kickBtn.type = 'button';
      kickBtn.textContent = 'Đuổi';
      kickBtn.addEventListener('click', () => {
        if (confirm(`Đuổi ${u.name} ra khỏi phòng?`)) ownerKick(u);
      });
      const banBtn = document.createElement('button');
      banBtn.type = 'button';
      banBtn.textContent = 'Cấm';
      banBtn.addEventListener('click', () => {
        if (confirm(`Cấm ${u.name} (tên này sẽ không vào lại được)?`)) ownerBan(u);
      });
      actions.append(muteBtn, kickBtn, banBtn);
      li.appendChild(actions);
    }
    list.appendChild(li);
  });
}

function showChatError(message) {
  showError($('chatError'), message);
}

function updateLockUI() {
  $('lockBadge').hidden = !state.locked;
  $('lockBtn').textContent = state.locked ? '🔓 Mở khóa phòng' : '🔒 Khóa phòng';
  updateComposerState();
}

function updateComposerState() {
  const blocked = state.muted || (state.locked && !state.isOwner);
  $('msgInput').disabled = blocked;
  $('sendBtn').disabled = blocked || state.uploading;
  $('imageInput').disabled = blocked;
  $('attachLabel').classList.toggle('disabled', blocked);
  $('msgInput').placeholder = state.muted
    ? 'Bạn đang bị khóa chat'
    : state.locked && !state.isOwner
      ? 'Phòng đang khóa'
      : 'Nhắn gì đó...';
}

// ---------- Gửi tin nhắn, gửi ảnh & trạng thái đang gõ ----------
function attachFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showChatError('Chỉ gửi được file hình ảnh.');
    return;
  }
  if (file.size > state.maxImageMB * 1024 * 1024) {
    showChatError(`Ảnh phải nhỏ hơn ${state.maxImageMB} MB.`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.pendingImage = { dataUrl: reader.result, name: file.name || 'hình ảnh' };
    $('previewImg').src = state.pendingImage.dataUrl;
    $('previewName').textContent = state.pendingImage.name;
    $('imagePreview').hidden = false;
    hideError($('chatError'));
  };
  reader.onerror = () => showChatError('Không đọc được file ảnh.');
  reader.readAsDataURL(file);
}

function clearImagePreview() {
  state.pendingImage = null;
  $('imageInput').value = '';
  $('imagePreview').hidden = true;
  $('previewImg').removeAttribute('src');
  $('previewName').textContent = '';
}

$('imageInput').addEventListener('change', () => {
  const file = $('imageInput').files[0];
  if (file) attachFile(file);
});

$('removeImageBtn').addEventListener('click', clearImagePreview);

// Dán ảnh từ clipboard (chụp màn hình rồi Ctrl+V) cũng gửi được.
$('msgInput').addEventListener('paste', (e) => {
  const files = e.clipboardData ? [...e.clipboardData.files] : [];
  const image = files.find((f) => f.type.startsWith('image/'));
  if (image) {
    e.preventDefault();
    attachFile(image);
  }
});

$('msgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('msgInput').value;
  if (!text.trim() && !state.pendingImage) return;
  if (state.uploading) return;
  hideError($('chatError'));
  try {
    if (state.pendingImage) {
      state.uploading = true;
      updateComposerState();
      $('sendBtn').textContent = 'Đang gửi...';
      await postJSON('/api/images', { token: state.token, dataUrl: state.pendingImage.dataUrl, caption: text });
      clearImagePreview();
    } else {
      await postJSON('/api/messages', { token: state.token, text });
    }
    $('msgInput').value = '';
    $('msgInput').focus();
  } catch (err) {
    showChatError(err.message);
  } finally {
    state.uploading = false;
    $('sendBtn').textContent = 'Gửi';
    updateComposerState();
  }
});

$('msgInput').addEventListener('input', () => {
  const now = Date.now();
  if (now - state.lastTypingSent < 3000) return;
  state.lastTypingSent = now;
  postJSON('/api/typing', { token: state.token }).catch(() => {});
});

function showTyping(name) {
  const el = $('typingIndicator');
  el.textContent = `${name} đang gõ...`;
  el.hidden = false;
  clearTimeout(state.typingTimers.get(name));
  state.typingTimers.set(
    name,
    setTimeout(() => {
      el.hidden = true;
    }, 3000)
  );
}

// ---------- Rời phòng ----------
$('leaveBtn').addEventListener('click', () => backToJoin());
window.addEventListener('beforeunload', () => {
  if (state.token) {
    try {
      navigator.sendBeacon(
        '/api/leave',
        new Blob([JSON.stringify({ token: state.token })], { type: 'application/json' })
      );
    } catch (_) {}
  }
});

// ---------- Bảng chủ phòng ----------
$('ownerBtn').addEventListener('click', () => {
  $('ownerPanel').hidden = !$('ownerPanel').hidden;
});

$('ownerLoginBtn').addEventListener('click', async () => {
  hideError($('ownerLoginError'));
  try {
    await postJSON('/api/owner/login', { token: state.token, password: $('ownerPassword').value });
    state.isOwner = true;
    document.body.classList.add('is-owner');
    $('ownerLoginBox').hidden = true;
    $('ownerControls').hidden = false;
    $('ownerPassword').value = '';
    renderUsers();
    updateComposerState();
    await refreshBanned();
  } catch (err) {
    showError($('ownerLoginError'), err.message);
  }
});

async function refreshBanned() {
  try {
    const data = await fetch(`/api/owner/banned?token=${encodeURIComponent(state.token)}`).then((r) => r.json());
    const list = $('bannedList');
    list.innerHTML = '';
    if (!data.banned || data.banned.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'Chưa có ai bị cấm.';
      list.appendChild(li);
      return;
    }
    data.banned.forEach((name) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = name;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Gỡ cấm';
      btn.addEventListener('click', async () => {
        await postJSON('/api/owner/unban', { token: state.token, name });
        refreshBanned();
      });
      li.append(span, btn);
      list.appendChild(li);
    });
  } catch (_) {}
}

async function ownerMute(u) {
  try {
    await postJSON('/api/owner/mute', { token: state.token, userId: u.id, muted: !u.muted });
  } catch (err) {
    showChatError(err.message);
  }
}

async function ownerKick(u) {
  try {
    await postJSON('/api/owner/kick', { token: state.token, userId: u.id });
  } catch (err) {
    showChatError(err.message);
  }
}

async function ownerBan(u) {
  try {
    await postJSON('/api/owner/ban', { token: state.token, userId: u.id });
    refreshBanned();
  } catch (err) {
    showChatError(err.message);
  }
}

$('lockBtn').addEventListener('click', async () => {
  try {
    const data = await postJSON('/api/owner/lock', { token: state.token, locked: !state.locked });
    state.locked = data.locked;
    updateLockUI();
  } catch (err) {
    showChatError(err.message);
  }
});

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('Xóa toàn bộ lịch sử chat? Hành động này không hoàn lại được.')) return;
  try {
    await postJSON('/api/owner/clear', { token: state.token });
  } catch (err) {
    showChatError(err.message);
  }
});

// ---------- Khởi động ----------
loadConfig();
