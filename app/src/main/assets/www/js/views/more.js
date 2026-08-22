import { Bridge } from '../bridge.js';
import { icon } from '../ui.js';
import { navRow, bindNavRows } from './shared.js';
import { openOnboardingTour } from './onboarding-tour.js';

export async function renderMore(container, app) {
  const smsGranted = Bridge.checkPermission('SMS');
  const smsOn = smsGranted && Bridge.isSmsTrackingEnabled();
  const smsSub = smsOn ? 'Active' : (smsGranted ? 'Paused' : 'Off');

  container.innerHTML = `
    <div class="card-accent">
      <div class="row" style="gap:12px">
        ${icon('verified_user', 'icon-lg')}
        <span class="banner-main">
          <span class="title">100% Offline & Private</span>
          <span class="caption" style="color:inherit;opacity:0.8">
            No internet permission. All data stays strictly on your device.
          </span>
        </span>
      </div>
    </div>

    <div class="section">
      <div class="section-header"><span class="title">Analytics</span></div>
      <div class="list">
        ${navRow('insights', 'query_stats', 'Insights',
          'Trends and flow analysis')}
        ${navRow('recurring', 'autorenew', 'Recurring payments',
          'Detected repeating payments')}
      </div>
    </div>

    <div class="section">
      <div class="section-header"><span class="title">Data & Family</span></div>
      <div class="list">
        ${navRow('backup', 'backup', 'Backup & Restore', 'Encrypted database backup')}
        ${app.familyEnabled ? navRow('family', 'group', 'Household', 'Family member profiles') : ''}
        ${navRow('rules', 'sms', 'Bank SMS tracking',
          smsSub,
          smsGranted ? '' : 'Set up')}
        ${navRow('delete-data', 'delete', 'Delete data', 'Erase specific records or reset app')}
      </div>
    </div>

    <div class="section">
      <div class="section-header"><span class="title">Preferences & Help</span></div>
      <div class="list">
        ${navRow('settings', 'tune', 'Settings', 'Theme, currency & preferences')}
        ${navRow('security', 'lock', 'Security', 'PIN & permissions')}
        ${navRow('guide', 'menu_book', 'Guide & FAQ', 'App guide and FAQ')}
        ${navRow('support', 'help', 'Help & Support', 'Contact us at help@chikatistudio.com')}
        ${navRow('about', 'info', 'About', 'Version & licenses')}
      </div>
    </div>`;

  bindNavRows(container, app);
}
