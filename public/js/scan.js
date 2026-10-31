'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) => {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[char];
    });

  const state = { busy: false, history: [], stream: null, detector: null, raf: null };

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (res.status === 401) {
      window.location.replace('/login');
      throw new Error('Session expirée');
    }
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  }

  function renderStats(stats) {
    if (!stats) return;
    $('s-in').textContent = stats.checkedIn ?? 0;
    $('s-confirmed').textContent = stats.confirmedSeats ?? stats.confirmed ?? 0;
    $('s-seats').textContent = stats.seats ?? 0;
    $('s-pending').textContent = stats.pending ?? 0;
  }

  function showResult(kind, title, lines) {
    const box = $('result');
    box.hidden = false;
    box.className = `scan-result ${kind}`;
    box.innerHTML = `<b>${esc(title)}</b>${lines
      .map((line) => `<span>${esc(line)}</span>`)
      .join('')}`;
  }

  function pushHistory(entry) {
    state.history.unshift(entry);
    state.history = state.history.slice(0, 8);
    $('recent').innerHTML = state.history
      .map(
        (item) =>
          `<div class="mini-row"><b>${esc(item.name)}</b><span class="badge badge-${item.ok ? 'checked' : 'declined'}">${esc(
            item.label
          )}</span></div>`
      )
      .join('');
  }

  async function submitCode(raw) {
    const code = String(raw || '').trim();
    if (!code || state.busy) return;
    state.busy = true;
    const { ok, status, data } = await api('/api/checkin', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    state.busy = false;

    if (ok) {
      renderStats(data.stats);
      showResult('success', `✓ ${data.guest.name}`, [
        `${data.guest.seats} personne(s) — billet validé`,
        data.eventTitle ? `Événement : ${data.eventTitle}` : '',
        `Arrivée enregistrée à ${new Date().toLocaleTimeString('fr-FR')}`,
      ].filter(Boolean));
      pushHistory({ name: data.guest.name, label: 'Entrée validée', ok: true });
      beep(880);
    } else if (status === 409) {
      renderStats(data.stats);
      showResult('warning', `⚠ Billet déjà scanné`, [
        `${data.guest?.name || 'Invité'} — ${data.guest?.seats || 1} personne(s)`,
        `Première entrée : ${new Date(data.checkedInAt).toLocaleString('fr-FR')}`,
      ]);
      pushHistory({ name: data.guest?.name || '—', label: 'Doublon', ok: false });
      beep(320);
    } else {
      showResult('error', '✕ Billet non reconnu', [
        data.error || 'Vérifiez le code et réessayez.',
      ]);
      pushHistory({ name: code.slice(0, 18), label: 'Refusé', ok: false });
      beep(240);
    }
  }

  function beep(frequency) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      gain.gain.value = 0.05;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, 140);
    } catch {
      /* audio facultatif */
    }
  }

  $('scan-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('scan-input');
    const value = input.value;
    input.value = '';
    submitCode(value);
  });

  /* ------------------------- Camera scanner ------------------------ */

  async function startCamera() {
    const video = $('video');
    if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
      $('camera-note').hidden = false;
      return;
    }
    if (!('BarcodeDetector' in window)) {
      $('camera-note').hidden = false;
      $('camera-note').textContent =
        'Ce navigateur ne détecte pas les QR codes automatiquement : saisissez le code du billet.';
      return;
    }
    try {
      state.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      video.srcObject = state.stream;
      video.hidden = false;
      $('scan-frame').hidden = false;
      await video.play();
      $('camera-btn').textContent = 'Arrêter la caméra';
      $('camera-btn').dataset.on = '1';
      const loop = async () => {
        if (!state.stream) return;
        try {
          const codes = await state.detector.detect(video);
          if (codes && codes.length) {
            const value = codes[0].rawValue;
            if (value) {
              showResult('success', 'Lecture…', ['Validation du billet en cours']);
              await submitCode(value);
            }
          }
        } catch {
          /* ignore les erreurs de frame */
        }
        state.raf = requestAnimationFrame(loop);
      };
      state.raf = requestAnimationFrame(loop);
    } catch {
      $('camera-note').hidden = false;
      $('camera-note').textContent =
        'Accès caméra refusé ou indisponible. Utilisez la saisie manuelle du code.';
    }
  }

  function stopCamera() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = null;
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }
    $('video').hidden = true;
    $('scan-frame').hidden = true;
    $('camera-btn').textContent = 'Activer la caméra';
    $('camera-btn').dataset.on = '';
  }

  $('camera-btn').addEventListener('click', () => {
    if ($('camera-btn').dataset.on) stopCamera();
    else startCamera();
  });

  /* ----------------------------- Boot ------------------------------ */

  (async () => {
    const session = await api('/api/session');
    if (!session.data.authenticated) {
      window.location.replace('/login');
      return;
    }
    const events = await api('/api/events');
    const first = (events.data.events || [])[0];
    if (first) renderStats(first.stats);
    $('scan-input').focus();
  })();
})();
