'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const ui = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const desktop = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('empty search queues start the selected song or podcast immediately', () => {
  const calls = [];
  const context = vm.createContext({
    currentIdx: -1,
    playQueue: [],
    playlist: [{ name: 'Song' }],
    podcastPrograms: [{ name: 'Podcast' }],
    playSearchResult(index) { calls.push(['play-song', index]); },
    playSearchSong(song) { calls.push(['play-podcast', song.name]); },
    queueSongNext(song) { calls.push(['queue-next', song.name]); },
    showToast(message) { calls.push(['toast', message]); },
  });
  vm.runInContext(
    sourceBetween(ui, 'function queuePodcastProgram', "$input.addEventListener('input'") +
      sourceBetween(ui, 'function queueSearchResult', 'function queueDetailSongNext'),
    context,
  );

  context.queueSearchResult(0);
  context.queuePodcastProgram(0);
  assert.deepEqual(calls, [
    ['play-song', 0],
    ['play-podcast', 'Podcast'],
  ]);
});

test('active queues preserve insert-next behavior', () => {
  const calls = [];
  const context = vm.createContext({
    currentIdx: 0,
    playQueue: [{ name: 'Current' }],
    playlist: [{ name: 'Song' }],
    podcastPrograms: [{ name: 'Podcast' }],
    playSearchResult() { calls.push(['unexpected-play']); },
    playSearchSong() { calls.push(['unexpected-podcast-play']); },
    queueSongNext(song) { calls.push(['queue-next', song.name]); },
    showToast(message) { calls.push(['toast', message]); },
  });
  vm.runInContext(
    sourceBetween(ui, 'function queuePodcastProgram', "$input.addEventListener('input'") +
      sourceBetween(ui, 'function queueSearchResult', 'function queueDetailSongNext'),
    context,
  );

  context.queueSearchResult(0);
  context.queuePodcastProgram(0);
  assert.deepEqual(calls, [
    ['queue-next', 'Song'],
    ['toast', '已设为下一首: Song'],
    ['queue-next', 'Podcast'],
    ['toast', '已设为下一首: Podcast'],
  ]);
});

test('song and podcast playback adapters use their own result objects', () => {
  const podcast = sourceBetween(ui, 'function playPodcastProgram', "$input.addEventListener('input'");
  const songs = sourceBetween(ui, 'function playSearchSong', 'var firstPlayDone');
  assert.match(podcast, /var item = podcastPrograms\[i\]/);
  assert.match(podcast, /playSearchSong\(item\)/);
  assert.match(songs, /function playSearchResult\(i\)[\s\S]*?var song = playlist\[i\][\s\S]*?playSearchSong\(song\)/);
});

test('active account provider preference is versioned, validated, and persisted', () => {
  const stored = new Map([['mineradio-active-account-provider-v1', 'spotify']]);
  const context = vm.createContext({
    localStorage: {
      getItem(key) { return stored.get(key) || null; },
      setItem(key, value) { stored.set(key, value); },
    },
  });
  const declarations = sourceBetween(
    ui,
    "var ACTIVE_ACCOUNT_PROVIDER_STORE_KEY",
    'var qqCookieBusy',
  );
  vm.runInContext(
    declarations +
      '; this.accountApi = {' +
      'loadActiveAccountProviderPreference,' +
      'rememberActiveAccountProvider,' +
      'get active(){ return activeAccountProvider; },' +
      'get preferred(){ return preferredAccountProvider; }' +
      '};',
    context,
  );

  assert.equal(context.accountApi.active, 'spotify');
  context.accountApi.rememberActiveAccountProvider('qq');
  assert.equal(context.accountApi.active, 'qq');
  assert.equal(context.accountApi.preferred, 'qq');
  assert.equal(stored.get('mineradio-active-account-provider-v1'), 'qq');
  context.accountApi.rememberActiveAccountProvider('invalid');
  assert.equal(stored.get('mineradio-active-account-provider-v1'), 'netease');

  const providerSelection = sourceBetween(ui, 'function firstLoggedProvider', 'function providerAvatarSrc');
  const setter = sourceBetween(ui, 'function setActiveAccountProvider', 'function openProviderLogin');
  assert.match(providerSelection, /hasPlatformLogin\(preferredAccountProvider\)/);
  assert.match(setter, /rememberActiveAccountProvider\(provider\)/);
});

test('desktop lyrics abnormal close stops the mouse poller', () => {
  const handler = desktop.match(/desktopLyricsWindow\.on\('closed', \(\) => \{([\s\S]*?)\n  \}\);/);
  assert.ok(handler, 'desktop lyrics closed handler should exist');
  assert.match(handler[1], /stopDesktopLyricsMousePoller\(\)/);
});
