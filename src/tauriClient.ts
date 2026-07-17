import {
  buildScanResult,
  type ApplyItem,
  type FileSuggestion,
  type OperationBatch,
  type ScanResult,
  type ScannedFile,
  type UndoResult,
} from './core/downloadsButler';

export type { ApplyItem, OperationBatch, UndoResult };

export async function getDefaultDownloadsFolder(): Promise<string> {
  if (!isTauriRuntime()) return 'C:/Users/you/Downloads';

  try {
    const { downloadDir } = await import('@tauri-apps/api/path');
    return await downloadDir();
  } catch {
    return 'Choose a Downloads folder';
  }
}

export async function chooseFolder(): Promise<string | null> {
  if (!isTauriRuntime()) return 'C:/Users/you/Downloads';
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === 'string' ? selected : null;
}

export async function scanFolder(folderPath: string): Promise<ScanResult> {
  if (!isTauriRuntime()) {
    return buildScanResult(sampleFiles(folderPath), ['Subfolders are skipped in browser preview.']);
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<ScanResult>('scan_folder', { folderPath });
}

export async function applySuggestions(items: ApplyItem[]): Promise<OperationBatch> {
  if (!isTauriRuntime()) {
    return {
      id: `batch-${Date.now()}`,
      timestamp: new Date().toISOString(),
      status: 'applied',
      succeeded: items.length,
      failed: 0,
      operations: items.map((item) => ({
        id: `op-${item.id}`,
        beforePath: item.path,
        afterPath: `${dirname(item.path)}/${item.suggestedRelativePath}`,
        fileName: basename(item.path),
        status: 'applied',
      })),
    };
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<OperationBatch>('apply_operations', { items });
}

export async function getOperationHistory(): Promise<OperationBatch[]> {
  if (!isTauriRuntime()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<OperationBatch[]>('get_operation_history');
}

export async function undoLastOperation(): Promise<UndoResult> {
  if (!isTauriRuntime()) return { restored: 0, failed: [] };
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<UndoResult>('undo_last_operation');
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

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}
