import type { z } from 'zod';

import { PipelineDocumentSchema, JobDocumentSchema, StepManifestSchema } from '../src/parts/pipeline/document/schema.js';
import { PluginsPatchDocumentSchema, RawConfigSchema } from '../src/parts/pipeline/config/schema.js';
import { ReviewStrategySchema } from '../src/parts/pipeline/document/reviewStrategy.js';
import { PluginManifestSchema } from '../src/kernel/tree/manifest.js';
import { BacklogItemSchema, BacklogSlotsResponseSchema } from '../src/parts/pipeline/domain/backlog/schema.js';
import { RouteDocumentSchema } from '../src/parts/ui/routesFile.js';
import { DashboardDocumentSchema } from '../src/parts/ui/dashboardsFile.js';
import { PackageManifestSchema } from '../src/parts/packages/manifest.js';

/**
 * Перечень целей генерации JSON Schema — общий для скрипта печати
 * (`generate-schema.ts`) и для теста их свежести (`test/schema-generated.test.ts`):
 * расхождение между печатаемым и проверяемым перечнем было бы той же бедой,
 * от которой уходит генерация схем из моделей.
 */
export interface SchemaTarget {
  readonly file: string;
  readonly schema: z.ZodType;
  readonly title: string;
  /** Форма документа: `input` — то, что пишет человек, `output` — то, что печатает команда. */
  readonly io: 'input' | 'output';
  /**
   * Печатается `buildPublishedSchemas()` (с пустым перечнем плагинных
   * предикатов — реестра здесь нет), а не прямым вызовом `z.toJSONSchema`:
   * печать схемы пакета и схемы проекта обязана идти одним кодом (design.md,
   * решение 4). `schema`/`io` у такой цели остаются — ими пользуется
   * независимая проверка `test/schema-generated.test.ts`.
   */
  readonly published?: 'pipeline' | 'job';
}

export const SCHEMA_TARGETS: readonly SchemaTarget[] = [
  {
    file: 'schema/pipeline.schema.json',
    schema: PipelineDocumentSchema,
    title: 'burnex pipeline',
    io: 'input',
    published: 'pipeline',
  },
  {
    file: 'schema/job.schema.json',
    schema: JobDocumentSchema,
    title: 'burnex job',
    io: 'input',
    published: 'job',
  },
  { file: 'schema/config.schema.json', schema: RawConfigSchema, title: 'burnex config', io: 'input' },
  {
    file: 'schema/plugins-patch.schema.json',
    schema: PluginsPatchDocumentSchema,
    title: 'burnex plugins patch',
    io: 'input',
  },
  {
    file: 'schema/review-strategy.schema.json',
    schema: ReviewStrategySchema,
    title: 'burnex review strategy',
    io: 'input',
  },
  {
    file: 'schema/step-manifest.schema.json',
    schema: StepManifestSchema,
    title: 'burnex step manifest',
    io: 'input',
  },
  {
    file: 'schema/plugin-manifest.schema.json',
    schema: PluginManifestSchema,
    title: 'burnex plugin manifest',
    io: 'input',
  },
  {
    file: 'schema/backlog.schema.json',
    schema: BacklogItemSchema,
    title: 'burnex backlog item',
    io: 'input',
  },
  {
    file: 'schema/backlog-slots.schema.json',
    schema: BacklogSlotsResponseSchema,
    title: 'burnex backlog pick --lanes',
    io: 'output',
  },
  {
    file: 'schema/routes.schema.json',
    schema: RouteDocumentSchema,
    title: 'burnex routes',
    io: 'input',
  },
  {
    file: 'schema/dashboard.schema.json',
    schema: DashboardDocumentSchema,
    title: 'burnex dashboard',
    io: 'input',
  },
  {
    file: 'schema/package.schema.json',
    schema: PackageManifestSchema,
    title: 'burnex package manifest',
    io: 'input',
  },
];
