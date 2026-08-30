/*
 * Help & Support view.
 *
 * Provides direct contact to help@chikatistudio.com with prefilled diagnostics,
 * topic presets, copy options, and links to the local FAQ guide.
 */

import { Bridge } from '../bridge.js';
import { icon, toast, h } from '../ui.js';

const SUPPORT_EMAIL = 'help@chikatistudio.com';

const TOPICS = [
  { id: 'general', label: 'General Help / Feedback', subject: '[Vitta Vriksha] Help & Feedback' },
  { id: 'bug', label: 'Report an Issue / Bug', subject: '[Vitta Vriksha] Bug Report' },
  { id: 'sms', label: 'Bank SMS Tracking Help', subject: '[Vitta Vriksha] SMS Tracking Issue' },
  { id: 'data', label: 'Backup / Data Help', subject: '[Vitta Vriksha] Backup & Data Question' },
];

export async function renderSupport(container, app) {
  let selectedTopic = TOPICS[0];

  const paint = () => {
    container.innerHTML = `
      <div class="card-accent">
        <div class="row" style="gap:12px">
          ${icon('help', 'icon-lg')}
          <span class="banner-main">
            <span class="title">How can we help?</span>
            <span class="caption" style="color:inherit;opacity:0.9">
              Questions, bug reports, and feedback.
            </span>
          </span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Contact Support</div>
        <p class="caption" style="margin-bottom:var(--gap-3)">
          Send an email directly to help@chikatistudio.com.
        </p>

        <div class="field" style="margin-bottom:var(--gap-3)">
          <label class="field-label">Topic</label>
          <div class="chip-scroller" data-topics style="margin-bottom:0">
            ${TOPICS.map((t) => `
              <button type="button" class="chip" data-topic="${t.id}"
                      aria-selected="${t.id === selectedTopic.id}">
                ${h(t.label)}
              </button>`).join('')}
          </div>
        </div>

        <div class="card-flat" style="margin-bottom:var(--gap-3);background:var(--surface-container-highest)">
          <div class="row-between" style="align-items:center">
            <div style="display:flex;align-items:center;gap:8px">
              ${icon('help', 'icon-sm')}
              <span style="font-weight:600;font-size:14px;color:var(--on-surface)">${SUPPORT_EMAIL}</span>
            </div>
            <button type="button" class="btn btn-outlined" data-copy-email style="padding:4px 10px;font-size:12px;min-height:30px">
              ${icon('content_copy', 'icon-sm')}Copy
            </button>
          </div>
        </div>

        <button type="button" class="btn btn-filled btn-block" data-compose-email>
          ${icon('arrow_forward')}Send Email
        </button>
      </div>

      <div class="card">
        <div class="card-title">Resources</div>
        <div class="list" style="box-shadow:none;background:transparent">
          <button type="button" class="list-row" data-open-faq style="padding-left:0;padding-right:0">
            <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
              ${icon('menu_book', 'icon-sm')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">Guide & FAQ</span>
              <span class="list-row-sub">Answers to commonly asked questions</span>
            </span>
            ${icon('chevron_right', 'icon-sm')}
          </button>
          <button type="button" class="list-row" data-open-security style="padding-left:0;padding-right:0">
            <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
              ${icon('lock', 'icon-sm')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">Security & Privacy</span>
              <span class="list-row-sub">How your data stays private and on-device</span>
            </span>
            ${icon('chevron_right', 'icon-sm')}
          </button>
        </div>
      </div>`;

    container.querySelectorAll('[data-topic]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const found = TOPICS.find((t) => t.id === btn.dataset.topic);
        if (found) {
          selectedTopic = found;
          paint();
        }
      });
    });

    const copyBtn = container.querySelector('[data-copy-email]');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(SUPPORT_EMAIL);
          }
          toast(`Copied ${SUPPORT_EMAIL}`, 'info');
        } catch {
          toast(SUPPORT_EMAIL, 'info');
        }
      });
    }

    const composeBtn = container.querySelector('[data-compose-email]');
    if (composeBtn) {
      composeBtn.addEventListener('click', () => {
        const bodyLines = [
          'Hi Vitta Vriksha Support Team,',
          '',
          '[Please describe your question or issue here]',
          '',
          '---',
          'App: Vitta Vriksha',
          `Platform: ${Bridge.isAndroid() ? 'Android' : 'Web/Desktop'}`,
          `Currency: ${app.currency || 'INR'}`,
          `Locale: ${app.locale || 'en-IN'}`,
        ];
        Bridge.openEmail(SUPPORT_EMAIL, selectedTopic.subject, bodyLines.join('\n'));
      });
    }

    const openFaqBtn = container.querySelector('[data-open-faq]');
    if (openFaqBtn) {
      openFaqBtn.addEventListener('click', () => {
        if (app?.open) app.open('guide');
        else if (app?.openPage) app.openPage('guide');
      });
    }

    const openSecBtn = container.querySelector('[data-open-security]');
    if (openSecBtn) {
      openSecBtn.addEventListener('click', () => {
        if (app?.open) app.open('security');
        else if (app?.openPage) app.openPage('security');
      });
    }
  };

  paint();
}
