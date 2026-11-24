'use strict';
/* Interface de Claude Switcher. Aucune donnée n'est insérée via innerHTML :
   tout passe par textContent (pas d'injection possible via un nom de compte). */
(() => {
  const api = window.api;
  let state = null;
  let menuEl = null;
  let modalStack = [];

  /* ----------------------------- outils ----------------------------- */

  const $ = (sel) => document.querySelector(sel);

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const ICONS = {
    more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
    star: '<path d="m12 2.8 2.8 5.7 6.3.9-4.55 4.43 1.07 6.27L12 17.1l-5.62 2.96 1.07-6.27L2.9 9.4l6.3-.9Z"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.4"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07l1.33-1.3"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  };

  function icon(name, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    svg.innerHTML = ICONS[name]; // chaînes statiques ci-dessus uniquement
    return svg;
  }

  async function call(fn, ...args) {
    const r = await fn(...args);
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'Erreur inconnue.');
    return r.data;
  }

  function toast(message, kind) {
    const el = h('div', { class: `toast${kind === 'error' ? ' error' : ''}`, role: 'status', text: message });
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4500);
  }

  const initials = (name) =>
    (name || '?')
      .split(/[\s@._\-–—/|()]+/)
      .filter((w) => /^[\p{L}\p{N}]/u.test(w))
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('') || '?';

  const fmtDate = (ms) => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' }).format(ms);
  const fmtDateTime = (ms) =>
    new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
  function fmtSize(b) {
    if (!b) return '0 o';
    const u = ['o', 'Ko', 'Mo', 'Go'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return `${(b / 1024 ** i).toFixed(i ? 1 : 0).replace('.', ',')} ${u[i]}`;
  }
  function relTime(ms) {
    const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
    const s = Math.round((ms - Date.now()) / 1000);
    const abs = Math.abs(s);
    if (abs < 60) return 'à l’instant';
    if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86400), 'day');
  }

  const isMac = () => state && state.platform === 'darwin';
  const isWin = () => state && state.platform === 'win32';

  /* --------------------------- rendu ------------------------------- */

  function sessionBadge(a) {
    if (!a.profileExists) return { text: 'Jamais ouvert', cls: '' };
    const exp = a.sessionExpiresAt;
    if (exp === 'unknown') {
      return a.everSignedIn
        ? { text: 'Déjà connecté', cls: 'ok', title: 'État exact indisponible pendant que Claude est ouvert' }
        : { text: 'Pas encore connecté', cls: 'warn' };
    }
    if (exp === null) return { text: a.everSignedIn ? 'Déconnecté' : 'Pas encore connecté', cls: 'warn' };
    if (exp < Date.now()) return { text: 'Session expirée', cls: 'warn' };
    const days = Math.ceil((exp - Date.now()) / 86400000);
    return {
      text: days <= 5 ? `Session : ${days} j restant${days > 1 ? 's' : ''}` : 'Connecté',
      cls: days <= 5 ? 'warn' : 'ok',
      title: `Session valable jusqu’au ${fmtDate(exp)} (prolongée à chaque utilisation)`,
    };
  }

  function openLabel(a) {
    if (a.running) return 'Afficher';
    const other = state.accounts.some((x) => x.running && x.id !== a.id);
    return other && state.settings.closeOthersOnSwitch ? 'Basculer' : 'Ouvrir';
  }

  function renderCard(a) {
    const s = sessionBadge(a);
    const badges = [];
    if (a.running) badges.push(h('span', { class: 'badge ok', text: 'Ouvert' }));
    badges.push(h('span', { class: `badge ${s.cls}`, text: s.text, title: s.title }));
    if (a.kind === 'principal') {
      badges.push(h('span', { class: 'badge', text: 'Profil Claude standard', title: 'Dossier de données habituel de Claude Desktop' }));
    }
    if (a.sameAccountAs.length) {
      badges.push(h('span', { class: 'badge warn', text: `Même compte que « ${a.sameAccountAs[0]} »` }));
    }
    if (a.shortcut) badges.push(h('span', { class: 'badge kbd', text: state.shortcutLabel + a.shortcut, title: 'Raccourci global' }));

    const openBtn = h(
      'button',
      {
        class: `btn open${a.running ? '' : ' primary'}`,
        disabled: a.busy,
        onclick: () => openAccount(a),
        'aria-label': `${openLabel(a)} ${a.name}`,
      },
      a.busy ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null,
      a.busy ? 'Patience…' : openLabel(a),
    );
    const moreBtn = h(
      'button',
      { class: 'icon-btn', title: 'Plus d’actions', 'aria-label': `Actions pour ${a.name}`, 'aria-haspopup': 'menu' },
      icon('more'),
    );
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showMenu(moreBtn, a);
    });

    return h(
      'li',
      {
        class: `card${a.running ? ' running' : ''}`,
        ondblclick: (e) => {
          if (!e.target.closest('button')) openAccount(a);
        },
      },
      h(
        'div',
        { class: 'avatar', style: { background: a.color }, 'aria-hidden': 'true' },
        initials(a.name),
        a.running ? h('span', { class: 'dot' }) : null,
      ),
      h(
        'div',
        { class: 'info', title: a.lastOpenedAt ? `Dernière ouverture ${relTime(a.lastOpenedAt)}` : undefined },
        h('div', { class: 'name-row' }, h('span', { class: 'name', text: a.name, title: a.name }), a.isDefault ? icon('star', 'star') : null),
        h('div', { class: 'email', text: a.email || 'Adresse e-mail non renseignée', title: a.email || undefined }),
        h('div', { class: 'badges' }, badges),
      ),
      h('div', { class: 'card-actions' }, openBtn, moreBtn),
    );
  }

  function renderBanners() {
    const root = $('#banners');
    root.replaceChildren();
    if (!state.claude.found) {
      root.append(
        h(
          'div',
          { class: 'banner' },
          icon('alert'),
          h(
            'div',
            { class: 'grow' },
            h('strong', { text: 'Claude Desktop introuvable. ' }),
            state.claude.custom
              ? 'L’emplacement choisi n’existe plus.'
              : isWin()
                ? 'Installez-le depuis claude.ai/download, puis cliquez sur « Détecter ».'
                : 'Installez-le depuis claude.ai/download ou indiquez son emplacement.',
          ),
          h('button', { class: 'btn', onclick: () => run(() => call(api.detectClaude)) }, 'Détecter'),
          h('button', { class: 'btn', onclick: () => browseClaude() }, 'Choisir…'),
        ),
      );
    }
    const up = state.update || {};
    if (up.updating) {
      root.append(
        h(
          'div',
          { class: 'banner info' },
          h('span', { class: 'spinner', 'aria-hidden': 'true' }),
          h('div', { class: 'grow' }, h('strong', { text: 'Mise à jour de Claude en cours d’installation. ' }), 'Le compte s’ouvrira dès qu’elle sera terminée.'),
        ),
      );
    } else if (up.pending && up.openCount > 0) {
      const many = up.openCount > 1;
      root.append(
        h(
          'div',
          { class: 'banner info' },
          icon('info'),
          h(
            'div',
            { class: 'grow' },
            h('strong', { text: `Mise à jour de Claude prête${up.version ? ` (${up.version})` : ''}. ` }),
            isWin()
              ? 'Elle sera utilisée au prochain démarrage de Claude.'
              : many
                ? 'Plusieurs comptes sont ouverts : elle ne pourra s’installer qu’une fois toutes les fenêtres Claude fermées.'
                : 'Elle s’installera à la fermeture de Claude.',
          ),
          h('button', { class: 'btn', onclick: () => installUpdateDialog() }, 'Installer maintenant'),
        ),
      );
    }
    const su = state.selfUpdate || {};
    if (su.status === 'ready') {
      root.append(
        h(
          'div',
          { class: 'banner info' },
          icon('restore'),
          h('div', { class: 'grow' }, h('strong', { text: `Claude Switcher ${su.version} est prêt. ` }), 'Redémarrez l’outil pour l’installer (Claude reste ouvert).'),
          h('button', { class: 'btn primary', onclick: () => run(() => call(api.installSelfUpdate)) }, 'Redémarrer'),
        ),
      );
    } else if (su.status === 'available' && su.mode && su.mode.kind === 'manual') {
      root.append(
        h(
          'div',
          { class: 'banner info' },
          icon('info'),
          h('div', { class: 'grow' }, h('strong', { text: `Claude Switcher ${su.version} est disponible. ` }), su.mode.reason || ''),
          su.releaseUrl ? h('button', { class: 'btn', onclick: () => run(() => call(api.openSelfUpdatePage)) }, 'Télécharger') : null,
        ),
      );
    }
    if (state.shortcutFailures.length) {
      root.append(
        h(
          'div',
          { class: 'banner info' },
          icon('info'),
          h(
            'div',
            { class: 'grow' },
            `Raccourcis déjà pris par une autre application : ${state.shortcutFailures.join(', ')}. Changez de combinaison dans les réglages.`,
          ),
        ),
      );
    }
    if (state.loadReport && state.loadReport.startsWith('recovered') && !renderBanners.shownRecovery) {
      renderBanners.shownRecovery = true;
      toast('La liste des comptes a été restaurée depuis une sauvegarde.');
    }
  }

  function renderList() {
    const list = $('#accounts');
    list.replaceChildren(...state.accounts.map(renderCard));
  }

  function renderHint() {
    const hint = $('#hint');
    const parts = [];
    if (state.settings.shortcutsEnabled) parts.push(`${state.shortcutLabel}1–9 : ouvrir un compte · ${state.shortcutLabel}0 : cette fenêtre`);
    parts.push(state.accounts.length > 1 ? 'Double-clic sur un compte pour l’ouvrir' : 'Ajoutez un compte pour commencer');
    hint.textContent = parts.join('  ·  ');
  }

  function render() {
    if (!state) return;
    document.body.classList.toggle('mac', isMac());
    renderBanners();
    renderList();
    renderHint();
  }

  /* ---------------------------- actions ---------------------------- */

  async function openAccount(a) {
    try {
      const r = await call(api.openAccount, a.id);
      for (const w of r.warnings || []) toast(w);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function installUpdateDialog() {
    const open = state.accounts.filter((a) => a.running).map((a) => `« ${a.name} »`);
    const ok = await confirmDialog({
      title: 'Installer la mise à jour de Claude ?',
      body: [
        `Claude Switcher va fermer proprement ${open.length > 1 ? `les comptes ouverts (${open.join(', ')})` : open.length ? `le compte ${open[0]}` : 'Claude'}, laisser l’installateur officiel de Claude faire la mise à jour, puis rouvrir votre compte.`,
        'Les tâches Claude Code en cours dans ces fenêtres seront interrompues.',
      ],
      confirmLabel: 'Installer',
    });
    if (!ok) return;
    const r = await run(() => call(api.installUpdate));
    if (r) {
      for (const w of r.warnings || []) toast(w);
      toast('Mise à jour lancée.');
    }
  }

  async function browseClaude() {
    try {
      await call(api.browseClaude);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /* ----------------------------- menu ------------------------------ */

  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
  }

  function showMenu(anchor, a) {
    closeMenu();
    const idx = state.accounts.findIndex((x) => x.id === a.id);
    const item = (label, ic, fn, opts = {}) =>
      h(
        'button',
        {
          role: 'menuitem',
          class: opts.danger ? 'danger' : undefined,
          disabled: opts.disabled,
          onclick: () => {
            closeMenu();
            fn();
          },
        },
        icon(ic),
        label,
      );
    menuEl = h(
      'div',
      { class: 'menu', role: 'menu' },
      item('Modifier…', 'edit', () => accountForm(a)),
      item('Définir par défaut', 'star', () => run(() => call(api.setDefault, a.id), `« ${a.name} » est le compte par défaut.`), {
        disabled: a.isDefault,
      }),
      item('Monter', 'up', () => run(() => call(api.moveAccount, a.id, -1)), { disabled: idx === 0 }),
      item('Descendre', 'down', () => run(() => call(api.moveAccount, a.id, 1)), { disabled: idx === state.accounts.length - 1 }),
      h('hr'),
      item('Sauvegardes…', 'archive', () => backupsDialog(a)),
      item('Ouvrir le dossier du profil', 'folder', () => run(() => call(api.reveal, a.id))),
      item(isWin() ? 'Raccourci sur le Bureau' : 'Copier la commande de lancement', 'link', () => shortcutFor(a)),
      a.kind === 'principal' ? null : h('hr'),
      a.kind === 'principal' ? null : item('Retirer le compte…', 'trash', () => removeDialog(a), { danger: true }),
    );
    document.body.append(menuEl);
    const r = anchor.getBoundingClientRect();
    const mw = menuEl.offsetWidth;
    const mh = menuEl.offsetHeight;
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    menuEl.style.top = `${top}px`;
    menuEl.style.left = `${Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8))}px`;
    const first = menuEl.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }

  document.addEventListener('click', (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  });
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  async function run(fn, okMessage) {
    try {
      const r = await fn();
      if (okMessage) toast(okMessage);
      return r;
    } catch (e) {
      toast(e.message, 'error');
      return undefined;
    }
  }

  async function shortcutFor(a) {
    const r = await run(() => call(api.createShortcut, a.id));
    if (!r) return;
    if (r.kind === 'file') toast('Raccourci créé sur le Bureau.');
    else toast('Commande copiée : collez-la dans un raccourci (Raycast, Alfred, Automator…).');
  }

  /* ---------------------------- modales ---------------------------- */

  function openModal(build, { labelledBy } = {}) {
    closeMenu();
    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy });
    const overlay = h('div', { class: 'overlay' }, modal);
    const ctx = {
      modal,
      close: () => {
        overlay.remove();
        modalStack = modalStack.filter((m) => m !== ctx);
      },
    };
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) ctx.close();
    });
    build(modal, ctx);
    $('#modal-root').append(overlay);
    modalStack.push(ctx);
    const focusable = modal.querySelector('input, select, button.primary, button');
    if (focusable) focusable.focus();
    return ctx;
  }

  function colorPicker(selected, onPick) {
    const wrap = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Couleur' });
    const draw = (current) => {
      wrap.replaceChildren(
        ...state.colors.map((c) =>
          h('button', {
            type: 'button',
            class: 'swatch',
            role: 'radio',
            'aria-checked': c === current ? 'true' : 'false',
            'aria-label': c,
            style: { background: c },
            onclick: () => {
              onPick(c);
              draw(c);
            },
          }),
        ),
      );
    };
    draw(selected);
    return wrap;
  }

  function accountForm(a) {
    const editing = !!a;
    let color = editing ? a.color : state.colors.find((c) => !state.accounts.some((x) => x.color === c)) || state.colors[0];
    openModal(
      (m, ctx) => {
        const name = h('input', { type: 'text', id: 'f-name', maxlength: 60, required: true, placeholder: 'ex. Pro, Perso, Client X', value: editing ? a.name : '' });
        const email = h('input', { type: 'email', id: 'f-email', maxlength: 120, placeholder: 'vous@exemple.com', value: editing ? a.email : '' });
        const err = h('p', { class: 'error', role: 'alert' });
        const copyMcp = h('input', { type: 'checkbox', id: 'f-mcp', checked: true });
        const closeOthers = h('input', { type: 'checkbox', id: 'f-close', checked: isMac() });
        const submit = h('button', { class: 'btn primary', type: 'submit' }, editing ? 'Enregistrer' : 'Créer et se connecter');
        const form = h(
          'form',
          {
            onsubmit: async (e) => {
              e.preventDefault();
              err.textContent = '';
              submit.disabled = true;
              try {
                if (editing) {
                  await call(api.updateAccount, a.id, { name: name.value, email: email.value, color });
                  ctx.close();
                  toast('Compte mis à jour.');
                } else {
                  const r = await call(api.addAccount, {
                    name: name.value,
                    email: email.value,
                    color,
                    copyMcp: copyMcp.checked,
                    closeOthersForLogin: closeOthers.checked,
                  });
                  ctx.close();
                  for (const w of r.warnings || []) toast(w);
                  firstLoginDialog(name.value.trim(), email.value.trim());
                }
              } catch (ex) {
                err.textContent = ex.message;
                submit.disabled = false;
              }
            },
          },
          h('h2', { id: 'dlg-title', text: editing ? 'Modifier le compte' : 'Ajouter un compte' }),
          h('p', {
            class: 'lead',
            text: editing
              ? 'Le nom et l’e-mail servent uniquement à l’affichage.'
              : 'Un profil Claude vierge et isolé est créé pour ce compte. Vous vous y connecterez une seule fois.',
          }),
          h('div', { class: 'field' }, h('label', { for: 'f-name', text: 'Nom' }), name),
          h(
            'div',
            { class: 'field' },
            h('label', { for: 'f-email', text: 'Adresse e-mail (affichage)' }),
            email,
            h('span', { class: 'help', text: 'Aide à reconnaître le compte ; elle n’est envoyée nulle part.' }),
          ),
          h('div', { class: 'field' }, h('span', { class: 'label', text: 'Couleur' }), colorPicker(color, (c) => (color = c))),
          editing
            ? null
            : [
                h(
                  'label',
                  { class: 'check' },
                  copyMcp,
                  h('span', null, 'Copier la configuration MCP du compte principal', h('small', { text: 'Serveurs MCP de claude_desktop_config.json. Aucune session n’est copiée.' })),
                ),
                isMac()
                  ? h(
                      'label',
                      { class: 'check' },
                      closeOthers,
                      h('span', null, 'Fermer les autres comptes pendant la connexion', h('small', { text: 'Recommandé pour une connexion Google ou SSO, qui revient vers l’application ouverte.' })),
                    )
                  : h('p', { class: 'help', text: 'Astuce Windows : pour la première connexion, préférez « Continuer avec l’e-mail » (code reçu par e-mail). Le retour d’une connexion Google/SSO via le navigateur arrive dans le compte principal.' }),
              ],
          err,
          h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => ctx.close() }, 'Annuler'), submit),
        );
        m.append(form);
      },
      { labelledBy: 'dlg-title' },
    );
  }

  function firstLoginDialog(name, email) {
    openModal(
      (m, ctx) => {
        m.append(
          h('h2', { id: 'dlg-title', text: `Première connexion : ${name}` }),
          h(
            'ol',
            { class: 'steps' },
            h('li', { text: 'Une fenêtre Claude vient de s’ouvrir sur ce nouveau profil, vierge.' }),
            h('li', { text: `Connectez-vous normalement${email ? ` avec ${email}` : ''} : e-mail + code, Google ou SSO, double authentification comprise.` }),
            h('li', { text: 'C’est tout : ensuite, ce compte s’ouvrira directement, déjà connecté, en un clic ou avec son raccourci.' }),
          ),
          h('p', {
            class: 'help',
            text: 'La session reste enregistrée dans le profil, chiffrée par Claude lui-même. Claude Switcher ne la lit ni ne la copie jamais.',
          }),
          h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: () => ctx.close() }, 'Compris')),
        );
      },
      { labelledBy: 'dlg-title' },
    );
  }

  function confirmDialog({ title, body, confirmLabel, danger }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v, ctx) => {
        if (done) return;
        done = true;
        ctx.close();
        resolve(v);
      };
      const ctx = openModal(
        (m, c) => {
          m.append(
            h('h2', { id: 'dlg-title', text: title }),
            ...[].concat(body).map((p) => h('p', { class: 'lead', text: p })),
            h(
              'div',
              { class: 'modal-actions' },
              h('button', { class: 'btn', onclick: () => finish(false, c) }, 'Annuler'),
              h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, onclick: () => finish(true, c) }, confirmLabel),
            ),
          );
        },
        { labelledBy: 'dlg-title' },
      );
      const origClose = ctx.close;
      ctx.close = () => {
        origClose();
        if (!done) {
          done = true;
          resolve(false);
        }
      };
    });
  }

  async function removeDialog(a) {
    const ok = await confirmDialog({
      title: `Retirer « ${a.name} » ?`,
      body: [
        'Le profil (session, réglages, historique local de Claude Code et Cowork) sera déplacé dans la corbeille de Claude Switcher. Rien n’est supprimé définitivement.',
        'Vos conversations restent disponibles sur votre compte claude.ai.',
      ],
      confirmLabel: 'Retirer',
      danger: true,
    });
    if (!ok) return;
    const r = await run(() => call(api.removeAccount, a.id));
    if (r) toast(`« ${a.name} » a été retiré (profil placé dans la corbeille).`);
  }

  function backupsDialog(a) {
    openModal(
      (m, ctx) => {
        const list = h('ul', { class: 'backup-list' });
        const err = h('p', { class: 'error', role: 'alert' });
        const createBtn = h('button', { class: 'btn primary' }, 'Sauvegarder maintenant');

        const refresh = async () => {
          list.replaceChildren(h('li', null, h('span', { text: 'Chargement…' })));
          try {
            const items = await call(api.listBackups, a.id);
            if (!items.length) {
              list.replaceChildren(h('li', null, h('span', { text: 'Aucune sauvegarde pour ce compte.' })));
              return;
            }
            list.replaceChildren(
              ...items.map((b) =>
                h(
                  'li',
                  null,
                  h('span', { text: `${fmtDateTime(b.createdAt)} · ${fmtSize(b.sizeBytes)}` }),
                  h(
                    'button',
                    {
                      class: 'btn',
                      onclick: async () => {
                        const ok = await confirmDialog({
                          title: 'Restaurer cette sauvegarde ?',
                          body: [
                            `Le profil « ${a.name} » reviendra à son état du ${fmtDateTime(b.createdAt)}.`,
                            'Les fichiers actuels remplacés sont d’abord déplacés dans la corbeille (rien n’est supprimé). Le compte doit être fermé.',
                          ],
                          confirmLabel: 'Restaurer',
                        });
                        if (!ok) return;
                        const r = await run(() => call(api.restore, a.id, b.name));
                        if (r) toast('Sauvegarde restaurée.');
                      },
                    },
                    icon('restore'),
                    'Restaurer',
                  ),
                ),
              ),
            );
          } catch (e) {
            list.replaceChildren();
            err.textContent = e.message;
          }
        };

        createBtn.addEventListener('click', async () => {
          err.textContent = '';
          createBtn.disabled = true;
          createBtn.replaceChildren(h('span', { class: 'spinner' }), 'Sauvegarde en cours…');
          try {
            const info = await call(api.backup, a.id);
            toast(`Sauvegarde créée (${fmtSize(info.sizeBytes)}).`);
            await refresh();
          } catch (e) {
            err.textContent = e.message;
          } finally {
            createBtn.disabled = false;
            createBtn.replaceChildren('Sauvegarder maintenant');
          }
        });

        m.append(
          h('h2', { id: 'dlg-title', text: `Sauvegardes — ${a.name}` }),
          h('p', {
            class: 'lead',
            text: 'Copie complète du profil (session, réglages, sessions Claude Code et Cowork). Le compte doit être fermé. Les caches et fichiers retéléchargeables (machine virtuelle, binaire Claude Code) ne sont pas copiés.',
          }),
          list,
          err,
          h(
            'div',
            { class: 'modal-actions' },
            h('button', { class: 'btn', onclick: () => run(() => call(api.revealData, 'backups')) }, icon('folder'), 'Dossier'),
            h('button', { class: 'btn', onclick: () => ctx.close() }, 'Fermer'),
            createBtn,
          ),
        );
        refresh();
      },
      { labelledBy: 'dlg-title' },
    );
  }

  function settingsDialog() {
    openModal(
      (m, ctx) => {
        const s = state.settings;
        const save = (patch) => run(() => call(api.updateSettings, patch));
        const toggle = (key, label, help, opts = {}) => {
          const input = h('input', { type: 'checkbox', checked: !!s[key], disabled: opts.disabled });
          input.addEventListener('change', async () => {
            if (opts.confirmOff && !input.checked) {
              const ok = await confirmDialog({
                title: 'Autoriser plusieurs comptes ouverts ?',
                body: [
                  'Tant que plusieurs comptes sont ouverts, Claude ne peut pas installer ses mises à jour, et chaque instance peut relancer le téléchargement de la mise à jour dans le même dossier que les autres.',
                  'Pensez à tout fermer régulièrement (ou utilisez « Installer maintenant » quand une mise à jour est prête).',
                ],
                confirmLabel: 'Autoriser',
              });
              if (!ok) {
                input.checked = true;
                return;
              }
            }
            save({ [key]: input.checked });
          });
          return h('label', { class: 'check' }, input, h('span', null, label, help ? h('small', { text: help }) : null));
        };
        const prefix = h(
          'select',
          { 'aria-label': 'Combinaison de touches' },
          state.prefixes.map((p) => h('option', { value: p.value, selected: p.value === s.shortcutPrefix }, `${p.label} + chiffre`)),
        );
        prefix.addEventListener('change', () => save({ shortcutPrefix: prefix.value }));

        m.append(
          h('h2', { id: 'dlg-title', text: 'Réglages' }),

          h('div', { class: 'section-title', text: 'Claude Desktop' }),
          h('div', { class: 'path', text: state.claude.label || state.claude.path || 'Introuvable' }),
          h(
            'div',
            { class: 'row', style: { marginTop: '8px' } },
            h('button', { class: 'btn', onclick: () => run(() => call(api.detectClaude), 'Détection terminée.') }, 'Détection automatique'),
            h('button', { class: 'btn', onclick: () => browseClaude() }, 'Choisir…'),
          ),
          isWin()
            ? h('p', {
                class: 'help',
                text: 'Avec l’installateur moderne (MSIX), Claude est rangé dans un dossier protégé de Windows (C:\\Program Files\\WindowsApps) qu’on ne peut pas parcourir : utilisez « Détection automatique ». « Choisir… » ne sert qu’à l’ancienne installation (%LOCALAPPDATA%\\AnthropicClaude\\claude.exe).',
              })
            : null,

          h('div', { class: 'section-title', text: 'Bascule' }),
          toggle(
            'closeOthersOnSwitch',
            'Un seul compte ouvert à la fois (recommandé)',
            'Indispensable aux mises à jour : Claude ne peut s’installer que lorsque toutes ses fenêtres sont fermées, et plusieurs instances ouvertes se disputent sa mise à jour. Claude est fermé proprement, jamais de force ; fermer un compte interrompt ses tâches Claude Code en cours.',
            { confirmOff: true },
          ),
          toggle('hideAfterOpen', 'Masquer cette fenêtre après l’ouverture d’un compte'),

          h('div', { class: 'section-title', text: 'Raccourcis clavier globaux' }),
          toggle('shortcutsEnabled', 'Activer les raccourcis', `${state.shortcutLabel}1 à 9 : ouvrir le compte n° 1 à 9 · ${state.shortcutLabel}0 : afficher cette fenêtre`),
          h('div', { class: 'field' }, prefix),

          h('div', { class: 'section-title', text: 'Démarrage' }),
          toggle(
            'launchAtLogin',
            'Lancer Claude Switcher à l’ouverture de session',
            state.packaged ? null : 'Disponible dans la version installée de l’application.',
            { disabled: !state.packaged },
          ),
          toggle('openDefaultOnLaunch', 'Ouvrir le compte par défaut au lancement de Claude Switcher'),

          h('div', { class: 'section-title', text: 'Mises à jour de Claude Switcher' }),
          selfUpdateSection(),

          h('div', { class: 'section-title', text: 'Données' }),
          h('div', { class: 'path', text: state.dataRoot }),
          h(
            'div',
            { class: 'row', style: { marginTop: '8px' } },
            h('button', { class: 'btn', onclick: () => run(() => call(api.revealData, 'root')) }, icon('folder'), 'Ouvrir'),
            h('button', { class: 'btn', onclick: () => run(() => call(api.revealData, 'backups')) }, 'Sauvegardes'),
            h('button', { class: 'btn', onclick: () => run(() => call(api.revealData, 'trash')) }, 'Corbeille'),
          ),
          h('p', { class: 'help', style: { marginTop: '14px' }, text: `Claude Switcher ${state.version} — aucun identifiant ni jeton n’est stocké par cet outil.` }),
          h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: () => ctx.close() }, 'Terminé')),
        );
      },
      { labelledBy: 'dlg-title' },
    );
  }

  function selfUpdateText(su) {
    switch (su.status) {
      case 'checking':
        return 'Recherche en cours…';
      case 'up-to-date':
        return `À jour (vérifié ${su.lastCheck ? relTime(su.lastCheck) : ''}).`;
      case 'available':
        return su.mode && su.mode.kind === 'manual' ? `Version ${su.version} disponible. ${su.mode.reason || ''}` : `Version ${su.version} disponible.`;
      case 'downloading':
        return `Téléchargement de la version ${su.version}… ${Math.round((su.progress || 0) * 100)} %`;
      case 'ready':
        return `Version ${su.version} téléchargée et vérifiée : prête à installer.`;
      case 'error':
        return `Échec : ${su.error}`;
      default:
        return su.lastCheck ? `Dernière vérification ${relTime(su.lastCheck)}.` : 'Pas encore vérifié.';
    }
  }

  function selfUpdateSection() {
    const su = state.selfUpdate || {};
    const wrap = h('div');
    if (!su.configured) {
      wrap.append(
        h('p', {
          class: 'help',
          text: 'Source non configurée : renseignez « updateRepository » (propriétaire/dépôt GitHub) dans package.json, puis publiez avec « npm run release ».',
        }),
      );
      return wrap;
    }
    const input = h('input', { type: 'checkbox', checked: !!su.autoUpdate });
    input.addEventListener('change', () => run(() => call(api.updateSettings, { autoUpdate: input.checked })));
    const status = h('p', { class: 'help', text: `Version installée : ${su.currentVersion} · ${selfUpdateText(su)}` });
    const checkBtn = h('button', { class: 'btn', disabled: su.status === 'checking' || su.status === 'downloading' }, 'Rechercher maintenant');
    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true;
      const r = await run(() => call(api.checkSelfUpdate));
      checkBtn.disabled = false;
      if (r) status.textContent = `Version installée : ${r.currentVersion} · ${selfUpdateText(r)}`;
    });
    wrap.append(
      h(
        'label',
        { class: 'check' },
        input,
        h('span', null, 'Rechercher et télécharger automatiquement les mises à jour', h('small', { text: `Source : github.com/${su.repo} — chaque version est vérifiée (signature Ed25519 et SHA-512) avant installation.` })),
      ),
      status,
      h(
        'div',
        { class: 'row' },
        checkBtn,
        su.status === 'ready' ? h('button', { class: 'btn primary', onclick: () => run(() => call(api.installSelfUpdate)) }, 'Redémarrer et installer') : null,
        su.status === 'available' && su.releaseUrl ? h('button', { class: 'btn', onclick: () => run(() => call(api.openSelfUpdatePage)) }, 'Page de la version') : null,
      ),
    );
    return wrap;
  }

  /* ---------------------------- clavier ---------------------------- */

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (menuEl) return closeMenu();
      const top = modalStack[modalStack.length - 1];
      if (top) return top.close();
      api.hideWindow();
      return undefined;
    }
    if (modalStack.length || menuEl || !state) return undefined;
    if (e.metaKey || e.ctrlKey || e.altKey) return undefined;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return undefined;
    if (/^[1-9]$/.test(e.key)) {
      const a = state.accounts[Number(e.key) - 1];
      if (a) openAccount(a);
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      accountForm(null);
    } else if (e.key === ',') {
      settingsDialog();
    }
    return undefined;
  });

  /* ----------------------------- départ ---------------------------- */

  $('#btn-add').addEventListener('click', () => accountForm(null));
  $('#btn-settings').addEventListener('click', () => settingsDialog());

  api.onState((s) => {
    state = s;
    render();
  });
  call(api.getState)
    .then((s) => {
      state = s;
      render();
    })
    .catch((e) => toast(e.message, 'error'));

  // Rafraîchit les dates relatives et l'état des sessions.
  setInterval(() => {
    if (!modalStack.length) render();
  }, 60000);
})();
