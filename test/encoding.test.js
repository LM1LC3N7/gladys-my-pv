// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, and never
// mojibake: UTF-8 bytes read as Latin-1 / Windows-1252 and saved again ("é"
// becoming "Ã" + "©", the apostrophe "’" becoming "â" + "€" + "™"). A secret
// field is never said to be encrypted: Gladys keeps it in clear in its base.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MOJIBAKE = /[ÂÃ][\u0080-¿€]|â€/;
const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'src/i18n.js',
  'src/models.js',
];

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url));

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake`, () => {
    const bytes = read(file);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
  });
}

test('the mojibake pattern catches what it should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.match('ACâ€¢THOR', MOJIBAKE, '• read as Windows-1252');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app… AC•THOR 55 °C', MOJIBAKE);
});

test('a secret is never said to be encrypted', () => {
  // "chiffré(e)" (encrypted), never "chiffres" (digits).
  const ENCRYPTED = /chiffré|encrypt|\bcrypté/i;
  for (const file of [...FILES, 'src/config.js', 'src/store.js', 'src/mypv/http.js']) {
    const text = read(file).toString('utf8');
    const line = text
      .split('\n')
      .findIndex((l) => ENCRYPTED.test(l) && !/never said|jamais dit|ENCRYPTED/.test(l));
    assert.equal(line, -1, `${file}: "encrypted" on line ${line + 1}`);
  }
});

test('LICENSE names nobody', () => {
  const license = read('LICENSE').toString('utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Copyright (?:\(c\) )?\d{4}/i);
});

test('the image ships the license and the third-party notices', () => {
  const dockerfile = read('Dockerfile').toString('utf8');
  assert.match(dockerfile, /COPY [^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
  const notices = read('THIRD_PARTY_NOTICES.md').toString('utf8');
  assert.match(notices, /py-mypv/);
  assert.match(notices, /Copyright 2026 my-PV GmbH/);
  assert.match(notices, /Licensed under the Apache License, Version 2\.0/);
});
