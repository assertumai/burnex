import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { BackendView, PipelineView, ProfileView, ProjectProfileView, Settings } from '../src/api';
import {
  AgentsProfiles,
  profileDraftOf,
  profileDraftProblem,
  profilesPatch,
  profileUsage,
  profileValueOf,
  removalConfirmation,
} from '../src/pages/AgentsProfiles';
import { agentChoices as policyChoices } from '../src/pages/PipelineAgents';
import { agentChoices as launchChoices } from '../src/runLaunch';

/**
 * Вкладка Profiles экрана «Agents» (`agent-profiles`). Щелчков в тестах
 * витрины нет: решения формы проверяются чистыми функциями, а то, что вкладка
 * показывает, — статическим рендером. Черновик профилей вкладка не хранит —
 * он приходит пропсом из `Agents.tsx` рядом с черновиками прочих вкладок, и
 * смена вкладки, меняющая только адрес, его не сбрасывает.
 */

const backend = (name: string, available = true): BackendView => ({
  name, command: name, enabled: true, available, defaultModelSource: 'built-in default',
  modelTiers: {}, modelTierSources: {}, modelTierEffortSources: {},
});

const STRICT: ProfileView = {
  name: 'reviewer-strict',
  profile: { backend: 'codex', model_tier: 'max', effort: 'high', context: [{ text: 'Ты строгий ревьюер.' }, 'guides/security.md'] },
  file: '/home/u/.burnex/config.yml',
};

const settings = (profiles: readonly ProfileView[] = [STRICT]): Settings => ({
  agent: { value: 'claude', source: 'built-in default' },
  model: { source: 'built-in default' },
  effort: { source: 'built-in default' },
  profiles,
  modelTiers: ['max', 'deep'],
  backends: [backend('claude'), backend('codex'), backend('copilot', false)],
  file: '/home/u/.burnex/config.yml',
});

function pipelineWith(profile: string | undefined): PipelineView {
  return {
    projectKey: 'k', projectPath: '/p', file: '.burnex/pipelines/self-improve.yml', name: 'self-improve',
    jobs: [{
      id: 'review', needs: [], on: 'success', publishesOutput: false, agentEntryJob: 'review',
      steps: [{
        id: 'review-diff', kind: 'agent', agent: 'codex',
        agentOrigin: profile === undefined ? { layer: 'step' } : { layer: 'step', profile },
      }],
    }],
  } as unknown as PipelineView;
}

describe('agent-profiles: черновик профиля', () => {
  it('нетронутый профиль ничего не меняет, правка уходит профилем целиком', () => {
    const drafts = [profileDraftOf(STRICT)];
    assert.equal(profilesPatch([STRICT], drafts), undefined);
    assert.deepEqual(profileValueOf(drafts[0]!), STRICT.profile);

    const edited = [{ ...drafts[0]!, tier: 'deep' }];
    assert.deepEqual(profilesPatch([STRICT], edited), { 'reviewer-strict': { ...STRICT.profile, model_tier: 'deep' } });
  });

  it('переименование — удаление прежнего имени и запись нового одной правкой; удаление — null', () => {
    const renamed = [{ ...profileDraftOf(STRICT), name: 'security' }];
    assert.deepEqual(profilesPatch([STRICT], renamed), { 'reviewer-strict': null, security: STRICT.profile });
    assert.deepEqual(profilesPatch([STRICT], []), { 'reviewer-strict': null });
  });

  it('выбор модели вместо уровня снимает уровень; неразбираемые формой записи контекста сохраняются', () => {
    const raw: ProfileView = { ...STRICT, profile: { backend: 'codex', context: [{ path: 'a.md', mode: 'inline' }] } };
    const draft = { ...profileDraftOf(raw), modelKind: 'model' as const, model: 'gpt-max', tier: 'max' };
    assert.deepEqual(profileValueOf(draft), { backend: 'codex', model: 'gpt-max', context: [{ path: 'a.md', mode: 'inline' }] });
  });

  it('форма имени и повтор отклоняются до отправки', () => {
    const draft = profileDraftOf(STRICT);
    assert.equal(profileDraftProblem([draft]), undefined);
    assert.match(profileDraftProblem([{ ...draft, name: 'Strict' }]) ?? '', /lowercase/);
    assert.match(profileDraftProblem([draft, draft]) ?? '', /twice/);
  });
});

describe('agent-profiles: использование и удаление', () => {
  it('использование собирается по происхождению агента шага', () => {
    const usage = profileUsage([pipelineWith('reviewer-strict'), pipelineWith(undefined)]);
    assert.deepEqual([...usage], [['reviewer-strict', ['self-improve/review/review-diff']]]);
  });

  it('удаление используемого профиля требует подтверждения, называющего шаги', () => {
    const usage = profileUsage([pipelineWith('reviewer-strict')]);
    assert.match(removalConfirmation('reviewer-strict', usage.get('reviewer-strict')) ?? '', /self-improve\/review\/review-diff/);
    assert.equal(removalConfirmation('unused', usage.get('unused')), undefined);
  });
});

describe('agent-profiles: вкладка Profiles', () => {
  const project: ProjectProfileView = {
    projectKey: 'k', projectPath: '/p', name: 'arch', backend: 'claude', modelTier: 'deep', context: [],
    file: '/p/.burnex/config.yml',
  };

  const render = (): string => renderToStaticMarkup(
    <AgentsProfiles
      settings={settings()}
      drafts={[{ ...profileDraftOf(STRICT), effort: 'low' }]}
      projectProfiles={[project]}
      pipelines={[pipelineWith('reviewer-strict')]}
      tiers={['max', 'deep']}
      onDrafts={() => undefined}
      onOpenDefault={() => undefined}
      confirm={() => true}
    />,
  );

  it('default первым ссылкой на вкладку Default, затем глобальные формой с черновиком и проектные', () => {
    const html = render();
    assert.ok(html.indexOf('>default<') < html.indexOf('reviewer-strict'));
    assert.ok(html.indexOf('reviewer-strict') < html.indexOf('>arch<'));
    assert.match(html, /Open the Default tab/);
    // Значение из черновика, а не из файла: вкладка показывает то, что держит экран.
    assert.match(html, /value="low"/);
    assert.match(html, /used by: self-improve\/review\/review-diff/);
  });

  it('проектный профиль только для чтения, с файлом-источником', () => {
    const html = render();
    const projectCard = html.slice(html.indexOf('>arch<'));
    assert.match(projectCard, /\/p\/\.burnex\/config\.yml/);
    assert.match(projectCard, /Read-only here/);
    assert.doesNotMatch(projectCard, /<input/);
    assert.doesNotMatch(projectCard, /Delete profile/);
  });
});

describe('agent-profiles: профили в выборе агента', () => {
  it('Policy: default и глобальные профили отдельной группой перед бэкендами', () => {
    const choices = policyChoices(settings());
    assert.deepEqual(choices.profiles, ['default', 'reviewer-strict']);
    assert.deepEqual(choices.agents, ['claude', 'codex']);
  });

  it('диалог запуска: профили группой над бэкендами, профиль недоступного бэкенда выключен', () => {
    const offline: ProfileView = { name: 'helper', profile: { backend: 'copilot' }, file: STRICT.file };
    const choices = launchChoices(settings().backends, [STRICT, offline]);
    assert.deepEqual(choices.map((choice) => [choice.group, choice.name, choice.disabled]), [
      ['profiles', 'reviewer-strict', false],
      ['profiles', 'helper', true],
      ['backends', 'claude', false],
      ['backends', 'codex', false],
      ['backends', 'copilot', true],
    ]);
  });
});
