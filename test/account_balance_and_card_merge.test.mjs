import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, call } from './_harness.mjs';
import {
  extractAccountBalanceFromText,
} from '../app/src/main/assets/www/js/backend/database.js';

describe('Bank Account Balance Extraction & Card/Account Merging', () => {
  let db;

  beforeEach(async () => {
    db = await freshBackend();
  });

  it('extracts bank account and wallet balances across various Indian SMS formats', () => {
    const cases = [
      { sms: 'Dear SBI User, A/C 1234 credited by Rs 50,000 on 25-Aug. Avl Bal: Rs 1,45,230.50', expected: 145230.5 },
      { sms: 'HDFC Bank: Rs 500.00 debited from A/C **5678 on 24-08-26. Avl Bal: INR 45,230.50. Not you? Call bank', expected: 45230.5 },
      { sms: 'ICICI Bank: Acct XX123 debited for Rs 1200.00. Bal:Rs.12,345.67. UPI:987654321', expected: 12345.67 },
      { sms: 'Axis Bank: INR 350.00 spent on your Card ending 4321. Avail Bal Rs 12,345.67', expected: 12345.67 },
      { sms: 'Kotak Bank: Rs 999 debited from A/C 9988. Bal: INR 15,000.00. Avl Limit: Rs 0', expected: 15000 },
      { sms: 'PNB Alert: Rs.2000.00 debited from A/C *1122. Clear Bal Rs. 15,000.00', expected: 15000 },
      { sms: 'Canara Bank: Rs 100 debited. Total Bal: Rs 50,000.00', expected: 50000 },
      { sms: 'Your Bank A/c Bal is Rs 25000.50 on 20-08-2026', expected: 25000.5 },
      { sms: 'Updated Bal: INR 20000.00 in A/C 4567', expected: 20000 },
      { sms: 'Pluxee: Rs 300 spent at Cafeteria. Wallet Bal: Rs 2,500.00', expected: 2500 },
      { sms: 'Paytm Payments Bank: Rs 50 paid to Merchant. Wallet Bal Rs 450.00', expected: 450 },
    ];

    for (const c of cases) {
      const val = extractAccountBalanceFromText(c.sms);
      assert.equal(val, c.expected, `Failed parsing: "${c.sms}" -> got ${val}, expected ${c.expected}`);
    }
  });

  it('auto-detects and populates bank balance on saveRecord and addDiscoveredAccounts', async () => {
    // Insert historical transactions with raw SMS containing balance
    db.run(
      "INSERT INTO transactions (account_id, type, amount, date, raw_sms, category) VALUES (NULL, 'expense', 500, '2026-08-20', 'HDFC Bank: Rs 500 debited from A/C **4321. Avl Bal: Rs 65,400.00', 'General')",
    );
    db.run(
      "INSERT INTO transactions (account_id, type, amount, date, raw_sms, category) VALUES (NULL, 'expense', 200, '2026-08-22', 'HDFC Bank: Rs 200 debited from A/C **4321. Avl Bal: Rs 65,200.00', 'General')",
    );

    // 1. saveRecord with 0 balance should auto-detect 65200 from the latest SMS
    const saveRes = await call('save_record', {
      record_type: 'account',
      record: {
        name: 'HDFC Salary',
        category: 'Bank',
        institution: 'HDFC Bank',
        account_number: '4321',
        balance: 0,
      },
    });
    assert.equal(saveRes.status, 'success');

    const acc = db.get('SELECT * FROM asset_accounts WHERE account_number = ?', ['4321']);
    assert.ok(acc);
    assert.equal(acc.balance, 65200, 'Account balance should be auto-detected from newest SMS');

    // 2. addDiscoveredAccounts with 0 balance
    db.run(
      "INSERT INTO transactions (account_id, type, amount, date, raw_sms, category) VALUES (NULL, 'expense', 100, '2026-08-24', 'SBI: Rs 100 debited from A/C *8899. Avl Bal: Rs 34,500.00', 'General')",
    );
    const discRes = await call('add_discovered_accounts', {
      accounts: [{
        name: 'SBI Savings',
        category: 'Bank',
        institution: 'SBI',
        account_number: '8899',
        balance: 0,
      }],
    });
    assert.equal(discRes.status, 'success');
    const sbiAcc = db.get('SELECT * FROM asset_accounts WHERE account_number = ?', ['8899']);
    assert.ok(sbiAcc);
    assert.equal(sbiAcc.balance, 34500, 'Discovered account balance should be populated from SMS');
  });

  it('merges duplicate/reissued cards and reassigns transactions', async () => {
    // Create Card 1 (Old card ending in 1111)
    const c1 = db.run(
      'INSERT INTO credit_cards (member_id, card_name, bank, last_4, total_limit, available_limit, current_balance, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
      ['HDFC Regalia Old', 'HDFC', '1111', 200000, 180000, 20000, '2026-01-01'],
    );
    const card1Id = c1.lastInsertRowid;

    // Create Card 2 (Reissued replacement card ending in 2222)
    const c2 = db.run(
      'INSERT INTO credit_cards (member_id, card_name, bank, last_4, total_limit, available_limit, current_balance, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
      ['HDFC Regalia Gold New', 'HDFC', '2222', 300000, 290000, 10000, '2026-08-01'],
    );
    const card2Id = c2.lastInsertRowid;

    // Add transactions to both cards
    db.run('INSERT INTO transactions (card_id, type, amount, date, raw_sms, category) VALUES (?, ?, ?, ?, ?, ?)',
      [card1Id, 'expense', 5000, '2026-01-15', 'HDFC Card 1111 spent 5000', 'Shopping']);
    db.run('INSERT INTO transactions (card_id, type, amount, date, raw_sms, category) VALUES (?, ?, ?, ?, ?, ?)',
      [card1Id, 'expense', 2500, '2026-02-10', 'HDFC Card 1111 spent 2500', 'Dining']);
    db.run('INSERT INTO transactions (card_id, type, amount, date, raw_sms, category) VALUES (?, ?, ?, ?, ?, ?)',
      [card2Id, 'expense', 1500, '2026-08-15', 'HDFC Card 2222 spent 1500', 'Shopping']);

    // Merge Card 1 into Card 2, retaining Card 2's new digits
    const mergeRes = await call('merge_cards', {
      source_card_id: card1Id,
      target_card_id: card2Id,
      update_last_4: false,
    });

    assert.equal(mergeRes.status, 'success');
    assert.equal(mergeRes.moved_transactions, 2);

    // Verify all transactions now belong to Card 2
    const txns = db.all('SELECT card_id, amount FROM transactions WHERE card_id = ?', [card2Id]);
    assert.equal(txns.length, 3, 'All 3 transactions should now belong to target card');

    // Verify Card 1 is deleted
    const oldCard = db.get('SELECT * FROM credit_cards WHERE id = ?', [card1Id]);
    assert.equal(oldCard, null, 'Source card should be removed');

    // Verify Card 2 limit and balance
    const targetCard = db.get('SELECT * FROM credit_cards WHERE id = ?', [card2Id]);
    assert.equal(targetCard.last_4, '2222');
    assert.equal(targetCard.current_balance, 30000, 'Balances should be combined');

    // Verify ignore rule created for old card 1111
    const ignored = db.all('SELECT * FROM ignored_discovered_accounts WHERE last_4 = ?', ['1111']);
    assert.ok(ignored.length > 0, 'Old card last_4 should be registered in ignored_discovered_accounts');
  });

  it('merges duplicate accounts and reassigns transactions', async () => {
    // Create Account 1
    const a1 = db.run(
      'INSERT INTO asset_accounts (member_id, name, category, institution, account_number, balance) VALUES (1, ?, ?, ?, ?, ?)',
      ['ICICI Old', 'Bank', 'ICICI Bank', '5555', 1000],
    );
    const acc1Id = a1.lastInsertRowid;

    // Create Account 2
    const a2 = db.run(
      'INSERT INTO asset_accounts (member_id, name, category, institution, account_number, balance) VALUES (1, ?, ?, ?, ?, ?)',
      ['ICICI Main', 'Bank', 'ICICI Bank', '6666', 25000],
    );
    const acc2Id = a2.lastInsertRowid;

    db.run('INSERT INTO transactions (account_id, type, amount, date, raw_sms, category) VALUES (?, ?, ?, ?, ?, ?)',
      [acc1Id, 'expense', 450, '2026-05-10', 'ICICI 5555 debited 450', 'Dining']);
    db.run('INSERT INTO transactions (account_id, type, amount, date, raw_sms, category) VALUES (?, ?, ?, ?, ?, ?)',
      [acc2Id, 'expense', 1200, '2026-08-10', 'ICICI 6666 debited 1200', 'Groceries']);

    const mergeRes = await call('merge_accounts', {
      source_account_id: acc1Id,
      target_account_id: acc2Id,
      balance_action: 'add',
    });

    assert.equal(mergeRes.status, 'success');
    assert.equal(mergeRes.moved_transactions, 1);

    const txns = db.all('SELECT * FROM transactions WHERE account_id = ?', [acc2Id]);
    assert.equal(txns.length, 2);

    const oldAcc = db.get('SELECT * FROM asset_accounts WHERE id = ?', [acc1Id]);
    assert.equal(oldAcc, null);

    const targetAcc = db.get('SELECT * FROM asset_accounts WHERE id = ?', [acc2Id]);
    assert.equal(targetAcc.balance, 26000, 'Summed balances when balance_action is add');
  });

  it('merges duplicate accounts while keeping target balance (no double balance) or overwriting', async () => {
    // Create Duplicate Account 1 (₹25,000) and Account 2 (₹25,000)
    const a1 = db.run(
      'INSERT INTO asset_accounts (member_id, name, category, institution, account_number, balance) VALUES (1, ?, ?, ?, ?, ?)',
      ['HDFC Dup', 'Bank', 'HDFC Bank', '1111', 25000],
    );
    const acc1Id = a1.lastInsertRowid;

    const a2 = db.run(
      'INSERT INTO asset_accounts (member_id, name, category, institution, account_number, balance) VALUES (1, ?, ?, ?, ?, ?)',
      ['HDFC Main', 'Bank', 'HDFC Bank', '1111', 25000],
    );
    const acc2Id = a2.lastInsertRowid;

    // Merge with keep_target (default for duplicates to avoid ₹50,000 doubling)
    const res1 = await call('merge_accounts', {
      source_account_id: acc1Id,
      target_account_id: acc2Id,
      balance_action: 'keep_target',
    });
    assert.equal(res1.status, 'success');
    const acc2 = db.get('SELECT * FROM asset_accounts WHERE id = ?', [acc2Id]);
    assert.equal(acc2.balance, 25000, 'Balance should remain 25,000 instead of doubling to 50,000');

    // Create a new source account with updated balance to test overwrite
    const a3 = db.run(
      'INSERT INTO asset_accounts (member_id, name, category, institution, account_number, balance) VALUES (1, ?, ?, ?, ?, ?)',
      ['HDFC Updated', 'Bank', 'HDFC Bank', '1111', 32000],
    );
    const acc3Id = a3.lastInsertRowid;

    const res2 = await call('merge_accounts', {
      source_account_id: acc3Id,
      target_account_id: acc2Id,
      balance_action: 'use_source',
    });
    assert.equal(res2.status, 'success');
    const accUpdated = db.get('SELECT * FROM asset_accounts WHERE id = ?', [acc2Id]);
    assert.equal(accUpdated.balance, 32000, 'Balance should overwrite with source balance 32,000');
  });

  it('supports updating last 4 digits on replacement cards during combine', async () => {
    const c = db.run(
      'INSERT INTO credit_cards (member_id, card_name, bank, last_4, total_limit, available_limit, current_balance, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
      ['SBI Card', 'SBI', '1234', 100000, 90000, 10000, '2026-01-01'],
    );
    const cardId = c.lastInsertRowid;

    const res = await call('combine_discovered_account', {
      target_id: cardId,
      target_type: 'card',
      last_4: '9999',
      bank: 'SBI',
      update_last_4: true,
    });

    assert.equal(res.status, 'success');
    const updatedCard = db.get('SELECT * FROM credit_cards WHERE id = ?', [cardId]);
    assert.equal(updatedCard.last_4, '9999', 'Card last_4 should be updated to reissued replacement digits');
  });

  it('links debit card to bank account without overriding the bank account number', async () => {
    // 1. Existing Bank Account with account number 1977
    const a = db.run(
      'INSERT INTO asset_accounts (member_id, name, category, institution, account_number, balance) VALUES (1, ?, ?, ?, ?, ?)',
      ['DCB Savings', 'Bank', 'DCB Bank', '1977', 50000],
    );
    const accId = a.lastInsertRowid;

    // 2. Link Discovered Debit Card 5678 to this Bank Account
    const res = await call('combine_discovered_account', {
      target_id: accId,
      target_type: 'account',
      last_4: '5678',
      bank: 'DCB Bank',
      is_debit_card: true,
    });

    assert.equal(res.status, 'success');
    const acc = db.get('SELECT * FROM asset_accounts WHERE id = ?', [accId]);
    assert.equal(acc.account_number, '1977', 'Account number must be preserved, not overwritten by debit card');
    assert.equal(acc.debit_card_last_4, '5678', 'Debit card digits must be linked');

    // 3. Merge a standalone Debit Card Account (5678) into Bank Account (1977) with link_as_debit_card
    const dcAcc = db.run(
      'INSERT INTO asset_accounts (member_id, name, category, institution, account_number, balance) VALUES (1, ?, ?, ?, ?, ?)',
      ['DCB Debit Card', 'Bank', 'DCB Bank', '8899', 0],
    );
    const dcAccId = dcAcc.lastInsertRowid;

    const mergeRes = await call('merge_accounts', {
      source_account_id: dcAccId,
      target_account_id: accId,
      link_as_debit_card: true,
      balance_action: 'keep_target',
    });

    assert.equal(mergeRes.status, 'success');
    const mergedAcc = db.get('SELECT * FROM asset_accounts WHERE id = ?', [accId]);
    assert.equal(mergedAcc.account_number, '1977', 'Target account number 1977 must be preserved');
    assert.equal(mergedAcc.debit_card_last_4, '8899', 'Target debit card updated with merged card');
  });

  it('correctly identifies bank account issuer when paying to Amazon Pay/Paytm/Swiggy and prevents fake payee accounts', async () => {
    // 1. "Sent Rs. 1500 From HDFC Bank A/C *1234 to Amazon Pay on 24/08/26"
    const sms1 = 'Sent Rs. 1500 From HDFC Bank A/C *1234 to Amazon Pay on 24/08/26';
    const parsed1 = (await import('../app/src/main/assets/www/js/backend/database.js')).parseAccountDetailsFromText(sms1);
    assert.equal(parsed1.issuer, 'HDFC Bank', 'Issuer must be HDFC Bank, NOT Amazon Pay');
    assert.equal(parsed1.last4, '1234');
    assert.equal(parsed1.instrument_type, 'bank_account');

    // 2. "INR 450.00 debited from A/C XX5678 on 20-AUG-26 towards Amazon Pay India UPI:628391029381. Avl Bal Rs 25,000"
    const sms2 = 'INR 450.00 debited from A/C XX5678 on 20-AUG-26 towards Amazon Pay India UPI:628391029381. Avl Bal Rs 25,000';
    const parsed2 = (await import('../app/src/main/assets/www/js/backend/database.js')).parseAccountDetailsFromText(sms2, 'AD-HDFCBK');
    assert.equal(parsed2.issuer, 'HDFC Bank');
    assert.equal(parsed2.last4, '5678');
    assert.equal(parsed2.account_balance, 25000);

    // 3. "Paid Rs. 299 to Paytm Merchant using HDFC Bank Debit Card ending 4321"
    const sms3 = 'Paid Rs. 299 to Paytm Merchant using HDFC Bank Debit Card ending 4321';
    const parsed3 = (await import('../app/src/main/assets/www/js/backend/database.js')).parseAccountDetailsFromText(sms3);
    assert.equal(parsed3.issuer, 'HDFC Bank', 'Issuer must be HDFC Bank, NOT Paytm');
    assert.equal(parsed3.last4, '4321');
    assert.equal(parsed3.isDebitCard, true);

    // 4. "Paid Rs. 500 at Swiggy using ICICI Bank Credit Card ending 9012"
    const sms4 = 'Paid Rs. 500 at Swiggy using ICICI Bank Credit Card ending 9012';
    const parsed4 = (await import('../app/src/main/assets/www/js/backend/database.js')).parseAccountDetailsFromText(sms4);
    assert.equal(parsed4.issuer, 'ICICI Bank');
    assert.equal(parsed4.last4, '9012');
    assert.equal(parsed4.isCreditCard, true);

    // 5. Test account discovery filtering: existing cards & accounts must never be re-discovered
    // Insert an existing card in DB
    db.run(
      'INSERT INTO credit_cards (member_id, card_name, bank, last_4, total_limit, available_limit, current_balance, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
      ['ICICI Coral', 'ICICI Bank', '9012', 150000, 140000, 10000, '2026-08-01'],
    );
    // Insert transaction using that card
    db.run('INSERT INTO transactions (card_id, type, amount, date, raw_sms, category) VALUES (NULL, ?, ?, ?, ?, ?)',
      ['expense', 500, '2026-08-20', sms4, 'Dining']);
    // Insert transaction from HDFC A/C *1234 to Amazon Pay
    db.run('INSERT INTO transactions (account_id, type, amount, date, raw_sms, category) VALUES (NULL, ?, ?, ?, ?, ?)',
      ['expense', 1500, '2026-08-24', sms1, 'Shopping']);

    const disc = await call('discover_accounts_from_sms');
    assert.equal(disc.status, 'success');

    // 1. Card 9012 already exists, so it should NOT be in discovered list
    const foundCard9012 = disc.discovered.find((d) => d.last_4 === '9012');
    assert.equal(foundCard9012, undefined, 'Existing card 9012 should not be discovered');

    // 2. SMS1 to Amazon Pay should be discovered as HDFC Bank A/c, NOT Amazon Pay
    const foundAmazonPay = disc.discovered.find((d) => d.bank === 'Amazon Pay' || (d.name && d.name.includes('Amazon Pay')));
    assert.equal(foundAmazonPay, undefined, 'Should NOT discover Amazon Pay as an account');

    const foundHdfc = disc.discovered.find((d) => d.last_4 === '1234');
    assert.ok(foundHdfc, 'HDFC A/C 1234 should be discovered');
    assert.equal(foundHdfc.bank, 'HDFC Bank');
    assert.equal(foundHdfc.kind, 'account');
  });

  it('correctly identifies DCB Bank account when transaction contains @okaxis UPI ID handle', async () => {
    const sms = 'Your DCB A/c no XX1977 has been credited with INR 3500.00 from UPI ID aaaaa@okaxis on 25/08/2026';
    const { parseAccountDetailsFromText, detectAccountIssuerWeighted } = await import('../app/src/main/assets/www/js/backend/database.js');
    
    const weighted = detectAccountIssuerWeighted(sms);
    assert.equal(weighted.issuer, 'DCB Bank', 'Weighted engine must rank DCB Bank highest');
    assert.equal(weighted.bankCode, 'DCB');
    assert.ok(weighted.score > 0);

    const parsed = parseAccountDetailsFromText(sms);
    assert.equal(parsed.issuer, 'DCB Bank', 'Must identify DCB Bank, NOT Axis Bank from @okaxis handle');
    assert.equal(parsed.last4, '1977');
    assert.equal(parsed.instrument_type, 'bank_account');
  });

  it('weights account bank ahead of external counterparty VPAs and payees', async () => {
    const { detectAccountIssuerWeighted } = await import('../app/src/main/assets/www/js/backend/database.js');

    // 1. SBI User receiving money from HDFC VPA handle
    const sbiMsg = 'Dear SBI Customer, your A/C *9876 credited by Rs 1,000 from user@okhdfcbank';
    const sbiRes = detectAccountIssuerWeighted(sbiMsg, 'CP-SBIBNK');
    assert.equal(sbiRes.issuer, 'State Bank of India', 'SBI should win over counterparty @okhdfcbank');

    // 2. Kotak Account paying to ICICI VPA handle
    const kotakMsg = 'Paid Rs. 500 from Kotak Bank A/C 4321 to merchant@icici';
    const kotakRes = detectAccountIssuerWeighted(kotakMsg);
    assert.equal(kotakRes.issuer, 'Kotak Mahindra Bank', 'Kotak should win over payee @icici');

    // 3. HDFC transfer to Amazon Pay
    const hdfcMsg = 'Sent Rs. 1500 From HDFC Bank A/C *1234 to Amazon Pay on 24/08/26';
    const hdfcRes = detectAccountIssuerWeighted(hdfcMsg);
    assert.equal(hdfcRes.issuer, 'HDFC Bank', 'HDFC should win over payee Amazon Pay');

    // 4. DCB Bank account transaction ending with "- SBI" signature
    const dcbSbiMsg = 'Dear Customer, your DCB Bank A/C XX1977 credited with INR 5000.00 from UPI ID rahul@okaxis. Ref: 123456. - SBI';
    const dcbSbiRes = detectAccountIssuerWeighted(dcbSbiMsg);
    assert.equal(dcbSbiRes.issuer, 'DCB Bank', 'DCB Bank must win over trailing sender signature - SBI');

    // 5. Account with only "- SBI" trailing signature
    const genericSbiMsg = 'Your A/c no XX1977 has been credited with INR 3500.00 on 25/08/2026. - SBI';
    const genericSbiRes = detectAccountIssuerWeighted(genericSbiMsg);
    assert.equal(genericSbiRes.issuer, 'State Bank of India', 'SBI should be identified when it is the sole sender signature');

    // 6. IT Refund disbursed by SBI as Refund Banker to user's account XXXXXXXXX1486
    const itRefundMsg = 'Dear Customer, For PAN XXXXXXX706K, An IT Refund of RS 14500 for AY-2026-26 has been credited to your account XXXXXXXXX1486 on 2026-08-20. - SBI';
    const itRefundRes = detectAccountIssuerWeighted(itRefundMsg);
    assert.equal(itRefundRes.issuer, 'Bank', 'IT Refund must NOT attribute SBI as the user account issuer');
    assert.equal(itRefundRes.bankCode, 'BANK');

    const { parseAccountDetailsFromText } = await import('../app/src/main/assets/www/js/backend/database.js');
    const parsedItRefund = parseAccountDetailsFromText(itRefundMsg);
    assert.equal(parsedItRefund.issuer, 'Bank', 'IT Refund issuer should be generic Bank, not SBI');
    assert.equal(parsedItRefund.last4, '1486');
    assert.equal(parsedItRefund.instrument_type, 'bank_account');
  });

  it('resyncs bank account balance and links unassigned transactions from SMS history', async () => {
    // 1. Create an asset account with 0 initial balance
    const createRes = await call('save_record', {
      record_type: 'account',
      record: {
        name: 'HDFC Savings',
        category: 'Bank',
        institution: 'HDFC Bank',
        account_number: '123456789012',
        debit_card_last_4: '9988',
        balance: 1000,
      },
    });
    assert.equal(createRes.status, 'success');
    const accId = createRes.record_id;

    // 2. Insert older and newer SMS transactions (some unassigned, some matching debit card, some account number)
    db.run(
      "INSERT INTO transactions (account_id, type, amount, date, raw_sms, category) VALUES (NULL, 'Expense', 500, '2026-08-20', 'HDFC Bank: Rs 500 debited from A/C **9012 on 20-08-26. Avl Bal: INR 45,000.00', 'Groceries')",
    );
    db.run(
      "INSERT INTO transactions (account_id, type, amount, date, raw_sms, category) VALUES (NULL, 'Expense', 1200, '2026-08-22', 'HDFC Bank: Rs 1200 spent on Debit Card **9988. Avl Bal: INR 43,800.00', 'Shopping')",
    );
    db.run(
      "INSERT INTO transactions (account_id, type, amount, date, raw_sms, category) VALUES (NULL, 'Expense', 300, '2026-08-24', 'HDFC Bank: Rs 300 debited from A/C **9012 on 24-08-26. Avl Bal: INR 43,500.00', 'Dining')",
    );

    // 3. Trigger resync_account_from_sms
    const resyncRes = await call('resync_account_from_sms', { account_id: accId });
    assert.equal(resyncRes.status, 'success');
    assert.equal(resyncRes.resynced, 1);
    assert.equal(resyncRes.results[0].balance, 43500, 'Balance must be updated to the newest SMS balance (43,500)');
    assert.equal(resyncRes.results[0].remapped_transactions, 3, 'All 3 unlinked matching SMS transactions must be remapped');

    // 4. Verify in database
    const updatedAcc = db.get('SELECT * FROM asset_accounts WHERE id = ?', [accId]);
    assert.equal(updatedAcc.balance, 43500);

    const linkedTxns = db.all('SELECT * FROM transactions WHERE account_id = ?', [accId]);
    assert.equal(linkedTxns.length, 3);
  });

  it('resyncs credit card limits and balance from SMS history', async () => {
    // 1. Create a credit card record
    const createRes = await call('save_record', {
      record_type: 'card',
      record: {
        card_name: 'ICICI Sapphiro',
        bank: 'ICICI Bank',
        last_4: '7766',
        total_limit: 200000,
        available_limit: 150000,
        current_balance: 50000,
      },
    });
    assert.equal(createRes.status, 'success');
    const cardId = createRes.record_id;

    // 2. Insert SMS transactions with updated card limits
    db.run(
      "INSERT INTO transactions (card_id, type, amount, date, raw_sms, category) VALUES (NULL, 'Expense', 5000, '2026-08-25', 'ICICI Bank: INR 5,000.00 spent on Credit Card ending 7766. Avail Limit: INR 1,45,000.00, Total Limit: INR 2,00,000.00', 'Shopping')",
    );

    // 3. Trigger resync for card
    const resyncRes = await call('resync_account_from_sms', { card_id: cardId });
    assert.equal(resyncRes.status, 'success');
    assert.equal(resyncRes.results[0].available_limit, 145000);
    assert.equal(resyncRes.results[0].total_limit, 200000);
    assert.equal(resyncRes.results[0].remapped_transactions, 1);

    const updatedCard = db.get('SELECT * FROM credit_cards WHERE id = ?', [cardId]);
    assert.equal(updatedCard.available_limit, 145000);
  });

  it('resyncs all accounts and cards in batch with { all: true }', async () => {
    await call('save_record', {
      record_type: 'account',
      record: {
        name: 'Axis Bank',
        category: 'Bank',
        institution: 'Axis Bank',
        account_number: '5544',
        balance: 0,
      },
    });

    db.run(
      "INSERT INTO transactions (account_id, type, amount, date, raw_sms, category) VALUES (NULL, 'Expense', 1000, '2026-08-25', 'Axis Bank: Rs 1000 debited from A/C 5544. Avail Bal Rs 18,500.00', 'Bills')",
    );

    const resyncAllRes = await call('resync_account_from_sms', { all: true });
    assert.equal(resyncAllRes.status, 'success');
    assert.ok(resyncAllRes.resynced >= 1);

    const axisAcc = db.get("SELECT * FROM asset_accounts WHERE account_number = '5544'");
    assert.equal(axisAcc.balance, 18500);
  });

  it('cleans up ignored identifiers on account deletion so re-adding from SMS works cleanly', async () => {
    // 1. Add discovered account
    const addRes = await call('add_discovered_accounts', {
      accounts: [{
        name: 'HDFC Account',
        category: 'Bank',
        institution: 'HDFC Bank',
        account_number: '7788',
        balance: 25000,
        instrument_type: 'bank_account',
      }],
    });
    assert.equal(addRes.status, 'success');
    assert.equal(addRes.added, 1);

    const acc = db.get("SELECT * FROM asset_accounts WHERE account_number = '7788'");
    assert.ok(acc);

    // Verify ignored_discovered_accounts has the entry
    const ignored = db.all("SELECT * FROM ignored_discovered_accounts WHERE last_4 = '7788'");
    assert.ok(ignored.length > 0);

    // 2. Delete the account
    const delRes = await call('delete_record', { record_type: 'account', record_id: acc.id });
    assert.equal(delRes.status, 'success');

    // Verify ignored_discovered_accounts entry is cleared on account deletion
    const ignoredAfter = db.all("SELECT * FROM ignored_discovered_accounts WHERE last_4 = '7788'");
    assert.equal(ignoredAfter.length, 0);

    // 3. Re-add account from discovered list
    const reAddRes = await call('add_discovered_accounts', {
      accounts: [{
        name: 'HDFC Account',
        category: 'Bank',
        institution: 'HDFC Bank',
        account_number: '7788',
        balance: 25000,
        instrument_type: 'bank_account',
      }],
    });
    assert.equal(reAddRes.status, 'success');
    assert.equal(reAddRes.added, 1);
    const reAcc = db.get("SELECT * FROM asset_accounts WHERE account_number = '7788'");
    assert.ok(reAcc);
  });

  it('converts bank account to credit card and re-links transactions atomically', async () => {
    // 1. Create an asset account
    const acc = db.run(
      'INSERT INTO asset_accounts (member_id, name, category, institution, account_number, balance) VALUES (1, ?, ?, ?, ?, ?)',
      ['ICICI Coral Card', 'Bank', 'ICICI Bank', '4321', 12500],
    );
    const accId = acc.lastInsertRowid;

    // 2. Add linked transaction
    const txn = db.run(
      'INSERT INTO transactions (account_id, amount, type, category, date, merchant) VALUES (?, ?, ?, ?, ?, ?)',
      [accId, 2500, 'Expense', 'Shopping', '2026-09-01', 'Amazon'],
    );
    const txnId = txn.lastInsertRowid;

    // 3. Convert to Credit Card
    const res = await call('convert_record', {
      from_type: 'account',
      id: accId,
    });

    assert.equal(res.status, 'success');
    assert.equal(res.target_type, 'card');
    assert.ok(res.new_id);

    // Old account should be deleted
    const oldAcc = db.get('SELECT * FROM asset_accounts WHERE id = ?', [accId]);
    assert.equal(oldAcc, null);

    // New card should exist with transferred balance and last 4
    const newCard = db.get('SELECT * FROM credit_cards WHERE id = ?', [res.new_id]);
    assert.ok(newCard);
    assert.equal(newCard.last_4, '4321');
    assert.equal(newCard.bank, 'ICICI Bank');
    assert.equal(newCard.current_balance, 12500);

    // Transaction should be migrated to card_id and account_id cleared
    const updatedTxn = db.get('SELECT * FROM transactions WHERE id = ?', [txnId]);
    assert.equal(updatedTxn.card_id, res.new_id);
    assert.equal(updatedTxn.account_id, null);
  });

  it('converts credit card to bank account and re-links transactions atomically', async () => {
    // 1. Create a credit card
    const card = db.run(
      'INSERT INTO credit_cards (member_id, card_name, bank, last_4, total_limit, current_balance) VALUES (1, ?, ?, ?, ?, ?)',
      ['Axis Bank Salary', 'Axis Bank', '9876', 0, 54000],
    );
    const cardId = card.lastInsertRowid;

    // 2. Add linked transaction
    const txn = db.run(
      'INSERT INTO transactions (card_id, amount, type, category, date, merchant) VALUES (?, ?, ?, ?, ?, ?)',
      [cardId, 1200, 'Expense', 'Dining', '2026-09-02', 'Swiggy'],
    );
    const txnId = txn.lastInsertRowid;

    // 3. Convert to Bank Account
    const res = await call('convert_record', {
      from_type: 'card',
      id: cardId,
    });

    assert.equal(res.status, 'success');
    assert.equal(res.target_type, 'account');
    assert.ok(res.new_id);

    // Old card should be deleted
    const oldCard = db.get('SELECT * FROM credit_cards WHERE id = ?', [cardId]);
    assert.equal(oldCard, null);

    // New account should exist with transferred balance and debit_card_last_4
    const newAcc = db.get('SELECT * FROM asset_accounts WHERE id = ?', [res.new_id]);
    assert.ok(newAcc);
    assert.equal(newAcc.debit_card_last_4, '9876');
    assert.equal(newAcc.institution, 'Axis Bank');
    assert.equal(newAcc.balance, 54000);

    // Transaction should be migrated to account_id and card_id cleared
    const updatedTxn = db.get('SELECT * FROM transactions WHERE id = ?', [txnId]);
    assert.equal(updatedTxn.account_id, res.new_id);
    assert.equal(updatedTxn.card_id, null);
  });
});
