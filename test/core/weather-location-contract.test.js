'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('IP weather location uses HTTPS and maps the ipwho.is response shape', () => {
  assert.match(serverSource, /WEATHER_IP_LOCATION_URL = 'https:\/\/ipwho\.is\/'/);
  assert.doesNotMatch(serverSource, /http:\/\/ip-api\.com/);
  assert.match(
    serverSource,
    /success,message,country,region,city,latitude,longitude,timezone,ip/,
  );
  assert.match(serverSource, /provider: 'ipwho\.is'/);
  assert.match(serverSource, /latitude: Number\(body\.latitude\)/);
  assert.match(serverSource, /longitude: Number\(body\.longitude\)/);
  assert.match(serverSource, /ip: body\.ip \|\| ''/);
});
