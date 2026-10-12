'use strict';

/* Names the extension accepts. A chat id that does not fit is dropped,
   never thrown: the person did not type it. */
const SESSION_RE = /^[A-Za-z0-9._-]{1,40}$/;

/* --session wins over BEAM_SESSION. Either of those wins over the chat id
   Claude Code or Cursor already exported, so two chats do not share a window
   unless someone asks them to. A plain terminal, with none of these set,
   still shares "default". */
function sessionOf(flag, env) {
  env = env || {};
  if (flag === true) throw new Error('invalid session name');
  const named = flag != null && flag !== '' ? String(flag) : (env.BEAM_SESSION || '');
  if (named) {
    if (!SESSION_RE.test(named)) throw new Error('invalid session name: ' + named);
    return named;
  }
  return chatSession(env) || 'default';
}

function chatSession(env) {
  const id = env.CLAUDE_CODE_SESSION_ID || env.CURSOR_CONVERSATION_ID || '';
  const raw = String(id).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  return SESSION_RE.test(raw) ? raw : '';
}

module.exports = { sessionOf };
