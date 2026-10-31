'use strict';

/**
 * Tests d'intégration de l'API Planning Events.
 * Base de données isolée dans un répertoire temporaire.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-events-test-'));
process.env.DATA_DIR = tmpDir;
process.env.ADMIN_CODE = 'TEST-CODE-2026';

const { app } = require('../server');

let server;
let base;
let cookie = '';

const api = async (pathname, options = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${pathname}`, { ...options, headers });
  const raw = await res.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: res.status, body, headers: res.headers };
};

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('le site vitrine expose la marque et les coordonnées de Kinshasa', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /PLANNING\s*<b>EVENTS<\/b>/i);
  assert.match(html, /Kinshasa/);
  assert.match(html, /808\s?979\s?828/);
  assert.match(html, /183 Avenue Dodoma/);
});

test('la page d\'invitation publique est servie', async () => {
  const res = await fetch(`${base}/i/DEMO2026`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /inv-body/);
});

test('les routes protégées refusent les anonymes', async () => {
  const res = await api('/api/events');
  assert.equal(res.status, 401);
});

test('un code administrateur invalide est rejeté', async () => {
  const res = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ code: 'MAUVAIS' }),
  });
  assert.equal(res.status, 401);
});

test('la connexion administrateur ouvre une session', async () => {
  const res = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ code: 'TEST-CODE-2026' }),
  });
  assert.equal(res.status, 200);
  const cookies = res.headers.getSetCookie?.() || [];
  const session = cookies.find((c) => c.startsWith('pe_session='));
  assert.ok(session, 'cookie de session attendu');
  cookie = session.split(';')[0];

  const check = await api('/api/session');
  assert.equal(check.body.authenticated, true);
});

test('création d\'un événement, d\'un invité puis lien + QR', async () => {
  const created = await api('/api/events', {
    method: 'POST',
    body: JSON.stringify({
      hosts: 'Alice Mbala & Joseph Kasa',
      startsAt: '2027-03-20T17:00:00+01:00',
      venue: 'Salle Prestige',
      address: 'Kinshasa',
      theme: 'or',
      program: [{ time: '17h00', label: 'Cérémonie' }],
    }),
  });
  assert.equal(created.status, 201);
  const event = created.body.event;
  assert.ok(event.id);
  assert.ok(event.code);
  assert.equal(event.theme, 'or');

  const guest = await api(`/api/events/${event.id}/guests`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Grace Mbuyi', phone: '+243810000000', seats: 2 }),
  });
  assert.equal(guest.status, 201);
  const created2 = guest.body.guests[0];
  assert.equal(created2.name, 'Grace Mbuyi');
  assert.equal(created2.status, 'invited');
  assert.match(created2.token, /^[0-9A-F]{12}$/);

  const list = await api(`/api/events/${event.id}/guests`);
  assert.equal(list.status, 200);
  const listed = list.body.guests.find((g) => g.id === created2.id);
  assert.match(listed.link, new RegExp(`/i/${event.code}`));
  assert.match(listed.qr, /qr\.png\?guest=/);
  assert.equal(list.body.stats.guests, 1);

  const qr = await fetch(`${base}/api/events/${event.id}/qr.png?guest=${created2.id}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type') || '', /image\/png/);

  const publicQr = await fetch(`${base}/api/invitations/${event.code}/qr.png?g=${created2.token}`);
  assert.equal(publicQr.status, 200);
  assert.match(publicQr.headers.get('content-type') || '', /image\/png/);

  globalThis.__event = event;
  globalThis.__guest = created2;
});

test('l\'invitation publique renvoie l\'événement et l\'invité', async () => {
  const event = globalThis.__event;
  const guest = globalThis.__guest;
  const res = await fetch(`${base}/api/invitations/${event.code}?g=${guest.token}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.event.code, event.code);
  assert.equal(body.guest.name, 'Grace Mbuyi');
  assert.equal(body.event.timeZone, 'Africa/Kinshasa');
});

test('le RSVP met à jour l\'invité, le livre d\'or et les statistiques', async () => {
  const event = globalThis.__event;
  const guest = globalThis.__guest;

  const res = await api(`/api/invitations/${event.code}/rsvp`, {
    method: 'POST',
    body: JSON.stringify({
      token: guest.token,
      name: 'Grace Mbuyi',
      phone: '+243810000000',
      seats: 2,
      attending: 'yes',
      message: 'Nous serons présents avec joie !',
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.guest.status, 'confirmed');
  assert.equal(res.body.guest.seats, 2);

  const invite = await fetch(`${base}/api/invitations/${event.code}?g=${guest.token}`);
  const body = await invite.json();
  assert.equal(body.guest.status, 'confirmed');
  assert.ok(body.guestbook.length >= 1);

  const guests = await api(`/api/events/${event.id}/guests`);
  assert.equal(guests.body.stats.confirmed, 1);
  assert.equal(guests.body.stats.pending, 0);
});

test('un visiteur peut laisser un message au livre d\'or', async () => {
  const event = globalThis.__event;
  const res = await api(`/api/invitations/${event.code}/guestbook`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Famille Ilunga', message: 'Tous nos vœux de bonheur.' }),
  });
  assert.equal(res.status, 201);

  const admin = await api(`/api/events/${event.id}/guestbook`);
  assert.equal(admin.status, 200);
  const entry = admin.body.entries.find((m) => m.name === 'Famille Ilunga');
  assert.ok(entry, 'message attendu dans la modération');

  const approved = await api(`/api/guestbook/${entry.id}`, {
    method: 'PUT',
    body: JSON.stringify({ approved: true }),
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.entry.approved, true);
});

test('le scan valide une entrée unique puis signale le doublon', async () => {
  const guest = globalThis.__guest;
  const event = globalThis.__event;

  const first = await api('/api/checkin', {
    method: 'POST',
    body: JSON.stringify({ code: guest.token }),
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.ok(first.body.guest.checkedInAt);
  assert.equal(first.body.stats.checkedIn, 1);

  const again = await api('/api/checkin', {
    method: 'POST',
    body: JSON.stringify({ code: `${base}/i/${event.code}?g=${guest.token}` }),
  });
  assert.equal(again.status, 409);
  assert.ok(again.body.checkedInAt);

  const unknown = await api('/api/checkin', {
    method: 'POST',
    body: JSON.stringify({ code: 'CODE-INEXISTANT' }),
  });
  assert.equal(unknown.status, 404);
});

test('l\'export CSV contient l\'invité et les statistiques sont cohérentes', async () => {
  const event = globalThis.__event;
  const res = await fetch(`${base}/api/events/${event.id}/export.csv`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.match(csv, /Grace Mbuyi/);
  assert.match(csv, /;/);

  const events = await api('/api/events');
  const listed = events.body.events.find((e) => e.id === event.id);
  assert.equal(listed.stats.guests, 1);
  assert.equal(listed.stats.checkedIn, 1);
  assert.match(listed.publicUrl, new RegExp(`/i/${event.code}$`));
});

test('le formulaire de contact enregistre une demande de devis', async () => {
  const res = await api('/api/contact', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Patrick Lukusa',
      phone: '+243820000000',
      eventType: 'Mariage',
      message: 'Nous souhaitons un devis pour 250 invités.',
    }),
  });
  assert.equal(res.status, 201);

  const messages = await api('/api/messages');
  assert.equal(messages.status, 200);
  const found = messages.body.messages.find((m) => m.name === 'Patrick Lukusa');
  assert.ok(found);
  assert.equal(found.read, false);
});

test('la déconnexion efface le cookie de session', async () => {
  const res = await api('/api/logout', { method: 'POST' });
  assert.equal(res.status, 200);
  const cleared = (res.headers.getSetCookie?.() || []).find((c) =>
    c.startsWith('pe_session=')
  );
  assert.ok(cleared, 'cookie de session attendu dans la réponse');
  assert.match(cleared, /Max-Age=0/);

  // Le cookie étant signé et sans état serveur, un client qui l'efface n'est plus reconnu.
  const anonymous = await fetch(`${base}/api/session`);
  const body = await anonymous.json();
  assert.equal(body.authenticated, false);
});
