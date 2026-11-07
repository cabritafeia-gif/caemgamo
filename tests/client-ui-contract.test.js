const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const community = fs.readFileSync(path.join(root, 'public', 'community-app.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('profile controls and account actions remain connected in the client', () => {
  for (const id of ['profile-button', 'rail-profile-button', 'rail-settings-button', 'profile-panel', 'sign-out-button']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(community, /\['profile-button', 'rail-profile-button', 'rail-settings-button'\]\) \$\(id\)\.addEventListener\('click', openAccount\)/);
  assert.match(community, /auth\.signOut\(\{ scope: 'local' \}\)/);
  assert.match(community, /state\.session = null;\s*await settleAuth\(\)/);
});

test('avatar controls have a visible fallback and refresh cached message profiles', () => {
  for (const id of ['profile-image', 'profile-initial', 'avatar-file']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(community, /image\.onerror = \(\) =>/);
  assert.match(community, /CAEMGAMO_REFRESH_AUTHOR\?\./);
  assert.match(app, /window\.CAEMGAMO_REFRESH_AUTHOR =/);
});

test('voice controls expose recovery for blocked playback and ICE reconnection', () => {
  assert.match(html, /id="enable-audio-button"/);
  assert.match(app, /enable-audio-button'\)\.addEventListener\('click', enableRemoteAudio\)/);
  assert.match(app, /NotAllowedError/);
  assert.match(app, /function scheduleIceRestart\(/);
  assert.match(app, /createOffer\(iceRestart \? \{ iceRestart: true \} : undefined\)/);
  assert.match(app, /type: 'media-state'/);
  assert.match(app, /data\.type === 'media-state'/);
});
