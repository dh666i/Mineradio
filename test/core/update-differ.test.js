'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const differ = require('../../lib/update-differ');

function makeBlock(size, seed) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (seed * 31 + i * 7) & 0xff;
  return buf;
}
function checksumOf(buf) {
  return crypto.createHash('sha256').update(buf).digest('base64');
}
function mapFromBuffers(buffers, opts) {
  opts = opts || {};
  const json = {
    version: '2',
    files: [{
      name: 'file',
      offset: opts.offset || 0,
      checksums: buffers.map(checksumOf),
      sizes: buffers.map(buf => buf.length),
    }],
  };
  const raw = Buffer.from(JSON.stringify(json), 'utf8');
  return opts.gzip === false ? raw : zlib.gzipSync(raw);
}

test('parseBlockMapBuffer handles gzip and plain JSON with accumulated offsets', () => {
  const blocks = [makeBlock(64, 1), makeBlock(32, 2), makeBlock(80, 3)];
  const gz = differ.parseBlockMapBuffer(mapFromBuffers(blocks));
  const plain = differ.parseBlockMapBuffer(mapFromBuffers(blocks, { gzip: false }));
  assert.equal(gz.totalSize, 176);
  assert.deepEqual(gz.blocks.map(b => b.offset), [0, 64, 96]);
  assert.deepEqual(plain.blocks.map(b => b.size), [64, 32, 80]);
  const offsetMap = differ.parseBlockMapBuffer(mapFromBuffers(blocks, { offset: 100 }));
  assert.deepEqual(offsetMap.blocks.map(b => b.offset), [100, 164, 196]);
  assert.equal(offsetMap.totalSize, 276);
});

test('identical maps plan to pure local copy with zero fetch bytes', () => {
  const blocks = [makeBlock(64, 1), makeBlock(64, 2), makeBlock(64, 3)];
  const map = differ.parseBlockMapBuffer(mapFromBuffers(blocks));
  const plan = differ.planDifferentialAssembly(map, map, { gapBytes: 0 });
  assert.ok(plan);
  assert.equal(plan.fetchBytes, 0);
  assert.equal(plan.copyBytes, 192);
  assert.equal(plan.ops.every(op => op.type === 'copy'), true);
});

test('changed and inserted blocks become merged fetch spans, shifted blocks still copy', () => {
  const a = makeBlock(64, 1);
  const b = makeBlock(64, 2);
  const c = makeBlock(64, 3);
  const d = makeBlock(64, 4);
  const oldMap = differ.parseBlockMapBuffer(mapFromBuffers([a, b, c, d]));
  const bNew = makeBlock(64, 20);
  const inserted = makeBlock(48, 21);
  // 新文件: a, bNew, inserted, c, d  → c/d 整体后移仍可从旧文件复制
  const newMap = differ.parseBlockMapBuffer(mapFromBuffers([a, bNew, inserted, c, d]));
  const plan = differ.planDifferentialAssembly(oldMap, newMap, { gapBytes: 0 });
  assert.ok(plan);
  assert.equal(plan.fetchBytes, 64 + 48);
  const fetchOps = plan.ops.filter(op => op.type === 'fetch');
  assert.equal(fetchOps.length, 1, 'adjacent changed blocks merge into one range');
  assert.equal(fetchOps[0].offset, 64);
  assert.equal(fetchOps[0].size, 112);
  const copies = plan.ops.filter(op => op.type === 'copy');
  assert.deepEqual(copies.map(op => op.oldOffset), [0, 128, 192], 'shifted blocks copy from their old offsets');
});

test('small copy gaps between fetch spans are absorbed to reduce range requests', () => {
  const blocks = [1, 2, 3, 4, 5].map(seed => makeBlock(64, seed));
  const oldMap = differ.parseBlockMapBuffer(mapFromBuffers(blocks));
  const changed1 = makeBlock(64, 30);
  const changed3 = makeBlock(64, 31);
  const newBlocks = [blocks[0], changed1, blocks[2], changed3, blocks[4]];
  const newMap = differ.parseBlockMapBuffer(mapFromBuffers(newBlocks));

  const merged = differ.planDifferentialAssembly(oldMap, newMap, { gapBytes: 64, maxFetchRatio: 1 });
  assert.equal(merged.ops.filter(op => op.type === 'fetch').length, 1, 'gap block joins the range');
  assert.equal(merged.fetchBytes, 192);

  const unmerged = differ.planDifferentialAssembly(oldMap, newMap, { gapBytes: 0, maxFetchRatio: 1 });
  assert.equal(unmerged.ops.filter(op => op.type === 'fetch').length, 2, 'no merging with zero gap');
  assert.equal(unmerged.fetchBytes, 128);
});

test('plans that would fetch nearly everything are rejected', () => {
  const oldMap = differ.parseBlockMapBuffer(mapFromBuffers([makeBlock(64, 1)]));
  const newMap = differ.parseBlockMapBuffer(mapFromBuffers([makeBlock(64, 9), makeBlock(64, 8)]));
  assert.equal(differ.planDifferentialAssembly(oldMap, newMap, { maxFetchRatio: 0.8 }), null);
  assert.ok(differ.planDifferentialAssembly(oldMap, newMap, { maxFetchRatio: 1 }));
});

test('verifyCopiedBlock detects corrupted local blocks', () => {
  const block = makeBlock(128, 7);
  assert.equal(differ.verifyCopiedBlock(block, checksumOf(block)), true);
  const corrupted = Buffer.from(block);
  corrupted[10] ^= 0xff;
  assert.equal(differ.verifyCopiedBlock(corrupted, checksumOf(block)), false);
});

test('blake2b matches RFC 7693 vectors and electron-builder 18-byte checksums verify', () => {
  // RFC 7693 附录 A 标准向量
  assert.equal(
    differ.blake2b(Buffer.from('abc'), 64).toString('hex'),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923'
  );
  assert.equal(
    differ.blake2b(Buffer.alloc(0), 64).toString('hex'),
    '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce'
  );
  // 18 字节输出 (electron-builder blockmap 格式, 已用真实 1.5.4/1.5.5 blockmap 全量核对)
  assert.equal(differ.blake2b(Buffer.from('abc'), 18).toString('base64'), 'F0ind9hBQXGzo0cA3QN9lVr1');
  const block = makeBlock(200, 9);
  const checksum18 = differ.blake2b(block, 18).toString('base64');
  assert.equal(checksum18.length, 24);
  assert.equal(differ.verifyCopiedBlock(block, checksum18), true);
  const corrupted = Buffer.from(block);
  corrupted[0] ^= 0x01;
  assert.equal(differ.verifyCopiedBlock(corrupted, checksum18), false);
});

test('malformed blockmaps are rejected with clear errors', () => {
  assert.throws(() => differ.parseBlockMapBuffer(Buffer.alloc(0)), /BLOCKMAP_EMPTY/);
  assert.throws(() => differ.parseBlockMapBuffer(Buffer.from('not json')), /BLOCKMAP_JSON_INVALID/);
  assert.throws(
    () => differ.parseBlockMapBuffer(Buffer.from(JSON.stringify({ files: [{ checksums: ['a'], sizes: [] }] }))),
    /BLOCKMAP_FILE_SHAPE_INVALID/
  );
});
