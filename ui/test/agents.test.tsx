import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PipelineView } from '../src/api';
import {
  AGENT_TABS,
  connectOffered,
  connectPatch,
  effortOptions,
  isCustomValue,
  modelOptions,
  orderedTierNames,
  scopeOf,
  selectableAgent,
  tabOf,
  tierDraftProblem,
  tierSelectionPatch,
  unavailableReason,
} from '../src/pages/Agents';

/**
 * Экран «Agents» (`ui-overhaul`): поле модели — Combobox со свободным вводом,
 * варианты — перечисленные CLI плюс уже сохранённые в конфигурации имена;
 * причины недоступности перечисления названы словами.
 */
describe('ui-agents: варианты поля модели', () => {
  it('перечисленные CLI идут с подписью, сохранённые в конфигурации добавляются без повторов', () => {
    const options = modelOptions(
      [{ name: 'sonnet', label: 'Sonnet 5', title: 'Balanced model', defaultEffort: 'medium' }, { name: 'opus' }],
      ['opus', 'my-fine-tune', undefined, ' ', 'my-fine-tune'],
    );
    assert.deepEqual(options, [
      { value: 'sonnet', label: 'Sonnet 5', description: 'Balanced model · default effort: medium' },
      { value: 'opus' },
      { value: 'my-fine-tune', description: 'from configuration' },
    ]);
  });

  it('без перечисления остаются только имена из конфигурации', () => {
    assert.deepEqual(modelOptions([], ['gpt-5.6-terra']), [{ value: 'gpt-5.6-terra', description: 'from configuration' }]);
  });

  it('effort зависит от модели и сохраняет кастомное настроенное значение', () => {
    assert.deepEqual(effortOptions([
      {
        name: 'gpt-6-astra', defaultEffort: 'medium',
        efforts: [{ name: 'low', description: 'Faster' }, { name: 'high' }],
      },
    ], 'gpt-6-astra', 'max'), [
      { value: 'low', description: 'Faster' },
      { value: 'high' },
      { value: 'max', description: 'from configuration' },
    ]);
    assert.deepEqual(effortOptions([], 'custom-model', 'high'), [
      { value: 'high', description: 'from configuration' },
    ]);
    assert.equal(isCustomValue('max', ['low', 'high']), true);
    assert.equal(isCustomValue('high', ['low', 'high']), false);
  });
});

describe('ui-agents: общие tier', () => {
  it('встроенные имена идут первыми, кастомные — один раз по алфавиту', () => {
    assert.deepEqual(orderedTierNames(['review', 'deep', 'nightly', 'review']), [
      'max', 'deep', 'balance', 'fast', 'mini', 'nightly', 'review',
    ]);
  });

  it('патч различает shorthand, объект с effort, очистку и отсутствие изменения', () => {
    assert.equal(tierSelectionPatch({ model: 'opus' }, { model: 'opus', effort: '' }), undefined);
    assert.deepEqual(tierSelectionPatch(undefined, { model: 'opus', effort: '' }), { model: 'opus', effort: null });
    assert.deepEqual(tierSelectionPatch({ model: 'opus' }, { model: 'opus', effort: 'high' }), { model: 'opus', effort: 'high' });
    assert.deepEqual(tierSelectionPatch({ model: 'opus', effort: 'high' }, { model: '', effort: '' }), { model: null });
  });

  it('новый tier требует модель хотя бы одного агента, effort без модели запрещён', () => {
    const empty = {
      claude: { defaultModel: '', modelTiers: { review: { model: '', effort: '' } } },
      codex: { defaultModel: '', modelTiers: { review: { model: '', effort: '' } } },
    };
    assert.match(tierDraftProblem(['review'], [], empty) ?? '', /at least one agent/);
    assert.equal(tierDraftProblem(['review'], [], {
      ...empty,
      codex: { defaultModel: '', modelTiers: { review: { model: 'gpt-review', effort: '' } } },
    }), undefined);
    assert.match(tierDraftProblem(['review'], ['review'], {
      ...empty,
      claude: { defaultModel: '', modelTiers: { review: { model: '', effort: 'high' } } },
    }) ?? '', /model/);
  });

  it('допустимое имя constructor не читает Object.prototype как черновик tier', () => {
    const draft = {
      claude: { defaultModel: '', modelTiers: {} },
    };
    assert.match(tierDraftProblem(['constructor'], [], draft) ?? '', /at least one agent/);
  });
});

describe('ui-agents: причина недоступности перечисления', () => {
  it('каждый статус отказа назван словами, успех — без причины', () => {
    assert.equal(unavailableReason({ status: 'ok', models: [] }), undefined);
    assert.match(unavailableReason({ status: 'unsupported' }) ?? '', /cannot list/);
    assert.match(unavailableReason({ status: 'not_installed', command: 'codex' }) ?? '', /“codex” not found/);
    assert.match(unavailableReason({ status: 'timeout' }) ?? '', /did not answer/);
    assert.equal(unavailableReason({ status: 'failed', message: '' }), 'The agent failed without saying why');
    assert.equal(unavailableReason({ status: 'failed', message: 'boom' }), 'The agent failed: boom');
    assert.match(unavailableReason({ status: 'unparsed' }) ?? '', /could not be parsed/);
    assert.equal(unavailableReason({ status: 'probe_error', message: 'x' }), 'Listing crashed: x');
  });
});

describe('ui-agents: вкладка из адреса и область действия модели по умолчанию', () => {
  it('tabOf знает четыре вкладки, пустое и неизвестное значение открывают Default', () => {
    assert.deepEqual(AGENT_TABS, ['default', 'backends', 'tiers', 'policy']);
    for (const tab of AGENT_TABS) assert.equal(tabOf(tab), tab);
    assert.equal(tabOf(undefined), 'default');
    assert.equal(tabOf(''), 'default');
    assert.equal(tabOf('other'), 'default');
  });

  it('scopeOf различает затронутые, объявившие сами, перекрытые ближним файлом и неразобранные', () => {
    const settingsFile = '/home/me/.stepcast/config.yml';
    const pipeline = (name: string, steps: readonly { readonly layer: string; readonly file?: string }[]): PipelineView =>
      ({
        projectKey: 'p', projectPath: '/p', file: `${name}.yml`, name, inputs: [],
        jobs: [{
          id: 'job', needs: [], on: 'success', publishesOutput: false, agentEntryJob: 'job',
          steps: steps.map((origin, index) => ({
            id: `s${index}`, kind: 'agent', agent: 'claude',
            modelOrigin: { layer: origin.layer, ...(origin.file === undefined ? {} : { file: origin.file }) },
          })),
        }],
      }) as unknown as PipelineView;
    const broken = { projectKey: 'p', projectPath: '/p', file: 'x.yml', name: 'x', inputs: [], jobs: [], error: 'boom' } as unknown as PipelineView;

    assert.deepEqual(scopeOf([
      pipeline('a', [
        { layer: 'step' }, { layer: 'job' }, { layer: 'pipeline' },
        { layer: 'config', file: settingsFile },
        { layer: 'config', file: '/p/.stepcast/config.yml' },
        { layer: 'backend' }, { layer: 'none' },
      ]),
      broken,
    ], settingsFile), { affected: 3, unaffected: 3, overridden: 1, unparsed: 1 });
    assert.deepEqual(scopeOf([], settingsFile), { affected: 0, unaffected: 0, overridden: 0, unparsed: 0 });
  });
});

describe('selectableAgent', () => {
  const none = new Set<string>();
  it('подключённый включённый бэкенд выбирается без отметки', () => {
    assert.equal(selectableAgent({ name: 'claude', enabled: true, available: true }, none), true);
  });
  it('неподключённый выбирается только вместе с отметкой «Connect»', () => {
    const backend = { name: 'cursor-agent', enabled: true, available: false };
    assert.equal(selectableAgent(backend, none), false);
    assert.equal(selectableAgent(backend, new Set(['copilot'])), false);
    assert.equal(selectableAgent(backend, new Set(['cursor-agent'])), true);
  });
  it('выключенный не выбирается, даже отмеченный', () => {
    assert.equal(selectableAgent({ name: 'codex', enabled: false, available: false }, new Set(['codex'])), false);
    assert.equal(selectableAgent({ name: 'claude', enabled: false, available: true }, none), false);
  });
});

describe('действие «Connect» на вкладке Backends', () => {
  it('есть только у неподключённого бэкенда, адаптер которого поставляется со Stepcast', () => {
    assert.equal(connectOffered({ available: false, plugin: 'stepcast/backends/copilot' }), true);
    assert.equal(connectOffered({ available: true }), false, 'claude и подключённые бэкенды plugin не несут');
    assert.equal(connectOffered({ available: true, plugin: 'stepcast/backends/codex' }), false);
    assert.equal(connectOffered({ available: false }), false, 'подключить из витрины нечем');
  });
  it('отмеченное подключение уходит полем connect, без connectCodex', () => {
    assert.deepEqual(connectPatch(new Set(['copilot'])), { connect: ['copilot'] });
    assert.deepEqual(connectPatch(new Set(['codex'])), { connect: ['codex'] });
    assert.deepEqual(connectPatch(new Set()), {});
  });
});
