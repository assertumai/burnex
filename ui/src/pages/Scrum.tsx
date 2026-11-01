import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import {
  columnOf,
  insertionBefore,
  isDroppable,
  viewBoard,
  type ScrumColumn,
} from '../../../src/parts/ui/scrumView';
import {
  addBoardColumn,
  editBacklogItem,
  moveBacklogItem,
  type BacklogItemView,
  type BacklogOverview,
} from '../api';
import { fmtTime } from '../format';
import { RunLaunchDialog } from '../components/RunLaunchDialog';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  statusBadgeVariant,
} from '@stepcast/ui';
import './scrum.css';

/**
 * Доска очереди: встроенные колонки плюс заведённые проектом
 * (`.stepcast/board.yml`), карточки перетаскиваются.
 *
 * Пункт со статусом, под который колонки нет, доску не ломает и в чужую
 * колонку не подкладывается: он показан полосой над доской с предложением
 * завести колонку, и место новой колонки выбирает человек.
 *
 * Данные — тот же живой поток, что у экрана «Бэклог» (событие `backlog`):
 * своего запроса доска не делает, и после правки файла в редакторе карточки
 * встают на новые места сами.
 *
 * Перетаскивание пишет файл: колонка задаёт `status`, место в колонке —
 * положение пункта в `backlog.md`, а колонка «Архив» — перенос в `archived.md`
 * (`POST /api/backlog/move`). Оптимистичного состояния доска не держит:
 * карточка встаёт на новое место, когда его подтвердил файл, — иначе экран
 * показывал бы порядок, которого на диске нет.
 *
 * Колонка «В работе» — единственная, в которую доска не пишет: пункт берёт в
 * работу запуск пайплайна (`backlog pick --only`), проставляя статус и момент
 * взятия одним вызовом. Поэтому бросок на неё открывает выбор пайплайна, а
 * состояние меняет уже прогон.
 */

/** Последний сегмент пути проекта — короткое имя для меню; полный путь остаётся подсказкой. */
function projectName(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? path;
}

function Card({
  item,
  dragging,
  selected,
}: {
  readonly item: BacklogItemView;
  readonly dragging?: boolean;
  readonly selected?: boolean;
}): JSX.Element {
  return (
    <article
      className={`scrum-card${dragging === true ? ' dragging' : ''}${selected === true ? ' selected' : ''}`}
    >
      <header className="scrum-card-head">
        <span className="mono small dim">{item.slug}</span>
        {item.track === '' ? null : <span className="scrum-track mono small">{item.track}</span>}
      </header>
      <p className="scrum-card-title">{item.title}</p>
      <footer className="scrum-card-foot small dim">
        {item.status === 'failed' ? <Badge variant="destructive">failed</Badge> : null}
        {item.status === 'in_progress' && item.startedAt !== undefined ? (
          <span>picked up {fmtTime(item.startedAt)}</span>
        ) : null}
        {item.group === item.slug ? null : <span className="mono">{item.group}</span>}
      </footer>
    </article>
  );
}

/**
 * Карточка, которую можно и перетащить, и выбрать щелчком.
 *
 * Одно другому не мешает: сенсор начинает перетаскивание только после
 * нескольких пикселей движения (`activationConstraint`), и щелчок на месте до
 * него не доходит — иначе выбрать карточку было бы нечем.
 */
function SortableCard({
  item,
  selected,
  onSelect,
}: {
  readonly item: BacklogItemView;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.slug });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      {...attributes}
      {...listeners}
      onClick={onSelect}
    >
      <Card item={item} selected={selected} />
    </div>
  );
}

function Column({
  id,
  title,
  items,
  note,
  selected,
  onSelect,
}: {
  readonly id: ScrumColumn;
  readonly title: string;
  readonly items: readonly BacklogItemView[];
  readonly note?: string;
  readonly selected: string | undefined;
  readonly onSelect: (slug: string) => void;
}): JSX.Element {
  // Колонка — сама по себе цель броска: без этого пустую колонку нечем было
  // бы наполнить, ведь сортируемых соседей в ней нет.
  const { setNodeRef, isOver } = useDroppable({ id: `column:${id}` });

  return (
    <section className={`scrum-column${isOver ? ' over' : ''}`} ref={setNodeRef}>
      <header className="scrum-column-head">
        <h2>{title}</h2>
        <span className="small dim">{items.length}</span>
      </header>
      {note === undefined ? null : <p className="small dim scrum-column-note">{note}</p>}
      <SortableContext items={items.map((item) => item.slug)} strategy={verticalListSortingStrategy}>
        <div className="scrum-column-body">
          {items.map((item) => (
            <SortableCard
              key={item.slug}
              item={item}
              selected={item.slug === selected}
              onSelect={() => onSelect(item.slug)}
            />
          ))}
        </div>
      </SortableContext>
    </section>
  );
}

/** Что выбирает диалог запуска: пункт, который берут в работу, и пайплайны, которым его есть куда передать. */
interface LaunchIntent {
  readonly item: BacklogItemView;
  readonly projectKey: string;
}

/** Статус без колонки, для которого открыт диалог добавления. */
interface ColumnIntent {
  readonly status: string;
  readonly projectKey: string;
}

/**
 * Диалог «завести колонку»: название и место среди колонок доски.
 *
 * Место выбирается промежутком между соседями, а не номером: «между „К
 * работе“ и „В работе“» читается сразу, номер пришлось бы пересчитывать по
 * доске глазами.
 */
function AddColumnDialog({
  intent,
  columns,
  onClose,
}: {
  readonly intent: ColumnIntent | undefined;
  readonly columns: readonly { readonly id: string; readonly title: string }[];
  readonly onClose: () => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [index, setIndex] = useState(1);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (intent === undefined) return;
    setTitle(intent.status);
    setError(undefined);
    // По умолчанию — сразу за «К работе»: незнакомый статус чаще всего
    // открытый («отложено», «ждёт»), и рядом с очередью ему самое место.
    const todo = columns.findIndex((column) => column.id === 'todo');
    setIndex(todo < 0 ? 0 : todo + 1);
  }, [intent?.status, intent?.projectKey]);

  const quote = (text: string): string => `“${text}”`;
  const placeLabel = (at: number): string => {
    const left = columns[at - 1];
    const right = columns[at];
    if (left === undefined && right !== undefined) return `First, before ${quote(right.title)}`;
    if (right === undefined && left !== undefined) return `Last, after ${quote(left.title)}`;
    if (left !== undefined && right !== undefined) return `Between ${quote(left.title)} and ${quote(right.title)}`;
    return 'The only one';
  };

  const add = async (): Promise<void> => {
    if (intent === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const trimmed = title.trim();
      await addBoardColumn({
        project: intent.projectKey,
        id: intent.status,
        index,
        ...(trimmed === '' || trimmed === intent.status ? {} : { title: trimmed }),
      });
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={intent !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add column</DialogTitle>
          <DialogDescription>
            {intent === undefined ? null : (
              <>
                For status <span className="mono">{intent.status}</span>. The layout is written to the project’s{' '}
                <span className="mono">.stepcast/board.yml</span>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <Label className="scrum-field">
          <span>Column title</span>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Label>

        <p className="small dim">Where should it go?</p>
        <ul className="scrum-pipelines">
          {Array.from({ length: columns.length + 1 }, (_, at) => (
            <li key={at}>
              <label className="scrum-pipeline">
                <input
                  type="radio"
                  name="scrum-column-place"
                  value={at}
                  checked={at === index}
                  onChange={() => setIndex(at)}
                />
                <span className="scrum-pipeline-body">{placeLabel(at)}</span>
              </label>
            </li>
          ))}
        </ul>

        {error === undefined ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void add()}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Поля пункта, которые правит панель: те же, что принимает `POST /api/backlog/item`. */
interface ItemFields {
  title: string;
  why: string;
  done_when: string;
  group: string;
  track: string;
  repos: string;
  needs: string;
}

/**
 * Значение поля однострочно (`docs/backlog.md`): многострочный ввод сводится к
 * одной строке при сохранении, а не отвергается. Панель показывает текст в
 * области с переносом — иначе абзац `why` читался бы в щёлку, — и перенос,
 * набранный человеком, ценой отказа в сохранении быть не должен.
 */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function fieldsOf(item: BacklogItemView): ItemFields {
  return {
    title: item.title,
    why: item.why,
    done_when: item.doneWhen,
    // Действующая группа равна слагу, когда поле не заполнено: показывать её в
    // поле ввода значило бы предлагать записать в файл то, чего человек не
    // писал (`effectiveGroup`, `src/parts/pipeline/domain/backlog/parse.ts`).
    group: item.group === item.slug ? '' : item.group,
    track: item.track,
    repos: '',
    needs: item.needs.join(', '),
  };
}

/**
 * Панель деталей справа от доски: выбранный пункт целиком, с правкой полей.
 *
 * Правится то, что описывает работу; статус задаёт колонка, `started_at` и
 * `reason` пишет движок — они показаны, но не редактируются
 * (`src/parts/ui/screens/scrum/server.ts`, перечень полей).
 *
 * Форма не перечитывается на каждый кадр живого потока: значения набираются
 * заново только при смене выбранного пункта. Иначе такт наблюдателя,
 * пришедший посреди набора, стирал бы недописанную строку.
 */
function ItemDetails({
  item,
  projectKey,
  statusBySlug,
  onClose,
}: {
  readonly item: BacklogItemView;
  readonly projectKey: string;
  /** Статусы пунктов проекта из обоих файлов, очередь приоритетнее архива — как у `statusResolver` движка. */
  readonly statusBySlug: ReadonlyMap<string, string>;
  readonly onClose: () => void;
}): JSX.Element {
  const [fields, setFields] = useState<ItemFields>(() => fieldsOf(item));
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setFields(fieldsOf(item));
    setError(undefined);
    setSaved(false);
    // Слаг, а не сам пункт: объект приходит новым на каждом кадре потока.
  }, [item.slug]);

  const set = (name: keyof ItemFields, value: string): void => {
    setFields((current) => ({ ...current, [name]: value }));
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await editBacklogItem({
        project: projectKey,
        slug: item.slug,
        fields: {
          title: oneLine(fields.title),
          why: oneLine(fields.why),
          done_when: oneLine(fields.done_when),
          group: oneLine(fields.group),
          track: oneLine(fields.track),
          ...(fields.repos === '' ? {} : { repos: oneLine(fields.repos) }),
          // В отличие от `repos`, форма `needs` стартует с текущего перечня:
          // очищенное поле должно дойти до сервера пустой строкой — она и
          // убирает поле. Пункт без зависимостей пустое поле не шлёт вовсе.
          ...(fields.needs === '' && item.needs.length === 0 ? {} : { needs: oneLine(fields.needs) }),
        },
      });
      setSaved(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="scrum-details">
      <header className="scrum-details-head">
        <span className="mono small">{item.slug}</span>
        <Button variant="ghost" size="sm" onClick={onClose} title="Close details" aria-label="Close details">
          ×
        </Button>
      </header>

      <p className="small dim scrum-details-meta">
        <Badge variant={statusBadgeVariant(item.status)}>{item.status}</Badge>
        <span className="mono">{item.sourceFile}</span>
        {item.startedAt === undefined ? null : <span>picked up {fmtTime(item.startedAt)}</span>}
      </p>

      {item.reason === undefined ? null : <p className="small">failure reason: {item.reason}</p>}

      <Label className="scrum-field">
        <span>Title</span>
        <Input value={fields.title} onChange={(event) => set('title', event.target.value)} />
      </Label>

      <Label className="scrum-field">
        <span>Why</span>
        <textarea className="sc-input" rows={5} value={fields.why} onChange={(event) => set('why', event.target.value)} />
      </Label>

      <Label className="scrum-field">
        <span>Done when</span>
        <textarea
          className="sc-input"
          rows={5}
          value={fields.done_when}
          onChange={(event) => set('done_when', event.target.value)}
        />
      </Label>

      <Label className="scrum-field">
        <span>Group</span>
        <Input
          value={fields.group}
          placeholder={item.slug}
          onChange={(event) => set('group', event.target.value)}
        />
      </Label>

      <Label className="scrum-field">
        <span>Track</span>
        <Input value={fields.track} onChange={(event) => set('track', event.target.value)} />
      </Label>

      <Label className="scrum-field">
        {/* Пустое поле значит «не трогать»: перечень репозиториев вид пункта не
            несёт, и подставить сюда прежнее значение неоткуда. */}
        <span>Repositories (comma-separated)</span>
        <Input value={fields.repos} onChange={(event) => set('repos', event.target.value)} />
      </Label>

      <Label className="scrum-field">
        <span>Needs (comma-separated slugs)</span>
        <Input value={fields.needs} onChange={(event) => set('needs', event.target.value)} />
      </Label>

      {item.needs.length === 0 ? null : (
        <ul className="scrum-pipelines small">
          {item.needs.map((slug) => {
            const status = statusBySlug.get(slug);
            return (
              <li key={slug}>
                <span className="mono">{slug}</span>
                {status === undefined ? null : <Badge variant={statusBadgeVariant(status)}>{status}</Badge>}
                <span className="dim">{status === undefined ? 'not in the queue' : status === 'done' ? 'met' : 'waiting'}</span>
              </li>
            );
          })}
        </ul>
      )}

      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="scrum-details-foot">
        <Button disabled={busy} onClick={() => void save()}>
          Save
        </Button>
        {saved ? <span className="small dim">saved</span> : null}
      </div>
    </aside>
  );
}

export function Scrum({ backlog }: { readonly backlog: BacklogOverview | undefined }): JSX.Element {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [openItem, setOpenItem] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [intent, setIntent] = useState<LaunchIntent | undefined>(undefined);
  const [columnIntent, setColumnIntent] = useState<ColumnIntent | undefined>(undefined);

  const projects = backlog?.projects ?? [];
  const view = useMemo(() => viewBoard(projects, selected), [projects, selected]);

  const sensors = useSensors(
    // Порог в несколько пикселей: без него клик по карточке считался бы
    // началом перетаскивания, и раскрыть карточку было бы нечем.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const header = (
    <PageHeader
      title="Board"
      description="One project’s queue laid out in columns; drag a card to change its status or order, click it to edit the item, drop it on In progress to start a pipeline."
    />
  );

  if (backlog === undefined) {
    return (
      <>
        {header}
        <EmptyState title="Loading…" />
      </>
    );
  }

  if (projects.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          title="No queues found"
          description={
            <>
              The daemon looks for a <code>backlog.md</code> file in the root of every project whose runs it sees.
            </>
          }
        />
      </>
    );
  }

  const allItems = [...view.columns, ...view.unplaced].flatMap((group) => group.items);
  const itemBySlug = new Map(allItems.map((item) => [item.slug, item] as const));
  // Архив кладётся первым, очередь поверх него: слаг в обоих файлах — пункт,
  // вернувшийся в работу, и рабочим считается файл очереди. Обходится полный
  // перечень, а не `itemBySlug`: в нём дубль слага уже схлопнут.
  const statusBySlug = new Map<string, string>();
  for (const file of ['archived.md', 'backlog.md'] as const) {
    for (const item of allItems) {
      if (item.sourceFile === file) statusBySlug.set(item.slug, item.status);
    }
  }
  const columnIds = view.columns.map((column) => column.id);
  const draggedItem = dragging === undefined ? undefined : itemBySlug.get(dragging);
  // Выбранный пункт мог уехать из кадра — например, его убрали из файла
  // руками: панель тогда закрывается сама, а не показывает былое значение.
  const detailed = openItem === undefined ? undefined : itemBySlug.get(openItem);

  /** Колонка, на которую пришёлся бросок: либо сама колонка, либо карточка в ней. */
  const columnOfDrop = (id: string): ScrumColumn | undefined => {
    if (id.startsWith('column:')) return id.slice('column:'.length) as ScrumColumn;
    const over = itemBySlug.get(id);
    return over === undefined ? undefined : columnOf(over, columnIds);
  };

  const onDragEnd = (event: DragEndEvent): void => {
    setDragging(undefined);
    const over = event.over;
    if (over === null) return;

    const slug = String(event.active.id);
    const item = itemBySlug.get(slug);
    const target = columnOfDrop(String(over.id));
    if (item === undefined || target === undefined) return;

    if (target === 'in_progress') {
      // Ни строки в файл: взятие в работу — дело запуска.
      if (item.status === 'in_progress') return;
      setIntent({ item, projectKey: view.projectKey });
      return;
    }
    if (!isDroppable(target)) return;
    // Идущую работу доска не трогает: её состояние ведёт прогон, и перенос
    // карточки посреди захода разошёлся бы с тем, что пишет `backlog finish`.
    if (item.status === 'in_progress') {
      setFailure('Item is in progress: its outcome is set by the running pipeline, not by the board');
      return;
    }

    const column = view.columns.find((entry) => entry.id === target);
    const slugs = (column?.items ?? []).map((entry) => entry.slug).filter((entry) => entry !== slug);
    const overIndex = String(over.id).startsWith('column:') ? slugs.length : slugs.indexOf(String(over.id));
    const order = target === 'archive' ? view.archiveOrder : view.tasksOrder;
    const before = insertionBefore(
      order.filter((entry) => entry !== slug),
      slugs,
      overIndex < 0 ? slugs.length : overIndex,
    );

    setFailure(undefined);
    void moveBacklogItem({
      project: view.projectKey,
      slug,
      column: target,
      ...(before === undefined ? {} : { before }),
    }).catch((cause: Error) => setFailure(cause.message));
  };

  const onDragStart = (event: DragStartEvent): void => setDragging(String(event.active.id));

  return (
    <>
      {header}

      <div className="filters scrum-filters">
        <Select value={view.projectKey} onValueChange={setSelected}>
          <SelectTrigger aria-label="Project" className="scrum-project-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {view.projectOptions.map((option) => (
              <SelectItem key={option.value} value={option.value} title={option.label}>
                {projectName(option.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="mono small dim scrum-project-path">{view.projectPath}</span>
      </div>

      {view.failures.map((entry) => (
        <Alert variant="destructive" key={entry.sourceFile}>
          <AlertDescription>
            <span className="mono">{entry.sourceFile}</span>: {entry.error}
          </AlertDescription>
        </Alert>
      ))}

      {failure === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}

      {view.unplaced.map((entry) => (
        <div className="scrum-unplaced" key={entry.status}>
          <p className="small">
            Status <span className="mono">{entry.status}</span> has no column on the board:{' '}
            {entry.items.map((item, index) => (
              <span key={item.slug}>
                {index === 0 ? null : ', '}
                <Button variant="ghost" size="sm" className="mono" onClick={() => setOpenItem(item.slug)} title={item.title}>
                  {item.slug}
                </Button>
              </span>
            ))}
          </p>
          <Button variant="outline" onClick={() => setColumnIntent({ status: entry.status, projectKey: view.projectKey })}>
            Add column
          </Button>
        </div>
      ))}

      <div className="scrum-layout">
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="scrum-board">
            {view.columns.map((column) => (
              <Column
                key={column.id}
                id={column.id}
                title={column.title}
                items={column.items}
                selected={openItem}
                onSelect={setOpenItem}
                {...(column.id === 'in_progress' ? { note: 'filled by launching a pipeline' } : {})}
              />
            ))}
          </div>
          <DragOverlay>{draggedItem === undefined ? null : <Card item={draggedItem} dragging />}</DragOverlay>
        </DndContext>

        {/* Панель живёт рядом с доской, а не поверх неё: правка пункта идёт
            вместе с взглядом на колонки, и модальное окно закрывало бы ровно
            то, ради чего пункт открыли. */}
        {detailed === undefined ? null : (
          <ItemDetails
            item={detailed}
            projectKey={view.projectKey}
            statusBySlug={statusBySlug}
            onClose={() => setOpenItem(undefined)}
          />
        )}
      </div>

      <RunLaunchDialog
        open={intent !== undefined}
        {...(intent === undefined
          ? {}
          : { preselect: { projectKey: intent.projectKey, item: { slug: intent.item.slug, title: intent.item.title } } })}
        onClose={() => setIntent(undefined)}
      />
      <AddColumnDialog
        intent={columnIntent}
        columns={view.columns}
        onClose={() => setColumnIntent(undefined)}
      />
    </>
  );
}
