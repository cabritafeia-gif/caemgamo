const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const requestedRoom = params.get('sala') || '';
const room = requestedRoom.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || randomRoom();
if (room !== requestedRoom) { params.set('sala', room); history.replaceState({}, '', `${location.pathname}?${params}`); }

const ui = {
  layout: document.querySelector('.layout'), connectionDot: $('connection-dot'), connectionLabel: $('connection-label'),
  roomCodeSide: $('room-code-side'), peopleCount: $('people-count'), guestPerson: $('guest-person'),
  stage: $('stage'), stageTitle: $('stage-title'), stageSubtitle: $('stage-subtitle'), stageHint: $('stage-hint'),
  waitingAvatar: $('waiting-avatar'), remoteVideo: $('remote-video'), localVideo: $('local-video'), screenLabel: $('screen-label'), callClock: $('call-clock'),
  caption: $('control-caption'), messageInput: $('message-input'), sendButton: $('send-button'), chatBody: $('chat-body'),
  toast: $('toast'), systemMessage: $('system-message'), installButton: $('install-button')
};

ui.roomCodeSide.textContent = room;
let ws, pc, channel, audioTrack = null, cameraTrack = null, screenTrack = null, connected = false;
let pendingCandidates = [], toastTimer, callTimer, callStartedAt, unread = 0;
let reconnectTimer = null, reconnectAttempts = 0, socketGeneration = 0, intentionalLeave = false, shouldInitiate = false;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

function randomRoom() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `sala-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}
function showToast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('visible'), 3000);
}
function setConnection(text, state = '') {
  ui.connectionLabel.textContent = text;
  ui.connectionDot.className = `live-dot ${state}`;
}
function setGuest(present) {
  ui.guestPerson.hidden = !present;
  ui.peopleCount.textContent = present ? '2' : '1';
  ui.waitingAvatar.textContent = present ? '✓' : '+';
  ui.waitingAvatar.classList.toggle('guest-avatar', present);
  ui.stageTitle.textContent = present ? 'Alguém entrou na sala' : 'A sala está pronta';
  ui.stageSubtitle.textContent = present ? 'Ative seu microfone ou compartilhe sua tela' : 'Convide alguém para começar a conversa';
  ui.stageHint.textContent = present ? 'Conectado à sala' : 'Aguardando alguém entrar';
  ui.caption.textContent = present ? 'Escolha o microfone, a câmera ou o compartilhamento.' : 'Entre na sala para ativar áudio, vídeo e compartilhamento.';
  for (const id of ['mic-button', 'camera-button', 'share-button', 'leave-button']) $(id).disabled = !present;
  if (present) {
    setConnection('Convidado na sala', 'connected');
    ui.systemMessage.textContent = 'Alguém entrou na sala. Envie uma mensagem para começar.';
  } else if (connected) {
    setConnection('Aguardando alguém entrar', 'connected');
    ui.systemMessage.textContent = 'Seu convite está pronto. Envie o link para alguém participar.';
  }
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
    setConnection('Sala conectada', 'connected');
  });
  socket.addEventListener('message', async (event) => {
    if (socket !== ws || generation !== socketGeneration) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'joined') {
      if (Array.isArray(message.iceServers) && message.iceServers.length) iceServers = message.iceServers;
      setConnection(message.count > 1 ? 'Convidado na sala' : 'Aguardando alguém entrar', 'connected');
      if (message.count > 1) setGuest(true);
    } else if (message.type === 'peer-joined') {
      setGuest(true);
      shouldInitiate = Boolean(message.initiator) && !pc?.remoteDescription;
      prepareConnection(shouldInitiate).catch((error) => showToast(`Não foi possível iniciar a conversa: ${error.message}`));
    } else if (message.type === 'peer-left') {
      resetPeer();
      setGuest(false);
      showToast('A outra pessoa saiu da sala.');
    } else if (message.type === 'signal') {
      try { await handleSignal(message.data); }
      catch (error) { showToast(`Falha ao conectar: ${error.message}`); }
    } else if (message.type === 'full') {
      setConnection('Sala cheia', 'error');
      showToast('Esta sala já tem duas pessoas. Peça um novo convite.');
    } else if (message.type === 'error') {
      setConnection('Não foi possível entrar', 'error');
      showToast(message.message || 'Erro ao entrar na sala.');
    }
  });
  socket.addEventListener('close', () => {
    if (socket !== ws || generation !== socketGeneration) return;
    connected = false;
    resetPeer();
    setGuest(false);
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

function sendSignal(data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'signal', data }));
}

async function prepareConnection(initiator) {
  if (!pc) {
    pc = new RTCPeerConnection({ iceServers });
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    pc.addTransceiver('video', { direction: 'sendrecv' });
    pc.onicecandidate = (event) => { if (event.candidate) sendSignal({ candidate: event.candidate }); };
    pc.ontrack = (event) => {
      if (event.track.kind === 'video') {
        const stream = event.streams[0] || new MediaStream([event.track]);
        const showVideo = () => { ui.remoteVideo.srcObject = stream; ui.stage.classList.add('has-remote'); };
        if (event.track.muted) event.track.onunmute = showVideo;
        else showVideo();
        event.track.onended = () => ui.stage.classList.remove('has-remote');
      }
    };
    pc.ondatachannel = (event) => setChannel(event.channel);
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'connected') startClock();
      if (pc?.connectionState === 'failed') showToast('A conexão direta falhou. Verifique a rede e tente novamente.');
      if (pc?.connectionState === 'disconnected') setConnection('Reconectando…', '');
    };
  }
  if (initiator && !pc.remoteDescription && (!channel || channel.readyState === 'closed')) {
    setChannel(pc.createDataChannel('mensagens'));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ description: pc.localDescription });
  }
}

function setChannel(nextChannel) {
  channel = nextChannel;
  channel.onopen = () => {
    ui.messageInput.disabled = false;
    ui.sendButton.disabled = !ui.messageInput.value.trim();
    ui.systemMessage.textContent = 'Conexão segura estabelecida. As mensagens vão diretamente para a outra pessoa.';
    setConnection('CAEMGAMO conectado', 'connected');
  };
  channel.onclose = () => {
    ui.messageInput.disabled = true;
    ui.sendButton.disabled = true;
  };
  channel.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'chat' && typeof data.text === 'string') addMessage(data.text, false, data.at);
    } catch { /* ignora mensagens fora do formato esperado */ }
  };
}

async function handleSignal(data) {
  if (!pc) await prepareConnection(false);
  if (data.description) {
    if (data.description.type === 'offer' && shouldInitiate && !pc.remoteDescription) shouldInitiate = false;
    await pc.setRemoteDescription(data.description);
    for (const candidate of pendingCandidates) await pc.addIceCandidate(candidate);
    pendingCandidates = [];
    if (data.description.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ description: pc.localDescription });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
    else pendingCandidates.push(data.candidate);
  }
}

function setVideoPreview() {
  if (cameraTrack && cameraTrack.readyState === 'live' && cameraTrack.enabled) {
    ui.localVideo.srcObject = new MediaStream([cameraTrack]);
    ui.localVideo.hidden = false;
  } else {
    ui.localVideo.hidden = true;
    ui.localVideo.srcObject = null;
  }
}

async function replaceTrack(kind, track) {
  const transceiver = pc?.getTransceivers().find((item) => item.sender.track?.kind === kind || item.receiver.track?.kind === kind);
  if (!transceiver) throw new Error('Faixa de mídia indisponível.');
  await transceiver.sender.replaceTrack(track);
}

async function toggleMic() {
  const button = $('mic-button');
  if (!audioTrack) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioTrack = stream.getAudioTracks()[0];
      await replaceTrack('audio', audioTrack);
      button.classList.add('active');
      button.lastElementChild.textContent = 'Microfone ligado';
      showToast('Microfone ligado.');
    } catch (error) { showToast(error.name === 'NotAllowedError' ? 'Permita o acesso ao microfone no navegador.' : 'Não foi possível acessar o microfone.'); }
    return;
  }
  audioTrack.enabled = !audioTrack.enabled;
  button.classList.toggle('active', audioTrack.enabled);
  button.lastElementChild.textContent = audioTrack.enabled ? 'Microfone ligado' : 'Microfone desligado';
}

async function toggleCamera() {
  const button = $('camera-button');
  if (!cameraTrack) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      cameraTrack = stream.getVideoTracks()[0];
      await replaceTrack('video', cameraTrack);
      setVideoPreview();
      button.classList.add('active');
      button.lastElementChild.textContent = 'Câmera ligada';
    } catch (error) { showToast(error.name === 'NotAllowedError' ? 'Permita o acesso à câmera no navegador.' : 'Não foi possível acessar a câmera.'); }
    return;
  }
  cameraTrack.enabled = !cameraTrack.enabled;
  button.classList.toggle('active', cameraTrack.enabled);
  button.lastElementChild.textContent = cameraTrack.enabled ? 'Câmera ligada' : 'Câmera desligada';
  setVideoPreview();
}

async function toggleScreen() {
  if (screenTrack) { await stopScreenShare(); return; }
  if (!navigator.mediaDevices?.getDisplayMedia || !window.isSecureContext) {
    showToast(window.isSecureContext ? 'Este navegador não permite compartilhar a tela.' : 'A tela só pode ser compartilhada em uma conexão HTTPS segura.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    screenTrack = stream.getVideoTracks()[0];
    await replaceTrack('video', screenTrack);
    ui.screenLabel.hidden = false;
    ui.stage.classList.add('has-remote');
    ui.remoteVideo.srcObject = stream;
    $('share-button').classList.add('active');
    $('share-button').lastElementChild.textContent = 'Parar compartilhamento';
    screenTrack.addEventListener('ended', stopScreenShare, { once: true });
  } catch (error) {
    if (error.name !== 'NotAllowedError') showToast('Não foi possível iniciar o compartilhamento de tela.');
  }
}

async function stopScreenShare() {
  if (!screenTrack) return;
  screenTrack.stop();
  screenTrack = null;
  await replaceTrack('video', cameraTrack?.enabled ? cameraTrack : null);
  ui.screenLabel.hidden = true;
  ui.stage.classList.remove('has-remote');
  ui.remoteVideo.srcObject = null;
  $('share-button').classList.remove('active');
  $('share-button').lastElementChild.textContent = 'Compartilhar tela';
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

function resetPeer() {
  shouldInitiate = false;
  if (callTimer) clearInterval(callTimer);
  callTimer = null;
  ui.callClock.hidden = true;
  for (const track of [audioTrack, cameraTrack, screenTrack]) track?.stop();
  audioTrack = cameraTrack = screenTrack = null;
  pc?.close(); pc = null; channel = null; pendingCandidates = [];
  ui.remoteVideo.srcObject = null; ui.localVideo.srcObject = null; ui.localVideo.hidden = true;
  ui.stage.classList.remove('has-remote'); ui.screenLabel.hidden = true;
  for (const id of ['mic-button', 'camera-button', 'share-button']) {
    $(id).classList.remove('active');
    $(id).lastElementChild.textContent = id === 'mic-button' ? 'Microfone' : id === 'camera-button' ? 'Câmera' : 'Compartilhar tela';
  }
  ui.messageInput.disabled = true; ui.sendButton.disabled = true;
}

function addMessage(text, mine, at = Date.now()) {
  const row = document.createElement('div');
  row.className = `message${mine ? ' mine' : ''}`;
  const author = document.createElement('span'); author.className = 'message-author'; author.textContent = mine ? 'Você' : 'Convidado';
  const bubble = document.createElement('div'); bubble.className = 'message-bubble'; bubble.textContent = text;
  const time = document.createElement('span'); time.className = 'message-time';
  time.textContent = new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  row.append(author, bubble, time); ui.chatBody.append(row); ui.chatBody.scrollTop = ui.chatBody.scrollHeight;
  if (!mine && window.matchMedia('(max-width: 820px)').matches && !ui.layout.classList.contains('show-chat')) {
    unread++; const badge = $('unread-count'); badge.hidden = false; badge.textContent = String(unread);
  }
}

$('message-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = ui.messageInput.value.trim();
  if (!text || channel?.readyState !== 'open') return;
  const message = { type: 'chat', text, at: Date.now() };
  channel.send(JSON.stringify(message)); addMessage(text, true, message.at);
  ui.messageInput.value = ''; ui.sendButton.disabled = true; ui.messageInput.style.height = '33px';
});
ui.messageInput.addEventListener('input', () => {
  ui.messageInput.style.height = '33px';
  ui.messageInput.style.height = `${Math.min(ui.messageInput.scrollHeight, 100)}px`;
  ui.sendButton.disabled = !ui.messageInput.value.trim() || channel?.readyState !== 'open';
});
ui.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('message-form').requestSubmit(); }
});
$('mic-button').addEventListener('click', toggleMic);
$('camera-button').addEventListener('click', toggleCamera);
$('share-button').addEventListener('click', toggleScreen);
$('leave-button').addEventListener('click', () => {
  intentionalLeave = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  resetPeer(); setGuest(false); setConnection('Você saiu da sala', '');
  ui.caption.textContent = 'Recarregue a página para entrar novamente.';
  for (const id of ['mic-button', 'camera-button', 'share-button', 'leave-button']) $(id).disabled = true;
});

async function copyText(text, labelButton) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const field = document.createElement('textarea'); field.value = text; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.append(field); field.select(); document.execCommand('copy'); field.remove();
  }
  if (labelButton) {
    const old = labelButton.textContent; labelButton.textContent = 'Copiado!'; setTimeout(() => labelButton.textContent = old, 1800);
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
  event.preventDefault(); installPrompt = event; ui.installButton.hidden = false;
});
ui.installButton.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; ui.installButton.hidden = true;
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
connect();
