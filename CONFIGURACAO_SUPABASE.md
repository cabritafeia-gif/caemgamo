# Configurar contas e comunidades do CAEMGAMO

O código está pronto para Supabase, mas cadastro, comunidades e mensagens persistentes só ficam ativos depois de conectar um projeto.

## 1. Criar o backend

1. Crie um projeto Supabase.
2. No **SQL Editor**, abra e execute [a migração](supabase/migrations/202611070001_caemgamo_communities.sql). Ela cria perfis, comunidades, canais, convites, mensagens, controles de moderação, auditoria, buckets de mídia e políticas RLS.
3. Em **Authentication → URL Configuration**, configure a URL pública do CAEMGAMO como **Site URL**. Inclua os endereços locais e todas as origens usadas para testar como URLs de redirecionamento permitidas.
4. Em **Authentication → Email**, habilite confirmação de e-mail e configure um provedor SMTP para entrega consistente de confirmações e recuperação de senha.

Use a URL do projeto e uma chave **Publishable** (ou a chave pública legada `anon`) na aplicação. Não use `service_role`/`secret` no navegador, no Render ou no repositório. A chave pública identifica o projeto; o acesso aos dados é controlado pelas políticas RLS.

## 2. Configurar o Render

Em **Render → serviço web → Environment**, adicione:

| Nome | Valor |
| --- | --- |
| `SUPABASE_URL` | URL HTTPS do projeto Supabase |
| `SUPABASE_ANON_KEY` | chave Publishable ou `anon` |

Salve e faça um novo deploy da versão do CAEMGAMO. O endpoint `/config.json` publica apenas esses dois valores para o navegador. Para desenvolvimento local, defina as mesmas variáveis no terminal antes de executar `node server.js`.

## 3. Testar a base de dados

Com Docker e Supabase CLI instalados, execute `supabase start` e depois `supabase test db`. Os testes em `supabase/tests/` verificam perfis, envio de mensagens, limite anti-spam, bloqueio de mute/ban, expiração e hierarquia de papéis. Para testar envio de e-mail, é necessário configurar SMTP e usar uma conta de teste.

## Limites conhecidos

- Áudio ao vivo, câmera e transmissão continuam usando WebRTC ponto a ponto. O servidor de mídia não é um SFU; várias câmeras em uma sala com 15 pessoas podem exigir muita banda e processamento. TURN melhora conectividade quando configurado.
- Clipes de áudio têm limite de 30 segundos medido no navegador, tamanho máximo de 10 MB imposto pelo Storage e formatos de áudio permitidos. A duração é informada pelo cliente; validar duração a partir do arquivo contra um cliente modificado exige um serviço confiável de transcodificação/inspeção, que ainda não está configurado.
- Os canais de texto persistentes são protegidos por RLS, mas retenção e exclusão administrativa de mensagens ainda não têm uma tela própria.
- A hospedagem continua sujeita às políticas e limites do Render e do Supabase; este código não pode garantir disponibilidade perpétua.
