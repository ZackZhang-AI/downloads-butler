export type FileCategory =
  | 'Invoices'
  | 'Screenshots'
  | 'PDFs'
  | 'Images'
  | 'Installers'
  | 'Archives'
  | 'Documents'
  | 'Unknown';

export type Confidence = 'high' | 'medium' | 'low';

export type ScannedFile = {
  id?: string;
  name: string;
  path: string;
  size: number;
  hash?: string;
  createdAt?: string;
  modifiedAt: string;
};

export type Classification = {
  category: FileCategory;
  confidence: Confidence;
  reason: string;
};

export type FileSuggestion = ScannedFile & {
  id: string;
  category: FileCategory;
  confidence: Confidence;
  reason: string;
  suggestedName: string;
  suggestedRelativePath: string;
  duplicateGroupId?: string;
  selected: boolean;
};

export type DuplicateGroup = {
  id: string;
  size: number;
  hash: string;
  files: Array<ScannedFile & { id: string }>;
};

export type ButlerReport = {
  total: number;
  highConfidence: number;
  duplicates: number;
  unknown: number;
  categoryCounts: Record<FileCategory, number>;
  message: string;
};

const invoiceKeywords = ['invoice', 'receipt', 'bill', 'order', 'payment', '发票', '收据', '账单'];
const screenshotKeywords = ['screenshot', 'screen shot', '截屏', '屏幕截图', 'wx', 'wechat image', '微信图片'];
const installerExtensions = ['.dmg', '.exe', '.pkg', '.msi', '.deb'];
const archiveExtensions = ['.zip', '.rar', '.7z', '.tar.gz'];
const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.heic'];
const documentExtensions = ['.docx', '.xlsx', '.pptx', '.txt', '.md'];

export function classifyFile(file: { name: string; [key: string]: unknown }): Classification {
  const normalizedName = file.name.toLowerCase();
  const extension = getExtension(normalizedName);

  if (invoiceKeywords.some((keyword) => normalizedName.includes(keyword))) {
    return { category: 'Invoices', confidence: 'high', reason: 'Matched invoice or billing keyword' };
  }

  if (screenshotKeywords.some((keyword) => normalizedName.includes(keyword))) {
    return { category: 'Screenshots', confidence: 'high', reason: 'Matched screenshot keyword' };
  }

  if (installerExtensions.includes(extension)) {
    return { category: 'Installers', confidence: 'high', reason: 'Matched installer extension' };
  }

  if (archiveExtensions.includes(extension)) {
    return { category: 'Archives', confidence: 'high', reason: 'Matched archive extension' };
  }

  if (extension === '.pdf') {
    return { category: 'PDFs', confidence: 'medium', reason: 'Matched PDF extension' };
  }

  if (imageExtensions.includes(extension)) {
    return { category: 'Images', confidence: 'medium', reason: 'Matched image extension' };
  }

  if (documentExtensions.includes(extension)) {
    return { category: 'Documents', confidence: 'medium', reason: 'Matched document extension' };
  }

  return { category: 'Unknown', confidence: 'low', reason: 'No rule matched' };
}

export function makeSuggestion(file: ScannedFile): FileSuggestion {
  const classification = classifyFile(file);
  const id = file.id ?? stableId(file.path || file.name);
  const suggestedName = buildSuggestedName(file, classification.category);

  return {
    ...file,
    id,
    category: classification.category,
    confidence: classification.confidence,
    reason: classification.reason,
    suggestedName,
    suggestedRelativePath: `${classification.category}/${suggestedName}`,
    selected: classification.confidence === 'high',
  };
}

export function detectDuplicateGroups(files: ScannedFile[]): DuplicateGroup[] {
  const buckets = new Map<string, Array<ScannedFile & { id: string }>>();

  for (const file of files) {
    if (!file.hash) continue;
    const id = file.id ?? stableId(file.path || file.name);
    const key = `${file.size}:${file.hash}`;
    const existing = buckets.get(key) ?? [];
    existing.push({ ...file, id });
    buckets.set(key, existing);
  }

  return [...buckets.entries()]
    .filter(([, filesInBucket]) => filesInBucket.length > 1)
    .map(([key, filesInBucket], index) => {
      const [size, hash] = key.split(':');
      return {
        id: `dup-${index + 1}`,
        size: Number(size),
        hash,
        files: filesInBucket,
      };
    });
}

export function attachDuplicateGroups(suggestions: FileSuggestion[]): FileSuggestion[] {
  const groups = detectDuplicateGroups(suggestions);
  const fileToGroup = new Map<string, string>();

  for (const group of groups) {
    for (const file of group.files) {
      fileToGroup.set(file.id, group.id);
    }
  }

  return suggestions.map((suggestion) => ({
    ...suggestion,
    duplicateGroupId: fileToGroup.get(suggestion.id),
  }));
}

export function buildButlerReport(suggestions: FileSuggestion[]): ButlerReport {
  const categoryCounts = emptyCategoryCounts();
  let highConfidence = 0;
  let duplicateFiles = 0;

  for (const suggestion of suggestions) {
    categoryCounts[suggestion.category] += 1;
    if (suggestion.confidence === 'high') highConfidence += 1;
    if (suggestion.duplicateGroupId) duplicateFiles += 1;
  }

  const unknown = categoryCounts.Unknown;
  const message =
    duplicateFiles > 0
      ? `I found ${duplicateFiles} duplicate suspects and still refuse to delete anything without your say-so.`
      : `I can tidy ${highConfidence} high-confidence files and refuse to delete anything. Caution is my best feature.`;

  return {
    total: suggestions.length,
    highConfidence,
    duplicates: duplicateFiles,
    unknown,
    categoryCounts,
    message,
  };
}

export function resolvePathConflict(relativePath: string, existingPaths: Set<string>): string {
  if (!existingPaths.has(relativePath)) return relativePath;

  const slashIndex = relativePath.lastIndexOf('/');
  const directory = slashIndex >= 0 ? relativePath.slice(0, slashIndex + 1) : '';
  const fileName = slashIndex >= 0 ? relativePath.slice(slashIndex + 1) : relativePath;
  const dotIndex = fileName.lastIndexOf('.');
  const stem = dotIndex >= 0 ? fileName.slice(0, dotIndex) : fileName;
  const extension = dotIndex >= 0 ? fileName.slice(dotIndex) : '';

  let suffix = 1;
  let candidate = `${directory}${stem}-${suffix}${extension}`;
  while (existingPaths.has(candidate)) {
    suffix += 1;
    candidate = `${directory}${stem}-${suffix}${extension}`;
  }

  return candidate;
}

function buildSuggestedName(file: ScannedFile, category: FileCategory): string {
  const extension = getExtension(file.name.toLowerCase()) || '';
  const date = extractDateParts(file.name) ?? datePartsFromIso(file.modifiedAt);

  if (category === 'Invoices') {
    return `invoice-unknown-${date.date}${extension || '.pdf'}`;
  }

  if (category === 'Screenshots') {
    if (file.name.includes('微信图片') || file.name.toLowerCase().includes('wechat')) {
      return `wechat-image-${date.date}-${date.time}${extension}`;
    }
    return `screenshot-${date.date}-${date.time}${extension}`;
  }

  const cleanedStem = sanitizeStem(removeExtension(file.name));
  return `${cleanedStem || category.toLowerCase()}-${date.date}${extension}`;
}

function extractDateParts(name: string): { date: string; time: string } | undefined {
  const compact = name.match(/(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})?/);
  if (compact) {
    return {
      date: `${compact[1]}-${compact[2]}-${compact[3]}`,
      time: `${compact[4]}${compact[5]}${compact[6] ?? '00'}`,
    };
  }

  const screenshot = name.match(/(20\d{2})-(\d{2})-(\d{2}).*?(\d{1,2})[.:](\d{2})(?:[.:](\d{2}))?/);
  if (screenshot) {
    return {
      date: `${screenshot[1]}-${screenshot[2]}-${screenshot[3]}`,
      time: `${screenshot[4].padStart(2, '0')}${screenshot[5]}${screenshot[6] ?? '00'}`,
    };
  }

  return undefined;
}

function datePartsFromIso(value: string): { date: string; time: string } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { date: 'unknown-date', time: '000000' };
  }

  return {
    date: date.toISOString().slice(0, 10),
    time: date.toISOString().slice(11, 19).replaceAll(':', ''),
  };
}

function getExtension(name: string): string {
  if (name.endsWith('.tar.gz')) return '.tar.gz';
  const dotIndex = name.lastIndexOf('.');
  return dotIndex >= 0 ? name.slice(dotIndex) : '';
}

function removeExtension(name: string): string {
  if (name.toLowerCase().endsWith('.tar.gz')) return name.slice(0, -7);
  const dotIndex = name.lastIndexOf('.');
  return dotIndex >= 0 ? name.slice(0, dotIndex) : name;
}

function sanitizeStem(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function emptyCategoryCounts(): Record<FileCategory, number> {
  return {
    Invoices: 0,
    Screenshots: 0,
    PDFs: 0,
    Images: 0,
    Installers: 0,
    Archives: 0,
    Documents: 0,
    Unknown: 0,
  };
}

function stableId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return `file-${Math.abs(hash)}`;
}
