// agent-pipelines WU-1 task 1.7 (RED + GOLDEN) — prompt generator contract
// (AP-3, C-R4 mirror). The generator lives in shared/ so the server rows and
// the web preview render BYTE-IDENTICAL text from the same role set. Golden
// asserts: every role exact key named in the body; task map {"*":"deny"}
// FIRST then def-order role allows then helper allows (last-match-wins
// C-R1f — any reorder would silently deny the allow-list); no __replace__
// (sync never merges into user rows, C-G1); no temperature/variant anywhere
// (AP-2). Pure unit — no fs, sandbox rule N/A.
import { describe, expect, it } from 'vitest';

import {
  buildOrchestratorPermission,
  buildOrchestratorPrompt,
  buildTaskPermissionMap,
} from '../../shared/pipeline-prompt';

const input = {
  pipeline: 'mypl',
  roles: [
    {
      name: 'mypl-build',
      description: 'Build the change',
      model: 'nan/glm5.3-flash',
    },
    { name: 'mypl-review', description: 'Review the diff' },
  ],
  helpers: ['general', 'sdd-verify'],
};

describe('shared generator — permission.task (AP-3, C-R1f last-match-wins)', () => {
  it('deny-star FIRST, then roles in def order, then helpers — exact keys', () => {
    const map = buildTaskPermissionMap(
      ['mypl-build', 'mypl-review'],
      ['general', 'sdd-verify'],
    );
    expect(Object.keys(map)).toEqual([
      '*',
      'mypl-build',
      'mypl-review',
      'general',
      'sdd-verify',
    ]);
    expect(JSON.stringify(map)).toBe(
      '{"*":"deny","mypl-build":"allow","mypl-review":"allow","general":"allow","sdd-verify":"allow"}',
    );
  });

  it('no __replace__ sentinel; deduped names; no helpers is fine', () => {
    const map = buildTaskPermissionMap(['a', 'a', 'b']);
    expect('__replace__' in map).toBe(false);
    expect(Object.keys(map)).toEqual(['*', 'a', 'b']);
  });

  it('orchestrator permission = question allow + generated task map (C-R4)', () => {
    const perm = buildOrchestratorPermission(
      ['mypl-build', 'mypl-review'],
      ['general'],
    );
    expect(perm.question).toBe('allow');
    expect(Object.keys(perm.task)).toEqual([
      '*',
      'mypl-build',
      'mypl-review',
      'general',
    ]);
  });
});

describe('shared generator — orchestrator prompt goldens (AP-3, C-R4)', () => {
  const prompt = buildOrchestratorPrompt(input);

  it('names the orchestrator/pipeline and every role by its exact key', () => {
    expect(prompt).toContain('`mypl`');
    expect(prompt).toContain('`mypl-build`');
    expect(prompt).toContain('`mypl-review`');
    expect(prompt).toContain('Build the change');
    expect(prompt).toContain('Review the diff');
  });

  it('explicit model stated; absent model says invoker inheritance (C-R1e)', () => {
    expect(prompt).toContain('nan/glm5.3-flash');
    expect(prompt.toLowerCase()).toContain('invoker');
  });

  it('helpers appear as delegatable names', () => {
    expect(prompt).toContain('`general`');
    expect(prompt).toContain('`sdd-verify`');
  });

  it('never emits temperature/variant or {file:} refs (AP-2, AC-5 anchored)', () => {
    expect(prompt).not.toMatch(/temperature/i);
    expect(prompt).not.toMatch(/\bvariant\b/i);
    expect(prompt).not.toContain('{file:');
  });

  it('deterministic: same input → byte-identical output (server/web parity)', () => {
    expect(buildOrchestratorPrompt(input)).toBe(prompt);
    // Key insertion order of the input must not leak — roles order is the
    // contract, object key order of the wrapper is not.
    const same = buildOrchestratorPrompt({
      helpers: ['general', 'sdd-verify'],
      roles: input.roles,
      pipeline: 'mypl',
    } as typeof input);
    expect(same).toBe(prompt);
  });
});
