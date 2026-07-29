'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  importKugouPublicPlaylist,
  importQishuiPublicPlaylist,
  parseKugouShareInput,
  parseDirectReference,
} = require('../../lib/shared-playlist-resolver');

function mockResponse(body, options = {}) {
  return {
    status: options.status == null ? 200 : options.status,
    url: options.url || '',
    headers: {
      get(name) {
        return String(name || '').toLowerCase() === 'location' ? (options.location || '') : '';
      },
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

test('Kugou gcid links decode and return normalized public tracks', async () => {
  const calls = [];
  const result = await importKugouPublicPlaylist(
    'https://m.kugou.com/songlist/gcid_3z106tadezl7z03a/?src_cid=3z106tadezl7z03a',
    {
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.includes('/batch_decode?')) {
          return mockResponse({
            status: 1,
            data: { list: [{ global_collection_id: 'collection-demo' }] },
          });
        }
        if (url.includes('/special/info_v2?')) {
          return mockResponse({
            status: 1,
            data: {
              specialname: '公开酷狗歌单',
              songcount: 2,
              imgurl: 'https://img.example/{size}/cover.jpg',
              nickname: '测试用户',
            },
          });
        }
        if (url.includes('/special/song_v2?')) {
          return mockResponse({
            status: 1,
            data: {
              info: [
                {
                  hash: 'HASH-A',
                  name: '歌手甲 - 歌曲甲',
                  singername: '歌手甲',
                  album_name: '专辑甲',
                  duration: 215,
                  cover: 'https://img.example/{size}/a.jpg',
                },
                {
                  mixsongid: '9002',
                  songname: '歌曲乙',
                  singername: '歌手乙',
                  duration: 180,
                },
              ],
            },
          });
        }
        throw new Error('Unexpected URL: ' + url);
      },
    },
  );

  assert.equal(result.provider, 'kugou');
  assert.equal(result.id, 'collection-demo');
  assert.equal(result.playlist.name, '公开酷狗歌单');
  assert.equal(result.tracks.length, 2);
  assert.deepEqual(
    result.tracks.map(track => [track.provider, track.name, track.artist]),
    [
      ['kugou', '歌曲甲', '歌手甲'],
      ['kugou', '歌曲乙', '歌手乙'],
    ],
  );
  assert.equal(result.tracks[0].duration, 215000);
  assert.ok(calls.some(url => url.includes('/batch_decode?')));
  assert.ok(calls.some(url => url.includes('/special/song_v2?')));
});

test('Kugou direct references preserve existing UI ids and specialid semantics', async () => {
  assert.deepEqual(
    parseKugouShareInput('kugou:123456'),
    {
      sourceUrl: '',
      gcid: '',
      globalCollectionId: '',
      specialId: '123456',
      uid: '',
      cover: '',
    },
  );
  assert.equal(parseKugouShareInput('kugou:gcid_demo123').gcid, 'demo123');
  assert.equal(parseKugouShareInput('kugou:collection_demo').globalCollectionId, 'collection_demo');

  const result = await importKugouPublicPlaylist('kugou:123456', {
    fetchImpl: async (url) => {
      if (url.includes('/special/info_v2?')) {
        return mockResponse({ status: 1, data: { specialname: 'Special 歌单', songcount: 1 } });
      }
      if (url.includes('/special/song_v2?')) {
        return mockResponse({
          status: 1,
          data: { info: [{ hash: 'SPECIAL-HASH', songname: 'Special Song', singername: 'Singer' }] },
        });
      }
      throw new Error('Unexpected URL: ' + url);
    },
  });
  assert.equal(result.id, 'special_123456');
  assert.equal(result.tracks[0].hash, 'SPECIAL-HASH');
});

test('Qishui short links follow same-provider redirects and parse public rows', async () => {
  const html = [
    '<!doctype html><html><head>',
    '<meta property="og:title" content="汽水公开歌单">',
    '<meta property="og:image" content="https://img.example/qishui.jpg">',
    '</head><body><div>共 2 首</div>',
    '<div style="padding-top:14px;padding-bottom:14px;"><p>歌曲一</p><p>歌手一 · 专辑一</p></div>',
    '<div style="padding-top:14px;padding-bottom:14px;"><p>歌曲二</p><p>歌手二</p></div>',
    '</body></html>',
  ].join('');
  const calls = [];
  const result = await importQishuiPublicPlaylist('https://qishui.douyin.com/s/demo/', {
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === 'https://qishui.douyin.com/s/demo/') {
        return mockResponse('', {
          status: 302,
          location: 'https://music.douyin.com/qishui/share/playlist?playlist_id=987654321',
        });
      }
      return mockResponse(html, { url });
    },
  });

  assert.equal(result.provider, 'qishui');
  assert.equal(result.id, '987654321');
  assert.equal(result.playlist.name, '汽水公开歌单');
  assert.equal(result.tracks.length, 2);
  assert.deepEqual(
    result.tracks.map(track => [track.provider, track.name, track.artist, track.album]),
    [
      ['qishui', '歌曲一', '歌手一', '专辑一'],
      ['qishui', '歌曲二', '歌手二', ''],
    ],
  );
  assert.equal(result.tracks[0].playbackFallbackOnly, true);
  assert.equal(calls.length, 2);
});

test('Apple Music, YouTube and local paths remain outside shared imports', () => {
  assert.equal(parseDirectReference('https://music.apple.com/cn/playlist/pl.demo'), null);
  assert.equal(parseDirectReference('https://youtube.com/playlist?list=demo'), null);
  assert.equal(parseDirectReference('C:\\Music\\playlist.m3u'), null);
});
