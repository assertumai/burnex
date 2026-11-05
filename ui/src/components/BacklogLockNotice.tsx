import { useEffect, useState, type JSX } from 'react';

import type { BacklogLockView } from '../api';
import { fmtTime } from '../format';
import { Alert, AlertDescription, AlertTitle } from '@burnex/ui';
import '../pages/backlog.css';

/**
 * Ниже этого возраста занятая блокировка не показывается: обычная запись держит
 * её миллисекунды, и кадр иначе «мигал» бы на каждой правке очереди
 * (design.md, Риски). Повисшая блокировка порог переходит.
 */
const SHOW_AFTER_MS = 1000;

function ageLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * Через сколько предупреждение надо перерисовать без нового кадра; `undefined` —
 * незачем. Кадр `backlog` приходит на ближайшем такте после взятия блокировки,
 * то есть почти всегда раньше порога, а пока она висит, отпечаток не меняется
 * и следующего кадра нет: без этой перерисовки повисшая блокировка так и
 * осталась бы скрытой. Показанная перерисовывается, когда сменится подпись
 * возраста.
 */
export function lockNoticeRefreshMs(lock: BacklogLockView, now: number): number | undefined {
  if (lock.state !== 'held') return undefined;
  const age = now - Date.parse(lock.acquiredAt);
  if (Number.isNaN(age)) return undefined;
  if (age < SHOW_AFTER_MS) return SHOW_AFTER_MS - age;
  return age < 60_000 ? 1000 - (age % 1000) : 60_000 - (age % 60_000);
}

/**
 * Предупреждение (не ошибка) о занятой блокировке очереди: запрос верен, просто
 * очередь сейчас пишет другой процесс. Возраст считается здесь, на момент
 * отрисовки: кадр без смены отпечатка не приходит, и возраст в кадре устарел бы.
 * Заданный `now` (тесты) замораживает часы; без него компонент ведёт их сам.
 */
export function BacklogLockNotice({
  lock,
  now: fixedNow,
}: {
  readonly lock: BacklogLockView;
  readonly now?: number;
}): JSX.Element | null {
  const [clock, setClock] = useState(() => Date.now());
  const now = fixedNow ?? clock;
  const refresh = fixedNow === undefined ? lockNoticeRefreshMs(lock, now) : undefined;

  useEffect(() => {
    if (refresh === undefined) return undefined;
    const timer = setTimeout(() => setClock(Date.now()), refresh);
    return () => clearTimeout(timer);
  }, [refresh, now]);

  if (lock.state === 'free') return null;

  if (lock.state === 'unreadable') {
    return (
      <Alert variant="warning" className="backlog-lock">
        <AlertTitle>The queue lock file is unreadable</AlertTitle>
        <AlertDescription>
          <span className="mono">{lock.path}</span> has unreadable contents; a write waits for the lock up to its
          limit before giving up.
        </AlertDescription>
      </Alert>
    );
  }

  // Момент взятия движок не проверяет (`readOwner` требует лишь строку):
  // нераспознанный показывается как есть, без возраста и без порога — судить
  // о свежести блокировки не по чему.
  const age = now - Date.parse(lock.acquiredAt);
  const dated = !Number.isNaN(age);
  if (dated && age < SHOW_AFTER_MS) return null;

  return (
    <Alert variant="warning" className="backlog-lock">
      <AlertTitle>The queue is locked by another writer</AlertTitle>
      <AlertDescription>
        <span className="mono">{lock.command}</span> · pid {lock.pid} · host {lock.host} · since{' '}
        {dated ? (
          <>
            {fmtTime(lock.acquiredAt)} ({ageLabel(age)} ago)
          </>
        ) : (
          <span className="mono">{lock.acquiredAt}</span>
        )}
        {lock.abandoned ? <p>the process is gone; the next writer will remove the lock</p> : null}
        {lock.foreignHost ? (
          <p>
            The owner runs on another machine and the daemon cannot check it. If that process is dead, delete{' '}
            <span className="mono">{lock.path}</span> by hand.
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
