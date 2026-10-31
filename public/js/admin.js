'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (char) => {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[char];
    });

  const state = {
    events: [],
    event: null,
    guests: [],
    stats: null,
    guestbook: [],
    messages: [],
    view: 'overview',
  };

  const STATUS_LABELS = {
    confirmed: 'Confirmé',
    invited: 'En attente',
    declined: 'Décliné',
  };

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
    if (!res.ok) throw new Error(data.error || 'Erreur serveur');
    return data;
  }

  const fmtDate = (iso) => {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('fr-FR', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Africa/Kinshasa',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  const fmtShort = (iso) => {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Africa/Kinshasa',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  };

  /* ----------------------------- Modal ----------------------------- */

  function openModal(title, html) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    $('#modal').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    $('#modal').hidden = true;
    $('#modal-body').innerHTML = '';
    document.body.style.overflow = '';
  }
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => {
    if (e.target === $('#modal')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
  });

  /* ---------------------------- Routing ---------------------------- */

  function setView(view) {
    state.view = view;
    $$('.side-link').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach((section) => {
      section.hidden = section.id !== `view-${view}`;
    });
  }

  $$('.side-link').forEach((btn) => {
    btn.addEventListener('click', () => {
      setView(btn.dataset.view);
      if (btn.dataset.view === 'messages') loadMessages();
    });
  });

  /* ---------------------------- Events ----------------------------- */

  async function loadEvents(preferredId) {
    const data = await api('/api/events');
    state.events = data.events || [];
    renderEventSelect(preferredId);
    if (!state.events.length) {
      showEmptyState();
      return;
    }
    const target =
      state.events.find((e) => e.id === preferredId) ||
      state.events.find((e) => e.id === state.event?.id) ||
      state.events[0];
    await selectEvent(target.id);
  }

  function renderEventSelect(preferredId) {
    const select = $('#event-select');
    select.innerHTML = '';
    for (const event of state.events) {
      const option = document.createElement('option');
      option.value = event.id;
      option.textContent = `${event.code} · ${event.hosts}`;
      if (event.id === preferredId) option.selected = true;
      select.appendChild(option);
    }
  }

  function showEmptyState() {
    $('#event-title').textContent = 'Aucun événement';
    $('#event-meta').textContent = 'Créez votre premier événement pour commencer.';
    $('#stats').innerHTML = '';
    $('#guests-body').innerHTML = '';
    $('#guests-empty').hidden = false;
    $('#recent-checkins').innerHTML =
      '<p class="form-note">Pas encore d’arrivée enregistrée.</p>';
  }

  $('#event-select').addEventListener('change', (e) => {
    if (e.target.value) selectEvent(e.target.value);
  });

  async function selectEvent(id) {
    const summary = state.events.find((e) => e.id === id);
    if (!summary) return;
    state.event = summary;
    state.stats = summary.stats;
    renderHeader();
    fillEventForm();
    await Promise.all([loadGuests(), loadGuestbook()]);
  }

  function renderHeader() {
    const event = state.event;
    if (!event) return;
    $('#event-title').textContent = event.title || event.hosts;
    $('#event-meta').textContent = `${fmtDate(event.startsAt)} · ${
      event.venue || 'lieu à confirmer'
    } · code ${event.code}`;
    $('#open-public').href = event.publicUrl || `/i/${event.code}`;
    renderStats();
  }

  function statCard(value, label, hint, tone = '') {
    return `<div class="stat ${tone}">
      <b>${value ?? 0}</b>
      <span>${label}</span>
      ${hint ? `<em>${hint}</em>` : ''}
    </div>`;
  }

  function renderStats() {
    const s = state.stats;
    if (!s) return;
    const rate = s.guests ? Math.round((s.confirmed / s.guests) * 100) : 0;
    const arrival = s.confirmedSeats
      ? Math.min(100, Math.round((s.checkedIn / s.confirmedSeats) * 100))
      : 0;
    $('#stats').innerHTML = [
      statCard(s.guests, 'Invités', `${s.pending} sans réponse`),
      statCard(s.confirmed, 'Confirmés', `${rate}% de la liste`, 'ok'),
      statCard(s.declined, 'Déclinés', 'absences signalées', 'muted'),
      statCard(s.confirmedSeats, 'Places attendues', `${s.seats} places au total`),
      statCard(s.checkedIn, 'Entrés', `${arrival}% des présents`, 'gold'),
    ].join('');
  }

  /* ---------------------------- Guests ----------------------------- */

  async function loadGuests() {
    if (!state.event) return;
    const data = await api(`/api/events/${state.event.id}/guests`);
    state.guests = data.guests || [];
    state.stats = data.stats;
    renderStats();
    renderGuests();
    renderRecentCheckins();
  }

  function renderRecentCheckins() {
    const recent = state.guests
      .filter((g) => g.checkedInAt)
      .sort((a, b) => new Date(b.checkedInAt) - new Date(a.checkedInAt))
      .slice(0, 6);
    const box = $('#recent-checkins');
    if (!recent.length) {
      box.innerHTML = '<p class="form-note">Pas encore d’arrivée enregistrée.</p>';
      return;
    }
    box.innerHTML = recent
      .map(
        (g) =>
          `<div class="mini-row"><b>${esc(g.name)}</b><span>${g.seats} pers. · ${fmtShort(
            g.checkedInAt
          )}</span></div>`
      )
      .join('');
  }

  function guestRow(guest) {
    const status = guest.checkedInAt ? 'checked' : guest.status;
    const label =
      status === 'checked' ? 'Entré' : STATUS_LABELS[guest.status] || guest.status;
    return `<tr>
      <td><b>${esc(guest.name)}</b><br /><span class="cell-sub">${esc(
      guest.phone || '—'
    )}</span></td>
      <td>${guest.seats}</td>
      <td><span class="badge badge-${status}">${label}</span></td>
      <td>${guest.checkedInAt ? fmtShort(guest.checkedInAt) : '—'}</td>
      <td class="row-actions">
        <button class="icon-btn" title="QR code" data-qr="${guest.id}">▧</button>
        <button class="icon-btn" title="Copier le lien" data-copy="${guest.id}">⧉</button>
        <button class="icon-btn" title="${
          guest.checkedInAt ? 'Annuler l’entrée' : 'Marquer comme entré'
        }" data-checkin="${guest.id}" data-undo="${guest.checkedInAt ? '1' : ''}">✓</button>
        <button class="icon-btn danger" title="Supprimer" data-del="${guest.id}">✕</button>
      </td>
    </tr>`;
  }

  function renderGuests() {
    const term = $('#guest-search').value.trim().toLowerCase();
    const filter = $('#guest-filter').value;
    const rows = state.guests.filter((guest) => {
      const matchesTerm =
        !term ||
        guest.name.toLowerCase().includes(term) ||
        (guest.phone || '').toLowerCase().includes(term) ||
        (guest.token || '').toLowerCase().includes(term);
      if (!matchesTerm) return false;
      if (filter === 'checked') return Boolean(guest.checkedInAt);
      if (filter !== 'all') return guest.status === filter;
      return true;
    });
    const body = $('#guests-body');
    body.innerHTML = rows.map(guestRow).join('');
    $('#guests-empty').hidden = state.guests.length > 0;
  }

  $('#guest-search').addEventListener('input', renderGuests);
  $('#guest-filter').addEventListener('change', renderGuests);

  $('#guests-body').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const { qr, copy, checkin, del } = button.dataset;
    if (qr) {
      const guest = state.guests.find((g) => g.id === qr);
      if (!guest) return;
      openModal(
        `Billet de ${guest.name}`,
        `<div class="qr-modal">
           <img src="${guest.qr}" alt="QR code de ${esc(guest.name)}" />
           <p class="form-note">Code billet : <b>${guest.token}</b></p>
           <p class="link-box">${esc(guest.link)}</p>
           <div style="display:flex;gap:.5rem;flex-wrap:wrap;justify-content:center">
             <a class="btn btn-ghost btn-sm" href="${guest.qr}" download="billet-${guest.token}.png">Télécharger</a>
             <a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(
               `Bonjour ${guest.name}, voici votre invitation : ${guest.link}`
             )}">Envoyer par WhatsApp</a>
             <button class="btn btn-gold btn-sm" id="copy-guest-link">Copier le lien</button>
           </div>
         </div>`
      );
      const copyBtn = document.getElementById('copy-guest-link');
      if (copyBtn) copyBtn.addEventListener('click', () => copyText(guest.link, copyBtn));
      return;
    }
    if (copy) {
      const guest = state.guests.find((g) => g.id === copy);
      if (guest) copyText(guest.link, button);
      return;
    }
    if (checkin) {
      try {
        const data = await api(`/api/guests/${checkin}/checkin`, {
          method: 'POST',
          body: JSON.stringify({ undo: Boolean(button.dataset.undo) }),
        });
        state.stats = data.stats;
        await loadGuests();
      } catch (err) {
        alert(err.message);
      }
      return;
    }
    if (del) {
      const guest = state.guests.find((g) => g.id === del);
      if (!guest) return;
      if (!confirm(`Supprimer ${guest.name} de la liste ?`)) return;
      try {
        await api(`/api/guests/${del}`, { method: 'DELETE' });
        await loadGuests();
        await refreshEventsQuietly();
      } catch (err) {
        alert(err.message);
      }
    }
  });

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = '✓';
      setTimeout(() => (button.textContent = original), 1500);
    } catch {
      window.prompt('Copiez ce lien :', text);
    }
  }

  $('#copy-public').addEventListener('click', () => {
    if (state.event?.publicUrl) copyText(state.event.publicUrl, $('#copy-public'));
  });

  $('#export-csv').addEventListener('click', () => {
    if (!state.event) return;
    window.location.href = `/api/events/${state.event.id}/export.csv`;
  });

  /* -------------------------- Add guests --------------------------- */

  $('#add-guest').addEventListener('click', () => {
    if (!state.event) {
      alert('Créez d’abord un événement.');
      return;
    }
    openModal(
      'Ajouter un invité',
      `<form id="guest-form">
         <div class="field"><label for="g-name">Nom complet *</label><input id="g-name" name="name" required maxlength="120" /></div>
         <div class="grid-2">
           <div class="field"><label for="g-phone">Téléphone</label><input id="g-phone" name="phone" maxlength="40" /></div>
           <div class="field"><label for="g-seats">Places</label><input id="g-seats" name="seats" type="number" min="1" max="20" value="1" /></div>
         </div>
         <button class="btn btn-gold btn-block" type="submit">Ajouter</button>
         <p class="form-status" id="g-status" role="status"></p>
       </form>`
    );
    const form = document.getElementById('guest-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = document.getElementById('g-status');
      const payload = Object.fromEntries(new FormData(form).entries());
      try {
        const data = await api(`/api/events/${state.event.id}/guests`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        state.stats = data.stats;
        closeModal();
        await loadGuests();
        await refreshEventsQuietly();
      } catch (err) {
        status.className = 'form-status err';
        status.textContent = err.message;
      }
    });
  });

  $('#bulk-guests').addEventListener('click', () => {
    if (!state.event) {
      alert('Créez d’abord un événement.');
      return;
    }
    openModal(
      'Import rapide',
      `<form id="bulk-form">
         <p class="form-note" style="margin-bottom:12px">Une ligne par invité : <b>Nom ; téléphone ; places</b></p>
         <div class="field"><textarea id="bulk-raw" name="raw" rows="8" placeholder="Grace Mbuyi; +243 810 000 000; 2&#10;Famille Tshibangu"></textarea></div>
         <button class="btn btn-gold btn-block" type="submit">Importer</button>
         <p class="form-status" id="bulk-status" role="status"></p>
       </form>`
    );
    const form = document.getElementById('bulk-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = document.getElementById('bulk-status');
      const raw = document.getElementById('bulk-raw').value;
      try {
        const data = await api(`/api/events/${state.event.id}/guests`, {
          method: 'POST',
          body: JSON.stringify({ raw }),
        });
        state.stats = data.stats;
        closeModal();
        await loadGuests();
        await refreshEventsQuietly();
      } catch (err) {
        status.className = 'form-status err';
        status.textContent = err.message;
      }
    });
  });

  /* --------------------------- Guestbook --------------------------- */

  async function loadGuestbook() {
    if (!state.event) return;
    const data = await api(`/api/events/${state.event.id}/guestbook`);
    state.guestbook = data.entries || [];
    renderGuestbook();
  }

  function renderGuestbook() {
    const box = $('#gb-admin');
    if (!state.guestbook.length) {
      box.innerHTML = '<p class="form-note">Aucun message pour le moment.</p>';
      return;
    }
    box.innerHTML = state.guestbook
      .map(
        (m) => `<article class="gb-admin-item">
          <div>
            <b>${esc(m.name)}</b>
            <span class="cell-sub">${fmtShort(m.createdAt)}</span>
            <p>${esc(m.message)}</p>
          </div>
          <div class="row-actions">
            <button class="icon-btn" data-toggle="${m.id}" title="${
          m.approved ? 'Masquer' : 'Publier'
        }">${m.approved ? '◉' : '○'}</button>
            <button class="icon-btn danger" data-gbdel="${m.id}" title="Supprimer">✕</button>
          </div>
        </article>`
      )
      .join('');
  }

  $('#gb-admin').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.toggle) {
      const entry = state.guestbook.find((m) => m.id === button.dataset.toggle);
      if (!entry) return;
      await api(`/api/guestbook/${entry.id}`, {
        method: 'PUT',
        body: JSON.stringify({ approved: !entry.approved }),
      });
      await loadGuestbook();
    }
    if (button.dataset.gbdel) {
      if (!confirm('Supprimer ce message ?')) return;
      await api(`/api/guestbook/${button.dataset.gbdel}`, { method: 'DELETE' });
      await loadGuestbook();
    }
  });

  /* ---------------------------- Messages --------------------------- */

  async function loadMessages() {
    const data = await api('/api/messages');
    state.messages = data.messages || [];
    const unread = state.messages.filter((m) => !m.read).length;
    const badge = $('#msg-badge');
    badge.hidden = unread === 0;
    badge.textContent = unread;
    renderMessages();
  }

  function renderMessages() {
    const box = $('#messages-list');
    if (!state.messages.length) {
      box.innerHTML = '<p class="form-note">Aucune demande reçue pour l’instant.</p>';
      return;
    }
    box.innerHTML = state.messages
      .map(
        (m) => `<article class="msg-item ${m.read ? 'read' : ''}">
          <div class="msg-head">
            <b>${esc(m.name)}</b>
            <span class="badge ${m.read ? 'badge-invited' : 'badge-confirmed'}">${
          m.read ? 'Lu' : 'Nouveau'
        }</span>
          </div>
          <p class="cell-sub">${esc(m.phone || '—')} · ${esc(m.eventType || '—')} · ${fmtShort(
          m.createdAt
        )}</p>
          <p>${esc(m.message)}</p>
          <div class="row-actions">
            <button class="icon-btn" data-read="${m.id}">${m.read ? '◯' : '◉'}</button>
            <button class="icon-btn danger" data-msgdel="${m.id}">✕</button>
          </div>
        </article>`
      )
      .join('');
  }

  $('#messages-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.read) {
      const msg = state.messages.find((m) => m.id === button.dataset.read);
      if (!msg) return;
      await api(`/api/messages/${msg.id}`, {
        method: 'PUT',
        body: JSON.stringify({ read: !msg.read }),
      });
      await loadMessages();
    }
    if (button.dataset.msgdel) {
      if (!confirm('Supprimer cette demande ?')) return;
      await api(`/api/messages/${button.dataset.msgdel}`, { method: 'DELETE' });
      await loadMessages();
    }
  });

  /* ------------------------- Event settings ------------------------ */

  function fillEventForm() {
    const event = state.event;
    if (!event) return;
    $('#f-title').value = event.title || '';
    $('#f-hosts').value = event.hosts || '';
    $('#f-starts').value = toLocalInput(event.startsAt);
    $('#f-deadline').value = event.rsvpDeadline || '';
    $('#f-venue').value = event.venue || '';
    $('#f-address').value = event.address || '';
    $('#f-map').value = event.mapUrl || '';
    $('#f-dress').value = event.dressCode || '';
    $('#f-intro').value = event.intro || '';
    $('#f-theme').value = event.theme || 'rouge';
    $('#f-program').value = (event.program || [])
      .map((p) => `${p.time} | ${p.label}`)
      .join('\n');
  }

  const parseProgram = (text) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [time, ...rest] = line.split('|');
        return rest.length
          ? { time: time.trim(), label: rest.join('|').trim() }
          : { time: '', label: line };
      });

  $('#event-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.event) return;
    const status = $('#event-status');
    const startsInput = $('#f-starts').value;
    const payload = {
      title: $('#f-title').value,
      hosts: $('#f-hosts').value,
      startsAt: startsInput ? new Date(startsInput).toISOString() : state.event.startsAt,
      rsvpDeadline: $('#f-deadline').value,
      venue: $('#f-venue').value,
      address: $('#f-address').value,
      mapUrl: $('#f-map').value,
      dressCode: $('#f-dress').value,
      intro: $('#f-intro').value,
      theme: $('#f-theme').value,
      program: parseProgram($('#f-program').value),
    };
    status.className = 'form-status';
    status.textContent = '';
    try {
      const data = await api(`/api/events/${state.event.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      state.event = { ...state.event, ...data.event };
      renderHeader();
      status.className = 'form-status ok';
      status.textContent = 'Modifications enregistrées.';
      await refreshEventsQuietly();
    } catch (err) {
      status.className = 'form-status err';
      status.textContent = err.message;
    }
  });

  $('#delete-event').addEventListener('click', async () => {
    if (!state.event) return;
    if (!confirm(`Supprimer « ${state.event.title} » et tous ses invités ?`)) return;
    await api(`/api/events/${state.event.id}`, { method: 'DELETE' });
    state.event = null;
    await loadEvents();
  });

  $('#new-event').addEventListener('click', () => {
    openModal(
      'Nouvel événement',
      `<form id="new-event-form">
         <div class="field"><label for="n-hosts">Hôtes *</label><input id="n-hosts" name="hosts" required maxlength="120" placeholder="Bénédicte NGOYA & Claire KABEY" /></div>
         <div class="grid-2">
           <div class="field"><label for="n-title">Titre (facultatif)</label><input id="n-title" name="title" maxlength="120" /></div>
           <div class="field"><label for="n-starts">Date & heure *</label><input id="n-starts" name="startsAt" type="datetime-local" required /></div>
         </div>
         <div class="grid-2">
           <div class="field"><label for="n-venue">Lieu</label><input id="n-venue" name="venue" maxlength="160" /></div>
           <div class="field"><label for="n-address">Adresse</label><input id="n-address" name="address" maxlength="200" /></div>
         </div>
         <div class="grid-2">
           <div class="field"><label for="n-deadline">Date limite RSVP</label><input id="n-deadline" name="rsvpDeadline" type="date" /></div>
           <div class="field"><label for="n-theme">Thème</label>
             <select id="n-theme" name="theme">
               <option value="rouge">Rouge & or</option>
               <option value="or">Or</option>
               <option value="nuit">Nuit</option>
               <option value="emeraude">Émeraude</option>
             </select>
           </div>
         </div>
         <button class="btn btn-gold btn-block" type="submit">Créer l’événement</button>
         <p class="form-status" id="n-status" role="status"></p>
       </form>`
    );
    const form = document.getElementById('new-event-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = document.getElementById('n-status');
      const fd = Object.fromEntries(new FormData(form).entries());
      if (!fd.startsAt) {
        status.className = 'form-status err';
        status.textContent = 'La date est requise.';
        return;
      }
      try {
        const data = await api('/api/events', {
          method: 'POST',
          body: JSON.stringify({ ...fd, startsAt: new Date(fd.startsAt).toISOString() }),
        });
        closeModal();
        await loadEvents(data.event.id);
      } catch (err) {
        status.className = 'form-status err';
        status.textContent = err.message;
      }
    });
  });

  async function refreshEventsQuietly() {
    try {
      const data = await api('/api/events');
      state.events = data.events || [];
      renderEventSelect(state.event?.id);
      const fresh = state.events.find((e) => e.id === state.event?.id);
      if (fresh) {
        state.event = fresh;
        state.stats = fresh.stats;
        renderHeader();
      }
    } catch {
      /* silencieux */
    }
  }

  /* ----------------------------- Boot ------------------------------ */

  $('#logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.replace('/login');
  });

  (async () => {
    try {
      const session = await api('/api/session');
      if (!session.authenticated) {
        window.location.replace('/login');
        return;
      }
      await loadEvents();
      setView('overview');
      loadMessages();
    } catch (err) {
      console.error(err);
    }
  })();
})();
