# CAEMGAMO

Protótipo de aplicativo web para salas privadas de duas pessoas. Inclui mensagens de texto ponto a ponto, chamada de áudio e vídeo e compartilhamento de tela quando o navegador oferece essa função. A interface usa uma navegação escura inspirada em apps de comunidades, com canais e participantes na lateral.

Logo vetorial: [logo.svg](public/logo.svg). Ícone do aplicativo: [caemgamo-icon.svg](public/caemgamo-icon.svg).

## Iniciar localmente

1. Instale o Node.js 18 ou mais recente.
2. Abra um terminal nesta pasta e execute `npm install`.
3. Execute `npm start`.
4. Acesse `http://localhost:4173`.
5. Use **Convidar pessoa** para enviar o link da sala.

O app funciona em modo local sem Redis. Cada sala admite duas pessoas e não usa cadastro. `GET /healthz` verifica se o processo está ativo; `GET /readyz` verifica se o serviço consegue aceitar salas.

## Configuração de produção

Configure as variáveis no serviço de hospedagem, usando um gerenciador de segredos para senhas e chaves:

| Variável | Uso |
| --- | --- |
| `PORT` | Porta HTTP do processo. O provedor costuma defini-la automaticamente. |
| `REDIS_URL` | Redis com TLS (`rediss://...`) para compartilhar salas entre processos. Sem esta variável, o app usa memória local. |
| `ALLOWED_ORIGINS` | Lista separada por vírgulas com as origens exatas permitidas, por exemplo `https://app.exemplo.com`. Por padrão, só é aceito o mesmo host da página. |
| `TRUST_PROXY_HEADERS` | Use `true` somente quando a origem dos pedidos for um proxy confiável, como um ALB privado. Permite usar o último endereço de `X-Forwarded-For` para limitar requisições por IP. |
| `STUN_URLS` | Servidores STUN separados por vírgula. O padrão é `stun:stun.l.google.com:19302`. |
| `TURN_URLS` | Endereços TURN separados por vírgula, como UDP e TLS. |
| `TURN_SHARED_SECRET` | Segredo compartilhado com o Coturn para emitir credenciais TURN temporárias. Nunca coloque esse segredo no navegador. |
| `TURN_TTL_SECONDS` | Validade das credenciais TURN, limitada entre 300 e 86.400 segundos; o padrão é 3.600. |

O cliente Redis usa Pub/Sub para encaminhar sinalização entre processos e um hash com expiração para registrar participantes. O Pub/Sub não guarda mensagens para assinantes que estavam desconectados; se o servidor ou a região cair, os usuários reconectam e renegociam a chamada. [Documentação do node-redis](https://redis.io/docs/latest/develop/use-cases/pub-sub/nodejs/).

Para habilitar TURN no Coturn, configure `use-auth-secret` e `static-auth-secret` com o mesmo segredo usado em `TURN_SHARED_SECRET`. O servidor gera usuário com expiração e senha HMAC-SHA1; o navegador recebe somente as credenciais temporárias. Configure cotas de alocação e banda no Coturn para limitar abuso e custos. [Documentação REST do Coturn](https://github.com/coturn/coturn/blob/master/README.turnserver).

## Proteções incluídas

- Salas novas usam tokens aleatórios de 128 bits gerados com Web Crypto. O servidor mantém compatibilidade com códigos antigos.
- O servidor valida a origem do WebSocket, limita conexões, tentativas de entrada e mensagens de sinalização, e rejeita frames acima de 1 MiB.
- O processo envia heartbeats pelo WebSocket e renova a presença das salas no Redis.
- O cliente tenta reconectar com espera progressiva; ao voltar, entra novamente na sala e renegocia a conexão.

As cotas e limites de frequência são proteções básicas. Em produção, monitore tráfego e ajuste-os para o volume real. O conteúdo de chamadas e mensagens continua sendo enviado entre os navegadores via WebRTC; não há histórico de mensagens no servidor.

## Hospedagem

O servidor precisa ficar atrás de HTTPS e aceitar WebSocket. Use `/healthz` para liveness e `/readyz` como prontidão do balanceador. O Redis precisa ser compartilhado pelos processos Node da mesma região. Uma região reserva exige outra configuração Redis; após failover, clientes precisam reconectar e reconstruir salas. As sessões já abertas não migram entre regiões.

Em computadores, navegadores atuais normalmente oferecem compartilhamento de tela. Em celulares, isso depende do suporte do sistema e do navegador; a hospedagem HTTPS não adiciona suporte que o navegador não possua.
