import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyAsset, ASSET_CLASSES } from '../app/src/main/assets/www/js/backend/asset-class.js';

describe('asset-class.js classification', () => {
  it('exports valid ASSET_CLASSES list', () => {
    assert.ok(Array.isArray(ASSET_CLASSES));
    assert.ok(ASSET_CLASSES.includes('Stocks'));
    assert.ok(ASSET_CLASSES.includes('Mutual funds'));
    assert.ok(ASSET_CLASSES.includes('ETF'));
    assert.ok(ASSET_CLASSES.includes('Government securities'));
    assert.ok(ASSET_CLASSES.includes('Commodities'));
    assert.ok(ASSET_CLASSES.includes('Bonds'));
    assert.ok(ASSET_CLASSES.includes('NPS'));
    assert.ok(ASSET_CLASSES.includes('Other'));
  });

  it('classifies NPS source directly', () => {
    assert.equal(classifyAsset({ source: 'nps' }), 'NPS');
    assert.equal(classifyAsset({ source: 'nps', isin: 'INE123A01010', name: 'Gold ETF' }), 'NPS');
  });

  it('classifies commodities (gold, silver, bullion, sgb)', () => {
    assert.equal(classifyAsset({ name: 'Nippon India Gold ETF' }), 'Commodities');
    assert.equal(classifyAsset({ name: 'ICICI Prudential Silver ETF' }), 'Commodities');
    assert.equal(classifyAsset({ name: 'DSP Bullion Fund of Fund' }), 'Commodities');
    assert.equal(classifyAsset({ name: 'Sovereign Gold Bond 2023-24 Series I' }), 'Commodities');
    assert.equal(classifyAsset({ name: 'SGB NOV 2026' }), 'Commodities');
  });

  it('classifies government securities from ISIN and name', () => {
    assert.equal(classifyAsset({ isin: 'IN0020210012' }), 'Government securities');
    assert.equal(classifyAsset({ isin: 'IN1234567890' }), 'Government securities');
    assert.equal(classifyAsset({ name: '7.18% GS 2033' }), 'Government securities');
    assert.equal(classifyAsset({ name: 'GOVT OF INDIA 2030' }), 'Government securities');
    assert.equal(classifyAsset({ name: 'SDL MH 2030' }), 'Government securities');
    assert.equal(classifyAsset({ name: 'TREASURY BILL 91D' }), 'Government securities');
    assert.equal(classifyAsset({ name: 'Sovereign Green Bond' }), 'Government securities');
  });

  it('classifies ETFs and index funds from name', () => {
    assert.equal(classifyAsset({ name: 'Nifty 50 ETF' }), 'ETF');
    assert.equal(classifyAsset({ name: 'NIFTY BEES' }), 'ETF');
    assert.equal(classifyAsset({ name: 'Junior BeES ETF' }), 'ETF');
    assert.equal(classifyAsset({ name: 'UTI Nifty 50 Index Fund' }), 'ETF');
    assert.equal(classifyAsset({ name: 'HDFC Exchange-Traded Fund' }), 'ETF');
    assert.equal(classifyAsset({ name: 'Exchange Traded Scheme' }), 'ETF');
  });

  it('classifies Mutual Funds by INF ISIN or source', () => {
    assert.equal(classifyAsset({ isin: 'INF179K01BE2', name: 'HDFC Flexi Cap' }), 'Mutual funds');
    assert.equal(classifyAsset({ source: 'folio', name: 'Some Fund' }), 'Mutual funds');
  });

  it('classifies Stocks and Bonds by INE ISIN or kind', () => {
    assert.equal(classifyAsset({ isin: 'INE002A01018', name: 'Reliance Industries' }), 'Stocks');
    assert.equal(classifyAsset({ isin: 'INE002A08013', name: 'Reliance Bond', kind: 'bond' }), 'Bonds');
    assert.equal(classifyAsset({ kind: 'bond' }), 'Bonds');
    assert.equal(classifyAsset({ kind: 'equity' }), 'Stocks');
  });

  it('falls back to Other when no rule matches', () => {
    assert.equal(classifyAsset(), 'Other');
    assert.equal(classifyAsset({ isin: '', name: 'Unidentified Asset' }), 'Other');
    assert.equal(classifyAsset({ isin: 'XYZ123', name: 'Unidentified Asset' }), 'Other');
  });
});
