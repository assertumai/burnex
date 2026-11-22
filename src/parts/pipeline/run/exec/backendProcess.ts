import type { BackendConnection, BackendEvent, LaunchSpec } from '../../backend/types.js';
import type { Usage } from '../journal/schema.js';
import { createAttemptCheckpoint, type ActiveAttempt, type AttemptCheckpoint } from '../journal/activeAttempt.js';
import { runProcess, type ProcessOptions, type ProcessResult } from './process.js';

type BackendProcessOptions = Omit<ProcessOptions,
  'command' | 'stdin' | 'interactive' | 'onSpawn' | 'onInterrupt' | 'onStdout' | 'onStderr'>;

export function beginBackendInvocation(options: {
  dir: string;
  attempt: number;
  backend: string;
  role: NonNullable<ActiveAttempt['role']>;
  launch: LaunchSpec;
  sessionId?: string;
  onCheckpoint?: () => void;
}): {
  checkpoint: AttemptCheckpoint;
  run(options: BackendProcessOptions, parse: (line: string) => BackendEvent, emit: (event: BackendEvent) => void): Promise<ProcessResult>;
} {
  const { dir, attempt, backend, role, launch, sessionId, onCheckpoint } = options;
  const checkpoint = createAttemptCheckpoint(dir, attempt, backend, launch.transport ?? 'exec', role);
  const notify = (patch: Partial<ActiveAttempt>, force = false): void => {
    if (checkpoint.update(patch, force)) onCheckpoint?.();
  };
  notify({ ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(launch.diagnostic === undefined ? {} : { diagnostic: launch.diagnostic }) }, true);

  return {
    checkpoint,
    async run(processOptions, parse, emit) {
      let connection: BackendConnection | undefined;
      let carry = '';
      const handleEvent = (event: BackendEvent): void => {
        const id = event.kind === 'session_started' || event.kind === 'init' ? event.sessionId : undefined;
        if (id === undefined) checkpoint.update({ last_backend_event_at: new Date().toISOString() });
        else notify({ last_backend_event_at: new Date().toISOString(), session_id: id }, true);
        emit(event);
      };
      const receive = (line: string): void => {
        if (connection === undefined) handleEvent(parse(line));
        else connection.receive(line);
      };

      notify({ spawn_pending: true }, true);
      const result = await runProcess({
        ...processOptions,
        command: launch.command,
        stdin: launch.stdin,
        interactive: launch.connect !== undefined,
        onSpawn(pid, send, close) {
          notify({ spawn_pending: false, child: { pid, started_at: new Date().toISOString() } }, true);
          connection = launch.connect?.({ send, emit: handleEvent, close });
        },
        onInterrupt() {
          if (connection === undefined) return false;
          connection.interrupt();
          return true;
        },
        onStdout(chunk) {
          notify({ last_stdout_at: new Date().toISOString() });
          const lines = (carry + chunk).split('\n');
          carry = lines.pop() ?? '';
          for (const line of lines) receive(line);
        },
        onStderr() { notify({ last_stderr_at: new Date().toISOString() }); },
      });

      if (carry.trim() !== '') receive(carry);
      connection?.onExit?.();
      return result;
    },
  };
}

export function finishBackendInvocation(
  checkpoint: AttemptCheckpoint, result: ProcessResult, usage: Usage, incomplete: boolean, failed: boolean,
): void {
  const completed = result.outcome === 'exited' && result.exitCode === 0 && !failed;
  checkpoint.update({
    state: completed ? 'completed' : 'interrupted',
    spawn_pending: false,
    usage,
    usage_state: incomplete || !completed ? 'incomplete'
      : usage.tokens_in === null && usage.tokens_out === null ? 'unavailable' : 'closed',
    exit_code: result.exitCode,
    signal: result.signal,
  }, true);
}
