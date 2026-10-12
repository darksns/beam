/* sessionOf: an unnamed command from a Claude or Cursor chat must not fall
   through to the shared "default" window. */
const { sessionOf } = require('../bin/session-name');

let fail = 0;
const ok = (name, cond) => {
  if (!cond) fail++;
  console.log((cond ? '✓ ' : '✗ ') + name);
};

const CLAUDE = '11111111-1111-4111-8111-111111111111';
const CURSOR = '22222222-2222-4222-8222-222222222222';

ok('plain terminal shares default', sessionOf(undefined, {}) === 'default');
ok('empty BEAM_SESSION shares default', sessionOf(undefined, { BEAM_SESSION: '' }) === 'default');

ok('BEAM_SESSION names the window', sessionOf(undefined, { BEAM_SESSION: 'pages' }) === 'pages');
ok('--session wins over BEAM_SESSION', sessionOf('other', { BEAM_SESSION: 'pages' }) === 'other');
ok('--session default forces the shared window',
  sessionOf('default', { CLAUDE_CODE_SESSION_ID: CLAUDE }) === 'default');

ok('claude chat id is the session',
  sessionOf(undefined, { CLAUDE_CODE_SESSION_ID: CLAUDE }) === CLAUDE);
ok('BEAM_SESSION wins over the claude chat',
  sessionOf(undefined, { BEAM_SESSION: 'pages', CLAUDE_CODE_SESSION_ID: CLAUDE }) === 'pages');
ok('cursor chat id is the session',
  sessionOf(undefined, { CURSOR_CONVERSATION_ID: CURSOR }) === CURSOR);
ok('claude id wins when both chats are set',
  sessionOf(undefined, { CLAUDE_CODE_SESSION_ID: CLAUDE, CURSOR_CONVERSATION_ID: CURSOR }) === CLAUDE);

ok('a dirty chat id is trimmed to a legal name',
  sessionOf(undefined, { CLAUDE_CODE_SESSION_ID: 'abc/def ghi' }) === 'abcdefghi');
ok('a chat id with no legal characters falls back to default',
  sessionOf(undefined, { CLAUDE_CODE_SESSION_ID: '///' }) === 'default');
ok('a chat id longer than 40 characters is cut',
  sessionOf(undefined, { CLAUDE_CODE_SESSION_ID: 'a'.repeat(50) }) === 'a'.repeat(40));

let threw = false;
try { sessionOf('has space', {}); } catch (e) { threw = /invalid session name/.test(e.message); }
ok('an illegal explicit name throws', threw);

threw = false;
try { sessionOf(true, {}); } catch (e) { threw = /invalid session name/.test(e.message); }
ok('a bare --session throws', threw);

process.exit(fail ? 1 : 0);
