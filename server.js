'use strict';

/**
 * Planning Events — plateforme d'invitations digitales interactives.
 * Serveur Express : API + pages statiques.
 */

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const QRCode = require('qrcode');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const ADMIN_CODE = process.env.ADMIN_CODE || 'PLANNING2026';
const SHOW_DEMO_CODE = !process.env.ADMIN_CODE;
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE = 'pe_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const THEMES = ['rouge', 'or', 'nuit', 'emeraude'];

/* ------------------------------------------------------------------ */
/* Stockage JSON (écriture atomique, sérialisée)                       */
/* ------------------------------------------------------------------ */

let db;
let writeChain = Promise.resolve();

const uid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const token = () => crypto.randomBytes(6).toString('hex').toUpperCase();

function seedDb() {
  const eventId = 'evt_demo';
  const guestsSeed = [
    ['Pasteur Daniel Mbala', '+243 821 000 111', 2, 'confirmed'],
    ['Famille Tshibangu', '+243 822 000 222', 4, 'confirmed'],
    ['Sarah Ilunga', '+243 823 000 333', 1, 'invited'],
    ['Jean-Paul Kasongo', '+243 824 000 444', 2, 'declined'],
    ['Mireille Ngoy', '+243 825 000 555', 2, 'invited'],
  ];

  const guests = guestsSeed.map(([name, phone, seats, status]) => ({
    id: uid('gst'),
    eventId,
    name,
    phone,
    email: '',
    seats,
    status,
    token: token(),
    checkedInAt: null,
    note: '',
    createdAt: new Date().toISOString(),
  }));

  return {
    events: [
      {
        id: eventId,
        code: 'DEMO2026',
        title: 'Mariage de Bénédicte & Claire',
        hosts: 'Bénédicte NGOYA & Claire KABEY',
        startsAt: '2026-12-19T16:00:00+01:00',
        timeZone: 'Africa/Kinshasa',
        venue: 'Salle des Fêtes La Gombe',
        address: '183 Avenue Dodoma, Gombe, Kinshasa',
        mapUrl: 'https://maps.google.com/?q=Avenue+Dodoma+Gombe+Kinshasa',
        dressCode: 'Tenue de soirée — rouge, noir et or',
        intro:
          'C’est avec une immense joie que nous vous convions à célébrer notre union. Votre présence sera notre plus beau cadeau.',
        theme: 'rouge',
        program: [
          { time: '16h00', label: 'Accueil des invités & cocktail' },
          { time: '17h00', label: 'Cérémonie civile' },
          { time: '18h30', label: 'Dîner de gala' },
          { time: '20h00', label: 'Première danse & soirée' },
        ],
        rsvpDeadline: '2026-12-05',
        active: true,
        createdAt: new Date().toISOString(),
      },
    ],
    guests,
    guestbook: [
      {
        id: uid('msg'),
        eventId,
        name: 'Famille Tshibangu',
        message:
          'Que Dieu bénisse votre union. Nous serons là pour partager ce grand moment !',
        approved: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: uid('msg'),
        eventId,
        name: 'Sarah Ilunga',
        message: 'Félicitations aux tourtereaux, hâte de vous voir briller.',
        approved: true,
        createdAt: new Date().toISOString(),
      },
    ],
    messages: [
      {
        id: uid('ctc'),
        name: 'Grace Mbuyi',
        phone: '+243 899 111 222',
        eventType: 'Anniversaire',
        message:
          'Bonjour, je souhaite une invitation digitale pour un anniversaire de 40 ans en janvier.',
        read: false,
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    db = seedDb();
  }
  db.events ||= [];
  db.guests ||= [];
  db.guestbook ||= [];
  db.messages ||= [];
  persist();
  return db;
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeChain = writeChain
    .then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DB_FILE}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot, 'utf8');
      await fsp.rename(tmp, DB_FILE);
    })
    .catch((err) => console.error('[db] écriture impossible:', err.message));
  return writeChain;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function signature(payload) {
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');
}

function createSession() {
  const payload = b64(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS }));
  return `${payload}.${signature(payload)}`;
}

function verifySession(value) {
  if (!value || typeof value !== 'string' || !value.includes('.')) return false;
  const [payload, sig] = value.split('.');
  const expected = signature(payload);
  if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return false;
  }
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function isLogged(req) {
  return verifySession(readCookie(req, SESSION_COOKIE));
}

function requireAuthApi(req, res, next) {
  if (!isLogged(req)) {
    return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
  }
  next();
}

function requireAuthPage(req, res, next) {
  if (!isLogged(req)) return res.redirect('/login');
  next();
}

/* ------------------------------------------------------------------ */
/* Limitation de débit (endpoints publics d'écriture)                  */
/* ------------------------------------------------------------------ */

const buckets = new Map();

function rateLimit({ max = 12, windowMs = 10 * 60 * 1000 } = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${req.method}:${req.baseUrl}${req.path}:${ip}`;
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      return res
        .status(429)
        .json({ error: 'Trop de demandes. Merci de réessayer dans quelques minutes.' });
    }
    hits.push(now);
    buckets.set(key, hits);
    if (buckets.size > 5000) buckets.clear();
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Helpers métier                                                      */
/* ------------------------------------------------------------------ */

const normalize = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const clean = (value, max = 400) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function publicBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

function eventStats(eventId) {
  const guests = db.guests.filter((g) => g.eventId === eventId);
  return {
    guests: guests.length,
    seats: guests.reduce((sum, g) => sum + (Number(g.seats) || 1), 0),
    confirmed: guests.filter((g) => g.status === 'confirmed').length,
    declined: guests.filter((g) => g.status === 'declined').length,
    pending: guests.filter((g) => g.status === 'invited').length,
    checkedIn: guests.filter((g) => g.checkedInAt).length,
    confirmedSeats: guests
      .filter((g) => g.status === 'confirmed')
      .reduce((sum, g) => sum + (Number(g.seats) || 1), 0),
  };
}

function findEventByCode(code) {
  const needle = String(code || '').trim().toUpperCase();
  return db.events.find((e) => String(e.code).toUpperCase() === needle);
}

function guestLink(req, event, guest) {
  const base = `${publicBase(req)}/i/${encodeURIComponent(event.code)}`;
  return guest ? `${base}?g=${encodeURIComponent(guest.token)}` : base;
}

function formatIcsDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function csvCell(value) {
  const str = String(value ?? '');
  return /[";\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

/* --------------------------- Pages -------------------------------- */

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/login', (req, res) => {
  if (isLogged(req)) return res.redirect('/admin');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});
app.get('/admin', requireAuthPage, (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'))
);
app.get('/scan', requireAuthPage, (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'scan.html'))
);
app.get('/i/:code', (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'invitation.html'))
);

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '30m' }));

/* --------------------------- Auth --------------------------------- */

app.post('/api/login', rateLimit({ max: 10, windowMs: 10 * 60 * 1000 }), (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!code || code !== ADMIN_CODE) {
    return res.status(401).json({ error: 'Code administrateur invalide.' });
  }
  const value = createSession();
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
      SESSION_TTL_MS / 1000
    }${secure ? '; Secure' : ''}`
  );
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({
    authenticated: isLogged(req),
    demoCode: SHOW_DEMO_CODE ? ADMIN_CODE : null,
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    demoCode: SHOW_DEMO_CODE ? ADMIN_CODE : null,
    themes: THEMES,
    timeZone: 'Africa/Kinshasa',
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, events: db.events.length, guests: db.guests.length });
});

/* ------------------------- Événements ----------------------------- */

app.get('/api/events', requireAuthApi, (req, res) => {
  const base = publicBase(req);
  const events = db.events
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((e) => ({
      ...e,
      stats: eventStats(e.id),
      publicUrl: `${base}/i/${encodeURIComponent(e.code)}`,
    }));
  res.json({ events });
});

app.post('/api/events', requireAuthApi, (req, res) => {
  const body = req.body || {};
  const hosts = clean(body.hosts, 120);
  if (!hosts) return res.status(400).json({ error: 'Le nom des hôtes est requis.' });

  const startsAt = clean(body.startsAt, 40);
  if (!startsAt || Number.isNaN(new Date(startsAt).getTime())) {
    return res.status(400).json({ error: 'Date et heure invalides.' });
  }

  let code = clean(body.code, 24)
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
  while (!code || db.events.some((e) => e.code === code)) {
    code = `EVT${crypto.randomInt(1000, 9999)}`;
  }

  const program = Array.isArray(body.program)
    ? body.program
        .map((p) => ({ time: clean(p.time, 20), label: clean(p.label, 120) }))
        .filter((p) => p.label)
        .slice(0, 12)
    : [];

  const event = {
    id: uid('evt'),
    code,
    title: clean(body.title, 140) || `Mariage de ${hosts}`,
    hosts,
    startsAt,
    timeZone: 'Africa/Kinshasa',
    venue: clean(body.venue, 120),
    address: clean(body.address, 200),
    mapUrl: clean(body.mapUrl, 400),
    dressCode: clean(body.dressCode, 120),
    intro: clean(body.intro, 800),
    theme: THEMES.includes(body.theme) ? body.theme : 'rouge',
    program,
    rsvpDeadline: clean(body.rsvpDeadline, 20),
    active: true,
    createdAt: new Date().toISOString(),
  };

  db.events.push(event);
  persist();
  res.status(201).json({ event: { ...event, stats: eventStats(event.id) } });
});

app.put('/api/events/:id', requireAuthApi, (req, res) => {
  const event = db.events.find((e) => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable.' });
  const body = req.body || {};
  const fields = [
    'hosts',
    'title',
    'venue',
    'address',
    'mapUrl',
    'dressCode',
    'intro',
    'rsvpDeadline',
    'startsAt',
  ];
  for (const field of fields) {
    if (typeof body[field] === 'string') event[field] = clean(body[field], 800);
  }
  if (THEMES.includes(body.theme)) event.theme = body.theme;
  if (typeof body.active === 'boolean') event.active = body.active;
  persist();
  res.json({ event: { ...event, stats: eventStats(event.id) } });
});

app.delete('/api/events/:id', requireAuthApi, (req, res) => {
  const idx = db.events.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Événement introuvable.' });
  const [{ id }] = db.events.splice(idx, 1);
  db.guests = db.guests.filter((g) => g.eventId !== id);
  db.guestbook = db.guestbook.filter((m) => m.eventId !== id);
  persist();
  res.json({ ok: true });
});

/* --------------------------- Invités ------------------------------ */

app.get('/api/events/:id/guests', requireAuthApi, (req, res) => {
  const event = db.events.find((e) => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable.' });
  const guests = db.guests
    .filter((g) => g.eventId === event.id)
    .map((g) => ({
      ...g,
      link: guestLink(req, event, g),
      qr: `${publicBase(req)}/api/events/${event.id}/qr.png?guest=${g.id}`,
    }));
  res.json({ guests, stats: eventStats(event.id) });
});

app.post('/api/events/:id/guests', requireAuthApi, rateLimit({ max: 200 }), (req, res) => {
  const event = db.events.find((e) => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable.' });

  const body = req.body || {};
  const raw = body.raw ? String(body.raw) : '';
  const list = raw
    ? raw
        .split(/\r?\n/)
        .map((line) => line.split(/[;,\t]/).map((v) => clean(v, 120)))
        .filter((cols) => cols[0])
        .map(([name, phone, seats]) => ({
          name,
          phone: phone || '',
          seats: Number(seats) || 1,
        }))
    : [
        {
          name: clean(body.name, 120),
          phone: clean(body.phone, 40),
          seats: Number(body.seats) || 1,
        },
      ];

  const created = [];
  for (const item of list) {
    if (!item.name) continue;
    const guest = {
      id: uid('gst'),
      eventId: event.id,
      name: item.name,
      phone: item.phone,
      email: '',
      seats: Math.min(Math.max(item.seats, 1), 20),
      status: 'invited',
      token: token(),
      checkedInAt: null,
      note: '',
      createdAt: new Date().toISOString(),
    };
    db.guests.push(guest);
    created.push(guest);
  }

  if (!created.length) {
    return res.status(400).json({ error: 'Aucun invité valide fourni.' });
  }
  persist();
  res.status(201).json({ guests: created, stats: eventStats(event.id) });
});

app.delete('/api/guests/:id', requireAuthApi, (req, res) => {
  const idx = db.guests.findIndex((g) => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Invité introuvable.' });
  db.guests.splice(idx, 1);
  persist();
  res.json({ ok: true });
});

app.post('/api/guests/:id/checkin', requireAuthApi, (req, res) => {
  const guest = db.guests.find((g) => g.id === req.params.id);
  if (!guest) return res.status(404).json({ error: 'Invité introuvable.' });
  guest.checkedInAt = req.body?.undo ? null : new Date().toISOString();
  if (!req.body?.undo) guest.status = 'confirmed';
  persist();
  const event = db.events.find((e) => e.id === guest.eventId);
  res.json({ guest, stats: eventStats(guest.eventId), eventTitle: event?.title });
});

app.post('/api/checkin', requireAuthApi, (req, res) => {
  const raw = String(req.body?.code || '').trim();
  if (!raw) return res.status(400).json({ error: 'Code manquant.' });

  let tokenValue = raw;
  try {
    const url = new URL(raw);
    tokenValue = url.searchParams.get('g') || url.pathname.split('/').pop() || raw;
  } catch {
    /* pas une URL : on garde la valeur brute */
  }
  tokenValue = tokenValue.trim().toUpperCase();

  const guest = db.guests.find(
    (g) => g.token.toUpperCase() === tokenValue || g.id === raw
  );
  if (!guest) {
    return res.status(404).json({ error: 'Billet non reconnu.' });
  }
  if (guest.checkedInAt) {
    const event = db.events.find((e) => e.id === guest.eventId);
    return res.status(409).json({
      error: 'Ce billet a déjà été scanné.',
      guest,
      checkedInAt: guest.checkedInAt,
      eventTitle: event?.title,
      stats: eventStats(guest.eventId),
    });
  }

  guest.checkedInAt = new Date().toISOString();
  guest.status = 'confirmed';
  persist();
  const event = db.events.find((e) => e.id === guest.eventId);
  res.json({
    ok: true,
    guest,
    eventTitle: event?.title,
    stats: eventStats(guest.eventId),
  });
});

app.get('/api/events/:id/qr.png', requireAuthApi, async (req, res) => {
  const event = db.events.find((e) => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable.' });
  const guest = req.query.guest
    ? db.guests.find((g) => g.id === req.query.guest && g.eventId === event.id)
    : null;
  const target = guestLink(req, event, guest);
  try {
    const png = await QRCode.toBuffer(target, {
      type: 'png',
      width: 520,
      margin: 1,
      color: { dark: '#101014', light: '#ffffff' },
    });
    res.type('png').set('Cache-Control', 'no-store').send(png);
  } catch (err) {
    res.status(500).json({ error: 'QR code indisponible.' });
  }
});

app.get('/api/events/:id/export.csv', requireAuthApi, (req, res) => {
  const event = db.events.find((e) => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable.' });
  const lines = [
    ['Nom', 'Téléphone', 'Places', 'Statut', 'Arrivée', 'Code billet', 'Lien']
      .map(csvCell)
      .join(';'),
  ];
  for (const g of db.guests.filter((x) => x.eventId === event.id)) {
    lines.push(
      [
        g.name,
        g.phone,
        g.seats,
        g.status,
        g.checkedInAt || '',
        g.token,
        guestLink(req, event, g),
      ]
        .map(csvCell)
        .join(';')
    );
  }
  res
    .type('text/csv; charset=utf-8')
    .set(
      'Content-Disposition',
      `attachment; filename="invites-${event.code.toLowerCase()}.csv"`
    )
    .send(`\uFEFF${lines.join('\n')}`);
});

/* ------------------- Invitation publique -------------------------- */

app.get('/api/invitations/:code', (req, res) => {
  const event = findEventByCode(req.params.code);
  if (!event) return res.status(404).json({ error: 'Invitation introuvable.' });

  const guest = req.query.g
    ? db.guests.find(
        (g) =>
          g.eventId === event.id && g.token.toUpperCase() === String(req.query.g).toUpperCase()
      )
    : null;

  res.json({
    event: {
      code: event.code,
      title: event.title,
      hosts: event.hosts,
      startsAt: event.startsAt,
      timeZone: event.timeZone,
      venue: event.venue,
      address: event.address,
      mapUrl: event.mapUrl,
      dressCode: event.dressCode,
      intro: event.intro,
      theme: event.theme,
      program: event.program || [],
      rsvpDeadline: event.rsvpDeadline,
      active: event.active,
    },
    guest: guest
      ? {
          id: guest.id,
          name: guest.name,
          seats: guest.seats,
          status: guest.status,
          checkedIn: Boolean(guest.checkedInAt),
        }
      : null,
    guestbook: db.guestbook
      .filter((m) => m.eventId === event.id && m.approved)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 30)
      .map(({ id, name, message, createdAt }) => ({ id, name, message, createdAt })),
    shareLink: `${publicBase(req)}/i/${event.code}`,
  });
});

app.post(
  '/api/invitations/:code/rsvp',
  rateLimit({ max: 20 }),
  (req, res) => {
    const event = findEventByCode(req.params.code);
    if (!event) return res.status(404).json({ error: 'Invitation introuvable.' });

    const body = req.body || {};
    const attending = body.attending === true || body.attending === 'yes';
    const name = clean(body.name, 120);
    if (!name) return res.status(400).json({ error: 'Votre nom est requis.' });

    const byToken = body.g
      ? db.guests.find(
          (g) => g.eventId === event.id && g.token === String(body.g).toUpperCase()
        )
      : null;
    const guest =
      byToken ||
      db.guests.find(
        (g) => g.eventId === event.id && normalize(g.name) === normalize(name)
      ) ||
      null;

    const record = guest || {
      id: uid('gst'),
      eventId: event.id,
      name,
      phone: '',
      email: '',
      seats: 1,
      status: 'invited',
      token: token(),
      checkedInAt: null,
      note: '',
      createdAt: new Date().toISOString(),
    };
    if (!guest) db.guests.push(record);

    record.name = name;
    if (body.phone) record.phone = clean(body.phone, 40);
    if (body.email) record.email = clean(body.email, 120);
    record.seats = Math.min(Math.max(Number(body.seats) || 1, 1), 20);
    record.status = attending ? 'confirmed' : 'declined';
    record.respondedAt = new Date().toISOString();

    let guestbookEntry = null;
    const message = clean(body.message, 500);
    if (message) {
      const existing = db.guestbook.find(
        (m) => m.eventId === event.id && normalize(m.name) === normalize(name)
      );
      if (existing) {
        existing.message = message;
        existing.approved = true;
        guestbookEntry = existing;
      } else {
        guestbookEntry = {
          id: uid('msg'),
          eventId: event.id,
          name,
          message,
          approved: true,
          createdAt: new Date().toISOString(),
        };
        db.guestbook.push(guestbookEntry);
      }
    }

    persist();
    res.json({
      ok: true,
      guest: {
        id: record.id,
        name: record.name,
        seats: record.seats,
        status: record.status,
      },
      guestbookEntry,
      stats: eventStats(event.id),
    });
  }
);

app.post('/api/invitations/:code/guestbook', rateLimit({ max: 20 }), (req, res) => {
  const event = findEventByCode(req.params.code);
  if (!event) return res.status(404).json({ error: 'Invitation introuvable.' });
  const name = clean(req.body?.name, 120);
  const message = clean(req.body?.message, 500);
  if (!name || !message) {
    return res.status(400).json({ error: 'Nom et message sont requis.' });
  }
  const entry = {
    id: uid('msg'),
    eventId: event.id,
    name,
    message,
    approved: true,
    createdAt: new Date().toISOString(),
  };
  db.guestbook.push(entry);
  persist();
  res.status(201).json({ entry });
});

app.get('/api/invitations/:code/qr.png', async (req, res) => {
  const event = findEventByCode(req.params.code);
  if (!event) return res.status(404).json({ error: 'Invitation introuvable.' });
  const guest = req.query.g
    ? db.guests.find(
        (g) =>
          g.eventId === event.id && g.token.toUpperCase() === String(req.query.g).toUpperCase()
      )
    : null;
  try {
    const png = await QRCode.toBuffer(guestLink(req, event, guest), {
      type: 'png',
      width: 480,
      margin: 1,
      color: { dark: '#101014', light: '#ffffff' },
    });
    res.type('png').set('Cache-Control', 'no-store').send(png);
  } catch (err) {
    res.status(500).json({ error: 'QR code indisponible.' });
  }
});

app.get('/api/invitations/:code/calendar.ics', (req, res) => {
  const event = findEventByCode(req.params.code);
  if (!event) return res.status(404).send('Événement introuvable');
  const start = formatIcsDate(event.startsAt);
  const end = formatIcsDate(new Date(new Date(event.startsAt).getTime() + 4 * 3600 * 1000));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Planning Events//Invitation//FR',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${event.id}@planning-events`,
    `DTSTAMP:${formatIcsDate(new Date().toISOString())}Z`,
    `DTSTART;TZID=${event.timeZone}:${start}`,
    `DTEND;TZID=${event.timeZone}:${end}`,
    `SUMMARY:${event.title.replace(/[,;]/g, ' ')}`,
    `LOCATION:${`${event.venue} ${event.address}`.trim().replace(/[,;]/g, ' ')}`,
    `DESCRIPTION:${(event.intro || '').replace(/\n/g, ' ').replace(/[,;]/g, ' ')}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  res
    .type('text/calendar; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="${event.code}.ics"`)
    .send(lines.join('\r\n'));
});

/* --------------------- Livre d'or & messages ---------------------- */

app.get('/api/events/:id/guestbook', requireAuthApi, (req, res) => {
  const event = db.events.find((e) => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Événement introuvable.' });
  res.json({
    entries: db.guestbook
      .filter((m) => m.eventId === event.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  });
});

app.put('/api/guestbook/:id', requireAuthApi, (req, res) => {
  const entry = db.guestbook.find((m) => m.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Message introuvable.' });
  if (typeof req.body?.approved === 'boolean') entry.approved = req.body.approved;
  persist();
  res.json({ entry });
});

app.delete('/api/guestbook/:id', requireAuthApi, (req, res) => {
  const idx = db.guestbook.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Message introuvable.' });
  db.guestbook.splice(idx, 1);
  persist();
  res.json({ ok: true });
});

app.post('/api/contact', rateLimit({ max: 10 }), (req, res) => {
  const body = req.body || {};
  const name = clean(body.name, 120);
  const message = clean(body.message, 1000);
  if (!name || !message) {
    return res.status(400).json({ error: 'Nom et message sont requis.' });
  }
  const record = {
    id: uid('ctc'),
    name,
    phone: clean(body.phone, 40),
    eventType: clean(body.eventType, 60),
    message,
    read: false,
    createdAt: new Date().toISOString(),
  };
  db.messages.push(record);
  persist();
  res.status(201).json({ ok: true, message: record });
});

app.get('/api/messages', requireAuthApi, (req, res) => {
  res.json({
    messages: db.messages
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  });
});

app.put('/api/messages/:id', requireAuthApi, (req, res) => {
  const record = db.messages.find((m) => m.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Message introuvable.' });
  if (typeof req.body?.read === 'boolean') record.read = req.body.read;
  persist();
  res.json({ message: record });
});

app.delete('/api/messages/:id', requireAuthApi, (req, res) => {
  const idx = db.messages.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Message introuvable.' });
  db.messages.splice(idx, 1);
  persist();
  res.json({ ok: true });
});

/* --------------------------- Erreurs ------------------------------ */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Ressource introuvable.' });
  }
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

app.use((err, req, res, next) => {
  console.error('[erreur]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erreur interne.' });
});

/* --------------------------- Démarrage ---------------------------- */

loadDb();

if (require.main === module) {
  app.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => {
    console.log(
      `Planning Events prêt sur http://0.0.0.0:${Number(process.env.PORT) || 3000}`
    );
  });
}

module.exports = { app, loadDb, eventStats };
