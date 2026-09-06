// WU-2 (RED) — the assignment arg composer (design #549 §Interfaces,
// spec S5/S6/S8/S9). The composer is a PURE function: it turns changed
// {key → "provider/model"} pairs into the EXACT argv for ONE runSync —
// repeated `--profile-phase` flags (D5 probe verdict batch_supported=YES:
// one invocation, sequential queue DROPPED) plus `--profile` flags for the
// sdd-orchestrator rows. It mirrors the server SYNC_ARG_ALLOWLIST regexes
// client-side (server/src/sync.ts stays authoritative — the server 400s
// anything else pre-spawn): tokens the mirror rejects are DROPPED AND
// FLAGGED, never emitted. Output carries only key/value-derived tokens —
// no hashes, no secret-bearing material can enter the args.
import { describe, expect, it } from 'vitest';

import {
  composeAssignmentArgs,
  composeAssignmentArgsDetailed,
} from './composeArgs';

describe('composeAssignmentArgs — D5 batch shape (S8)', () => {
  it('three changed pairs compose EXACTLY the repeated --profile-phase argv', () => {
    expect(
      composeAssignmentArgs({
        'deep:sdd-spec': 'nan/deepseek-v4-flash',
        'deep:sdd-tasks': 'nan/deepseek-v4-flash',
        'cheap:jd-judge-a': 'nan/qwen3.6',
      }),
    ).toEqual([
      '--profile-phase',
      'deep:sdd-spec:nan/deepseek-v4-flash',
      '--profile-phase',
      'deep:sdd-tasks:nan/deepseek-v4-flash',
      '--profile-phase',
      'cheap:jd-judge-a:nan/qwen3.6',
    ]);
  });

  it('the orchestrator key composes --profile <profile>:<provider/model> (S5)', () => {
    expect(
      composeAssignmentArgs({ 'deep:orchestrator': 'nanSendvalu/glm5.3' }),
    ).toEqual(['--profile', 'deep:nanSendvalu/glm5.3']);
    expect(
      composeAssignmentArgs({ 'cheap:orchestrator': 'nan/qwen3.8-flash' }),
    ).toEqual(['--profile', 'cheap:nan/qwen3.8-flash']);
  });

  it('jd-* phases compose --profile-phase like any catalog phase (S6)', () => {
    expect(
      composeAssignmentArgs({ 'deep:jd-fix-agent': 'nan/glm5.3' }),
    ).toEqual(['--profile-phase', 'deep:jd-fix-agent:nan/glm5.3']);
  });

  it('phase flags precede profile flags; insertion order kept within each group', () => {
    expect(
      composeAssignmentArgs({
        'deep:orchestrator': 'nanSendvalu/glm5.3',
        'deep:sdd-spec': 'nan/deepseek-v4-flash',
        'cheap:sdd-apply': 'nan/mimo-v2.5',
      }),
    ).toEqual([
      '--profile-phase',
      'deep:sdd-spec:nan/deepseek-v4-flash',
      '--profile-phase',
      'cheap:sdd-apply:nan/mimo-v2.5',
      '--profile',
      'deep:nanSendvalu/glm5.3',
    ]);
  });

  it('no changes compose no argv', () => {
    expect(composeAssignmentArgs({})).toEqual([]);
  });
});

describe('composeAssignmentArgs — allowlist mirror drops-and-flags (server stays authoritative)', () => {
  it('drops a value with shell-shaped characters and flags it, emitting nothing', () => {
    const result = composeAssignmentArgsDetailed({
      'deep:sdd-spec': 'nan/evil; rm -rf ~',
    });
    expect(result.args).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].key).toBe('deep:sdd-spec');
    expect(result.dropped[0].value).toBe('nan/evil; rm -rf ~');
    expect(result.dropped[0].reason).toMatch(/allowlist/i);
  });

  it('drops an unknown phase key (the CLI is the phase authority — probe C)', () => {
    const result = composeAssignmentArgsDetailed({
      'deep:not-a-phase': 'nan/qwen3.8-flash',
    });
    expect(result.args).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toMatch(/phase/i);
  });

  it('drops an unknown profile key', () => {
    const result = composeAssignmentArgsDetailed({
      'turbo:sdd-spec': 'nan/qwen3.8-flash',
    });
    expect(result.args).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toMatch(/profile/i);
  });

  it('drops a value without the provider/model shape', () => {
    const result = composeAssignmentArgsDetailed({
      'deep:sdd-spec': 'just-a-model-id',
    });
    expect(result.args).toEqual([]);
    expect(result.dropped).toHaveLength(1);
  });

  it('composes the valid changes and drops only the invalid ones', () => {
    const result = composeAssignmentArgsDetailed({
      'deep:sdd-spec': 'nan/deepseek-v4-flash',
      'cheap:not-a-phase': 'nan/qwen3.8-flash',
    });
    expect(result.args).toEqual([
      '--profile-phase',
      'deep:sdd-spec:nan/deepseek-v4-flash',
    ]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].key).toBe('cheap:not-a-phase');
  });

  it('the plain composer never emits secret-bearing or non-allowlist material', () => {
    const args = composeAssignmentArgs({
      'deep:sdd-spec': 'nan/deepseek-v4-flash',
      'deep:orchestrator': 'nanSendvalu/glm5.3',
    });
    for (const token of args) {
      expect(token).toMatch(/^[\w.:/-]+$/); // the sync charset door
      expect(token).not.toMatch(/key|secret|token|hash/i);
    }
  });
});
