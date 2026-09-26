// Neon Slither — Cloudflare Worker entry
import { Arena } from './arena.js';
export { Arena };

const encoder = new TextEncoder();
const GOOD_INDEX_URL =
  'https://raw.githubusercontent.com/izad369/neon-slither-izad/17716e5bf55a6f5f02d4ffc8f4dca5835673777f/index.html';

async function hashPassword(password, salt) {
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function makeToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function makeSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}
function conversationKey(a, b) {
  return [a, b].sort().join('|');
}

const CHAT_OVERRIDE = `
<script>
(function(){
  function waitReady(fn){
    if (typeof api === 'function' && typeof appendChatBubble === 'function') return fn();
    setTimeout(function(){ waitReady(fn); }, 50);
  }
  waitReady(function(){
    window.sendChatMessage = async function(){
      var input = document.getElementById('chatInput');
      if (!input) return;
      var text = (input.value || '').trim();
      if (!text || !currentChatFriend || !store || !store.token) return;
      input.value = '';
      appendChatBubble(text, true);
      try {
        await api('/api/chat/send', { token: store.token, to: currentChatFriend, text: text });
      } catch (e) {
        console.warn('chat send failed', e);
      }
      try {
        if (socialSocket && socialSocket.readyState === 1) {
          socialSocket.send(JSON.stringify({ type: 'chat-send', token: store.token, to: currentChatFriend, text: text }));
        }
      } catch (e) {}
    };
    var btn = document.getElementById('chatSendBtn');
    if (btn) {
      btn.onclick = function(e){ e.preventDefault(); window.sendChatMessage(); };
    }
    var inp = document.getElementById('chatInput');
    if (inp) {
      inp.addEventListener('keydown', function(e){
        if (e.key === 'Enter') { e.preventDefault(); window.sendChatMessage(); }
      });
    }
  });
})();
</script>
`;

function patchChatClient(html) {
  if (html.includes('</body>')) {
    html = html.replace('</body>', CHAT_OVERRIDE + '</body>');
  } else {
    html += CHAT_OVERRIDE;
  }
  return html;
}

async function serveGameHtml() {
  const res = await fetch(GOOD_INDEX_URL);
  if (!res.ok) return new Response('Failed to load game HTML', { status: 502 });
  let html = await res.text();
  html = patchChatClient(html);
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function handleApi(request, env, pathname) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (!env.USERS) return json({ error: 'KV binding USERS not configured.' }, 500);

  if (pathname === '/api/register' && request.method === 'POST') {
    const { username, password } = await readJson(request);
    if (!username || !password || username.length < 3 || password.length < 4)
      return json({ error: 'Username needs 3+ chars, password 4+ chars.' }, 400);
    const key = username.toLowerCase();
    if (await env.USERS.get('user:' + key)) return json({ error: 'That username is taken.' }, 409);
    const salt = makeSalt();
    const hash = await hashPassword(password, salt);
    await env.USERS.put('user:' + key, JSON.stringify({ username, salt, hash, bestScore: 0, skin: 'classic', friends: [] }));
    const token = makeToken();
    await env.USERS.put('token:' + token, key, { expirationTtl: 60 * 60 * 24 * 30 });
    return json({ token, username, bestScore: 0, skin: 'classic' });
  }

  if (pathname === '/api/login' && request.method === 'POST') {
    const { username, password } = await readJson(request);
    const key = (username || '').toLowerCase();
    const raw = await env.USERS.get('user:' + key);
    if (!raw) return json({ error: 'Wrong username or password.' }, 401);
    const u = JSON.parse(raw);
    if ((await hashPassword(password || '', u.salt)) !== u.hash) return json({ error: 'Wrong username or password.' }, 401);
    const token = makeToken();
    await env.USERS.put('token:' + token, key, { expirationTtl: 60 * 60 * 24 * 30 });
    return json({ token, username: u.username, bestScore: u.bestScore || 0, skin: u.skin || 'classic' });
  }

  if (pathname === '/api/profile' && request.method === 'POST') {
    const { token } = await readJson(request);
    const key = await env.USERS.get('token:' + token);
    if (!key) return json({ error: 'Session expired, please log in again.' }, 401);
    const raw = await env.USERS.get('user:' + key);
    if (!raw) return json({ error: 'Session expired, please log in again.' }, 401);
    const u = JSON.parse(raw);
    return json({ username: u.username, bestScore: u.bestScore || 0, skin: u.skin || 'classic' });
  }

  if (pathname === '/api/set-skin' && request.method === 'POST') {
    const { token, skin } = await readJson(request);
    const key = await env.USERS.get('token:' + token);
    if (!key) return json({ error: 'Not logged in.' }, 401);
    const raw = await env.USERS.get('user:' + key);
    if (!raw) return json({ error: 'Not logged in.' }, 401);
    const u = JSON.parse(raw);
    u.skin = skin;
    await env.USERS.put('user:' + key, JSON.stringify(u));
    return json({ ok: true });
  }

  if (pathname === '/api/search-users' && request.method === 'POST') {
    const { token, query } = await readJson(request);
    const key = token ? await env.USERS.get('token:' + token) : null;
    let me = null;
    if (key) {
      const meRaw = await env.USERS.get('user:' + key);
      if (meRaw) me = JSON.parse(meRaw);
    }
    const q = (query || '').toLowerCase().trim();
    if (q.length < 2) return json({ results: [] });
    const listed = await env.USERS.list({ prefix: 'user:', limit: 1000 });
    const results = [];
    for (const item of listed.keys) {
      const k = item.name.slice(5);
      if (k === key) continue;
      if (!k.includes(q)) continue;
      const raw = await env.USERS.get(item.name);
      if (!raw) continue;
      const u = JSON.parse(raw);
      results.push({
        username: u.username,
        online: false,
        isFriend: !!(me && Array.isArray(me.friends) && me.friends.includes(k)),
      });
      if (results.length >= 15) break;
    }
    return json({ results });
  }

  if (pathname === '/api/friends/list' && request.method === 'POST') {
    const { token } = await readJson(request);
    const key = await env.USERS.get('token:' + token);
    if (!key) return json({ error: 'Not logged in.' }, 401);
    const raw = await env.USERS.get('user:' + key);
    if (!raw) return json({ error: 'Not logged in.' }, 401);
    const me = JSON.parse(raw);
    const friends = Array.isArray(me.friends) ? me.friends : [];
    const list = [];
    for (const fk of friends) {
      const fr = await env.USERS.get('user:' + fk);
      if (!fr) continue;
      const f = JSON.parse(fr);
      list.push({ username: f.username, online: false });
    }
    return json({ friends: list });
  }

  if (pathname === '/api/friends/add' && request.method === 'POST') {
    const { token, target } = await readJson(request);
    const key = await env.USERS.get('token:' + token);
    if (!key) return json({ error: 'Not logged in.' }, 401);
    const meRaw = await env.USERS.get('user:' + key);
    if (!meRaw) return json({ error: 'Not logged in.' }, 401);
    const me = JSON.parse(meRaw);
    if (!Array.isArray(me.friends)) me.friends = [];
    const targetKey = (target || '').toLowerCase().trim();
    if (targetKey === key) return json({ error: "You can't add yourself." }, 400);
    const targetRaw = await env.USERS.get('user:' + targetKey);
    if (!targetRaw) return json({ error: 'No player with that username.' }, 404);
    const targetUser = JSON.parse(targetRaw);
    if (!Array.isArray(targetUser.friends)) targetUser.friends = [];
    if (!me.friends.includes(targetKey)) me.friends.push(targetKey);
    if (!targetUser.friends.includes(key)) targetUser.friends.push(key);
    await env.USERS.put('user:' + key, JSON.stringify(me));
    await env.USERS.put('user:' + targetKey, JSON.stringify(targetUser));
    return json({ ok: true, username: targetUser.username });
  }

  if (pathname === '/api/chat/send' && request.method === 'POST') {
    const { token, to, text } = await readJson(request);
    const key = await env.USERS.get('token:' + token);
    if (!key) return json({ error: 'Not logged in.' }, 401);
    const meRaw = await env.USERS.get('user:' + key);
    if (!meRaw) return json({ error: 'Not logged in.' }, 401);
    const me = JSON.parse(meRaw);
    const otherKey = (to || '').toLowerCase().trim();
    if (!Array.isArray(me.friends) || !me.friends.includes(otherKey))
      return json({ error: 'Not friends with that player. Add them first.' }, 403);
    const body = String(text || '').slice(0, 500).trim();
    if (!body) return json({ error: 'Empty message.' }, 400);
    const ck = conversationKey(key, otherKey);
    const histKey = 'chat:' + ck;
    let hist = [];
    try {
      const prev = await env.USERS.get(histKey);
      if (prev) hist = JSON.parse(prev);
    } catch {}
    const entry = { from: me.username, text: body, ts: Date.now() };
    hist.push(entry);
    if (hist.length > 200) hist = hist.slice(-200);
    await env.USERS.put(histKey, JSON.stringify(hist));
    return json({ ok: true, entry });
  }

  if (pathname === '/api/chat/history' && request.method === 'POST') {
    const { token, withUser } = await readJson(request);
    const key = await env.USERS.get('token:' + token);
    if (!key) return json({ error: 'Not logged in.' }, 401);
    const meRaw = await env.USERS.get('user:' + key);
    if (!meRaw) return json({ error: 'Not logged in.' }, 401);
    const me = JSON.parse(meRaw);
    const otherKey = (withUser || '').toLowerCase().trim();
    if (!Array.isArray(me.friends) || !me.friends.includes(otherKey))
      return json({ error: 'Not friends with that player.' }, 403);
    const ck = conversationKey(key, otherKey);
    const histRaw = await env.USERS.get('chat:' + ck);
    const msgs = histRaw ? JSON.parse(histRaw) : [];
    return json({ messages: msgs.slice(-50) });
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const id = env.ARENA.idFromName('main');
      return env.ARENA.get(id).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url.pathname);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveGameHtml();
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Neon Slither Worker is running.', { status: 200 });
  },
};
