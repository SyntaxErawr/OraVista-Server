const test = require('node:test');
const assert = require('node:assert/strict');
const {catalog, services, findService, bookingAmount} = require('../service-catalog');
const expected = {
  'Oral Prophylaxis':500, Restoration:500, Extraction:700,
  'Braces Installation':4000, 'Braces Adjustment':1000, Veneers:3500,
  'Root Canal (RCT)':0, 'Wisdom Tooth Surgery':0, Dentures:0,
  'Fixed Bridge':3500, 'Teeth Whitening':0,
};
test('clinic-offer estimates apply equally to canonical and mobile service names', () => {
  assert.equal(services.length,11);
  assert.equal(new Set(services.map(service=>service.name)).size,11);
  for (const [name, amount] of Object.entries(expected)) {
    assert.equal(bookingAmount(name),amount,name);
    assert.equal(bookingAmount(findService(name).mobileName),amount,name);
  }
  assert.equal(bookingAmount(' oral prophylaxis '),500);
  assert.throws(()=>bookingAmount('Unsupported service'),/current clinic list/);
  assert.throws(()=>bookingAmount({}),/current clinic list/);
});
test('clinic prices distinguish minimum fees, down payments and unquoted treatment', () => {
  const braces=findService('Braces Installation');
  assert.equal(braces.priceType,'down_payment');
  assert.match(braces.priceLabel,/4,000.*down payment/);
  assert.match(braces.priceNote,/40,000.*45,000/);
  assert.match(findService('Restoration').priceNote,/Front tooth: minimum ₱700 per surface/);
  for (const service of services.filter(service=>service.priceType==='quote')) {
    assert.equal(service.basePrice,null);
    assert.equal(service.priceLabel,'Case to Case');
  }
  assert.match(catalog.pricingNotice,/cash payments/);
});
