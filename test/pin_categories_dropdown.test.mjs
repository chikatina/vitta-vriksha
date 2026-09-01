import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { call, freshBackend, ok } from './_harness.mjs';

beforeEach(async () => {
  await freshBackend();
});

describe('PIN reset and categories fixes', () => {
  it('seeds Emergency Fund and expanded investment and expense categories', async (t) => {
    const res = await ok(t, 'get_categories');
    const categories = res.categories || [];
    const catMap = new Map(categories.map((c) => [c.name, c]));

    assert.ok(catMap.has('Emergency Fund'), 'Emergency Fund category should exist');
    assert.equal(catMap.get('Emergency Fund').type, 'Investment');
    assert.equal(catMap.get('Emergency Fund').icon, 'savings');

    assert.ok(catMap.has('Mutual Funds'), 'Mutual Funds category should exist');
    assert.equal(catMap.get('Mutual Funds').type, 'Investment');

    assert.ok(catMap.has('Stocks & Equity'), 'Stocks & Equity category should exist');
    assert.equal(catMap.get('Stocks & Equity').type, 'Investment');

    assert.ok(catMap.has('Fixed Deposit & RD'), 'Fixed Deposit & RD category should exist');
    assert.equal(catMap.get('Fixed Deposit & RD').type, 'Investment');

    assert.ok(catMap.has('Gold & Metals'), 'Gold & Metals category should exist');
    assert.equal(catMap.get('Gold & Metals').type, 'Investment');

    assert.ok(catMap.has('Retirement & NPS'), 'Retirement & NPS category should exist');
    assert.equal(catMap.get('Retirement & NPS').type, 'Investment');

    assert.ok(catMap.has('Real Estate'), 'Real Estate category should exist');
    assert.equal(catMap.get('Real Estate').type, 'Investment');

    assert.ok(catMap.has('Crypto & Digital Assets'), 'Crypto & Digital Assets category should exist');
    assert.equal(catMap.get('Crypto & Digital Assets').type, 'Investment');

    assert.ok(catMap.has('Bills & Recharge'), 'Bills & Recharge category should exist');
    assert.equal(catMap.get('Bills & Recharge').type, 'Expense');

    assert.ok(catMap.has('Office & Work'), 'Office & Work category should exist');
    assert.equal(catMap.get('Office & Work').type, 'Expense');
  });

  it('automatically flags transactions categorized under investment categories as investment outflows', async (t) => {
    const saveRes = await ok(t, 'save_transaction', {
      transaction: {
        amount: 25000,
        merchant: 'Emergency Liquid Fund',
        category: 'Emergency Fund',
        date: '2026-09-01',
      },
    });
    assert.ok(saveRes.transaction_id);

    const txRes = await ok(t, 'get_transactions');
    const tx = txRes.transactions.find((item) => item.id === saveRes.transaction_id);
    assert.ok(tx);
    assert.equal(tx.type, 'Investment');
    assert.equal(tx.is_investment_outflow, 1);
  });

  it('supports all singular and plural aliases for accounts and cards in list_records', async (t) => {
    // Add an account and a card
    await ok(t, 'save_record', {
      record_type: 'account',
      record: { name: 'HDFC Salary A/c', category: 'Bank', balance: 50000 },
    });
    await ok(t, 'save_record', {
      record_type: 'card',
      record: { card_name: 'Infinia Metal', bank: 'HDFC', last_4: '9988' },
    });

    const acc1 = await ok(t, 'list_records', { type: 'asset_account' });
    assert.equal(acc1.records.length, 1);
    assert.equal(acc1.records[0].name, 'HDFC Salary A/c');

    const acc2 = await ok(t, 'list_records', { type: 'asset_accounts' });
    assert.equal(acc2.records.length, 1);

    const acc3 = await ok(t, 'list_records', { type: 'account' });
    assert.equal(acc3.records.length, 1);

    const card1 = await ok(t, 'list_records', { type: 'credit_card' });
    assert.equal(card1.records.length, 1);
    assert.equal(card1.records[0].card_name, 'Infinia Metal');

    const card2 = await ok(t, 'list_records', { type: 'credit_cards' });
    assert.equal(card2.records.length, 1);

    const card3 = await ok(t, 'list_records', { type: 'card' });
    assert.equal(card3.records.length, 1);
  });
});
