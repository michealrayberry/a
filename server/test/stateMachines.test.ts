import { describe, it, expect } from 'vitest';
import { transition, canTransition, IllegalTransition, terminalStates } from '../src/stateMachines.js';

describe('evidence state machine (blueprint §24)', () => {
  it('allows the happy path', () => {
    expect(canTransition('evidence', 'READY_FOR_REVIEW', 'VERIFIED')).toBe(true);
    expect(canTransition('evidence', 'DEFICIENT', 'REPLACEMENT_SUBMITTED')).toBe(true);
  });
  it('rejects skipping straight to VERIFIED (evidence-before-status)', () => {
    expect(canTransition('evidence', 'DRAFT', 'VERIFIED')).toBe(false);
    expect(() => transition('evidence', 'DRAFT', 'VERIFIED')).toThrow(IllegalTransition);
  });
  it('VERIFIED is terminal', () => {
    expect(terminalStates('evidence')).toContain('VERIFIED');
  });
});

describe('requirement state machine', () => {
  it('cannot verify without review', () => {
    expect(canTransition('requirement', 'NOT_STARTED', 'VERIFIED')).toBe(false);
  });
  it('supports the deficiency correction loop', () => {
    expect(canTransition('requirement', 'DEFICIENT', 'CORRECTION_SUBMITTED')).toBe(true);
    expect(canTransition('requirement', 'CORRECTION_SUBMITTED', 'VERIFIED')).toBe(true);
  });
  it('missed requirements route to violation review', () => {
    expect(canTransition('requirement', 'MISSED', 'VIOLATION_PENDING')).toBe(true);
    expect(canTransition('requirement', 'VIOLATION_PENDING', 'VIOLATION_ASSESSED')).toBe(true);
  });
});

describe('violation state machine', () => {
  it('assessed can be acknowledged or go to factual review', () => {
    expect(canTransition('violation', 'ASSESSED', 'ACKNOWLEDGED')).toBe(true);
    expect(canTransition('violation', 'ASSESSED', 'FACTUAL_REVIEW')).toBe(true);
  });
  it('factual review can reverse', () => {
    expect(canTransition('violation', 'FACTUAL_REVIEW', 'REVERSED')).toBe(true);
  });
  it('cannot archive straight from proposed', () => {
    expect(() => transition('violation', 'PROPOSED', 'ARCHIVED')).toThrow(IllegalTransition);
  });
});
