import { describe, expect, it } from 'vitest';
import {
  formatToolCalls,
  partitionToolCalls,
  splitMessage,
  truncate,
  truncateLine,
} from '../src/formatting';

describe('truncateLine defensive shape (audit stability batch 票17)', () => {
  it('non-string input from untrusted RPC shapes never throws and stays readable', () => {
    expect(truncateLine(123 as unknown as string)).toBe('123');
    expect(truncateLine({ a: 1 } as unknown as string)).toBe('[object Object]');
    expect(truncateLine(undefined as unknown as string)).toBe('undefined');
    expect(truncateLine('正常文本')).toBe('正常文本');
  });
});

describe('splitMessage maxLen 钳制(审计工程批 票23)', () => {
  it('maxLen 0/负不再死循环,按 1 切分', () => {
    expect(splitMessage('abc', 0)).toEqual(['a', 'b', 'c']);
    expect(splitMessage('ab', -5)).toEqual(['a', 'b']);
  });
});

describe('truncateLine', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates with ellipsis at maxLen', () => {
    expect(truncate('hello world!', 8)).toBe('hello...');
  });

  it('returns empty string for falsy input', () => {
    expect(truncate('', 10)).toBe('');
  });
});

describe('splitMessage', () => {
  it('returns single chunk for short text', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello']);
  });

  it('splits at newline boundary and preserves all content', () => {
    const text = 'aaaa\nbbbb\ncccc';
    // maxLen=9: "aaaa\nbbbb" is 9 chars, so first chunk should be exactly that
    const chunks = splitMessage(text, 9);
    expect(chunks).toEqual(['aaaa\nbbbb', 'cccc']);
  });

  it('splits at space when no good newline exists', () => {
    const text = 'hello world goodbye world';
    const chunks = splitMessage(text, 15);
    // Should break at space, not mid-word
    expect(chunks[0]).toBe('hello world');
    expect(chunks[1]).toBe('goodbye world');
  });

  it('hard-cuts continuous text and preserves all content', () => {
    const text = 'a'.repeat(100);
    const chunks = splitMessage(text, 30);
    expect(chunks.join('')).toBe(text);
    // First chunks should be exactly maxLen
    expect(chunks[0].length).toBe(30);
  });

  it('handles text that is exactly maxLen', () => {
    const text = 'a'.repeat(50);
    expect(splitMessage(text, 50)).toEqual([text]);
  });
});

describe('splitMessage 代码围栏感知(spec issue #223)', () => {
  /** 数一段文本里的围栏行数(``` 与 ~~~,含带 info string 的开围栏)。 */
  const fenceCount = (chunk: string): number =>
    (chunk.match(/^ {0,3}(?:```|~~~)/gm) ?? []).length;

  it('切点落进装得下的代码块 → 回退到块前,块整体留在同一段', () => {
    const block = '```ts\nconst a = 1\n```';
    const text = 'a'.repeat(40) + '\n' + block + '\n' + 'c'.repeat(60);
    const chunks = splitMessage(text, 50);
    // 块必须完整出现在某一段里,不允许两段各持半截围栏
    // (块后可粘普通文本 —— 段填充优先,粘着不破坏渲染)
    expect(chunks.some((c) => c.includes(block))).toBe(true);
    for (const chunk of chunks.slice(0, -1)) {
      expect(fenceCount(chunk) % 2).toBe(0);
    }
  });

  it('块在段首且装得下 → 前推切点到块尾,块独占整段', () => {
    const block = '```\nX\n```';
    const text = block + '\n' + 'q'.repeat(50);
    const chunks = splitMessage(text, 10);
    expect(chunks[0]).toBe(block);
  });

  it('单块超长 → 块内下刀补围栏,两半各自配对且语言标记复现', () => {
    const body = 'b'.repeat(100);
    const text = 'head\n```ts\n' + body + '\n```\ntail';
    const chunks = splitMessage(text, 40);
    // 精确期望:首段含块前文本,后续每段以复现语言标记的开围栏起头
    expect(chunks).toEqual([
      'head\n```ts\n' + 'b'.repeat(40) + '\n```',
      '```ts\n' + 'b'.repeat(40) + '\n```',
      '```ts\n' + 'b'.repeat(20) + '\n```\ntail',
    ]);
  });

  it('~~~ 围栏与 ``` 同等对待', () => {
    const block = '~~~\npycode\n~~~';
    const text = 'a'.repeat(40) + '\n' + block + '\n' + 'c'.repeat(60);
    const chunks = splitMessage(text, 50);
    expect(chunks.some((c) => c.includes(block))).toBe(true);
    for (const chunk of chunks.slice(0, -1)) {
      expect(fenceCount(chunk) % 2).toBe(0);
    }
  });

  it('CommonMark 边界:``` 行 info 含反引号不算围栏,视同普通文本', () => {
    // "```a`b" 的 info string 含反引号,按 CommonMark(markdown-it 同判)
    // 不是围栏行 —— 不得触发切点让路或补围栏
    const text = 'x'.repeat(40) + '\n```a`b\n' + 'y'.repeat(100);
    expect(splitMessage(text, 50)).toEqual(['x'.repeat(40) + '\n```a`b', 'y'.repeat(50), 'y'.repeat(50)]);
  });

  it('CommonMark 边界:带 info 的 ``` 行不算闭围栏,块继续未闭', () => {
    // "``` js" 不是合法闭围栏(带 info)→ 块仍开着,超长时按未闭合块内切补围栏
    const text = '```\nA\n``` js\n' + 'B'.repeat(100);
    expect(splitMessage(text, 40)).toEqual([
      '```\nA\n``` js\n```',
      '```\n' + 'B'.repeat(40) + '\n```',
      '```\n' + 'B'.repeat(40) + '\n```',
      '```\n' + 'B'.repeat(20),
    ]);
  });

  it('内容守恒:无内切场景全部非空白内容跨段按序不丢不重', () => {
    // 切点处的空白会被 trimStart 吃掉(既有语义),故剥掉全部空白后
    // 比对 —— 任何非空白字符的丢失/重复/乱序都会破断言
    const strip = (s: string): string => s.replace(/\s+/g, '');
    const text = 'a'.repeat(40) + '\n' + '```ts\nx = 1\n```' + '\n' + 'c'.repeat(60);
    const chunks = splitMessage(text, 50);
    expect(strip(chunks.join(''))).toBe(strip(text));
  });

  it('多块与长文本交错 → 各块完整、每段围栏成对', () => {
    const block1 = '```m1\nA\n```';
    const block2 = '```m2\nB\n```';
    const text = block1 + '\n' + 'y'.repeat(80) + '\n' + block2 + '\n' + 'z'.repeat(80);
    const chunks = splitMessage(text, 50);
    expect(chunks.some((c) => c.includes(block1))).toBe(true);
    expect(chunks.some((c) => c.includes(block2))).toBe(true);
    for (const chunk of chunks.slice(0, -1)) {
      expect(fenceCount(chunk) % 2).toBe(0);
    }
  });

  it('超长未闭合块 → 不死循环,补闭围栏让各段合法', () => {
    const text = '```\n' + 'd'.repeat(5000);
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBeGreaterThan(10);
    for (const chunk of chunks.slice(0, -1)) {
      expect(fenceCount(chunk) % 2).toBe(0);
    }
  });

  it('围栏感知不扰动纯文本切分:无围栏时与旧算法结果一致', () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd\neeee';
    expect(splitMessage(text, 9)).toEqual(splitMessageNaive(text, 9));
  });

  /** 旧算法参照实现(改造前的 splitMessage 逻辑),用于回归对照。 */
  function splitMessageNaive(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let breakAt = remaining.lastIndexOf('\n', maxLen);
      if (breakAt < maxLen * 0.5) breakAt = remaining.lastIndexOf(' ', maxLen);
      if (breakAt < maxLen * 0.3) breakAt = maxLen;
      chunks.push(remaining.substring(0, breakAt));
      remaining = remaining.substring(breakAt).trimStart();
    }
    return chunks;
  }
});

describe('formatToolCalls', () => {
  it('formats tool calls with arguments', () => {
    const msg = {
      content: [
        {
          type: 'toolCall',
          name: 'grep',
          arguments: { pattern: 'hello', path: '/src' },
        },
      ],
    } as any;
    const result = formatToolCalls(msg);
    expect(result).toBe('🔧 `grep` (pattern=hello, path=/src)');
  });

  it('formats tool calls without arguments', () => {
    const msg = {
      content: [{ type: 'toolCall', name: 'status', arguments: {} }],
    } as any;
    expect(formatToolCalls(msg)).toBe('🔧 `status`');
  });

  it('returns empty string when no tool calls', () => {
    const msg = {
      content: [{ type: 'text', text: 'hi' }],
    } as any;
    expect(formatToolCalls(msg)).toBe('');
  });

  it('truncates long argument values at the default 100 chars', () => {
    const longVal = 'x'.repeat(200);
    const msg = {
      content: [
        {
          type: 'toolCall',
          name: 'write',
          arguments: { content: longVal },
        },
      ],
    } as any;
    const result = formatToolCalls(msg);
    // 100 chars: 97 x's + "..."
    expect(result).toContain('content=' + 'x'.repeat(97) + '...');
    expect(result).not.toContain('x'.repeat(98));
  });

  it('honors a custom per-argument limit', () => {
    const longVal = 'x'.repeat(100);
    const msg = {
      content: [{ type: 'toolCall', name: 'bash', arguments: { command: longVal } }],
    } as any;
    const result = formatToolCalls(msg, 20);
    // 20 chars: 17 x's + "..."
    expect(result).toContain('command=' + 'x'.repeat(17) + '...');
    expect(result).not.toContain('x'.repeat(18));
  });

  it('leaves a value exactly at the limit untouched', () => {
    const exact = 'y'.repeat(100);
    const msg = {
      content: [{ type: 'toolCall', name: 'read', arguments: { path: exact } }],
    } as any;
    const result = formatToolCalls(msg);
    expect(result).toContain('path=' + exact + ')');
    expect(result).not.toContain('...');
  });

  it('applies the limit to each argument independently, not to the whole line', () => {
    const msg = {
      content: [
        {
          type: 'toolCall',
          name: 'bash',
          arguments: { command: 'a'.repeat(150), timeout: 'b'.repeat(150) },
        },
      ],
    } as any;
    const result = formatToolCalls(msg);
    expect(result).toContain('command=' + 'a'.repeat(97) + '...');
    expect(result).toContain('timeout=' + 'b'.repeat(97) + '...');
  });

  it('joins multiple tool calls with newlines', () => {
    const msg = {
      content: [
        { type: 'toolCall', name: 'grep', arguments: { pattern: 'a' } },
        { type: 'toolCall', name: 'read', arguments: { path: '/b' } },
      ],
    } as any;
    const result = formatToolCalls(msg);
    expect(result).toBe('🔧 `grep` (pattern=a)\n🔧 `read` (path=/b)');
  });
});

describe('参数单行化(spec #297)', () => {
  it('含换行的参数值压成单行,不再把换行漏进卡片', () => {
    const msg = {
      content: [
        {
          type: 'toolCall',
          name: 'write',
          arguments: { content: '/**\n * 反射层\n *\n * 实测', path: '/src/reflex.ts' },
        },
      ],
    } as any;
    const result = formatToolCalls(msg);
    expect(result).toBe('🔧 `write` (content=/** * 反射层 * * 实测, path=/src/reflex.ts)');
    expect(result).not.toContain('\n');
  });

  it('尾部换行归一成尾随空格(归一不 trim)', () => {
    const msg = {
      content: [{ type: 'toolCall', name: 'write', arguments: { content: 'hello\n' } }],
    } as any;
    expect(formatToolCalls(msg)).toBe('🔧 `write` (content=hello )');
  });

  it('CRLF 同样压平', () => {
    const msg = {
      content: [
        { type: 'toolCall', name: 'bash', arguments: { command: 'cat <<EOF\r\nhello\r\nEOF' } },
      ],
    } as any;
    expect(formatToolCalls(msg)).toBe('🔧 `bash` (command=cat <<EOF hello EOF)');
  });

  it('含换行的值压平后仍受长度上限约束', () => {
    const long = `/**\n${' * x'.repeat(50)}`;
    const msg = {
      content: [{ type: 'toolCall', name: 'write', arguments: { content: long } }],
    } as any;
    const result = formatToolCalls(msg);
    expect(result).not.toContain('\n');
    expect(result).toContain('...');
  });

  it('不含换行的值逐字节不变(连续空格不归一)', () => {
    const msg = {
      content: [
        {
          type: 'toolCall',
          name: 'bash',
          arguments: { command: 'echo a  b   c', timeout: '30' },
        },
      ],
    } as any;
    expect(formatToolCalls(msg)).toBe('🔧 `bash` (command=echo a  b   c, timeout=30)');
  });
});

describe('partitionToolCalls 切段(spec #297)', () => {
  const call = (name: string, args: Record<string, unknown>) => ({
    type: 'toolCall',
    name,
    arguments: args,
  });
  const writeMultiline = () =>
    call('write', { content: '/**\n * doc', path: '/src/x.ts' });
  const bashLine = () => call('bash', { cmd: 'ls' });

  it('无工具调用给空段列表', () => {
    const msg = { content: [{ type: 'text', text: 'hi' }] } as any;
    expect(partitionToolCalls(msg)).toEqual([]);
  });

  it('连续普通调用归一段,段文本为逐行拼接', () => {
    const msg = { content: [bashLine(), bashLine()] } as any;
    expect(partitionToolCalls(msg)).toEqual([
      { standalone: false, text: '🔧 `bash` (cmd=ls)\n🔧 `bash` (cmd=ls)' },
    ]);
  });

  it('大段参数调用独立成段且恒单行', () => {
    const msg = { content: [writeMultiline()] } as any;
    const segments = partitionToolCalls(msg);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.standalone).toBe(true);
    expect(segments[0]!.text).toBe(
      '🔧 `write` (content=/** * doc, path=/src/x.ts)'
    );
  });

  it('混合顺序切段:普通段在独立段两侧断开,段序即调用序', () => {
    const msg = {
      content: [bashLine(), writeMultiline(), bashLine(), bashLine(), writeMultiline()],
    } as any;
    const segments = partitionToolCalls(msg);
    expect(segments.map((s) => s.standalone)).toEqual([false, true, false, true]);
    expect(segments[0]!.text.split('\n')).toHaveLength(1); // 首个 bash:独立段前只有自己
    expect(segments[2]!.text.split('\n')).toHaveLength(2); // 独立段后的连续 bash 归一段
  });

  it('切段拼接 == 整段工具文本(拼装口径单一)', () => {
    const msg = {
      content: [bashLine(), writeMultiline(), bashLine(), writeMultiline(), writeMultiline()],
    } as any;
    expect(
      partitionToolCalls(msg).map((s) => s.text).join('\n')
    ).toBe(formatToolCalls(msg));
  });
});
