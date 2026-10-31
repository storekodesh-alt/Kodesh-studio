'use strict';

/**
 * Vérification en ligne de la plateforme Planning Events.
 *
 * Usage :
 *   BASE_URL=https://mon-app.exemple.com ADMIN_CODE=PLANNING2026 node scripts/live-check.js
 *
 * Le script exécute le parcours métier complet contre l'application déployée :
 * connexion administrateur → création d'un événement → ajout d'un invité →
 * QR code → RSVP + livre d'or → scan/check-in → détection du doublon →
 * cohérence des statistiques → suppression de l'événement de test.
 * Il sort en code 1 dès qu'une assertion échoue.
 */

const assert = require('node:assert/strict');

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const ADMIN_CODE = process.env.ADMIN_CODE || 'PLANNING2026';

let cookie = '';

function step(name) {
  process.stdout.write(`• ${name}\n`);
}

async function api(path, { method = 'GET', body, expect } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  assert.equal(
    res.status,
    expect,
    `${method} ${path} → HTTP ${res.status} (attendu ${expect}) : ${text.slice(0, 200)}`
  );
  if (/json/.test(res.headers.get('content-type') || '')) return JSON.parse(text);
  return text;
}

async function main() {
  step(`Cible : ${BASE_URL}`);

  const health = await api('/api/health');
  assert.equal(health.ok, true, 'l’endpoint /api/health doit répondre ok=true');

  const page = await api('/');
  assert.match(page, /Planning Events/, 'la vitrine doit afficher la marque Planning Events');
  assert.match(page, /Kinshasa/, 'la vitrine doit mentionner Kinshasa');

  await api('/api/login', { method: 'POST', body: { code: ADMIN_CODE } });
  const session = await api('/api/session');
  assert.equal(session.authenticated, true, 'la connexion administrateur doit ouvrir une session');

  const created = await api('/api/events', {
    method: 'POST',
    body: {
      title: 'Vérification en ligne',
      hosts: 'Équipe Planning Events',
      startsAt: '2027-06-12T18:30',
      venue: 'Kinshasa',
      address: 'Gombe, Kinshasa',
    },
  });
  const event = created.event;
  assert.ok(event?.id && event?.code, 'la création d’événement doit renvoyer un id et un code');

  try {
    const guestRes = await api(`/api/events/${event.id}/guests`, {
      method: 'POST',
      body: { name: 'Invité Verification', phone: '+243810000000', seats: 2 },
    });
    const guest = guestRes.guests.find((g) => g.name === 'Invité Verification');
    assert.ok(guest?.token, 'l’invité créé doit recevoir un jeton de billet');

    const invitation = await api(`/api/invitations/${event.code}`);
    assert.equal(invitation.event.code, event.code, 'l’invitation publique doit renvoyer l’événement');

    const qr = await fetch(`${BASE_URL}/api/invitations/${event.code}/qr.png`);
    assert.equal(qr.status, 200, 'le QR code de l’invitation doit être servi');
    assert.equal(qr.headers.get('content-type'), 'image/png', 'le QR code doit être un PNG');
    const png = Buffer.from(await qr.arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), 'PNG', 'le QR code doit être un fichier PNG valide');

    const rsvp = await api(`/api/invitations/${event.code}/rsvp`, {
      method: 'POST',
      body: { name: 'Invité Verification', attending: true, seats: 2, message: 'Nous serons présents !' },
    });
    assert.equal(rsvp.guest.status, 'confirmed', 'le RSVP doit confirmer l’invité');

    const guestbook = await api(`/api/invitations/${event.code}/guestbook`, {
      method: 'POST',
      body: { name: 'Visiteur Test', message: 'Félicitations pour cet événement !' },
    });
    assert.equal(guestbook.entry.approved, true, 'le message du livre d’or doit être publié');

    const checkin = await api('/api/checkin', { method: 'POST', body: { code: guest.token } });
    assert.equal(checkin.ok, true, 'le scan doit valider le billet');
    assert.equal(checkin.stats.checkedIn >= 1, true, 'les statistiques doivent compter l’entrée');

    const duplicate = await api('/api/checkin', {
      method: 'POST',
      body: { code: guest.token },
      expect: 409,
    });
    assert.match(duplicate.error, /déjà/, 'un second scan doit signaler le doublon');

    const stats = await api(`/api/events/${event.id}`);
    assert.equal(stats.stats.confirmed, 1, 'un invité doit être confirmé');
    assert.equal(stats.stats.checkedIn, 1, 'une entrée doit être comptée');

    const csv = await api(`/api/events/${event.id}/export.csv`);
    assert.match(csv, /Invité Verification/, 'l’export CSV doit contenir l’invité');
  } finally {
    await api(`/api/events/${event.id}`, { method: 'DELETE' });
  }

  step('Vérification en ligne OK : vitrine, session, événement, invité, QR, RSVP, livre d’or, scan, statistiques, export, nettoyage.');
}

main().catch((err) => {
  console.error(`ÉCHEC : ${err.message}`);
  process.exit(1);
});
