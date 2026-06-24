import {
  attachDuplicateGroups,
  makeSuggestion,
  type FileSuggestion,
  type ScannedFile,
} from './core/downloadsButler';

export type AppliedOperation = {
  id: string;
  beforePath: string;
  afterPath: string;
  fileName: string;
};

export type OperationBatch = {
  id: string;
  timestamp: string;
  operations: AppliedOperation[];
};

export async function chooseFolder(): Promise<string | null> {
  if (!isTauriRuntime()) return 'C:/Users/you/Downloads';
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === 'string' ? selected : null;
}

export async function scanFolder(folderPath: string): Promise<FileSuggestion[]> {
  if (!isTauriRuntime()) {
    return attachDuplicateGroups(sampleFiles(folderPath).map(makeSuggestion));
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<FileSuggestion[]>('scan_folder', { folderPath });
}

export async function applySuggestions(suggestions: FileSuggestion[]): Promise<OperationBatch> {
  if (!isTauriRuntime()) {
    return {
      id: `batch-${Date.now()}`,
      timestamp: new Date().toISOString(),
      operations: suggestions.map((suggestion) => ({
        id: `op-${suggestion.id}`,
        beforePath: suggestion.path,
        afterPath: `${dirname(suggestion.path)}/${suggestion.suggestedRelativePath}`,
        fileName: suggestion.name,
      })),
    };
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<OperationBatch>('apply_operations', { items: suggestions });
}

export async function undoLastOperation(): Promise<{ restored: number }> {
  if (!isTauriRuntime()) return { restored: 0 };
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<{ restored: number }>('undo_last_operation');
}

export function getRuntimeMode(): 'tauri' | 'browser' {
  return isTauriRuntime() ? 'tauri' : 'browser';
}

export function sampleFiles(folderPath = 'C:/Users/you/Downloads'): ScannedFile[] {
  return [
    {
      id: 'sample-invoice',
      name: 'invoice-final-final.pdf',
      path: `${folderPath}/invoice-final-final.pdf`,
      size: 421_000,
      hash: 'hash-invoice',
      modifiedAt: '2026-06-23T10:20:00.000Z',
    },
    {
      id: 'sample-screenshot',
      name: 'Screenshot 2026-06-23 at 10.41.22.png',
      path: `${folderPath}/Screenshot 2026-06-23 at 10.41.22.png`,
      size: 842_000,
      hash: 'hash-screen',
      modifiedAt: '2026-06-23T10:41:22.000Z',
    },
    {
      id: 'sample-installer',
      name: 'setup.exe',
      path: `${folderPath}/setup.exe`,
      size: 8_192_000,
      hash: 'hash-installer',
      modifiedAt: '2026-06-22T09:00:00.000Z',
    },
    {
      id: 'sample-unknown',
      name: 'mystery-download.bin',
      path: `${folderPath}/mystery-download.bin`,
      size: 512,
      hash: 'hash-mystery',
      modifiedAt: '2026-06-21T09:00:00.000Z',
    },
  ];
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function dirname(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : normalized;
}
