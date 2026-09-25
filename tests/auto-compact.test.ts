import { describe, expect, it } from 'vitest';
import { register } from '../hooks/fast-jev.ts';

type Hook = ($: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;

const HEADLESS =
  '$.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on';

function engine(opts: { percent?: number; directRefused?: boolean }) {
  const calls: string[] = [];
  const files: Record<string, string> = {};
  const $ = {
    session: {
      usage: async () => ({ context: { window: 1_000_000, percent: opts.percent } }),
      compact: async () => {
        calls.push('session.compact');
        if (opts.directRefused) throw new Error(HEADLESS);
        return { messages: [] };
      },
    },
    command: {
      run: async (input: { command: string }) => {
        calls.push(`command.run:${input.command}`);
        return { text: 'queued' };
      },
    },
    fs: {
      read: async (path: string) => {
        if (!(path in files)) throw new Error('missing');
        return files[path];
      },
      write: async (path: string, text: string) => {
        files[path] = text;
      },
    },
    env: { get: async (name: string) => (name === 'HOME' ? '/home/test' : undefined) },
    clock: { now: async () => Date.UTC(2026, 8, 25) },
    ui: { log: () => {}, toast: () => {} },
  };
  return { $, calls, files };
}

function turnCompleteHook(): Hook {
  const hooks: Record<string, Hook> = {};
  const on = (event: string, hook: Hook) => {
    hooks[event] = hook;
  };
  register(on as never, {} as never);
  return hooks['turn.complete']!;
}

async function runTurn(
  hook: Hook,
  $: unknown,
  event: Record<string, unknown> = {},
): Promise<{ order: string[]; result: unknown }> {
  const order: string[] = [];
  const e = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...event };
  const result = await hook($, e, async () => {
    order.push('next');
    return { text: 'ok' };
  });
  return { order, result };
}

describe('turn.complete automatic compaction', () => {
  it('does nothing below the threshold, and calls next exactly once', async () => {
    const { $, calls } = engine({ percent: 40 });
    const { order, result } = await runTurn(turnCompleteHook(), $);
    expect(calls).toEqual([]);
    expect(order).toEqual(['next']);
    expect(result).toEqual({ text: 'ok' });
  });

  it('treats an absent percent as not yet, not as zero-and-compact or a crash', async () => {
    const { $, calls } = engine({ percent: undefined });
    await runTurn(turnCompleteHook(), $);
    expect(calls).toEqual([]);
  });

  it('uses the direct call where the engine allows it (interactive terminal)', async () => {
    const { $, calls } = engine({ percent: 75 });
    await runTurn(turnCompleteHook(), $);
    expect(calls).toEqual(['session.compact']);
  });

  it('falls back to a queued /compact when the engine refuses the direct call (cloud / SDK)', async () => {
    const { $, calls, files } = engine({ percent: 75, directRefused: true });
    const { order } = await runTurn(turnCompleteHook(), $);
    expect(calls).toEqual(['session.compact', 'command.run:compact']);
    expect(order).toEqual(['next']);
    const log = files['/home/test/.claude/fast-jev-compaction.log'] ?? '';
    expect(log).toContain('requesting compaction');
    expect(log).toContain('queuing /compact');
  });

  it('asks only after the turn has completed', async () => {
    const { $ } = engine({ percent: 75, directRefused: true });
    const seen: string[] = [];
    const hook = turnCompleteHook();
    const wrapped = {
      ...$,
      session: { ...$.session, compact: async () => (seen.push('compact'), $.session.compact()) },
    };
    await hook(wrapped, { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }, async () => {
      seen.push('next');
      return { text: '' };
    });
    expect(seen).toEqual(['next', 'compact']);
  });

  it("skips a subagent's turn and an interrupted turn", async () => {
    const hook = turnCompleteHook();
    const a = engine({ percent: 90 });
    await runTurn(hook, a.$, { agentId: 'sub-1' });
    const b = engine({ percent: 90 });
    await runTurn(hook, b.$, { isAborted: true, reason: 'aborted' });
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
  });
});
