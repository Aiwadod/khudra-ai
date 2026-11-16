// End-to-end check of the built-in assistant (no external model, no API key):
// intent routing on a labelled question set -> guardrails on adversarial actions -> nothing happens until Approve -> effects land in the store.
// Run: npm i playwright && npx playwright install chromium && node tests/agent_flow.test.js
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');
const LABELLED = [
  ['بكرة وش نطلب عشان ما ينقص شي؟', 'order'], ['what should we order?', 'order'], ['كم مخزون الأفوكادو؟', 'stock'], ['كم المخزون', 'stock'],
  ['how much chicken is left?', 'stock'], ['الطلب وسط الأسبوع قليل، كيف نزيده؟', 'promo'], ['وين أقدر أقلل التكاليف؟', 'costs'],
  ['جهّز لي بوستر لعرض نهاية الأسبوع', 'design'], ['كم مبيعات اليوم', 'sales'], ['كم الربح هذا الاسبوع', 'profit'], ['وش المتوقع بكرة', 'forecast'],
  ['في هدر متوقع؟', 'waste'], ['كم موظف نحتاج', 'staff'], ['مين اسوأ مورد', 'supplier'], ['كيف الفروع', 'branch'], ['وش هوامش الاطباق', 'menu'],
  ['كم ركعة صلاة الفجر', null], ['ما هي عاصمة فرنسا', null], ['who invented the telephone', null], ['من هو مخترع الهاتف', null],
];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  const external = []; p.on('request', r => { if (/generativelanguage|anthropic|openai/.test(r.url())) external.push(r.url()); });
  await p.goto('file://' + path.resolve(__dirname, '../app/index.html'));
  await p.waitForTimeout(900);
  await p.evaluate(() => (location.hash = 'admin')); await p.waitForTimeout(600);

  // 1) routing accuracy
  const got = await p.evaluate(qs => qs.map(q => classify(q).intent), LABELLED.map(x => x[0]));
  const right = got.filter((g, i) => g === LABELLED[i][1]).length;
  console.log(`intent routing: ${right}/${LABELLED.length} correct`);
  assert.ok(right / LABELLED.length >= 0.9, 'routing accuracy on the labelled set is at least 90%');

  // 2) guardrails on adversarial actions
  const g = await p.evaluate(() => { const A = analyze(); return [
    { type: 'purchase_order', items: [{ item: 'avocado', qty: 500 }, { item: 'not_an_item', qty: 9 }] },
    { type: 'promo', title_en: 'x', title_ar: 'x', date: todayISO(), days: 1, discountPercent: 95, bowl: 'med', expectedUpliftPercent: 25 },
    { type: 'promo', title_en: 'Past', date: '2020-01-01', days: 1, discountPercent: 10, bowl: 'all' },
    { type: 'delete_everything' } ].map(a => normAction(a, A)); });
  assert.strictEqual(g[0].items.length, 1, 'unknown inventory items are removed');
  assert.ok(g[0].items[0].qty < 500 && g[0].items[0].capped, 'perishable order is capped to what can be used before it spoils');
  assert.strictEqual(g[1].discount, 50, 'discount is clamped to 50%');
  assert.strictEqual(g[2], null, 'a promo in the past is dropped');
  assert.strictEqual(g[3], null, 'an unknown action type is dropped');

  // 3) propose -> approve -> effect
  const ask = async q => { await p.fill('#cQ', q); await p.press('#cQ', 'Enter'); await p.waitForTimeout(500); };
  await ask('بكرة وش نطلب عشان ما ينقص شي؟');
  let s = await p.evaluate(() => ({ acts: asst[asst.length - 1].actions, via: asst[asst.length - 1].via, pos: Object.values(Store.all('purchases')).filter(x => x.by === 'ai').length }));
  assert.strictEqual(s.via, 'store', 'a store question is answered from store data');
  assert.strictEqual(s.acts[0].type, 'purchase_order', 'the assistant proposes a purchase order');
  assert.strictEqual(s.pos, 0, 'nothing is executed before approval');
  await p.click('[data-ax$=":yes"]'); await p.waitForTimeout(500);
  s = await p.evaluate(() => ({ pos: Object.values(Store.all('purchases')).filter(x => x.by === 'ai').length, log: (Store.all('agent').log.entries || []).length }));
  assert.ok(s.pos >= 1, 'approved purchase order is created');
  assert.ok(s.log >= 1, 'the executed action is written to the audit log');
  assert.deepStrictEqual(external, [], 'no request goes to any external AI model');
  assert.deepStrictEqual(errors, []);
  console.log('assistant flow: 11 checks passed');
  await b.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
