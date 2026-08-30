/*
 * The guide: what the app does, and the questions it keeps being asked.
 *
 * Written as prose rather than as a feature list, because the things people get stuck on
 * are rarely "where is the button". They are "why did that number change", "is this
 * leaving my phone", and "what happens if I lose the device".
 */

import { icon, h } from '../ui.js';
import { Bridge } from '../bridge.js';
import { openOnboardingTour } from './onboarding-tour.js';

const SECTIONS = [
  {
    title: 'The short version',
    body: [
      'Everything you enter stays on this device. The app has no internet permission, '
      + 'which is not a setting but a property of the build: there is no code path that '
      + 'could send your data anywhere, because the operating system would refuse.',
      'That has a consequence worth being clear about. If you lose the phone and have no '
      + 'backup, the data is gone. Nobody can recover it for you, including us.',
    ],
  },
  {
    title: 'Following a number back to where it came from',
    body: [
      'Every chart in the app leads somewhere. Tap a bar and the screen moves to that day, '
      + 'week or month; tap a category, a shop or a person and you get its own history and '
      + 'the entries behind it. Nothing is a dead end, so a figure that looks wrong can '
      + 'always be taken apart until the transaction that caused it is on screen.',
      'Insights, under More, is where that starts. Choose whether you are looking at money '
      + 'going out, coming in or being invested, choose days, weeks or months, and step back '
      + 'through the periods with the arrows. Everything below follows what you chose.',
      'Home works the same way. A panel with a chart on it can be tapped through to the same '
      + 'period, and the panels themselves are yours to pick: add one, set what it charts and '
      + 'over how long, and add it again pointed at something else.',
    ],
    faqs: [
      ['I tapped a month and nothing happened.',
        'A bar that is already selected opens the period in full. One that is not selected '
        + 'moves the screen to it first, so the headline, the breakdown and the calendar all '
        + 'describe the same period.'],
      ['Why does a week start on Monday?',
        'One answer had to be picked so that a week means the same thing everywhere in the '
        + 'app. Monday is the one a bank statement and a working month both follow here.'],
      ['A comparison says nothing to compare with.',
        'There is no period before it in your records. The moment there is, the comparison '
        + 'appears without you doing anything.'],
    ],
  },
  {
    title: 'Subscriptions and SIPs you never typed in',
    body: [
      'Under Wealth, Recurring payments, the app reads your own transactions and looks for '
      + 'money that leaves on a rhythm: the same shop, roughly the same amount, at a steady '
      + 'interval. It has to appear at least three times before it counts, which is what '
      + 'keeps a weekly grocery run out of the list.',
      'What it finds is a suggestion until you file it. File it as a subscription or as an '
      + 'investment SIP, and it joins the ordinary lists under Wealth with its price history '
      + 'already filled in from the payments that were read.',
      'The same reading is what notices a price rise. A plan on file at one amount that is '
      + 'actually being debited another is reported, with the date the price moved, and '
      + 'updating it keeps the old figure as history rather than overwriting it.',
    ],
    faqs: [
      ['Something in the list is not a subscription.',
        'Tap "Not a plan" and it is set aside. It stays out of the list until you bring it '
        + 'back, which you can do from the bottom of the same screen.'],
      ['It found a plan I already track.',
        'Then it is listed as tracked rather than offered, and matched to the record by the '
        + 'shop name. If the two names are nothing like each other, file the suggestion and '
        + 'delete the older record.'],
      ['Nothing was found at all.',
        'Either the payments are not in the app yet, or they are recorded without a shop '
        + 'name: the grouping is by who was paid, so a transaction with no counterparty '
        + 'cannot be matched to anything. Widening the window at the bottom of the screen '
        + 'helps if your history is short.'],
    ],
  },
  {
    title: 'Amounts that go up every year',
    body: [
      'A SIP can carry a yearly step-up and a subscription can carry a yearly price rise. '
      + 'Both are a percentage and a date to count anniversaries from, and both are used by '
      + 'the projections, so what you are committed to next year is worked out rather than '
      + 'assumed to be this year repeated twelve times.',
      'A negative percentage steps the amount down, for an instalment you are winding back '
      + 'rather than up. A step-up can also be pinned to a calendar month, which is what a '
      + 'mandate written to rise every April does.',
      'The SIP and subscription screens each show the next twelve months with all of that '
      + 'applied, and say which of them are rising.',
    ],
    faqs: [
      ['My step-up is not showing in the projection.',
        'A percentage needs a date to count from. Check the started date on the SIP, or the '
        + '"price since" date on a subscription: without one there are no anniversaries to '
        + 'apply, so the amount stays flat.'],
      ['Should I edit the amount or record a price change?',
        'Record a price change. Editing overwrites what the plan used to cost; a price '
        + 'change keeps it, which is what lets the app show you what has happened to this '
        + 'plan over the years.'],
    ],
  },
  {
    title: 'Getting your investments in (CAS Statements)',
    body: [
      'Ask CAMS, KFintech, or MF Central for a consolidated account statement (CAS) and they email you a password-protected PDF covering your mutual funds. Ask NSDL or CDSL instead and you get the same funds plus your demat account: shares, bonds, and any National Pension System (NPS) holdings.',
      'Import it under Wealth &rarr; Account statement. It is read entirely on this device. The password is usually your PAN in uppercase (e.g. ABCDE1234F).',
      'Your name and PAN appear in these statements. Neither is ever stored or uploaded: the app is completely offline and has zero internet permissions.',
    ],
    faqs: [
      ['Where can I download my Mutual Fund CAS?',
        'You can request a free Detailed CAS statement online directly from:<br>'
        + '· <button class="btn btn-tonal btn-xs" data-open-url="https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement">CAMS Online CAS</button><br>'
        + '· <button class="btn btn-tonal btn-xs" data-open-url="https://mfs.kfintech.com/investor/General/CAS">KFintech CAS Portal</button><br>'
        + '· <button class="btn btn-tonal btn-xs" data-open-url="https://www.mfcentral.com">MF Central (Unified CAMS + KFintech)</button><br><br>'
        + '<strong>Key settings when requesting:</strong><br>'
        + '1. Choose <strong>Detailed Statement</strong> (includes all transactions) rather than Summary.<br>'
        + '2. Set the start date back to when you began investing (e.g. <code>01-01-1990</code>) so your entire purchase history is included.<br>'
        + '3. Choose your preferred PDF password (usually your PAN in capitals). The statement arrives in your email inbox within a few minutes.'],
      ['Where can I download my CDSL or NSDL Demat eCAS?',
        'For a consolidated view of all demat shares, ETFs, bonds, mutual funds and NPS:<br>'
        + '· <button class="btn btn-tonal btn-xs" data-open-url="https://www.cdslindia.com/cas/logincas.aspx">CDSL eCAS Login</button> (Log in with your 16-digit Demat BO ID & PAN)<br>'
        + '· <button class="btn btn-tonal btn-xs" data-open-url="https://eservices.nsdl.com/kyc-web/#/casLogin">NSDL eCAS Portal</button> (Log in with DP ID + Client ID or CAS ID & PAN)<br><br>'
        + 'Download the monthly or annual eCAS PDF and import it under Wealth &rarr; Account statement.'],
      ['What does the detailed statement give me that a summary does not?',
        'Every SIP purchase, redemption, dividend, and switch, with the exact date, NAV, and stamp duty. A summary statement only lists what you hold today, so it cannot calculate your profit/loss, holding periods, or capital gains. A detailed statement builds your full historical ledger.'],
      ['It says the file has no readable text.',
        'The file is a scanned image or picture rather than the original PDF generated by CAMS/KFintech/CDSL/NSDL. Import the original digital PDF received via email.'],
    ],
  },
  {
    title: 'Equity trades & stock capital gains',
    body: [
      'Depository eCAS statements from NSDL and CDSL provide a snapshot of current demat holdings (shares held and closing valuation), but they do NOT include historical buy/sell execution prices, trade dates, or broker brokerage fees.',
      'To calculate exact stock capital gains, FIFO lot allocations, and Schedule 112A filings, you can import your broker’s Tradebook CSV directly in Vitta Vriksha under Wealth &rarr; Investments &rarr; Import CSV.',
    ],
    faqs: [
      ['Why does NSDL/CDSL eCAS not have stock trade history?',
        'Depositories (CDSL/NSDL) act as custody vaults holding your shares. Your actual buy and sell orders, brokerage charges, STT taxes, and order executions occur with your stock broker (Zerodha, Groww, Upstox, etc.). Depositories only record the net daily share transfers in and out of your demat account.'],
      ['How do I download my Broker Tradebook CSV?',
        'Log in to your broker console and download your all-time Tradebook report as a CSV or Excel file:<br>'
        + '· <button class="btn btn-tonal btn-xs" data-open-url="https://console.zerodha.com/reports/tradebook">Zerodha Console</button>: Reports &rarr; Tradebook &rarr; Select Date Range &rarr; Download CSV.<br>'
        + '· <button class="btn btn-tonal btn-xs" data-open-url="https://groww.in/user/profile/reports">Groww</button>: Profile &rarr; Reports &rarr; Stocks &rarr; Download Tradebook / P&L Excel or CSV.<br>'
        + '· <button class="btn btn-tonal btn-xs" data-open-url="https://login.upstox.com">Upstox</button>: Account &rarr; Reports &rarr; Tradebook CSV.<br>'
        + '· <button class="btn btn-tonal btn-xs" data-open-url="https://trade.angelone.in">Angel One</button>: Reports &rarr; Tradebook / Transaction Summary CSV.<br>'
        + '· <strong>Dhan / Kotak Neo / ICICI Direct / Shoonya / HDFC Sky</strong>: Statements / Tradebook CSV.<br><br>'
        + 'Then open <strong>Wealth &rarr; Investments</strong> and tap <strong>Import CSV</strong>.'],
    ],
  },
  {
    title: 'Capital gains & tax calculations',
    body: [
      'From detailed mutual fund statements and broker tradebooks, the app computes your exact statutory realised gains: First-In First-Out (FIFO) matching, Section 112A Grandfathering (Jan 31, 2018 benchmark NAVs), purchase-side stamp duty inclusion, and STT exclusion.',
      'It also applies the Budget 2024 statutory regime split: 15% vs 20% STCG and 10% vs 12.5% LTCG with the ₹1.25 Lakh exemption limit for trades executed on or after July 23, 2024.',
      'You can export the official Schedule 112A CSV to verify against your broker’s tax statements or attach for CA filing.',
    ],
    faqs: [
      ['It says the statement does not go back far enough.',
        'Capital gains calculations need the purchase lots a sale is matched against. Request a CAS or Tradebook with a start date before your earliest purchase.'],
      ['A scheme was left out of the report.',
        'Usually gifted units or off-market transfers: their original cost basis and holding period belong to the donor and are not in the statement.'],
    ],
  },
  {
    title: 'Bank messages',
    body: [
      'With permission, the app reads alerts as they arrive and files the ones a rule '
      + 'recognises. A rule is a phrase to look for and what to do when it appears; the '
      + 'defaults cover the common banks and you can add your own under More, Bank SMS '
      + 'tracking.',
      'Turning it on later is not a problem. Settings has a button that reads the messages '
      + 'already on the phone and files what it recognises.',
      'Only messages that look financial are ever read. An ordinary conversation is '
      + 'filtered out before anything looks at it.',
    ],
    faqs: [
      ['A message was read but nothing was filed.',
        'No rule matched it. The app will not invent a transaction from a message it had '
        + 'to guess at; add a rule with a phrase from that message and read the past '
        + 'messages in again.'],
    ],
  },
  {
    title: 'Money you lent',
    body: [
      'A loan works the same arithmetic whichever way the money went, so both live under '
      + 'Loans. Mark it as borrowed and it counts against your net worth; mark it as lent '
      + 'and it counts towards it, because somebody owes it to you.',
    ],
  },
  {
    title: 'Backups',
    body: [
      'Under More, Backup and restore. The export is a single encrypted file: the password '
      + 'you choose is the only thing protecting it, and it is the only thing that can '
      + 'open it. There is no recovery if you forget it.',
      'Keep one somewhere other than this phone. A backup that only exists on the device '
      + 'it is backing up is not a backup.',
    ],
    faqs: [
      ['Can I move to a new phone?',
        'Export from the old one, install on the new one, restore. The file format has '
        + 'not changed across versions, so an old export still restores.'],
    ],
  },
  {
    title: 'Privacy',
    body: [
      'No internet permission. No analytics, no crash reporting, no advertising identifier. '
      + 'Backups are excluded from Android’s automatic cloud backup on purpose, so your '
      + 'ledger is not quietly copied off the device by the system either.',
      'Your unlock PIN is stored as a salted hash, so the app can tell whether a PIN is '
      + 'right without ever holding the PIN itself.',
    ],
    faqs: [
      ['How do I know my bank data isn’t being uploaded?',
        'Check Settings → Apps → Vitta Vriksha → Permissions on your phone. Network/Internet '
        + 'permission is not requested at all. Android blocks apps without internet access from opening network connections.'],
      ['What happens to my CAS PDF statement when I import it?',
        'It is parsed on-device using WebAssembly. Your PAN and statement file stay on your phone and are never sent anywhere.'],
      ['Where is my financial data stored?',
        'Everything is stored in a local SQLite database file on your device. It stays encrypted if you set a PIN in the app.'],
      ['What if I lose my backup password?',
        'Backups are encrypted using AES-GCM on your device. There are no cloud servers, reset links, or backdoor keys. If you lose your password, the backup file cannot be decrypted by anyone, including us.'],
      ['Is the code open source?',
        'Yes, Vitta Vriksha is built under the MIT licence. You can inspect every line of code, build it yourself, or download it via F-Droid.'],
    ],
  },
];

export async function renderGuide(container, app) {
  container.innerHTML = `
    <div class="card-accent">
      <div class="row" style="gap:12px">
        ${icon('menu_book', 'icon-lg')}
        <span class="banner-main">
          <span class="title">How this works</span>
          <span class="caption" style="color:inherit;opacity:0.85">
            Written for the questions people actually ask.
          </span>
        </span>
      </div>
    </div>

    <div class="card" style="border:1px solid var(--accent);background:var(--surface-container-low)">
      <div class="row-between" style="align-items:center;margin-bottom:8px">
        <div class="row" style="gap:8px;align-items:center">
          <span style="color:var(--accent);display:flex">${icon('rocket_launch', 'icon-sm')}</span>
          <span style="font-weight:700;font-size:14px">App Walkthrough</span>
        </div>
        <span class="badge badge-income">8 steps</span>
      </div>
      <p class="caption" style="margin-bottom:12px">
        Step through tabs and key features in an interactive walkthrough.
      </p>
      <button type="button" class="btn btn-filled btn-block" data-guide-tour style="gap:8px">
        ${icon('rocket_launch', 'icon-sm')}Start Tour
      </button>
    </div>

    ${SECTIONS.map((section) => `
      <div class="card">
        <div class="card-title">${h(section.title)}</div>
        ${section.body.map((paragraph) => `
          <p class="caption" style="margin-bottom:10px">${h(paragraph)}</p>`).join('')}

        ${(section.faqs || []).map(([question, answer]) => `
          <details class="card-flat" style="margin-top:10px">
            <summary class="title" style="cursor:pointer;list-style:none">
              <span class="row-between">
                <span>${h(question)}</span>
                ${icon('expand_more', 'icon-sm')}
              </span>
            </summary>
            <div class="caption" style="margin-top:10px;line-height:1.5">${answer}</div>
          </details>`).join('')}
      </div>`).join('')}

    <div class="card">
      <div class="card-title">Still have questions?</div>
      <p class="caption" style="margin-bottom:var(--gap-3)">
        For questions or bug reports, email help@chikatistudio.com.
      </p>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-filled" data-open-email style="flex:1;min-width:120px">
          ${icon('help')}Email
        </button>
        <button type="button" class="btn btn-tonal" data-open-support-hub style="flex:1;min-width:120px">
          ${icon('help')}Support
        </button>
      </div>
    </div>`;

  container.querySelectorAll('[data-open-url]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const url = el.dataset.openUrl;
      if (url) Bridge.openUrl(url);
    });
  });

  const tourBtn = container.querySelector('[data-guide-tour]');
  if (tourBtn) {
    tourBtn.addEventListener('click', () => openOnboardingTour(app));
  }

  const emailBtn = container.querySelector('[data-open-email]');
  if (emailBtn) {
    emailBtn.addEventListener('click', () => {
      Bridge.openEmail(
        'help@chikatistudio.com',
        '[Vitta Vriksha] Support Request',
        'Hi Vitta Vriksha Support Team,\n\nI have a question regarding:\n\n---\nApp: Vitta Vriksha\n',
      );
    });
  }

  const supportHubBtn = container.querySelector('[data-open-support-hub]');
  if (supportHubBtn) {
    supportHubBtn.addEventListener('click', () => {
      if (app?.open) app.open('support');
      else if (app?.openPage) app.openPage('support');
    });
  }
}
