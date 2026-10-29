import { homedir } from 'node:os';
import { isMap, type Document } from 'yaml';
import { z } from 'zod';

import { EffortSchema, ModelNameSchema, ModelTierSchema } from '../pipeline/config/schema.js';
import { StepcastError } from '../../kernel/errors.js';
import type { KernelCache } from './pipelines.js';
import { editGlobalConfig, readSettings } from './settings.js';

/**
 * Запись выбора пользователя с экрана Pipelines в `pipeline_agents` и
 * `step_agents` глобального файла (`agent-policy-and-pipeline-agents`,
 * design.md, решение 8). Экран пишет только глобальный файл: проектный лежит
 * в репозитории и попадает в ревью.
 *
 * Поле со значением `null` снимается; `selection: null` снимает запись целиком.
 * Выбор tier снимает `model`, выбор модели — `model_tier`: слой выбирает модель
 * целиком, и две половины одной записи не сосуществуют (docs/config.md).
 */
const FieldPatch = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

export const PipelineAgentPatchSchema = z
  .object({
    pipeline: z.string().min(1),
    job: z.string().min(1).optional(),
    step: z.string().min(1).optional(),
    selection: z
      .object({
        agent: FieldPatch(z.string().min(1)),
        model: FieldPatch(ModelNameSchema),
        model_tier: FieldPatch(ModelTierSchema),
        effort: FieldPatch(EffortSchema),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((value) => (value.job === undefined) === (value.step === undefined), {
    message: 'job и step называются вместе: запись шага адресуется работой и шагом',
  })
  .refine(
    (value) =>
      value.selection === null || value.selection.model === undefined || value.selection.model === null ||
      value.selection.model_tier === undefined || value.selection.model_tier === null,
    { message: 'model и model_tier в одной правке задать нельзя: выбор модели слоем целиком' },
  );

export type PipelineAgentPatch = z.infer<typeof PipelineAgentPatchSchema>;

type EntryField = 'agent' | 'model' | 'model_tier' | 'effort';

/** Убрать пустой узел и опустевших родителей, чтобы файл не копил `{}`. */
function pruneEmpty(document: Document, path: readonly string[]): void {
  for (let depth = path.length; depth > 0; depth -= 1) {
    const prefix = path.slice(0, depth);
    const node = document.getIn(prefix, true);
    if (node === undefined || (isMap(node) && node.items.length === 0)) document.deleteIn(prefix);
    else break;
  }
}

export async function writePipelineAgent(
  input: unknown,
  home: string = homedir(),
  kernelCache?: KernelCache,
): Promise<void> {
  const parsed = PipelineAgentPatchSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new StepcastError(`Invalid pipeline agent selection ${issue.path.join('.')}: ${issue.message}`);
  }
  const patch = parsed.data;

  // Агент, которого нельзя запустить, в запись не попадёт: раскрытие этого
  // пайплайна отказало бы с названным ключом, и карточка осталась бы с ошибкой.
  const agent = patch.selection?.agent;
  if (typeof agent === 'string') {
    const backend = (await readSettings(home, kernelCache)).backends.find((candidate) => candidate.name === agent);
    if (backend === undefined) throw new StepcastError(`Unknown agent ${agent}`);
    if (!backend.enabled) throw new StepcastError(`Agent ${agent} is disabled`);
    if (!backend.available) throw new StepcastError(`Agent ${agent} is not connected: connect its plugin first`);
  }

  const path = patch.job === undefined || patch.step === undefined
    ? ['pipeline_agents', patch.pipeline]
    : ['step_agents', patch.pipeline, patch.job, patch.step];

  editGlobalConfig(home, (document) => {
    if (patch.selection === null) {
      document.deleteIn(path);
    } else {
      const fields: EntryField[] = ['agent', 'model', 'model_tier', 'effort'];
      for (const field of fields) {
        const value = patch.selection[field];
        if (value === undefined) continue;
        if (value === null) document.deleteIn([...path, field]);
        else document.setIn([...path, field], value);
      }
      // Выбор одной половины пары снимает другую.
      if (typeof patch.selection.model === 'string') document.deleteIn([...path, 'model_tier']);
      if (typeof patch.selection.model_tier === 'string') document.deleteIn([...path, 'model']);
    }
    pruneEmpty(document, path);
  });
}
