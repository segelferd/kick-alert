// KickAlert v2.5.101: chat text normalisation for filters and mention matching.
// Loaded as a content script before chat.js and in the background (importScripts /
// background.scripts), so every matcher uses the same rules.
//
// kaFold(s) makes the usual filter evasions compare equal to the plain word:
//   - full-width / styled letters (ｓｐａｍ, 𝐬𝐩𝐚𝐦) -> NFKC
//   - invisible characters (zero-width space/joiner, soft hyphen, BOM, tag chars) -> removed
//   - Cyrillic / Greek look-alikes inside Latin text (ѕрам) -> Latin
//   - accents on Latin letters (şpâm, ı) -> plain letter, so "serefsiz" also matches "şerefsiz"
// Folding is applied to both the message and the filter word, so non-Latin words
// (Russian, Arabic, Japanese...) keep matching themselves exactly as before.
//
// kaMatchWord(text, word) = whole-word match on folded text, plus the same match on
// a copy where runs of single letters split by spaces/dots/dashes are joined
// ("s p a m", "s.p.a.m" -> "spam"). Words longer than one letter are never joined,
// so "is pamela" can not turn into "spam".

var KA_FOLD_INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]|\uDB40[\uDC00-\uDC7F]/g;
var KA_FOLD_MAP = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x',
  'ѕ': 's', 'і': 'i', 'ї': 'i', 'ј': 'j', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'һ': 'h', 'ӏ': 'l', 'ɡ': 'g',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'μ': 'u', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
  // Latin extras that have no decomposition
  'ı': 'i', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ħ': 'h', 'ŧ': 't',
};
var KA_FOLD_MAP_RE = new RegExp('[' + Object.keys(KA_FOLD_MAP).join('') + ']', 'g');
var KA_FOLD_MAP_TEST = new RegExp('[' + Object.keys(KA_FOLD_MAP).join('') + ']');

function kaFold(s, allLookalikes) {
  if (!s) return '';
  let t = String(s);
  try { t = t.normalize('NFKC'); } catch (e) {}
  t = t.replace(KA_FOLD_INVISIBLE, '').toLowerCase();
  // Look-alikes are mapped only inside words that also contain a Latin letter, so a
  // purely Cyrillic/Greek word stays as it is (and still matches the same word).
  t = t.replace(/[\p{L}\p{M}]+/gu, w => ((allLookalikes || /[a-z]/.test(w)) && KA_FOLD_MAP_TEST.test(w)) ? w.replace(KA_FOLD_MAP_RE, c => KA_FOLD_MAP[c]) : w);
  // Latin-only extras (ı, ł...) in otherwise Latin words
  t = t.replace(/[ıłøđħŧ]/g, c => KA_FOLD_MAP[c]);
  // Strip accents from Latin letters only (keeps Japanese dakuten, Arabic marks etc.)
  try { t = t.normalize('NFKD').replace(/([a-z])\p{M}+/gu, '$1').normalize('NFC'); } catch (e) {}
  return t;
}

// "s p a m" / "s.p.a.m" / "s-p-a-m" -> "spam" (only runs of 3+ single letters)
function kaJoinSpaced(t) {
  return t.replace(/(?<![\p{L}\p{N}])[\p{L}\p{N}](?:[\s.\-_*·•|,]+[\p{L}\p{N}](?![\p{L}\p{N}])){2,}/gu, m => m.replace(/[\s.\-_*·•|,]+/g, ''));
}

function kaHasWord(lt, lw) {
  const isLetter = c => /[\p{L}\p{N}_]/u.test(c);
  let idx = 0;
  while ((idx = lt.indexOf(lw, idx)) !== -1) {
    const before = idx > 0 ? lt[idx - 1] : '';
    const after = idx + lw.length < lt.length ? lt[idx + lw.length] : '';
    if (!isLetter(before) && !isLetter(after)) return true;
    idx++;
  }
  return false;
}

var _kaFoldCache = { src: null, folded: '', joined: null, full: null };
function kaFoldCached(text) {
  if (_kaFoldCache.src !== text) { _kaFoldCache = { src: text, folded: kaFold(text), joined: null, full: null }; }
  return _kaFoldCache;
}

function kaMatchWord(text, word) {
  const lw = kaFold(word).trim();
  if (!lw) return false;
  const c = kaFoldCached(text || '');
  if (kaHasWord(c.folded, lw)) return true;
  if (c.joined === null) c.joined = kaJoinSpaced(c.folded);
  if (c.joined !== c.folded && kaHasWord(c.joined, lw.replace(/[\s.\-_*·•|,]+/g, ''))) return true;
  // Latin filter word vs a word written entirely in Cyrillic/Greek look-alikes ("ѕрам")
  if (/[a-z]/.test(lw) && KA_FOLD_MAP_TEST.test(c.folded)) {
    if (c.full === null) c.full = kaJoinSpaced(kaFold(text, true));
    if (kaHasWord(c.full, lw.replace(/[\s.\-_*·•|,]+/g, ''))) return true;
  }
  return false;
}

// Mention check: folded "contains" (same as the old toLowerCase().includes)
function kaContains(text, needle) {
  const n = kaFold(needle).trim();
  if (!n) return false;
  return kaFoldCached(text || '').folded.includes(n);
}
