const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const community = fs.readFileSync(path.join(root, 'public', 'community-app.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const socialMigration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '202611070003_caemgamo_social.sql'), 'utf8');
const socialDbTest = fs.readFileSync(path.join(root, 'supabase', 'tests', 'social_permissions.test.sql'), 'utf8');

test('profile controls and account actions remain connected in the client', () => {
  for (const id of ['profile-button', 'rail-profile-button', 'rail-settings-button', 'profile-panel', 'sign-out-button']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(community, /\['profile-button', 'rail-profile-button', 'rail-settings-button'\]\) \$\(id\)\.addEventListener\('click', openAccount\)/);
  assert.match(community, /auth\.signOut\(\{ scope: 'local' \}\)/);
  assert.match(community, /state\.session = null;\s*await settleAuth\(\)/);
  const logout = community.slice(community.indexOf("$('sign-out-button').addEventListener"), community.indexOf("$('create-community-button').addEventListener"));
  assert.match(logout, /openAccount\(\);\s*closeSocialViews\(\);\s*status\('Você saiu da conta\.'\)/);
  assert.doesNotMatch(logout, /\$\('account-dialog'\)\.hidden = true/);
  assert.match(community, /window\.CAEMGAMO_OPEN_ACCOUNT = openAccount/);
  assert.match(community, /window\.CAEMGAMO_ROOM_AUTH_CHANGED\?\.\(false\)/);
  assert.match(app, /Entre na sua conta para acessar a sala/);
  assert.match(app, /type: 'auth-refresh'/);
  assert.match(app, /if \(!ws \|\| ws\.readyState >= WebSocket\.CLOSING\) connect\(\)/);
  assert.match(html, /name="username" minlength="3" maxlength="32"/);
  assert.match(community, /update\(\{ display_name, username \}\)/);
  assert.match(community, /window\.CAEMGAMO_ROOM_AUTH_CHANGED\?\.\(true\)/);
});

test('avatar controls have a visible fallback and refresh cached message profiles', () => {
  for (const id of ['profile-image', 'profile-initial', 'avatar-file', 'remove-avatar-button']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(community, /image\.onerror = \(\) =>/);
  assert.match(community, /CAEMGAMO_REFRESH_AUTHOR\?\./);
  assert.match(app, /window\.CAEMGAMO_REFRESH_AUTHOR =/);
  assert.match(community, /async function removeAvatar\(\)/);
  assert.match(community, /update\(\{ avatar_path: null \}\)/);
});

test('voice controls expose recovery for blocked playback and ICE reconnection', () => {
  assert.match(html, /id="enable-audio-button"/);
  assert.match(app, /enable-audio-button'\)\.addEventListener\('click', enableRemoteAudio\)/);
  assert.match(app, /NotAllowedError/);
  assert.match(app, /function scheduleIceRestart\(/);
  assert.match(app, /createOffer\(iceRestart \? \{ iceRestart: true \} : undefined\)/);
  assert.match(app, /type: 'media-state'/);
  assert.match(app, /data\.type === 'media-state'/);
  assert.match(app, /setAttribute\('aria-pressed', String\(active\)\)/);
});

test('account settings expose working device tests and stop media on logout', () => {
  for (const id of ['settings-theme-select', 'audio-input-select', 'audio-output-select', 'video-input-select', 'test-microphone-button', 'test-speaker-button', 'preview-camera-button', 'desktop-notifications-toggle', 'allow-friend-requests']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /navigator\.mediaDevices\.enumerateDevices\(\)/);
  assert.match(app, /getUserMedia\(\{ audio: audioConstraints\(\) \}\)/);
  assert.match(app, /function endCurrentCall\(\)/);
  assert.match(app, /window\.CAEMGAMO_END_CALL = endCurrentCall/);
  assert.match(community, /window\.CAEMGAMO_END_CALL\?\.\(\)/);
  assert.match(html, /id="rejoin-button"/);
  assert.match(app, /window\.CAEMGAMO_RECONNECT_CALL = reconnectToRoom/);
  assert.match(community, /allow_friend_requests: Boolean\(enabled\)/);
  assert.match(community, /document\.querySelectorAll\('\[data-community-button\]'\)\.forEach\(\(button\) => button\.remove\(\)\)/);
});

test('friend requests and direct messages are backed by isolated database policies', () => {
  for (const id of ['nav-friends', 'nav-messages', 'friends-dialog', 'messages-dialog', 'friend-search-form', 'direct-message-form']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const rpc of ['find_profile_by_username', 'send_friend_request', 'respond_friend_request', 'remove_friend', 'open_direct_conversation']) {
    assert.match(community, new RegExp(`rpc\\('${rpc}'`));
    assert.match(socialMigration, new RegExp(`function public\\.${rpc}\\(`));
  }
  assert.match(socialMigration, /alter table public\.direct_messages enable row level security/);
  assert.match(socialMigration, /direct_messages_insert_author/);
  assert.match(socialMigration, /p\.allow_friend_requests/);
  assert.match(socialMigration, /friend requests disabled/);
  assert.match(socialMigration, /grant update \(allow_friend_requests\) on public\.profiles to authenticated/);
  assert.match(socialMigration, /grant select on public\.friend_requests, public\.friendships, public\.direct_conversations to authenticated/);
  assert.match(socialDbTest, /unrelated user cannot read a private conversation/);
  assert.match(socialDbTest, /unrelated user cannot send a message into a private conversation/);
  assert.match(socialDbTest, /backend blocks requests when the recipient disabled them/);
  assert.match(socialDbTest, /user can update their own profile/);
});
