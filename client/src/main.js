import { DiscordSDK } from '@discord/embedded-app-sdk';
import { createPlayer } from './player.js';
import { createAudio } from './audio.js';
import { createBroadcaster } from '../../shared/broadcaster.js';

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const inDiscord = params.has('frame_id');

const P = inDiscord ? '/.proxy' : '';

const streams = new Map();

const available = new Map();
const watching = new Set();

let sdk = null;
let session = null;
let clientId = null;
let ws = null;
let participants = [];
let reconnectDelay = 1000;
let lagTimer = null;
let myBroadcast = null;
let volume = Math.min(1, Math.max(0, Number(read('volume') ?? 1)));

const volumePessoa = lerVolumes();

function lerVolumes() {
  try {
    return new Map(Object.entries(JSON.parse(read('volumePessoa') ?? '{}')));
  } catch {
    return new Map();
  }
}

const gravarVolumes = () =>
  store('volumePessoa', JSON.stringify(Object.fromEntries(volumePessoa)));

const volumeEfetivo = (userId) => volume * (volumePessoa.get(userId) ?? 1);

function aplicarVolume(slot) {
  const s = streams.get(slot);
  s?.audio?.setVolume(volumeEfetivo(s.userId));
}

let volumeAntes = volume || 1;
let activeSlot = null;
let telaCheia = false;

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

function setEmpty(title, text) {
  $('emptyTitle').textContent = title;
  $('emptyText').textContent = text;
}

function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 42%)`;
}

function avatarUrl(p) {
  if (!p.avatar) return null;
  return `${P}/api/avatar/${p.id}/${p.avatar}`;
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase();
}

const slotOf = (userId) =>
  [...available.entries()].find(([, a]) => a.userId === userId)?.[0] ?? null;

function watchSlot(slot) {
  const info = available.get(slot);
  if (!info) return;
  watching.add(slot);
  ws?.send(JSON.stringify({ type: 'watch', slot }));
  if (info.config) {
    openStream(slot, info.userId);
    startStream(slot, info.config);
  }
  renderGrid();
}

function unwatchSlot(slot) {
  watching.delete(slot);
  ws?.send(JSON.stringify({ type: 'unwatch', slot }));
  closeStream(slot);
  renderGrid();
  renderBar();
}

function columnsFor(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

const STRIP_DEFAULT = 300;
const STRIP_MIN = 200;
let stripW = Number(read('stripW')) || STRIP_DEFAULT;

const divider = document.createElement('div');
divider.className = 'divider';
divider.title = 'Arraste para redimensionar · duplo clique restaura';

function applyStrip() {
  const max = Math.max(STRIP_MIN, $('grid').clientWidth * 0.45);
  $('grid').style.setProperty('--strip', `${Math.round(Math.min(max, stripW))}px`);
}

function setStrip(px) {
  stripW = Math.max(STRIP_MIN, Math.round(px));
  applyStrip();
  store('stripW', String(stripW));
}

divider.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  divider.classList.add('dragging');

  const move = (ev) => setStrip($('grid').getBoundingClientRect().right - ev.clientX - 21);
  const up = () => {
    divider.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

divider.addEventListener('dblclick', () => setStrip(STRIP_DEFAULT));
window.addEventListener('resize', () => inRoom() && applyStrip());

function renderGrid() {
  const grid = $('grid');

  if (!inRoom()) {
    grid.hidden = true;
    $('empty').hidden = true;
    $('fullscreen').hidden = true;
    return;
  }

  const hasPeople = participants.length > 0;
  $('empty').hidden = hasPeople;
  grid.hidden = !hasPeople;

  const casters = participants.filter((p) => p.broadcasting);

  if (!casters.length) {
    activeSlot = null;
    telaCheia = false;
  } else if (activeSlot === null || !available.has(activeSlot)) {
    activeSlot = casters.map((p) => slotOf(p.id)).find((s) => s !== null) ?? null;
  }

  const noPalco = activeSlot !== null;
  $('fullscreen').hidden = !noPalco;
  $('fullscreen').classList.toggle('on', telaCheia);
  const rotulo = telaCheia ? 'Sair da tela cheia' : 'Tela cheia';
  $('fullscreen').dataset.tip = rotulo;
  $('fullscreen').setAttribute('aria-label', rotulo);

  if (!hasPeople) return;

  grid.classList.toggle('palco', noPalco);
  grid.classList.toggle('cheia', noPalco && telaCheia);

  $('people').hidden = noPalco && !telaCheia;

  grid.replaceChildren();

  if (!noPalco) {
    grid.style.setProperty('--cols', columnsFor(participants.length));
    grid.append(...participants.map((p) => buildTile(p).el));
    return;
  }

  const dono = available.get(activeSlot)?.userId;
  const emCena = participants.find((p) => p.id === dono) ?? {
    id: dono ?? 'desconhecido',
    name: 'Transmitindo',
    broadcasting: true,
  };
  grid.append(buildTile(emCena, { palco: true }).el);

  if (telaCheia) return;

  applyStrip();
  grid.append(divider, buildSidebar(casters));
}

function buildSidebar(casters) {
  const barra = document.createElement('aside');
  barra.className = 'sidebar';

  const outras = casters.filter((p) => slotOf(p.id) !== activeSlot);
  if (outras.length) {
    barra.append(secaoTitulo(outras.length === 1 ? 'Outra tela' : 'Outras telas'));
    for (const p of outras) barra.append(buildTile(p).el);
  }

  barra.append(contagemPessoas());

  const gente = document.createElement('div');
  gente.className = 'sidebar-people';
  for (const p of participants) gente.append(buildTile(p, { semVideo: true }).el);
  barra.append(gente);

  return barra;
}

function secaoTitulo(texto) {
  const t = document.createElement('h2');
  t.className = 'sidebar-title';
  t.textContent = texto;
  return t;
}

function contagemPessoas() {
  const chip = document.createElement('div');
  chip.className = 'sidebar-count';
  chip.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 20v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="9" cy="7" r="4"/><path d="M23 20v-2a4 4 0 0 0-3-3.87"/>' +
    '<path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  chip.append(document.createTextNode(String(participants.length)));
  chip.title =
    participants.length === 1 ? '1 pessoa na sala' : `${participants.length} pessoas na sala`;
  return chip;
}

function buildTile(p, { palco = false, semVideo = false } = {}) {
  const slot = p.broadcasting && !semVideo ? slotOf(p.id) : null;
  const stream = slot !== null ? streams.get(slot) : null;
  const isMe = p.id === session?.user?.id;

  const tile = document.createElement('div');
  tile.className = p.broadcasting ? 'tile sharing' : 'tile';
  if (palco) tile.classList.add('tile-palco');

  if (palco && stream?.canvas.width) {
    tile.style.aspectRatio = `${stream.canvas.width} / ${stream.canvas.height}`;
  }

  const aoClicar = () => {
    if (palco) telaCheia = !telaCheia;
    else activeSlot = slot;
    renderGrid();
  };

  if (stream) {
    tile.append(stream.canvas);
    tile.title = palco
      ? telaCheia
        ? 'Clique para sair da tela cheia'
        : 'Clique para ver em tela cheia'
      : 'Clique para ver em destaque';
    tile.addEventListener('click', aoClicar);
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTileMenu(e.clientX, e.clientY, slot, p.name);
    });

    if (!stream.started) tile.append(buildLoading());

    const stop = document.createElement('button');
    stop.className = 'tile-stop';
    stop.dataset.tip = 'Parar de assistir';
    stop.setAttribute('aria-label', `Parar de assistir ${p.name}`);
    stop.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    stop.addEventListener('click', (e) => {
      e.stopPropagation();
      unwatchSlot(slot);
    });
    tile.append(stop);
  } else if (slot !== null) {
    if (!palco) tile.addEventListener('click', aoClicar);
    tile.append(buildWatchPrompt(slot, p.name, isMe));
  } else {
    tile.append(buildAvatar(p));
  }

  const footer = document.createElement('div');
  footer.className = 'tile-footer';

  const badge = document.createElement('div');
  badge.className = 'tile-name';
  if (p.broadcasting) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    badge.append(dot);
  }
  badge.append(document.createTextNode(p.name));
  footer.append(badge);

  if (slot !== null) footer.append(buildWatchers(slot));
  tile.append(footer);

  if (isMe) {
    const you = document.createElement('span');
    you.className = 'tile-you';
    you.textContent = 'você';
    tile.append(you);
  }

  return { el: tile, slot };
}

function buildLoading() {
  const wrap = document.createElement('div');
  wrap.className = 'tile-loading';
  wrap.innerHTML = '<span class="spinner"></span>';
  wrap.append(document.createTextNode('Conectando…'));
  return wrap;
}

function buildWatchers(slot) {
  const people = available.get(slot)?.watchers ?? [];

  const badge = document.createElement('div');
  badge.className = 'tile-watchers';
  badge.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="12" cy="7" r="4"/></svg>';
  badge.append(document.createTextNode(String(people.length)));
  badge.title = people.length === 1 ? '1 pessoa assistindo' : `${people.length} pessoas assistindo`;

  const list = document.createElement('div');
  list.className = 'hover-list';

  if (!people.length) {
    const empty = document.createElement('span');
    empty.className = 'hover-empty';
    empty.textContent = 'Ninguém assistindo';
    list.append(empty);
  } else {
    for (const w of people) {
      const row = document.createElement('span');
      row.className = 'hover-row';
      row.append(buildAvatar(w));
      row.append(document.createTextNode(w.name));
      list.append(row);
    }
  }

  badge.append(list);
  return badge;
}

function buildWatchPrompt(slot, name, isMe) {
  const wrap = document.createElement('div');
  wrap.className = 'watch-prompt';

  const btn = document.createElement('button');
  btn.className = 'btn go';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v11H3z"/><path d="M8 20h8"/></svg>';
  btn.append(document.createTextNode(isMe ? 'Ver minha tela' : 'Assistir tela'));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    watchSlot(slot);
  });

  const who = document.createElement('span');
  who.className = 'watch-who';
  who.textContent = isMe ? 'Sua transmissão está no ar' : `${name} está transmitindo`;

  wrap.append(btn, who);
  return wrap;
}

function renderProfileButton() {
  if (!session) return;
  const me = participants.find((p) => p.id === session.user.id) ?? session.user;

  $('profile').replaceChildren(buildAvatar({ ...me, id: session.user.id }));

  const name = document.createElement('span');
  name.textContent = me.name;
  $('lobbyUser').replaceChildren(buildAvatar({ ...me, id: session.user.id }), name);
  $('lobbyUser').hidden = false;
}

$('lobbyUser').addEventListener('click', openProfile);
$('profile').addEventListener('click', openProfile);

function openProfile() {
  if (!session) return;
  const me = participants.find((p) => p.id === session.user.id) ?? session.user;

  $('profileAvatar').replaceChildren(buildAvatar({ ...me, id: session.user.id }));
  $('profileName').textContent = me.name;
  $('profileId').textContent = inDiscord ? `Discord · ${session.user.id}` : 'modo local';
  $('profileInput').value = me.name;

  $('profileModal').hidden = false;

  $('profileInput').focus();
  $('profileInput').select();
}

const closeProfile = () => {
  $('profileModal').hidden = true;
};

$('profileCancel').addEventListener('click', closeProfile);

$('profileModal').addEventListener('click', (e) => {
  if (e.target === $('profileModal')) closeProfile();
});

$('profileInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('profileSave').click();
});

$('profileSave').addEventListener('click', () => {
  const name = $('profileInput').value.replace(/\s+/g, ' ').trim().slice(0, 32);
  if (name) {
    session.user.name = name;
    storeName(name);
    ws?.send(JSON.stringify({ type: 'rename', name }));
    renderProfileButton();
  }
  closeProfile();
});

const storedName = () => read('displayName');
const storeName = (name) => store('displayName', name);

function openTileMenu(x, y, slot, name) {
  document.querySelector('.tile-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'tile-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const stream = streams.get(slot);
  if (stream?.audio) menu.append(buildMenuVolume(stream.userId, name, slot));

  const item = document.createElement('button');
  item.textContent = `Parar de assistir ${name}`;
  item.addEventListener('click', () => {
    menu.remove();
    unwatchSlot(slot);
  });

  menu.append(item);
  document.body.append(menu);

  const box = menu.getBoundingClientRect();
  if (x + box.width > window.innerWidth) menu.style.left = `${window.innerWidth - box.width - 8}px`;
  if (y + box.height > window.innerHeight)
    menu.style.top = `${window.innerHeight - box.height - 8}px`;

  setTimeout(() => {
    const close = (e) => {
      if (e.type === 'pointerdown' && menu.contains(e.target)) return;
      menu.remove();
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
  }, 0);
}

function buildMenuVolume(userId, name, slot) {
  const bloco = document.createElement('div');
  bloco.className = 'menu-volume';

  const rotulo = document.createElement('span');
  rotulo.className = 'menu-volume-nome';
  rotulo.textContent = `Volume de ${name}`;

  const linha = document.createElement('div');
  linha.className = 'menu-volume-linha';

  const barra = document.createElement('input');
  barra.type = 'range';
  barra.min = '0';
  barra.max = '200';
  barra.step = '5';
  barra.setAttribute('aria-label', `Volume de ${name}`);

  const valor = document.createElement('span');
  valor.className = 'menu-volume-valor';

  const mostrar = () => {
    valor.textContent = `${barra.value}%`;
  };

  barra.value = String(Math.round((volumePessoa.get(userId) ?? 1) * 100));
  mostrar();

  barra.addEventListener('input', () => {
    const nivel = Number(barra.value) / 100;
    if (nivel === 1) volumePessoa.delete(userId);
    else volumePessoa.set(userId, nivel);
    gravarVolumes();
    aplicarVolume(slot);
    mostrar();
  });

  linha.append(barra, valor);
  bloco.append(rotulo, linha);
  return bloco;
}

function buildAvatar(p) {
  const url = avatarUrl(p);

  const fallback = () => {
    const div = document.createElement('div');
    div.className = 'avatar';
    div.style.background = colorFor(p.id);
    div.textContent = initials(p.name);
    return div;
  };

  if (!url) return fallback();

  const img = document.createElement('img');
  img.className = 'avatar';
  img.src = url;
  img.alt = p.name;
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

function buildPeopleList() {
  const list = document.createElement('div');
  list.className = 'hover-list';

  if (!participants.length) {
    const empty = document.createElement('span');
    empty.className = 'hover-empty';
    empty.textContent = 'Ninguém na sala';
    list.append(empty);
    return list;
  }

  for (const p of participants) {
    const row = document.createElement('span');
    row.className = 'hover-row';
    if (p.broadcasting) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      row.append(dot);
    }
    row.append(document.createTextNode(p.id === session?.user?.id ? `${p.name} (você)` : p.name));
    list.append(row);
  }

  return list;
}

function renderBar() {
  $('people').replaceChildren();
  $('people').insertAdjacentHTML(
    'afterbegin',
    '<svg viewBox="0 0 24 24"><path d="M17 20v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>' +
      '<circle cx="9" cy="7" r="4"/><path d="M23 20v-2a4 4 0 0 0-3-3.87"/>' +
      '<path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'
  );
  $('people').append(document.createTextNode(String(participants.length)));
  $('people').append(buildPeopleList());

  const casters = participants.filter((p) => p.broadcasting);
  const iAmCasting = iAmBroadcasting();

  const btn = $('share');
  btn.classList.toggle('go', !iAmCasting);
  btn.classList.toggle('live', iAmCasting);
  btn.disabled = false;

  const rotuloShare = iAmCasting ? 'Parar transmissão' : 'Compartilhar tela';
  $('shareLabel').textContent = rotuloShare;
  btn.dataset.tip = rotuloShare;
  btn.setAttribute('aria-label', rotuloShare);

  $('liveSettings').hidden = !myBroadcast;
  const somPendente = Boolean(myBroadcast?.somBloqueado?.());
  $('liveSettings').classList.toggle('atencao', somPendente);
  $('liveSettings').dataset.tip = somPendente
    ? 'Som barrado — clique para escolher a aba'
    : 'Ajustes da transmissão';

  const temSom = [...streams.values()].some((s) => s.audio);
  $('volumeBox').hidden = !temSom;
  renderVolume();

  renderProfileButton();

  $('pWho').textContent = casters.length ? casters.map((p) => p.name).join(', ') : 'ninguém';
}

function openStream(slot, userId) {
  closeStream(slot);

  const canvas = document.createElement('canvas');
  const s = {
    userId,
    canvas,
    started: false,
    player: createPlayer(canvas, {
      onError: (m) => toast(m, true),
      onTamanho: () => {
        s.started = true;
        renderGrid();
      },
    }),
    audio: null,
  };

  streams.set(slot, s);
}

function startAudio(slot, config) {
  const s = streams.get(slot);
  if (!s) return;

  s.audio?.stop();
  s.audio = createAudio({ onError: (m) => toast(m, true), volume: volumeEfetivo(s.userId) });
  if (!s.audio.start(config)) {
    s.audio = null;
    return;
  }
  renderBar();
}

function startStream(slot, config) {
  const s = streams.get(slot);
  if (!s || !s.player.start(config)) return;
  renderGrid();
  renderBar();
  ensureStatsTimer();
}

function closeStream(slot) {
  const s = streams.get(slot);
  if (!s) return;
  s.player.stop();
  s.audio?.stop();
  s.canvas.remove();
  streams.delete(slot);
  if (activeSlot === slot) activeSlot = null;
}

function endStream(slot) {
  if (!streams.has(slot)) return;
  closeStream(slot);

  if (streams.size === 0) {
    clearInterval(lagTimer);
    lagTimer = null;
    for (const id of ['pLag', 'pFps', 'pRes']) $(id).textContent = '—';
  }

  renderGrid();
  renderBar();
}

function closeAllStreams() {
  for (const slot of [...streams.keys()]) closeStream(slot);
  clearInterval(lagTimer);
  lagTimer = null;
}

function ensureStatsTimer() {
  if (lagTimer) return;
  lagTimer = setInterval(() => {
    const s = streams.get(activeSlot) ?? streams.values().next().value;
    if (!s) return;
    $('pLag').textContent = `${Math.max(0, s.player.getLag())} ms`;
    $('pFps').textContent = `${s.player.takeFrameCount()} fps`;
    $('pRes').textContent = s.player.getSizes().video;

    if (!s.audio) $('pSom').textContent = 'a transmissão não tem áudio';
    else if (!s.audio.temSom()) $('pSom').textContent = 'aguardando o áudio…';
    else if (volume === 0) $('pSom').textContent = 'silenciado aqui';
    else $('pSom').textContent = `tocando · ${Math.round(volume * 100)}%`;
  }, 1000);
}

boot().catch((err) => {
  console.error(err);
  setEmpty('Não foi possível entrar', err.message);
});

async function boot() {
  const vigia = setTimeout(() => {
    setEmpty('Está demorando…', 'Sem resposta do servidor. Ele está no ar?');
  }, 8000);

  const config = loadConfig();

  session = inDiscord ? await authDiscord(config) : await authWeb();

  clientId = params.get('client_id') || (await config).clientId || null;
  checkVersion((await config).asset);
  clearTimeout(vigia);

  renderProfileButton();

  if (inDiscord) return entrarNaCall();

  const alvo = new URLSearchParams(location.search).get('sala');

  await showLobby();
  if (session && alvo) await joinById(alvo);
}

async function entrarNaCall() {
  setEmpty('Entrando…', 'Sala desta call');
  try {
    const tokens = await post(`${P}/api/rooms/call`, { identity: session.identity });
    openRoom(tokens, { id: tokens.roomId, name: 'Sala da call' });
  } catch (err) {
    setEmpty('Não foi possível entrar', err.message);
  }
}

$('loginBtn').addEventListener('click', () => {
  remove('identity');
  location.href = '/auth/login';
});

async function authWeb() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const fromLogin = fragment.get('identity');

  if (fromLogin) {
    store('identity', fromLogin);
    history.replaceState(null, '', location.pathname + location.search);
  }

  let identity = fromLogin ?? read('identity');

  if (!identity) {
    const guest = await post('/api/session-guest', { name: storedName() }, { retry: false });
    store('identity', guest.identity);
    identity = guest.identity;
  }

  const payload = decodeIdentity(identity);
  if (!payload) {
    remove('identity');
    return null;
  }

  return {
    identity,
    isGuest: String(payload.uid).startsWith('guest-'),
    call: payload.call ?? null,
    user: { id: payload.uid, name: payload.name, avatar: payload.av ?? null },
  };
}

function decodeIdentity(token) {
  try {
    const p = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    if (p.exp && p.exp * 1000 < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
  }
}

let roomTokens = null;
let roomInfo = null;
let joinTarget = null;
let lastRoomState = null;
let lobbyRooms = [];

function inRoom() {
  return roomTokens !== null;
}

const LOBBY_REFRESH_MS = 4000;
let lobbyTimer = null;

function limparSala() {
  stopMyBroadcast();

  closeAllStreams();
  available.clear();
  watching.clear();
  participants = [];
  lastRoomState = null;
  activeSlot = null;
  telaCheia = false;

  if (roomInfo) remove(`sala:${roomInfo.id}`);
  roomTokens = null;
  roomInfo = null;
  setRoomUrl(null);

  ws?.close();
  ws = null;
}

async function showLobby() {
  limparSala();

  $('lobby').hidden = false;
  $('grid').hidden = true;
  $('empty').hidden = true;
  $('roomPill').hidden = true;
  $('leaveRoom').hidden = true;
  $('roomSettings').hidden = true;
  $('share').hidden = true;
  $('liveSettings').hidden = true;

  $('fullscreen').hidden = true;
  $('settings').hidden = true;
  $('settings').classList.remove('on');
  $('panel').hidden = true;
  $('profile').hidden = true;

  $('loginBtn').hidden = inDiscord || !session?.isGuest;
  $('people').hidden = true;

  await loadRooms();

  clearInterval(lobbyTimer);
  lobbyTimer = setInterval(() => {
    const busy = ['createModal', 'joinModal'].some((id) => !$(id).hidden);
    if (!busy && !$('lobby').hidden) loadRooms();
  }, LOBBY_REFRESH_MS);
}

async function loadRooms() {
  const list = $('roomList');

  let rooms = [];
  try {
    rooms = (await post(`${P}/api/rooms/list`, { identity: session?.identity })).rooms ?? [];
  } catch (err) {
    list.replaceChildren(msgRow(`Não foi possível carregar: ${err.message}`));
    return;
  }

  lobbyRooms = rooms;

  const cards = rooms.map(roomCard);

  if (!cards.length) {
    list.replaceChildren(msgRow('Nenhuma sala aberta. Crie a primeira.'));
    return;
  }

  list.replaceChildren(...cards);
}

function msgRow(text) {
  const el = document.createElement('div');
  el.className = 'lobby-empty';
  el.textContent = text;
  return el;
}

function roomCard(room) {
  const card = document.createElement('button');
  card.className = 'room-card';

  const top = document.createElement('div');
  top.className = 'room-card-top';

  if (room.locked) {
    top.insertAdjacentHTML(
      'afterbegin',
      '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/>' +
        '<path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
    );
  }

  const name = document.createElement('span');
  name.className = 'room-card-name';
  name.textContent = room.name;
  top.append(name);

  const meta = document.createElement('span');
  meta.className = 'room-card-meta';
  const pessoas = room.people === 1 ? '1 pessoa' : `${room.people} pessoas`;
  meta.textContent = `${pessoas} · por ${room.owner}`;

  card.append(top, meta);

  if (room.streams > 0) {
    const live = document.createElement('span');
    live.className = 'room-card-meta room-live';
    live.textContent = room.streams === 1 ? '1 tela no ar' : `${room.streams} telas no ar`;
    card.append(live);
  }

  card.addEventListener('click', () => enterRoom(room));
  return card;
}

async function enterRoom(room, password) {
  if (!session) return;

  try {
    const tokens = await post(`${P}/api/rooms/join`, {
      identity: session.identity,
      roomId: room.id,
      password: password ?? '',
    });
    openRoom(tokens, room);
  } catch (err) {
    if (err.status === 403 && !password) return askPassword(room);
    if (err.status === 403) return askPassword(room, 'Senha incorreta.');
    if (err.status === 429) return askPassword(room, err.detail);
    if (err.status === 404) {
      toast('Essa sala já fechou.', true);
      remove(`sala:${room.id}`);
      setRoomUrl(null);
      loadRooms();
      return;
    }
    toast(err.message, true);
  }
}

function askPassword(room, error) {
  joinTarget = room;
  $('joinSub').textContent = `"${room.name}" pede uma senha para entrar.`;
  $('joinError').textContent = error ?? '';
  $('joinError').hidden = !error;
  if (!error) $('joinPass').value = '';
  $('joinModal').hidden = false;

  $('joinPass').focus();
}

async function joinById(id) {
  const saved = read(`sala:${id}`);
  if (saved) {
    try {
      const { tokens, name } = JSON.parse(saved);
      openRoom(tokens, { id, name });
      return;
    } catch {
      remove(`sala:${id}`);
    }
  }

  const known = lobbyRooms.find((r) => r.id === id);
  await enterRoom(known ?? { id, name: 'Sala' });
}

function setRoomUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('sala', id);
  else url.searchParams.delete('sala');
  history.replaceState(null, '', url);
}

function openRoom(tokens, room) {
  roomTokens = tokens;
  roomInfo = room;

  setRoomUrl(room.id);
  store(`sala:${room.id}`, JSON.stringify({ tokens, name: room.name }));

  $('lobby').hidden = true;
  $('empty').hidden = false;
  $('share').hidden = false;
  $('people').hidden = false;
  $('settings').hidden = false;
  $('profile').hidden = false;
  $('loginBtn').hidden = true;

  $('roomPill').hidden = inDiscord;
  $('leaveRoom').hidden = inDiscord;

  clearInterval(lobbyTimer);
  lobbyTimer = null;
  $('roomPill').textContent = room.name;

  setEmpty('Entrando…', room.name);
  connect();
}

$('leaveRoom').addEventListener('click', () => showLobby());

async function loadConfig() {
  try {
    const r = await fetch(`${P}/api/config`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });
    return await r.json();
  } catch {
    return {};
  }
}

function checkVersion(asset) {
  const mine = import.meta.url.split('/').pop().split('?')[0];

  if (!/^index-[A-Za-z0-9_-]+.js$/.test(mine)) return;

  if (!asset || asset === mine) return;

  if (inDiscord) {
    toast('Esta atividade está numa versão antiga. Feche e abra de novo para atualizar.', true);
    return;
  }

  if (sessionStorage.getItem('reloadedFor') === asset) {
    toast('Versão desatualizada e o cache não cede. Recarregue a página.', true);
    return;
  }
  sessionStorage.setItem('reloadedFor', asset);
  location.reload();
}

async function authDiscord(fonteDoId) {
  const id =
    params.get('client_id') ||
    (typeof fonteDoId === 'string' ? fonteDoId : (await fonteDoId)?.clientId);

  if (!id) {
    throw new Error('O servidor está sem as credenciais do Discord. Rode: npm run configurar');
  }

  const clientId = id;
  sdk = new DiscordSDK(clientId);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });

  const { access_token } = await post(`${P}/api/token`, { code, client_id: clientId });
  await sdk.commands.authenticate({ access_token });

  try {
    await sdk.commands.setActivity({
      activity: {
        type: 3, 
        state: "Transmitindo tela",
        details: "Ao vivo na sala",
        timestamps: {
          start: Date.now()
        }
      }
    });
  } catch (err) {
    console.warn(err);
  }

  return post(`${P}/api/session`, {
    access_token,
    instance_id: sdk.instanceId,
    guild_id: sdk.guildId,
    channel_id: sdk.channelId,
  });
}

async function renovarIdentidade() {
  remove('identity');
  try {
    session = inDiscord ? await authDiscord(clientId) : await authWeb();
    renderProfileButton();
    return session?.identity ?? null;
  } catch {
    return null;
  }
}

async function post(url, body, { retry = true } = {}) {
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const msg =
      err.name === 'TimeoutError'
        ? 'O servidor não respondeu a tempo.'
        : 'Não foi possível falar com o servidor.';
    throw Object.assign(new Error(msg), { status: 0 });
  }

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    if (r.status === 401 && retry && body?.identity) {
      const nova = await renovarIdentidade();
      if (nova) return post(url, { ...body, identity: nova }, { retry: false });
    }

    const err = new Error(data.error ?? `Servidor respondeu ${r.status}.`);
    err.status = r.status;
    err.detail = data.error;
    throw err;
  }
  return data;
}

function connect() {
  if (!roomTokens) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(
    `${proto}://${location.host}${P}/ws?t=${encodeURIComponent(roomTokens.viewerToken)}`
  );
  ws.binaryType = 'arraybuffer';

  let abriu = false;

  ws.addEventListener('open', () => {
    abriu = true;
    reconnectDelay = 1000;
    $('grid').hidden = false;
    setEmpty('Ninguém na sala', 'Aguardando participantes.');

    const saved = storedName();
    if (saved && saved !== session.user.name) {
      session.user.name = saved;
      ws.send(JSON.stringify({ type: 'rename', name: saved }));
    }
  });

  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') {
      const view = new DataView(e.data);
      const s = streams.get(view.getUint8(0));
      if (!s) return;
      if (view.getUint8(1) === 3) s.audio?.push(e.data);
      else s.player.push(e.data);
      return;
    }

    const msg = JSON.parse(e.data);

    if (msg.type === 'state') {
      participants = msg.participants ?? [];
      lastRoomState = msg.room ?? null;

      $('roomPill').textContent = `${lastRoomState?.locked ? '🔒 ' : ''}${lastRoomState?.name ?? ''}`;
      $('roomSettings').hidden = lastRoomState?.ownerId !== session?.user?.id;
      $('roomSettings').classList.toggle('on', Boolean(lastRoomState?.locked));

      const live = new Set((msg.streams ?? []).map((s) => s.slot));
      for (const s of msg.streams ?? []) {
        const info = available.get(s.slot) ?? { userId: s.userId, config: null };
        info.watchers = s.watchers ?? [];
        available.set(s.slot, info);
      }
      for (const slot of [...available.keys()]) if (!live.has(slot)) available.delete(slot);
      for (const slot of [...streams.keys()]) if (!live.has(slot)) closeStream(slot);
      for (const slot of [...watching]) if (!live.has(slot)) watching.delete(slot);
      renderGrid();
      renderBar();
    } else if (msg.type === 'stream-start') {
      available.set(msg.slot, { userId: msg.userId, config: null });
      watching.delete(msg.slot);
      closeStream(msg.slot);
      renderGrid();
    } else if (msg.type === 'config') {
      const info = available.get(msg.slot);
      if (info) info.config = msg.config;
      if (watching.has(msg.slot)) {
        openStream(msg.slot, info?.userId ?? msg.slot);
        startStream(msg.slot, msg.config);
      }
    } else if (msg.type === 'audio-config') {
      if (watching.has(msg.slot)) startAudio(msg.slot, msg.config);
    } else if (msg.type === 'stream-stop') {
      available.delete(msg.slot);
      watching.delete(msg.slot);
      endStream(msg.slot);
    } else if (msg.type === 'room-gone') {
      roomTokens = null;
      if (inDiscord) {
        limparSala();
        entrarNaCall();
      } else {
        toast('A sala foi fechada.', true);
        showLobby();
      }
    } else if (msg.type === 'error') {
      toast(msg.message, true);
    }
  });

  ws.addEventListener('close', () => {
    closeAllStreams();
    available.clear();
    watching.clear();
    participants = [];
    renderGrid();

    if (!roomTokens) return;

    if (!abriu) {
      const id = roomInfo?.id;
      limparSala();
      if (id) remove(`sala:${id}`);
      toast('Sua sessão expirou. Entrando de novo…');
      if (inDiscord) entrarNaCall();
      else showLobby();
      return;
    }

    setEmpty('Reconectando…', 'A conexão com a sala caiu.');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
  });

  ws.addEventListener('error', () => ws.close());
}

function iAmBroadcasting() {
  if (myBroadcast) return true;
  return participants.some((p) => p.broadcasting && p.id === session?.user?.id);
}

function stopMyBroadcast() {
  myBroadcast?.stop();
  myBroadcast = null;
  if (participants.some((p) => p.broadcasting && p.id === session?.user?.id)) {
    ws?.send(JSON.stringify({ type: 'stop-broadcast' }));
  }
}

$('share').addEventListener('click', () => {
  if (!session) return;

  if (iAmBroadcasting()) {
    stopMyBroadcast();
    renderBar();
    return;
  }

  openModal('start');
});

let modalMode = 'start';

function openModal(mode) {
  modalMode = mode;
  const live = mode === 'live';

  $('modalTitle').textContent = live ? 'Ajustes da transmissão' : 'Compartilhar sua tela';
  $('modalSub').textContent = live
    ? 'Vale na hora, sem derrubar quem está assistindo.'
    : 'Escolha a tela e comece a transmitir.';
  $('modalGo').textContent = live ? 'Aplicar' : 'Compartilhar tela';
  $('modalSwap').hidden = !live;
  $('modalNote').hidden = live;

  $('modalSom').hidden = !live || !myBroadcast;
  if (live && myBroadcast) {
    $('modalSom').textContent = myBroadcast.temSom()
      ? 'Trocar a aba do som'
      : 'Som de uma aba';

    const s = myBroadcast.getSettings();
    $('mQuality').value = String(s.bitrate);
    $('mFps').value = String(s.fps);
  }

  $('modal').hidden = false;
}

$('liveSettings').addEventListener('click', () => openModal('live'));

function renderVolume() {
  const pct = Math.round(volume * 100);
  $('volume').value = String(pct);
  $('volumeVal').textContent = pct + '%';

  const rotulo = volume === 0 ? 'Ligar o som' : 'Silenciar';
  $('mute').setAttribute('aria-label', rotulo);
  $('mute').title = rotulo;
  $('mute').classList.toggle('on', volume === 0);
  $('muteOn').hidden = volume === 0;
  $('muteOff').hidden = volume !== 0;
}

function setVolume(valor) {
  volume = Math.min(1, Math.max(0, valor));
  if (volume > 0) volumeAntes = volume;
  store('volume', String(volume));
  for (const slot of streams.keys()) aplicarVolume(slot);
  renderVolume();
}

$('mute').addEventListener('click', () => setVolume(volume === 0 ? volumeAntes : 0));
$('volume').addEventListener('input', (e) => setVolume(Number(e.target.value) / 100));

$('modalSwap').addEventListener('click', async () => {
  if (!myBroadcast) return;
  try {
    await myBroadcast.changeScreen();
    closeModal();
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast(err.message, true);
  }
});

$('modalSom').addEventListener('click', async () => {
  if (!myBroadcast) return;
  try {
    await myBroadcast.trocarSom();
    toast('Som ligado, vindo da aba escolhida.');
    closeModal();
    renderBar();
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast(err.message, true);
  }
});

const closeModal = () => {
  $('modal').hidden = true;
};

async function broadcastFromHere() {
  if (!navigator.mediaDevices?.getDisplayMedia || !window.VideoEncoder) return false;

  if (!roomTokens) return false;
  const shareToken = new URL(roomTokens.shareUrl).searchParams.get('t');
  if (!shareToken) return false;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';

  const b = createBroadcaster({
    wsUrl: `${proto}://${location.host}${P}/ws?t=${encodeURIComponent(shareToken)}`,
    bitrate: Number($('mQuality').value),
    fps: Number($('mFps').value),
    audio: $('mAudio').checked,
    onAviso: (m) => toast(m, true),
    onEnd: () => {
      myBroadcast = null;
      renderBar();
    },
  });

  const startedAt = performance.now();
  try {
    await b.start();
    myBroadcast = b;
    closeModal();
    renderBar();
    return true;
  } catch (err) {
    const showedPicker = performance.now() - startedAt > 250;
    if (err.name === 'NotAllowedError' && showedPicker) {
      closeModal();
      return true;
    }
    return false;
  }
}

$('modalCancel').addEventListener('click', closeModal);

$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) closeModal();
});

$('modalGo').addEventListener('click', async () => {
  if (modalMode === 'live') {
    myBroadcast?.setQuality({
      bitrate: Number($('mQuality').value),
      fps: Number($('mFps').value),
    });
    closeModal();
    return;
  }

  if (await broadcastFromHere()) return;

  closeModal();

  const url = new URL(roomTokens.shareUrl);
  url.searchParams.set('q', $('mQuality').value);
  url.searchParams.set('fps', $('mFps').value);
  url.searchParams.set('som', $('mAudio').checked ? '1' : '0');

  if (inDiscord) {
    try {
      const res = await sdk.commands.openExternalLink({ url: url.toString() });
      if (res?.opened === false) {
        toast('Você recusou abrir o link. Sem isso não dá para capturar a tela.', true);
        return;
      }
    } catch (err) {
      toast(`Não foi possível abrir o link: ${err.message}`, true);
      return;
    }
  } else {
    window.open(url.toString(), '_blank');
  }
});

$('newRoom').addEventListener('click', () => {
  if (!session) return;
  $('createName').value = '';
  $('createPass').value = '';
  $('createModal').hidden = false;

  $('createName').focus();
});

$('createCancel').addEventListener('click', () => ($('createModal').hidden = true));
$('createModal').addEventListener('click', (e) => {
  if (e.target === $('createModal')) $('createModal').hidden = true;
});

$('createGo').addEventListener('click', async () => {
  const name = $('createName').value.trim();

  try {
    const tokens = await post(`${P}/api/rooms/create`, {
      identity: session.identity,
      name,
      password: $('createPass').value || null,
    });
    $('createModal').hidden = true;
    openRoom(tokens, {
      id: tokens.roomId,
      name: name || `Sala de ${session.user.name}`,
      owner: session.user.name,
    });
  } catch (err) {
    toast(err.message, true);
  }
});

$('joinCancel').addEventListener('click', () => ($('joinModal').hidden = true));
$('joinModal').addEventListener('click', (e) => {
  if (e.target === $('joinModal')) $('joinModal').hidden = true;
});
$('joinPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('joinGo').click();
});

$('joinGo').addEventListener('click', async () => {
  if (!joinTarget) return;
  $('joinModal').hidden = true;
  await enterRoom(joinTarget, $('joinPass').value);
});

$('roomCancel').addEventListener('click', () => ($('roomModal').hidden = true));
$('roomModal').addEventListener('click', (e) => {
  if (e.target === $('roomModal')) $('roomModal').hidden = true;
});

$('roomSave').addEventListener('click', async () => {
  try {
    const r = await post(`${P}/api/rooms/password`, {
      identity: session.identity,
      roomId: roomTokens.roomId,
      password: $('roomPass').value || '',
    });
    $('roomModal').hidden = true;
    toast(r.locked ? 'Sala protegida com senha.' : 'Senha removida.');
  } catch (err) {
    toast(err.message, true);
  }
});

function openRoomSettings() {
  $('roomSub').textContent = roomInfo?.name ?? '';
  $('roomPass').value = '';
  $('roomModal').hidden = false;

  $('roomPass').focus();
}

$('roomSettings').addEventListener('click', openRoomSettings);

$('settings').addEventListener('click', () => {
  const panel = $('panel');
  panel.hidden = !panel.hidden;
  $('settings').classList.toggle('on', !panel.hidden);
});

$('fullscreen').addEventListener('click', () => {
  if (activeSlot === null) return;
  telaCheia = !telaCheia;
  renderGrid();
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;

  for (const id of ['profileModal', 'roomModal', 'joinModal', 'createModal', 'modal']) {
    if (!$(id).hidden) {
      $(id).hidden = true;
      return;
    }
  }

  if (telaCheia) {
    telaCheia = false;
    renderGrid();
  }
});

$('probe').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('getDisplayMedia nem existe neste contexto — iframe sem permissão.', true);
    return;
  }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
    toast('Funcionou! O iframe permite captura direta — dá para dispensar a aba externa.');
  } catch (err) {
    toast(`Bloqueado (${err.name}): ${err.message}`, true);
  }
});
