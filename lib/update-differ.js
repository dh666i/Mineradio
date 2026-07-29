'use strict';

// 安装包差量更新核心 (纯逻辑, 不做网络与磁盘 IO)。
//
// electron-builder 每次构建都会为安装包生成 .blockmap: 按内容切块并记录每块的
// SHA256 与大小。差量更新 = 对比新旧两份 blockmap, 新包里已存在于旧包的块直接
// 从本地旧安装包复制, 只有变化的块用 HTTP Range 从服务器拉取, 最后拼装出与
// 整包字节一致的新安装包 (由调用方用 latest.yml 的 sha512 做最终校验)。
//
// 本模块只负责三件事:
//   1. parseBlockMapBuffer  解析 (gzip 或明文 JSON 的) blockmap
//   2. planDifferentialAssembly  规划复制/拉取操作序列与收益评估
//   3. describeDifferentialPlan  给日志与 UI 的摘要
//
// 安全性依赖两道闸: 复制块逐块校验 SHA256, 拼装结果整体校验 sha512;
// 任何一步不满足, 调用方回退整包下载即可, 不会比差量出现前更糟。

const zlib = require('zlib');
const crypto = require('crypto');

// ---------------------------------------------------------------
// BLAKE2b (RFC 7693) 纯 JS 实现, 支持任意输出长度 1-64 字节。
// electron-builder 的 blockmap 块校验和是 blake2b(digest=18 字节) 的
// 无填充 base64 (24 字符); BLAKE2b 把输出长度编入参数块, 不能用
// Node 内置 blake2b512 截断代替, 因此需要本实现。
// 参考 RFC 7693 与公有领域的 blakejs 参考实现移植。
// ---------------------------------------------------------------
const BLAKE2B_IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85,
  0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
  0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);
const BLAKE2B_SIGMA8 = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
];
const BLAKE2B_SIGMA82 = new Uint8Array(BLAKE2B_SIGMA8.map(x => x * 2));
const b2bV = new Uint32Array(32);
const b2bM = new Uint32Array(32);
function b2bAdd64AA(v, a, b) {
  const o0 = v[a] + v[b];
  let o1 = v[a + 1] + v[b + 1];
  if (o0 >= 0x100000000) o1++;
  v[a] = o0;
  v[a + 1] = o1;
}
function b2bAdd64AC(v, a, b0, b1) {
  let o0 = v[a] + b0;
  if (b0 < 0) o0 += 0x100000000;
  let o1 = v[a + 1] + b1;
  if (o0 >= 0x100000000) o1++;
  v[a] = o0;
  v[a + 1] = o1;
}
function b2bGet32(arr, i) {
  return arr[i] ^ (arr[i + 1] << 8) ^ (arr[i + 2] << 16) ^ (arr[i + 3] << 24);
}
function b2bG(a, b, c, d, ix, iy) {
  const x0 = b2bM[ix];
  const x1 = b2bM[ix + 1];
  const y0 = b2bM[iy];
  const y1 = b2bM[iy + 1];
  b2bAdd64AA(b2bV, a, b);
  b2bAdd64AC(b2bV, a, x0, x1);
  let xor0 = b2bV[d] ^ b2bV[a];
  let xor1 = b2bV[d + 1] ^ b2bV[a + 1];
  b2bV[d] = xor1;
  b2bV[d + 1] = xor0;
  b2bAdd64AA(b2bV, c, d);
  xor0 = b2bV[b] ^ b2bV[c];
  xor1 = b2bV[b + 1] ^ b2bV[c + 1];
  b2bV[b] = (xor0 >>> 24) ^ (xor1 << 8);
  b2bV[b + 1] = (xor1 >>> 24) ^ (xor0 << 8);
  b2bAdd64AA(b2bV, a, b);
  b2bAdd64AC(b2bV, a, y0, y1);
  xor0 = b2bV[d] ^ b2bV[a];
  xor1 = b2bV[d + 1] ^ b2bV[a + 1];
  b2bV[d] = (xor0 >>> 16) ^ (xor1 << 16);
  b2bV[d + 1] = (xor1 >>> 16) ^ (xor0 << 16);
  b2bAdd64AA(b2bV, c, d);
  xor0 = b2bV[b] ^ b2bV[c];
  xor1 = b2bV[b + 1] ^ b2bV[c + 1];
  b2bV[b] = (xor1 >>> 31) ^ (xor0 << 1);
  b2bV[b + 1] = (xor0 >>> 31) ^ (xor1 << 1);
}
function blake2bCompress(ctx, last) {
  let i = 0;
  for (i = 0; i < 16; i++) {
    b2bV[i] = ctx.h[i];
    b2bV[i + 16] = BLAKE2B_IV32[i];
  }
  b2bV[24] = b2bV[24] ^ ctx.t;
  b2bV[25] = b2bV[25] ^ (ctx.t / 0x100000000);
  if (last) {
    b2bV[28] = ~b2bV[28];
    b2bV[29] = ~b2bV[29];
  }
  for (i = 0; i < 32; i++) b2bM[i] = b2bGet32(ctx.b, 4 * i);
  for (i = 0; i < 12; i++) {
    b2bG(0, 8, 16, 24, BLAKE2B_SIGMA82[i * 16 + 0], BLAKE2B_SIGMA82[i * 16 + 1]);
    b2bG(2, 10, 18, 26, BLAKE2B_SIGMA82[i * 16 + 2], BLAKE2B_SIGMA82[i * 16 + 3]);
    b2bG(4, 12, 20, 28, BLAKE2B_SIGMA82[i * 16 + 4], BLAKE2B_SIGMA82[i * 16 + 5]);
    b2bG(6, 14, 22, 30, BLAKE2B_SIGMA82[i * 16 + 6], BLAKE2B_SIGMA82[i * 16 + 7]);
    b2bG(0, 10, 20, 30, BLAKE2B_SIGMA82[i * 16 + 8], BLAKE2B_SIGMA82[i * 16 + 9]);
    b2bG(2, 12, 22, 24, BLAKE2B_SIGMA82[i * 16 + 10], BLAKE2B_SIGMA82[i * 16 + 11]);
    b2bG(4, 14, 16, 26, BLAKE2B_SIGMA82[i * 16 + 12], BLAKE2B_SIGMA82[i * 16 + 13]);
    b2bG(6, 8, 18, 28, BLAKE2B_SIGMA82[i * 16 + 14], BLAKE2B_SIGMA82[i * 16 + 15]);
  }
  for (i = 0; i < 16; i++) ctx.h[i] = ctx.h[i] ^ b2bV[i] ^ b2bV[i + 16];
}
function blake2b(input, outlen) {
  outlen = outlen || 64;
  if (!(outlen > 0 && outlen <= 64)) throw new Error('BLAKE2B_OUTLEN_INVALID');
  const ctx = {
    b: new Uint8Array(128),
    h: new Uint32Array(16),
    t: 0,
    c: 0,
    outlen,
  };
  for (let i = 0; i < 16; i++) ctx.h[i] = BLAKE2B_IV32[i];
  ctx.h[0] ^= 0x01010000 ^ outlen;
  for (let i = 0; i < input.length; i++) {
    if (ctx.c === 128) {
      ctx.t += ctx.c;
      blake2bCompress(ctx, false);
      ctx.c = 0;
    }
    ctx.b[ctx.c++] = input[i];
  }
  ctx.t += ctx.c;
  while (ctx.c < 128) ctx.b[ctx.c++] = 0;
  blake2bCompress(ctx, true);
  const out = Buffer.alloc(outlen);
  for (let i = 0; i < outlen; i++) out[i] = ctx.h[i >> 2] >> (8 * (i & 3));
  return out;
}

const DEFAULT_GAP_BYTES = 256 * 1024;      // 相邻拉取段之间的小间隙直接并入网络段, 减少请求数
const DEFAULT_MAX_FETCH_RATIO = 0.8;       // 需要拉取的字节超过全量的 80% 时差量不划算

function isGzipBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

// 返回 { blocks: [{ checksum, size, offset }], totalSize }
function parseBlockMapBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('BLOCKMAP_EMPTY');
  }
  let text;
  try {
    text = (isGzipBuffer(buffer) ? zlib.gunzipSync(buffer) : buffer).toString('utf8');
  } catch (e) {
    throw new Error('BLOCKMAP_GUNZIP_FAILED');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('BLOCKMAP_JSON_INVALID');
  }
  const files = Array.isArray(data && data.files) ? data.files : [];
  if (!files.length) throw new Error('BLOCKMAP_FILES_MISSING');
  const blocks = [];
  let totalSize = 0;
  for (const file of files) {
    const checksums = Array.isArray(file && file.checksums) ? file.checksums : [];
    const sizes = Array.isArray(file && file.sizes) ? file.sizes : [];
    if (!checksums.length || checksums.length !== sizes.length) {
      throw new Error('BLOCKMAP_FILE_SHAPE_INVALID');
    }
    let offset = Number(file.offset) || 0;
    for (let i = 0; i < checksums.length; i++) {
      const size = Number(sizes[i]) || 0;
      const checksum = String(checksums[i] || '');
      if (!checksum || size <= 0) throw new Error('BLOCKMAP_BLOCK_INVALID');
      blocks.push({ checksum, size, offset });
      offset += size;
    }
    totalSize = Math.max(totalSize, offset);
  }
  return { blocks, totalSize };
}

function indexBlocksByChecksum(blocks) {
  const index = new Map();
  for (const block of blocks) {
    const key = block.checksum + '@' + block.size;
    if (!index.has(key)) index.set(key, block);
  }
  return index;
}

// 规划拼装操作。返回:
//   {
//     ops: [ { type:'copy', offset, size, oldOffset, checksum }
//          | { type:'fetch', offset, size } ],   // fetch 已按相邻/小间隙合并
//     totalBytes, fetchBytes, copyBytes, fetchRatio, fetchOps, copyOps
//   }
// 拉取占比超过 maxFetchRatio 时返回 null (调用方走整包下载)。
function planDifferentialAssembly(oldMap, newMap, opts) {
  opts = opts || {};
  const gapBytes = Number.isFinite(opts.gapBytes) ? Math.max(0, opts.gapBytes) : DEFAULT_GAP_BYTES;
  const maxFetchRatio = Number.isFinite(opts.maxFetchRatio) ? opts.maxFetchRatio : DEFAULT_MAX_FETCH_RATIO;
  const oldBlocks = oldMap && Array.isArray(oldMap.blocks) ? oldMap.blocks : [];
  const newBlocks = newMap && Array.isArray(newMap.blocks) ? newMap.blocks : [];
  if (!newBlocks.length) return null;

  const oldIndex = indexBlocksByChecksum(oldBlocks);

  // 第一遍: 每个新块标记来源。
  const sources = newBlocks.map((block) => {
    const match = oldIndex.get(block.checksum + '@' + block.size);
    return match ? { fetch: false, oldOffset: match.offset } : { fetch: true, oldOffset: -1 };
  });

  // 第二遍: 位于两个网络段之间、总大小不超过 gapBytes 的本地复制小段,
  // 直接并入网络段 (内容一致, 最终 sha512 仍然把关), 大幅减少 Range 请求数。
  if (gapBytes > 0) {
    let i = 0;
    while (i < newBlocks.length) {
      if (!sources[i].fetch) { i += 1; continue; }
      // 找到当前 fetch 段结尾
      let end = i;
      while (end + 1 < newBlocks.length && sources[end + 1].fetch) end += 1;
      // 看下一个 copy 段是否是被 fetch 段夹着的小间隙
      let gapStart = end + 1;
      let gapEnd = gapStart;
      let gapSize = 0;
      while (gapEnd < newBlocks.length && !sources[gapEnd].fetch) {
        gapSize += newBlocks[gapEnd].size;
        gapEnd += 1;
      }
      if (gapStart < newBlocks.length && gapEnd < newBlocks.length && gapSize <= gapBytes) {
        for (let j = gapStart; j < gapEnd; j++) sources[j] = { fetch: true, oldOffset: -1 };
        i = end + 1; // 重新扫描合并后的段
      } else {
        i = gapEnd;
      }
    }
  }

  // 第三遍: 生成操作序列, 相邻 fetch 合并为单个 Range 段。
  const ops = [];
  let totalBytes = 0;
  let fetchBytes = 0;
  let copyBytes = 0;
  for (let i = 0; i < newBlocks.length; i++) {
    const block = newBlocks[i];
    const source = sources[i];
    if (source.fetch) {
      const last = ops[ops.length - 1];
      if (last && last.type === 'fetch' && last.offset + last.size === block.offset) {
        last.size += block.size;
      } else {
        ops.push({ type: 'fetch', offset: block.offset, size: block.size });
      }
      fetchBytes += block.size;
    } else {
      ops.push({
        type: 'copy',
        offset: block.offset,
        size: block.size,
        oldOffset: source.oldOffset,
        checksum: block.checksum,
      });
      copyBytes += block.size;
    }
    totalBytes += block.size;
  }

  if (!totalBytes) return null;
  const fetchRatio = fetchBytes / totalBytes;
  if (fetchRatio > maxFetchRatio) return null;

  return {
    ops,
    totalBytes,
    fetchBytes,
    copyBytes,
    fetchRatio,
    fetchOps: ops.filter(op => op.type === 'fetch').length,
    copyOps: ops.filter(op => op.type === 'copy').length,
  };
}

// 按校验和的字节长度自动识别算法:
//   32 字节 → sha256 (本仓库测试与部分工具)
//   1-64 字节其它长度 → blake2b 定制输出长度 (electron-builder blockmap, 实际为 18)
// 无法识别时返回 true, 由最终 sha512 终检兜底。
function verifyCopiedBlock(buffer, checksum) {
  const raw = String(checksum || '');
  let decoded;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch (_) {
    return true;
  }
  if (!decoded.length || decoded.length > 64) return true;
  if (Buffer.from(decoded.toString('base64'), 'base64').length !== decoded.length) return true;
  const digest = decoded.length === 32
    ? crypto.createHash('sha256').update(buffer).digest()
    : blake2b(buffer, decoded.length);
  return digest.equals(decoded);
}

function describeDifferentialPlan(plan) {
  if (!plan) return 'no-plan';
  const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  return `fetch ${mb(plan.fetchBytes)} (${Math.round(plan.fetchRatio * 100)}%) in ${plan.fetchOps} range(s), reuse ${mb(plan.copyBytes)} from local installer`;
}

module.exports = {
  DEFAULT_GAP_BYTES,
  DEFAULT_MAX_FETCH_RATIO,
  blake2b,
  parseBlockMapBuffer,
  planDifferentialAssembly,
  verifyCopiedBlock,
  describeDifferentialPlan,
};
