'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const qqVip = require('../../qq-vip-api');

function activeVipPayload(uin, expiresAt) {
  return {
    code: 0,
    req_1: {
      code: 0,
      data: {
        uin_map: {
          [String(uin)]: {
            vip_info: {
              is_vip: true,
              vip_type: 1,
              end_time: Math.floor(expiresAt / 1000),
            },
          },
        },
      },
    },
  };
}

function ordinaryPayload(uin) {
  return {
    code: 0,
    req_1: {
      code: 0,
      data: {
        uin_map: {
          [String(uin)]: {
            vip_info: {
              is_vip: false,
              vip_type: 0,
            },
          },
        },
      },
    },
  };
}

test('QQ membership normalization requires explicit account-scoped evidence', () => {
  const now = Date.now();
  const unknown = qqVip.normalizeQQVipPayload({ code: 0, data: {} });
  assert.equal(unknown.decision, 'unknown');
  assert.equal(unknown.resolved, false);

  const textOnly = qqVip.normalizeQQVipPayload({
    code: 0,
    data: { vip_info: { label: 'VIP', title: 'Green Diamond' } },
  });
  assert.equal(textOnly.decision, 'unknown');

  const ordinary = qqVip.normalizeQQVipPayload(ordinaryPayload('10001'));
  assert.equal(ordinary.decision, 'negative');
  assert.equal(ordinary.isVip, false);

  const active = qqVip.normalizeQQVipPayload(activeVipPayload('10001', now + 60 * 60 * 1000));
  assert.equal(active.decision, 'positive');
  assert.equal(active.isVip, true);
  assert.ok(active.expiresAt > now);

  const expired = qqVip.normalizeQQVipPayload(activeVipPayload('10001', now - 60 * 1000));
  assert.equal(expired.decision, 'negative');
  assert.equal(expired.isVip, false);
});

test('QQ membership probes preserve later positive evidence and require a negative quorum', async () => {
  const uin = '10002';
  const probes = [
    { source: 'first', responseKey: 'req_1', uin },
    { source: 'second', responseKey: 'req_1', uin },
    { source: 'third', responseKey: 'req_1', uin },
  ];
  const responses = [
    ordinaryPayload(uin),
    { code: 0, req_1: { code: 0, data: {} } },
    activeVipPayload(uin, Date.now() + 60 * 60 * 1000),
  ];
  let calls = 0;
  const resolved = await qqVip.resolveQQVipFromProbes(probes, async () => responses[calls++]);
  assert.equal(calls, 3);
  assert.equal(resolved.isVip, true);
  assert.equal(resolved.vipSource, 'third');

  const unattributedNegative = await qqVip.resolveQQVipFromProbes(
    [{ source: 'single', responseKey: 'req_1', uin }],
    async () => ({ code: 0, req_1: { code: 0, data: { vip_info: { is_vip: false, vip_type: 0 } } } }),
  );
  assert.equal(unattributedNegative.decision, 'unknown');

  const otherAccountPositive = await qqVip.resolveQQVipFromProbes(
    [{ source: 'other-user', responseKey: 'req_1', uin }],
    async () => activeVipPayload('99999', Date.now() + 60 * 60 * 1000),
  );
  assert.equal(otherAccountPositive.decision, 'unknown');

  const attributedNegative = await qqVip.resolveQQVipFromProbes(
    [{ source: 'attributed', responseKey: 'req_1', uin }],
    async () => ordinaryPayload(uin),
  );
  assert.equal(attributedNegative.decision, 'negative');
});

test('QQ membership cache keys are credential-scoped and expiry-bounded', () => {
  const cookieA = { login_type: '1', qm_keyst: 'ticket-A' };
  const cookieB = { login_type: '1', qm_keyst: 'ticket-B' };
  const keyA = qqVip.qqVipSessionCacheKey('10003', 'ticket-A', cookieA);
  assert.equal(keyA, qqVip.qqVipSessionCacheKey('10003', 'ticket-A', cookieA));
  assert.notEqual(keyA, qqVip.qqVipSessionCacheKey('10003', 'ticket-B', cookieB));
  assert.notEqual(keyA, qqVip.qqVipSessionCacheKey('10004', 'ticket-A', cookieA));
  assert.ok(!keyA.includes('ticket-A'));

  const now = Date.now();
  const ttl = qqVip.qqVipCacheTtlMs({
    resolved: true,
    membershipKnown: true,
    isVip: true,
    expiresAt: now + 2500,
  }, { now, positiveTtlMs: 120000 });
  assert.ok(ttl > 0 && ttl <= 2500);
  assert.equal(qqVip.qqVipCacheTtlMs({ resolved: false, membershipKnown: false }, { now }), 0);
});

test('QQ VIP module is included in the packaged application', () => {
  const root = path.resolve(__dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('qq-vip-api.js'));
});
