const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const requestedRoom = params.get('sala') || '';
const room = requestedRoom.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || randomRoom();
if (room !== requestedRoom) { params.set('sala', room); history.replaceState({}, '', `${location.pathname}?${params}`); }

const ui = {
  layout: document.querySelector('.layout'), connectionDot: $('connection-dot'), connectionLabel: $('connection-label'),
  roomCodeSide: $('room-code-side'), peopleCount: $('people-count'), participantList: $('participant-list'),
  stage: $('stage'), stageTitle: $('stage-title'), stageSubtitle: $('stage-subtitle'), stageHint: $('stage-hint'),
  waitingAvatar: $('waiting-avatar'), mediaGrid: $('media-grid'), localVideo: $('local-video'),
  screenLabel: $('screen-label'), callClock: $('call-clock'), caption: $('control-caption'),
  messageInput: $('message-input'), sendButton: $('send-button'), chatBody: $('chat-body'),
  toast: $('toast'), systemMessage: $('system-message'), installButton: $('install-button'), themeSelect: $('theme-select')
};

ui.roomCodeSide.textContent = room;
const peers = new Map();
const participants = new Set();
let ws, clientId = '', connected = false, roomJoined = false;
let audioTrack = null, cameraTrack = null, screenTrack = null;
let toastTimer, callTimer, callStartedAt, unread = 0;
let reconnectTimer = null, reconnectAttempts = 0, socketGeneration = 0, intentionalLeave = false;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

function randomRoom() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `sala-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}
function showToast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('visible'), 3200);
}
function setConnection(text, state = '') {
  ui.connectionLabel.textContent = text;
  ui.connectionDot.className = `live-dot ${state}`;
}
function applyTheme(theme, save = true) {
  const selected = ['light', 'dark', 'navy'].includes(theme) ? theme : 'dark';
  document.body.dataset.theme = selected;
  ui.themeSelect.value = selected;
  const colors = { light: '#f7f8fc', dark: '#1e1f22', navy: '#081a2a' };
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors[selected]);
  if (save) {
    try { localStorage.setItem('caemgamo-theme', selected); } catch { /* armazenamento indisponível */ }
  }
}
try { applyTheme(localStorage.getItem('caemgamo-theme') || 'dark', false); }
catch { applyTheme('dark', false); }
ui.themeSelect.addEventListener('change', () => applyTheme(ui.themeSelect.value));

function updateParticipants() {
  const count = participants.size + 1;
  ui.peopleCount.textContent = `${count}/15`;
  ui.participantList.replaceChildren();
  [...participants].sort().forEach((id, index) => {
    const row = document.createElement('div');
    row.className = 'person-row';
    const avatar = document.createElement('span');
    avatar.className = 'person-avatar guest-avatar';
    avatar.textContent = String(index + 1);
    const name = document.createElement('span');
    name.className = 'person-name';
    name.textContent = `Pessoa ${index + 1}`;
    name.title = id;
    const status = document.createElement('span');
    status.className = 'person-status';
    status.setAttribute('aria-label', 'Na sala');
    row.append(avatar, name, status);
    ui.participantList.append(row);
  });

  ui.stageTitle.textContent = count > 1 ? `${count} pessoas na sala` : 'Sua sala está pronta';
  ui.stageSubtitle.textContent = count > 1
    ? 'O microfone, a câmera e a tela podem ser ativados quando quiser.'
    : 'Ative o microfone ou compartilhe sua tela mesmo sozinho.';
  ui.stageHint.textContent = count > 1 ? `${count} de 15 participantes` : 'Controles disponíveis • aguardando pessoas';
  ui.waitingAvatar.textContent = count > 1 ? String(count) : '+';
  ui.waitingAvatar.classList.toggle('guest-avatar', count > 1);
  ui.caption.textContent = participants.size
    ? 'Seus controles de áudio, câmera e tela estão disponíveis.'
    : 'Você pode ligar e desligar o microfone e iniciar a transmissão a qualquer momento.';
  for (const id of ['mic-button', 'camera-button', 'share-button', 'leave-button']) $(id).disabled = !roomJoined;
  if (roomJoined) setConnection(`Sala conectada · ${count}/15`, 'connected');
  updateStage();
  updateChatState();
}

function updateChatState() {
  const available = [...peers.values()].some((peer) => peer.channel?.readyState === 'open');
  ui.messageInput.disabled = !available;
  ui.sendButton.disabled = !available || !ui.messageInput.value.trim();
}

function updateStage() {
  ui.stage.classList.toggle('has-media', peers.size > 0);
  ui.stage.classList.toggle('solo-sharing', Boolean(screenTrack && participants.size === 0));
  ui.screenLabel.hidden = !screenTrack;
  const previewTrack = screenTrack || (cameraTrack?.enabled ? cameraTrack : null);
  if (previewTrack?.readyState === 'live') {
    const currentTrack = ui.localVideo.srcObject?.getVideoTracks?.()[0];
    if (currentTrack !== previewTrack) ui.localVideo.srcObject = new MediaStream([previewTrack]);
    ui.localVideo.hidden = false;
  } else {
    ui.localVideo.hidden = true;
    ui.localVideo.srcObject = null;
  }
}

function createPeerTile(peerId) {
  const tile = document.createElement('article');
  tile.className = 'media-tile';
  const avatar = document.createElement('div');
  avatar.className = 'media-avatar';
  avatar.textContent = 'P';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.hidden = true;
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  audio.setAttribute('aria-label', 'Áudio do participante');
  const label = document.createElement('span');
  label.className = 'media-name';
  label.textContent = 'Pessoa';
  label.title = peerId;
  tile.append(avatar, video, audio, label);
  ui.mediaGrid.append(tile);
  return { tile, avatar, video, audio, label };
}

function updatePeerTile(peer) {
  const videoTrack = peer.remoteStream.getVideoTracks().find((track) => track.readyState === 'live');
  peer.ui.video.hidden = !videoTrack;
  peer.ui.tile.classList.toggle('has-video', Boolean(videoTrack));
  peer.ui.avatar.hidden = Boolean(videoTrack);
  peer.ui.video.srcObject = peer.remoteStream;
  peer.ui.audio.srcObject = peer.remoteStream;
  peer.ui.video.play().catch(() => {});
  peer.ui.audio.play().catch(() => {});
}

function ensurePeer(peerId, initiator = false) {
  if (!peerId || peerId === clientId) return null;
  let peer = peers.get(peerId);
  if (peer) {
    if (initiator) startOffer(peer).catch((error) => showToast(`Falha ao conectar participante: ${error.message}`));
    return peer;
  }

  const pc = new RTCPeerConnection({ iceServers });
  const audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
  const videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
  peer = {
    id: peerId, pc, senders: { audio: audioSender, video: videoSender },
    channel: null, pendingCandidates: [], remoteStream: new MediaStream(), ui: createPeerTile(peerId),
    offerStarted: false, closed: false
  };
  peers.set(peerId, peer);
  updatePeerTile(peer);

  pc.onicecandidate = (event) => { if (event.candidate) sendSignal(peerId, { candidate: event.candidate }); };
  pc.ontrack = (event) => {
    if (!peer.remoteStream.getTracks().includes(event.track)) peer.remoteStream.addTrack(event.track);
    event.track.addEventListener('unmute', () => updatePeerTile(peer));
    event.track.addEventListener('mute', () => updatePeerTile(peer));
    event.track.addEventListener('ended', () => updatePeerTile(peer));
    updatePeerTile(peer);
  };
  pc.ondatachannel = (event) => bindChannel(peer, event.channel);
  pc.onconnectionstatechange = () => {
    if (peer.closed) return;
    if (pc.connectionState === 'connected') startClock();
    if (pc.connectionState === 'failed') showToast('Não foi possível conectar uma pessoa. Verifique a rede e tente novamente.');
    if (pc.connectionState === 'disconnected') setConnection('Reconectando mídia…', '');
    if (pc.connectionState === 'connected' && roomJoined) setConnection(`Sala conectada · ${participants.size + 1}/15`, 'connected');
  };
  syncPeerTracks(peer).catch(() => {});
  if (initiator) startOffer(peer).catch((error) => showToast(`Falha ao iniciar conexão: ${error.message}`));
  updateStage();
  return peer;
}

async function syncPeerTracks(peer) {
  if (peer.closed) return;
  await peer.senders.audio.replaceTrack(audioTrack?.enabled ? audioTrack : null);
  await peer.senders.video.replaceTrack(screenTrack || (cameraTrack?.enabled ? cameraTrack : null));
}

async function syncTrackToPeers(kind, track) {
  const updates = [...peers.values()].map((peer) => peer.senders[kind].replaceTrack(track).catch(() => {}));
  await Promise.all(updates);
}

async function startOffer(peer) {
  if (peer.closed || peer.offerStarted || peer.pc.signalingState !== 'stable') return;
  peer.offerStarted = true;
  if (!peer.channel) bindChannel(peer, peer.pc.createDataChannel('mensagens'));
  await syncPeerTracks(peer);
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  sendSignal(peer.id, { description: peer.pc.localDescription });
}

function bindChannel(peer, channel) {
  peer.channel = channel;
  channel.onopen = () => {
    updateChatState();
    ui.systemMessage.textContent = 'Conexão segura estabelecida. As mensagens são enviadas diretamente às pessoas da sala.';
  };
  channel.onclose = updateChatState;
  channel.onerror = updateChatState;
  channel.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'chat' && typeof data.text === 'string') addMessage(data.text, false, data.at, peer.id);
    } catch { /* ignora mensagens fora do formato esperado */ }
  };
  updateChatState();
}

function closePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.closed = true;
  peer.channel?.close();
  peer.pc.close();
  peer.ui.tile.remove();
  peers.delete(peerId);
  updateStage();
  updateChatState();
}

function clearPeers() {
  for (const id of [...peers.keys()]) closePeer(id);
  participants.clear();
  updateParticipants();
}

function connect() {
  if (intentionalLeave || (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN))) return;
  const generation = ++socketGeneration;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  ws = socket;
  setConnection(reconnectAttempts ? 'Reconectando…' : 'Conectando à sala…');
  socket.addEventListener('open', () => {
    if (socket !== ws || generation !== socketGeneration) return;
    connected = true;
    reconnectAttempts = 0;
    socket.send(JSON.stringify({ type: 'join', room }));
    setConnection('Entrando na sala…');
  });
  socket.addEventListener('message', async (event) => {
    if (socket !== ws || generation !== socketGeneration) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'joined') {
      clientId = String(message.clientId || '');
      if (Array.isArray(message.iceServers) && message.iceServers.length) iceServers = message.iceServers;
      roomJoined = true;
      participants.clear();
      for (const id of message.participants || []) {
        if (id !== clientId) participants.add(String(id));
      }
      updateParticipants();
      for (const id of participants) ensurePeer(id, clientId < id);
      if (!participants.size) ui.systemMessage.textContent = 'Você já pode ativar o microfone ou transmitir sua tela. As outras pessoas ouvirão e verão a transmissão ao entrar.';
    } else if (message.type === 'peer-joined') {
      const peerId = String(message.peerId || '');
      if (!peerId || peerId === clientId) return;
      participants.add(peerId);
      updateParticipants();
      ensurePeer(peerId, Boolean(message.initiator));
      ui.systemMessage.textContent = 'Uma pessoa entrou na sala. O microfone, a câmera e a transmissão podem ser usados quando quiser.';
    } else if (message.type === 'peer-left') {
      const peerId = String(message.peerId || '');
      participants.delete(peerId);
      closePeer(peerId);
      updateParticipants();
      showToast('Uma pessoa saiu da sala. Seus controles continuam disponíveis.');
    } else if (message.type === 'signal') {
      try { await handleSignal(String(message.from || ''), message.data); }
      catch (error) { showToast(`Falha ao conectar: ${error.message}`); }
    } else if (message.type === 'full') {
      roomJoined = false;
      updateParticipants();
      setConnection('Sala cheia · máximo 15 pessoas', 'error');
      showToast('Esta sala já atingiu o limite de 15 participantes.');
    } else if (message.type === 'error') {
      setConnection('Não foi possível entrar', 'error');
      showToast(message.message || 'Erro ao entrar na sala.');
    }
  });
  socket.addEventListener('close', () => {
    if (socket !== ws || generation !== socketGeneration) return;
    connected = false;
    roomJoined = false;
    clearPeers();
    updateStage();
    for (const id of ['mic-button', 'camera-button', 'share-button', 'leave-button']) $(id).disabled = true;
    if (!intentionalLeave) scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    if (socket === ws) setConnection('Servidor indisponível', 'error');
  });
}

function scheduleReconnect() {
  if (intentionalLeave || reconnectTimer) return;
  const baseDelay = Math.min(30_000, 1000 * (2 ** Math.min(reconnectAttempts, 5)));
  const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
  reconnectAttempts++;
  setConnection('Reconectando…');
  ui.caption.textContent = 'A conexão caiu. Tentando entrar na sala novamente…';
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function sendSignal(peerId, data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'signal', data: { to: peerId, payload: data } }));
  }
}

async function handleSignal(peerId, data) {
  if (!peerId || !data) return;
  const peer = ensurePeer(peerId, false);
  if (!peer) return;
  if (data.description) {
    await peer.pc.setRemoteDescription(data.description);
    for (const candidate of peer.pendingCandidates) await peer.pc.addIceCandidate(candidate);
    peer.pendingCandidates = [];
    if (data.description.type === 'offer') {
      await syncPeerTracks(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      sendSignal(peerId, { description: peer.pc.localDescription });
    }
  } else if (data.candidate) {
    if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
    else peer.pendingCandidates.push(data.candidate);
  }
}

function updateMediaButton(id, active, onText, offText) {
  const button = $(id);
  button.classList.toggle('active', active);
  button.lastElementChild.textContent = active ? onText : offText;
}

async function toggleMic() {
  if (!roomJoined) return;
  try {
    if (!audioTrack) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioTrack = stream.getAudioTracks()[0];
      audioTrack.enabled = true;
    } else {
      audioTrack.enabled = !audioTrack.enabled;
    }
    await syncTrackToPeers('audio', audioTrack.enabled ? audioTrack : null);
    updateMediaButton('mic-button', audioTrack.enabled, 'Microfone ligado', 'Microfone desligado');
    showToast(audioTrack.enabled ? 'Microfone ligado.' : 'Microfone desligado.');
  } catch (error) {
    showToast(error.name === 'NotAllowedError' ? 'Permita o acesso ao microfone no navegador.' : 'Não foi possível acessar o microfone.');
  }
}

async function toggleCamera() {
  if (!roomJoined) return;
  try {
    if (!cameraTrack) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      cameraTrack = stream.getVideoTracks()[0];
      cameraTrack.enabled = true;
    } else {
      cameraTrack.enabled = !cameraTrack.enabled;
    }
    if (!screenTrack) await syncTrackToPeers('video', cameraTrack.enabled ? cameraTrack : null);
    updateMediaButton('camera-button', Boolean(cameraTrack?.enabled), 'Câmera ligada', 'Câmera desligada');
    updateStage();
  } catch (error) {
    showToast(error.name === 'NotAllowedError' ? 'Permita o acesso à câmera no navegador.' : 'Não foi possível acessar a câmera.');
  }
}

async function toggleScreen() {
  if (!roomJoined) return;
  if (screenTrack) { await stopScreenShare(); return; }
  if (!navigator.mediaDevices?.getDisplayMedia || !window.isSecureContext) {
    showToast(window.isSecureContext ? 'Este navegador não permite compartilhar a tela.' : 'A tela só pode ser compartilhada em uma conexão HTTPS segura.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    screenTrack = stream.getVideoTracks()[0];
    await syncTrackToPeers('video', screenTrack);
    updateMediaButton('share-button', true, 'Parar transmissão', 'Compartilhar tela');
    screenTrack.addEventListener('ended', () => stopScreenShare().catch(() => {}), { once: true });
    updateStage();
    ui.systemMessage.textContent = participants.size
      ? 'Sua tela está sendo transmitida para as pessoas da sala.'
      : 'Sua tela está pronta para transmissão; quem entrar na sala poderá vê-la.';
  } catch (error) {
    if (error.name !== 'NotAllowedError') showToast('Não foi possível iniciar o compartilhamento de tela.');
  }
}

async function stopScreenShare() {
  if (!screenTrack) return;
  const track = screenTrack;
  screenTrack = null;
  track.stop();
  await syncTrackToPeers('video', cameraTrack?.enabled ? cameraTrack : null);
  updateMediaButton('share-button', false, 'Parar transmissão', 'Compartilhar tela');
  updateStage();
}

function startClock() {
  if (callTimer) return;
  callStartedAt = Date.now();
  ui.callClock.hidden = false;
  callTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartedAt) / 1000);
    ui.callClock.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  }, 1000);
}

function stopLocalMedia() {
  for (const track of [audioTrack, cameraTrack, screenTrack]) track?.stop();
  audioTrack = cameraTrack = screenTrack = null;
  updateMediaButton('mic-button', false, 'Microfone ligado', 'Microfone');
  updateMediaButton('camera-button', false, 'Câmera ligada', 'Câmera');
  updateMediaButton('share-button', false, 'Parar transmissão', 'Compartilhar tela');
  updateStage();
}

function addMessage(text, mine, at = Date.now(), senderId = '') {
  const row = document.createElement('div');
  row.className = `message${mine ? ' mine' : ''}`;
  const author = document.createElement('span');
  author.className = 'message-author';
  author.textContent = mine ? 'Você' : `Pessoa ${Math.max(1, [...participants].sort().indexOf(senderId) + 1)}`;
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;
  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  row.append(author, bubble, time);
  ui.chatBody.append(row);
  ui.chatBody.scrollTop = ui.chatBody.scrollHeight;
  if (!mine && window.matchMedia('(max-width: 820px)').matches && !ui.layout.classList.contains('show-chat')) {
    unread++;
    const badge = $('unread-count');
    badge.hidden = false;
    badge.textContent = String(unread);
  }
}

function sendMessage(event) {
  event.preventDefault();
  const text = ui.messageInput.value.trim();
  if (!text) return;
  const message = JSON.stringify({ type: 'chat', text, at: Date.now() });
  const openChannels = [...peers.values()].map((peer) => peer.channel).filter((channel) => channel?.readyState === 'open');
  if (!openChannels.length) return;
  for (const channel of openChannels) channel.send(message);
  addMessage(text, true);
  ui.messageInput.value = '';
  ui.messageInput.style.height = '33px';
  updateChatState();
}

ui.messageInput.addEventListener('input', () => {
  ui.messageInput.style.height = '33px';
  ui.messageInput.style.height = `${Math.min(ui.messageInput.scrollHeight, 100)}px`;
  updateChatState();
});
ui.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('message-form').requestSubmit(); }
});
$('message-form').addEventListener('submit', sendMessage);
$('mic-button').addEventListener('click', toggleMic);
$('camera-button').addEventListener('click', toggleCamera);
$('share-button').addEventListener('click', toggleScreen);
$('leave-button').addEventListener('click', () => {
  intentionalLeave = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  roomJoined = false;
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  clearPeers();
  stopLocalMedia();
  setConnection('Você saiu da sala');
  ui.caption.textContent = 'Recarregue a página para entrar novamente.';
  for (const id of ['mic-button', 'camera-button', 'share-button', 'leave-button']) $(id).disabled = true;
});

async function copyText(text, labelButton) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    document.execCommand('copy');
    field.remove();
  }
  if (labelButton) {
    const old = labelButton.textContent;
    labelButton.textContent = 'Copiado!';
    setTimeout(() => labelButton.textContent = old, 1800);
  } else showToast('Convite copiado. Envie para alguém entrar na sala.');
}
$('copy-invite').addEventListener('click', () => copyText(location.href));
$('copy-code').addEventListener('click', () => copyText(room, $('copy-code-label')));

document.querySelectorAll('.mobile-tab').forEach((button) => button.addEventListener('click', () => {
  const chat = button.dataset.tab === 'chat';
  ui.layout.classList.toggle('show-chat', chat);
  document.querySelectorAll('.mobile-tab').forEach((tab) => tab.classList.toggle('selected', tab === button));
  if (chat) { unread = 0; $('unread-count').hidden = true; }
}));

let installPrompt;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  ui.installButton.hidden = false;
});
ui.installButton.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  ui.installButton.hidden = true;
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
updateParticipants();
connect();
