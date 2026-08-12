/* About, licences and credits. */

import { Bridge } from '../bridge.js';
import { icon, h } from '../ui.js';
import { brandMark } from '../brand-mark.js';

const CREDITS = [
  ['SQLite', 'D. Richard Hipp and contributors', 'Public domain'],
  ['pdf.js', 'Mozilla', 'Apache 2.0'],
  ['casparser', 'Sandeep Somasekharan', 'MIT'],
  ['casparser-isin', 'Sandeep Somasekharan', 'MIT'],
  ['Material Symbols', 'Google', 'Apache 2.0'],
];

export async function renderAbout(container, app) {
  // The reference database is updated on its own schedule, so which one is bundled is
  // worth being able to see rather than having to work out from the build date.
  const reference = await Bridge.call('cas', { action: 'versions' }).catch(() => null);
  container.innerHTML = `
    <div class="card" style="text-align:center">
      <div class="lock-mark" style="margin:0 auto 16px">${brandMark()}</div>
      <div class="headline">Vitta Vriksha</div>
      <div class="caption">Version 1.0.0</div>
      <p class="caption" style="margin-top:12px">
        A personal finance tracker for Indian households that keeps everything on the device
        it runs on.
      </p>
    </div>

    <div class="card">
      <div class="card-title">What the app can and cannot do</div>
      <div style="display:flex;flex-direction:column;gap:12px">
        ${claim('cloud_off', 'No network access', 'The app declares no INTERNET permission, so it cannot send your data anywhere even if it tried.')}
        ${claim('key', 'Encrypted exports', 'Backups use AES-GCM with a key derived from your password through PBKDF2.')}
        ${claim('sms', 'Optional SMS reading', 'Off unless you grant it. Messages are matched on device and never stored in full.')}
        ${claim('science', 'Calculations are estimates', 'Retirement and prepayment figures are planning tools, not financial advice.')}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Built with</div>
      <div class="list" style="box-shadow:none;background:transparent">
        ${CREDITS.map(([name, author, licence]) => `
          <div class="list-row" style="padding-left:0;padding-right:0">
            <span class="list-row-main">
              <span class="list-row-title">${h(name)}</span>
              <span class="list-row-sub">${h(author)}</span>
            </span>
            <span class="badge">${h(licence)}</span>
          </div>`).join('')}
      </div>
      <p class="caption" style="margin-top:12px">
        Vitta Vriksha itself is released under the MIT licence. The statement parser is a
        JavaScript port of casparser, and carries its layout heuristics, its tax rules and
        its tests.
      </p>
    </div>

    ${reference && reference.status === 'success' ? `
      <div class="card">
        <div class="card-title">Bundled data</div>
        <div class="row-between" style="padding:3px 0">
          <span class="caption">Statement parser</span>
          <span class="caption" style="color:var(--on-surface);font-weight:600">${h(reference.parser)}</span>
        </div>
        <div class="row-between" style="padding:3px 0">
          <span class="caption">Scheme reference data</span>
          <span class="caption" style="color:var(--on-surface);font-weight:600">${h(reference.reference_data || 'not loaded')}</span>
        </div>
      </div>` : ''}

    <div class="card">
      <div class="card-title">Contact & Support</div>
      <p class="caption" style="margin-bottom:var(--gap-3)">
        Built by Chikati Studio. For help, feedback or inquiries, contact us at:
      </p>
      <button type="button" class="btn btn-filled btn-block" data-contact-support>
        ${icon('mail')}help@chikatistudio.com
      </button>
    </div>`;

  const contactBtn = container.querySelector('[data-contact-support]');
  if (contactBtn && app?.openPage) {
    contactBtn.addEventListener('click', () => app.openPage('support'));
  }
}

function claim(glyph, title, body) {
  return `
    <div class="row" style="align-items:flex-start;gap:12px">
      <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface-variant)">${icon(glyph)}</span>
      <span class="list-row-main">
        <span class="list-row-title">${h(title)}</span>
        <span class="caption">${h(body)}</span>
      </span>
    </div>`;
}
