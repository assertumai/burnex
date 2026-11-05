import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canonicalAddress,
  canonicalSpecifier,
  isPackagedAddress,
  PACKAGE_ADDRESS_PREFIX,
  PACKAGE_NAME,
  packagedAddressName,
} from '../src/kernel/package-name.js';
import { canonicalUse, keyOperations } from '../src/kernel/tree/tree.js';
import { LEGACY_SHARED_SPECIFIERS, SHARED_MODULE_IMPORT_MAP } from '../src/parts/ui/daemon/sharedModules.js';

describe('kernel/package-name: имя пакета и адреса поставки', () => {
  it('пакет — burnex, адрес поставки — burnex:<имя>', () => {
    assert.equal(PACKAGE_NAME, 'burnex');
    assert.equal(PACKAGE_ADDRESS_PREFIX, 'burnex:');
  });

  it('адрес читается под обоими именами, прочее — не адрес', () => {
    assert.equal(packagedAddressName('burnex:step'), 'step');
    assert.equal(packagedAddressName('stepcast:step'), 'step');
    assert.equal(packagedAddressName('./schema.json'), undefined);
    assert.equal(packagedAddressName('hello:greet'), undefined);
    assert.equal(isPackagedAddress('stepcast:x'), true);
    assert.equal(isPackagedAddress('hello:x'), false);
  });

  it('каноничная форма адреса — новое имя; чужие значения не трогаются', () => {
    assert.equal(canonicalAddress('stepcast:backend-claude'), 'burnex:backend-claude');
    assert.equal(canonicalAddress('burnex:backend-claude'), 'burnex:backend-claude');
    assert.equal(canonicalAddress('./x.js'), './x.js');
  });

  it('каноничная форма спецификатора — новое имя пакета и его подпутей', () => {
    assert.equal(canonicalSpecifier('stepcast/backends/codex'), 'burnex/backends/codex');
    assert.equal(canonicalSpecifier('stepcast'), 'burnex');
    assert.equal(canonicalSpecifier('stepcast-plugin-http'), 'stepcast-plugin-http');
    assert.equal(canonicalSpecifier('./stepcast/plugin.js'), './stepcast/plugin.js');
  });
});

describe('дерево состава: use строки приводится к каноничной форме на входе', () => {
  it('ключ plugins со старым адресом или подпутём читается как новый, id остаётся как написан', () => {
    assert.equal(canonicalUse('stepcast:backend-claude'), 'burnex:backend-claude');
    assert.equal(canonicalUse('stepcast/backends/codex'), 'burnex/backends/codex');
    const [row] = keyOperations(['stepcast/backends/codex'], '/p/.stepcast/config.yml');
    assert.equal(row?.use, 'burnex/backends/codex');
    assert.equal(row?.id, 'stepcast/backends/codex');
  });
});

describe('карта имён страницы: прежние @stepcast/* ведут на те же переходники', () => {
  it('каждый прежний специфик указывает на адрес своего нового', () => {
    for (const [legacy, current] of Object.entries(LEGACY_SHARED_SPECIFIERS)) {
      assert.equal(SHARED_MODULE_IMPORT_MAP[legacy], SHARED_MODULE_IMPORT_MAP[current], legacy);
    }
    assert.equal(SHARED_MODULE_IMPORT_MAP['@stepcast/ui'], '/shared/burnex-ui.js');
  });
});
