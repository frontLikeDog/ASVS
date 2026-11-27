import path from 'node:path';
import type {
  KnowledgeEntrypoint,
  KnowledgeFile,
  KnowledgeHeading,
  KnowledgeLanguage,
  KnowledgeSymbol,
  KnowledgeSymbolKind,
} from '@asvs/domain';

/**
 * Deterministic, text-only extraction. Nothing here executes repository code,
 * resolves imports or runs a parser; a file that happens to contain a `postinstall`
 * script is still just bytes to this module.
 */

const MAX_HEADINGS_PER_FILE = 200;
const MAX_SYMBOLS_PER_FILE = 500;
const MAX_HEADING_CHARS = 200;
const MAX_SYMBOL_CHARS = 200;

export function detectLanguage(filePath: string): KnowledgeLanguage {
  const base = path.posix.basename(filePath).toLowerCase();
  const ext = path.posix.extname(base);

  if (base === 'dockerfile' || base === 'makefile') return 'shell';
  if (base === 'readme' || base === 'license' || base === 'changelog') return 'markdown';

  switch (ext) {
    case '.md':
    case '.mdx':
    case '.markdown':
      return 'markdown';
    case '.py':
    case '.pyi':
      return 'python';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.jsx':
      return 'javascript';
    case '.json':
      return 'json';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.toml':
      return 'toml';
    case '.css':
    case '.scss':
      return 'css';
    case '.html':
    case '.htm':
      return 'html';
    case '.sh':
    case '.bash':
    case '.zsh':
    case '.ps1':
      return 'shell';
    default:
      return 'unknown';
  }
}

/** Languages we index structurally; others still get digest + size tracking. */
const STRUCTURED_LANGUAGES = new Set<KnowledgeLanguage>([
  'markdown',
  'python',
  'typescript',
  'javascript',
]);

export function isStructuredLanguage(language: KnowledgeLanguage): boolean {
  return STRUCTURED_LANGUAGES.has(language);
}

function cleanText(raw: string, max: number): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .trim();
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  // A trailing newline is a terminator, not an extra empty line.
  if (content.endsWith('\n')) lines -= 1;
  return lines;
}

export interface MarkdownSection {
  level: number;
  title: string;
  line: number;
}

/** Extracts ATX headings, ignoring fenced code blocks and HTML comments. */
export function extractMarkdownHeadings(content: string): MarkdownSection[] {
  const headings: MarkdownSection[] = [];
  let inFence = false;
  let fenceMarker = '';

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '';
      if (!inFence) {
        inFence = true;
        fenceMarker = marker[0] ?? '`';
      } else if (marker[0] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const headingMatch = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!headingMatch) continue;
    const text = stripInlineMarkdown(headingMatch[2] ?? '');
    if (!text) continue;

    headings.push({
      level: (headingMatch[1] ?? '#').length,
      title: cleanText(text, MAX_HEADING_CHARS),
      line: index + 1,
    });
    if (headings.length >= MAX_HEADINGS_PER_FILE) break;
  }
  return headings;
}

interface PythonScope {
  indent: number;
  kind: 'class' | 'function';
  name: string;
}

const PY_DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const PY_CLASS_RE = /^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/;
const PY_CONST_RE = /^([A-Z][A-Z0-9_]{1,60})\s*(?::[^=]+)?=/;
/** Flask/FastAPI-style decorators and common Django/DRF route helpers. */
const PY_ROUTE_RE =
  /^\s*@\s*(?:[A-Za-z_][\w.]*\.)?(get|post|put|patch|delete|route|websocket|api_view)\s*\(/i;
const PY_EXPORT_RE = /^__all__\s*=/;

function indentWidth(whitespace: string): number {
  let width = 0;
  for (const char of whitespace) width += char === '\t' ? 4 : 1;
  return width;
}

export function extractPythonSymbols(content: string): KnowledgeSymbol[] {
  const symbols: KnowledgeSymbol[] = [];
  const lines = content.split(/\r?\n/);
  // Python scope is indentation, and a class can contain sibling methods at the
  // same indent as each other. A single "parent" slot would forget the class as
  // soon as the first method closes, so keep the enclosing def/class stack.
  const scopes: PythonScope[] = [];
  let pendingRoute: { line: number; kind: string } | null = null;

  for (let index = 0; index < lines.length && symbols.length < MAX_SYMBOLS_PER_FILE; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = indentWidth(/^\s*/.exec(line)?.[0] ?? '');

    if (PY_ROUTE_RE.test(line)) {
      const verb = (PY_ROUTE_RE.exec(line)?.[1] ?? 'route').toUpperCase();
      pendingRoute = { line: index + 1, kind: verb };
      continue;
    }

    const classMatch = PY_CLASS_RE.exec(line);
    const defMatch = classMatch ? null : PY_DEF_RE.exec(line);

    if (classMatch || defMatch) {
      // Close every scope this declaration is no longer inside of.
      while (scopes.length > 0 && (scopes[scopes.length - 1] as PythonScope).indent >= indent) {
        scopes.pop();
      }
      const name = (classMatch?.[2] ?? defMatch?.[2] ?? '').trim();
      const parent = scopes[scopes.length - 1];
      let kind: KnowledgeSymbolKind;
      if (classMatch) {
        kind = 'class';
      } else if (pendingRoute) {
        // The decorator is the strong signal, so it wins over `method`.
        kind = 'route';
      } else {
        kind = parent?.kind === 'class' ? 'method' : 'function';
      }

      symbols.push({ name: cleanText(name, MAX_SYMBOL_CHARS), kind, line: index + 1 });
      pendingRoute = null;
      scopes.push({ indent, kind: classMatch ? 'class' : 'function', name });
      continue;
    }

    // A decorator between us and a def (stacked decorators) keeps the pending
    // route until a def/class consumes it or a real statement appears.
    if (trimmed.startsWith('@')) continue;
    pendingRoute = null;

    if (scopes.length === 0) {
      const constMatch = PY_CONST_RE.exec(line);
      if (constMatch) {
        symbols.push({
          name: cleanText(constMatch[1] ?? '', MAX_SYMBOL_CHARS),
          kind: 'constant',
          line: index + 1,
        });
        continue;
      }

      if (PY_EXPORT_RE.test(line) && symbols.length < MAX_SYMBOLS_PER_FILE) {
        symbols.push({ name: '__all__', kind: 'export', line: index + 1 });
      }
    }
  }

  return symbols;
}

const JS_FUNCTION_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/;
const JS_CLASS_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const JS_CONST_FN_RE =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
const JS_INTERFACE_RE = /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/;
const JS_TYPE_RE = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/;
const JS_ENUM_RE = /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
const JS_CONST_RE = /^\s*export\s+(?:const|let|var)\s+([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/;
/** Express/Fastify/Hono-style handler registration. */
const JS_ROUTE_RE =
  /\b(?:app|router|server|fastify|hono)\s*\.\s*(get|post|put|patch|delete|all|route)\s*\(\s*['"`]([^'"`]+)['"`]/;
const JS_EXPORT_LIST_RE = /^\s*export\s*(?:type\s*)?\{([^}]+)\}/;

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name) && !/^[A-Z0-9_]+$/.test(name);
}

export function extractTypeScriptSymbols(content: string): KnowledgeSymbol[] {
  const symbols: KnowledgeSymbol[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length && symbols.length < MAX_SYMBOLS_PER_FILE; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    const routeMatch = JS_ROUTE_RE.exec(line);
    if (routeMatch) {
      symbols.push({
        name: cleanText(`${(routeMatch[1] ?? 'route').toUpperCase()} ${routeMatch[2] ?? ''}`, MAX_SYMBOL_CHARS),
        kind: 'route',
        line: index + 1,
      });
      continue;
    }

    const classMatch = JS_CLASS_RE.exec(line);
    if (classMatch) {
      const name = classMatch[1] ?? '';
      symbols.push({
        name: cleanText(name, MAX_SYMBOL_CHARS),
        kind: isComponentName(name) && /extends\s+React\.(?:Component|PureComponent)/.test(line)
          ? 'component'
          : 'class',
        line: index + 1,
      });
      continue;
    }

    const fnMatch = JS_FUNCTION_RE.exec(line);
    if (fnMatch) {
      const name = fnMatch[1] ?? '';
      symbols.push({
        name: cleanText(name, MAX_SYMBOL_CHARS),
        kind: isComponentName(name) ? 'component' : 'function',
        line: index + 1,
      });
      continue;
    }

    const constFnMatch = JS_CONST_FN_RE.exec(line);
    if (constFnMatch) {
      const name = constFnMatch[1] ?? '';
      symbols.push({
        name: cleanText(name, MAX_SYMBOL_CHARS),
        kind: isComponentName(name) ? 'component' : 'constant',
        line: index + 1,
      });
      continue;
    }

    const interfaceMatch = JS_INTERFACE_RE.exec(line);
    if (interfaceMatch) {
      symbols.push({
        name: cleanText(interfaceMatch[1] ?? '', MAX_SYMBOL_CHARS),
        kind: 'interface',
        line: index + 1,
      });
      continue;
    }

    const typeMatch = JS_TYPE_RE.exec(line);
    if (typeMatch) {
      symbols.push({
        name: cleanText(typeMatch[1] ?? '', MAX_SYMBOL_CHARS),
        kind: 'type',
        line: index + 1,
      });
      continue;
    }

    const enumMatch = JS_ENUM_RE.exec(line);
    if (enumMatch) {
      symbols.push({
        name: cleanText(enumMatch[1] ?? '', MAX_SYMBOL_CHARS),
        kind: 'type',
        line: index + 1,
      });
      continue;
    }

    const constMatch = JS_CONST_RE.exec(line);
    if (constMatch) {
      symbols.push({
        name: cleanText(constMatch[1] ?? '', MAX_SYMBOL_CHARS),
        kind: 'constant',
        line: index + 1,
      });
      continue;
    }

    const exportListMatch = JS_EXPORT_LIST_RE.exec(line);
    if (exportListMatch) {
      for (const rawName of (exportListMatch[1] ?? '').split(',')) {
        const name = rawName.trim().split(/\s+as\s+/)[0]?.trim() ?? '';
        if (!name || name.startsWith('type ')) continue;
        symbols.push({ name: cleanText(name, MAX_SYMBOL_CHARS), kind: 'export', line: index + 1 });
        if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
      }
    }
  }

  return symbols;
}

/**
 * Markdown headings plus a shallow outline of fenced code blocks is enough for
 * docs; Python/TS/JS get real symbol extraction.
 */
export function extractSymbols(language: KnowledgeLanguage, content: string): KnowledgeSymbol[] {
  if (language === 'python') return extractPythonSymbols(content);
  if (language === 'typescript' || language === 'javascript') {
    return extractTypeScriptSymbols(content);
  }
  return [];
}

function toHeadings(sections: MarkdownSection[]): KnowledgeHeading[] {
  return sections.map((section) => ({
    level: Math.max(1, Math.min(6, section.level)),
    text: section.title,
  }));
}

const ENTRYPOINT_BASE_NAMES = new Set([
  'readme.md',
  'readme.markdown',
  'index.ts',
  'index.js',
  'index.mts',
  'main.ts',
  'main.js',
  'main.py',
  'app.py',
  'server.py',
  'manage.py',
  '__main__.py',
  'package.json',
  'pyproject.toml',
  'dockerfile',
]);

/**
 * Ranked entrypoints: project docs first, then runtime/manifest entry files,
 * then any other README-like doc. Rank is part of the published contract, so
 * downstream slices do not need to repeat these rules.
 */
export function detectEntrypoints(filePath: string, language: KnowledgeLanguage): KnowledgeEntrypoint[] {
  const base = path.posix.basename(filePath).toLowerCase();
  const depth = filePath.split('/').length - 1;

  if (base === 'readme.md' || base === 'readme.markdown' || base === 'readme') {
    return [{ path: filePath, kind: 'readme', rank: depth === 0 ? 0 : 2 }];
  }
  if (base === 'package.json') {
    return [{ path: filePath, kind: 'manifest', rank: 1 }];
  }
  if (base === 'pyproject.toml' || base === 'requirements.txt' || base === 'setup.py') {
    return [{ path: filePath, kind: 'manifest', rank: 1 }];
  }
  if (base === 'main.py' || base === 'app.py' || base === 'server.py' || base === 'manage.py' || base === '__main__.py') {
    return [{ path: filePath, kind: 'runtime_entry', rank: 1 }];
  }
  if (
    (base === 'index.ts' || base === 'index.js' || base === 'main.ts' || base === 'main.js') &&
    depth <= 2
  ) {
    return [{ path: filePath, kind: 'runtime_entry', rank: 1 }];
  }
  if (language === 'markdown' && depth === 0 && ENTRYPOINT_BASE_NAMES.has(base)) {
    return [{ path: filePath, kind: 'doc', rank: 2 }];
  }
  return [];
}

export interface ExtractedFile {
  language: KnowledgeLanguage;
  byteSize: number;
  lineCount: number;
  headings: KnowledgeHeading[];
  symbols: KnowledgeSymbol[];
  entrypoints: KnowledgeEntrypoint[];
}

export function extractFile(filePath: string, content: string): ExtractedFile {
  const language = detectLanguage(filePath);
  const sections = language === 'markdown' ? extractMarkdownHeadings(content) : [];

  return {
    language,
    byteSize: Buffer.byteLength(content, 'utf8'),
    lineCount: countLines(content),
    headings: toHeadings(sections),
    symbols: extractSymbols(language, content),
    entrypoints: detectEntrypoints(filePath, language),
  };
}

export interface DescribedFile {
  path: string;
  language: KnowledgeLanguage;
  byteSize: number;
  lineCount: number;
  blobSha?: string;
  headings: KnowledgeHeading[];
  symbols: KnowledgeSymbol[];
  entrypoints: KnowledgeEntrypoint[];
}

export function toKnowledgeFile(file: DescribedFile): KnowledgeFile {
  return {
    path: file.path,
    language: file.language,
    byteSize: file.byteSize,
    lineCount: file.lineCount,
    ...(file.blobSha ? { blobSha: file.blobSha } : {}),
    headings: file.headings,
    symbols: file.symbols,
    entrypoints: file.entrypoints,
  };
}

/** Sorted, deduped union of per-file entrypoints, stable for snapshot digests. */
export function mergeEntrypoints(files: KnowledgeFile[]): KnowledgeEntrypoint[] {
  const byPath = new Map<string, KnowledgeEntrypoint>();
  for (const file of files) {
    for (const entry of file.entrypoints) {
      const existing = byPath.get(entry.path);
      if (!existing || entry.rank < existing.rank) byPath.set(entry.path, entry);
    }
  }
  return Array.from(byPath.values()).sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
}
