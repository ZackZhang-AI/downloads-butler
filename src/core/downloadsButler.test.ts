import { describe, expect, it } from 'vitest';
import {
  buildButlerReport,
  buildScanResult,
  classifyFile,
  detectDuplicateGroups,
  makeSuggestion,
  resolvePathConflict,
} from './downloadsButler';

describe('Downloads Butler rules', () => {
  it('classifies invoice keywords before generic PDFs', () => {
    expect(
      classifyFile({ name: 'invoice-final-final.pdf', size: 120, modifiedAt: '2026-06-23T10:20:00.000Z' }),
    ).toMatchObject({
      category: 'Invoices',
      confidence: 'high',
    });
  });

  it('classifies Chinese invoice keywords before generic PDFs', () => {
    expect(classifyFile({ name: '发票_20260623.pdf', size: 120, modifiedAt: '2026-06-23T10:20:00.000Z' })).toMatchObject({
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

  it('classifies the MVP extension set', () => {
    expect(classifyFile({ name: 'bundle.tar.gz' })).toMatchObject({ category: 'Archives', confidence: 'high' });
    expect(classifyFile({ name: 'setup.msi' })).toMatchObject({ category: 'Installers', confidence: 'high' });
    expect(classifyFile({ name: 'notes.md' })).toMatchObject({ category: 'Documents', confidence: 'medium' });
    expect(classifyFile({ name: 'photo.heic' })).toMatchObject({ category: 'Images', confidence: 'medium' });
    expect(classifyFile({ name: 'plain.pdf' })).toMatchObject({ category: 'PDFs', confidence: 'medium' });
    expect(classifyFile({ name: 'mystery.bin' })).toMatchObject({ category: 'Unknown', confidence: 'low' });
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

  it('normalizes WeChat image names with parsed timestamps', () => {
    const suggestion = makeSuggestion({
      name: '微信图片_20260623102039.jpg',
      path: 'C:/Users/me/Downloads/微信图片_20260623102039.jpg',
      size: 100,
      modifiedAt: '2026-06-23T10:20:00.000Z',
    });

    expect(suggestion.suggestedRelativePath).toBe('Screenshots/wechat-image-2026-06-23-102039.jpg');
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

  it('builds a scan result with suggestions, duplicate groups, report, and warnings', () => {
    const result = buildScanResult(
      [
        {
          id: '1',
          name: 'invoice.pdf',
          path: 'C:/Users/me/Downloads/invoice.pdf',
          size: 10,
          hash: 'same',
          modifiedAt: '2026-06-23T00:00:00.000Z',
        },
        {
          id: '2',
          name: 'invoice copy.pdf',
          path: 'C:/Users/me/Downloads/invoice copy.pdf',
          size: 10,
          hash: 'same',
          modifiedAt: '2026-06-23T00:00:00.000Z',
        },
      ],
      ['Skipped subfolders.'],
    );

    expect(result.suggestions).toHaveLength(2);
    expect(result.duplicateGroups).toHaveLength(1);
    expect(result.report.duplicates).toBe(2);
    expect(result.warnings).toEqual(['Skipped subfolders.']);
  });

  it('resolves target path conflicts with numeric suffixes', () => {
    const existingPaths = new Set(['Invoices/invoice-unknown-2026-06-23.pdf', 'Invoices/invoice-unknown-2026-06-23-1.pdf']);

    expect(resolvePathConflict('Invoices/invoice-unknown-2026-06-23.pdf', existingPaths)).toBe(
      'Invoices/invoice-unknown-2026-06-23-2.pdf',
    );
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
