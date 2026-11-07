# CAEMGAMO

Aplicativo web CAEMGAMO para amizades, mensagens diretas privadas e comunidades criadas por cada conta. A área inicial abre em Amigos; chamadas de voz, vídeo e compartilhamento de tela começam somente quando alguém escolhe entrar em um canal de voz. Com Supabase configurado, inclui contas por e-mail, recuperação por código, perfis, amizades, convites, canais, mensagens persistentes, presentes virtuais gratuitos, denúncias e cargos com permissões configuráveis.

Logo vetorial: [logo.svg](public/logo.svg). Ícone do aplicativo: [caemgamo-icon.svg](public/caemgamo-icon.svg).

## Iniciar localmente

1. Instale o Node.js 18 ou mais recente.
2. Abra um terminal nesta pasta e execute `npm install`.
3. Execute `npm start`.
4. Acesse `http://localhost:4173`.
5. Use **Convidar pessoa** para enviar o link de uma sala direta.

É necessário criar ou acessar uma conta para usar o app. Depois do login, a tela abre em Amigos; cada pessoa pode criar comunidades privadas, convidar amigos e escolher canais de texto ou voz. Nenhuma sala é acessada automaticamente. Para ativar contas, comunidades, mensagens, amizades e mensagens diretas, siga [CONFIGURACAO_SUPABASE.md](CONFIGURACAO_SUPABASE.md) e aplique as quatro migrações em ordem. `GET /healthz` verifica se o processo está ativo; `GET /readyz` informa a prontidão, o backend de salas e se há configuração TURN no servidor.

Os testes locais usam `npm test` (ou `node --test tests/server.test.js tests/room-manager.test.js tests/client-ui-contract.test.js`). Os testes das políticas Postgres usam `supabase test db` e precisam de Supabase CLI e Docker.

## Configuração de produção

Configure as variáveis no serviço de hospedagem, usando um gerenciador de segredos para senhas e chaves:

| Variável | Uso |
| --- | --- |
| `PORT` | Porta HTTP do processo. O provedor costuma defini-la automaticamente. |
| `REDIS_URL` | Redis com TLS (`rediss://...`) para compartilhar salas entre processos. Sem esta variável, o app usa memória local. |
| `ALLOWED_ORIGINS` | Lista separada por vírgulas com as origens exatas permitidas, por exemplo `https://app.exemplo.com`. Por padrão, só é aceito o mesmo host da página. |
| `TRUST_PROXY_HEADERS` | Use `true` somente quando a origem dos pedidos for um proxy confiável, como um ALB privado. Permite usar o último endereço de `X-Forwarded-For` para limitar requisições por IP. |
| `STUN_URLS` | Servidores STUN separados por vírgula. O padrão é `stun:stun.l.google.com:19302`. |
| `CLOUDFLARE_TURN_KEY_ID` | ID da chave TURN criada no painel da Cloudflare. |
| `CLOUDFLARE_TURN_KEY_TOKEN` | Token Bearer privado retornado ao criar a chave TURN. Não é o token geral da conta; mantenha-o apenas no backend. |
| `CLOUDFLARE_TURN_TTL_SECONDS` | Validade das credenciais temporárias, limitada a 172.800 segundos (48 horas); esse é o padrão. |
| `TURN_URLS` | Endereços TURN separados por vírgula, se usar Coturn em vez da Cloudflare. |
| `TURN_SHARED_SECRET` | Segredo compartilhado com Coturn para emitir credenciais TURN temporárias. Nunca coloque esse segredo no navegador. |
| `TURN_TTL_SECONDS` | Validade das credenciais Coturn, limitada entre 300 e 86.400 segundos; o padrão é 3.600. |
| `SUPABASE_URL` | URL HTTPS do projeto Supabase. |
| `SUPABASE_ANON_KEY` | Chave pública Publishable (ou legada `anon`); não use uma chave administrativa. |

O cliente Redis usa Pub/Sub para encaminhar sinalização entre processos e um hash com expiração para registrar participantes. O Pub/Sub não guarda mensagens para assinantes que estavam desconectados; se o servidor ou a região cair, os usuários reconectam e renegociam a chamada. [Documentação do node-redis](https://redis.io/docs/latest/develop/use-cases/pub-sub/nodejs/).

Com `CLOUDFLARE_TURN_KEY_ID` (`uid`) e `CLOUDFLARE_TURN_KEY_TOKEN` (`key`) configurados, o backend solicita à Cloudflare credenciais temporárias quando uma pessoa entra na sala e envia ao navegador somente os ICE servers e as credenciais de curta duração. O token da chave TURN nunca é enviado ao cliente. Se o serviço Cloudflare estiver indisponível, o app registra um aviso e mantém STUN como alternativa; algumas redes restritivas podem então não conseguir completar chamadas. A Cloudflare documenta TTL máximo de 48 horas e geração das credenciais no backend em [Generate TURN credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/).

Como alternativa, para habilitar TURN no Coturn, configure `use-auth-secret` e `static-auth-secret` com o mesmo segredo usado em `TURN_SHARED_SECRET`. O servidor gera usuário com expiração e senha HMAC-SHA1; o navegador recebe somente as credenciais temporárias. Configure cotas de alocação e banda no Coturn para limitar abuso e custos. [Documentação REST do Coturn](https://github.com/coturn/coturn/blob/master/README.turnserver).

## Proteções incluídas

- Salas novas usam tokens aleatórios de 128 bits gerados com Web Crypto. O servidor não impõe um limite numérico de participantes. Ele valida a sessão Supabase antes de admitir cada pessoa e confirma no banco a associação para canais de voz e chamadas diretas.
- Áudio, câmera, tela e mensagens usam conexões WebRTC diretas entre os navegadores. A malha direta cresce rapidamente em uso de banda e processamento conforme o grupo aumenta; remover o teto do app não torna a capacidade infinita. Para grupos grandes e chamadas estáveis, use um SFU, como LiveKit.
- O servidor valida a origem do WebSocket, limita conexões, tentativas de entrada e mensagens de sinalização, e rejeita frames acima de 1 MiB.
- O processo envia heartbeats pelo WebSocket e renova a presença das salas no Redis.
- O cliente tenta reconectar com espera progressiva; ao voltar, entra novamente na sala e renegocia a conexão.

As cotas e limites de frequência são proteções básicas. Em produção, monitore tráfego e ajuste-os para o volume real. Chamadas e mensagens em salas diretas continuam sendo enviadas entre navegadores via WebRTC, sem histórico no servidor. Mensagens de canais Supabase ficam no Postgres e são entregues em tempo real; RLS limita leitura e envio. Figurinhas, presentes virtuais sem pagamento e clipes gravados ou enviados (até 30 segundos e 10 MB) são anexos dos canais de texto. A duração de áudio é conferida pelo navegador e não por um transcodificador confiável no servidor.

## Hospedagem

O servidor precisa ficar atrás de HTTPS e aceitar WebSocket. Use `/healthz` para liveness e `/readyz` como prontidão do balanceador. O Redis precisa ser compartilhado pelos processos Node da mesma região. Uma região reserva exige outra configuração Redis; após failover, clientes precisam reconectar e reconstruir salas. As sessões já abertas não migram entre regiões.

Em computadores, navegadores atuais normalmente oferecem compartilhamento de tela. Em celulares, isso depende do suporte do sistema e do navegador; a hospedagem HTTPS não adiciona suporte que o navegador não possua.
