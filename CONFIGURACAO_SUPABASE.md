# Configurar contas e comunidades do CAEMGAMO

O código está pronto para Supabase, mas cadastro, comunidades, lista de amigos e mensagens persistentes só ficam ativos depois de conectar um projeto e aplicar as migrações.

## 1. Criar o backend

1. Crie um projeto Supabase.
2. No **SQL Editor**, abra e execute [a migração inicial](supabase/migrations/202611070001_caemgamo_communities.sql). Ela cria perfis, comunidades, canais, convites, mensagens, controles de moderação, auditoria, buckets de mídia e políticas RLS.
3. Depois, execute [a migração complementar](supabase/migrations/202611070002_caemgamo_complete_features.sql). Ela habilita cargos personalizados, denúncias, presentes virtuais gratuitos e avatares prontos. Ela é necessária para a versão atual do site.
4. Por último, execute [a migração social](supabase/migrations/202611070003_caemgamo_social.sql). Ela cria identificadores de amizade, solicitações e mensagens diretas com políticas RLS. Aceite a migration antes de usar Amigos ou Mensagens diretas.
5. Em **Authentication → URL Configuration**, configure a URL pública do CAEMGAMO como **Site URL**. Inclua os endereços locais e todas as origens usadas para testar como URLs de redirecionamento permitidas.
6. Em **Authentication → Email**, habilite confirmação de e-mail e configure um provedor SMTP para entrega consistente de confirmações e recuperação de senha.

Para a recuperação por código, abra **Authentication → Email Templates → Reset Password** e inclua `{{ .Token }}` no corpo do modelo. Você pode manter o link alternativo:

```html
<h2>Recuperar senha do CAEMGAMO</h2>
<p>Digite este código na tela de recuperação:</p>
<p><strong>{{ .Token }}</strong></p>
<p>Ou <a href="{{ .ConfirmationURL }}">abra o link para redefinir a senha</a>.</p>
<p>Se você não pediu a troca, ignore esta mensagem.</p>
```

O app valida o código pelo fluxo de recuperação do Supabase. O link de recuperação continua aceito quando o template o inclui. O código e o link são de uso único e têm validade definida nas configurações de Auth do projeto.

Use a URL do projeto e uma chave **Publishable** (ou a chave pública legada `anon`) na aplicação. Não use `service_role`/`secret` no navegador, no Render ou no repositório. A chave pública identifica o projeto; o acesso aos dados é controlado pelas políticas RLS.

## 2. Configurar o Render

Em **Render → serviço web → Environment**, adicione:

| Nome | Valor |
| --- | --- |
| `SUPABASE_URL` | URL HTTPS do projeto Supabase |
| `SUPABASE_ANON_KEY` | chave Publishable ou `anon` |

Salve e faça um novo deploy da versão do CAEMGAMO. O endpoint `/config.json` publica apenas esses dois valores para o navegador. Para desenvolvimento local, defina as mesmas variáveis no terminal antes de executar `node server.js`.

## 3. Testar a base de dados

Com Docker e Supabase CLI instalados, execute `supabase start` e depois `supabase test db`. Os testes em `supabase/tests/` verificam perfis, envio de mensagens e presentes, limite anti-spam, bloqueio de mute/ban, expiração, cargos, denúncias, solicitações de amizade e isolamento das mensagens diretas. Para testar envio de e-mail, é necessário configurar SMTP e usar uma conta de teste.

## Proteções e limites conhecidos

- Áudio ao vivo, câmera e transmissão continuam usando WebRTC ponto a ponto. O servidor de mídia não é um SFU; várias câmeras em uma sala com 15 pessoas podem exigir muita banda e processamento. TURN melhora conectividade quando configurado.
- Áudios gravados ou enviados têm até 30 segundos medidos no navegador, limite de 10 MB imposto pelo Storage e tipos MIME permitidos. Um cliente modificado pode falsificar a duração; verificar o arquivo com confiabilidade exigiria processamento de mídia no servidor, que não está configurado.
- O banco limita mensagens a cinco por pessoa a cada dez segundos, convites a 30 por hora, moderação a 30 ações por dez minutos e denúncias a dez por hora. O Supabase Auth também limita solicitações de recuperação e tentativas de validação; mantenha uma expiração curta para OTP e monitore erros 429 no painel.
- Cargos personalizados têm permissões explícitas e hierarquia validada no banco; usuários não podem atribuir a si mesmos cargos iguais ou superiores. Denúncias e auditoria ficam visíveis apenas a quem tem a permissão correspondente. Presentes são apenas emojis gratuitos: não há moeda, cobrança nem transação simulada.
- Amigos são encontrados pelo identificador público imutável exibido no perfil. Solicitações, amizades e mensagens diretas são restringidas no banco aos participantes; a preferência para bloquear solicitações também é conferida no backend. Remover uma amizade remove a conversa direta associada.
- Voz e vídeo incluem seleção local de dispositivos quando o navegador oferece essa API, teste do microfone, tom de teste para a saída e prévia local da câmera. Permissões e nomes dos dispositivos dependem do navegador e de HTTPS.
- Notificações do navegador funcionam enquanto a página do CAEMGAMO estiver aberta. Notificações push com o site fechado exigem outro serviço de push e chaves VAPID; ainda não estão configuradas.
- Os canais de texto persistentes são protegidos por RLS, mas retenção e exclusão administrativa de mensagens ainda não têm uma tela própria.
- A hospedagem continua sujeita às políticas e limites do Render e do Supabase; este código não pode garantir disponibilidade perpétua.
