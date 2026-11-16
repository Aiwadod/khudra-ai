// End-to-end check of the agent loop with a scripted model reply (no API key needed):
// the model proposes actions -> guardrails normalise them -> nothing happens until Approve -> effects land in the store.
// Run: npm i playwright && npx playwright install chromium && node tests/agent_flow.test.js
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.addInitScript(() => {
    const fake = async () => ({ text: '' });
    fake.json = async () => ({
      reply: 'Order avocado and tahini; run a midweek deal. Shall I do it?',
      actions: [
        { type: 'purchase_order', items: [{ item: 'avocado', qty: 500 }, { item: 'not_an_item', qty: 9 }], reason: 'cover two days' },
        { type: 'promo', title_en: 'Midweek deal', title_ar: 'عرض وسط الأسبوع', date: todayISO(), days: 1, discountPercent: 95, bowl: 'med', expectedUpliftPercent: 25 },
        { type: 'promo', title_en: 'Past promo', date: '2020-01-01', days: 1, discountPercent: 10, bowl: 'all' },
        { type: 'delete_everything' },
      ],
    });
    window.claude = { use: async n => (n === 'sample' ? fake : null) };
  });
  await p.goto('file://' + path.resolve(__dirname, '../app/index.html'));
  await p.waitForTimeout(900);
  await p.evaluate(() => (location.hash = 'admin')); await p.waitForTimeout(600);
  await p.click('.qs'); await p.waitForTimeout(600);
  let s = await p.evaluate(() => ({ acts: asst[asst.length - 1].actions, pos: Object.values(Store.all('purchases')).filter(x => x.by === 'ai').length, promo: promoToday('med') }));
  assert.strictEqual(s.acts.length, 2, 'invalid actions (unknown type, past date) are dropped');
  assert.strictEqual(s.pos, 0, 'nothing is executed before approval');
  assert.strictEqual(s.promo, 0, 'no promo before approval');
  const po = s.acts[0];
  assert.strictEqual(po.items.length, 1, 'unknown inventory items are removed');
  assert.ok(po.items[0].qty < 500 && po.items[0].capped, 'perishable order is capped to what can be used before it spoils');
  assert.strictEqual(s.acts[1].discount, 50, 'discount is clamped to 50%');
  for (let i = 0; i < 2; i++) { await p.click('[data-ax$=":yes"]'); await p.waitForTimeout(400); }
  s = await p.evaluate(() => ({ pos: Object.values(Store.all('purchases')).filter(x => x.by === 'ai').length, promo: promoToday('med'), log: (Store.all('agent').log.entries || []).length }));
  assert.ok(s.pos >= 1, 'approved purchase order is created');
  assert.strictEqual(s.promo, 50, 'approved promo is live for customers');
  assert.ok(s.log >= 3, 'every executed action is written to the audit log');
  assert.deepStrictEqual(errors, []);
  console.log('agent flow: 9 checks passed');
  await b.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
