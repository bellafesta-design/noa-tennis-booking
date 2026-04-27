#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'tennis-booking.db');

const PORT = Number(process.env.PORT || 8787);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const DEFAULT_YEAR = Number(process.env.BOOKING_YEAR || new Date().getFullYear());
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || '';

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
setupDatabase();
ensureYearSlots(DEFAULT_YEAR);

setInterval(() => {
  cleanExpiredSessions();
  cleanExpiredCancellationCodes();
}, 30 * 60 * 1000).unref();

const server = createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, parsedUrl);
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (error) {
    if (error?.apiStatus) {
      json(res, error.apiStatus, { error: error.message });
      return;
    }
    console.error('Unexpected server error:', error);
    json(res, 500, { error: 'Internal server error. Please try again.' });
  }
});

server.listen(PORT, () => {
  console.log(`NoA Tennis booking is running on http://localhost:${PORT}`);
  if (ADMIN_PASSWORD === 'change-me-now') {
    console.warn('Warning: set ADMIN_PASSWORD in environment variables before production.');
  }
});

function setupDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      date TEXT NOT NULL UNIQUE,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      court TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'booked', 'closed')),
      closed_reason TEXT,
      booked_email TEXT,
      booked_name TEXT,
      booked_agency TEXT,
      booked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cancellation_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_slots_year_date ON slots(year, date);
    CREATE INDEX IF NOT EXISTS idx_slots_booked_email ON slots(booked_email);
    CREATE INDEX IF NOT EXISTS idx_cancellation_codes_slot_email ON cancellation_codes(slot_id, email);
    CREATE INDEX IF NOT EXISTS idx_cancellation_codes_expires_at ON cancellation_codes(expires_at);
  `);
}

function ensureYearSlots(year) {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new Error(`Invalid year: ${year}`);
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO slots (
      year, date, start_time, end_time, court, status, created_at, updated_at
    ) VALUES (?, ?, '12:00', '13:00', '13', 'open', ?, ?)
  `);

  const now = nowIso();
  for (const date of getWednesdays(year)) {
    insertStmt.run(year, date, now, now);
  }
}

function getWednesdays(year) {
  const dates = [];
  const cursor = new Date(Date.UTC(year, 0, 1));
  while (cursor.getUTCFullYear() === year) {
    if (cursor.getUTCDay() === 3) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

async function handleApi(req, res, pathname, parsedUrl) {
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/api/public/years') {
    const years = getAvailableYears();
    return json(res, 200, { years });
  }

  if (method === 'GET' && pathname === '/api/public/slots') {
    const year = parseYear(parsedUrl.searchParams.get('year'));
    ensureYearSlots(year);
    const slots = listSlots(year, false);
    return json(res, 200, { year, slots });
  }

  if (method === 'POST' && pathname === '/api/public/book') {
    const body = await parseJsonBody(req);
    return handlePublicBook(req, res, body);
  }

  if (method === 'POST' && pathname === '/api/public/cancel/request-code') {
    const body = await parseJsonBody(req);
    return handlePublicCancelRequestCode(res, body);
  }

  if (method === 'POST' && pathname === '/api/public/cancel/confirm') {
    const body = await parseJsonBody(req);
    return handlePublicCancelConfirm(res, body);
  }

  if (method === 'POST' && pathname === '/api/admin/login') {
    const body = await parseJsonBody(req);
    return handleAdminLogin(res, body);
  }

  if (method === 'POST' && pathname === '/api/admin/logout') {
    return handleAdminLogout(req, res);
  }

  if (method === 'GET' && pathname === '/api/admin/me') {
    const admin = requireAdmin(req);
    return json(res, 200, { ok: true, admin: !!admin });
  }

  if (method === 'GET' && pathname === '/api/admin/slots') {
    requireAdmin(req);
    const year = parseYear(parsedUrl.searchParams.get('year'));
    ensureYearSlots(year);
    const slots = listSlots(year, true);
    return json(res, 200, { year, slots });
  }

  const closeMatch = pathname.match(/^\/api\/admin\/slots\/(\d+)\/close$/);
  if (method === 'POST' && closeMatch) {
    requireAdmin(req);
    const slotId = Number(closeMatch[1]);
    const body = await parseJsonBody(req);
    return handleAdminCloseSlot(res, slotId, body);
  }

  const clearMatch = pathname.match(/^\/api\/admin\/slots\/(\d+)\/clear-booking$/);
  if (method === 'POST' && clearMatch) {
    requireAdmin(req);
    const slotId = Number(clearMatch[1]);
    return handleAdminClearBooking(res, slotId);
  }

  return json(res, 404, { error: 'Endpoint not found.' });
}

function handlePublicBook(req, res, body) {
  const slotId = Number(body?.slotId);
  const email = normalizeEmail(body?.email);
  const name = toCleanString(body?.name, 80);
  const agency = toCleanString(body?.agency, 80);

  if (!Number.isInteger(slotId) || slotId <= 0) {
    return json(res, 400, { error: 'Invalid slot.' });
  }
  if (!email) {
    return json(res, 400, { error: 'Enter a valid email address.' });
  }
  if (!name) {
    return json(res, 400, { error: 'Enter your name.' });
  }

  try {
    const result = withTransaction(() => {
      const slot = db
        .prepare('SELECT * FROM slots WHERE id = ?')
        .get(slotId);

      if (!slot) {
        throw apiError(404, 'This slot does not exist.');
      }
      if (slotEndDate(slot.date, slot.end_time) <= new Date()) {
        throw apiError(409, 'The selected slot has already passed.');
      }
      if (slot.status === 'closed') {
        throw apiError(409, 'This day is closed for booking.');
      }
      if (slot.status === 'booked') {
        throw apiError(409, 'This slot is already booked.');
      }

      const activeBooking = getActiveBookingByEmail(email);
      if (activeBooking) {
        const dateText = formatDateEn(activeBooking.date);
        throw apiError(
          409,
          `You already have an active booking (${dateText}). You can book a new slot after that booking has passed.`
        );
      }

      const now = nowIso();
      db.prepare(`
        UPDATE slots
        SET status = 'booked',
            closed_reason = NULL,
            booked_email = ?,
            booked_name = ?,
            booked_agency = ?,
            booked_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(email, name, agency || null, now, now, slotId);
      db.prepare('DELETE FROM cancellation_codes WHERE slot_id = ?').run(slotId);

      return db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
    });

    return json(res, 200, {
      ok: true,
      slot: serializeSlot(result, false),
      message: 'Your booking has been saved.'
    });
  } catch (error) {
    if (error.apiStatus) {
      return json(res, error.apiStatus, { error: error.message });
    }
    console.error('Booking failed:', error);
    return json(res, 500, { error: 'Could not save booking.' });
  }
}

async function handlePublicCancelRequestCode(res, body) {
  const slotId = Number(body?.slotId);
  const email = normalizeEmail(body?.email);

  if (!Number.isInteger(slotId) || slotId <= 0) {
    return json(res, 400, { error: 'Invalid slot.' });
  }
  if (!email) {
    return json(res, 400, { error: 'Enter a valid email address.' });
  }

  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
  if (!slot) {
    return json(res, 404, { error: 'Slot not found.' });
  }
  if (slot.status !== 'booked') {
    return json(res, 409, { error: 'This slot is not booked.' });
  }
  if (slotEndDate(slot.date, slot.end_time) <= new Date()) {
    return json(res, 409, { error: 'This booking has already passed.' });
  }
  if (String(slot.booked_email || '').toLowerCase() !== email) {
    return json(res, 403, { error: 'This email does not match the booking for this slot.' });
  }

  const now = nowIso();
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  db.prepare(`
    DELETE FROM cancellation_codes
    WHERE slot_id = ? AND lower(email) = lower(?) AND used_at IS NULL
  `).run(slotId, email);

  db.prepare(`
    INSERT INTO cancellation_codes (
      slot_id, email, code, created_at, expires_at, used_at
    ) VALUES (?, ?, ?, ?, ?, NULL)
  `).run(slotId, email, code, now, expiresAt);

  const delivery = await sendCancellationCodeEmail(email, code, slot);
  if (delivery.sent) {
    return json(res, 200, {
      ok: true,
      message: 'Verification code sent to your email.'
    });
  }

  return json(res, 200, {
    ok: true,
    message: 'Verification code generated. Email delivery is not configured here, so the code is shown below.',
    devCode: code
  });
}

function handlePublicCancelConfirm(res, body) {
  const slotId = Number(body?.slotId);
  const email = normalizeEmail(body?.email);
  const code = String(body?.code || '').trim();

  if (!Number.isInteger(slotId) || slotId <= 0) {
    return json(res, 400, { error: 'Invalid slot.' });
  }
  if (!email) {
    return json(res, 400, { error: 'Enter a valid email address.' });
  }
  if (!/^\d{6}$/.test(code)) {
    return json(res, 400, { error: 'Enter the 6-digit verification code.' });
  }

  try {
    const updatedSlot = withTransaction(() => {
      const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
      if (!slot) {
        throw apiError(404, 'Slot not found.');
      }
      if (slot.status !== 'booked') {
        throw apiError(409, 'This slot is not booked.');
      }
      if (slotEndDate(slot.date, slot.end_time) <= new Date()) {
        throw apiError(409, 'This booking has already passed.');
      }
      if (String(slot.booked_email || '').toLowerCase() !== email) {
        throw apiError(403, 'This email does not match the booking for this slot.');
      }

      const verification = db.prepare(`
        SELECT *
        FROM cancellation_codes
        WHERE slot_id = ?
          AND lower(email) = lower(?)
          AND used_at IS NULL
          AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(slotId, email, nowIso());

      if (!verification) {
        throw apiError(409, 'No active verification code found. Request a new code.');
      }
      if (verification.code !== code) {
        throw apiError(409, 'Invalid verification code.');
      }

      const now = nowIso();
      db.prepare(`
        UPDATE slots
        SET status = 'open',
            booked_email = NULL,
            booked_name = NULL,
            booked_agency = NULL,
            booked_at = NULL,
            closed_reason = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(now, slotId);

      db.prepare('UPDATE cancellation_codes SET used_at = ? WHERE id = ?').run(now, verification.id);
      db.prepare('DELETE FROM cancellation_codes WHERE slot_id = ?').run(slotId);

      return db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
    });

    return json(res, 200, {
      ok: true,
      slot: serializeSlot(updatedSlot, false),
      message: 'Your booking has been canceled.'
    });
  } catch (error) {
    if (error.apiStatus) {
      return json(res, error.apiStatus, { error: error.message });
    }
    console.error('Cancel confirmation failed:', error);
    return json(res, 500, { error: 'Could not cancel booking.' });
  }
}

function handleAdminLogin(res, body) {
  const password = String(body?.password || '');

  if (password !== ADMIN_PASSWORD) {
    return json(res, 401, { error: 'Incorrect admin password.' });
  }

  const token = randomBytes(24).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  db.prepare('INSERT INTO sessions(token, created_at, expires_at) VALUES (?, ?, ?)')
    .run(token, now.toISOString(), expires.toISOString());

  setCookie(res, 'session_token', token, {
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: 12 * 60 * 60,
    path: '/'
  });

  return json(res, 200, { ok: true });
}

function handleAdminLogout(req, res) {
  const token = getSessionToken(req);
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  setCookie(res, 'session_token', '', {
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: 0,
    path: '/'
  });

  return json(res, 200, { ok: true });
}

function handleAdminCloseSlot(res, slotId, body) {
  const closed = Boolean(body?.closed);
  const reason = toCleanString(body?.reason, 200);

  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
  if (!slot) {
    return json(res, 404, { error: 'Slot not found.' });
  }

  const now = nowIso();

  if (closed) {
    db.prepare(`
      UPDATE slots
      SET status = 'closed',
          closed_reason = ?,
          booked_email = NULL,
          booked_name = NULL,
          booked_agency = NULL,
          booked_at = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(reason || 'Closed by admin', now, slotId);
    db.prepare('DELETE FROM cancellation_codes WHERE slot_id = ?').run(slotId);
  } else {
    if (slot.status !== 'closed') {
      return json(res, 409, { error: 'This slot is not closed.' });
    }

    db.prepare(`
      UPDATE slots
      SET status = 'open',
          closed_reason = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(now, slotId);
  }

  const updated = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
  return json(res, 200, { ok: true, slot: serializeSlot(updated, true) });
}

function handleAdminClearBooking(res, slotId) {
  const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
  if (!slot) {
    return json(res, 404, { error: 'Slot not found.' });
  }

  if (slot.status !== 'booked') {
    return json(res, 409, { error: 'No booking exists to remove.' });
  }

  const now = nowIso();
  db.prepare(`
    UPDATE slots
    SET status = 'open',
        booked_email = NULL,
        booked_name = NULL,
        booked_agency = NULL,
        booked_at = NULL,
        closed_reason = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(now, slotId);
  db.prepare('DELETE FROM cancellation_codes WHERE slot_id = ?').run(slotId);

  const updated = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
  return json(res, 200, { ok: true, slot: serializeSlot(updated, true) });
}

function getAvailableYears() {
  const rows = db.prepare('SELECT DISTINCT year FROM slots ORDER BY year').all();
  if (rows.length === 0) {
    return [DEFAULT_YEAR];
  }
  return rows.map((row) => row.year);
}

function listSlots(year, includePrivate) {
  const rows = db
    .prepare('SELECT * FROM slots WHERE year = ? ORDER BY date ASC')
    .all(year);

  return rows.map((slot) => serializeSlot(slot, includePrivate));
}

function serializeSlot(slot, includePrivate) {
  const serialized = {
    id: slot.id,
    year: slot.year,
    date: slot.date,
    weekday: new Date(`${slot.date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long' }),
    startTime: slot.start_time,
    endTime: slot.end_time,
    court: slot.court,
    status: slot.status,
    closedReason: slot.closed_reason,
    bookedName: slot.booked_name,
    bookedAgency: slot.booked_agency
  };

  if (includePrivate) {
    serialized.bookedEmail = slot.booked_email;
    serialized.bookedAt = slot.booked_at;
  }

  return serialized;
}

function getActiveBookingByEmail(email) {
  const now = new Date();
  const rows = db.prepare(`
    SELECT id, date, end_time
    FROM slots
    WHERE status = 'booked'
      AND lower(booked_email) = lower(?)
      AND date >= date('now', 'localtime', '-1 day')
    ORDER BY date ASC
  `).all(email);

  return rows.find((row) => slotEndDate(row.date, row.end_time) > now) || null;
}

function slotEndDate(dateString, endTime) {
  const [hour, minute] = endTime.split(':').map((x) => Number(x));
  const dt = new Date(`${dateString}T00:00:00`);
  dt.setHours(hour, minute, 0, 0);
  return dt;
}

function requireAdmin(req) {
  const token = getSessionToken(req);
  if (!token) {
    throw apiError(401, 'You must be logged in as admin.');
  }

  const row = db
    .prepare('SELECT token, expires_at FROM sessions WHERE token = ?')
    .get(token);

  if (!row) {
    throw apiError(401, 'Session not found. Please log in again.');
  }

  if (new Date(row.expires_at) <= new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    throw apiError(401, 'Session expired. Please log in again.');
  }

  return true;
}

function cleanExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
}

function cleanExpiredCancellationCodes() {
  db.prepare('DELETE FROM cancellation_codes WHERE used_at IS NULL AND expires_at <= ?').run(nowIso());
}

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((cookie) => {
        const idx = cookie.indexOf('=');
        if (idx === -1) {
          return [cookie, ''];
        }
        return [cookie.slice(0, idx), decodeURIComponent(cookie.slice(idx + 1))];
      })
  );

  return cookies.session_token || null;
}

function parseYear(raw) {
  const year = Number(raw || DEFAULT_YEAR);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw apiError(400, 'Invalid year.');
  }
  return year;
}

async function parseJsonBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1024 * 1024) {
      throw apiError(413, 'Payload too large.');
    }
  }

  if (!data) {
    return {};
  }

  try {
    return JSON.parse(data);
  } catch {
    throw apiError(400, 'Invalid JSON.');
  }
}

async function serveStatic(req, res, pathname) {
  const decodedPath = decodeURIComponent(pathname);
  const normalizedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const safePath = path
    .normalize(normalizedPath)
    .replace(/^([.][.][/\\])+/, '')
    .replace(/^[/\\]+/, '');
  const fullPath = path.join(PUBLIC_DIR, safePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    json(res, 403, { error: 'Forbidden file path.' });
    return;
  }

  try {
    const file = await readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = mimeType(ext);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    });
    res.end(file);
  } catch {
    if (pathname !== '/') {
      return serveStatic(req, res, '/');
    }
    json(res, 404, { error: 'Page not found.' });
  }
}

function mimeType(ext) {
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    default:
      return 'text/plain; charset=utf-8';
  }
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function withTransaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function setCookie(res, name, value, options) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  res.setHeader('Set-Cookie', parts.join('; '));
}

function nowIso() {
  return new Date().toISOString();
}

function generateVerificationCode() {
  return String(randomInt(100000, 1000000));
}

async function sendCancellationCodeEmail(email, code, slot) {
  const text = [
    `Your NoA Tennis cancellation code is ${code}.`,
    'The code expires in 10 minutes.',
    '',
    `Booking: ${formatDateEn(slot.date)}, ${slot.start_time}-${slot.end_time}, Court ${slot.court}.`
  ].join('\n');

  if (RESEND_API_KEY && RESEND_FROM_EMAIL) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: [email],
          subject: 'Your NoA Tennis cancellation code',
          text
        })
      });

      if (!response.ok) {
        const body = await response.text();
        console.error('Resend email error:', body);
      } else {
        return { sent: true };
      }
    } catch (error) {
      console.error('Failed to send cancellation code email:', error);
    }
  }

  console.log(`[DEV cancellation code] email=${email} code=${code} slot=${slot.date}`);
  return { sent: false, devCode: code };
}

function apiError(status, message) {
  const err = new Error(message);
  err.apiStatus = status;
  return err;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) {
    return '';
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) ? email : '';
}

function toCleanString(value, maxLength) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  return text.slice(0, maxLength);
}

function formatDateEn(dateString) {
  return new Date(`${dateString}T00:00:00`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
