'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const BOOKINGS_FILE = path.join(DATA_DIR, 'appointments.json');
const SLOT_BLOCKS_FILE = path.join(DATA_DIR, 'slot-blocks.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'GV@2026!';
const DATABASE_URL = process.env.DATABASE_URL || '';
let dbPool = null;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const SERVICES = [
  { id: 'corte', name: 'Corte', priceLabel: 'consultar valor' },
  { id: 'corte-feminino', name: 'Corte feminino', priceLabel: 'consultar valor' },
  { id: 'corte-masculino', name: 'Corte masculino', priceLabel: 'consultar valor' },
  { id: 'progressiva', name: 'Progressiva', priceLabel: 'consultar valor' },
  { id: 'sobrancelhas', name: 'Sobrancelhas', priceLabel: 'consultar valor' },
  { id: 'coloracao', name: 'Coloração', priceLabel: 'consultar valor' }
];
const TIME_SLOTS = ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'];
const sessions = new Map();
const loginFailures = new Map();
let writeQueue = Promise.resolve();

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BOOKINGS_FILE)) fs.writeFileSync(BOOKINGS_FILE, '[]\n', 'utf8');
if (!fs.existsSync(SLOT_BLOCKS_FILE)) fs.writeFileSync(SLOT_BLOCKS_FILE, '[]\n', 'utf8');

function json(res, status, data, extraHeaders = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    ...extraHeaders
  });
  res.end(payload);
}

function parseCookies(req) {
  const result = {};
  for (const item of (req.headers.cookie || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator > -1) result[item.slice(0, separator).trim()] = decodeURIComponent(item.slice(separator + 1).trim());
  }
  return result;
}

function getSession(req) {
  const token = parseCookies(req).gv_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function requireAdmin(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: 'Entre com seu usuário de administrador para continuar.' });
    return null;
  }
  return session;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Não foi possível ler ${path.basename(file)}:`, error.message);
    return fallback;
  }
}

async function writeBookings(bookings) {
  const temp = `${BOOKINGS_FILE}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(bookings, null, 2) + '\n', 'utf8');
  await fs.promises.rename(temp, BOOKINGS_FILE);
}

async function getBookings() {
  if (!dbPool) return readJson(BOOKINGS_FILE, []);
  const result = await dbPool.query(`
    SELECT id, name, phone, service_id AS service, service_name AS "serviceName",
           booking_date AS date, booking_time AS time, notes, status, tracking_code AS "trackingCode",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM gv_bookings ORDER BY booking_date, booking_time
  `);
  return result.rows.map(row => ({
    ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : (row.updatedAt || undefined)
  }));
}

async function getSlotBlocks() {
  if (!dbPool) return readJson(SLOT_BLOCKS_FILE, []);
  const result = await dbPool.query('SELECT booking_date AS date, booking_time AS time, blocked FROM gv_slot_blocks');
  return result.rows;
}

async function setSlotBlock(date, time, blocked) {
  if (!dbPool) {
    const blocks = readJson(SLOT_BLOCKS_FILE, []).filter(item => !(item.date === date && item.time === time));
    if (blocked) blocks.push({ date, time, blocked: true, updatedAt: new Date().toISOString() });
    const temp = `${SLOT_BLOCKS_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(blocks, null, 2) + '\n', 'utf8');
    await fs.promises.rename(temp, SLOT_BLOCKS_FILE);
    return;
  }
  if (blocked) {
    await dbPool.query(`INSERT INTO gv_slot_blocks (booking_date, booking_time, blocked, updated_at) VALUES ($1, $2, TRUE, NOW()) ON CONFLICT (booking_date, booking_time) DO UPDATE SET blocked = TRUE, updated_at = NOW()`, [date, time]);
  } else {
    await dbPool.query('DELETE FROM gv_slot_blocks WHERE booking_date = $1 AND booking_time = $2', [date, time]);
  }
}

function normalizePhone(value) { return String(value || '').replace(/\D/g, ''); }

async function storeNewBooking(booking, currentBookings) {
  if (!dbPool) {
    currentBookings.push(booking);
    await writeBookings(currentBookings);
    return;
  }
  try {
    await dbPool.query(`
      INSERT INTO gv_bookings (id, name, phone, service_id, service_name, booking_date, booking_time, notes, status, tracking_code, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [booking.id, booking.name, booking.phone, booking.service, booking.serviceName, booking.date, booking.time, booking.notes, booking.status, booking.trackingCode, booking.createdAt]);
  } catch (error) {
    if (error && error.code === '23505') {
      error.status = 409;
      error.message = 'Esse horário acabou de ficar indisponível. Escolha outro horário.';
    }
    throw error;
  }
}

async function persistBookingChanges(bookings, changedBooking) {
  if (!dbPool) {
    await writeBookings(bookings);
    return;
  }
  try {
    await dbPool.query('UPDATE gv_bookings SET status = $2, updated_at = $3 WHERE id = $1', [changedBooking.id, changedBooking.status, changedBooking.updatedAt]);
  } catch (error) {
    if (error && error.code === '23505') {
      error.status = 409;
      error.message = 'Já existe outro agendamento confirmado nesse horário.';
    }
    throw error;
  }
}

async function initializeStorage() {
  if (process.env.RENDER === 'true' && !DATABASE_URL) {
    throw new Error('Configure DATABASE_URL com o endereço do PostgreSQL antes de publicar o site.');
  }
  if (process.env.RENDER === 'true' && !process.env.ADMIN_PASSWORD) {
    throw new Error('Configure uma ADMIN_PASSWORD forte no painel da hospedagem antes de publicar.');
  }
  if (!DATABASE_URL) return;
  const { Pool } = require('pg');
  const options = { connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 30000 };
  if (process.env.DATABASE_SSL !== 'disable') options.ssl = { rejectUnauthorized: false };
  dbPool = new Pool(options);
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS gv_bookings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      service_id TEXT NOT NULL,
      service_name TEXT NOT NULL,
      booking_date TEXT NOT NULL,
      booking_time TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled')),
      tracking_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    )
  `);
  await dbPool.query(`ALTER TABLE gv_bookings ADD COLUMN IF NOT EXISTS tracking_code TEXT`);
  await dbPool.query(`ALTER TABLE gv_bookings DROP CONSTRAINT IF EXISTS gv_bookings_status_check`);
  await dbPool.query(`ALTER TABLE gv_bookings ADD CONSTRAINT gv_bookings_status_check CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled'))`);
  await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS gv_booking_tracking_code_unique ON gv_bookings (tracking_code) WHERE tracking_code IS NOT NULL`);
  await dbPool.query(`DROP INDEX IF EXISTS gv_one_confirmed_booking_per_slot`);
  await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS gv_one_confirmed_booking_per_slot ON gv_bookings (booking_date, booking_time) WHERE status IN ('pending', 'confirmed')`);
  await dbPool.query(`CREATE TABLE IF NOT EXISTS gv_slot_blocks (booking_date TEXT NOT NULL, booking_time TEXT NOT NULL, blocked BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (booking_date, booking_time))`);
  console.log('  Armazenamento: PostgreSQL remoto (agendamentos persistentes e horários bloqueados)');
}

function serialized(operation) {
  const next = writeQueue.then(operation, operation);
  writeQueue = next.then(() => undefined, () => undefined);
  return next;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 100 * 1024) {
        reject(new Error('A solicitação ficou muito grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const content = Buffer.concat(chunks).toString('utf8');
        resolve(content ? JSON.parse(content) : {});
      } catch {
        reject(new Error('O corpo da solicitação não é um JSON válido.'));
      }
    });
    req.on('error', reject);
  });
}

function localToday() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function slotIsInPast(date, time) {
  if (date !== localToday()) return date < localToday();
  const [hours, minutes] = time.split(':').map(Number);
  const now = new Date();
  return hours < now.getHours() || (hours === now.getHours() && minutes <= now.getMinutes());
}

function availabilityFor(date, bookings, blocks = []) {
  const occupied = new Map(bookings.filter(booking => booking.date === date && ['pending', 'confirmed'].includes(booking.status)).map(booking => [booking.time, booking.status]));
  const blocked = new Set(blocks.filter(block => block.date === date && block.blocked).map(block => block.time));
  return TIME_SLOTS.map(time => {
    const passed = slotIsInPast(date, time);
    const bookingStatus = occupied.get(time);
    const manuallyBlocked = blocked.has(time);
    const reason = passed ? 'passado' : bookingStatus === 'confirmed' ? 'reservado' : bookingStatus === 'pending' ? 'aguardando-aprovacao' : manuallyBlocked ? 'bloqueado' : null;
    return { time, available: !passed && !bookingStatus && !manuallyBlocked, reason, manuallyBlocked };
  });
}

function isValidSlot(time) {
  return typeof time === 'string' && TIME_SLOTS.includes(time);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, maxLength);
}

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
  })[ext] || 'application/octet-stream';
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, storage: dbPool ? 'postgres' : 'local-file' });
  }

  if (req.method === 'GET' && pathname === '/api/services') {
    return json(res, 200, { services: SERVICES });
  }

  if (req.method === 'GET' && pathname === '/api/availability') {
    const date = searchParams.get('date') || localToday();
    if (!validDate(date)) return json(res, 400, { error: 'Informe uma data válida.' });
    if (date < localToday()) return json(res, 200, { date, slots: TIME_SLOTS.map(time => ({ time, available: false, reason: 'passado' })) });
    const [bookings, blocks] = await Promise.all([getBookings(), getSlotBlocks()]);
    return json(res, 200, { date, slots: availabilityFor(date, bookings, blocks) });
  }

  if (req.method === 'POST' && pathname === '/api/bookings') {
    let body;
    try { body = await readBody(req); } catch (error) { return json(res, 400, { error: error.message }); }
    const name = cleanText(body.name, 100);
    const phone = cleanText(body.phone, 32);
    const serviceId = cleanText(body.service, 40);
    const date = cleanText(body.date, 10);
    const time = cleanText(body.time, 5);
    const notes = cleanText(body.notes, 250);
    const service = SERVICES.find(item => item.id === serviceId);
    if (name.length < 2) return json(res, 400, { error: 'Digite seu nome completo.' });
    if (phone.replace(/\D/g, '').length < 8) return json(res, 400, { error: 'Informe um número de WhatsApp válido.' });
    if (!service) return json(res, 400, { error: 'Selecione um serviço válido.' });
    if (!validDate(date) || date < localToday()) return json(res, 400, { error: 'Escolha uma data de hoje em diante.' });
    if (!isValidSlot(time)) return json(res, 400, { error: 'Selecione um horário válido.' });

    try {
      const booking = await serialized(async () => {
        const [bookings, blocks] = await Promise.all([getBookings(), getSlotBlocks()]);
        const slot = availabilityFor(date, bookings, blocks).find(item => item.time === time);
        if (!slot || !slot.available) {
          const error = new Error('Esse horário está indisponível ou aguarda aprovação de outro pedido. Escolha outro horário.');
          error.status = 409;
          throw error;
        }
        const trackingCode = crypto.randomBytes(4).toString('hex').toUpperCase();
        const created = {
          id: crypto.randomUUID(),
          name,
          phone,
          service: service.id,
          serviceName: service.name,
          date,
          time,
          notes,
          status: 'pending',
          trackingCode,
          createdAt: new Date().toISOString()
        };
        await storeNewBooking(created, bookings);
        return created;
      });
      return json(res, 201, { message: 'Pedido enviado para aprovação.', booking: { id: booking.id, serviceName: booking.serviceName, date: booking.date, time: booking.time, status: booking.status, trackingCode: booking.trackingCode } });
    } catch (error) {
      return json(res, error.status || 500, { error: error.status ? error.message : 'Não foi possível salvar o agendamento. Tente novamente.' });
    }
  }

  if (req.method === 'GET' && pathname === '/api/client/booking') {
    const phone = normalizePhone(searchParams.get('phone'));
    const code = cleanText(searchParams.get('code'), 12).toUpperCase();
    if (phone.length < 8 || !/^[A-F0-9]{8}$/.test(code)) {
      return json(res, 400, { error: 'Informe o WhatsApp e o código de acompanhamento recebidos ao solicitar o horário.' });
    }
    const bookings = await getBookings();
    const booking = bookings.find(item => normalizePhone(item.phone) === phone && String(item.trackingCode || '').toUpperCase() === code);
    if (!booking) return json(res, 404, { error: 'Não encontramos um pedido com esses dados. Confira o WhatsApp e o código.' });
    return json(res, 200, { booking: { name: booking.name, serviceName: booking.serviceName, date: booking.date, time: booking.time, status: booking.status, notes: booking.notes || '', createdAt: booking.createdAt, updatedAt: booking.updatedAt } });
  }

  if (req.method === 'GET' && pathname === '/api/admin/session') {
    const session = getSession(req);
    return json(res, 200, { authenticated: Boolean(session), username: session ? session.username : null });
  }

  if (req.method === 'POST' && pathname === '/api/admin/login') {
    const ip = req.socket.remoteAddress || 'local';
    const now = Date.now();
    const attempts = (loginFailures.get(ip) || []).filter(time => now - time < 15 * 60 * 1000);
    if (attempts.length >= 8) return json(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
    let body;
    try { body = await readBody(req); } catch (error) { return json(res, 400, { error: error.message }); }
    const username = cleanText(body.username, 100);
    const password = String(body.password || '');
    if (!safeEqual(username, ADMIN_USER) || !safeEqual(password, ADMIN_PASSWORD)) {
      attempts.push(now);
      loginFailures.set(ip, attempts);
      return json(res, 401, { error: 'Usuário ou senha incorretos.' });
    }
    loginFailures.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username: ADMIN_USER, expiresAt: now + SESSION_TTL_MS });
    const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return json(res, 200, { authenticated: true, username: ADMIN_USER }, {
      'Set-Cookie': `gv_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secureCookie}`
    });
  }

  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    const token = parseCookies(req).gv_session;
    if (token) sessions.delete(token);
    return json(res, 200, { authenticated: false }, {
      'Set-Cookie': `gv_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/bookings') {
    if (!requireAdmin(req, res)) return;
    const bookings = (await getBookings()).slice().sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)).map(({ trackingCode, ...booking }) => booking);
    return json(res, 200, { bookings });
  }

  if (req.method === 'GET' && pathname === '/api/admin/availability') {
    if (!requireAdmin(req, res)) return;
    const date = searchParams.get('date') || localToday();
    if (!validDate(date)) return json(res, 400, { error: 'Informe uma data válida.' });
    const [bookings, blocks] = await Promise.all([getBookings(), getSlotBlocks()]);
    return json(res, 200, { date, slots: availabilityFor(date, bookings, blocks) });
  }

  if (req.method === 'PATCH' && pathname === '/api/admin/slots') {
    if (!requireAdmin(req, res)) return;
    let body;
    try { body = await readBody(req); } catch (error) { return json(res, 400, { error: error.message }); }
    const date = cleanText(body.date, 10);
    const time = cleanText(body.time, 5);
    const blocked = body.blocked === true;
    if (!validDate(date) || date < localToday() || !isValidSlot(time)) return json(res, 400, { error: 'Escolha uma data futura ou de hoje e um horário válido.' });
    try {
      await serialized(async () => setSlotBlock(date, time, blocked));
      const [bookings, blocks] = await Promise.all([getBookings(), getSlotBlocks()]);
      return json(res, 200, { date, slots: availabilityFor(date, bookings, blocks), message: blocked ? 'Horário marcado como indisponível.' : 'Bloqueio manual removido.' });
    } catch (error) {
      return json(res, 500, { error: 'Não foi possível atualizar a disponibilidade.' });
    }
  }

  const bookingMatch = pathname.match(/^\/api\/admin\/bookings\/([a-f0-9-]+)$/i);
  if (bookingMatch && req.method === 'PATCH') {
    if (!requireAdmin(req, res)) return;
    let body;
    try { body = await readBody(req); } catch (error) { return json(res, 400, { error: error.message }); }
    const status = body.status;
    if (!['pending', 'confirmed', 'rejected', 'cancelled'].includes(status)) return json(res, 400, { error: 'Status inválido.' });
    try {
      const result = await serialized(async () => {
        const bookings = await getBookings();
        const index = bookings.findIndex(item => item.id === bookingMatch[1]);
        if (index < 0) {
          const error = new Error('Agendamento não encontrado.'); error.status = 404; throw error;
        }
        const item = bookings[index];
        if (['pending', 'confirmed'].includes(status)) {
          const conflict = bookings.some(other => other.id !== item.id && other.date === item.date && other.time === item.time && ['pending', 'confirmed'].includes(other.status));
          if (conflict) { const error = new Error('Já existe outro pedido pendente ou confirmado nesse horário.'); error.status = 409; throw error; }
          if (slotIsInPast(item.date, item.time)) { const error = new Error('Não é possível aprovar um horário que já passou.'); error.status = 409; throw error; }
          const blocks = await getSlotBlocks();
          if (blocks.some(block => block.date === item.date && block.time === item.time && block.blocked)) { const error = new Error('Esse horário está bloqueado manualmente. Remova o bloqueio antes de aprovar.'); error.status = 409; throw error; }
        }
        item.status = status;
        item.updatedAt = new Date().toISOString();
        await persistBookingChanges(bookings, item);
        return item;
      });
      return json(res, 200, { booking: result });
    } catch (error) {
      return json(res, error.status || 500, { error: error.status ? error.message : 'Não foi possível atualizar o agendamento.' });
    }
  }

  return json(res, 404, { error: 'Rota da API não encontrada.' });
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('Método não permitido.');
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Caminho inválido.'); }
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  if (pathname === '/cliente' || pathname === '/cliente/') pathname = '/cliente.html';
  if (pathname === '/sobre-nos' || pathname === '/sobre-nos/') pathname = '/sobre-nos.html';
  if (pathname === '/galeria' || pathname === '/galeria/') pathname = '/galeria.html';
  const file = path.resolve(PUBLIC, `.${pathname}`);
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    res.writeHead(403); return res.end('Acesso negado.');
  }
  let stat;
  try { stat = await fs.promises.stat(file); } catch { res.writeHead(404); return res.end('Arquivo não encontrado.'); }
  if (!stat.isFile()) { res.writeHead(404); return res.end('Arquivo não encontrado.'); }
  res.writeHead(200, {
    'Content-Type': mimeType(file),
    'Content-Length': stat.size,
    'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { res.writeHead(400); return res.end('Solicitação inválida.'); }
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (error) {
    console.error('Erro no servidor:', error);
    if (!res.headersSent) json(res, 500, { error: 'Erro interno do servidor.' });
    else res.end();
  }
});

initializeStorage().then(() => {
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('==========================================');
    console.log('  GEOVANE VIANA — SALÃO DE BELEZA');
    console.log(`  Site:       http://${HOST}:${PORT}`);
    console.log(`  Admin:      http://${HOST}:${PORT}/admin`);
    console.log(`  Usuário:    ${ADMIN_USER}`);
    console.log(`  Senha:      ${process.env.ADMIN_PASSWORD ? '(definida por variável de ambiente)' : 'GV@2026!'}`);
    if (!dbPool) console.log('  Dados:      data/appointments.json (local)');
    console.log('==========================================');
    console.log('');
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.warn('Aviso: o servidor está ouvindo na rede. Use senha forte antes de expor o projeto à internet.');
  });
}).catch(error => {
  console.error('Falha ao inicializar o banco de dados:', error.message);
  process.exit(1);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
