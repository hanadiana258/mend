// main.ts is mend, the CLI SPEC.md specifies (MIT). Implements sections 1 to 10:
// the command line, output, exit codes, safe paths, format detection and the tiered
// line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits
// and the all-or-nothing write. Node 22, the standard library alone.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers
// ---------------------------------------------------------------------------

function tierOf(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const res: number[] = [];
  if (o.length === 0) return res;
  const t = o.map((l) => tierOf(l, tier));
  outer: for (let i = 0; i + o.length <= lines.length; i++) {
    for (let j = 0; j < o.length; j++) if (tierOf(lines[i + j]!, tier) !== t[j]) continue outer;
    res.push(i);
  }
  return res;
}

function findAtTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrencesAt(lines, o, tier);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** leading spaces and tabs */
const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** At tier 2, re-indent a written line: P (O's first line's indent) becomes F (the file's). */
function reindent(s: string, F: string, P: string): string {
  if (s.trim() === '') return s;
  if (s.startsWith(P)) return F + s.slice(P.length);
  return s;
}

interface LineFile {
  lines: string[];
  finalBreak: boolean;
}

function fileToLines(text: string): LineFile {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], finalBreak: false };
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, finalBreak };
}

function linesToFile(f: LineFile, br: string): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(br) + (f.finalBreak ? br : '');
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface UItem {
  t: ' ' | '-' | '+' | '\\';
  s: string;
}
interface UHunk {
  a: number;
  items: UItem[];
}
interface USection {
  oldPath: string | null;
  newPath: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  created: boolean;
  deleted: boolean;
  hunks: UHunk[];
}

function stripAb(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = (tab >= 0 ? rest.slice(0, tab) : rest).trim();
  return stripAb(p);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSection = (): USection => {
    const s: USection = { oldPath: null, newPath: null, renameOld: null, renameNew: null, diffOld: null, diffNew: null, created: false, deleted: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice(11);
      const idx = rest.lastIndexOf(' b/');
      if (!rest.startsWith('a/') || idx < 2) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = rest.slice(2, idx);
      cur.diffNew = rest.slice(idx + 3);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.oldPath !== null) cur = newSection();
      cur.oldPath = headerPath(l);
      cur.newPath = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), items: [] };
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') hunk.items.push({ t: ' ', s: '' });
        else if (b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') hunk.items.push({ t: b[0] as UItem['t'], s: b.slice(1) });
        else break;
        j += 1;
      }
      while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1]!.t === ' ' && hunk.items[hunk.items.length - 1]!.s === '') hunk.items.pop();
      cur.hunks.push(hunk);
      i = j;
      continue;
    }
    if (cur !== null) {
      if (l.startsWith('--- ') && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.renameOld = l.slice(12);
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice(10);
      else if (l.startsWith('new file mode')) cur.created = true;
      else if (l.startsWith('deleted file mode')) cur.deleted = true;
      i += 1;
      continue;
    }
    // outside any section: only malformed @@ is an error, the rest is ignored
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.oldPath ?? s.renameOld ?? s.diffOld;
    const newP = s.newPath ?? s.renameNew ?? s.diffNew;
    if (oldP === null && newP === null) throw new Exit2('error: parse 1');
    const isCreate = s.created || oldP === '/dev/null';
    const isDelete = s.deleted || newP === '/dev/null';
    if (isCreate && !isDelete) {
      const p = newP ?? '';
      const plus: string[] = [];
      let bsAfter = false;
      let seenLastPlus = false;
      for (let hi = s.hunks.length - 1; hi >= 0 && !seenLastPlus; hi--) {
        const items = s.hunks[hi]!.items;
        let lastPlus = -1;
        items.forEach((it, ii) => {
          if (it.t === '+') lastPlus = ii;
        });
        if (lastPlus >= 0) {
          seenLastPlus = true;
          for (let ii = lastPlus + 1; ii < items.length; ii++) if (items[ii]!.t === '\\') bsAfter = true;
        }
      }
      for (const h of s.hunks) for (const it of h.items) if (it.t === '+') plus.push(it.s);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (bsAfter ? '' : '\n'));
      });
      continue;
    }
    if (isDelete) {
      const p = oldP ?? '';
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    // change or move
    const op = oldP ?? '';
    const np = newP ?? '';
    const isMove = op !== np;
    edits.push((tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (isMove && !safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
      const f = fileToLines(before);
      let d = 0;
      for (const h of s.hunks) {
        const o: string[] = [];
        const items: Array<{ ctx: boolean; s: string }> = [];
        let lastCtxPlus = -1;
        let hasBs = false;
        h.items.forEach((it, ii) => {
          if (it.t === ' ') {
            o.push(it.s);
            items.push({ ctx: true, s: it.s, minus: false });
            lastCtxPlus = ii;
          } else if (it.t === '-') {
            o.push(it.s);
            items.push({ ctx: false, s: it.s, minus: true });
          } else if (it.t === '+') {
            items.push({ ctx: false, s: it.s, minus: false });
            lastCtxPlus = ii;
          } else if (ii > lastCtxPlus) hasBs = true;
        });
        if (o.length > 0) {
          const found = findAtTier(f.lines, o, strict);
          if (found === null) throw new Fail('no-match', op);
          const target = h.a - 1 + d;
          let best = found.pos[0]!;
          for (const p of found.pos) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
          const F = lead(f.lines[best]!);
          const P = lead(o[0]!);
          const out: string[] = [];
          let oi = 0;
          for (const it of items) {
            if (it.ctx) out.push(f.lines[best + oi]!), (oi += 1);
            else if (it.minus) oi += 1;
            else out.push(found.tier === 2 ? reindent(it.s, F, P) : it.s);
          }
          const lenBefore = f.lines.length;
          f.lines = [...f.lines.slice(0, best), ...out, ...f.lines.slice(best + o.length)];
          if (best + o.length === lenBefore) f.finalBreak = !hasBs;
          d += out.length - o.length;
        } else {
          const ins = Math.min(h.a + d, f.lines.length);
          const written = items.map((it) => it.s);
          const lenBefore = f.lines.length;
          f.lines = [...f.lines.slice(0, ins), ...written, ...f.lines.slice(ins)];
          if (ins >= lenBefore) f.finalBreak = !hasBs;
          d += written.length;
        }
      }
      if (isMove) {
        tree.now.set(op, null);
        tree.now.set(np, linesToFile(f, fileBr(before)));
        tree.moves.push([op, np]);
      } else {
        tree.now.set(op, linesToFile(f, fileBr(before)));
      }
    });
  }
  return edits;
}

function fileBr(text: string): string {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string | null;
    old: string[];
    neu: string[];
    searchLine: number;
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    // find =======
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, old: lines.slice(i + 1, sep), neu: lines.slice(sep + 1, end), searchLine: i });
    prevEnd = end;
    prevPath = path;
    i = end;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const b of blocks) {
    const p = b.path!;
    if (b.old.length === 0) {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, b.neu.length === 0 ? '' : b.neu.join('\n') + '\n');
      });
    } else {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const f = fileToLines(before);
        const found = findAtTier(f.lines, b.old, strict);
        if (found === null) throw new Fail('no-match', p);
        if (found.pos.length > 1) throw new Fail('ambiguous', p);
        const pos = found.pos[0]!;
        const F = lead(f.lines[pos]!);
        const P = lead(b.old[0]!);
        const out = b.neu.map((l) => (found!.tier === 2 ? reindent(l, F, P) : l));
        f.lines = [...f.lines.slice(0, pos), ...out, ...f.lines.slice(pos + b.old.length)];
        tree.now.set(p, linesToFile(f, fileBr(before)));
      });
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface VItem {
  kind: 'ctx' | '-' | '+';
  s: string;
}
interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: VItem[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => {
    for (let i = lines.length - 1; i >= 0; i--) if (!blank(lines[i]!)) return i;
    return -1;
  })();
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const n = last; // exclusive bound: content before *** End Patch
  while (i < n) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice(14).trim();
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ') || b.trim() === '*** End Patch') break;
        if (b === '') body.push('');
        else if (b[0] === '+') body.push(b.slice(1));
        else throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, body.length === 0 ? '' : body.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice(17).trim();
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ') || b.trim() === '*** End Patch') break;
        if (blank(b)) {
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice(17).trim();
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < n && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice(13).trim();
        j += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let sawBody = false;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ') || b.trim() === '*** End Patch') break;
        if (b.trim() === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: true, items: [] };
          else cur.eof = true;
          chunks.push(cur);
          cur = null;
          sawBody = false;
          j += 1;
          continue;
        }
        if (b.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${j + 1}`);
        if (b.startsWith('@@')) {
          if (sawBody) {
            chunks.push(cur!);
            sawBody = false;
          }
          const a = b.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, items: [] };
          j += 1;
          continue;
        }
        if (b === '') {
          if (cur === null) {
            // blank lines before any chunk body are ignored
            j += 1;
            continue;
          }
          cur.items.push({ kind: 'ctx', s: '' });
          sawBody = true;
          j += 1;
          continue;
        }
        if (b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, eof: false, items: [] };
          }
          cur.items.push({ kind: b[0] === ' ' ? 'ctx' : (b[0] as '-' | '+'), s: b.slice(1) });
          sawBody = true;
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      // drop trailing blank context lines of the last chunk
      if (chunks.length > 0) {
        const c = chunks[chunks.length - 1]!;
        while (c.items.length > 0 && c.items[c.items.length - 1]!.kind === 'ctx' && c.items[c.items.length - 1]!.s === '') c.items.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(makeV4aUpdate(p, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function makeV4aUpdate(p: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && moveTo !== p && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = fileToLines(before);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        let anchorAt = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (tierOf(f.lines[k]!, tier) === tierOf(c.anchor, tier)) {
              anchorAt = k;
              break;
            }
          }
          if (anchorAt >= 0) break;
        }
        if (anchorAt < 0) throw new Fail('no-match', p);
        cursor = anchorAt + 1;
      }
      const o: string[] = [];
      const seq: Array<{ kind: 'ctx' | '-' | '+'; s: string }> = [];
      const plus: string[] = [];
      for (const it of c.items) {
        if (it.kind === 'ctx') {
          seq.push({ kind: 'ctx', s: it.s });
          o.push(it.s);
        } else if (it.kind === '-') {
          seq.push({ kind: '-', s: it.s });
          o.push(it.s);
        } else {
          seq.push({ kind: '+', s: it.s });
          plus.push(it.s);
        }
      }
      if (o.length === 0) {
        const ins = c.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const written = plus;
        f.lines = [...f.lines.slice(0, ins), ...written, ...f.lines.slice(ins)];
        cursor = ins + written.length;
      } else {
        let found: { tier: number; pos: number[] } | null = null;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          const pos = occurrencesAt(f.lines, o, tier).filter((q) => q >= cursor && (!c.eof || q + o.length === f.lines.length));
          if (pos.length > 0) {
            found = { tier, pos };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', p);
        const pos = found.pos[0]!;
        const F = lead(f.lines[pos]!);
        const P = lead(o[0]!);
        const out: string[] = [];
        let oi = 0;
        for (const it of seq) {
          if (it.kind === 'ctx') out.push(f.lines[pos + oi]!), (oi += 1);
          else if (it.kind === '-') oi += 1;
          else out.push(found.tier === 2 ? reindent(it.s, F, P) : it.s);
        }
        f.lines = [...f.lines.slice(0, pos), ...out, ...f.lines.slice(pos + o.length)];
        cursor = pos + out.length;
      }
    }
    if (moveTo !== null) {
      if (moveTo === p) {
        tree.now.set(p, linesToFile(f, fileBr(before)));
      } else {
        tree.now.set(p, null);
        tree.now.set(moveTo, linesToFile(f, fileBr(before)));
        tree.moves.push([p, moveTo]);
      }
    } else {
      tree.now.set(p, linesToFile(f, fileBr(before)));
    }
  };
}

// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  type Row = { key: string; text: string };
  const rows: Row[] = [];
  const dropped = new Set<string>();
  for (const [ol, nu] of tree.moves) {
    const oldWas = tree.original(ol);
    const oldNow = tree.now.get(ol);
    const newWas = tree.original(nu);
    const newNow = tree.now.get(nu);
    if (oldWas !== null && oldWas !== undefined && oldNow === null && newWas === null && newNow !== null && newNow !== undefined) {
      dropped.add(`D ${ol}`);
      dropped.add(`A ${nu}`);
      rows.push({ key: nu, text: `R ${ol} -> ${nu}` });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const text2 = `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`;
    if (dropped.has(text2)) continue;
    rows.push({ key: p, text: text2 });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (check) return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
