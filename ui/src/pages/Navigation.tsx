import { useEffect, useMemo, useState, type ChangeEvent, type JSX, type ReactNode } from 'react';
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
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import type { RouteDefinition } from '../../../src/parts/ui/routes.ts';
import {
  UNGROUPED,
  draftFromMenu,
  isEmptyPatch,
  navPatch,
  type DraftGroup,
  type DraftItem,
  type NavDraft,
} from '../navDraft';
import { useRoutes, useScreens } from '../router';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ICON_NAMES,
  Icon,
  IconValue,
  Input,
  Label,
  PageHeader,
  TEXT_ICON_PREFIX,
  iconGlyphs,
} from '@burnex/ui';
import './navigation.css';

/**
 * Экран «Navigation»: настройка бокового меню — группы, порядок и группа
 * пунктов перетаскиванием, названия, значки, скрытие. Меню остаётся
 * содержимым `routes.yml` (docs/routes.md): экран правит черновик и по Save
 * пишет в файл выбранного слоя только разницу с действующим меню.
 */

const PAGE_TITLE = 'Navigation';
const PAGE_DESCRIPTION =
  'Arrange the side menu: drag items between groups, rename, pick icons, hide what you do not use. Hidden screens still open by address.';

type Layer = 'home' | 'project';

const LAYER_FILE: Record<Layer, string> = {
  home: '~/.burnex/routes.yml',
  project: '.burnex/routes.yml',
};

async function post(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Daemon responded ${response.status}`);
}

/** Сторона картинки-значка: вдвое больше показа в меню, чтобы не мылилась на плотном экране. */
const ICON_IMAGE_SIDE = 64;

/** Картинка пользователя → квадратный PNG `data:` небольшого размера: значок лежит строкой в `routes.yml`. */
async function imageToIcon(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = ICON_IMAGE_SIDE;
  canvas.height = ICON_IMAGE_SIDE;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('This browser cannot draw the image');
  const scale = Math.min(ICON_IMAGE_SIDE / bitmap.width, ICON_IMAGE_SIDE / bitmap.height);
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;
  context.drawImage(bitmap, (ICON_IMAGE_SIDE - width) / 2, (ICON_IMAGE_SIDE - height) / 2, width, height);
  return canvas.toDataURL('image/png');
}

function IconPicker({
  item,
  onPick,
  onClose,
}: {
  readonly item: DraftItem;
  readonly onPick: (icon: string | undefined) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState(
    item.icon?.startsWith(TEXT_ICON_PREFIX) === true ? item.icon.slice(TEXT_ICON_PREFIX.length) : '',
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const label = item.title === '' ? item.inheritedTitle : item.title;

  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    imageToIcon(file).then(onPick, (reason: Error) => setError(`The image cannot be read: ${reason.message}`));
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="nav-icon-dialog">
        <DialogHeader>
          <DialogTitle>Icon for “{label}”</DialogTitle>
          <DialogDescription>Pick one from the set, or use your own emoji, letters or image.</DialogDescription>
        </DialogHeader>
        <div className="nav-icon-grid" role="listbox" aria-label="Icon set">
          {ICON_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={item.icon === name}
              className={item.icon === name ? 'nav-icon-option selected' : 'nav-icon-option'}
              title={name}
              aria-label={name}
              onClick={() => onPick(name)}
            >
              <Icon name={name} size={18} />
            </button>
          ))}
        </div>
        <div className="nav-icon-custom">
          <div className="nav-icon-field">
            <Label htmlFor="nav-icon-text">Emoji or letters</Label>
            <div className="nav-icon-row">
              <Input
                id="nav-icon-text"
                value={text}
                placeholder="🔥"
                onChange={(event) => setText(event.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={iconGlyphs(text) === ''}
                onClick={() => onPick(`${TEXT_ICON_PREFIX}${iconGlyphs(text)}`)}
              >
                Use
              </Button>
            </div>
          </div>
          <div className="nav-icon-field">
            <Label htmlFor="nav-icon-file">Image</Label>
            <input id="nav-icon-file" type="file" accept="image/*" onChange={onFile} />
          </div>
        </div>
        {error === undefined ? null : <Alert variant="destructive">{error}</Alert>}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onPick(undefined)}>
            No icon
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ItemRowProps {
  readonly item: DraftItem;
  readonly groupKey: string;
  readonly groups: readonly DraftGroup[];
  readonly onChange: (item: DraftItem) => void;
  readonly onMove: (groupKey: string) => void;
  readonly onPickIcon: () => void;
}

function ItemRowBody({
  item,
  groupKey,
  groups,
  onChange,
  onMove,
  onPickIcon,
  handle,
}: ItemRowProps & { readonly handle: JSX.Element }): JSX.Element {
  const label = item.title === '' ? item.inheritedTitle : item.title;
  return (
    <>
      {handle}
      <button type="button" className="nav-edit-icon" aria-label={`Icon of ${label}`} title="Change icon" onClick={onPickIcon}>
        <IconValue value={item.icon} label={label} />
      </button>
      <Input
        className="nav-edit-title"
        aria-label={`Menu title of ${item.inheritedTitle}`}
        value={item.title}
        placeholder={item.inheritedTitle}
        onChange={(event) => onChange({ ...item, title: event.target.value })}
      />
      <span className="nav-edit-path mono small dim">{item.path}</span>
      {item.hidden ? <Badge variant="secondary">hidden</Badge> : null}
      {/* Выбор группы — путь без перетаскивания: с клавиатуры и на сенсорном экране. */}
      <select
        className="nav-edit-group"
        aria-label={`Group of ${label}`}
        value={groupKey}
        onChange={(event) => onMove(event.target.value)}
      >
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            {group.title}
          </option>
        ))}
        <option value={UNGROUPED}>No group</option>
      </select>
      <button
        type="button"
        className="nav-edit-action"
        aria-label={item.hidden ? `Show ${label} in the menu` : `Hide ${label} from the menu`}
        aria-pressed={item.hidden}
        title={item.hidden ? 'Show in the menu' : 'Hide from the menu'}
        onClick={() => onChange({ ...item, hidden: !item.hidden })}
      >
        <Icon name={item.hidden ? 'eye-off' : 'eye'} size={16} />
      </button>
    </>
  );
}

function SortableItemRow(props: ItemRowProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.item.id });
  return (
    <li
      ref={setNodeRef}
      className={props.item.hidden ? 'nav-edit-item is-hidden' : 'nav-edit-item'}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
    >
      <ItemRowBody
        {...props}
        handle={
          <button type="button" className="nav-edit-handle" aria-label="Drag to reorder" {...attributes} {...listeners}>
            <Icon name="grip-vertical" size={16} />
          </button>
        }
      />
    </li>
  );
}

function GroupItems({
  groupKey,
  ids,
  children,
}: {
  readonly groupKey: string;
  readonly ids: readonly string[];
  readonly children: ReactNode;
}): JSX.Element {
  // Группа — сама цель сброса: в пустую группу иначе нечем было бы попасть.
  const { setNodeRef, isOver } = useDroppable({ id: `group:${groupKey}` });
  return (
    <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
      <ul ref={setNodeRef} className={isOver ? 'nav-edit-items is-over' : 'nav-edit-items'}>
        {ids.length === 0 ? <li className="nav-edit-empty small dim">Drop an item here</li> : children}
      </ul>
    </SortableContext>
  );
}

function containerOf(draft: NavDraft, id: string): string | undefined {
  if (id.startsWith('group:')) return id.slice('group:'.length);
  return Object.keys(draft.layout).find((key) => draft.layout[key]?.includes(id));
}

function moveItem(draft: NavDraft, id: string, to: string, index?: number): NavDraft {
  const from = containerOf(draft, id);
  if (from === undefined) return draft;
  const source = (draft.layout[from] ?? []).filter((candidate) => candidate !== id);
  const target = from === to ? source : [...(draft.layout[to] ?? [])];
  target.splice(index ?? target.length, 0, id);
  return { ...draft, layout: { ...draft.layout, [from]: source, [to]: target } };
}

export function Navigation(): JSX.Element {
  const { table, navGroups } = useRoutes();
  const { table: screens } = useScreens();

  const base = useMemo(
    () =>
      draftFromMenu(table, navGroups, (route: RouteDefinition) =>
        route.target.kind === 'screen' ? (screens.get(route.target.id)?.title ?? route.target.id) : route.target.id,
      ),
    [table, navGroups, screens],
  );

  // Черновик заведён только после первой правки: до неё экран показывает
  // действующее меню и следует за ним вживую.
  const [edited, setEdited] = useState<NavDraft | undefined>(undefined);
  const [layer, setLayer] = useState<Layer>('home');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [confirmReset, setConfirmReset] = useState(false);
  const [dragging, setDragging] = useState<string | undefined>(undefined);
  const [iconFor, setIconFor] = useState<string | undefined>(undefined);
  /** Таблица, с которой ушло сохранение: черновик снимается, когда придёт следующая. */
  const [savedFrom, setSavedFrom] = useState<unknown>(undefined);

  useEffect(() => {
    if (savedFrom !== undefined && savedFrom !== table) {
      setEdited(undefined);
      setSavedFrom(undefined);
    }
  }, [savedFrom, table]);

  const draft = edited ?? base;
  const patch = useMemo(() => navPatch(table, navGroups, draft), [table, navGroups, draft]);
  const dirty = edited !== undefined && !isEmptyPatch(patch);
  const update = (change: (current: NavDraft) => NavDraft): void => setEdited((current) => change(current ?? base));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (event: DragStartEvent): void => setDragging(String(event.active.id));

  // Пункт переезжает в чужую группу, едва оказавшись над ней, — так
  // сортировка группы-цели сразу раздвигает строки под него.
  const onDragOver = (event: DragOverEvent): void => {
    if (event.over === null) return;
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    update((current) => {
      const from = containerOf(current, activeId);
      const to = containerOf(current, overId);
      if (from === undefined || to === undefined || from === to) return current;
      const index = overId.startsWith('group:') ? undefined : current.layout[to]?.indexOf(overId);
      return moveItem(current, activeId, to, index === -1 ? undefined : index);
    });
  };

  const onDragEnd = (event: DragEndEvent): void => {
    setDragging(undefined);
    if (event.over === null) return;
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    update((current) => {
      const key = containerOf(current, activeId);
      if (key === undefined || key !== containerOf(current, overId) || overId.startsWith('group:')) return current;
      const ids = current.layout[key] ?? [];
      const from = ids.indexOf(activeId);
      const to = ids.indexOf(overId);
      if (from === to) return current;
      return { ...current, layout: { ...current.layout, [key]: arrayMove([...ids], from, to) } };
    });
  };

  const changeItem = (item: DraftItem): void =>
    update((current) => ({ ...current, items: { ...current.items, [item.id]: item } }));

  const addGroup = (): void =>
    update((current) => {
      let n = 1;
      while (current.layout[`new-group-${n}`] !== undefined) n += 1;
      const id = `new-group-${n}`;
      return {
        ...current,
        groups: [...current.groups, { id, title: 'New group', builtin: false, isNew: true }],
        layout: { ...current.layout, [id]: [] },
      };
    });

  const changeGroup = (id: string, title: string): void =>
    update((current) => ({
      ...current,
      groups: current.groups.map((group) => (group.id === id ? { ...group, title } : group)),
    }));

  const shiftGroup = (id: string, by: -1 | 1): void =>
    update((current) => {
      const from = current.groups.findIndex((group) => group.id === id);
      const to = from + by;
      if (from === -1 || to < 0 || to >= current.groups.length) return current;
      return { ...current, groups: arrayMove([...current.groups], from, to) };
    });

  // Удаление группы не удаляет её пункты: они уходят в «без группы».
  const removeGroup = (id: string): void =>
    update((current) => {
      const { [id]: orphans = [], ...layout } = current.layout;
      return {
        ...current,
        groups: current.groups.filter((group) => group.id !== id),
        layout: { ...layout, [UNGROUPED]: [...(layout[UNGROUPED] ?? []), ...orphans] },
      };
    });

  const run = (action: () => Promise<void>): void => {
    setBusy(true);
    setError(undefined);
    action()
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setBusy(false));
  };

  const save = (): void =>
    run(async () => {
      await post('/api/nav', { layer, patch });
      setSavedFrom(table);
    });

  const reset = (): void =>
    run(async () => {
      await post('/api/nav/reset', { layer });
      setConfirmReset(false);
      setEdited(undefined);
    });

  const renderItems = (key: string): JSX.Element => {
    const ids = draft.layout[key] ?? [];
    return (
      <GroupItems groupKey={key} ids={ids}>
        {ids.map((id) => {
          const item = draft.items[id];
          if (item === undefined) return null;
          return (
            <SortableItemRow
              key={id}
              item={item}
              groupKey={key}
              groups={draft.groups}
              onChange={changeItem}
              onMove={(to) => update((current) => moveItem(current, id, to))}
              onPickIcon={() => setIconFor(id)}
            />
          );
        })}
      </GroupItems>
    );
  };

  const draggedItem = dragging === undefined ? undefined : draft.items[dragging];
  const iconItem = iconFor === undefined ? undefined : draft.items[iconFor];

  return (
    <div className="nav-edit">
      <PageHeader
        title={PAGE_TITLE}
        description={PAGE_DESCRIPTION}
        actions={
          <>
            {dirty ? <Badge variant="running">unsaved changes</Badge> : null}
            <select
              className="nav-edit-layer"
              aria-label="Layer file to write"
              value={layer}
              onChange={(event) => setLayer(event.target.value as Layer)}
            >
              <option value="home">Home — {LAYER_FILE.home}</option>
              <option value="project">Project — {LAYER_FILE.project}</option>
            </select>
            <Button variant="outline" size="sm" disabled={busy || edited === undefined} onClick={() => setEdited(undefined)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || !dirty} onClick={save}>
              Save
            </Button>
          </>
        }
      />

      {error === undefined ? null : <Alert variant="destructive">{error}</Alert>}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(undefined)}
      >
        <div className="nav-edit-groups">
          {draft.groups.map((group, index) => (
            <section className="nav-edit-group-card" key={group.id} aria-label={`Group ${group.title}`}>
              <header className="nav-edit-group-head">
                <Input
                  className="nav-edit-group-title"
                  aria-label="Group name"
                  value={group.title}
                  onChange={(event) => changeGroup(group.id, event.target.value)}
                />
                {group.builtin ? <Badge variant="outline">bundled</Badge> : null}
                {group.isNew ? <Badge variant="secondary">new</Badge> : null}
                <span className="nav-edit-group-actions">
                  <button
                    type="button"
                    className="nav-edit-action"
                    aria-label={`Move group ${group.title} up`}
                    title="Move up"
                    disabled={index === 0}
                    onClick={() => shiftGroup(group.id, -1)}
                  >
                    <Icon name="chevron-down" size={16} className="nav-edit-up" />
                  </button>
                  <button
                    type="button"
                    className="nav-edit-action"
                    aria-label={`Move group ${group.title} down`}
                    title="Move down"
                    disabled={index === draft.groups.length - 1}
                    onClick={() => shiftGroup(group.id, 1)}
                  >
                    <Icon name="chevron-down" size={16} />
                  </button>
                  {group.builtin ? null : (
                    <button
                      type="button"
                      className="nav-edit-action"
                      aria-label={`Delete group ${group.title}`}
                      title="Delete group; its items move to “No group”"
                      onClick={() => removeGroup(group.id)}
                    >
                      <Icon name="trash-2" size={16} />
                    </button>
                  )}
                </span>
              </header>
              {renderItems(group.id)}
            </section>
          ))}

          <section className="nav-edit-group-card" aria-label="Items without a group">
            <header className="nav-edit-group-head">
              <span className="nav-edit-group-static">No group</span>
              <span className="small dim">shown after the groups, without a heading</span>
            </header>
            {renderItems(UNGROUPED)}
          </section>
        </div>
        <DragOverlay>
          {draggedItem === undefined ? null : (
            <div className="nav-edit-item nav-edit-overlay">
              <Icon name="grip-vertical" size={16} />
              <IconValue value={draggedItem.icon} label={draggedItem.inheritedTitle} />
              <span>{draggedItem.title === '' ? draggedItem.inheritedTitle : draggedItem.title}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <div className="nav-edit-footer">
        <Button variant="outline" size="sm" onClick={addGroup}>
          <Icon name="plus" size={14} /> New group
        </Button>
        <span className="nav-edit-reset">
          {confirmReset ? (
            <>
              <span className="small dim">Remove all menu settings from {LAYER_FILE[layer]}?</span>
              <Button variant="destructive" size="sm" disabled={busy} onClick={reset}>
                Reset
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmReset(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirmReset(true)}>
              <Icon name="rotate-ccw" size={14} /> Reset layer
            </Button>
          )}
        </span>
      </div>

      {iconItem === undefined ? null : (
        <IconPicker
          item={iconItem}
          onClose={() => setIconFor(undefined)}
          onPick={(icon) => {
            changeItem({ ...iconItem, icon });
            setIconFor(undefined);
          }}
        />
      )}
    </div>
  );
}
