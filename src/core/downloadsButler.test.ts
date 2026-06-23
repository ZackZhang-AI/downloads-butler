import { describe, expect, it } from 'vitest';
import {
  buildButlerReport,
  classifyFile,
  detectDuplicateGroups,
  makeSuggestion,
} from './downloadsButler';

describe('Downloads Butler rules', () => {
  it('classifies invoice keywords before generic PDFs', () => {
    expect(classifyFile({ name: 'invoice-final-final.pdf', size: 120, modifiedAt: '2026-06-23T10:20:00.000Z' })).toMatchObject({
      category: 'Invoices',
      confidence: 'high',
    });
  });

  it('classifies screenshot keywords before generic images', () => {
    expect(classifyFile({ name: '微信图片_20260623102039.jpg', size: 120, modifiedAt: '2026-06-23T10:20:00.000Z' })).toMatchObject({
      category: 'Screenshots',
      confidence: 'high',
    });
  });

  it('generates deterministic suggested paths', () => {
    const suggestion = makeSuggestion({
      name: 'Screenshot 2026-06-23 at 10.41.22.png',
      path: 'C:/Users/me/Downloads/Screenshot 2026-06-23 at 10.41.22.png',
      size: 100,
      modifiedAt: '2026-06-23T10:41:22.000Z',
    });

    expect(suggestion.suggestedRelativePath).toBe('Screenshots/screenshot-2026-06-23-104122.png');
  });

  it('groups duplicates only when both size and hash match', () => {
    const groups = detectDuplicateGroups([
      { id: '1', name: 'a.pdf', path: '/a.pdf', size: 10, hash: 'same', modifiedAt: '2026-06-23T00:00:00.000Z' },
      { id: '2', name: 'b.pdf', path: '/b.pdf', size: 10, hash: 'same', modifiedAt: '2026-06-23T00:00:00.000Z' },
      { id: '3', name: 'c.pdf', path: '/c.pdf', size: 20, hash: 'same', modifiedAt: '2026-06-23T00:00:00.000Z' },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].files.map((file) => file.id)).toEqual(['1', '2']);
  });

  it('builds a cautious butler report', () => {
    const report = buildButlerReport([
      makeSuggestion({ name: 'invoice.pdf', path: '/invoice.pdf', size: 1, modifiedAt: '2026-06-23T00:00:00.000Z' }),
      makeSuggestion({ name: 'mystery.bin', path: '/mystery.bin', size: 1, modifiedAt: '2026-06-23T00:00:00.000Z' }),
    ]);

    expect(report.total).toBe(2);
    expect(report.unknown).toBe(1);
    expect(report.message).toContain('refuse to delete');
  });
});
