import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, call } from './_harness.mjs';
import { getFinancialPeriod } from '../app/src/main/assets/www/js/backend/periods.js';
import { parseSmsText } from '../app/src/main/assets/www/js/backend/sms.js';

describe('Custom Transaction Buckets (Trips & Projects)', () => {
  beforeEach(async () => {
    await freshBackend();
  });

  it('creates, lists, and manages buckets with budget and spend progress', async () => {
    // 1. Create a bucket for "Trip To Japan 2025"
    const createRes = await call('save_transaction_bucket', {
      bucket: {
        name: 'Trip To Japan 2025',
        icon: 'flight',
        target_budget: 250000,
        start_date: '2025-10-10',
        end_date: '2025-10-25',
        notes: 'Tokyo and Kyoto trip itinerary',
      },
    });

    assert.equal(createRes.status, 'success');
    const bucketId = createRes.id;
    assert.ok(bucketId > 0);

    // 2. Add transactions linked to this bucket
    await call('save_transaction', {
      transaction: {
        amount: 80000,
        type: 'Expense',
        category: 'Travel',
        merchant: 'ANA Air Flights',
        date: '2025-10-10',
        bucket_id: bucketId,
      },
    });

    await call('save_transaction', {
      transaction: {
        amount: 45000,
        type: 'Expense',
        category: 'Travel',
        merchant: 'Shinjuku Hotel Tokyo',
        date: '2025-10-12',
        bucket_id: bucketId,
      },
    });

    await call('save_transaction', {
      transaction: {
        amount: 15000,
        type: 'Expense',
        category: 'Dining',
        merchant: 'Ginza Sushi Bar',
        date: '2025-10-14',
        bucket_id: bucketId,
      },
    });

    // 3. Query get_transaction_buckets
    const listRes = await call('get_transaction_buckets', {});
    assert.equal(listRes.status, 'success');
    assert.equal(listRes.buckets.length, 1);

    const b = listRes.buckets[0];
    assert.equal(b.name, 'Trip To Japan 2025');
    assert.equal(b.total_spent, 140000);
    assert.equal(b.transaction_count, 3);
    assert.equal(b.progress_pct, 56); // 140,000 / 250,000 = 56%
    assert.equal(b.is_over_budget, false);

    // 4. Query get_bucket_details
    const detailsRes = await call('get_bucket_details', { bucket_id: bucketId });
    assert.equal(detailsRes.status, 'success');
    assert.equal(detailsRes.transactions.length, 3);
    assert.equal(detailsRes.bucket.total_spent, 140000);
    assert.ok(detailsRes.bucket.categories.length >= 2);

    // 5. Bulk assign another transaction
    const extraTxRes = await call('save_transaction', {
      transaction: {
        amount: 5000,
        type: 'Expense',
        category: 'Transport',
        merchant: 'Shinkansen Bullet Train',
        date: '2025-10-15',
      },
    });

    // Bulk assign extra transaction to bucket
    const assignRes = await call('assign_transactions_bucket', {
      bucket_id: bucketId,
      ids: [extraTxRes.transaction_id || extraTxRes.id],
    });
    assert.equal(assignRes.status, 'success');
    assert.equal(assignRes.updated_count, 1);

    const updatedDetails = await call('get_bucket_details', { bucket_id: bucketId });
    assert.equal(updatedDetails.transactions.length, 4);
    assert.equal(updatedDetails.bucket.total_spent, 145000);

    // 6. Delete bucket: transactions must be unlinked, NOT deleted!
    const deleteRes = await call('delete_transaction_bucket', { bucket_id: bucketId });
    assert.equal(deleteRes.status, 'success');

    const txsAfterDelete = await call('get_transactions', {});
    assert.equal(txsAfterDelete.transactions.length, 4);
    assert.equal(txsAfterDelete.transactions[0].bucket_id, null);
  });

  it('calculates spending heatmap and streaks accurately', async () => {
    // Add transactions for heatmap calculation
    await call('save_transaction', {
      transaction: {
        amount: 2500,
        type: 'Expense',
        category: 'Dining',
        date: '2026-10-10',
      },
    });

    const res = await call('get_spending_heatmap', { days: 28, end_date: '2026-10-17' });
    assert.equal(res.status, 'success');
    assert.ok(res.cells.length >= 28);
    assert.ok(res.no_spend_days > 0);
  });

  it('calculates custom financial periods with salary anchor days', () => {
    // 1st of month anchor
    const p1 = getFinancialPeriod('2026-10-15', 1);
    assert.equal(p1.from, '2026-10-01');
    assert.equal(p1.to, '2026-11-01');

    // 25th of month anchor, date is 15th Oct -> period is 25th Sep to 25th Oct
    const p25Early = getFinancialPeriod('2026-10-15', 25);
    assert.equal(p25Early.from, '2026-09-25');
    assert.equal(p25Early.to, '2026-10-25');

    // 25th of month anchor, date is 26th Oct -> period is 25th Oct to 25th Nov
    const p25Late = getFinancialPeriod('2026-10-26', 25);
    assert.equal(p25Late.from, '2026-10-25');
    assert.equal(p25Late.to, '2026-11-25');
  });

  it('classifies ATM cash withdrawals as Transfers to avoid double counting', async () => {
    const sms = 'HDFC Bank: Rs. 5000.00 withdrawn at ATM from A/C **1234 on 15-Oct-26. Avail Bal: Rs. 42000.00';
    const parsed = await parseSmsText(sms, 'HDFCBK');
    assert.equal(parsed.type, 'Transfer');
    assert.equal(parsed.category, 'Transfer');
    assert.equal(parsed.amount, 5000);
  });
});
