import type { BackendEvent, BackendRefusal, BackendRefusalClass } from '../../pipeline/surface.js';

/**
 * Отказ турна. Сообщение CLI — строка, внутри которой JSON ответа API вида
 * `{"type":"error","status":429,"error":{"type":…,"message":…}}`; класс решает
 * код, а формулировка смотрится только когда кода нет (design.md, решение 5).
 * Код, не входящий в узнаваемые, — отказ без класса: бэкенд его назвал, и
 * угадывать поверх названного нельзя.
 */
export function codexFailure(rawMessage: unknown, prefix = ''): BackendEvent {
  const serialized = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage ?? null);
  const evidence = parseApiError(serialized);
  const text = prefix === '' ? serialized : prefix + (evidence?.text ?? serialized);
  const refusal = readRefusal(text, evidence);
  return { kind: 'result', text, failed: true, ...(refusal === undefined ? {} : { refusal }) };
}

function readRefusal(message: string, parsed: ApiError | undefined): BackendRefusal | undefined {
  const statusCode = parsed?.status;
  const refusalClass = parsed?.refusalClass ?? classifyRefusal(statusCode, parsed?.text ?? message);
  if (refusalClass === undefined) return undefined;

  const resetAt = refusalClass === 'rate_limit' ? parsed?.resetAt : undefined;
  return {
    class: refusalClass,
    message,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

interface ApiError {
  readonly status?: number;
  readonly text?: string;
  readonly resetAt?: number;
  readonly refusalClass?: BackendRefusalClass;
}

function parseApiError(message: string): ApiError | undefined {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(message) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof record !== 'object' || record === null) return undefined;

  const error = (typeof record.error === 'object' && record.error !== null ? record.error : {}) as Record<
    string,
    unknown
  >;
  const data = typeof record.data === 'object' && record.data !== null ? record.data as Record<string, unknown> : {};
  const info = record.codexErrorInfo ?? data.codexErrorInfo;
  const httpStatus = typeof info === 'object' && info !== null
    ? Object.values(info).find((value): value is { httpStatusCode: number } =>
      typeof value === 'object' && value !== null && 'httpStatusCode' in value && typeof value.httpStatusCode === 'number')
    : undefined;
  const status = [record.status, record.statusCode, data.status, data.statusCode, httpStatus?.httpStatusCode]
    .find((value): value is number => typeof value === 'number');
  const text = typeof error.message === 'string' ? error.message
    : typeof record.message === 'string' ? record.message : undefined;
  const refusalClass = info === 'usageLimitExceeded' ? 'rate_limit' : info === 'unauthorized' ? 'unauthenticated' : undefined;
  return {
    ...(status === undefined ? {} : { status }),
    ...(text === undefined ? {} : { text }),
    ...(refusalClass === undefined ? {} : { refusalClass }),
    ...(readResetAt(error) ?? readResetAt(data) ?? readResetAt(record) ?? {}),
  };
}

/**
 * Момент сброса — только из полей ответа, если они есть. Живой записи 429 у
 * ChatGPT-аккаунта нет (см. README фикстур), поэтому распознаются две
 * очевидные формы и ничего сверх: `resets_at` (секунды эпохи либо ISO 8601) и
 * `resets_in_seconds`.
 */
function readResetAt(error: Record<string, unknown>): { resetAt: number } | undefined {
  const at = error.resets_at;
  if (typeof at === 'number') return { resetAt: at < 1e12 ? at * 1000 : at };
  if (typeof at === 'string') {
    const parsed = Date.parse(at);
    if (!Number.isNaN(parsed)) return { resetAt: parsed };
  }
  const inSeconds = error.resets_in_seconds;
  if (typeof inSeconds === 'number') return { resetAt: Date.now() + inSeconds * 1000 };
  return undefined;
}

function classifyRefusal(statusCode: number | undefined, text: string): BackendRefusalClass | undefined {
  if (statusCode !== undefined) {
    if (statusCode === 429) return 'rate_limit';
    if (statusCode === 401 || statusCode === 403) return 'unauthenticated';
    return undefined;
  }
  // Закрытый перечень формулировок — расширять его по весу равно смене кодов возврата.
  if (/rate limit|usage limit|quota/i.test(text)) return 'rate_limit';
  if (/unauthorized|not logged in|authentication/i.test(text)) return 'unauthenticated';
  return undefined;
}
