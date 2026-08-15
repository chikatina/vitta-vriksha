/*
 * The guide: what the app does, and the questions it keeps being asked.
 *
 * Written as prose rather than as a feature list, because the things people get stuck on
 * are rarely "where is the button". They are "why did that number change", "is this
 * leaving my phone", and "what happens if I lose the device".
 */

import { icon, h } from '../ui.js';
import { Bridge } from '../bridge.js';

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
    title: 'Getting your investments in',
    body: [
      'Ask CAMS or KFintech for a consolidated account statement and they email you a '
      + 'password-protected PDF covering your mutual funds. Ask NSDL or CDSL instead and '
      + 'you get the same funds plus your demat account: shares, bonds, and any National '
      + 'Pension System holdings.',
      'Import it under Wealth, Account statement. It is read on this device. The password '
      + 'is usually your PAN in capitals.',
      'Your name and PAN appear in these statements. Neither is stored: the app has no '
      + 'use for them and not keeping them is the safer default.',
    ],
    faqs: [
      ['Which statement should I ask for?',
        'A depository one, from NSDL or CDSL, if you have a demat account, because it '
        + 'covers everything. A registrar one, from CAMS or KFintech, if you only hold '
        + 'mutual funds, because it carries the full transaction history that capital '
        + 'gains are worked out from.'],
      ['How do I get the detailed one, with every transaction?',
        'Go to camsonline.com, choose Investor Services and then Statements, and ask for '
        + 'the CAS. Two things matter on that form. Pick the detailed statement rather '
        + 'than the summary, and set the period from 01-01-1990, or whenever you started, '
        + 'rather than the last year it offers by default. KFintech has the same thing at '
        + 'kfintech.com under Investor Services, and mfcentral.com serves both registrars '
        + 'from one place. The file arrives by email within a few minutes, locked with '
        + 'your PAN in capitals.'],
      ['What does the detailed statement give me that the summary does not?',
        'Every purchase, redemption, dividend and switch, with the date and the price. A '
        + 'summary says what you hold today and nothing about how it got there, so it '
        + 'cannot tell you what you paid, what you have made, or how long you have held '
        + 'anything. Import a detailed one and each holding grows a history, and the '
        + 'amount invested stops being something you have to type in.'],
      ['It says the file has no readable text.',
        'The file is a scan or a photograph rather than the original. Import the PDF that '
        + 'was emailed to you.'],
      ['A number looks wrong after an import.',
        'The statement prints a running balance after every transaction, and the importer '
        + 'checks its own arithmetic against it. Where they disagree it says so rather '
        + 'than staying quiet, so look for the note after the import.'],
    ],
  },
  {
    title: 'Capital gains',
    body: [
      'From a detailed registrar statement the app can work out what you actually realised: '
      + 'units matched first in, first out, grandfathering applied to anything bought on '
      + 'or before 31 January 2018, purchase-side stamp duty counted as part of the cost, '
      + 'and the securities transaction tax correctly left out of it.',
      'It produces the Schedule 112A file the filing utility takes, and the split of the '
      + 'year into the five advance-tax windows.',
      'Check it against your registrar’s own capital gains statement before you file. '
      + 'This is arithmetic, not advice.',
    ],
    faqs: [
      ['It says the statement does not go back far enough.',
        'Gains need the purchases a sale is matched against. Ask for a statement that '
        + 'starts before your first purchase, not just the current year.'],
      ['A scheme was left out of the report.',
        'Usually gifted units: their cost and holding period belong to whoever gave them '
        + 'to you and are not in your statement. The gift itself is still listed.'],
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
      ['Can I use the app completely offline?',
        'Yes. Turn on Airplane Mode and test it yourself: every calculation, PDF parser, and chart works without an internet connection.'],
      ['What happens to my CAS PDF statement when I upload it?',
        'It is parsed inside your phone’s browser engine using WebAssembly. Your PAN and statement file stay in your phone’s local storage and are never sent to any server.'],
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
            <p class="caption" style="margin-top:10px">${h(answer)}</p>
          </details>`).join('')}
      </div>`).join('')}

    <div class="card">
      <div class="card-title">Still have questions?</div>
      <p class="caption" style="margin-bottom:var(--gap-3)">
        If you have questions that aren't answered here or run into any problems, our team is ready to assist you.
      </p>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-filled" data-open-email style="flex:1;min-width:180px">
          ${icon('mail')}Email Support
        </button>
        <button type="button" class="btn btn-tonal" data-open-support-hub style="flex:1;min-width:140px">
          ${icon('support_agent')}Help Hub
        </button>
      </div>
    </div>`;

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
