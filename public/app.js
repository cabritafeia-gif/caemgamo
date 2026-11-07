const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const requestedRoom = params.get('sala') || '';
const requestedChannel = params.get('canal') || '';
const room = requestedRoom.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || randomRoom();
if (room !== requestedRoom) { params.set('sala', room); history.replaceState({}, '', `${location.pathname}?${params}${location.hash}`); }

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
const audioBlockedPeers = new Set();
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
window.CAEMGAMO_TOAST = showToast;
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
window.CAEMGAMO_APPLY_THEME = applyTheme;
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
  const communityChat = window.CaemgamoCommunity?.canSend === true;
  ui.messageInput.disabled = !available && !communityChat;
  ui.sendButton.disabled = (!available && !communityChat) || !ui.messageInput.value.trim();
  for (const id of ['sticker-button', 'gift-button', 'upload-audio-button', 'record-audio-button']) if ($(id)) $(id).disabled = !communityChat;
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
  const status = document.createElement('span');
  status.className = 'media-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Conectando mídia…';
  tile.append(avatar, video, audio, label, status);
  ui.mediaGrid.append(tile);
  return { tile, avatar, video, audio, label, status };
}

function updatePeerTile(peer) {
  const videoTrack = peer.remoteStream.getVideoTracks().find((track) => track.readyState === 'live');
  peer.ui.video.hidden = !videoTrack;
  peer.ui.tile.classList.toggle('has-video', Boolean(videoTrack));
  peer.ui.avatar.hidden = Boolean(videoTrack);
  peer.ui.video.srcObject = peer.remoteStream;
  peer.ui.audio.srcObject = peer.remoteStream;
  const state = peer.mediaState;
  peer.ui.status.textContent = state
    ? `${state.audio ? '🎙 Microfone ligado' : '🔇 Microfone desligado'} · ${state.sharing ? '▣ Transmitindo tela' : state.video ? '▣ Câmera ligada' : 'Câmera desligada'}`
    : 'Aguardando estado dos controles…';
  peer.ui.video.play().catch(() => {});
  playPeerAudio(peer);
}

function updateAudioUnlockButton() {
  const button = $('enable-audio-button');
  button.hidden = audioBlockedPeers.size === 0;
  button.setAttribute('aria-label', 'Permitir reprodução do áudio dos participantes');
}

async function playPeerAudio(peer) {
  if (!peer.remoteStream.getAudioTracks().some((track) => track.readyState === 'live')) {
    audioBlockedPeers.delete(peer.id);
    updateAudioUnlockButton();
    return;
  }
  try {
    await peer.ui.audio.play();
    audioBlockedPeers.delete(peer.id);
    updateAudioUnlockButton();
  } catch (error) {
    if (error.name === 'NotAllowedError') {
      audioBlockedPeers.add(peer.id);
      updateAudioUnlockButton();
      ui.systemMessage.textContent = 'O navegador bloqueou o áudio automático. Clique em “Ativar áudio dos participantes” para ouvir.';
    } else {
      showToast('Não foi possível reproduzir o áudio recebido. Confira a saída de som do dispositivo.');
    }
  }
}

async function enableRemoteAudio() {
  const failures = [];
  for (const peer of peers.values()) {
    if (!peer.remoteStream.getAudioTracks().some((track) => track.readyState === 'live')) continue;
    try {
      await peer.ui.audio.play();
      audioBlockedPeers.delete(peer.id);
    } catch { failures.push(peer.id); }
  }
  audioBlockedPeers.clear();
  for (const id of failures) audioBlockedPeers.add(id);
  updateAudioUnlockButton();
  if (failures.length) showToast('Ainda não foi possível liberar o áudio. Confira as permissões e o volume do navegador.');
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
    polite: clientId > peerId, makingOffer: false, ignoreOffer: false, mediaState: null,
    iceRestarts: 0, iceRestartTimer: null, closed: false
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
    if (pc.connectionState === 'failed') scheduleIceRestart(peer, true);
    if (pc.connectionState === 'disconnected') {
      setConnection('Reconectando áudio e vídeo…', '');
      scheduleIceRestart(peer);
    }
    if (pc.connectionState === 'connected' && roomJoined) setConnection(`Sala conectada · ${participants.size + 1}/15`, 'connected');
    if (pc.connectionState === 'connected') {
      peer.iceRestarts = 0;
      clearTimeout(peer.iceRestartTimer);
      peer.iceRestartTimer = null;
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (peer.closed) return;
    if (pc.iceConnectionState === 'failed') scheduleIceRestart(peer, true);
    else if (pc.iceConnectionState === 'disconnected') scheduleIceRestart(peer);
    else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      peer.iceRestarts = 0;
      clearTimeout(peer.iceRestartTimer);
      peer.iceRestartTimer = null;
    }
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
  const updates = [...peers.values()].map((peer) => peer.senders[kind].replaceTrack(track));
  const results = await Promise.allSettled(updates);
  if (results.some((result) => result.status === 'rejected')) {
    throw Object.assign(new Error('A faixa não foi enviada aos participantes.'), { name: 'TrackSyncError' });
  }
}

async function startOffer(peer, iceRestart = false) {
  if (peer.closed || peer.makingOffer || peer.pc.signalingState !== 'stable') return false;
  peer.makingOffer = true;
  try {
    if (!peer.channel) bindChannel(peer, peer.pc.createDataChannel('mensagens'));
    await syncPeerTracks(peer);
    const offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await peer.pc.setLocalDescription(offer);
    sendSignal(peer.id, { description: peer.pc.localDescription });
    return true;
  } finally {
    peer.makingOffer = false;
  }
}

function scheduleIceRestart(peer, immediate = false) {
  if (peer.closed || peer.iceRestartTimer) return;
  if (clientId > peer.id) return;
  if (peer.iceRestarts >= 3) {
    setConnection('Mídia interrompida · verifique a rede e tente novamente', 'error');
    showToast('A conexão de áudio e vídeo foi interrompida. Saia e entre novamente na sala.');
    return;
  }
  const delay = immediate ? 0 : 1800;
  peer.iceRestartTimer = setTimeout(async () => {
    peer.iceRestartTimer = null;
    if (peer.closed || peer.pc.connectionState === 'connected') return;
    peer.iceRestarts++;
    try {
      const offered = await startOffer(peer, true);
      if (!offered && peer.pc.signalingState !== 'stable') {
        peer.iceRestarts--;
        peer.iceRestartTimer = setTimeout(() => {
          peer.iceRestartTimer = null;
          scheduleIceRestart(peer, true);
        }, 1000);
        return;
      }
      peer.iceRestartTimer = setTimeout(() => {
        peer.iceRestartTimer = null;
        if (peer.pc.connectionState !== 'connected') scheduleIceRestart(peer, true);
      }, 6000);
    } catch {
      if (peer.iceRestarts >= 3) {
        setConnection('Mídia interrompida · verifique a rede e tente novamente', 'error');
        showToast('Não foi possível restabelecer a chamada. Confira a rede, STUN/TURN e tente novamente.');
      } else scheduleIceRestart(peer, true);
    }
  }, delay);
}

function bindChannel(peer, channel) {
  peer.channel = channel;
  channel.onopen = () => {
    broadcastMediaState();
    updateChatState();
    ui.systemMessage.textContent = 'Conexão segura estabelecida. As mensagens são enviadas diretamente às pessoas da sala.';
  };
  channel.onclose = () => { peer.mediaState = null; updatePeerTile(peer); updateChatState(); };
  channel.onerror = () => { peer.mediaState = null; updatePeerTile(peer); updateChatState(); };
  channel.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'chat' && typeof data.text === 'string') addMessage(data.text, false, data.at, peer.id);
      if (data.type === 'media-state' && typeof data.audio === 'boolean' && typeof data.video === 'boolean' && typeof data.sharing === 'boolean') {
        peer.mediaState = data;
        updatePeerTile(peer);
      }
    } catch { /* ignora mensagens fora do formato esperado */ }
  };
  updateChatState();
}

function closePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.closed = true;
  clearTimeout(peer.iceRestartTimer);
  audioBlockedPeers.delete(peerId);
  updateAudioUnlockButton();
  peer.channel?.close();
  peer.pc.close();
  peer.ui.tile.remove();
  peers.delete(peerId);
  updateStage();
  updateChatState();
  if (![...peers.values()].some((activePeer) => activePeer.pc.connectionState === 'connected')) stopClock();
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
  socket.addEventListener('open', async () => {
    if (socket !== ws || generation !== socketGeneration) return;
    connected = true;
    reconnectAttempts = 0;
    if (requestedChannel) {
      try { await window.CaemgamoCommunity?.ready; } catch { /* o servidor recusará canais sem autenticação válida */ }
    }
    if (socket !== ws || generation !== socketGeneration || socket.readyState !== WebSocket.OPEN) return;
    const accessToken = await window.CaemgamoCommunity?.getAccessToken?.();
    socket.send(JSON.stringify({ type: 'join', room, channelId: requestedChannel || '', accessToken: accessToken || '' }));
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
    const offerCollision = data.description.type === 'offer'
      && (peer.makingOffer || peer.pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;
    if (offerCollision) await peer.pc.setLocalDescription({ type: 'rollback' });
    await peer.pc.setRemoteDescription(data.description);
    for (const candidate of peer.pendingCandidates) {
      try { await peer.pc.addIceCandidate(candidate); }
      catch (error) { if (!peer.ignoreOffer) throw error; }
    }
    peer.pendingCandidates = [];
    if (data.description.type === 'offer') {
      await syncPeerTracks(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      sendSignal(peerId, { description: peer.pc.localDescription });
    }
  } else if (data.candidate) {
    if (peer.ignoreOffer) return;
    if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
    else peer.pendingCandidates.push(data.candidate);
  }
}

function updateMediaButton(id, active, onText, offText) {
  const button = $(id);
  button.classList.toggle('active', active);
  button.setAttribute('aria-pressed', String(active));
  button.lastElementChild.textContent = active ? onText : offText;
}

function broadcastMediaState() {
  const message = JSON.stringify({
    type: 'media-state',
    audio: Boolean(audioTrack?.enabled),
    video: Boolean(screenTrack || cameraTrack?.enabled),
    sharing: Boolean(screenTrack)
  });
  for (const peer of peers.values()) {
    if (peer.channel?.readyState === 'open') {
      try { peer.channel.send(message); } catch { /* outro evento mostrará a reconexão */ }
    }
  }
}

async function toggleMic() {
  if (!roomJoined) return;
  const previousTrack = audioTrack;
  const previousEnabled = Boolean(previousTrack?.readyState === 'live' && previousTrack.enabled);
  let acquired = false;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('Conexão segura necessária'), { name: 'InsecureContextError' });
    if (!audioTrack || audioTrack.readyState !== 'live') {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) throw new Error('Nenhum microfone foi encontrado.');
      const track = audioTrack;
      track.addEventListener('ended', () => {
        if (audioTrack !== track) return;
        audioTrack = null;
        syncTrackToPeers('audio', null).catch(() => {});
        updateMediaButton('mic-button', false, 'Microfone ligado', 'Microfone desligado');
        broadcastMediaState();
        showToast('O microfone foi desconectado. Verifique o dispositivo e ative-o novamente.');
      }, { once: true });
      audioTrack.enabled = true;
      acquired = true;
    } else {
      audioTrack.enabled = !audioTrack.enabled;
    }
    await syncTrackToPeers('audio', audioTrack.enabled ? audioTrack : null);
    broadcastMediaState();
    updateMediaButton('mic-button', audioTrack.enabled, 'Microfone ligado', 'Microfone desligado');
    showToast(audioTrack.enabled ? 'Microfone ligado.' : 'Microfone desligado.');
  } catch (error) {
    if (acquired) { audioTrack?.stop(); audioTrack = null; }
    else if (audioTrack?.readyState === 'live') audioTrack.enabled = previousEnabled;
    await syncTrackToPeers('audio', previousEnabled && previousTrack?.readyState === 'live' ? previousTrack : null).catch(() => {});
    updateMediaButton('mic-button', previousEnabled, 'Microfone ligado', 'Microfone desligado');
    broadcastMediaState();
    showToast(mediaErrorMessage(error, 'microfone'));
  }
}

async function toggleCamera() {
  if (!roomJoined) return;
  const previousTrack = cameraTrack;
  const previousEnabled = Boolean(previousTrack?.readyState === 'live' && previousTrack.enabled);
  let acquired = false;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('Conexão segura necessária'), { name: 'InsecureContextError' });
    if (!cameraTrack || cameraTrack.readyState !== 'live') {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      cameraTrack = stream.getVideoTracks()[0];
      if (!cameraTrack) throw new Error('Nenhuma câmera foi encontrada.');
      const track = cameraTrack;
      track.addEventListener('ended', () => {
        if (cameraTrack !== track) return;
        cameraTrack = null;
        if (!screenTrack) syncTrackToPeers('video', null).catch(() => {});
        updateMediaButton('camera-button', false, 'Câmera ligada', 'Câmera desligada');
        broadcastMediaState();
        updateStage();
        showToast('A câmera foi desconectada. Verifique o dispositivo e ative-a novamente.');
      }, { once: true });
      cameraTrack.enabled = true;
      acquired = true;
    } else {
      cameraTrack.enabled = !cameraTrack.enabled;
    }
    if (!screenTrack) await syncTrackToPeers('video', cameraTrack.enabled ? cameraTrack : null);
    broadcastMediaState();
    updateMediaButton('camera-button', Boolean(cameraTrack?.enabled), 'Câmera ligada', 'Câmera desligada');
    updateStage();
  } catch (error) {
    if (acquired) { cameraTrack?.stop(); cameraTrack = null; }
    else if (cameraTrack?.readyState === 'live') cameraTrack.enabled = previousEnabled;
    if (!screenTrack) await syncTrackToPeers('video', previousEnabled && previousTrack?.readyState === 'live' ? previousTrack : null).catch(() => {});
    updateMediaButton('camera-button', previousEnabled, 'Câmera ligada', 'Câmera desligada');
    broadcastMediaState();
    updateStage();
    showToast(mediaErrorMessage(error, 'câmera'));
  }
}

function mediaErrorMessage(error, device) {
  if (error.name === 'TrackSyncError') return `O ${device} foi ativado, mas não conseguiu chegar às outras pessoas. Verifique a conexão e tente novamente.`;
  if (error.name === 'InsecureContextError') return `O ${device} exige HTTPS ou localhost. Abra o aplicativo pela conexão segura.`;
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return `Acesso ao ${device} negado. Clique no cadeado ao lado do endereço, permita o dispositivo e tente novamente.`;
  if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') return `Nenhum ${device} foi encontrado neste dispositivo.`;
  if (error.name === 'NotReadableError' || error.name === 'TrackStartError') return `O ${device} está ocupado ou indisponível. Feche outros aplicativos que o estejam usando.`;
  if (error.name === 'OverconstrainedError') return `O dispositivo não oferece uma configuração compatível para o ${device}.`;
  return `Não foi possível iniciar o ${device}. Verifique o dispositivo e tente novamente.`;
}

async function toggleScreen() {
  if (!roomJoined) return;
  if (screenTrack) {
    try { await stopScreenShare(); }
    catch { showToast('A transmissão parou, mas a câmera não conseguiu retomar o envio. Tente alterná-la novamente.'); }
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia || !window.isSecureContext) {
    showToast(window.isSecureContext ? 'Este navegador não permite compartilhar a tela.' : 'A tela só pode ser compartilhada em uma conexão HTTPS segura.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    screenTrack = stream.getVideoTracks()[0];
    try { await syncTrackToPeers('video', screenTrack); }
    catch (error) {
      screenTrack?.stop();
      screenTrack = null;
      throw error;
    }
    broadcastMediaState();
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
  try { await syncTrackToPeers('video', cameraTrack?.enabled ? cameraTrack : null); }
  finally {
    broadcastMediaState();
    updateMediaButton('share-button', false, 'Parar transmissão', 'Compartilhar tela');
    updateStage();
  }
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

function stopClock() {
  clearInterval(callTimer);
  callTimer = null;
  callStartedAt = null;
  ui.callClock.hidden = true;
  ui.callClock.textContent = '00:00';
}

function stopLocalMedia() {
  const tracks = [audioTrack, cameraTrack, screenTrack];
  audioTrack = cameraTrack = screenTrack = null;
  for (const track of tracks) track?.stop();
  updateMediaButton('mic-button', false, 'Microfone ligado', 'Microfone');
  updateMediaButton('camera-button', false, 'Câmera ligada', 'Câmera');
  updateMediaButton('share-button', false, 'Parar transmissão', 'Compartilhar tela');
  updateStage();
}

function addMessage(text, mine, at = Date.now(), senderId = '', displayName = '', avatarUrl = '', media = null) {
  const row = document.createElement('div');
  row.className = `message${mine ? ' mine' : ''}`;
  row.dataset.authorId = senderId;
  const avatar = avatarUrl ? document.createElement('img') : document.createElement('span');
  avatar.className = 'chat-avatar';
  if (avatarUrl) { avatar.src = avatarUrl; avatar.alt = ''; }
  else avatar.textContent = mine ? 'V' : 'P';
  const author = document.createElement('span');
  author.className = 'message-author';
  author.textContent = mine ? 'Você' : (displayName || `Pessoa ${Math.max(1, [...participants].sort().indexOf(senderId) + 1)}`);
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (media?.type === 'audio' && media.url) {
    const player = document.createElement('audio');
    player.controls = true;
    player.preload = 'none';
    player.src = media.url;
    player.setAttribute('aria-label', 'Áudio enviado no canal');
    bubble.append(player);
    if (text) { const caption = document.createElement('span'); caption.textContent = text; bubble.append(caption); }
  } else if (media?.type === 'sticker') {
    bubble.classList.add('sticker-bubble');
    bubble.textContent = text;
  } else if (media?.type === 'gift') {
    bubble.classList.add('gift-bubble');
    bubble.textContent = `🎁 ${text}`;
  } else bubble.textContent = text;
  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  row.append(avatar, author, bubble, time);
  if (media?.messageId && !mine) {
    const report = document.createElement('button');
    report.type = 'button';
    report.className = 'message-report-button';
    report.dataset.reportMessage = media.messageId;
    report.textContent = 'Denunciar';
    row.append(report);
  }
  ui.chatBody.append(row);
  ui.chatBody.scrollTop = ui.chatBody.scrollHeight;
  if (!mine && window.matchMedia('(max-width: 820px)').matches && !ui.layout.classList.contains('show-chat')) {
    unread++;
    const badge = $('unread-count');
    badge.hidden = false;
    badge.textContent = String(unread);
  }
}
window.CAEMGAMO_ADD_MESSAGE = addMessage;
window.CAEMGAMO_REFRESH_AUTHOR = (userId, displayName, avatarUrl) => {
  document.querySelectorAll(`.message[data-author-id="${CSS.escape(userId)}"]`).forEach((row) => {
    const existing = row.querySelector('.chat-avatar');
    const avatar = avatarUrl ? document.createElement('img') : document.createElement('span');
    avatar.className = 'chat-avatar';
    if (avatarUrl) { avatar.src = avatarUrl; avatar.alt = ''; }
    else avatar.textContent = (displayName || 'P').trim().slice(0, 1).toUpperCase();
    existing?.replaceWith(avatar);
    const author = row.querySelector('.message-author');
    if (author && !row.classList.contains('mine')) author.textContent = displayName || 'Participante';
  });
};
window.CAEMGAMO_UPDATE_CHAT_STATE = updateChatState;

async function sendMessage(event) {
  event.preventDefault();
  const text = ui.messageInput.value.trim();
  if (!text) return;
  if (window.CaemgamoCommunity?.activeTextChannel) {
    ui.sendButton.disabled = true;
    try {
      await window.CaemgamoCommunity.sendText(text);
      ui.messageInput.value = '';
      ui.messageInput.style.height = '33px';
    } catch (error) {
      showToast(error.message || 'Não foi possível enviar a mensagem.');
    }
    updateChatState();
    return;
  }
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
$('enable-audio-button').addEventListener('click', enableRemoteAudio);
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
  const communities = button.dataset.tab === 'communities';
  ui.layout.classList.toggle('show-chat', chat);
  ui.layout.classList.toggle('show-communities', communities);
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
if (requestedChannel) {
  setInterval(async () => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    try {
      await window.CaemgamoCommunity?.ready;
      const accessToken = await window.CaemgamoCommunity?.getAccessToken?.();
      if (accessToken && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'voice-auth-refresh', channelId: requestedChannel, accessToken }));
    } catch { /* reconexão ou renovação da sessão cuidará do próximo ciclo */ }
  }, 20_000);
}
updateParticipants();
connect();
