(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    client: null, session: null, profile: null, communities: [], communityId: null,
    channel: null, subscription: null, moderationSubscription: null, seenMessages: new Set(), profiles: new Map(), configured: false
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
    for (const id of ['sign-in-form', 'sign-up-form', 'recovery-form', 'new-password-form']) $(id).hidden = id !== name;
    document.querySelectorAll('#auth-forms button[type="submit"]').forEach((button) => { button.disabled = !state.configured; });
    $('profile-panel').hidden = true;
    status('');
  }

  function setAvatar(url, name) {
    const button = $('profile-button');
    const rail = document.querySelector('.rail-user-avatar');
    const initials = (name || 'C').trim().slice(0, 1).toUpperCase();
    for (const target of [button, rail, $('profile-initial')]) {
      if (!target) continue;
      target.textContent = initials;
      target.style.backgroundImage = '';
      if (url && (target === button || target === rail)) {
        target.style.backgroundImage = `url("${url.replaceAll('"', '')}")`;
        target.classList.add('has-avatar');
      } else target.classList.remove('has-avatar');
    }
    const image = $('profile-image');
    if (image) {
      image.hidden = !url;
      if (url) image.src = url;
    }
  }

  function avatarUrl(path) {
    if (!path || !state.client) return '';
    return state.client.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  }

  function avatarUrlFrom(bucket, path) {
    if (!path || !state.client) return '';
    return state.client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }

  function updateAccountView() {
    const signedIn = Boolean(state.session?.user);
    $('auth-forms').hidden = signedIn;
    $('profile-panel').hidden = !signedIn;
    $('profile-button').title = signedIn ? 'Seu perfil' : 'Entrar ou criar conta';
    $('workspace-name').textContent = state.communities.find((item) => item.id === state.communityId)?.name || 'CAEMGAMO';
    for (const id of ['create-community-button', 'join-community-button', 'explore-community-button', 'add-community-button']) $(id).disabled = !state.configured || !signedIn;
    for (const id of ['create-channel-button', 'create-invite-button', 'revoke-invite-button', 'manage-members-button', 'edit-community-button', 'community-icon-button', 'leave-community-button']) $(id).disabled = !state.configured || !signedIn || !state.communityId;
    if (signedIn && state.profile) {
      $('profile-form').elements.display_name.value = state.profile.display_name || '';
      $('profile-form').elements.theme.value = state.profile.preferred_theme || 'dark';
      setAvatar(avatarUrl(state.profile.avatar_path), state.profile.display_name);
    } else setAvatar('', 'C');
  }

  async function loadProfile() {
    if (!state.session?.user) return;
    const { data, error } = await state.client.from('profiles').select('id,display_name,avatar_path,preferred_theme').eq('id', state.session.user.id).maybeSingle();
    if (error) throw error;
    state.profile = data;
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

  async function loadChannels() {
    const container = $('channel-list');
    container.replaceChildren();
    if (!state.communityId) return;
    const { data, error } = await state.client.from('channels').select('id,name,kind').eq('community_id', state.communityId).order('created_at');
    if (error) throw error;
    (data || []).forEach((channel) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'channel-row';
      button.innerHTML = `<span aria-hidden="true">${channel.kind === 'voice' ? '♫' : '#'}</span>`;
      const name = document.createElement('span');
      name.textContent = channel.name;
      button.append(name);
      button.addEventListener('click', () => channel.kind === 'voice' ? joinVoiceChannel(channel) : selectTextChannel(channel));
      container.append(button);
    });
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
    window.CaemgamoCommunity.activeTextChannel = channel.id;
    window.CaemgamoCommunity.canSend = true;
    $('chat-header').querySelector('h2').textContent = `# ${channel.name}`;
    $('chat-header').querySelector('span').textContent = 'Canal de texto da comunidade';
    $('system-message').textContent = 'Este canal salva as mensagens e aplica as regras de acesso da comunidade.';
    $('message-input').placeholder = `Mensagem em #${channel.name}`;
    $('chat-footnote').innerHTML = '<span>◈</span> Histórico salvo com acesso controlado pela comunidade.';
    clearChat();
    try {
      const { data, error } = await state.client.from('messages').select('id,author_id,content,created_at').eq('channel_id', channel.id).order('created_at', { ascending: true }).limit(100);
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

  function joinVoiceChannel(channel) {
    if (!state.session?.user) { openAccount(); return; }
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
    const action = prompt('Ação: papel:member, papel:mod, papel:admin, warning, mute, kick, ban, revogar, transferir')?.trim().toLowerCase();
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

  function openAccount() {
    $('account-dialog').hidden = false;
    if (state.session?.user) {
      $('auth-forms').hidden = true;
      $('profile-panel').hidden = false;
    } else {
      showForm('sign-in-form');
    }
  }

  function requireAccount() {
    if (state.session?.user) return true;
    openAccount();
    return false;
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
    if (/message_rate_limited/i.test(text)) return 'Você enviou várias mensagens em pouco tempo. Aguarde alguns segundos.';
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
    $('profile-button').addEventListener('click', openAccount);
    $('home-server-button').addEventListener('click', () => location.assign('/'));
    $('account-close').addEventListener('click', () => { $('account-dialog').hidden = true; });
    $('account-dialog').addEventListener('click', (event) => { if (event.target === $('account-dialog')) $('account-dialog').hidden = true; });
    $('show-sign-up').addEventListener('click', () => showForm('sign-up-form'));
    $('show-sign-in').addEventListener('click', () => showForm('sign-in-form'));
    $('show-recovery').addEventListener('click', () => showForm('recovery-form'));
    $('show-sign-in-from-recovery').addEventListener('click', () => showForm('sign-in-form'));
    $('sign-in-form').addEventListener('submit', (event) => runAccountForm(event, async (values) => {
      try {
        const { error } = await state.client.auth.signInWithPassword({ email: values.get('email'), password: values.get('password') });
        if (error) throw error;
        $('account-dialog').hidden = true;
        status('Login realizado.');
        if (requestedChannel) location.reload();
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
      const email = values.get('email');
      try { await state.client.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/?recuperar=1` }); }
      catch { /* resposta genérica para evitar revelar se o e-mail existe */ }
      status('Se houver uma conta para esse endereço, enviaremos instruções de recuperação.');
    }));
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
      const preferred_theme = String(values.get('theme'));
      try {
        const { error } = await state.client.from('profiles').update({ display_name, preferred_theme }).eq('id', state.session.user.id);
        if (error) throw error;
        state.profile = { ...state.profile, display_name, preferred_theme };
        window.CAEMGAMO_APPLY_THEME?.(preferred_theme);
        setAvatar(avatarUrl(state.profile.avatar_path), display_name);
        status('Perfil salvo.');
      } catch (error) { status(friendlyError(error), true); }
    }));
    $('avatar-file').addEventListener('change', async (event) => {
      try { await changeAvatar(event.target.files?.[0]); }
      catch (error) { status(friendlyError(error), true); }
      event.target.value = '';
    });
    $('profile-reset-password').addEventListener('click', async () => {
      try { await state.client.auth.resetPasswordForEmail(state.session.user.email, { redirectTo: `${location.origin}/?recuperar=1` }); }
      catch { /* manter resposta genérica */ }
      status('Se a conta puder receber e-mail, enviaremos as instruções de troca de senha.');
    });
    $('sign-out-button').addEventListener('click', async () => {
      const { error } = await state.client.auth.signOut();
      if (error) { status(friendlyError(error), true); return; }
      $('account-dialog').hidden = true;
      if (requestedChannel) location.reload();
    });
    $('create-community-button').addEventListener('click', () => createCommunity().catch((error) => status(friendlyError(error), true)));
    $('add-community-button').addEventListener('click', () => createCommunity().catch((error) => status(friendlyError(error), true)));
    $('join-community-button').addEventListener('click', () => joinInvite().catch((error) => status(friendlyError(error), true)));
    $('explore-community-button').addEventListener('click', () => exploreCommunities().catch((error) => status(friendlyError(error), true)));
    $('create-channel-button').addEventListener('click', () => createChannel().catch((error) => status(friendlyError(error), true)));
    $('create-invite-button').addEventListener('click', () => createInvite().catch((error) => status(friendlyError(error), true)));
    $('manage-members-button').addEventListener('click', () => manageMembers().catch((error) => status(friendlyError(error), true)));
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
    $('record-audio-button').addEventListener('click', () => toggleAudioRecording().catch((error) => window.CAEMGAMO_TOAST?.(friendlyError(error))));
  }

  window.CaemgamoCommunity = {
    ready: null,
    canSend: false,
    activeTextChannel: null,
    getAccessToken: async () => state.session?.access_token || '',
    sendText
  };

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
      await settleAuth();
      if (inviteToken && !state.session?.user) {
        try { sessionStorage.setItem('caemgamo-pending-invite', inviteToken); } catch { /* o convite permanece no endereço */ }
        openAccount();
      }
      if (requestedChannel && !state.session?.user) openAccount();
      state.client.auth.onAuthStateChange((_event, session) => {
        state.session = session;
        queueMicrotask(() => settleAuth().catch((authError) => status(friendlyError(authError), true)));
      });
      const recovery = new URLSearchParams(location.search).get('recuperar') === '1' || hashParams.get('type') === 'recovery';
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
      let savedCommunity = null;
      try { savedCommunity = localStorage.getItem('caemgamo-community'); } catch { /* preferências opcionais */ }
      await loadCommunities(state.communityId || savedCommunity);
      let pendingInvite = '';
      try { pendingInvite = sessionStorage.getItem('caemgamo-pending-invite') || inviteToken; } catch { pendingInvite = inviteToken; }
      if (pendingInvite) await joinInvite(pendingInvite);
      if (!requestedChannel && !state.channel && state.communities.length === 0) {
        window.CaemgamoCommunity.canSend = false;
      }
    } else {
      if (state.subscription) state.client.removeChannel(state.subscription);
      if (state.moderationSubscription) state.client.removeChannel(state.moderationSubscription);
      state.subscription = null;
      state.moderationSubscription = null;
      state.profile = null;
      state.channel = null;
      window.CaemgamoCommunity.activeTextChannel = null;
      clearChat();
      state.communities = [];
      state.communityId = null;
      window.CaemgamoCommunity.canSend = false;
      updateAccountView();
    }
    window.CAEMGAMO_UPDATE_CHAT_STATE?.();
  }
})();
