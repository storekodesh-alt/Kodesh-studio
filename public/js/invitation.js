'use strict';

(() => {
  const params = new URLSearchParams(window.location.search);
  const parts = window.location.pathname.split('/').filter(Boolean);
  const codeFromPath = parts[0] === 'i' ? parts[1] : null;
  const code = decodeURIComponent(codeFromPath || '');
  const guestToken = params.get('g');

  const $ = (id) => document.getElementById(id);
  let state = { event: null, guest: null };

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) => {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[char];
    });

  const formatter = (event) =>
    new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: event.timeZone || 'Africa/Kinshasa',
    }).format(new Date(event.startsAt));

  function renderHosts(hosts) {
    const chunks = String(hosts || '').split(/\s+&\s+/);
    if (chunks.length === 2) {
      return `${esc(chunks[0])}<span class="amp">&amp;</span>${esc(chunks[1])}`;
    }
    return esc(hosts);
  }

  function startCountdown(startsAt) {
    const target = new Date(startsAt).getTime();
    if (Number.isNaN(target)) return;
    const box = $('countdown');
    box.hidden = false;
    const tick = () => {
      const diff = target - Date.now();
      if (diff <= 0) {
        box.innerHTML =
          '<span class="pill" style="font-size:.8rem">C’est le grand jour ✦</span>';
        clearInterval(timer);
        return;
      }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      $('cd-d').textContent = d;
      $('cd-h').textContent = String(h).padStart(2, '0');
      $('cd-m').textContent = String(m).padStart(2, '0');
      $('cd-s').textContent = String(s).padStart(2, '0');
    };
    tick();
    const timer = setInterval(tick, 1000);
  }

  function renderGuestbook(entries) {
    const list = $('guestbook');
    const empty = $('gb-empty');
    list.innerHTML = '';
    if (!entries.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const entry of entries) {
      const item = document.createElement('div');
      item.className = 'gb-item';
      item.innerHTML = `<b>${esc(entry.name)}</b><p>${esc(entry.message)}</p>`;
      list.appendChild(item);
    }
  }

  function renderGuestState() {
    if (!state.guest) return;
    const pill = $('guest-pill');
    pill.hidden = false;
    pill.textContent =
      state.guest.status === 'confirmed'
        ? `Billet de ${state.guest.name} · ${state.guest.seats} pers.`
        : state.guest.status === 'declined'
        ? `Réponse enregistrée : ${state.guest.name}`
        : `Invité : ${state.guest.name}`;

    const summary = $('rsvp-summary');
    if (state.guest.status === 'confirmed') {
      summary.hidden = false;
      summary.innerHTML = `✦ Merci <strong>${esc(
        state.guest.name
      )}</strong> — votre présence est confirmée pour <strong>${
        state.guest.seats
      } personne(s)</strong>. Présentez votre QR code à l'entrée.`;
    } else if (state.guest.status === 'declined') {
      summary.hidden = false;
      summary.style.borderColor = 'rgba(217,180,106,.4)';
      summary.style.background = 'rgba(217,180,106,.08)';
      summary.style.color = '#f0d9a4';
      summary.innerHTML = `Votre absence a bien été enregistrée. Vous pouvez modifier votre réponse à tout moment.`;
    }
  }

  function fillForm() {
    if (state.guest) {
      $('r-name').value = state.guest.name;
      $('r-seats').value = state.guest.seats;
      $('r-attending').value = state.guest.status === 'declined' ? 'no' : 'yes';
    }
  }

  async function load() {
    try {
      const url = `/api/invitations/${encodeURIComponent(code)}${
        guestToken ? `?g=${encodeURIComponent(guestToken)}` : ''
      }`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('introuvable');
      const data = await res.json();
      state = { event: data.event, guest: data.guest };

      const { event } = data;
      document.title = `${event.hosts} — Invitation`;
      document.body.dataset.theme = event.theme || 'rouge';

      $('hosts').innerHTML = renderHosts(event.hosts || event.title);
      $('date').textContent = formatter(event);
      $('venue').textContent = [event.venue, event.address].filter(Boolean).join(' · ');

      if (event.intro) {
        $('intro').hidden = false;
        $('intro').textContent = event.intro;
      }
      if (event.dressCode) {
        $('dress').hidden = false;
        $('dress').textContent = event.dressCode;
      }
      if (event.rsvpDeadline) {
        const [y, m, d] = String(event.rsvpDeadline).split('-');
        if (y && m && d) {
          $('deadline').hidden = false;
          $('deadline').textContent = `RSVP avant le ${d}/${m}/${y}`;
        }
      }

      const calendar = $('calendar-link');
      calendar.hidden = false;
      calendar.href = `/api/invitations/${encodeURIComponent(event.code)}/calendar.ics`;

      $('place-name').textContent = event.venue || 'Lieu à confirmer';
      $('place-address').textContent = event.address || '';
      if (event.mapUrl) {
        const map = $('map-link');
        map.hidden = false;
        map.href = event.mapUrl;
      }

      const program = $('program');
      program.innerHTML = '';
      if (!(event.program || []).length) {
        $('program-panel').hidden = true;
      } else {
        for (const step of event.program) {
          const li = document.createElement('li');
          li.innerHTML = `<time>${esc(step.time)}</time><p>${esc(step.label)}</p>`;
          program.appendChild(li);
        }
      }

      $('qr').src = `/api/invitations/${encodeURIComponent(event.code)}/qr.png${
        guestToken ? `?g=${encodeURIComponent(guestToken)}` : ''
      }`;

      startCountdown(event.startsAt);
      renderGuestbook(data.guestbook || []);
      renderGuestState();
      fillForm();

      $('loading').hidden = true;
      $('page').hidden = false;
    } catch {
      $('loading').hidden = true;
      $('notfound').hidden = false;
    }
  }

  $('rsvp-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('r-status');
    const submit = $('r-submit');
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.attending = payload.attending === 'yes';
    payload.seats = Number(payload.seats) || 1;
    if (guestToken) payload.g = guestToken;

    status.className = 'form-status';
    status.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Envoi…';
    try {
      const res = await fetch(`/api/invitations/${encodeURIComponent(code)}/rsvp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Envoi impossible');
      state.guest = {
        ...data.guest,
        status: data.guest.status,
      };
      status.className = 'form-status ok';
      status.textContent = payload.attending
        ? `Merci ${data.guest.name} ! Votre présence est confirmée.`
        : 'Votre réponse a bien été enregistrée. Merci de nous avoir prévenus.';
      renderGuestState();
      const list = await fetch(`/api/invitations/${encodeURIComponent(code)}`).then((r) =>
        r.json()
      );
      renderGuestbook(list.guestbook || []);
      form.reset();
      fillForm();
    } catch (err) {
      status.className = 'form-status err';
      status.textContent = err.message;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Envoyer ma réponse';
    }
  });

  $('share-btn').addEventListener('click', async () => {
    const shareData = {
      title: state.event ? state.event.hosts : 'Invitation',
      text: 'Vous êtes invité(e) ! Confirmez votre présence :',
      url: window.location.href,
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }
      await navigator.clipboard.writeText(window.location.href);
      $('share-btn').textContent = 'Lien copié ✓';
      setTimeout(() => ($('share-btn').textContent = 'Partager'), 2200);
    } catch {
      window.prompt('Copiez ce lien :', window.location.href);
    }
  });

  if (!code) {
    $('loading').hidden = true;
    $('notfound').hidden = false;
  } else {
    load();
  }
})();
