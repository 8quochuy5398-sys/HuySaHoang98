// Khung chat online thời gian thực — chỉ dùng thư viện có sẵn của Node.js,
// không cần cài thêm gói nào (không cần npm install).
//
// Cách chạy:
//   node server.js
//   Mở trình duyệt: http://localhost:3000
//
// Biến môi trường:
//   PORT            Cổng chạy máy chủ (mặc định 3000; nền tảng triển khai tự gán).
//   OWNER_PASSWORD  Mật khẩu của chủ phòng (mặc định "chu-phong-123" — hãy đổi
//                   khi triển khai thật).
//   ROOM_NAME       Tên hiển thị của phòng chat.
//   DATA_FILE       File lưu lịch sử chat, danh sách cấm, trạng thái khóa phòng
//                   (mặc định ./chat-data.json).
//   UPLOADS_DIR     Thư mục lưu hình ảnh đã gửi (mặc định ./uploads).
//   MAX_IMAGE_MB    Dung lượng ảnh tối đa mỗi lần gửi, tính bằng MB (mặc định 2).
//
// Cách hoạt động: trình duyệt nhận tin nhắn mới qua SSE (Server-Sent Events)
// và gửi tin nhắn qua POST JSON. Lịch sử chat, danh sách cấm và trạng thái
// khóa phòng được ghi ra file JSON nên khởi động lại máy chủ vẫn còn.
// Lưu ý: trên gói miễn phí của Render, ổ đĩa là tạm thời — dữ liệu có thể
// mất khi máy chủ triển khai lại hoặc chuyển máy chủ. Muốn lưu thật lâu dài
// thì chạy trên VPS/máy chủ có ổ đĩa bền, hoặc gắn thêm ổ đĩa bền.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Đọc file .env nếu có (chỉ dùng khi chạy local; khi triển khai thì đặt
// biến môi trường trong bảng điều khiển của nền tảng).
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch (_) {
  // Không có file .env thì bỏ qua.
}

const PORT = Number(process.env.PORT || 3000);
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'chu-phong-123';
const ROOM_NAME = process.env.ROOM_NAME || 'Phòng chat trực tuyến';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'chat-data.json');
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, 'uploads'));
const MAX_IMAGE_MB = (() => {
  const n = Number(process.env.MAX_IMAGE_MB || 2);
  return Number.isFinite(n) && n > 0 ? n : 2;
})();
const MAX_IMAGE_BYTES = Math.floor(MAX_IMAGE_MB * 1024 * 1024);

const MAX_TEXT = 500; // Độ dài tối đa của một tin nhắn
const MAX_CAPTION = 200; // Độ dài tối đa của chú thích kèm ảnh
const STORE_LIMIT = 1000; // Số tin nhắn tối đa lưu trong file dữ liệu
const JOIN_HISTORY = 200; // Số tin nhắn gửi cho người mới vào phòng
const MIN_MSG_GAP_MS = 800; // Chống nhắn dồn dập: tối thiểu 0,8 giây/tin
const HEARTBEAT_TIMEOUT_MS = 60000; // Mất kết nối quá 60 giây thì coi như rời phòng
const MAX_UPLOAD_FILES = 500; // Số file ảnh tối đa trong thư mục uploads

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const IMAGE_MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// ---------------- Trạng thái ----------------
let messages = []; // { id, userId, name, text, time, owner, system, kind, imageUrl }
let locked = false; // Phòng bị khóa: chỉ chủ phòng được nhắn
const users = new Map(); // userId -> { id, name, token, isOwner, muted, lastSeen, lastMsgAt, res }
const bannedNames = new Set(); // Tên (viết thường) đã bị cấm
const BLOCKED_NAMES = ['hệ thống', 'he thong', 'admin', 'chủ phòng', 'chu phong', 'system'];

// ---------------- Lưu trữ lâu dài (file JSON) ----------------
function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(data.messages)) messages = data.messages.slice(-STORE_LIMIT);
    if (Array.isArray(data.banned)) {
      data.banned.forEach((n) => bannedNames.add(String(n).toLowerCase()));
    }
    locked = !!data.locked;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // File hỏng: giữ lại bản hỏng để xem sau, bắt đầu lại từ đầu.
      try {
        fs.renameSync(DATA_FILE, DATA_FILE + '.corrupt');
      } catch (_) {}
      console.warn('File dữ liệu bị lỗi, đã bắt đầu lại từ đầu.');
    }
  }
}

// Ghi ra file tạm rồi đổi tên (ghi nguyên tử) để tránh file hỏng dở
// nếu máy chủ tắt đúng lúc đang ghi.
function saveState() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ messages, banned: [...bannedNames], locked }));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.warn('Không ghi được file dữ liệu:', err.message);
  }
}

function deleteImageFile(msg) {
  if (!msg || msg.kind !== 'image' || typeof msg.imageUrl !== 'string') return;
  if (!msg.imageUrl.startsWith('/uploads/')) return;
  const file = path.join(UPLOADS_DIR, path.basename(msg.imageUrl));
  fs.unlink(file, () => {});
}

try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (err) {
  console.warn('Không tạo được thư mục uploads:', err.message);
}

// ---------------- Hàm hỗ trợ ----------------
function publicUsers() {
  return [...users.values()].map((u) => ({
    id: u.id,
    name: u.name,
    isOwner: u.isOwner,
    muted: u.muted,
  }));
}

function sendEvent(user, event, data) {
  if (!user.res || user.res.writableEnded) return;
  try {
    user.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    // Kết nối đã đứt, vòng dọn dẹp sẽ xử lý.
  }
}

function broadcast(event, data, exceptId) {
  for (const u of users.values()) {
    if (u.id !== exceptId) sendEvent(u, event, data);
  }
}

function broadcastUsers() {
  broadcast('users', { users: publicUsers() });
}

function trimHistory() {
  if (messages.length > STORE_LIMIT) {
    const removed = messages.splice(0, messages.length - STORE_LIMIT);
    removed.forEach(deleteImageFile);
  }
}

function systemMessage(text) {
  const msg = {
    id: crypto.randomUUID(),
    userId: null,
    name: 'Hệ thống',
    text,
    time: Date.now(),
    system: true,
    kind: 'text',
  };
  messages.push(msg);
  trimHistory();
  saveState();
  broadcast('message', { message: msg });
}

function getUserByToken(token) {
  if (typeof token !== 'string' || !token) return null;
  for (const u of users.values()) {
    if (u.token === token) return u;
  }
  return null;
}

// Tên hiển thị: 2–20 ký tự, chỉ gồm chữ (kể cả tiếng Việt có dấu), số,
// khoảng trắng, gạch dưới, gạch ngang, dấu chấm. Trả về tên đã chuẩn hóa
// hoặc null nếu không hợp lệ.
function validName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 20) return null;
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(name)) return null;
  if (BLOCKED_NAMES.includes(name.toLowerCase())) return null;
  return name;
}

function readJson(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error('too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (_) {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

// Kiểm tra nhanh "chữ ký" đầu file để chắc đây đúng là file ảnh,
// không phải file khác đội lốt ảnh.
function imageLooksValid(buf, ext) {
  if (ext === 'png') {
    return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  }
  if (ext === 'jpg') {
    return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (ext === 'gif') {
    return buf.length > 6 && buf.toString('ascii', 0, 6).startsWith('GIF8');
  }
  if (ext === 'webp') {
    return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

// ---------------- Phục vụ file tĩnh (giao diện) ----------------
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Không tìm thấy');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

// Phục vụ hình ảnh đã gửi. Tên file chỉ gồm chữ/số/gạch nối + đuôi ảnh
// nên không thể thoát ra ngoài thư mục uploads.
function serveUpload(req, res, pathname) {
  const filename = path.basename(pathname);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.(png|jpg|gif|webp)$/.test(filename)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Không tìm thấy');
  }
  const file = path.join(UPLOADS_DIR, filename);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Không tìm thấy');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)],
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

// ---------------- Xử lý API ----------------
async function handleJoin(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const name = validName(body.name);
  if (!name) {
    return json(res, 400, {
      error: 'Tên hiển thị phải dài 2–20 ký tự, chỉ gồm chữ, số, khoảng trắng, gạch dưới, gạch ngang, dấu chấm.',
    });
  }
  if (bannedNames.has(name.toLowerCase())) {
    return json(res, 403, { error: 'Tên này đã bị chủ phòng cấm.' });
  }
  for (const u of users.values()) {
    if (u.name.toLowerCase() === name.toLowerCase()) {
      return json(res, 409, { error: 'Tên này đang có người dùng, vui lòng chọn tên khác.' });
    }
  }
  const user = {
    id: crypto.randomUUID(),
    name,
    token: crypto.randomUUID(),
    isOwner: false,
    muted: false,
    lastSeen: Date.now(),
    lastMsgAt: 0,
    res: null,
  };
  users.set(user.id, user);
  systemMessage(`${name} đã vào phòng.`);
  broadcastUsers();
  json(res, 200, {
    token: user.token,
    userId: user.id,
    name: user.name,
    history: messages.slice(-JOIN_HISTORY),
    users: publicUsers(),
    locked,
    roomName: ROOM_NAME,
  });
}

function handleStream(req, res, url) {
  const user = getUserByToken(url.searchParams.get('token'));
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Phiên không hợp lệ');
  }
  // Nếu cùng một người mở kết nối mới thì đóng kết nối cũ.
  if (user.res && !user.res.writableEnded) {
    try {
      user.res.end();
    } catch (_) {}
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  user.res = res;
  user.lastSeen = Date.now();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    if (user.res === res) user.res = null;
    user.lastSeen = Date.now();
  });
}

// Kiểm tra chung trước khi một người gửi nội dung (chữ hoặc ảnh).
// Trả về user nếu được phép, ngược lại đã trả lỗi và trả về null.
function checkCanSend(user, res) {
  if (!user) {
    json(res, 401, { error: 'Phiên không hợp lệ, vui lòng vào lại phòng.' });
    return false;
  }
  user.lastSeen = Date.now();
  if (user.muted) {
    json(res, 403, { error: 'Bạn đang bị chủ phòng khóa chat.' });
    return false;
  }
  if (locked && !user.isOwner) {
    json(res, 403, { error: 'Phòng đang khóa, chỉ chủ phòng mới được nhắn.' });
    return false;
  }
  const now = Date.now();
  if (now - user.lastMsgAt < MIN_MSG_GAP_MS) {
    json(res, 429, { error: 'Bạn nhắn hơi nhanh, chờ một chút nhé.' });
    return false;
  }
  user.lastMsgAt = now;
  return true;
}

async function handleMessage(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const user = getUserByToken(body.token);
  if (!checkCanSend(user, res)) return;
  if (typeof body.text !== 'string') {
    return json(res, 400, { error: 'Tin nhắn không hợp lệ.' });
  }
  const text = body.text.trim();
  if (!text || text.length > MAX_TEXT) {
    return json(res, 400, { error: `Tin nhắn phải dài 1–${MAX_TEXT} ký tự.` });
  }
  const msg = {
    id: crypto.randomUUID(),
    userId: user.id,
    name: user.name,
    text,
    time: Date.now(),
    owner: user.isOwner,
    kind: 'text',
  };
  messages.push(msg);
  trimHistory();
  saveState();
  broadcast('message', { message: msg });
  json(res, 200, { ok: true, message: msg });
}

async function handleImage(req, res) {
  let body;
  try {
    // Base64 làm dữ liệu phình ~33% nên giới hạn đọc rộng hơn giới hạn ảnh.
    body = await readJson(req, Math.floor(MAX_IMAGE_BYTES * 1.5) + 65536);
  } catch (_) {
    return json(res, 413, { error: 'Dữ liệu gửi lên quá lớn.' });
  }
  const user = getUserByToken(body.token);
  if (!checkCanSend(user, res)) return;

  const match = typeof body.dataUrl === 'string'
    ? body.dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/)
    : null;
  if (!match) {
    return json(res, 400, { error: 'Ảnh không hợp lệ. Chỉ nhận ảnh PNG, JPEG, GIF, WEBP.' });
  }
  const ext = IMAGE_MIME_TO_EXT[match[1]];
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
    return json(res, 400, { error: `Ảnh phải nhỏ hơn ${MAX_IMAGE_MB} MB.` });
  }
  if (!imageLooksValid(buf, ext)) {
    return json(res, 400, { error: 'File gửi lên không phải là ảnh hợp lệ.' });
  }
  let existing = [];
  try {
    existing = fs.readdirSync(UPLOADS_DIR);
  } catch (_) {}
  if (existing.length >= MAX_UPLOAD_FILES) {
    return json(res, 429, { error: 'Kho ảnh đã đầy, chủ phòng xóa bớt ảnh cũ rồi gửi lại nhé.' });
  }
  const filename = `${crypto.randomUUID()}.${ext}`;
  try {
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  } catch (err) {
    return json(res, 500, { error: 'Không lưu được ảnh, vui lòng thử lại.' });
  }
  const caption = typeof body.caption === 'string' ? body.caption.trim().slice(0, MAX_CAPTION) : '';
  const msg = {
    id: crypto.randomUUID(),
    userId: user.id,
    name: user.name,
    text: caption,
    imageUrl: `/uploads/${filename}`,
    time: Date.now(),
    owner: user.isOwner,
    kind: 'image',
  };
  messages.push(msg);
  trimHistory();
  saveState();
  broadcast('message', { message: msg });
  json(res, 200, { ok: true, message: msg });
}

async function handlePing(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const user = getUserByToken(body.token);
  if (!user) return json(res, 401, { error: 'Phiên không hợp lệ.' });
  user.lastSeen = Date.now();
  json(res, 200, { ok: true, locked, muted: user.muted, isOwner: user.isOwner });
}

async function handleTyping(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const user = getUserByToken(body.token);
  if (!user) return json(res, 401, { error: 'Phiên không hợp lệ.' });
  user.lastSeen = Date.now();
  broadcast('typing', { name: user.name }, user.id);
  json(res, 200, { ok: true });
}

async function handleLeave(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const user = getUserByToken(body.token);
  if (!user) return json(res, 200, { ok: true });
  if (user.res && !user.res.writableEnded) {
    try {
      user.res.end();
    } catch (_) {}
  }
  users.delete(user.id);
  systemMessage(`${user.name} đã rời phòng.`);
  broadcastUsers();
  json(res, 200, { ok: true });
}

// --- Quyền chủ phòng ---
function requireOwner(body, res) {
  const user = getUserByToken(body.token);
  if (!user) {
    json(res, 401, { error: 'Phiên không hợp lệ.' });
    return null;
  }
  if (!user.isOwner) {
    json(res, 403, { error: 'Chỉ chủ phòng mới có quyền này.' });
    return null;
  }
  user.lastSeen = Date.now();
  return user;
}

async function handleOwnerLogin(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const user = getUserByToken(body.token);
  if (!user) return json(res, 401, { error: 'Phiên không hợp lệ.' });
  if (typeof body.password !== 'string' || body.password !== OWNER_PASSWORD) {
    return json(res, 403, { error: 'Mật khẩu chủ phòng không đúng.' });
  }
  user.isOwner = true;
  user.lastSeen = Date.now();
  broadcastUsers();
  json(res, 200, { ok: true });
}

async function handleOwnerDelete(req, res) {
  const body = await readJson(req).catch(() => ({}));
  if (!requireOwner(body, res)) return;
  const idx = messages.findIndex((m) => m.id === body.id);
  if (idx === -1) return json(res, 404, { error: 'Không tìm thấy tin nhắn.' });
  const [removed] = messages.splice(idx, 1);
  deleteImageFile(removed);
  saveState();
  broadcast('deleted', { id: body.id });
  json(res, 200, { ok: true });
}

function removeUser(target, notice) {
  sendEvent(target, 'kicked', { reason: notice });
  if (target.res && !target.res.writableEnded) {
    try {
      target.res.end();
    } catch (_) {}
  }
  target.res = null;
  users.delete(target.id);
  systemMessage(notice);
  broadcastUsers();
}

async function handleOwnerKick(req, res) {
  const body = await readJson(req).catch(() => ({}));
  if (!requireOwner(body, res)) return;
  const target = users.get(body.userId);
  if (!target) return json(res, 404, { error: 'Không tìm thấy người này.' });
  if (target.isOwner) return json(res, 403, { error: 'Không thể đuổi chủ phòng.' });
  removeUser(target, `${target.name} đã bị chủ phòng mời ra khỏi phòng.`);
  json(res, 200, { ok: true });
}

async function handleOwnerMute(req, res) {
  const body = await readJson(req).catch(() => ({}));
  if (!requireOwner(body, res)) return;
  const target = users.get(body.userId);
  if (!target) return json(res, 404, { error: 'Không tìm thấy người này.' });
  if (target.isOwner) return json(res, 403, { error: 'Không thể khóa chat chủ phòng.' });
  target.muted = body.muted !== false;
  sendEvent(target, 'muted', { muted: target.muted });
  systemMessage(
    target.muted
      ? `${target.name} đã bị chủ phòng khóa chat.`
      : `${target.name} đã được chủ phòng mở khóa chat.`
  );
  broadcastUsers();
  json(res, 200, { ok: true, muted: target.muted });
}

async function handleOwnerBan(req, res) {
  const body = await readJson(req).catch(() => ({}));
  if (!requireOwner(body, res)) return;
  const target = users.get(body.userId);
  if (!target) return json(res, 404, { error: 'Không tìm thấy người này.' });
  if (target.isOwner) return json(res, 403, { error: 'Không thể cấm chủ phòng.' });
  bannedNames.add(target.name.toLowerCase());
  removeUser(target, `${target.name} đã bị chủ phòng cấm vào phòng.`);
  json(res, 200, { ok: true });
}

async function handleOwnerUnban(req, res) {
  const body = await readJson(req).catch(() => ({}));
  if (!requireOwner(body, res)) return;
  if (typeof body.name !== 'string') return json(res, 400, { error: 'Tên không hợp lệ.' });
  bannedNames.delete(body.name.toLowerCase());
  saveState();
  json(res, 200, { ok: true, banned: [...bannedNames] });
}

async function handleOwnerBanned(req, res, url) {
  const user = getUserByToken(url.searchParams.get('token'));
  if (!user) return json(res, 401, { error: 'Phiên không hợp lệ.' });
  if (!user.isOwner) return json(res, 403, { error: 'Chỉ chủ phòng mới có quyền này.' });
  json(res, 200, { banned: [...bannedNames] });
}

async function handleOwnerLock(req, res) {
  const body = await readJson(req).catch(() => ({}));
  if (!requireOwner(body, res)) return;
  locked = body.locked !== false;
  broadcast('locked', { locked });
  systemMessage(locked ? 'Chủ phòng đã khóa phòng.' : 'Chủ phòng đã mở khóa phòng.');
  json(res, 200, { ok: true, locked });
}

async function handleOwnerClear(req, res) {
  const body = await readJson(req).catch(() => ({}));
  if (!requireOwner(body, res)) return;
  messages.forEach(deleteImageFile);
  messages = [];
  broadcast('cleared', {});
  systemMessage('Chủ phòng đã xóa toàn bộ lịch sử chat.');
  json(res, 200, { ok: true });
}

// ---------------- Định tuyến ----------------
loadState();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/config') {
    return json(res, 200, { roomName: ROOM_NAME, locked, maxText: MAX_TEXT, maxImageMB: MAX_IMAGE_MB });
  }
  if (req.method === 'POST' && pathname === '/api/join') return handleJoin(req, res);
  if (req.method === 'GET' && pathname === '/api/stream') return handleStream(req, res, url);
  if (req.method === 'POST' && pathname === '/api/ping') return handlePing(req, res);
  if (req.method === 'POST' && pathname === '/api/typing') return handleTyping(req, res);
  if (req.method === 'POST' && pathname === '/api/messages') return handleMessage(req, res);
  if (req.method === 'POST' && pathname === '/api/images') return handleImage(req, res);
  if (req.method === 'POST' && pathname === '/api/leave') return handleLeave(req, res);
  if (req.method === 'POST' && pathname === '/api/owner/login') return handleOwnerLogin(req, res);
  if (req.method === 'POST' && pathname === '/api/owner/delete') return handleOwnerDelete(req, res);
  if (req.method === 'POST' && pathname === '/api/owner/kick') return handleOwnerKick(req, res);
  if (req.method === 'POST' && pathname === '/api/owner/mute') return handleOwnerMute(req, res);
  if (req.method === 'POST' && pathname === '/api/owner/ban') return handleOwnerBan(req, res);
  if (req.method === 'POST' && pathname === '/api/owner/unban') return handleOwnerUnban(req, res);
  if (req.method === 'GET' && pathname === '/api/owner/banned') return handleOwnerBanned(req, res, url);
  if (req.method === 'POST' && pathname === '/api/owner/lock') return handleOwnerLock(req, res);
  if (req.method === 'POST' && pathname === '/api/owner/clear') return handleOwnerClear(req, res);
  if (req.method === 'GET' && pathname.startsWith('/uploads/')) return serveUpload(req, res, pathname);

  if (req.method === 'GET') return serveStatic(req, res, pathname);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Không tìm thấy');
});

// Dọn dẹp người mất kết nối (đóng tab, rớt mạng) mà không kịp báo rời phòng.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const u of [...users.values()]) {
    if (!u.res && now - u.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      users.delete(u.id);
      systemMessage(`${u.name} đã rời phòng.`);
      changed = true;
    }
  }
  if (changed) broadcastUsers();
}, 15000);

server.listen(PORT, () => {
  console.log(
    `Chat đang chạy tại http://localhost:${PORT} — phòng: ${ROOM_NAME} ` +
    `(đã tải ${messages.length} tin nhắn, ${bannedNames.size} tên bị cấm).`
  );
});
