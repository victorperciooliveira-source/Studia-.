# Studia — Documentação técnica

Documentação baseada no código real do repositório (`src/app.js` e `server.ts`). Onde algo existe no código mas não é usado por nenhuma tela, isso é indicado explicitamente como tal.

## 1. Visão geral da arquitetura

```
Navegador                    Express (server.ts)              Supabase
┌────────────────┐  fetch   ┌───────────────────────┐  SDK   ┌─────────────┐
│ src/app.js      │ ───────▶│ /api/*  (rotas REST)   │ ─────▶ │ Postgres    │
│ (renderiza tudo │◀─────── │ - client "supabase"    │        │ (tabelas)   │
│  via innerHTML) │  JSON   │   (service role key)   │        │ Auth        │
└────────────────┘         │ - client "supabaseAuth" │        └─────────────┘
                            │   (anon key, só login)  │
                            └───────────────────────┘
```

- **Frontend (`src/app.js`)**: uma única SPA vanilla JS sem framework, sem build de componentes e sem roteador de URL. Todo o app vive em memória em variáveis `let` no topo do arquivo (`user`, `schedules`, `teachers`, `allUsers`, `currentTab`, etc.). Cada "tela" é uma função que retorna uma string HTML (`LandingView`, `DeveloperView`, `DiretorView`, `TeacherView`, e abas como `HorariosTab`, `LabsTab`, `UsersTab` e `RelatoriosTab`). `DeveloperView`/`DiretorView`/`TeacherView` compõem sua sidebar e drawer mobile chamando os helpers compartilhados `Sidebar({...})`/`MobileDrawer({...})` em vez de duplicar essa marcação. A função `render(html)` substitui `#app.innerHTML` inteiro a cada mudança de estado.
- **Interação**: não há `addEventListener` delegado nem componentes — os próprios templates têm `onclick="actions.algumaCoisa(...)"` inline, e `window.actions` é exposto globalmente (`window.actions = actions`) para que esses atributos funcionem. Toda ação que muda estado termina chamando `this.init()`, que decide qual view renderizar com base em `user` e `currentTab` e re-renderiza a árvore inteira.
- **Backend (`server.ts`)**: Express expondo rotas `/api/*` que apenas repassam para o Supabase. Existem dois clients Supabase:
  - `supabase` — criado com a **service role key**, usado em quase todas as rotas (acesso administrativo total ao banco e à Auth).
  - `supabaseAuth` — criado com a **anon key**, usado só em `/api/auth/login` para `signInWithPassword`.
- Em desenvolvimento, o Vite roda como middleware do próprio Express (`middlewareMode: true`, `appType: 'spa'`) — um único processo/porta. Em produção (`NODE_ENV=production`), o Express serve os arquivos estáticos de `dist/` com fallback de SPA (`app.get('*', ...)`).
- **Persistência do lado do cliente**: `localStorage` guarda a sessão (`user`, incluindo os tokens retornados pelo login), a URL base da API (`api_base_url`) e a preferência de tamanho de card dos relatórios (`reportCardSize`).

## 2. Funcionalidades por perfil de usuário

Hierarquia (topo → base): `dev` (administrador global) → `diretor` (direção de uma escola) → `teacher` (professor). O perfil (`user.role`) decide qual view é renderizada em `actions.init()`: sem `user` → `LandingView`; `role === 'dev'` → `DeveloperView`; `role === 'diretor'` → `DiretorView`; qualquer outro (`teacher`) → `TeacherView`.

> Os perfis válidos no código atual são `dev`, `diretor` e `teacher`; não existe perfil `admin`.

### Desenvolvedor (`DeveloperView`) — console técnico
Sidebar escura com as abas **Visão geral**, **Saúde do sistema**, **Diagnóstico**, **Logs do sistema**, **Auditoria**, **Dados e backups**, **Escolas**, **Matérias** e **Usuários**. Logs do sistema consolidam atividade da API e erros JavaScript não tratados; a consulta é pesquisável e filtrável e fica restrita ao perfil `dev`. A edição de horários permanece disponível na aba **Horários** da direção, não no console do desenvolvedor.

### Diretor (`DiretorView`) — direção de escola
Sidebar clara, 5 abas:
- **Horários** (`HorariosTab`): tabela com todos os horários cadastrados (todas as turmas/professores), com botões de editar e excluir por linha, e botão "Novo Horário" no header.
- **Laboratórios** (`LabsTab`): agenda escolar com filtros por data, laboratório e professor; reservas sobrepostas são rejeitadas.
- **Matérias** (`MateriasEscolaTab`): gerencia o catálogo de matérias da escola em uma aba separada; permite adicionar e excluir cada matéria individualmente e também está disponível para o desenvolvedor.
- **Usuários** (`UsersTab({ viewerRole: 'diretor' })`): lista diretores e professores (contas `dev` ficam ocultas), permite edição e exclusão de contas e alteração de cargo entre `teacher`/`diretor`; o próprio usuário não pode alterar o próprio perfil.
- **Relatórios** (`RelatoriosTab`): geração de grade em PDF (por professor ou por turma) e gráfico de frequência.

### Professor (`TeacherView`)
Sidebar com 4 abas:
- **Dashboard**: visão somente leitura da agenda e das reservas do próprio professor, com resumo da semana atual e dados da escola.
- **Meus Horários**: grade semanal só com as aulas do próprio professor (`GET /api/schedules?teacherId=...`), sem edição — só visualização e exportação em PDF individual.
- **Laboratórios**: agenda compartilhada da escola; o professor pode excluir suas próprias reservas.
- **Minhas Matérias** (`MateriasTab`): consulta matérias vinculadas e as turmas/quantidade de aulas semanais encontradas nos horários; professores não podem alterar vínculos.

O cadastro público está desativado. A direção e o desenvolvedor criam contas pela gestão de usuários; no login, a pessoa seleciona a escola vinculada à conta.

## 3. Rotas da API (`server.ts`)

Rotas privadas validam o bearer token do Supabase Auth e o perfil no servidor por meio de `requireRole`/`validateUserPermission`. As rotas públicas são descritas como tal.

| Rota | O que faz |
|---|---|
| `GET /api/school-periods` | Lista os períodos da própria escola para direção e professores; o professor tem acesso somente de leitura. `dev` pode consultar informando `schoolId`. |
| `POST /api/school-periods` | Cria ou substitui um período da escola/turno após validar o intervalo e evitar sobreposição. |
| `PATCH /api/school-periods/:id` / `DELETE /api/school-periods/:id` | Atualiza ou remove um período pertencente à escola da direção. |
| `GET /api/schools/public` | Lista somente `id` e `name` das escolas ativas para o login, sem autenticação nem cache e com limite de requisições por IP. `/api/public/schools` permanece como alias compatível. |
| `POST /api/auth/register` | Cadastro público desativado; responde `403`. |
| `POST /api/auth/login` | Autentica com `supabaseAuth.auth.signInWithPassword`, exige uma escola ativa e confere o vínculo de professores/diretores; contas vinculadas a escolas inativas recebem `Credenciais inválidas`. Limita a 5 tentativas por e-mail e IP em 15 minutos e inclui `mustChangePassword` na resposta. |
| `PATCH /api/auth/password` | Verifica a senha atual e troca a senha do próprio usuário; conclui a troca obrigatória quando `must_change_password` está ativo. |
| `POST /api/users/:uid/password` | Define senha manual ou aplica a senha padrão do perfil, com acesso limitado a desenvolvedor ou direção da própria escola. |
| `POST /api/users/password/bulk-default` | Aplica a senha padrão a usuários do perfil/escola selecionados após confirmação digitada. |
| `GET /api/users/password-policy` | Retorna somente quais senhas padrão estão configuradas, sem expor seus valores. |
| `GET /api/dev/system-logs` | Restrita a `dev`; lista logs paginados e filtrados por texto, categoria, nível e período. |
| `POST /api/client-errors` | Endpoint público limitado por IP; registra somente o tipo de erro JavaScript enviado, nunca a mensagem ou o stack trace. |
| `GET /api/schedules` | Lista horários, ordenado por `date` desc e `startTime` asc. Filtra por `?teacherId=`. |
| `POST /api/schedules` | Cria horário com `status: 'pending'`. |
| `POST /api/schedules/recurring` | Gera de uma vez as ocorrências para os dias, períodos e datas selecionados, rejeitando o lote inteiro em caso de conflito. |
| `PATCH /api/schedules/:id` | Atualiza um horário. Se só `status` vier no corpo, atualiza somente o status; senão substitui todos os campos enviados. |
| `DELETE /api/schedules?turno=manha\|tarde\|noite` | Remove os horários do turno indicado na escola da direção autenticada; sem turno, remove todos os horários dessa escola. |
| `DELETE /api/schedules/:id` | Exclui um horário. |
| `GET /api/stats` | Conta horários por status (`total`, `confirmed`, `absent`, `pending`). |
| `GET /api/teachers` | Lista usuários com `role = 'teacher'`. |
| `GET /api/teachers/:uid/subjects` | Lista matérias vinculadas; professores só podem consultar as próprias. |
| `POST /api/teachers/:uid/subjects` / `DELETE /api/teachers/:uid/subjects/:subject` | Altera vínculos de matérias; permitido somente à direção e ao desenvolvedor. |
| `POST /api/school-subjects/:id/teachers` / `DELETE /api/school-subjects/:id/teachers/:teacherId` | Vincula/desvincula matéria de professor; permitido somente à direção e ao desenvolvedor. |
| `GET /api/users` | Lista todos os usuários, ordenado por nome. |
| `PATCH /api/users/:uid` | Atualiza parcialmente e-mail, nome, matéria, perfil e escola. Desenvolvedores têm acesso global; diretores só editam contas não-`dev` da própria escola e não podem alterar a escola. As alterações sincronizam Auth e perfil e registram valores anteriores/novos na auditoria. |
| `PATCH /api/users/:uid/role` / `PATCH /api/users/:uid/school` | Rotas compatíveis com as ações existentes; usam as mesmas regras de permissão e auditoria da edição de usuários. |
| `DELETE /api/users/:uid` | Remove o usuário do Supabase Auth e da tabela `users`; a própria conta não pode ser removida. |
| `GET /api/schools` | Para `dev`, lista todas as escolas incluindo o campo `active`. |
| `PATCH /api/schools/:id` | Para `dev`, atualiza nome e/ou estado `active` da escola. |
| `GET /api/labs/bookings` | Lista reservas de laboratório. |
| `POST /api/labs/bookings` | Cria uma reserva (sem checar conflito de horário/sala). |
| `DELETE /api/labs/bookings/:id` | Exclui uma reserva. |
| `DELETE /api/labs/bookings-clear-all` | Removido; reservas são canceladas individualmente. |

O fluxo e as rotas de atestados foram removidos. A tabela `certificates` permanece somente para conservar registros históricos e não é acessada pela aplicação.

## 4. Fluxo de autenticação e cargos

1. **Criação de contas**: o cadastro público está desativado. A direção e o desenvolvedor criam usuários pela gestão de usuários.
2. **Login**: a pessoa escolhe uma escola ativa e envia e-mail/senha a `POST /api/auth/login`. Professores e diretores só entram se o vínculo da conta corresponder à escola escolhida e a escola vinculada estiver ativa. Contas sem escola recebem orientação para solicitar o vínculo.
3. **Troca obrigatória**: contas criadas ou redefinidas por um administrador recebem `must_change_password = true`. O servidor bloqueia as rotas privadas com `403/PASSWORD_CHANGE_REQUIRED` até a senha atual ser verificada e trocada em `PATCH /api/auth/password`.
4. **Persistência de sessão**: ao carregar a página, `app.js` lê `localStorage.getItem('user')` para restaurar a sessão; tokens continuam seguindo o fluxo existente, mas senha e sinalizador de troca obrigatória não são persistidos.
5. **Logout**: `actions.logout()` só limpa `localStorage.user` e zera o estado local; não há chamada ao backend nem revogação de nada no Supabase Auth.
6. **Cargos**: contas `teacher`, `diretor` e `dev` são criadas/gerenciadas pela direção ou pelo desenvolvedor. Diretores não podem editar contas `dev`, mudar escola ou promover usuários a `dev`; ninguém pode alterar o próprio perfil.
7. **Migrações**: aplique `migrations/011_school_active_flag.sql` para ativar a escola Júlio Szymanski, desativar as demais e vincular professores/diretores sem escola ativa. Aplique também `migrations/012_user_profile_audit.sql` para adicionar ao log de auditoria o UID alvo e os valores alterados, `migrations/012_password_policy.sql` para a política de senha e `migrations/011_system_logs.sql` para criar os logs do sistema e importar os registros legados de `dev_error_logs`. Há dois arquivos com o prefixo `011` e dois com o prefixo `012`; aplique cada arquivo explicitamente, sem inferir a ordem apenas pelo número.

## 5. Registros históricos de certificados

A aplicação não oferece envio, consulta ou aprovação de atestados. A tabela `certificates` é mantida apenas para preservar registros antigos; não remover essa tabela ao aplicar a migração de horários.

## 6. Horários e Laboratórios

### Horários
- A direção configura períodos por escola e turno (`manha`, `tarde`, `noite`) em `/api/school-periods`; manhã e tarde permitem até seis períodos. Pode gerar aulas para dias da semana e intervalo de datas (`POST /api/schedules/recurring`), selecionando turno, dias e períodos. O servidor valida escola, turno, períodos e conflitos antes de inserir o lote.
- Também é possível criar uma aula em uma única data a partir dos períodos configurados. Edição e exclusão continuam disponíveis por registro.
- Status possíveis: `pending` (padrão ao criar), `confirmed` e `absent`. A migração 008 converte os registros antigos `vaga` para `confirmed` e remove esse status.
- O professor só visualiza os próprios horários, em formato de grade semanal (`TeacherScheduleCard`) calculada a partir do dia da semana de cada `date` e dos horários realmente cadastrados.
- Os relatórios e PDFs detectam os horários nos registros do turno selecionado; os períodos e horários são definidos por cada escola.

### Laboratórios
- Dois tipos fixos, fixos no código (não configuráveis pela UI): `info` (Informática) e `chem` (Química).
- Professores e direção podem reservar `info` (Informática) ou `chem` (Química) para sua escola (`LabModal` → `POST /api/labs/bookings`); o servidor valida data, intervalo e conflitos com reservas do mesmo laboratório.
- A agenda permite filtrar por data, laboratório e professor. Professores podem cancelar as próprias reservas; a direção pode cancelar reservas da escola.

## 7. Variáveis de ambiente (`.env`)

Lidas em `server.ts`; as quatro primeiras variáveis são obrigatórias e o processo lança erro na inicialização se alguma estiver ausente. As senhas padrão são opcionais:

| Variável | Uso |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave privilegiada usada pelo client `supabase` (quase todas as rotas, incluindo operações administrativas de Auth como criar/excluir usuário). Nunca deve ir para o frontend. |
| `SUPABASE_ANON_KEY` | Chave pública usada só pelo client `supabaseAuth`, exclusivamente para `signInWithPassword` no login. |
| `PORT` | Porta do Express (padrão 3000 se ausente). |
| `LOG_IP_SALT` | Salt secreto usado para gerar hashes SHA-256 dos IPs nos logs; obrigatório no servidor e nunca enviado ao navegador. |
| `DEFAULT_TEACHER_PASSWORD` | Senha padrão temporária para professores. Vazia desabilita a ação. Se configurada, exige 8 caracteres, letra e número. |
| `DEFAULT_DIRECTOR_PASSWORD` | Senha padrão temporária para diretores. Vazia desabilita a ação. Se configurada, exige 8 caracteres, letra e número. |
| `DEFAULT_DEV_PASSWORD` | Senha padrão temporária para desenvolvedores. Vazia desabilita a ação. Se configurada, exige 8 caracteres, letra e número. |

Adicionalmente, `vite.config.ts` injeta `process.env.GEMINI_API_KEY` como `define` global, mas essa variável **não é lida em nenhum lugar de `src/app.js`** — é resquício de um scaffold (o pacote `@google/genai` está no `package.json` mas não é importado por nada) e não precisa ser configurada para o app funcionar.

As senhas padrão devem ser configuradas apenas no ambiente do servidor (ou no painel do Render), nunca no repositório. Aplique também `migrations/012_password_policy.sql` para habilitar a troca obrigatória e a atribuição de quem definiu a senha; o repositório já contém outro arquivo `012_user_profile_audit.sql`, portanto aplique cada migration explicitamente.

## 8. Decisões técnicas relevantes e limitações conhecidas

- **UI vanilla em vez de React**: apesar de `react`/`@vitejs/plugin-react`/`recharts`/`motion` estarem no `package.json`, nada disso é usado — a interface inteira é `src/app.js` com template strings e `innerHTML`. Qualquer contribuição deve seguir esse padrão em vez de introduzir componentes React soltos.
- **Autorização da API**: rotas privadas exigem bearer token válido e verificam os perfis permitidos no servidor. As regras de edição de usuário são aplicadas pela rota PATCH completa e pelas rotas legadas de perfil/escola.
- **CORS totalmente aberto**: `Access-Control-Allow-Origin: *` em todas as rotas.
- **Dados históricos de certificados**: a tabela continua no banco para preservar registros antigos; o fluxo e os endpoints correspondentes foram removidos.
- **Sem verificação de conflito de horário**: nem em `/api/schedules`, nem em `/api/labs/bookings` há checagem de sobreposição (dois horários/reservas podem coexistir no mesmo horário/sala/lab).
- **"Limpar Tabela" de laboratórios é destrutivo e global**: apaga todas as reservas de todos os professores, e o botão fica visível tanto para `dev` quanto para professor (não há checagem de `user.role` nessa ação, diferente da exclusão individual de reserva).
- **Sessão sem verificação no carregamento**: `localStorage.user` persiste até logout/limpeza; a aplicação não valida automaticamente a expiração dos tokens ao restaurar a sessão.
- **`api_base_url` / detecção de ambiente**: em `localhost` a API aponta sempre para `http://localhost:3000`; no próprio host Render, usa a mesma origem; em outros hosts, aponta para `https://studia-8st9.onrender.com`.
- **Código morto**: `SlidesTab` (um carrossel de slides institucionais sobre o Studia) e as actions `nextSlide`/`prevSlide`/estado `currentSlide` existem no arquivo mas não são chamados por nenhuma view atual — não aparecem em lugar nenhum da aplicação.
- **Sem testes e sem lint de código**: não há suíte de testes no repositório; `npm run lint` roda apenas `tsc --noEmit` (checagem de tipos), sem ESLint/Prettier configurados.
- **Schema do banco**: as tabelas são referenciadas por nome direto no `server.ts`; o schema inicial e as migrações SQL ficam neste repositório e devem ser aplicados no Supabase. A migração `013_teacher_weekday_availability.sql` cria a disponibilidade semanal dos professores; sem registro, o dia é considerado disponível. O cálculo da hora-atividade permanece pausado até a direção validar a interpretação de “15/5” do PDF.

## 9. Vulnerabilidades conhecidas

### 9.1 Auto-cadastro público — cadastro desativado

**Estado atual**: o modal não oferece criação de conta e `POST /api/auth/register` responde `403`. Direção e desenvolvedor criam contas pela gestão de usuários. O histórico da vulnerabilidade e sua correção anterior ficam registrados abaixo.

O histórico do problema original fica registrado abaixo para referência.

**Resumo (histórico)**: qualquer visitante anônimo podia virar admin ("Diretor") pela própria tela pública de cadastro, sem convite nem aprovação de ninguém.

**Detalhes (histórico)**: `LandingView` renderizava, no modal de "Criar Conta", um `<select id="auth-role">` com as opções `teacher`/`admin` (`src/app.js:753-756`) visível para qualquer usuário não autenticado. `actions.register()` (`src/app.js:2344-2374`) enviava esse `role` como veio do formulário para `POST /api/auth/register`. No backend, `server.ts:38` aceitava esse campo sem checagem de autorização — `const profileRole = role === 'admin' ? 'admin' : 'teacher';` — e criava a conta com `role: 'admin'` de fato. Como nenhuma rota valida token/sessão do chamador (ver seção 8), o mesmo valia batendo direto em `POST /api/auth/register` com `{"role":"admin"}` via HTTP, sem sequer passar pela UI. O resultado era acesso administrativo total (gerenciar horários de todos, excluir usuários, aprovar atestados, limpar reservas de lab) via auto-cadastro.

**Correção aplicada**: o cadastro público está desativado e responde `403`. Contas e perfis são gerenciados por usuários autenticados com permissões adequadas.

### 9.2 Permissões em operações de usuários

As rotas privadas validam o bearer token e os perfis no servidor. A edição de usuários restringe diretores à própria escola, impede que editem contas `dev` ou alterem escola/perfil para `dev`, e impede alterações do próprio perfil.

### 9.3 Cargos atuais

Os perfis válidos no banco e no código são `dev`, `diretor` e `teacher`; não há um perfil `admin`. As migrations `003_add_dev_role.sql` e `006_remove_admin_role.sql` documentam a adoção desses valores.
