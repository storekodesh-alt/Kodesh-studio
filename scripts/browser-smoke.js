'use strict';

/**
 * Vérification navigateur des pages Planning Events.
 * Lance le serveur sur un port libre avec un DATA_DIR temporaire, puis
 * contrôle le rendu réel (titre, éléments visibles, absence d'erreur JS).
 *
 * Usage : node scripts/browser-smoke.js
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BROWSER_MODULES = [
  '/opt/appjet/browser/node_modules/playwright',
  '/opt/appjet/browser/node_modules/playwright-core',
  'playwright',
];

const BROWSER_PATHS = [
  '/opt/appjet/browser-binaries/chromium-1234/chrome-linux64/chrome',
  '/opt/appjet/browser-binaries/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
  '/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
];

function loadPlaywright() {
  for (const id of BROWSER_MODULES) {
    try {
      return require(id);
    } catch {
      /* suivant */
    }
  }
  return null;
}

function chromePath() {
  return BROWSER_PATHS.find((p) => fs.existsSync(p));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(base, deadlineMs = 20000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${base}/api/session`);
      if (res.status < 500) return;
    } catch {
      /* pas encore prêt */
    }
    await wait(250);
  }
  throw new Error('le serveur ne répond pas');
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.error('Playwright indisponible : vérification navigateur impossible.');
    process.exit(2);
  }
  const executablePath = chromePath();
  if (!executablePath) {
    console.error('Aucun binaire Chromium détecté : vérification navigateur impossible.');
    process.exit(2);
  }

  const port = 3311;
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-smoke-'));
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), ADMIN_CODE: 'SMOKE-CODE-2026', DATA_DIR: dataDir },
    stdio: 'ignore',
  });

  const failures = [];
  let browser;

  try {
    await waitForServer(base);

    browser = await playwright.chromium.launch({
      executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    async function check(name, route, assertions) {
      consoleErrors.length = 0;
      const res = await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
      await wait(600);
      if (!res || res.status() !== 200) {
        failures.push(`${name}: HTTP ${res ? res.status() : 'aucune réponse'}`);
        return;
      }
      for (const [selector, expected] of assertions) {
        try {
          await page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
          if (expected) {
            const text = (await page.textContent(selector)) || '';
            if (!text.includes(expected)) {
              failures.push(`${name}: "${selector}" ne contient pas « ${expected} » (vu : « ${text.trim().slice(0, 70)} »)`);
            }
          }
        } catch {
          failures.push(`${name}: sélecteur visible introuvable ${selector}`);
        }
      }
      const real = consoleErrors.filter((e) => !/fonts\.(googleapis|gstatic)\.com|net::ERR_(NAME|INTERNET)/i.test(e));
      if (real.length) failures.push(`${name}: erreurs console → ${real.slice(0, 3).join(' | ')}`);
    }

    await check('vitrine', '/', [
      ['header .brand', 'PLANNING'],
      ['h1', "Vos invités vivent l'événement"],
      ['#fonctionnalites h2', 'Fonctionnalités'],
      ['#fonctionnalites', 'QR'],
      ['#contact', 'Kinshasa'],
      ['a[href^="https://wa.me"]', null],
      ['#contact-form', null],
      ['#c-submit', 'Envoyer ma demande'],
    ]);

    await check('connexion', '/login', [
      ['#login-form', null],
      ['#code', null],
      ['h1', 'Espace professionnel'],
    ]);

    await check('invitation démo', '/i/DEMO2026', [
      ['#page', null],
      ['#hosts', 'Bénédicte'],
      ['#rsvp-form', null],
      ['#guestbook', null],
    ]);

    // Connexion réelle, puis contrôle du tableau de bord et du scan.
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('#code', 'SMOKE-CODE-2026');
    await page.click('#submit');
    await page.waitForURL('**/admin', { timeout: 10000 });
    await page.waitForSelector('#stats .stat', { timeout: 10000 });
    const cards = await page.$$eval('#stats .stat', (els) => els.length);
    if (cards < 3) failures.push(`admin: ${cards} cartes de statistiques affichées (attendu ≥ 3)`);
    await page.waitForSelector('#event-select option', { state: 'attached', timeout: 5000 });
    const guestRows = await page.$eval('#guests-body tr', (els) => els.length);
    if (guestRows < 1) failures.push('admin: aucun invité listé pour l\'événement de démonstration');
    const dashTitle = (await page.textContent('#event-title')) || '';
    if (!dashTitle.trim() || /chargement/i.test(dashTitle)) {
      failures.push(`admin: titre d'événement non chargé (« ${dashTitle.trim()} »)`);
    }

    consoleErrors.length = 0;
    await page.goto(`${base}/scan`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#scan-form', { timeout: 5000 });
    await page.waitForSelector('#s-in', { state: 'visible', timeout: 5000 });

    await context.close();

    // Rendu mobile de la vitrine et de l'invitation.
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mpage = await mobile.newPage();
    await mpage.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    const overflow = await mpage.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    if (overflow > 4) failures.push(`vitrine mobile: débordement horizontal de ${overflow}px`);
    await mpage.goto(`${base}/i/DEMO2026`, { waitUntil: 'domcontentloaded' });
    await mpage.waitForSelector('#page', { timeout: 5000 });
    const overflowInvite = await mpage.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    if (overflowInvite > 4) failures.push(`invitation mobile: débordement horizontal de ${overflowInvite}px`);
    await mobile.close();
  } catch (err) {
    failures.push(`exception: ${err.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`Échec de la vérification navigateur (${failures.length}) :`);
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }
  console.log('Vérification navigateur OK : vitrine, connexion, invitation, tableau de bord, scan, mobile.');
}

main();
