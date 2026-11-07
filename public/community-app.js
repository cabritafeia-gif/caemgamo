(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    client: null, session: null, profile: null, communities: [], communityId: null,
    channel: null, subscription: null, moderationSubscription: null, friendsSubscription: null,
    directSubscription: null, dmNotifications: null, directConversationId: null, directFriend: null, directSeen: new Set(),
    friends: [], incomingRequests: [], outgoingRequests: [], seenMessages: new Set(), profiles: new Map(), configured: false, recoveryEmail: ''
  };
  const requestedChannel = new URLSearchParams(location.search).get('canal') || '';
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const inviteToken = hashParams.get('convite') || '';
  let statusTimer;

  function loadSupabaseSdk() {
    if (window.supabase?.createClient) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      script.async = true;
      script.onload = () => window.supabase?.createClient ? resolve() : reject(new Error('SDK de contas indisponível'));
      script.onerror = () => reject(new Error('SDK de contas indisponível'));
      document.head.append(script);
    });
  }

  function status(message, error = false) {
    const element = $('account-status');
    if (element) {
      element.textContent = message;
      element.classList.toggle('is-error', error);
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => { element.textContent = ''; }, 6500);
    }
    if (message && (error || $('account-dialog')?.hidden)) window.CAEMGAMO_TOAST?.(message);
  }

  function showForm(name) {
    $('auth-forms').hidden = false;
    for (const id of ['sign-in-form', 'sign-up-form', 'recovery-form', 'recovery-code-form', 'new-password-form']) $(id).hidden = id !== name;
    document.querySelectorAll('#auth-forms button[type="submit"]').forEach((button) => { button.disabled = !state.configured; });
    $('profile-panel').hidden = true;
    status('');
  }

  function setAvatar(url, name) {
    const button = $('profile-button');
    const rail = $('rail-profile-button');
    const initials = (name || 'C').trim().slice(0, 1).toUpperCase();
    for (const target of [button, rail, $('profile-initial')]) {
      if (!target) continue;
      target.textContent = initials;
      target.style.backgroundImage = '';
      target.classList.remove('has-avatar');
      target.dataset.avatarUrl = url || '';
      if (url && (target === button || target === rail)) {
        const probe = new Image();
        probe.onload = () => {
          if (target.dataset.avatarUrl !== url) return;
          target.style.backgroundImage = `url("${url.replaceAll('"', '')}")`;
          target.classList.add('has-avatar');
        };
        probe.onerror = () => {
          if (target.dataset.avatarUrl !== url) return;
          target.style.backgroundImage = '';
          target.classList.remove('has-avatar');
          target.textContent = initials;
        };
        probe.src = url;
      }
    }
    const image = $('profile-image');
    const initial = $('profile-initial');
    if (image) {
      image.dataset.avatarUrl = url || '';
      image.hidden = true;
      initial.hidden = false;
      if (!url) { image.removeAttribute('src'); return; }
      image.onload = () => {
        if (image.dataset.avatarUrl !== url) return;
        image.hidden = false;
        initial.hidden = true;
      };
      image.onerror = () => {
        if (image.dataset.avatarUrl !== url) return;
        image.hidden = true;
        initial.hidden = false;
      };
      image.src = url;
      if (image.complete && image.naturalWidth > 0) {
        image.hidden = false;
        initial.hidden = true;
      }
    }
  }

  function avatarUrl(path) {
    if (!path || !state.client) return '';
    const presets = { fox: '🦊', cat: '🐱', owl: '🦉', frog: '🐸', star: '⭐', heart: '💜', robot: '🤖', flower: '🌼' };
    const preset = /^preset:(fox|cat|owl|frog|star|heart|robot|flower)$/.exec(path);
    if (preset) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="64" fill="#5865f2"/><text x="64" y="88" text-anchor="middle" font-size="78">${presets[preset[1]]}</text></svg>`;
      return `data:image/svg+xml,${encodeURIComponent(svg)}`;
    }
    return state.client.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  }

  function avatarUrlFrom(bucket, path) {
    if (!path || !state.client) return '';
    return state.client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }

  function updateAccountView() {
    const signedIn = Boolean(state.session?.user);
    $('account-dialog').classList.toggle('is-signed-in', signedIn);
    $('account-title').textContent = signedIn ? 'Conta e configurações' : 'Sua conta CAEMGAMO';
    $('account-dialog-hint').textContent = signedIn
      ? 'Gerencie seu perfil, segurança e preferências do CAEMGAMO.'
      : 'Entre para criar comunidades, salvar mensagens e gerenciar seu perfil.';
    $('auth-forms').hidden = signedIn;
    $('profile-panel').hidden = !signedIn;
    $('profile-button').title = signedIn ? 'Seu perfil' : 'Entrar ou criar conta';
    $('workspace-name').textContent = state.communities.find((item) => item.id === state.communityId)?.name || 'CAEMGAMO';
    for (const id of ['create-community-button', 'join-community-button', 'explore-community-button', 'add-community-button']) $(id).disabled = !state.configured || !signedIn;
    for (const id of ['create-channel-button', 'create-invite-button', 'revoke-invite-button', 'manage-members-button', 'manage-roles-button', 'view-reports-button', 'view-audit-button', 'edit-community-button', 'community-icon-button', 'leave-community-button']) $(id).disabled = !state.configured || !signedIn || !state.communityId;
    $('account-email').textContent = state.session?.user?.email || '—';
    $('profile-handle').textContent = state.profile?.username ? `@${state.profile.username}` : '—';
    $('allow-friend-requests').checked = state.profile?.allow_friend_requests !== false;
    if (signedIn && state.profile) {
      $('profile-form').elements.username.value = state.profile.username || '';
      $('profile-form').elements.display_name.value = state.profile.display_name || '';
      $('settings-theme-select').value = state.profile.preferred_theme || 'dark';
      setAvatar(avatarUrl(state.profile.avatar_path), state.profile.display_name);
    } else setAvatar('', 'C');
  }

  async function loadProfile() {
    if (!state.session?.user) return;
    const { data, error } = await state.client.from('profiles').select('id,display_name,avatar_path,preferred_theme').eq('id', state.session.user.id).maybeSingle();
    if (error) throw error;
    try {
      const { data: preferences, error: handleError } = await state.client.from('profiles').select('username,allow_friend_requests').eq('id', state.session.user.id).maybeSingle();
      if (!handleError) { data.username = preferences?.username || ''; data.allow_friend_requests = preferences?.allow_friend_requests !== false; }
    } catch { /* a conta continua utilizável se a migração social ainda não foi aplicada */ }
    state.profile = data;
    if (data?.id) state.profiles.set(data.id, { ...(state.profiles.get(data.id) || {}), ...data });
    if (data?.id) window.CAEMGAMO_REFRESH_AUTHOR?.(data.id, data.display_name, avatarUrl(data.avatar_path));
    if (data?.preferred_theme) window.CAEMGAMO_APPLY_THEME?.(data.preferred_theme);
    updateAccountView();
  }

  async function loadCommunities(preferredId = state.communityId) {
    const list = $('my-communities');
    list.replaceChildren();
    state.communities = [];
    if (!state.session?.user) { state.communityId = null; updateAccountView(); return; }
    const { data: memberships, error: memberError } = await state.client.from('community_members').select('community_id,role').eq('user_id', state.session.user.id);
    if (memberError) throw memberError;
    const ids = [...new Set((memberships || []).map((row) => row.community_id))];
    if (ids.length) {
      const { data, error } = await state.client.from('communities').select('id,name,description,rules,is_public,icon_path').in('id', ids).order('created_at');
      if (error) throw error;
      state.communities = data || [];
    }
    const rail = document.querySelector('.server-rail');
    rail.querySelectorAll('[data-community-button]').forEach((button) => button.remove());
    state.communities.forEach((community) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `server-icon${community.id === preferredId ? ' active-server' : ''}`;
      button.dataset.communityButton = 'true';
      button.title = community.name;
      button.textContent = community.name.trim().slice(0, 1).toUpperCase();
      if (community.icon_path) { button.style.backgroundImage = `url("${avatarUrlFrom('community-icons', community.icon_path)}")`; button.classList.add('has-community-icon'); }
      button.addEventListener('click', () => selectCommunity(community.id));
      rail.insertBefore(button, $('add-community-button'));
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `community-row${community.id === preferredId ? ' selected' : ''}`;
      row.textContent = community.name;
      row.addEventListener('click', () => selectCommunity(community.id));
      list.append(row);
    });
    state.communityId = state.communities.some((item) => item.id === preferredId) ? preferredId : state.communities[0]?.id || null;
    if (state.communityId) await selectCommunity(state.communityId);
    else { $('channel-list').replaceChildren(); updateAccountView(); }
  }

  async function selectCommunity(id, reload = true) {
    if (state.communityId && state.communityId !== id && state.channel?.kind === 'text') {
      if (state.subscription) await state.client.removeChannel(state.subscription);
      state.subscription = null;
      state.channel = null;
      state.seenMessages.clear();
      window.CaemgamoCommunity.activeTextChannel = null;
      window.CaemgamoCommunity.canSend = false;
      clearChat();
      $('chat-header').querySelector('h2').textContent = 'Bate-papo';
      $('chat-header').querySelector('span').textContent = 'Mensagens da sala';
      $('chat-footnote').innerHTML = '<span>◈</span> As mensagens são enviadas diretamente entre participantes.';
    }
    state.communityId = id;
    try { localStorage.setItem('caemgamo-community', id); } catch { /* armazenamento opcional */ }
    const community = state.communities.find((item) => item.id === id);
    $('workspace-name').textContent = community?.name || 'CAEMGAMO';
    document.querySelectorAll('.community-row').forEach((row) => row.classList.toggle('selected', row.textContent === community?.name));
    document.querySelectorAll('[data-community-button]').forEach((button) => button.classList.toggle('active-server', button.title === community?.name));
    updateAccountView();
    if (reload) await loadChannels();
  }

  function markSelectedChannel(channelId) {
    document.querySelectorAll('.channel-row').forEach((button) => {
      button.classList.toggle('selected', button.dataset.channelId === channelId);
      if (button.dataset.channelId === channelId) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  async function loadChannels() {
    const container = $('channel-list');
    container.replaceChildren();
    if (!state.communityId) return;
    const { data, error } = await state.client.from('channels').select('id,name,kind').eq('community_id', state.communityId).order('created_at');
    if (error) throw error;
    for (const group of [
      { kind: 'text', title: 'TEXTO', icon: '#' },
      { kind: 'voice', title: 'VOZ E TRANSMISSÃO', icon: '♫' }
    ]) {
      const channels = (data || []).filter((channel) => channel.kind === group.kind);
      const section = document.createElement('section');
      section.className = 'channel-group';
      section.setAttribute('aria-label', `Canais de ${group.kind === 'text' ? 'texto' : 'voz e transmissão'}`);
      const heading = document.createElement('div');
      heading.className = 'channel-category';
      heading.textContent = group.title;
      section.append(heading);
      for (const channel of channels) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'channel-row';
        button.dataset.channelId = channel.id;
        button.innerHTML = `<span aria-hidden="true">${group.icon}</span>`;
        const name = document.createElement('span');
        name.textContent = channel.name;
        button.append(name);
        button.addEventListener('click', () => {
          markSelectedChannel(channel.id);
          channel.kind === 'voice' ? joinVoiceChannel(channel) : selectTextChannel(channel);
        });
        section.append(button);
      }
      container.append(section);
    }
    const selected = state.channel?.id || requestedChannel;
    if (selected) markSelectedChannel(selected);
    updateAccountView();
  }

  function clearChat() {
    $('chat-body').querySelectorAll('.message').forEach((row) => row.remove());
    state.seenMessages.clear();
  }

  async function loadAuthors(userIds) {
    const missing = [...new Set(userIds)].filter((id) => !state.profiles.has(id));
    if (missing.length) {
      const { data, error } = await state.client.from('profiles').select('id,display_name,avatar_path').in('id', missing);
      if (error) throw error;
      for (const profile of data || []) state.profiles.set(profile.id, profile);
    }
    return state.profiles;
  }

  async function displayMessage(message) {
    if (!message?.id || state.seenMessages.has(message.id)) return;
    state.seenMessages.add(message.id);
    try { await loadAuthors([message.author_id]); } catch { /* mensagem continua legível sem perfil */ }
    const profile = state.profiles.get(message.author_id);
    let media = null;
    if (message.message_type === 'audio' && message.media_path) {
      const { data, error } = await state.client.storage.from('chat-media').createSignedUrl(message.media_path, 3600);
      if (!error) media = { type: 'audio', url: data.signedUrl };
    } else if (message.message_type === 'sticker') media = { type: 'sticker' };
    else if (message.message_type === 'gift') media = { type: 'gift' };
    if (media) media.messageId = message.id;
    else media = { messageId: message.id };
    window.CAEMGAMO_ADD_MESSAGE?.(
      message.content, message.author_id === state.session?.user?.id,
      Date.parse(message.created_at) || Date.now(), message.author_id,
      profile?.display_name || 'Participante', avatarUrl(profile?.avatar_path), media
    );
  }

  async function selectTextChannel(channel) {
    if (!state.session?.user) { openAccount(); return; }
    if (state.subscription) await state.client.removeChannel(state.subscription);
    state.subscription = null;
    state.channel = channel;
    markSelectedChannel(channel.id);
    window.CaemgamoCommunity.activeTextChannel = channel.id;
    window.CaemgamoCommunity.canSend = true;
    $('chat-header').querySelector('h2').textContent = `# ${channel.name}`;
    $('chat-header').querySelector('span').textContent = 'Canal de texto da comunidade';
    $('system-message').textContent = 'Este canal salva as mensagens e aplica as regras de acesso da comunidade.';
    $('message-input').placeholder = `Mensagem em #${channel.name}`;
    $('chat-footnote').innerHTML = '<span>◈</span> Histórico salvo com acesso controlado pela comunidade.';
    clearChat();
    try {
      const { data, error } = await state.client.from('messages').select('id,author_id,message_type,content,media_path,duration_seconds,created_at').eq('channel_id', channel.id).order('created_at', { ascending: true }).limit(100);
      if (error) throw error;
      await loadAuthors((data || []).map((item) => item.author_id));
      for (const message of data || []) await displayMessage(message);
      state.subscription = state.client.channel(`caemgamo-messages-${channel.id}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${channel.id}` }, ({ new: message }) => { displayMessage(message).catch(() => {}); })
        .subscribe((subscriptionStatus) => {
          if (subscriptionStatus === 'CHANNEL_ERROR' || subscriptionStatus === 'TIMED_OUT') status('A conexão do bate-papo caiu. Atualize o canal para reconectar.', true);
        });
    } catch (error) { window.CAEMGAMO_TOAST?.(friendlyError(error)); }
    window.CAEMGAMO_UPDATE_CHAT_STATE?.();
  }

  async function refreshTextChannel() {
    const channelId = window.CaemgamoCommunity.activeTextChannel;
    if (!channelId || !state.session?.user) throw new Error('Escolha um canal de texto primeiro.');
    const { data, error } = await state.client.from('channels').select('id,name,kind').eq('id', channelId).maybeSingle();
    if (error) throw error;
    if (!data || data.kind !== 'text') throw new Error('Este canal de texto não está disponível.');
    await selectTextChannel(data);
  }

  function joinVoiceChannel(channel) {
    if (!state.session?.user) { openAccount(); return; }
    markSelectedChannel(channel.id);
    location.assign(`/?sala=${encodeURIComponent(channel.id)}&canal=${encodeURIComponent(channel.id)}`);
  }

  async function sendText(content) {
    if (!state.channel || !state.session?.user) throw new Error('Entre na conta e escolha um canal de texto.');
    const safeContent = String(content).trim();
    if (!safeContent || safeContent.length > 2000) throw new Error('A mensagem deve ter entre 1 e 2.000 caracteres.');
    const { data, error } = await state.client.from('messages').insert({ channel_id: state.channel.id, author_id: state.session.user.id, content: safeContent }).select('id,author_id,content,created_at').single();
    if (error) throw error;
    await displayMessage(data);
  }

  async function sendSticker() {
    if (!state.channel || !state.session?.user) throw new Error('Escolha um canal de texto primeiro.');
    const stickers = ['🎉', '👋', '😂', '👍', '❤️', '🎮', '✨', '🔥'];
    const selected = prompt(`Escolha uma figurinha:\n${stickers.map((value, index) => `${index + 1}. ${value}`).join('\n')}`, '1');
    if (!selected) return;
    const sticker = stickers[Number(selected) - 1];
    if (!sticker) throw new Error('Escolha um número entre 1 e 8.');
    const { data, error } = await state.client.from('messages').insert({ channel_id: state.channel.id, author_id: state.session.user.id, message_type: 'sticker', content: sticker }).select('id,author_id,message_type,content,created_at').single();
    if (error) throw error;
    await displayMessage(data);
  }

  async function sendGift() {
    if (!state.channel || !state.session?.user) throw new Error('Escolha um canal de texto primeiro.');
    const gifts = ['🎁', '🌟', '💐', '🍰', '🧸', '🚀', '💎', '🎮'];
    const selected = prompt(`Escolha um presente virtual gratuito:\n${gifts.map((value, index) => `${index + 1}. ${value}`).join('\n')}`, '1');
    if (!selected) return;
    const gift = gifts[Number(selected) - 1];
    if (!gift) throw new Error('Escolha um número entre 1 e 8.');
    const { data, error } = await state.client.from('messages').insert({ channel_id: state.channel.id, author_id: state.session.user.id, message_type: 'gift', content: gift }).select('id,author_id,message_type,content,created_at').single();
    if (error) throw error;
    await displayMessage(data);
  }

  async function sendAudioFile(file) {
    if (!file || !state.channel || !state.session?.user) return;
    const types = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
    if (!types[file.type] || file.size < 1 || file.size > 10 * 1024 * 1024) throw new Error('Escolha um áudio WebM, Ogg, M4A, MP3 ou WAV com até 10 MB.');
    const objectUrl = URL.createObjectURL(file);
    let duration;
    try {
      duration = await new Promise((resolve, reject) => {
        const audio = new Audio();
        const timeout = setTimeout(() => reject(new Error('Não foi possível ler a duração do áudio.')), 8000);
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => { clearTimeout(timeout); resolve(audio.duration); };
        audio.onerror = () => { clearTimeout(timeout); reject(new Error('O arquivo não parece ser um áudio válido.')); };
        audio.src = objectUrl;
      });
    } finally { URL.revokeObjectURL(objectUrl); }
    if (!Number.isFinite(duration) || duration <= 0 || duration > 30) throw new Error('O áudio precisa durar até 30 segundos.');
    const mediaPath = `${state.channel.id}/${state.session.user.id}/${crypto.randomUUID()}.${types[file.type]}`;
    const { error: uploadError } = await state.client.storage.from('chat-media').upload(mediaPath, file, { contentType: file.type, upsert: false });
    if (uploadError) throw uploadError;
    const { data, error } = await state.client.from('messages').insert({ channel_id: state.channel.id, author_id: state.session.user.id, message_type: 'audio', content: '', media_path: mediaPath, duration_seconds: Math.ceil(duration) }).select('id,author_id,message_type,content,media_path,duration_seconds,created_at').single();
    if (error) throw error;
    await displayMessage(data);
  }

  let recorder = null;
  let recorderStream = null;
  let recorderTimer = null;
  let recordingStarted = 0;
  async function toggleAudioRecording() {
    if (recorder?.state === 'recording') { recorder.stop(); return; }
    if (!state.channel || !state.session?.user) throw new Error('Escolha um canal de texto primeiro.');
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Este navegador não oferece gravação de áudio.');
    recorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) { recorderStream.getTracks().forEach((track) => track.stop()); throw new Error('Formato de áudio compatível não encontrado.'); }
    const chunks = [];
    recorder = new MediaRecorder(recorderStream, { mimeType });
    recordingStarted = Date.now();
    $('record-audio-button').textContent = '■ Parar e enviar';
    $('recording-indicator').hidden = false;
    recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) chunks.push(event.data); });
    recorder.addEventListener('stop', async () => {
      clearTimeout(recorderTimer);
      recorderStream?.getTracks().forEach((track) => track.stop());
      recorderStream = null;
      $('record-audio-button').textContent = '♩ Gravar áudio';
      $('recording-indicator').hidden = true;
      const duration = Math.max(1, Math.min(30, Math.ceil((Date.now() - recordingStarted) / 1000)));
      const audio = new Blob(chunks, { type: mimeType.split(';')[0] });
      try {
        if (!audio.size || audio.size > 10 * 1024 * 1024) throw new Error('O áudio precisa ter menos de 10 MB.');
        const extension = mimeType.startsWith('audio/webm') ? 'webm' : mimeType.startsWith('audio/ogg') ? 'ogg' : 'm4a';
        const mediaPath = `${state.channel.id}/${state.session.user.id}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await state.client.storage.from('chat-media').upload(mediaPath, audio, { contentType: mimeType.split(';')[0], upsert: false });
        if (uploadError) throw uploadError;
        const { data, error } = await state.client.from('messages').insert({ channel_id: state.channel.id, author_id: state.session.user.id, message_type: 'audio', content: '', media_path: mediaPath, duration_seconds: duration }).select('id,author_id,message_type,content,media_path,duration_seconds,created_at').single();
        if (error) throw error;
        await displayMessage(data);
      } catch (error) { window.CAEMGAMO_TOAST?.(friendlyError(error)); }
    }, { once: true });
    recorder.start(250);
    recorderTimer = setTimeout(() => { if (recorder?.state === 'recording') recorder.stop(); }, 30_000);
  }

  function randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  async function createCommunity() {
    if (!requireAccount()) return;
    const name = prompt('Nome da comunidade (2 a 64 caracteres):');
    if (!name?.trim()) return;
    const description = prompt('Descrição curta (opcional):') || '';
    const rules = prompt('Regras da comunidade (opcional):') || '';
    const isPublic = confirm('Permitir que usuários conectados encontrem esta comunidade? (Cancelar cria uma comunidade privada por convite)');
    const { data, error } = await state.client.rpc('create_community', { p_name: name.trim(), p_description: description, p_is_public: isPublic, p_rules: rules });
    if (error) throw error;
    await loadCommunities(data);
    await selectCommunity(data);
    status('Comunidade criada com os canais #geral e voz.');
  }

  async function createChannel() {
    if (!requireAccount() || !state.communityId) return;
    const name = prompt('Nome do canal:');
    if (!name?.trim()) return;
    const kind = confirm('Criar um canal de voz? (Cancelar cria canal de texto)') ? 'voice' : 'text';
    const readRole = prompt('Nível mínimo para ver: member, mod, admin ou owner', 'member') || 'member';
    const postRole = kind === 'voice' ? 'member' : (prompt('Nível mínimo para enviar mensagens: member, mod, admin ou owner', 'member') || 'member');
    const roles = ['member', 'mod', 'admin', 'owner'];
    if (!roles.includes(readRole) || !roles.includes(postRole)) { status('Papel inválido. Use member, mod, admin ou owner.', true); return; }
    const { error } = await state.client.rpc('create_channel', { p_community_id: state.communityId, p_name: name.trim(), p_kind: kind, p_read_min_role: readRole, p_post_min_role: postRole });
    if (error) throw error;
    await loadChannels();
  }

  async function createInvite() {
    if (!requireAccount() || !state.communityId) return;
    const hours = prompt('Validade em horas (vazio = sem expiração):', '24');
    const maxUses = prompt('Limite de usos (vazio = sem limite):', '');
    if (hours?.trim() && (!Number.isFinite(Number(hours)) || Number(hours) < 1 || Number(hours) > 8760)) { status('Informe uma validade entre 1 e 8.760 horas.', true); return; }
    const expiresAt = hours?.trim() ? new Date(Date.now() + Number(hours) * 3600_000).toISOString() : null;
    const useLimit = maxUses?.trim() ? Number(maxUses) : null;
    if (useLimit !== null && (!Number.isInteger(useLimit) || useLimit < 1)) { status('O limite de usos precisa ser um número inteiro positivo.', true); return; }
    const token = randomToken();
    const { data: inviteId, error } = await state.client.rpc('create_community_invite', { p_community_id: state.communityId, p_token: token, p_expires_at: expiresAt, p_max_uses: useLimit });
    if (error) throw error;
    const link = `${location.origin}/#convite=${token}`;
    try { await navigator.clipboard.writeText(link); }
    catch {
      const field = document.createElement('textarea'); field.value = link; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.append(field); field.select(); document.execCommand('copy'); field.remove();
    }
    status(`Convite criado e copiado. Guarde o ID ${inviteId} para revogá-lo.`);
  }

  async function revokeInvite() {
    const inviteId = prompt('ID do convite que deseja revogar:');
    if (!inviteId) return;
    const { error } = await state.client.rpc('revoke_community_invite', { p_invite_id: inviteId.trim() });
    if (error) throw error;
    status('Convite revogado.');
  }

  async function editCommunity() {
    const current = state.communities.find((item) => item.id === state.communityId);
    if (!current) return;
    const name = prompt('Nome da comunidade:', current.name);
    if (!name?.trim()) return;
    const description = prompt('Descrição:', current.description || '') ?? (current.description || '');
    const rules = prompt('Regras:', current.rules || '') ?? (current.rules || '');
    const isPublic = confirm('Esta comunidade deve aparecer para usuários conectados?');
    const { error } = await state.client.rpc('update_community_settings', { p_community_id: current.id, p_name: name.trim(), p_description: description, p_rules: rules, p_is_public: isPublic, p_icon_path: current.icon_path });
    if (error) throw error;
    await loadCommunities(current.id);
    status('Configurações da comunidade salvas.');
  }

  async function uploadCommunityIcon(file) {
    if (!file || !state.communityId) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Escolha PNG, JPEG ou WebP com até 5 MB.');
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { throw new Error('O arquivo não parece ser uma imagem válida.'); }
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
    if (!blob || blob.size > 3 * 1024 * 1024) throw new Error('A imagem processada excede o limite de 3 MB.');
    const community = state.communities.find((item) => item.id === state.communityId);
    const path = `${state.communityId}/${crypto.randomUUID()}.webp`;
    const { error: uploadError } = await state.client.storage.from('community-icons').upload(path, blob, { contentType: 'image/webp', upsert: false });
    if (uploadError) throw uploadError;
    const { error } = await state.client.rpc('update_community_settings', { p_community_id: state.communityId, p_name: community.name, p_description: community.description || '', p_rules: community.rules || '', p_is_public: community.is_public, p_icon_path: path });
    if (error) throw error;
    await loadCommunities(state.communityId);
    status('Imagem da comunidade atualizada.');
  }

  async function joinInvite(token = '') {
    if (!requireAccount()) { if (token) sessionStorage.setItem('caemgamo-pending-invite', token); return; }
    const invite = token || prompt('Cole o convite da comunidade:')?.split('convite=')[1]?.split('&')[0];
    if (!invite) return;
    const { data, error } = await state.client.rpc('join_community_by_invite', { p_token: invite });
    if (error) throw error;
    history.replaceState({}, '', location.pathname + location.search);
    sessionStorage.removeItem('caemgamo-pending-invite');
    await loadCommunities(data);
    await selectCommunity(data);
    status('Você entrou na comunidade.');
  }

  async function exploreCommunities() {
    if (!requireAccount()) return;
    const { data, error } = await state.client.from('communities').select('id,name,description').eq('is_public', true).order('created_at', { ascending: false }).limit(30);
    if (error) throw error;
    if (!data?.length) { status('Nenhuma comunidade pública encontrada.'); return; }
    const selected = prompt(`Comunidades públicas:\n${data.map((item, index) => `${index + 1}. ${item.name} — ${item.description || 'sem descrição'}`).join('\n')}\n\nDigite o número para entrar:`);
    if (!selected) return;
    const community = data[Number(selected) - 1];
    if (!community) { status('Escolha um número da lista.', true); return; }
    const { error: joinError } = await state.client.rpc('join_public_community', { p_community_id: community.id });
    if (joinError) throw joinError;
    await loadCommunities(community.id);
    status(`Você entrou em ${community.name}.`);
  }

  async function leaveCommunity() {
    if (!requireAccount() || !state.communityId) return;
    if (!confirm('Sair desta comunidade? O proprietário precisa transferir a propriedade antes.')) return;
    const { error } = await state.client.rpc('leave_community', { p_community_id: state.communityId });
    if (error) throw error;
    await loadCommunities(null);
    window.CAEMGAMO_UPDATE_CHAT_STATE?.();
    status('Você saiu da comunidade.');
  }

  async function manageMembers() {
    if (!requireAccount() || !state.communityId) return;
    const { data: members, error } = await state.client.from('community_members').select('user_id,role').eq('community_id', state.communityId);
    if (error) throw error;
    await loadAuthors((members || []).map((member) => member.user_id));
    const lines = (members || []).map((member) => `${state.profiles.get(member.user_id)?.display_name || 'Participante'} — ${member.role} — ${member.user_id}`).join('\n');
    const memberId = prompt(`Membros (copie o ID da pessoa que quer gerenciar):\n${lines}`);
    if (!memberId) return;
    const action = prompt('Ação: papel:member, papel:mod, papel:admin, cargo, warning, mute, kick, ban, revogar, transferir')?.trim().toLowerCase();
    if (!action) return;
    if (action === 'transferir') {
      if (!confirm('Transferir a propriedade desta comunidade para esta pessoa? Você passará a ser administrador.')) return;
      const { error: transferError } = await state.client.rpc('transfer_community_ownership', { p_community_id: state.communityId, p_new_owner_id: memberId.trim() });
      if (transferError) throw transferError;
    } else if (action.startsWith('papel:')) {
      const role = action.slice(6);
      if (!['member', 'mod', 'admin'].includes(role)) { status('Papel inválido.', true); return; }
      const { error: roleError } = await state.client.rpc('assign_community_role', { p_community_id: state.communityId, p_user_id: memberId.trim(), p_role: role });
      if (roleError) throw roleError;
    } else if (action === 'cargo') {
      const { data: roles, error: rolesError } = await state.client.from('community_custom_roles').select('id,name,rank').eq('community_id', state.communityId).order('rank', { ascending: false });
      if (rolesError) throw rolesError;
      const roleId = prompt(`Cargos disponíveis:\n${(roles || []).map((item) => `${item.name} (nível ${item.rank}) — ${item.id}`).join('\n') || 'Nenhum cargo personalizado'}\n\nCole o ID para atribuir; deixe vazio para remover cargo personalizado:`);
      if (roleId === null) return;
      const { error: assignError } = await state.client.rpc('assign_community_custom_role', { p_community_id: state.communityId, p_user_id: memberId.trim(), p_role_id: roleId.trim() || null });
      if (assignError) throw assignError;
    } else if (action === 'revogar') {
      const cases = await state.client.from('moderation_cases').select('id,action,subject_id,created_at').eq('community_id', state.communityId).eq('subject_id', memberId.trim()).is('revoked_at', null).order('created_at', { ascending: false }).limit(10);
      if (cases.error) throw cases.error;
      const caseId = prompt(`Punições ativas (copie o ID):\n${(cases.data || []).map((item) => `${item.action} — ${item.id}`).join('\n')}`);
      if (!caseId) return;
      const { error: revokeError } = await state.client.rpc('revoke_moderation_case', { p_case_id: caseId.trim(), p_reason: prompt('Motivo da revogação (opcional):') || '' });
      if (revokeError) throw revokeError;
    } else {
      const kind = ['warning', 'mute', 'kick', 'ban'].find((candidate) => action === candidate);
      if (!kind) { status('Ação inválida.', true); return; }
      const duration = ['warning', 'ban'].includes(kind) && confirm('Aplicar sem expiração?') ? null : Number(prompt('Duração em segundos (mínimo 60):', kind === 'mute' ? '600' : '3600'));
      if (duration !== null && (!Number.isInteger(duration) || duration < 60)) { status('A duração precisa ser de pelo menos 60 segundos.', true); return; }
      const { error: modError } = await state.client.rpc('moderate_community_member', { p_community_id: state.communityId, p_user_id: memberId.trim(), p_action: kind, p_reason: prompt('Motivo (opcional, máximo 500 caracteres):') || '', p_duration_seconds: duration });
      if (modError) throw modError;
    }
    status('Ação registrada. O banco validou a permissão e gravou a auditoria.');
    await loadCommunities(state.communityId);
  }

  async function manageRoles() {
    if (!requireAccount() || !state.communityId) return;
    const { data: roles, error } = await state.client.from('community_custom_roles').select('id,name,rank,permissions').eq('community_id', state.communityId).order('rank', { ascending: false });
    if (error) throw error;
    const list = (roles || []).map((role) => `${role.name} · nível ${role.rank} · ${role.id} · ${Object.keys(role.permissions || {}).filter((key) => role.permissions[key]).join(', ') || 'sem permissões'}`).join('\n');
    const action = prompt(`Cargos personalizados da comunidade:\n${list || 'Nenhum cargo criado'}\n\nDigite: criar, editar, excluir ou atribuir` )?.trim().toLowerCase();
    if (!action) return;
    if (action === 'criar' || action === 'editar') {
      const roleId = action === 'editar' ? prompt('ID do cargo que será editado:')?.trim() : null;
      if (action === 'editar' && !roleId) return;
      const current = roles?.find((role) => role.id === roleId);
      const name = prompt('Nome do cargo (2 a 32 caracteres):', current?.name || '')?.trim();
      if (!name) return;
      const rank = Number(prompt('Nível: 1 = membro, 2 = moderador, 3 = administrador. Seu cargo precisa estar abaixo do seu.', String(current?.rank || 1)));
      const keys = ['send_messages','join_voice','create_invites','manage_channels','manage_settings','moderate_members','view_audit','view_reports','report_content'];
      const enabled = prompt(`Permissões separadas por vírgula. Opções:\n${keys.join(', ')}`, Object.keys(current?.permissions || {}).filter((key) => current.permissions[key]).join(','));
      if (enabled === null) return;
      const permissions = Object.fromEntries(enabled.split(',').map((key) => key.trim()).filter(Boolean).map((key) => [key, true]));
      const { error: saveError } = await state.client.rpc('save_community_role', { p_community_id: state.communityId, p_role_id: roleId || null, p_name: name, p_rank: rank, p_permissions: permissions });
      if (saveError) throw saveError;
    } else if (action === 'excluir') {
      const roleId = prompt(`ID do cargo para excluir:\n${list}`)?.trim();
      if (!roleId || !confirm('Excluir este cargo e remover dos membros que o usam?')) return;
      const { error: deleteError } = await state.client.rpc('delete_community_role', { p_community_id: state.communityId, p_role_id: roleId });
      if (deleteError) throw deleteError;
    } else if (action === 'atribuir') {
      const userId = prompt('ID da pessoa para receber o cargo:')?.trim();
      const roleId = prompt(`ID do cargo (deixe vazio para voltar ao papel padrão):\n${list}`);
      if (!userId || roleId === null) return;
      const { error: assignError } = await state.client.rpc('assign_community_custom_role', { p_community_id: state.communityId, p_user_id: userId, p_role_id: roleId.trim() || null });
      if (assignError) throw assignError;
    } else { status('Escolha criar, editar, excluir ou atribuir.', true); return; }
    status('Cargos atualizados. As permissões e a hierarquia foram validadas pelo banco.');
  }

  async function reportMessage(messageId) {
    const reason = prompt('Por que deseja denunciar esta mensagem? (3 a 500 caracteres)');
    if (reason === null) return;
    const { error } = await state.client.rpc('report_community_message', { p_message_id: messageId, p_reason: reason.trim() });
    if (error) throw error;
    window.CAEMGAMO_TOAST?.('Denúncia enviada para a equipe da comunidade.');
  }

  async function viewReports() {
    if (!requireAccount() || !state.communityId) return;
    const { data: canView, error: permissionError } = await state.client.rpc('community_has_permission', { p_community_id: state.communityId, p_permission: 'view_reports' });
    if (permissionError) throw permissionError;
    if (!canView) throw new Error('Sua conta não tem permissão para analisar denúncias.');
    const { data, error } = await state.client.from('message_reports').select('id,reported_user_id,reason,status,created_at').eq('community_id', state.communityId).eq('status', 'open').order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    await loadAuthors((data || []).map((report) => report.reported_user_id));
    const lines = (data || []).map((report) => `${report.id} · ${state.profiles.get(report.reported_user_id)?.display_name || 'Participante'} · ${report.reason}`);
    if (!lines.length) { status('Não há denúncias abertas.'); return; }
    const reportId = prompt(`Denúncias abertas (copie o ID para analisar):\n${lines.join('\n')}`)?.trim();
    if (!reportId) return;
    const decision = prompt('Resultado: reviewed, actioned ou dismissed', 'reviewed')?.trim().toLowerCase();
    if (!['reviewed','actioned','dismissed'].includes(decision)) { status('Resultado inválido.', true); return; }
    const { error: resolveError } = await state.client.rpc('resolve_community_message_report', { p_report_id: reportId, p_status: decision });
    if (resolveError) throw resolveError;
    status('Denúncia atualizada e registrada na auditoria.');
  }

  async function viewAudit() {
    if (!requireAccount() || !state.communityId) return;
    const { data, error } = await state.client.from('audit_logs').select('actor_id,subject_id,action,reason,created_at').eq('community_id', state.communityId).order('created_at', { ascending: false }).limit(20);
    if (error) throw error;
    const ids = (data || []).flatMap((row) => [row.actor_id, row.subject_id].filter(Boolean));
    await loadAuthors(ids);
    const lines = (data || []).map((row) => {
      const actor = state.profiles.get(row.actor_id)?.display_name || 'Participante';
      const subject = row.subject_id ? ` → ${state.profiles.get(row.subject_id)?.display_name || 'Participante'}` : '';
      const reason = row.reason ? ` · ${row.reason}` : '';
      return `${new Date(row.created_at).toLocaleString('pt-BR')} · ${actor}${subject} · ${row.action}${reason}`;
    });
    alert(lines.join('\n') || 'Nenhum evento registrado.');
  }

  async function changeAvatar(file) {
    if (!file || !state.session?.user) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Escolha PNG, JPEG ou WebP com até 5 MB.');
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { throw new Error('O arquivo não parece ser uma imagem válida.'); }
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const sanitized = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
    if (!sanitized || sanitized.size > 3 * 1024 * 1024) throw new Error('A imagem processada excede o limite de 3 MB.');
    const path = `${state.session.user.id}/${crypto.randomUUID()}.webp`;
    const { error: uploadError } = await state.client.storage.from('avatars').upload(path, sanitized, { contentType: 'image/webp', upsert: false });
    if (uploadError) throw uploadError;
    const { error } = await state.client.from('profiles').update({ avatar_path: path }).eq('id', state.session.user.id);
    if (error) throw error;
    await loadProfile();
    status('Avatar atualizado.');
  }

  async function removeAvatar() {
    if (!state.session?.user || !state.profile?.avatar_path) return;
    const previousPath = state.profile.avatar_path;
    const { error } = await state.client.from('profiles').update({ avatar_path: null }).eq('id', state.session.user.id);
    if (error) throw error;
    await loadProfile();
    if (!previousPath.startsWith('preset:')) {
      const { error: deleteError } = await state.client.storage.from('avatars').remove([previousPath]);
      if (deleteError) status('Avatar removido do perfil; o arquivo antigo não pôde ser apagado do armazenamento.', true);
      else status('Avatar removido.');
    } else status('Avatar removido.');
  }

  async function changePresetAvatar(preset) {
    const allowed = ['fox','cat','owl','frog','star','heart','robot','flower'];
    if (!allowed.includes(preset) || !state.session?.user) return;
    const { error } = await state.client.from('profiles').update({ avatar_path: `preset:${preset}` }).eq('id', state.session.user.id);
    if (error) throw error;
    await loadProfile();
    status('Avatar atualizado.');
  }

  async function requestRecoveryCode(email) {
    state.recoveryEmail = String(email || '').trim();
    if (!state.recoveryEmail) { status('Digite seu e-mail para receber o código.', true); return; }
    $('recovery-code-form').elements.email.value = state.recoveryEmail;
    try {
      const { error } = await state.client.auth.resetPasswordForEmail(state.recoveryEmail, { redirectTo: `${location.origin}/?recuperar=1` });
      if (error) throw error;
    } catch (error) {
      status(`Não foi possível solicitar o código agora. Confira a conexão e as configurações de e-mail do Supabase. ${friendlyError(error)}`, true);
      return;
    }
    showForm('recovery-code-form');
    status('Se houver uma conta para esse endereço, enviaremos um código de recuperação por e-mail.');
  }

  function openAccount() {
    const signedIn = Boolean(state.session?.user);
    $('account-dialog').hidden = false;
    $('account-close').hidden = !signedIn;
    $('auth-forms').hidden = signedIn;
    $('profile-panel').hidden = !signedIn;
    if (signedIn) {
      updateAccountView();
    } else {
      showForm('sign-in-form');
    }
  }
  window.CAEMGAMO_OPEN_ACCOUNT = openAccount;

  function requireAccount() {
    if (state.session?.user) return true;
    openAccount();
    return false;
  }

  function socialStatus(message, target = 'friends-status', error = false) {
    const element = $(target);
    if (!element) return;
    element.textContent = message || '';
    element.classList.toggle('is-error', error);
  }

  function makeSocialRow(profile, buttons = []) {
    const row = document.createElement('div');
    row.className = 'social-row';
    const avatar = document.createElement('span');
    avatar.className = 'social-avatar';
    const url = avatarUrl(profile.avatar_path);
    if (url) {
      avatar.style.backgroundImage = `url("${url.replaceAll('"', '')}")`;
      avatar.classList.add('has-avatar');
    } else avatar.textContent = (profile.display_name || 'C').trim().slice(0, 1).toUpperCase();
    const main = document.createElement('div');
    main.className = 'social-row-main';
    const name = document.createElement('div');
    name.className = 'social-row-name';
    name.textContent = profile.display_name || 'Participante';
    const handle = document.createElement('div');
    handle.className = 'social-row-handle';
    handle.textContent = profile.username ? `@${profile.username}` : '';
    main.append(name, handle);
    const actions = document.createElement('div');
    actions.className = 'social-row-actions';
    for (const { label, action, danger = false } of buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = danger ? 'link-action danger-action' : 'secondary-button';
      button.textContent = label;
      button.addEventListener('click', () => Promise.resolve(action()).catch((error) => {
        const target = $('messages-dialog') && !$('messages-dialog').hidden ? 'messages-status' : 'friends-status';
        socialStatus(friendlyError(error), target, true);
      }));
      actions.append(button);
    }
    row.append(avatar, main, actions);
    return row;
  }

  async function loadSocialProfiles(ids) {
    const uniqueIds = [...new Set(ids)].filter(Boolean);
    if (!uniqueIds.length) return [];
    const { data, error } = await state.client.from('profiles').select('id,username,display_name,avatar_path,allow_friend_requests').in('id', uniqueIds);
    if (error) throw error;
    for (const profile of data || []) state.profiles.set(profile.id, { ...(state.profiles.get(profile.id) || {}), ...profile });
    return data || [];
  }

  function profileFor(id) { return state.profiles.get(id) || { id, display_name: 'Participante', username: '' }; }

  async function loadFriends() {
    if (!state.session?.user) return;
    const userId = state.session.user.id;
    const [friendResult, incomingResult, outgoingResult] = await Promise.all([
      state.client.from('friendships').select('user_a,user_b').or(`user_a.eq.${userId},user_b.eq.${userId}`),
      state.client.from('friend_requests').select('id,sender_id,receiver_id,created_at').eq('receiver_id', userId).order('created_at', { ascending: false }),
      state.client.from('friend_requests').select('id,sender_id,receiver_id,created_at').eq('sender_id', userId).order('created_at', { ascending: false })
    ]);
    for (const result of [friendResult, incomingResult, outgoingResult]) if (result.error) throw result.error;
    state.incomingRequests = incomingResult.data || [];
    state.outgoingRequests = outgoingResult.data || [];
    await loadSocialProfiles([
      ...state.incomingRequests.map((request) => request.sender_id),
      ...state.outgoingRequests.map((request) => request.receiver_id)
    ]);
    const friendIds = (friendResult.data || []).map((row) => row.user_a === userId ? row.user_b : row.user_a);
    state.friends = await loadSocialProfiles(friendIds);
    renderFriends();
  }

  function renderFriends() {
    const friendList = $('friend-list');
    const pendingList = $('pending-friend-list');
    const contacts = $('dm-contacts');
    friendList.replaceChildren(); pendingList.replaceChildren(); contacts.replaceChildren();
    if (!state.friends.length) {
      const empty = document.createElement('p'); empty.className = 'social-status'; empty.textContent = 'Você ainda não adicionou amigos.'; friendList.append(empty);
    }
    for (const friend of state.friends) {
      const openChat = () => openDirectMessage(friend);
      const row = makeSocialRow(friend, [
        { label: 'Mensagem', action: openChat },
        { label: 'Remover', danger: true, action: async () => {
          const { error } = await state.client.rpc('remove_friend', { p_user_id: friend.id }); if (error) throw error;
          if (state.directFriend?.id === friend.id) {
            if (state.directSubscription) await state.client.removeChannel(state.directSubscription);
            state.directSubscription = null; state.directConversationId = null; state.directFriend = null; state.directSeen.clear();
            $('dm-recipient').textContent = 'Escolha um amigo'; $('dm-messages').replaceChildren(); $('direct-message-input').disabled = true;
            $('direct-message-form').querySelector('button[type="submit"]').disabled = true; $('call-dm-button').disabled = true;
          }
          await loadFriends(); socialStatus('Amizade removida.');
        } }
      ]);
      friendList.append(row);
      const contact = makeSocialRow(friend, [{ label: 'Abrir', action: openChat }]);
      contact.dataset.friendId = friend.id;
      contact.setAttribute('aria-current', String(state.directFriend?.id === friend.id));
      contacts.append(contact);
    }
    const pendingCount = state.incomingRequests.length + state.outgoingRequests.length;
    $('pending-friend-count').textContent = String(pendingCount);
    $('pending-friend-count').hidden = pendingCount === 0;
    if (!pendingCount) { const empty = document.createElement('p'); empty.className = 'social-status'; empty.textContent = 'Não há solicitações pendentes.'; pendingList.append(empty); }
    for (const request of state.incomingRequests) {
      const profile = profileFor(request.sender_id);
      const row = makeSocialRow(profile, [
        { label: 'Aceitar', action: async () => { const { error } = await state.client.rpc('respond_friend_request', { p_request_id: request.id, p_accept: true }); if (error) throw error; await loadFriends(); socialStatus('Solicitação aceita.'); } },
        { label: 'Recusar', danger: true, action: async () => { const { error } = await state.client.rpc('respond_friend_request', { p_request_id: request.id, p_accept: false }); if (error) throw error; await loadFriends(); socialStatus('Solicitação recusada.'); } }
      ]);
      pendingList.append(row);
    }
    for (const request of state.outgoingRequests) {
      const row = makeSocialRow(profileFor(request.receiver_id), [{ label: 'Cancelar', danger: true, action: async () => { const { error } = await state.client.rpc('cancel_friend_request', { p_request_id: request.id }); if (error) throw error; await loadFriends(); socialStatus('Solicitação cancelada.'); } }]);
      pendingList.append(row);
    }
  }

  async function openFriends(tab = 'all') {
    if (!requireAccount()) return;
    setActiveArea('friends');
    $('friends-dialog').hidden = false;
    activateFriendsTab(tab);
    try { await loadFriends(); socialStatus(''); }
    catch (error) { socialStatus(`${friendlyError(error)} Se as tabelas sociais ainda não existem, aplique a migração 202611070003_caemgamo_social.sql.`, 'friends-status', true); }
  }

  function activateFriendsTab(tab) {
    document.querySelectorAll('[data-friends-tab]').forEach((button) => button.setAttribute('aria-current', String(button.dataset.friendsTab === tab)));
    document.querySelectorAll('[data-friends-section]').forEach((section) => { section.hidden = section.dataset.friendsSection !== tab; });
  }

  async function searchFriend() {
    if (!requireAccount()) return;
    const username = String($('friend-search-form').elements.username.value || '').trim().replace(/^@/, '');
    $('friend-search-result').replaceChildren();
    if (!username) return;
    const { data, error } = await state.client.rpc('find_profile_by_username', { p_username: username });
    if (error) throw error;
    const profile = Array.isArray(data) ? data[0] : data;
    if (!profile) { const empty = document.createElement('p'); empty.className = 'social-status'; empty.textContent = 'Não encontramos esse identificador.'; $('friend-search-result').append(empty); return; }
    state.profiles.set(profile.id, profile);
    const alreadyFriend = state.friends.some((friend) => friend.id === profile.id);
    const outgoing = state.outgoingRequests.some((request) => request.receiver_id === profile.id);
    const incoming = state.incomingRequests.find((request) => request.sender_id === profile.id);
    const buttons = alreadyFriend ? [{ label: 'Enviar mensagem', action: () => openDirectMessage(profile) }]
      : incoming ? [{ label: 'Aceitar solicitação', action: async () => { const { error: responseError } = await state.client.rpc('respond_friend_request', { p_request_id: incoming.id, p_accept: true }); if (responseError) throw responseError; await loadFriends(); } }]
          : profile.allow_friend_requests === false ? []
            : outgoing ? []
          : [{ label: 'Adicionar amigo', action: async () => { const { error: requestError } = await state.client.rpc('send_friend_request', { p_user_id: profile.id }); if (requestError) throw requestError; await loadFriends(); socialStatus('Solicitação enviada.'); } }];
    const row = makeSocialRow(profile, buttons);
    if (outgoing) { const note = document.createElement('span'); note.className = 'social-row-handle'; note.textContent = 'Solicitação enviada'; row.append(note); }
    else if (!alreadyFriend && !incoming && profile.allow_friend_requests === false) { const note = document.createElement('span'); note.className = 'social-row-handle'; note.textContent = 'Solicitações desativadas'; row.append(note); }
    $('friend-search-result').append(row);
  }

  async function openMessages() {
    if (!requireAccount()) return;
    setActiveArea('messages');
    $('messages-dialog').hidden = false;
    $('direct-unread-count').hidden = true;
    $('direct-unread-count').textContent = '0';
    try { await loadFriends(); if (!state.friends.length) socialStatus('Adicione alguém como amigo para iniciar uma conversa.', 'messages-status'); }
    catch (error) { socialStatus(`${friendlyError(error)} Aplique primeiro a migração social do Supabase.`, 'messages-status', true); }
  }

  async function openDirectMessage(friend) {
    if (!state.session?.user) { openAccount(); return; }
    $('friends-dialog').hidden = true;
    $('messages-dialog').hidden = false;
    setActiveArea('messages');
    if (state.directSubscription) await state.client.removeChannel(state.directSubscription);
    state.directSubscription = null;
    state.directConversationId = null;
    state.directFriend = friend;
    state.directSeen.clear();
    $('dm-recipient').textContent = friend.display_name || friend.username || 'Mensagem direta';
    $('dm-messages').replaceChildren();
    $('direct-message-input').disabled = true;
    $('direct-message-form').querySelector('button[type="submit"]').disabled = true;
    $('call-dm-button').disabled = true;
    document.querySelectorAll('#dm-contacts [data-friend-id]').forEach((row) => row.setAttribute('aria-current', String(row.dataset.friendId === friend.id)));
    const { data: conversationId, error } = await state.client.rpc('open_direct_conversation', { p_user_id: friend.id });
    if (error) { socialStatus(friendlyError(error), 'messages-status', true); return; }
    state.directConversationId = conversationId;
    $('direct-message-input').disabled = false;
    $('direct-message-form').querySelector('button[type="submit"]').disabled = false;
    $('call-dm-button').disabled = false;
    const { data: messages, error: messagesError } = await state.client.from('direct_messages').select('id,sender_id,content,created_at').eq('conversation_id', conversationId).order('created_at', { ascending: true }).limit(100);
    if (messagesError) throw messagesError;
    for (const message of messages || []) displayDirectMessage(message);
    state.directSubscription = state.client.channel(`caemgamo-dm-${conversationId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'direct_messages', filter: `conversation_id=eq.${conversationId}` }, ({ new: message }) => displayDirectMessage(message))
      .subscribe((subscriptionStatus) => { if (['CHANNEL_ERROR', 'TIMED_OUT'].includes(subscriptionStatus)) socialStatus('A conexão caiu. Feche e reabra a conversa para tentar novamente.', 'messages-status', true); });
    $('dm-messages').scrollTop = $('dm-messages').scrollHeight;
    socialStatus('');
  }

  function displayDirectMessage(message) {
    if (!message?.id || state.directSeen.has(message.id)) return;
    state.directSeen.add(message.id);
    const row = document.createElement('div');
    row.className = `dm-message${message.sender_id === state.session?.user?.id ? ' mine' : ''}`;
    const content = document.createElement('div');
    const callInvite = /^CAEMGAMO_CALL:(direct-[a-zA-Z0-9-]{30,64})$/.exec(message.content);
    if (callInvite) {
      const link = document.createElement('a');
      link.className = 'primary-action call-invite-link';
      link.href = `/?sala=${encodeURIComponent(callInvite[1])}`;
      link.textContent = 'Entrar na chamada';
      content.append(link);
    } else content.textContent = message.content;
    const meta = document.createElement('small');
    meta.textContent = `${message.sender_id === state.session?.user?.id ? 'Você' : (state.directFriend?.display_name || 'Amigo')} · ${new Date(message.created_at).toLocaleString('pt-BR')}`;
    row.append(content, meta); $('dm-messages').append(row);
    $('dm-messages').scrollTop = $('dm-messages').scrollHeight;
  }

  async function sendDirectMessage(event) {
    event.preventDefault();
    const content = String($('direct-message-input').value || '').trim();
    if (!state.directConversationId || !content) return;
    const submit = $('direct-message-form').querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const { error } = await state.client.from('direct_messages').insert({ conversation_id: state.directConversationId, sender_id: state.session.user.id, content });
      if (error) throw error;
      $('direct-message-input').value = '';
      socialStatus('');
    } catch (error) { socialStatus(friendlyError(error), 'messages-status', true); }
    finally { submit.disabled = false; }
  }

  async function startDirectCall() {
    if (!state.directConversationId || !state.session?.user) return;
    const room = `direct-${String(state.directConversationId).replace(/[^a-zA-Z0-9-]/g, '')}`;
    const { error } = await state.client.from('direct_messages').insert({ conversation_id: state.directConversationId, sender_id: state.session.user.id, content: `CAEMGAMO_CALL:${room}` });
    if (error) throw error;
    location.assign(`/?sala=${encodeURIComponent(room)}`);
  }

  async function savePreferredTheme(theme) {
    if (!state.session?.user) return;
    const { error } = await state.client.from('profiles').update({ preferred_theme: theme }).eq('id', state.session.user.id);
    if (error) throw error;
    state.profile = { ...state.profile, preferred_theme: theme };
    $('settings-theme-select').value = theme;
  }

  async function setAllowFriendRequests(enabled) {
    if (!state.session?.user) return;
    const { error } = await state.client.from('profiles').update({ allow_friend_requests: Boolean(enabled) }).eq('id', state.session.user.id);
    if (error) throw error;
    state.profile = { ...state.profile, allow_friend_requests: Boolean(enabled) };
    $('privacy-settings-status').textContent = enabled ? 'Solicitações de amizade permitidas.' : 'Novas solicitações de amizade foram bloqueadas pelo banco.';
  }

  async function watchFriendRequests() {
    if (state.friendsSubscription) await state.client.removeChannel(state.friendsSubscription);
    if (!state.session?.user) { state.friendsSubscription = null; return; }
    state.friendsSubscription = state.client.channel(`caemgamo-friends-${state.session.user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friend_requests' }, () => {
        loadFriends().catch((error) => socialStatus(friendlyError(error), 'friends-status', true));
      })
      .subscribe();
  }

  async function watchDirectMessages() {
    if (state.dmNotifications) await state.client.removeChannel(state.dmNotifications);
    state.dmNotifications = null;
    if (!state.session?.user) return;
    state.dmNotifications = state.client.channel(`caemgamo-dm-notifications-${state.session.user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'direct_messages' }, async ({ new: message }) => {
        if (message.sender_id === state.session?.user?.id) return;
        if (message.conversation_id === state.directConversationId) { displayDirectMessage(message); return; }
        try { await loadSocialProfiles([message.sender_id]); } catch { /* o aviso continua genérico */ }
        const sender = profileFor(message.sender_id).display_name || 'um amigo';
        const invite = /^CAEMGAMO_CALL:(direct-[a-zA-Z0-9-]{30,64})$/.exec(message.content || '');
        const isCall = Boolean(invite);
        const badge = $('direct-unread-count');
        badge.hidden = false;
        badge.textContent = String(Math.min(99, Number(badge.textContent || 0) + 1));
        window.CAEMGAMO_DESKTOP_NOTIFY?.(
          isCall ? `Chamada de ${sender}` : `Mensagem de ${sender}`,
          isCall ? 'Toque para entrar na chamada.' : 'Toque para abrir a conversa.',
          isCall ? () => location.assign(`/?sala=${encodeURIComponent(invite[1])}`) : () => openDirectMessage(profileFor(message.sender_id)).catch((error) => socialStatus(friendlyError(error), 'messages-status', true))
        );
        window.CAEMGAMO_TOAST?.(isCall ? `${sender} convidou você para uma chamada. Abra Mensagens para entrar.` : `Nova mensagem de ${sender}.`);
      })
      .subscribe((subscriptionStatus) => {
        if (['CHANNEL_ERROR', 'TIMED_OUT'].includes(subscriptionStatus) && state.session?.user) socialStatus('As notificações de mensagens foram desconectadas.', 'messages-status', true);
      });
  }

  function activateSettingsTab(tab) {
    document.querySelectorAll('[data-settings-tab]').forEach((button) => button.setAttribute('aria-current', String(button.dataset.settingsTab === tab)));
    document.querySelectorAll('[data-settings-section]').forEach((section) => { section.hidden = section.dataset.settingsSection !== tab; });
  }

  function closeSocialViews() {
    $('friends-dialog').hidden = true;
    $('messages-dialog').hidden = true;
    if (state.directSubscription && state.client) state.client.removeChannel(state.directSubscription).catch(() => {});
    state.directSubscription = null;
    state.directConversationId = null;
    state.directFriend = null;
  }

  function setActiveArea(area) {
    document.querySelectorAll('#workspace-nav button').forEach((button) => {
      if (button.id === `nav-${area}`) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function watchModerationNotices() {
    if (state.moderationSubscription) state.client.removeChannel(state.moderationSubscription);
    const userId = state.session?.user?.id;
    if (!userId) return;
    state.moderationSubscription = state.client.channel(`caemgamo-moderation-${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'moderation_cases', filter: `subject_id=eq.${userId}` }, ({ new: item }) => {
        const end = item.expires_at ? ` até ${new Date(item.expires_at).toLocaleString('pt-BR')}` : '';
        window.CAEMGAMO_TOAST?.(`Moderação: ${item.action}${end}${item.reason ? ` · ${item.reason}` : ''}`);
      })
      .subscribe();
  }

  function friendlyError(error) {
    const text = String(error?.message || '');
    if (/profiles_username_unique|duplicate key/i.test(text)) return 'Esse nome de usuário já está em uso. Escolha outro.';
    if (/invalid profile handle/i.test(text)) return 'Use um identificador de 3 a 32 letras, números ou sublinhados, começando com letra ou número.';
    if (/message_rate_limited/i.test(text)) return 'Você enviou várias mensagens em pouco tempo. Aguarde alguns segundos.';
    if (/(community|invite|moderation)_rate_limited/i.test(text)) return 'Muitas ações em pouco tempo. Aguarde alguns minutos e tente de novo.';
    if (/duplicate key|already exists/i.test(text)) return 'Este nome já está em uso. Escolha outro.';
    if (/permission|row-level|policy|not permitted|insufficient/i.test(text)) return 'Sua conta não tem permissão para esta ação.';
    if (/fetch|network|timeout/i.test(text)) return 'Sem conexão com o serviço. Tente novamente.';
    return text || 'Não foi possível concluir a ação.';
  }

  async function runAccountForm(event, action) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = event.submitter || form.querySelector('button[type="submit"]');
    if (submit.disabled) return;
    const originalText = submit.textContent;
    submit.disabled = true;
    submit.textContent = 'Aguarde…';
    try { await action(new FormData(form)); }
    finally { submit.disabled = false; submit.textContent = originalText; }
  }

  function bindForms() {
    for (const id of ['profile-button', 'rail-profile-button', 'rail-settings-button']) $(id).addEventListener('click', openAccount);
    document.querySelectorAll('[data-settings-tab]').forEach((button) => button.addEventListener('click', () => activateSettingsTab(button.dataset.settingsTab)));
    document.querySelectorAll('[data-friends-tab]').forEach((button) => button.addEventListener('click', () => activateFriendsTab(button.dataset.friendsTab)));
    $('nav-friends').addEventListener('click', () => openFriends().catch((error) => socialStatus(friendlyError(error), 'friends-status', true)));
    $('nav-messages').addEventListener('click', () => openMessages().catch((error) => socialStatus(friendlyError(error), 'messages-status', true)));
    $('nav-calls').addEventListener('click', () => { closeSocialViews(); setActiveArea('calls'); document.querySelector('.main-column')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    $('nav-communities').addEventListener('click', () => { closeSocialViews(); setActiveArea('communities'); });
    $('nav-streams').addEventListener('click', () => { closeSocialViews(); setActiveArea('streams'); $('share-button').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    $('friends-close').addEventListener('click', () => { $('friends-dialog').hidden = true; });
    $('messages-close').addEventListener('click', async () => {
      $('messages-dialog').hidden = true;
      if (state.directSubscription) await state.client.removeChannel(state.directSubscription);
      state.directSubscription = null; state.directConversationId = null; state.directFriend = null;
    });
    $('friends-dialog').addEventListener('click', (event) => { if (event.target === $('friends-dialog')) $('friends-dialog').hidden = true; });
    $('messages-dialog').addEventListener('click', (event) => { if (event.target === $('messages-dialog')) closeSocialViews(); });
    $('friend-search-form').addEventListener('submit', (event) => { event.preventDefault(); searchFriend().catch((error) => socialStatus(friendlyError(error), 'friends-status', true)); });
    $('direct-message-form').addEventListener('submit', sendDirectMessage);
    $('call-dm-button').addEventListener('click', () => startDirectCall().catch((error) => socialStatus(friendlyError(error), 'messages-status', true)));
    $('direct-message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('direct-message-form').requestSubmit(); } });
    $('home-server-button').addEventListener('click', () => location.assign('/'));
    $('account-close').addEventListener('click', () => { if (state.session?.user) $('account-dialog').hidden = true; });
    $('account-dialog').addEventListener('click', (event) => { if (event.target === $('account-dialog') && state.session?.user) $('account-dialog').hidden = true; });
    $('chat-menu').addEventListener('click', () => {
      const menu = $('chat-menu-options');
      menu.hidden = !menu.hidden;
      $('chat-menu').setAttribute('aria-expanded', String(!menu.hidden));
    });
    $('refresh-chat-button').addEventListener('click', async () => {
      $('chat-menu-options').hidden = true;
      $('chat-menu').setAttribute('aria-expanded', 'false');
      try { await refreshTextChannel(); }
      catch (error) { window.CAEMGAMO_TOAST?.(friendlyError(error)); }
    });
    $('copy-chat-invite-button').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      $('chat-menu-options').hidden = true;
      $('chat-menu').setAttribute('aria-expanded', 'false');
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(location.href);
        else {
          const field = document.createElement('textarea');
          field.value = location.href;
          field.style.position = 'fixed';
          field.style.opacity = '0';
          document.body.append(field);
          field.select();
          if (!document.execCommand('copy')) throw new Error('clipboard indisponível');
          field.remove();
        }
        button.textContent = 'Copiado!';
        setTimeout(() => { button.textContent = '↗ Copiar link desta sala'; }, 1500);
      } catch { window.CAEMGAMO_TOAST?.('Não foi possível copiar o link. Use o botão Convidar da sala.'); }
    });
    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('.chat-menu-wrap')) {
        $('chat-menu-options').hidden = true;
        $('chat-menu').setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        $('chat-menu-options').hidden = true;
        $('chat-menu').setAttribute('aria-expanded', 'false');
        closeSocialViews();
        if (state.session?.user) $('account-dialog').hidden = true;
      }
    });
    $('show-sign-up').addEventListener('click', () => showForm('sign-up-form'));
    $('show-sign-in').addEventListener('click', () => showForm('sign-in-form'));
    $('show-recovery').addEventListener('click', () => showForm('recovery-form'));
    $('show-sign-in-from-recovery').addEventListener('click', () => showForm('sign-in-form'));
    $('show-sign-in-from-code').addEventListener('click', () => showForm('sign-in-form'));
    $('sign-in-form').addEventListener('submit', (event) => runAccountForm(event, async (values) => {
      try {
        const { error } = await state.client.auth.signInWithPassword({ email: values.get('email'), password: values.get('password') });
        if (error) throw error;
        $('account-dialog').hidden = true;
        status('Login realizado.');
        window.CAEMGAMO_ROOM_AUTH_CHANGED?.(true);
      } catch (error) { status(friendlyError(error), true); }
    }));
    $('sign-up-form').addEventListener('submit', (event) => runAccountForm(event, async (values) => {
      try {
        const { data, error } = await state.client.auth.signUp({ email: values.get('email'), password: values.get('password'), options: { data: { display_name: String(values.get('display_name')).trim() }, emailRedirectTo: `${location.origin}/` } });
        if (error) throw error;
        if (!data.session) { showForm('sign-in-form'); status('Se o endereço for válido, enviaremos uma mensagem para confirmar a conta.'); }
        else { $('account-dialog').hidden = true; status('Conta criada.'); }
      } catch (error) { status(friendlyError(error), true); }
    }));
    $('recovery-form').addEventListener('submit', (event) => runAccountForm(event, async (values) => {
      await requestRecoveryCode(values.get('email'));
    }));
    $('recovery-code-form').addEventListener('submit', (event) => runAccountForm(event, async (values) => {
      const email = String(values.get('email')).trim();
      const token = String(values.get('token')).trim();
      try {
        const { error } = await state.client.auth.verifyOtp({ email, token, type: 'recovery' });
        if (error) throw error;
        state.recoveryEmail = email;
        history.replaceState({}, '', `${location.pathname}?recuperar=1`);
        showForm('new-password-form');
        status('Código validado. Escolha uma nova senha.');
      } catch (error) { status(friendlyError(error), true); }
    }));
    $('resend-recovery-code').addEventListener('click', () => requestRecoveryCode($('recovery-code-form').elements.email.value));
    $('new-password-form').addEventListener('submit', (event) => runAccountForm(event, async (values) => {
      const password = values.get('password');
      try {
        const { error } = await state.client.auth.updateUser({ password });
        if (error) throw error;
        history.replaceState({}, '', location.pathname);
        $('account-dialog').hidden = true;
        status('Senha alterada.');
      } catch (error) { status(friendlyError(error), true); }
    }));
    $('profile-form').addEventListener('submit', (event) => runAccountForm(event, async (values) => {
      const display_name = String(values.get('display_name')).trim();
      const username = String(values.get('username')).trim().replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9][a-z0-9_]{2,31}$/.test(username)) { status('Use um identificador de 3 a 32 letras, números ou sublinhados, começando com letra ou número.', true); return; }
      try {
        const { error } = await state.client.from('profiles').update({ display_name, username }).eq('id', state.session.user.id);
        if (error) throw error;
        state.profile = { ...state.profile, username, display_name };
        state.profiles.set(state.session.user.id, { ...(state.profiles.get(state.session.user.id) || {}), ...state.profile });
        setAvatar(avatarUrl(state.profile.avatar_path), display_name);
        updateAccountView();
        status('Perfil salvo.');
      } catch (error) { status(friendlyError(error), true); }
    }));
    $('settings-theme-select').addEventListener('change', async () => {
      const theme = $('settings-theme-select').value;
      window.CAEMGAMO_APPLY_THEME?.(theme);
      try { await savePreferredTheme(theme); status('Tema salvo no seu perfil.'); }
      catch (error) { status(`O tema ficou salvo neste navegador, mas não no perfil: ${friendlyError(error)}`, true); }
    });
    $('allow-friend-requests').addEventListener('change', async () => {
      const checkbox = $('allow-friend-requests');
      checkbox.disabled = true;
      try { await setAllowFriendRequests(checkbox.checked); }
      catch (error) { checkbox.checked = state.profile?.allow_friend_requests !== false; $('privacy-settings-status').textContent = friendlyError(error); }
      finally { checkbox.disabled = false; }
    });
    $('avatar-file').addEventListener('change', async (event) => {
      try { await changeAvatar(event.target.files?.[0]); }
      catch (error) { status(friendlyError(error), true); }
      event.target.value = '';
    });
    $('remove-avatar-button').addEventListener('click', () => removeAvatar().catch((error) => status(friendlyError(error), true)));
    $('profile-reset-password').addEventListener('click', async () => {
      await requestRecoveryCode(state.session.user.email);
    });
    $('sign-out-button').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const { error } = await state.client.auth.signOut({ scope: 'local' });
        if (error) throw error;
        window.CAEMGAMO_END_CALL?.();
        state.session = null;
        await settleAuth();
        openAccount();
        closeSocialViews();
        status('Você saiu da conta.');
        if (requestedChannel) location.replace('/');
      } catch (error) { status(friendlyError(error), true); }
      finally { button.disabled = false; }
    });
    $('create-community-button').addEventListener('click', () => createCommunity().catch((error) => status(friendlyError(error), true)));
    $('add-community-button').addEventListener('click', () => createCommunity().catch((error) => status(friendlyError(error), true)));
    $('join-community-button').addEventListener('click', () => joinInvite().catch((error) => status(friendlyError(error), true)));
    $('explore-community-button').addEventListener('click', () => exploreCommunities().catch((error) => status(friendlyError(error), true)));
    $('create-channel-button').addEventListener('click', () => createChannel().catch((error) => status(friendlyError(error), true)));
    $('create-invite-button').addEventListener('click', () => createInvite().catch((error) => status(friendlyError(error), true)));
    $('manage-members-button').addEventListener('click', () => manageMembers().catch((error) => status(friendlyError(error), true)));
    $('manage-roles-button').addEventListener('click', () => manageRoles().catch((error) => status(friendlyError(error), true)));
    $('view-reports-button').addEventListener('click', () => viewReports().catch((error) => status(friendlyError(error), true)));
    $('view-audit-button').addEventListener('click', () => viewAudit().catch((error) => status(friendlyError(error), true)));
    $('revoke-invite-button').addEventListener('click', () => revokeInvite().catch((error) => status(friendlyError(error), true)));
    $('edit-community-button').addEventListener('click', () => editCommunity().catch((error) => status(friendlyError(error), true)));
    $('community-icon-button').addEventListener('click', () => $('community-icon-file').click());
    $('community-icon-file').addEventListener('change', async (event) => {
      try { await uploadCommunityIcon(event.target.files?.[0]); }
      catch (error) { status(friendlyError(error), true); }
      event.target.value = '';
    });
    $('leave-community-button').addEventListener('click', () => leaveCommunity().catch((error) => status(friendlyError(error), true)));
    $('sticker-button').addEventListener('click', () => sendSticker().catch((error) => window.CAEMGAMO_TOAST?.(friendlyError(error))));
    $('gift-button').addEventListener('click', () => sendGift().catch((error) => window.CAEMGAMO_TOAST?.(friendlyError(error))));
    $('upload-audio-button').addEventListener('click', () => $('audio-file').click());
    $('audio-file').addEventListener('change', async (event) => {
      try { await sendAudioFile(event.target.files?.[0]); }
      catch (error) { window.CAEMGAMO_TOAST?.(friendlyError(error)); }
      event.target.value = '';
    });
    $('record-audio-button').addEventListener('click', () => toggleAudioRecording().catch((error) => window.CAEMGAMO_TOAST?.(friendlyError(error))));
    $('chat-body').addEventListener('click', (event) => {
      const button = event.target.closest('[data-report-message]');
      if (button) reportMessage(button.dataset.reportMessage).catch((error) => window.CAEMGAMO_TOAST?.(friendlyError(error)));
    });
    document.querySelectorAll('[data-preset-avatar]').forEach((button) => button.addEventListener('click', () => changePresetAvatar(button.dataset.presetAvatar).catch((error) => status(friendlyError(error), true))));
  }

  window.CaemgamoCommunity = {
    ready: null,
    canSend: false,
    activeTextChannel: null,
    getAccessToken: async () => state.session?.access_token || '',
    getUserId: () => state.session?.user?.id || '',
    savePreferredTheme,
    sendText,
    refreshTextChannel
  };
  window.CAEMGAMO_OPEN_FRIENDS = () => openFriends();
  window.CAEMGAMO_OPEN_MESSAGES = () => openMessages();

  bindForms();
  document.querySelectorAll('#auth-forms button[type="submit"]').forEach((button) => { button.disabled = true; });
  window.CaemgamoCommunity.ready = (async () => {
    try {
      const response = await fetch('/config.json', { cache: 'no-store' });
      const config = await response.json();
      if (!config.supabaseUrl || !config.supabaseAnonKey) {
        $('auth-config-warning').hidden = false;
        $('auth-config-warning').textContent = 'Contas e comunidades estão prontas, mas precisam da URL e da chave pública do seu projeto Supabase. Veja CONFIGURACAO_SUPABASE.md.';
        document.querySelectorAll('#auth-forms button[type="submit"]').forEach((button) => { button.disabled = true; });
        for (const id of ['create-community-button', 'join-community-button', 'add-community-button']) $(id).disabled = true;
        return;
      }
      await loadSupabaseSdk();
      state.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true } });
      state.configured = true;
      showForm('sign-in-form');
      const { data, error } = await state.client.auth.getSession();
      if (error) throw error;
      state.session = data.session;
      window.CAEMGAMO_SET_MEDIA_USER?.(state.session?.user?.id || '');
      await settleAuth();
      if (inviteToken && !state.session?.user) {
        try { sessionStorage.setItem('caemgamo-pending-invite', inviteToken); } catch { /* o convite permanece no endereço */ }
        openAccount();
      }
      if (requestedChannel && !state.session?.user) openAccount();
      state.client.auth.onAuthStateChange((event, session) => {
        const previousUserId = state.session?.user?.id || '';
        state.session = session;
        const userId = state.session?.user?.id || '';
        window.CAEMGAMO_SET_MEDIA_USER?.(userId);
        if (event === 'SIGNED_OUT') {
          window.CAEMGAMO_END_CALL?.();
          closeSocialViews();
        }
        if (event === 'PASSWORD_RECOVERY') {
          $('account-dialog').hidden = false;
          showForm('new-password-form');
        }
        if (previousUserId === userId && ['INITIAL_SESSION', 'TOKEN_REFRESHED'].includes(event)) return;
        queueMicrotask(async () => {
          try {
            await settleAuth();
            if (event === 'SIGNED_IN') $('account-dialog').hidden = true;
          } catch (authError) { status(friendlyError(authError), true); }
        });
      });
      const recovery = Boolean(state.session?.user) && (new URLSearchParams(location.search).get('recuperar') === '1' || hashParams.get('type') === 'recovery');
      if (recovery) { $('account-dialog').hidden = false; showForm('new-password-form'); }
      if (requestedChannel && state.session?.user) {
        const { data: voiceChannel, error: voiceError } = await state.client.from('channels').select('id,name,community_id,kind').eq('id', requestedChannel).maybeSingle();
        if (!voiceError && voiceChannel?.kind === 'voice') {
          state.channel = voiceChannel;
          state.communityId = voiceChannel.community_id;
          const { data: community } = await state.client.from('communities').select('id,name,description,is_public,icon_path').eq('id', voiceChannel.community_id).maybeSingle();
          if (community && !state.communities.some((item) => item.id === community.id)) state.communities.unshift(community);
          $('workspace-name').textContent = community?.name || 'Comunidade';
          const heading = document.querySelector('.room-header h1');
          const icon = document.createElement('span');
          icon.className = 'voice-heading-icon';
          icon.textContent = '♫';
          heading.replaceChildren(icon, document.createTextNode(` ${voiceChannel.name}`));
        }
      }
    } catch (error) {
      console.error('Falha ao iniciar contas CAEMGAMO:', error?.message || '');
      $('auth-config-warning').hidden = false;
      $('auth-config-warning').textContent = 'Não foi possível conectar ao serviço de contas. Confira a configuração do Supabase.';
      state.configured = false;
      document.querySelectorAll('#auth-forms button[type="submit"]').forEach((button) => { button.disabled = true; });
    }
  })();

  async function settleAuth() {
    if (state.session?.user) {
      watchModerationNotices();
      await loadProfile();
      window.CAEMGAMO_SET_MEDIA_USER?.(state.session.user.id);
      let savedCommunity = null;
      try { savedCommunity = localStorage.getItem('caemgamo-community'); } catch { /* preferências opcionais */ }
      await loadCommunities(state.communityId || savedCommunity);
      try {
        await watchFriendRequests();
        await loadFriends();
        await watchDirectMessages();
      } catch (error) {
        if (!$('friends-dialog').hidden || !$('messages-dialog').hidden) socialStatus(`${friendlyError(error)} Aplique a migração social 202611070003_caemgamo_social.sql no Supabase.`, 'friends-status', true);
      }
      let pendingInvite = '';
      try { pendingInvite = sessionStorage.getItem('caemgamo-pending-invite') || inviteToken; } catch { pendingInvite = inviteToken; }
      if (pendingInvite) {
        try { await joinInvite(pendingInvite); }
        catch (error) {
          try { sessionStorage.removeItem('caemgamo-pending-invite'); } catch { /* armazenamento opcional */ }
          history.replaceState({}, '', location.pathname + location.search);
          status(friendlyError(error), true);
        }
      }
      if (!requestedChannel && !state.channel && state.communities.length === 0) {
        window.CaemgamoCommunity.canSend = false;
      }
      window.CAEMGAMO_ROOM_AUTH_CHANGED?.(true);
    } else {
      if (state.subscription) await state.client.removeChannel(state.subscription);
      if (state.moderationSubscription) await state.client.removeChannel(state.moderationSubscription);
      if (state.friendsSubscription) await state.client.removeChannel(state.friendsSubscription);
      if (state.directSubscription) await state.client.removeChannel(state.directSubscription);
      if (state.dmNotifications) await state.client.removeChannel(state.dmNotifications);
      state.subscription = null;
      state.moderationSubscription = null;
      state.friendsSubscription = null;
      state.directSubscription = null;
      state.dmNotifications = null;
      state.directConversationId = null;
      state.directFriend = null;
      state.directSeen.clear();
      state.profile = null;
      state.profiles.clear();
      state.friends = [];
      state.incomingRequests = [];
      state.outgoingRequests = [];
      state.channel = null;
      window.CaemgamoCommunity.activeTextChannel = null;
      clearChat();
      state.communities = [];
      state.communityId = null;
      window.CaemgamoCommunity.canSend = false;
      $('my-communities').replaceChildren();
      $('channel-list').replaceChildren();
      document.querySelectorAll('[data-community-button]').forEach((button) => button.remove());
      $('workspace-name').textContent = 'CAEMGAMO';
      $('friend-list').replaceChildren();
      $('pending-friend-list').replaceChildren();
      $('dm-contacts').replaceChildren();
      $('dm-messages').replaceChildren();
      $('direct-unread-count').hidden = true;
      $('direct-unread-count').textContent = '0';
      $('account-email').textContent = '—';
      $('profile-handle').textContent = '—';
      window.CAEMGAMO_SET_MEDIA_USER?.('');
      updateAccountView();
      window.CAEMGAMO_ROOM_AUTH_CHANGED?.(false);
    }
    window.CAEMGAMO_UPDATE_CHAT_STATE?.();
  }

  window.CAEMGAMO_FORCE_REAUTH = async () => {
    try {
      if (state.client) {
        const { error } = await state.client.auth.signOut({ scope: 'local' });
        if (error) throw error;
      }
      state.session = null;
      await settleAuth();
      openAccount();
    } catch (error) {
      openAccount();
      status(friendlyError(error), true);
    }
  };
})();
