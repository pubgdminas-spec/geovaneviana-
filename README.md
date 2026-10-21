# Geovane Viana — Salão de Beleza

Site em HTML, CSS e JavaScript com visual escuro/neon e detalhes dourados, servidor Node.js, agendamento com horários compartilhados, página Sobre Nós, galeria de fotos/vídeos, Área do Cliente e painel administrativo com aprovação de pedidos e bloqueio manual de horários.

## Abrir no computador (Windows)

1. Instale o Node.js LTS em https://nodejs.org/.
2. Extraia a pasta do projeto.
3. Dê dois cliques em `iniciar-site.bat`.
4. Acesse `http://127.0.0.1:3000`.
5. Para acompanhar um pedido de cliente, acesse `http://127.0.0.1:3000/cliente`.
6. Para administrar os pedidos e horários, acesse `http://127.0.0.1:3000/admin`.

O site continua disponível enquanto a janela preta do servidor estiver aberta. Sem `DATABASE_URL`, os agendamentos são salvos em `data/appointments.json` no computador. Faça backup desse arquivo.

## Páginas

- Início: `/`
- Sobre Nós: `/sobre-nos`
- Galeria: `/galeria`
- Área do Cliente: `/cliente` (consulta de pedido com WhatsApp + código de acompanhamento)
- Painel administrativo: `/admin`
- Verificação do servidor: `/api/health`

## Acesso administrativo local

- Usuário inicial: `admin`
- Senha inicial: `GV@2026!`

Essa senha só serve para uso local. **Troque-a antes de hospedar publicamente**. Na hospedagem, defina `ADMIN_USER` e uma `ADMIN_PASSWORD` forte por variáveis de ambiente. Nunca publique senhas dentro do código ou do GitHub.

## Galeria: pré-visualização de mídia

Os quadros da Galeria aceitam seleção de foto ou vídeo do computador e mostram uma prévia no navegador. **Essa prévia não publica nem envia o arquivo ao servidor** e desaparece ao sair ou atualizar a página. Para publicar mídias reais para todo mundo, é necessário usar armazenamento de arquivos online e cadastrar os links no site.

## Hospedagem gratuita na internet (Render + Neon)

O projeto inclui `render.yaml` e suporte opcional a PostgreSQL. Uma configuração gratuita de demonstração pode usar o serviço Node.js do Render para o site e o PostgreSQL do Neon para manter os agendamentos. Consulte os limites dos planos gratuitos antes de usar comercialmente.

1. **Crie a base de dados:** abra https://neon.com/ e crie um projeto PostgreSQL gratuito. Copie a string de conexão do banco (`DATABASE_URL`, geralmente identificada como pooled connection string, com SSL habilitado). Guarde-a como segredo; não a envie publicamente.
2. **Suba o projeto ao GitHub:** crie um repositório e envie os arquivos desta pasta. Não envie credenciais nem dados locais de clientes; o `.gitignore` exclui os arquivos JSON da pasta `data`. O `.gitignore` exclui `.env`, dependências e arquivos temporários.
3. **Crie o serviço:** entre em https://render.com/, conecte o repositório e crie um Web Service Node.js, ou use o arquivo `render.yaml` como Blueprint. O Render reconhecerá o comando de compilação `npm install --omit=dev` e o início `npm start`.
4. **Configure as variáveis do serviço no Render:** `HOST=0.0.0.0`, `NODE_ENV=production`, `ADMIN_USER=admin`, `ADMIN_PASSWORD=uma-senha-forte-e-unica` e `DATABASE_URL=string-de-conexao-do-Neon`. Não use a senha inicial `GV@2026!` na internet.
5. **Faça o deploy** e espere o serviço ficar ativo. A URL pública aparece no painel do Render. Teste a página inicial, `/sobre-nos`, `/galeria`, `/cliente`, `/admin` e `/api/health`. O banco e as tabelas de agendamento são inicializados automaticamente na primeira inicialização.

### Limites importantes do modo gratuito

- O Render gratuito pode suspender o serviço após 15 minutos sem tráfego e levar cerca de um minuto para acordar. Isso pode deixar o primeiro acesso mais lento.
- O sistema foi preparado para usar PostgreSQL quando `DATABASE_URL` é definido. **Configure o Neon antes de aceitar agendamentos reais**: o sistema bloqueia a inicialização no Render se o banco ou a senha administrativa não tiverem sido configurados.
- A galeria faz pré-visualização local, não upload permanente. Não use dados ou mídias particulares de clientes no repositório público.
- A hospedagem gratuita é boa para teste e divulgação inicial, mas provedores podem alterar os limites. Verifique os termos atuais e faça cópias de segurança dos registros importantes.

## Notas técnicas

- Cada pedido enviado pelo cliente fica como `pending` (aguardando aprovação) até o administrador aceitar ou recusar. Pedidos pendentes e confirmados reservam o horário; pedidos recusados/cancelados liberam o horário. Todos os visitantes veem a mesma disponibilidade compartilhada.
- O cliente recebe um código de acompanhamento e pode consultar seu pedido na Área do Cliente usando o mesmo WhatsApp + código.
- No painel administrativo, é possível marcar horários manualmente como indisponíveis e remover esses bloqueios. Os bloqueios locais ficam em `data/slot-blocks.json`; com PostgreSQL ficam em `gv_slot_blocks`.
- Com PostgreSQL, um índice exclusivo impede que dois agendamentos confirmem o mesmo horário.
- O painel está disponível em `/admin`; sessões administrativas expiram após oito horas.
- Os links do Instagram, TikTok, Facebook e WhatsApp são exemplos e podem ser trocados pelos perfis e número reais do salão.
