// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  detectEntrypoints,
  detectLanguage,
  extractFile,
  extractMarkdownHeadings,
  extractPythonSymbols,
  extractTypeScriptSymbols,
  mergeEntrypoints,
} from './extract';

const PYTHON_SOURCE = `"""LiveNotes API."""
from flask import Flask

app = Flask(__name__)
MAX_NOTES = 120


@app.route("/notes", methods=["GET"])
def list_notes():
    return []


class NoteRepository:
    """Stores notes."""

    def __init__(self, path):
        self.path = path

    async def load(self):
        return None

    class Cache:
        pass
`;

const TYPESCRIPT_SOURCE = `import { Fastify } from 'fastify';

export interface Note { id: string }
export type NoteId = string;
export const MAX_NOTES = 100;
export const fetchNotes = async (): Promise<Note[]> => [];
export function buildNote(id: string): Note { return { id }; }
export class NoteStore {}
export enum Mode { Live, Draft }

const app = Fastify();
app.get('/v1/notes', async () => []);
app.post("/v1/notes", async () => ({}));

export { buildNote as makeNote, NoteId };
`;

const MARKDOWN_SOURCE = `# LiveNotes

Intro paragraph.

## Features

\`\`\`python
# not a heading
def ignored():
    pass
\`\`\`

### Sync [docs](https://example.com)

<!-- # hidden heading -->

Setext heading
==============
`;

describe('语言识别', () => {
  it('识别 Python / TS / Markdown / 配置与未知语言', () => {
    expect(detectLanguage('app/main.py')).toBe('python');
    expect(detectLanguage('src/App.tsx')).toBe('typescript');
    expect(detectLanguage('src/util.mjs')).toBe('javascript');
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('package.json')).toBe('json');
    expect(detectLanguage('pyproject.toml')).toBe('toml');
    expect(detectLanguage('config/app.yaml')).toBe('yaml');
    expect(detectLanguage('scripts/deploy.sh')).toBe('shell');
    expect(detectLanguage('Dockerfile')).toBe('shell');
    expect(detectLanguage('LICENSE')).toBe('markdown');
    expect(detectLanguage('data.unknownext')).toBe('unknown');
  });
});

describe('Markdown 章节提取', () => {
  it('提取 ATX 标题、忽略围栏内伪标题并保留层级', () => {
    const headings = extractMarkdownHeadings(MARKDOWN_SOURCE);
    expect(headings.map((heading) => [heading.level, heading.title])).toEqual([
      [1, 'LiveNotes'],
      [2, 'Features'],
      [3, 'Sync docs'],
    ]);
    expect(headings.map((heading) => heading.line)).toEqual([1, 5, 13]);
  });

  it('去掉行内链接与强调，并限制单个标题长度', () => {
    const headings = extractMarkdownHeadings(`## See [the **guide**](https://x.y)\n`);
    expect(headings[0]?.title).toBe('See the guide');
  });
});

describe('Python 符号提取', () => {
  it('识别函数、类、方法、常量与 Flask 路由', () => {
    const symbols = extractPythonSymbols(PYTHON_SOURCE);
    expect(symbols).toEqual(
      expect.arrayContaining([
        { name: 'MAX_NOTES', kind: 'constant', line: 5 },
        { name: 'list_notes', kind: 'route', line: 9 },
        { name: 'NoteRepository', kind: 'class', line: 13 },
        { name: 'load', kind: 'method', line: 19 },
        { name: 'Cache', kind: 'class', line: 22 },
      ]),
    );
    // `__init__` is a method of NoteRepository.
    expect(symbols).toContainEqual({ name: '__init__', kind: 'method', line: 16 });
  });

  it('不把装饰器本身当作符号', () => {
    const symbols = extractPythonSymbols(PYTHON_SOURCE);
    expect(symbols.some((symbol) => symbol.name.includes('/notes'))).toBe(false);
  });
});

describe('TypeScript/JS 符号提取', () => {
  it('识别接口、类型、常量、函数、类、枚举与路由', () => {
    const symbols = extractTypeScriptSymbols(TYPESCRIPT_SOURCE);
    expect(symbols).toEqual(
      expect.arrayContaining([
        { name: 'Note', kind: 'interface', line: 3 },
        { name: 'NoteId', kind: 'type', line: 4 },
        { name: 'MAX_NOTES', kind: 'constant', line: 5 },
        { name: 'fetchNotes', kind: 'constant', line: 6 },
        { name: 'buildNote', kind: 'function', line: 7 },
        { name: 'NoteStore', kind: 'class', line: 8 },
        { name: 'Mode', kind: 'type', line: 9 },
        { name: 'GET /v1/notes', kind: 'route', line: 12 },
        { name: 'POST /v1/notes', kind: 'route', line: 13 },
      ]),
    );
  });
});

describe('入口点识别', () => {
  it('README 排在最前，运行时入口次之', () => {
    expect(detectEntrypoints('README.md', 'markdown')[0]).toMatchObject({ rank: 0, kind: 'readme' });
    expect(detectEntrypoints('app/main.py', 'python')[0]).toMatchObject({
      rank: 1,
      kind: 'runtime_entry',
    });
    expect(detectEntrypoints('package.json', 'json')[0]).toMatchObject({ kind: 'manifest' });
    expect(detectEntrypoints('src/util.ts', 'typescript')).toEqual([]);
  });

  it('合并后按 rank 与路径稳定排序', () => {
    const files = [
      {
        path: 'src/util.ts',
        language: 'typescript' as const,
        byteSize: 1,
        lineCount: 1,
        headings: [],
        symbols: [],
        entrypoints: [],
      },
      {
        path: 'package.json',
        language: 'json' as const,
        byteSize: 1,
        lineCount: 1,
        headings: [],
        symbols: [],
        entrypoints: [{ path: 'package.json', kind: 'manifest', rank: 1 }],
      },
      {
        path: 'README.md',
        language: 'markdown' as const,
        byteSize: 1,
        lineCount: 1,
        headings: [],
        symbols: [],
        entrypoints: [{ path: 'README.md', kind: 'readme', rank: 0 }],
      },
    ];
    expect(mergeEntrypoints(files).map((entry) => entry.path)).toEqual([
      'README.md',
      'package.json',
    ]);
  });
});

describe('extractFile', () => {
  it('统计 UTF-8 字节数与行数，并组合多项信号', () => {
    const extracted = extractFile('notes.md', '# 标题\n\n中文内容\n');
    expect(extracted.language).toBe('markdown');
    expect(extracted.lineCount).toBe(3);
    expect(extracted.byteSize).toBe(Buffer.byteLength('# 标题\n\n中文内容\n', 'utf8'));
    expect(extracted.headings).toEqual([{ level: 1, text: '标题' }]);
    expect(extracted.entrypoints).toEqual([]);
  });

  it('空文件是 0 行 0 字节，不会抛错', () => {
    const extracted = extractFile('empty.py', '');
    expect(extracted).toMatchObject({ byteSize: 0, lineCount: 0, symbols: [], headings: [] });
  });
});
