import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyScript, foldForSearch, looksLikeFranco, normalizeArabic,
  stripProclitic, stemsForSearch,
} from '../src/core/normalize.js';

test('every alef variant folds to bare alef', () => {
  assert.equal(normalizeArabic('أحمد'), 'احمد');
  assert.equal(normalizeArabic('آسف'), 'اسف');
  assert.equal(normalizeArabic('إسكندرية'), 'اسكندريه');
});

test('taa marbuta, alef maksura and diacritics are folded', () => {
  assert.equal(normalizeArabic('الشقة'), 'الشقه');
  assert.equal(normalizeArabic('مُحَمَّد'), 'محمد');
  assert.equal(normalizeArabic('على'), 'علي');
  assert.equal(normalizeArabic('مبـــروك'), 'مبروك');
});

test('two spellings of one word converge', () => {
  assert.equal(normalizeArabic('الشقة'), normalizeArabic('الشقه'));
  assert.equal(normalizeArabic('إنشاء'), normalizeArabic('انشاء'));
});

test('arabic-indic digits become ascii', () => {
  assert.equal(normalizeArabic('٤٢٠٠ جنيه'), '4200 جنيه');
});

test('folding is idempotent', () => {
  const once = normalizeArabic('إن شاء الله ٣');
  assert.equal(normalizeArabic(once), once);
});

test('real franco is detected', () => {
  for (const s of [
    '3ashan el sha2a ba3at el deposit',
    'ma3lesh ana nesit',
    'el mo3ad kan embare7',
    'tmam yalla bokra',
    '7abibi 3amel eh',
  ]) assert.ok(looksLikeFranco(s), s);
});

test('developer jargon is not mistaken for franco', () => {
  for (const s of [
    'deploy v2 to staging at 5pm',
    'convert the mp3 and base64 the blob',
    'sha256 mismatch on x86 build',
    'utf8 encoding issue in h264 stream',
    'enable 2fa on the admin account',
    'can you send me the invoice tomorrow please',
  ]) assert.equal(looksLikeFranco(s), false, s);
});

test('script classification routes the enrichment queue', () => {
  assert.equal(classifyScript('الشقة جاهزة'), 'arabic');
  assert.equal(classifyScript('el sha2a gahza ya 3am'), 'franco');
  assert.equal(classifyScript('the apartment is ready'), 'latin');
  assert.equal(classifyScript('الشقة ready بكرة'), 'mixed');
  assert.equal(classifyScript('   '), 'empty');
});

test('search folding lowercases latin and canonicalises arabic', () => {
  assert.equal(foldForSearch('Deposit'), 'deposit');
  assert.equal(foldForSearch('الشقة'), 'الشقه');
});

test('arabic proclitics are stripped so glued prefixes stay reachable', () => {
  // Regression: searching الشقة used to miss للشقة entirely, because FTS
  // prefix matching starts at the token boundary and لل sits in front of it.
  assert.equal(stripProclitic('للشقه'), 'شقه');
  assert.equal(stripProclitic('والشقه'), 'شقه');
  assert.equal(stripProclitic('بالبيت'), 'بيت');
  assert.equal(stripProclitic('الشقه'), 'شقه');
  // Short words must survive intact — stripping ال from الي leaves nothing useful.
  assert.equal(stripProclitic('الي'), 'الي');
  assert.equal(stripProclitic('بيت'), 'بيت');
});

test('stems are only produced for arabic tokens', () => {
  assert.equal(stemsForSearch('the apartment is ready'), '');
  assert.ok(stemsForSearch('بعت الديبوزت للشقه').includes('شقه'));
});
