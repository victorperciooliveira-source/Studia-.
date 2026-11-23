import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import path from 'path';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error('Configure SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY no ambiente do servidor.');
}

// A chave service role fica somente no servidor; o navegador usa a API Express.
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  db: { schema: 'public' },
  global: { headers: { 'X-Client-Info': 'supabase-js-server' } }
});
const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  db: { schema: 'public' },
  global: { headers: { 'X-Client-Info': 'supabase-js-auth' } }
});

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;
const logIpSalt = process.env.LOG_IP_SALT;
if (!logIpSalt) {
  throw new Error('Configure LOG_IP_SALT no ambiente do servidor para habilitar o registro seguro de logs.');
}

type PasswordRole = 'teacher' | 'diretor' | 'dev';
const defaultPasswords: Record<PasswordRole, string | undefined> = {
  teacher: process.env.DEFAULT_TEACHER_PASSWORD?.trim() || undefined,
  diretor: process.env.DEFAULT_DIRECTOR_PASSWORD?.trim() || undefined,
  dev: process.env.DEFAULT_DEV_PASSWORD?.trim() || undefined
};
const defaultPasswordEnvNames: Record<PasswordRole, string> = {
  teacher: 'DEFAULT_TEACHER_PASSWORD',
  diretor: 'DEFAULT_DIRECTOR_PASSWORD',
  dev: 'DEFAULT_DEV_PASSWORD'
};
const isStrongPassword = (password: unknown): password is string =>
  typeof password === 'string' &&
  password.length >= 8 &&
  /\p{L}/u.test(password) &&
  /\d/.test(password);

for (const role of ['teacher', 'diretor', 'dev'] as const) {
  const password = defaultPasswords[role];
  if (!password) {
    console.warn(`[PASSWORD_POLICY] ${defaultPasswordEnvNames[role]} is empty; applying this default is disabled.`);
  } else if (!isStrongPassword(password)) {
    throw new Error(`${defaultPasswordEnvNames[role]} must have at least 8 characters, including a letter and a number.`);
  }
}

type SystemLogLevel = 'info' | 'warn' | 'error';
type SystemLogCategory = 'auth' | 'api' | 'action' | 'error' | 'frontend' | 'system';
type SystemLogActor = { uid: string; role: string; school_id?: string | null } | null;

const logEvent = async ({
  level,
  category,
  method,
  route,
  statusCode,
  durationMs,
  actor,
  schoolId,
  req,
  message,
  metadata
}: {
  level: SystemLogLevel;
  category: SystemLogCategory;
  method?: string | null;
  route?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  actor?: SystemLogActor;
  schoolId?: string | null;
  req?: any;
  message?: string | null;
  metadata?: { eventType?: 'error' | 'unhandledrejection' } | null;
}): Promise<void> => {
  try {
    const ip = req?.ip || req?.socket?.remoteAddress;
    const ipHash = ip
      ? createHash('sha256').update(`${logIpSalt}:${ip}`).digest('hex')
      : null;
    const safeMetadata = metadata?.eventType ? { eventType: metadata.eventType } : null;
    const { error } = await supabase.from('system_logs').insert({
      level,
      category,
      method: method?.slice(0, 16) || null,
      route: route?.slice(0, 255) || null,
      status_code: statusCode ?? null,
      duration_ms: durationMs ?? null,
      actor_uid: actor?.uid || null,
      actor_role: actor?.role || null,
      school_id: schoolId || actor?.school_id || null,
      ip_hash: ipHash,
      user_agent: String(req?.get?.('user-agent') || '').slice(0, 255) || null,
      message: message?.slice(0, 1000) || null,
      metadata: safeMetadata
    });
    if (error) console.error('[SYSTEM_LOG] Could not store event:', error);
  } catch (error) {
    console.error('[SYSTEM_LOG] Could not store event:', error);
  }
};

// Mapeamento de colunas do banco para camelCase
const columnMap: {[key: string]: string} = {
  starttime: 'startTime',
  endtime: 'endTime',
  period_number: 'periodNumber',
  start_time: 'startTime',
  end_time: 'endTime',
  teacher_uid: 'teacherUid',
  updated_at: 'updatedAt',
  teacherid: 'teacherId',
  teachername: 'teacherName',
  classgroup: 'classGroup',
  labid: 'labId',
  displayname: 'displayName',
  school_id: 'school_id',
  must_change_password: 'mustChangePassword',
  password_set_by: 'passwordSetBy',
  createdat: 'createdAt',
  updatedat: 'updatedAt'
};

const transformKeys = (obj: any): any => {
  if (Array.isArray(obj)) return obj.map(transformKeys);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).reduce((acc: any, key) => {
      const newKey = columnMap[key] || key;
      acc[newKey] = obj[key];
      return acc;
    }, {});
  }
  return obj;
};

// Security: Sanitização de entrada
const sanitizeString = (str: string): string => {
  if (!str) return '';
  return str.trim().replace(/[<>\"']/g, '').substring(0, 255);
};

const isValidDateOnly = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const isValidTime = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);

const timeToMinutes = (value: string): number => {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
};

const doesTimeOverlap = (startA: string, endA: string, startB: string, endB: string): boolean =>
  timeToMinutes(startA) < timeToMinutes(endB) && timeToMinutes(endA) > timeToMinutes(startB);

type ScheduleConflictCandidate = {
  date: string;
  startTime: string;
  endTime: string;
  teacherId?: string;
  classGroup?: string;
  room?: string;
};

const findScheduleConflict = async (
  schoolId: string,
  candidate: ScheduleConflictCandidate,
  excludeId?: number
) => {
  let query = supabase
    .from('schedules')
    .select('id,date,starttime,endtime,teacherid,classgroup,room')
    .eq('school_id', schoolId)
    .eq('date', candidate.date);
  if (excludeId !== undefined) query = query.neq('id', excludeId);
  const { data, error } = await query;
  if (error) return { error: 'Erro ao validar conflitos nos horários.' };

  const conflict = (data || []).find(schedule => {
    if (!isValidTime(schedule.starttime) || !isValidTime(schedule.endtime)) return false;
    if (!doesTimeOverlap(candidate.startTime, candidate.endTime, schedule.starttime, schedule.endtime)) return false;
    const sameTeacher = Boolean(candidate.teacherId) && schedule.teacherid === candidate.teacherId;
    const sameClass = Boolean(candidate.classGroup) &&
      String(schedule.classgroup || '').trim().toLocaleLowerCase() === String(candidate.classGroup).trim().toLocaleLowerCase();
    const sameRoom = Boolean(candidate.room) &&
      String(schedule.room || '').trim().toLocaleLowerCase() === String(candidate.room).trim().toLocaleLowerCase();
    return sameTeacher || sameClass || sameRoom;
  });
  return conflict ? { conflict } : {};
};

const getTurnoByStartTime = (time: string): 'manha' | 'tarde' | 'noite' => {
  const minutes = timeToMinutes(time);
  if (minutes >= 5 * 60 && minutes < 12 * 60) return 'manha';
  if (minutes >= 12 * 60 && minutes < 18 * 60) return 'tarde';
  return 'noite';
};

const sanitizeEmail = (email: string): string => {
  if (!email) return '';
  return email.trim().toLowerCase();
};

const isValidEmail = (email: string): boolean => {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const normalizeSubjects = (subject: unknown): string[] => {
  const entries = Array.isArray(subject) ? subject : [subject];
  const subjects = entries
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap(entry => entry.split(/[,;\n]/))
    .map(entry => sanitizeString(entry))
    .filter(Boolean);
  return [...new Map(subjects.map(entry => [entry.toLocaleLowerCase(), entry])).values()];
};

const ensureDefaultSchoolExists = async (requestedSchoolId?: string | null): Promise<string> => {
  const schoolQuery = supabase.from('schools').select('id');
  const { data: school, error } = requestedSchoolId
    ? await schoolQuery.eq('id', requestedSchoolId).maybeSingle()
    : await schoolQuery.eq('name', 'Colégio Estadual Prof. Júlio Szymanski').maybeSingle();

  if (error) throw error;
  if (school) return school.id;
  throw new Error(requestedSchoolId
    ? 'Escola inválida. Crie ou selecione uma escola antes de continuar.'
    : 'A escola padrão não está cadastrada. Execute as migrations antes de continuar.');
};

const getOrCreateSchoolSubject = async (schoolId: string, subject: string) => {
  const { data: existingSubjects, error: findError } = await supabase
    .from('school_subjects')
    .select('id,subject')
    .eq('school_id', schoolId);
  if (findError) return { data: null, error: findError };

  const existing = (existingSubjects || []).find(item => item.subject.toLocaleLowerCase() === subject.toLocaleLowerCase());
  if (existing) return { data: existing, error: null };

  const { data, error } = await supabase
    .from('school_subjects')
    .insert({ school_id: schoolId, subject })
    .select('id,subject')
    .single();
  return { data, error };
};

const saveTeacherSubjects = async (teacherId: string, schoolId: string | null, subjects: string[]) => {
  if (subjects.length === 0) return null;
  if (!schoolId) return new Error('O professor precisa estar associado a uma escola para cadastrar matérias.');

  const { data: school, error: schoolError } = await supabase
    .from('schools')
    .select('id')
    .eq('id', schoolId)
    .maybeSingle();

  if (schoolError || !school) {
    return new Error('Escola inválida. Crie ou selecione uma escola antes de cadastrar matérias.');
  }

  for (const subject of subjects) {
    const { data: catalogSubject, error: subjectError } = await getOrCreateSchoolSubject(schoolId, subject);
    if (subjectError || !catalogSubject) return subjectError || new Error('Não foi possível cadastrar a matéria.');

    const { error } = await supabase
      .from('teacher_subjects')
      .upsert(
        { teacher_id: teacherId, subject_id: catalogSubject.id },
        { onConflict: 'teacher_id,subject_id', ignoreDuplicates: true }
      );
    if (error) return error;
  }
  return null;
};

// Security: Rate-limiting em-memória
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
let lastRateLimitCleanup = 0;

const checkRateLimit = (key: string, maxRequests: number = 5, windowMs: number = 60000): boolean => {
  const now = Date.now();
  if (now - lastRateLimitCleanup > 60000) {
    for (const [storedKey, entry] of rateLimitMap) {
      if (now > entry.resetTime) rateLimitMap.delete(storedKey);
    }
    lastRateLimitCleanup = now;
  }
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (entry.count >= maxRequests) {
    return false;
  }

  entry.count++;
  return true;
};

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '10mb' }));

app.use('/api', (req, res, next) => {
  const startedAt = Date.now();
  res.once('finish', () => {
    const route = `${req.baseUrl}${req.route?.path || req.path}`.slice(0, 255);
    const method = req.method;
    const statusCode = res.statusCode;
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const isAuthRoute = route.startsWith('/api/auth/');
    const category = res.locals.systemLogCategory
      || (isAuthRoute ? 'auth' : isWrite && statusCode < 400 ? 'action' : statusCode >= 500 ? 'error' : 'api');
    const level = res.locals.systemLogLevel
      || (statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info');

    void (async () => {
      let actor: SystemLogActor = res.locals.systemLogActor || null;
      if (!actor) {
        const authorization = req.headers.authorization as string | undefined;
        const accessToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
        if (accessToken) {
          const { data: authData, error: authError } = await supabaseAuth.auth.getUser(accessToken);
          if (!authError && authData.user) actor = await getUserFromDB(authData.user.id);
        }
      }

      await logEvent({
        level,
        category,
        method,
        route,
        statusCode,
        durationMs: Date.now() - startedAt,
        actor,
        req,
        message: res.locals.systemLogMessage || (statusCode >= 500 ? 'Falha na requisição da API' : 'Requisição concluída'),
        metadata: res.locals.systemLogMetadata || null
      });
    })().catch(error => console.error('[SYSTEM_LOG] Could not resolve event actor:', error));
  });
  next();
});

const passwordChangeExemptions = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/password',
  '/api/auth/logout',
  '/api/client-errors',
  '/api/schools/public',
  '/api/public/schools'
]);
app.use('/api', async (req, res, next) => {
  const route = `${req.baseUrl}${req.path}`;
  if (passwordChangeExemptions.has(route)) return next();

  const authorization = req.headers.authorization;
  const accessToken = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';
  if (!accessToken) return next();

  try {
    const { data: authData, error: authError } = await supabaseAuth.auth.getUser(accessToken);
    if (authError || !authData.user) return next();

    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('uid,role,school_id,displayname,must_change_password')
      .eq('uid', authData.user.id)
      .maybeSingle();
    if (profileError) return res.status(500).json({ error: 'Não foi possível verificar a política de senha.' });
    if (!profile) return next();

    res.locals.authenticatedUser = profile;
    if (profile.must_change_password) {
      return res.status(403).json({
        error: 'Troque sua senha para continuar usando o sistema.',
        code: 'PASSWORD_CHANGE_REQUIRED'
      });
    }
    next();
  } catch {
    return res.status(500).json({ error: 'Não foi possível verificar a política de senha.' });
  }
});

app.post('/api/auth/register', (_req, res) => {
  res.status(403).json({ error: 'Cadastro público desativado. Peça à direção pedagógica para criar seu acesso.' });
});

app.post('/api/client-errors', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkRateLimit(`client-errors:${ip}`, 10, 60000)) {
    return res.status(429).json({ error: 'Muitos eventos enviados. Tente novamente mais tarde.' });
  }
  const eventType = req.body?.eventType;
  if (eventType !== 'error' && eventType !== 'unhandledrejection') {
    return res.status(400).json({ error: 'Tipo de evento inválido.' });
  }

  res.locals.systemLogCategory = 'frontend';
  res.locals.systemLogLevel = 'error';
  res.locals.systemLogMessage = eventType === 'error'
    ? 'Erro JavaScript não tratado'
    : 'Rejeição de promise não tratada';
  res.locals.systemLogMetadata = { eventType };
  res.status(202).json({ status: 'accepted' });
});

app.get(['/api/schools/public', '/api/public/schools'], async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  const ip = req.ip || 'unknown';
  if (!checkRateLimit(`public-schools:${ip}`, 30, 60000)) {
    return res.status(429).json({ error: 'Muitas consultas. Tente novamente mais tarde.' });
  }

  const { data, error } = await supabase
    .from('schools')
    .select('id,name')
    .eq('active', true)
    .order('name', { ascending: true });
  if (error) {
    console.error('[PUBLIC SCHOOLS] Query failed:', error);
    return res.status(500).json({ error: 'Não foi possível carregar as escolas.' });
  }
  res.json(data || []);
});

app.post('/api/auth/login', async (req, res) => {
  let { email, password } = req.body;
  email = sanitizeEmail(email);
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const rateLimitKey = createHash('sha256').update(`${email}\0${ip}`).digest('hex');
  if (!checkRateLimit(`login:${rateLimitKey}`, 5, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Credenciais inválidas' });
  }

  const schoolId = typeof req.body.schoolId === 'string' ? req.body.schoolId : '';
  if (!schoolId) return res.status(400).json({ error: 'Selecione sua escola para continuar.' });

  const { data: selectedSchool, error: schoolError } = await supabase
    .from('schools')
    .select('id,active')
    .eq('id', schoolId)
    .maybeSingle();
  if (schoolError) {
    console.error('[LOGIN] School validation failed:', schoolError);
    return res.status(500).json({ error: 'Não foi possível validar a escola selecionada.' });
  }
  if (!selectedSchool || !selectedSchool.active) return res.status(401).json({ error: 'Credenciais inválidas' });

  const { data: authData, error: authError } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (authError || !authData.user) return res.status(401).json({ error: 'Credenciais inválidas' });

  let userData: any = null;
  // Buscar usuário com SQL direto (evita cache do REST API)
  try {
    const { data, error: userError } = await supabase
      .from('users')
      .select('uid,email,displayname,role,subject,school_id,must_change_password,password_set_by')
      .eq('uid', authData.user.id)
      .maybeSingle();

    if (userError) {
      console.log('[LOGIN] Query error (retrying with RPC):', userError);
      // Fallback: usar RPC ou SQL direto
      throw new Error(userError.message);
    }
    userData = data;
  } catch (err) {
    console.error('[LOGIN] Fallback to fetch:', err instanceof Error ? err.message : err);
    // Fallback: usar fetch direto sem select=*
    const response = await fetch(`${supabaseUrl}/rest/v1/users?uid=eq.${authData.user.id}`, {
      headers: {
        'apikey': supabaseServiceRoleKey,
        'Authorization': `Bearer ${supabaseServiceRoleKey}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });

    if (!response.ok) {
      console.error('[LOGIN] Fallback fetch failed:', response.status);
      return res.status(500).json({ error: 'Erro ao realizar login' });
    }

    const data = await response.json();
    if (!data || data.length === 0) return res.status(401).json({ error: 'Credenciais inválidas' });
    userData = data[0];
  }

  if (!userData) return res.status(401).json({ error: 'Credenciais inválidas' });
  if (userData.role === 'teacher' || userData.role === 'diretor') {
    if (!userData.school_id) {
      return res.status(403).json({ error: 'Sua conta ainda não está vinculada a uma escola. Procure a direção pedagógica ou o desenvolvedor para solicitar o vínculo.' });
    }
    if (userData.school_id !== schoolId) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const { data: userSchool, error: userSchoolError } = await supabase
      .from('schools')
      .select('active')
      .eq('id', userData.school_id)
      .maybeSingle();
    if (userSchoolError) {
      console.error('[LOGIN] User school validation failed:', userSchoolError);
      return res.status(500).json({ error: 'Não foi possível validar a escola.' });
    }
    if (!userSchool?.active) return res.status(401).json({ error: 'Credenciais inválidas' });
  } else if (userData.role !== 'dev') {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  res.locals.systemLogActor = {
    uid: userData.uid,
    role: userData.role,
    school_id: userData.school_id || null
  };
  res.json({
    ...transformKeys(userData),
    accessToken: authData.session.access_token,
    refreshToken: authData.session.refresh_token
  });
});

app.post('/api/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    return res.status(400).json({ error: 'Token de atualização obrigatório' });
  }

  const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }

  res.json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token
  });
});

app.post('/api/users/create', async (req, res) => {
  let { email, password, displayName, subject, role, schoolId } = req.body;
  const creator = await validateUserPermission(req, res);
  if (!creator) return res.status(401).json({ error: 'Não autorizado' });
  const { role: userRole, school_id: userSchoolId } = creator;

  // Sanitizar entrada
  email = sanitizeEmail(email);
  displayName = sanitizeString(displayName);
  const subjects = normalizeSubjects(subject);
  subject = subjects.join(', ');
  role = sanitizeString(role);

  // Rate-limit: máx 10 criações por minuto por IP
  const ip = req.ip || 'unknown';
  if (!checkRateLimit(`createUser:${ip}`, 10, 60000)) {
    return res.status(429).json({ error: 'Muitas criações de usuário. Tente novamente mais tarde.' });
  }

  if (!email || !password || !displayName || !role) {
    return res.status(400).json({ error: 'Email, senha, nome e cargo são obrigatórios' });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({ error: 'A senha deve ter no mínimo 8 caracteres, com pelo menos uma letra e um número.' });
  }

  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Cargo inválido' });
  }

  // VALIDAÇÕES DE PERMISSÃO
  // Desenvolvedor pode criar qualquer perfil.
  if (userRole === 'dev') {
    // OK - criar qualquer role
  }
  // Diretor pode criar diretor/professor da mesma escola
  else if (userRole === 'diretor') {
    if (role === 'dev') {
      return res.status(403).json({ error: 'Diretores não podem criar desenvolvedores' });
    }
    if (schoolId && schoolId !== userSchoolId) {
      return res.status(403).json({ error: 'Diretor só pode criar usuários da mesma escola' });
    }
  }
  // Professor não pode criar ninguém
  else {
    return res.status(403).json({ error: 'Você não tem permissão para criar usuários' });
  }

  try {
    const finalSchoolId = userRole === 'diretor' ? userSchoolId : (schoolId || userSchoolId);
    if (!finalSchoolId) {
      return res.status(400).json({ error: 'Selecione uma escola válida para este usuário.' });
    }

    const { data: validSchool, error: schoolValidationError } = await supabase
      .from('schools')
      .select('id')
      .eq('id', finalSchoolId)
      .maybeSingle();
    if (schoolValidationError || !validSchool) {
      return res.status(400).json({ error: 'A escola selecionada não foi encontrada. Escolha uma escola cadastrada.' });
    }

    // Criar usuário no Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { displayName, role, subject }
    });

    if (authError) {
      return res.status(400).json({
        error: authError.message === 'A user with this email address has already been registered'
          ? 'Email já cadastrado'
          : 'Erro ao criar usuário.'
      });
    }

    const uid = authData.user.id;

    const { data: userData, error: insertError } = await supabase
      .from('users')
      .insert({
        uid,
        email,
        displayname: displayName,
        role,
        subject: subject || null,
        school_id: finalSchoolId,
        must_change_password: true,
        password_set_by: creator.uid
      })
      .select('uid,email,displayname,role,subject,school_id,must_change_password,password_set_by')
      .single();

    if (insertError) {
      console.error('[CREATE_USER] Profile insert failed:', insertError);
      await supabase.auth.admin.deleteUser(uid);
      return res.status(500).json({ error: 'Não foi possível criar o perfil associado à escola. Nenhuma conta foi criada.' });
    }

    if (role === 'teacher') {
      const subjectError = role === 'teacher'
        ? await saveTeacherSubjects(uid, finalSchoolId, subjects)
        : null;
      if (subjectError) {
        console.error('[CREATE_USER] Could not save teacher subjects:', subjectError);
        const friendlyMessage = subjectError.message?.includes('Escola inválida') || subjectError.message?.includes('school_id')
          ? 'Escola inválida. Crie ou selecione uma escola antes de continuar.'
          : `Usuário criado, mas não foi possível salvar as matérias: ${subjectError.message}`;
        return res.status(400).json({ error: friendlyMessage });
      }
    }

    res.json(transformKeys(userData));
  } catch {
    res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

app.get('/api/schedules', async (req, res) => {
  const userInfo = await validateUserPermission(req, res);
  if (!userInfo) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  let query = supabase.from('schedules').select('*');

  if (userInfo.role === 'teacher') {
    if (req.query.teacherId && req.query.teacherId !== userInfo.uid) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    query = query.eq('teacherid', userInfo.uid);
  } else if (userInfo.role === 'diretor') {
    if (req.query.schoolId && req.query.schoolId !== userInfo.school_id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    query = query.eq('school_id', userInfo.school_id);
  } else if (req.query.teacherId) {
    query = query.eq('teacherid', req.query.teacherId);
  } else if (req.query.schoolId) {
    query = query.eq('school_id', req.query.schoolId);
  }

  query = query.order('date', { ascending: true }).order('starttime', { ascending: true });
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Erro ao buscar horários' });
  res.json(transformKeys(data));
});

app.post('/api/schedules', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;
  const { date, startTime, endTime, subject, room, teacherId, teacherName, classGroup, school_id } = req.body;
  const turno = req.body?.turno || (isValidTime(startTime) ? getTurnoByStartTime(startTime) : '');
  if (!['manha', 'tarde', 'noite'].includes(turno)) {
    return res.status(400).json({ error: 'Informe um turno válido para o horário.' });
  }
  if (!isValidDateOnly(date) || !isValidTime(startTime) || !isValidTime(endTime) || timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    return res.status(400).json({ error: 'Informe uma data e um intervalo de horários válido.' });
  }
  if (userInfo.role === 'diretor' && school_id && school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  if (userInfo.role === 'diretor') {
    const teacher = teacherId ? await getUserFromDB(teacherId) : null;
    if (!teacher || teacher.role !== 'teacher' || teacher.school_id !== userInfo.school_id) {
      return res.status(403).json({ error: 'O horário deve pertencer a um professor da sua escola' });
    }
  }

  let finalSchoolId: string | undefined;
  try {
    finalSchoolId = userInfo.role === 'diretor'
      ? userInfo.school_id
      : await ensureDefaultSchoolExists(school_id || undefined);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Escola inválida' });
  }

  if (!finalSchoolId) return res.status(400).json({ error: 'Selecione uma escola válida.' });
  const conflictResult = await findScheduleConflict(finalSchoolId, {
    date,
    startTime,
    endTime,
    teacherId,
    classGroup,
    room
  });
  if ('error' in conflictResult) return res.status(500).json({ error: conflictResult.error });
  if ('conflict' in conflictResult) {
    return res.status(409).json({
      error: `Conflito de horário em ${date}, das ${startTime.slice(0, 5)} às ${endTime.slice(0, 5)}. Nenhuma aula foi criada.`
    });
  }

  const { data, error } = await supabase.from('schedules').insert({
    date,
    starttime: startTime,
    endtime: endTime,
    subject,
    room,
    teacherid: teacherId,
    teachername: teacherName,
    classgroup: classGroup,
    turno,
    status: 'pending',
    school_id: finalSchoolId
  }).select('id').single();
  if (error) return res.status(500).json({ error: 'Erro ao criar horário' });
  res.json({ id: data.id, status: 'success' });
});

app.patch('/api/schedules/:id', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;
  if (req.body.status !== undefined && !['pending', 'confirmed', 'absent'].includes(req.body.status)) {
    return res.status(400).json({ error: 'Status de horário inválido.' });
  }
  const { data: existingSchedule, error: existingError } = await supabase
    .from('schedules')
    .select('id,school_id,date,starttime,endtime,subject,room,teacherid,teachername,classgroup,turno,status')
    .eq('id', req.params.id)
    .maybeSingle();
  if (existingError) return res.status(500).json({ error: 'Erro ao verificar horário' });
  if (!existingSchedule) return res.status(404).json({ error: 'Horário não encontrado para edição.' });
  if (userInfo.role === 'diretor') {
    if (existingSchedule.school_id !== userInfo.school_id) return res.status(403).json({ error: 'Acesso negado' });
    if (req.body.teacherId) {
      const teacher = await getUserFromDB(req.body.teacherId);
      if (!teacher || teacher.role !== 'teacher' || teacher.school_id !== userInfo.school_id) {
        return res.status(403).json({ error: 'O horário deve pertencer a um professor da sua escola' });
      }
    }
  }
  const { status, date, startTime, endTime, subject, room, teacherId, teacherName, classGroup } = req.body;
  const turno = req.body?.turno || (isValidTime(startTime) ? getTurnoByStartTime(startTime) : undefined);
  if (turno !== undefined && !['manha', 'tarde', 'noite'].includes(turno)) {
    return res.status(400).json({ error: 'Informe um turno válido para o horário.' });
  }
  const onlyStatus = status !== undefined && date === undefined && startTime === undefined && endTime === undefined && subject === undefined && room === undefined && teacherId === undefined && teacherName === undefined && classGroup === undefined && turno === undefined;
  if (!onlyStatus) {
    const finalDate = date ?? existingSchedule.date;
    const finalStartTime = startTime ?? existingSchedule.starttime;
    const finalEndTime = endTime ?? existingSchedule.endtime;
    const finalTeacherId = teacherId ?? existingSchedule.teacherid;
    const finalClassGroup = classGroup ?? existingSchedule.classgroup;
    const finalRoom = room ?? existingSchedule.room;
    if (!isValidDateOnly(finalDate) || !isValidTime(finalStartTime) || !isValidTime(finalEndTime) ||
        timeToMinutes(finalStartTime) >= timeToMinutes(finalEndTime)) {
      return res.status(400).json({ error: 'Informe uma data e um intervalo de horários válido.' });
    }
    const conflictResult = await findScheduleConflict(existingSchedule.school_id, {
      date: finalDate,
      startTime: finalStartTime,
      endTime: finalEndTime,
      teacherId: finalTeacherId,
      classGroup: finalClassGroup,
      room: finalRoom
    }, existingSchedule.id);
    if ('error' in conflictResult) return res.status(500).json({ error: conflictResult.error });
    if ('conflict' in conflictResult) {
      return res.status(409).json({
        error: `Conflito de horário em ${finalDate}, das ${finalStartTime.slice(0, 5)} às ${finalEndTime.slice(0, 5)}. Nenhuma alteração foi salva.`
      });
    }
  }
  const updates = onlyStatus
    ? { status }
    : {
        status,
        date,
        starttime: startTime,
        endtime: endTime,
        subject,
        room,
        teacherid: teacherId,
        teachername: teacherName,
        classgroup: classGroup,
        turno
      };
  const { data: updatedSchedule, error } = await supabase
    .from('schedules')
    .update(updates)
    .eq('id', req.params.id)
    .select('id')
    .maybeSingle();
  if (error) return res.status(500).json({ error: `Erro ao atualizar horário: ${error.message}` });
  if (!updatedSchedule) return res.status(404).json({ error: 'Horário não encontrado para edição.' });
  res.json({ status: 'success' });
});

app.delete('/api/schedules', async (req, res) => {
  const userInfo = await requireRole(req, res, ['diretor']);
  if (!userInfo) return;
  if (!userInfo.school_id) return res.status(400).json({ error: 'Associe sua conta a uma escola antes de remover horários.' });

  const turno = req.query.turno;
  if (turno !== undefined && !['manha', 'tarde', 'noite'].includes(String(turno))) {
    return res.status(400).json({ error: 'Turno inválido.' });
  }

  const classGroup = typeof req.query.classGroup === 'string'
    ? req.query.classGroup.trim()
    : '';

  let query = supabase
    .from('schedules')
    .delete({ count: 'exact' })
    .eq('school_id', userInfo.school_id);
  if (turno) query = query.eq('turno', String(turno));
  if (classGroup) query = query.eq('classgroup', classGroup);

  const { error, count } = await query;
  if (error) return res.status(500).json({ error: 'Não foi possível remover os horários da escola.' });
  res.json({ status: 'success', deleted: count || 0 });
});

app.delete('/api/schedules/:id', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;
  if (userInfo.role === 'diretor') {
    const { data: schedule, error: findError } = await supabase.from('schedules').select('school_id').eq('id', req.params.id).maybeSingle();
    if (findError) return res.status(500).json({ error: 'Erro ao verificar horário' });
    if (!schedule || schedule.school_id !== userInfo.school_id) return res.status(403).json({ error: 'Acesso negado' });
  }
  const { error } = await supabase.from('schedules').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao excluir horário' });
  res.json({ status: 'success' });
});

app.get('/api/stats', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev']);
  if (!userInfo) return;
  const { data, error } = await supabase.from('schedules').select('status');
  if (error) return res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  res.json({ total: data.length, confirmed: data.filter(item => item.status === 'confirmed').length, absent: data.filter(item => item.status === 'absent').length, pending: data.filter(item => item.status === 'pending').length });
});

app.get('/api/teachers', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;

  let query = supabase.from('users').select('*').eq('role', 'teacher');

  // Diretor só vê professores da sua escola
  if (userInfo.role === 'diretor') {
    query = query.eq('school_id', userInfo.school_id);
  }

  query = query.order('displayname', { ascending: true });
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Erro ao buscar professores' });
  res.json(transformKeys(data));
});

app.get('/api/users', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;

  let query = supabase.from('users').select('*').order('displayname', { ascending: true });

  if (userInfo.role === 'diretor') {
    if (req.query.schoolId && req.query.schoolId !== userInfo.school_id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    query = query.eq('school_id', userInfo.school_id);
    query = query.neq('role', 'dev');
  } else if (req.query.schoolId) {
    query = query.eq('school_id', req.query.schoolId);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Erro ao buscar usuários' });
  res.json(transformKeys(data));
});

app.patch('/api/users/:uid/school', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev']);
  if (!userInfo) return;
  if (typeof req.body.schoolId !== 'string' || !req.body.schoolId.trim()) {
    return res.status(400).json({ error: 'Selecione uma escola.' });
  }

  await updateUserProfile(userInfo, req.params.uid, { schoolId: req.body.schoolId }, res, {
    allowedFields: ['schoolId'],
    targetRoles: ['teacher']
  });
});

app.delete('/api/users/:uid', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;
  if (req.params.uid === userInfo.uid) {
    return res.status(403).json({ error: userInfo.role === 'dev'
      ? 'Não é permitido remover a própria conta de desenvolvedor.'
      : 'Não é possível excluir sua própria conta.' });
  }

  const uid = req.params.uid;
  const { data: target, error: targetError } = await supabase
    .from('users')
    .select('uid,school_id,role')
    .eq('uid', uid)
    .maybeSingle();
  if (targetError) return res.status(500).json({ error: 'Erro ao verificar usuário' });
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (userInfo.role === 'diretor' && (target.school_id !== userInfo.school_id || target.role === 'dev')) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const { data: authData, error: authLookupError } = await supabase.auth.admin.getUserById(uid);
  const authUserNotFound = authLookupError?.status === 404 || authLookupError?.code === 'user_not_found';
  if (authLookupError && !authUserNotFound) {
    return res.status(500).json({ error: 'Erro ao remover usuário do sistema de autenticação' });
  }
  if (authData.user) {
    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(uid);
    if (authDeleteError) {
      return res.status(500).json({ error: 'Erro ao remover usuário do sistema de autenticação' });
    }
  } else if (!authUserNotFound) {
    return res.status(500).json({ error: 'Não foi possível confirmar a conta no sistema de autenticação' });
  }

  const { error: dbError } = await supabase.from('users').delete().eq('uid', uid);
  if (dbError) {
    return res.status(500).json({ error: 'Erro ao remover usuário do banco de dados' });
  }

  res.json({ status: 'success' });
});

// Server-side permission validation
type AppRole = PasswordRole;

interface UserInfo {
  uid: string;
  role: AppRole;
  school_id?: string;
  displayname?: string;
  must_change_password?: boolean;
}

const VALID_ROLES: AppRole[] = ['teacher', 'diretor', 'dev'];

const getUserFromDB = async (uid: string): Promise<UserInfo | null> => {
  const { data, error } = await supabase
    .from('users')
    .select('uid,role,school_id,displayname,must_change_password')
    .eq('uid', uid)
    .maybeSingle();

  if (error) {
    console.error('[PERMISSION] Error fetching user:', error);
    return null;
  }

  return data as UserInfo | null;
};

const validateUserPermission = async (req: any, res: any, requiredRole?: string[]): Promise<UserInfo | null> => {
  const cachedUser = res.locals.authenticatedUser as UserInfo | undefined;
  if (cachedUser) {
    return requiredRole && !requiredRole.includes(cachedUser.role) ? null : cachedUser;
  }

  const authorization = req.headers.authorization as string | undefined;
  const accessToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';

  if (!accessToken) return null;

  const { data: authData, error: authError } = await supabaseAuth.auth.getUser(accessToken);
  if (authError || !authData.user) return null;

  const userInfo = await getUserFromDB(authData.user.id);

  if (!userInfo) return null;

  if (requiredRole && !requiredRole.includes(userInfo.role)) return null;

  return userInfo;
};

const requireRole = async (req: any, res: any, allowedRoles: AppRole[]): Promise<UserInfo | null> => {
  const userInfo = await validateUserPermission(req, res);
  if (!userInfo) {
    res.status(401).json({ error: 'Não autorizado' });
    return null;
  }
  if (!allowedRoles.includes(userInfo.role)) {
    res.status(403).json({ error: 'Acesso negado' });
    return null;
  }
  return userInfo;
};

const recordPasswordAudit = async (
  actor: UserInfo,
  route: string,
  targetUid: string | null,
  details: Record<string, string | number | null>,
  statusCode = 200
) => supabase.from('dev_audit_logs').insert({
  actor_uid: actor.uid,
  actor_role: actor.role,
  method: 'POST',
  route,
  status_code: statusCode,
  target_uid: targetUid,
  details
});

app.get('/api/users/password-policy', async (req, res) => {
  const actor = await requireRole(req, res, ['dev', 'diretor']);
  if (!actor) return;
  res.json({
    teacher: Boolean(defaultPasswords.teacher),
    diretor: Boolean(defaultPasswords.diretor),
    dev: actor.role === 'dev' && Boolean(defaultPasswords.dev)
  });
});

app.post('/api/users/:uid/password', async (req, res) => {
  const actor = await requireRole(req, res, ['dev', 'diretor']);
  if (!actor) return;
  if (req.params.uid === actor.uid) {
    return res.status(403).json({ error: 'Use a troca de senha da própria conta.' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['mode', 'password'].includes(key)) ||
      !['custom', 'default'].includes(body.mode)) {
    return res.status(400).json({ error: 'Informe um modo de alteração de senha válido.' });
  }

  const { data: target, error: targetError } = await supabase
    .from('users')
    .select('uid,role,school_id,must_change_password,password_set_by')
    .eq('uid', req.params.uid)
    .maybeSingle();
  if (targetError) return res.status(500).json({ error: 'Não foi possível verificar o usuário.' });
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });

  if (actor.role === 'diretor' &&
      (target.role === 'dev' || !actor.school_id || target.school_id !== actor.school_id)) {
    return res.status(403).json({ error: 'Diretores só podem alterar contas da própria escola.' });
  }

  let newPassword: string;
  if (body.mode === 'custom') {
    if (typeof body.password !== 'string' || !isStrongPassword(body.password)) {
      return res.status(400).json({ error: 'A senha deve ter no mínimo 8 caracteres, com pelo menos uma letra e um número.' });
    }
    newPassword = body.password;
  } else {
    const role = target.role as PasswordRole;
    if (!Object.prototype.hasOwnProperty.call(defaultPasswords, role)) {
      return res.status(400).json({ error: 'Não há senha padrão para este perfil.' });
    }
    const configuredPassword = defaultPasswords[role];
    if (!configuredPassword) {
      return res.status(503).json({ error: `A variável ${defaultPasswordEnvNames[role]} não está configurada.` });
    }
    newPassword = configuredPassword;
  }

  const { error: policyError } = await supabase
    .from('users')
    .update({ must_change_password: true, password_set_by: actor.uid })
    .eq('uid', target.uid);
  if (policyError) return res.status(500).json({ error: 'Não foi possível atualizar a política de senha.' });

  const { error: authUpdateError } = await supabase.auth.admin.updateUserById(target.uid, { password: newPassword });
  if (authUpdateError) {
    const { error: rollbackError } = await supabase
      .from('users')
      .update({
        must_change_password: target.must_change_password,
        password_set_by: target.password_set_by
      })
      .eq('uid', target.uid);
    if (rollbackError) {
      return res.status(500).json({ error: 'Não foi possível concluir a alteração da senha. Contate o desenvolvedor.' });
    }
    return res.status(400).json({ error: 'Não foi possível alterar a senha.' });
  }

  const { error: auditError } = await recordPasswordAudit(
    actor,
    `/api/users/${target.uid}/password`,
    target.uid,
    { event: 'password_changed' }
  );
  if (auditError) return res.status(500).json({ error: 'Senha alterada, mas não foi possível registrar a auditoria.' });

  res.json({ status: 'success', mustChangePassword: true });
});

app.post('/api/users/password/bulk-default', async (req, res) => {
  const actor = await requireRole(req, res, ['dev', 'diretor']);
  if (!actor) return;
  const { role, schoolId, confirm } = req.body || {};
  if (!['teacher', 'diretor'].includes(role) || (schoolId !== undefined && typeof schoolId !== 'string')) {
    return res.status(400).json({ error: 'Informe um perfil e uma escola válidos.' });
  }
  if (confirm !== 'APLICAR') return res.status(400).json({ error: 'Digite APLICAR para confirmar a operação.' });
  if (actor.role === 'diretor' && (!actor.school_id || (schoolId && schoolId !== actor.school_id))) {
    return res.status(403).json({ error: 'Diretores só podem aplicar a senha padrão na própria escola.' });
  }

  const configuredPassword = defaultPasswords[role as 'teacher' | 'diretor'];
  if (!configuredPassword) {
    const envName = role === 'teacher'
      ? defaultPasswordEnvNames.teacher
      : defaultPasswordEnvNames.diretor;
    return res.status(503).json({ error: `A variável ${envName} não está configurada.` });
  }

  const requestedSchoolId = actor.role === 'diretor' ? actor.school_id : schoolId;
  if (requestedSchoolId) {
    const { data: school, error: schoolError } = await supabase
      .from('schools')
      .select('id')
      .eq('id', requestedSchoolId)
      .maybeSingle();
    if (schoolError) return res.status(500).json({ error: 'Não foi possível verificar a escola.' });
    if (!school) return res.status(400).json({ error: 'Escola não encontrada.' });
  }

  let query = supabase
    .from('users')
    .select('uid,must_change_password,password_set_by')
    .eq('role', role)
    .neq('uid', actor.uid);
  if (requestedSchoolId) query = query.eq('school_id', requestedSchoolId);
  const { data: targets, error: targetsError } = await query;
  if (targetsError) return res.status(500).json({ error: 'Não foi possível localizar os usuários.' });

  let updated = 0;
  let failed = false;
  for (const target of targets || []) {
    const { error: policyError } = await supabase
      .from('users')
      .update({ must_change_password: true, password_set_by: actor.uid })
      .eq('uid', target.uid);
    if (policyError) {
      failed = true;
      continue;
    }

    const { error: authUpdateError } = await supabase.auth.admin.updateUserById(target.uid, {
      password: configuredPassword
    });
    if (authUpdateError) {
      const { error: rollbackError } = await supabase
        .from('users')
        .update({
          must_change_password: target.must_change_password,
          password_set_by: target.password_set_by
        })
        .eq('uid', target.uid);
      if (rollbackError) failed = true;
      failed = true;
      continue;
    }
    updated += 1;
  }

  const { error: auditError } = await recordPasswordAudit(
    actor,
    '/api/users/password/bulk-default',
    null,
    { event: 'bulk_default_password_applied', role, school_id: requestedSchoolId || null, count: updated },
    failed ? 207 : 200
  );
  if (auditError) return res.status(500).json({ error: 'Não foi possível registrar a auditoria do lote.', updated });
  if (failed) {
    return res.status(207).json({ error: 'A operação foi concluída parcialmente.', updated });
  }
  res.json({ updated });
});

app.patch('/api/auth/password', async (req, res) => {
  const actor = await requireRole(req, res, ['dev', 'diretor', 'teacher']);
  if (!actor) return;
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !currentPassword ||
      typeof newPassword !== 'string' || !isStrongPassword(newPassword)) {
    return res.status(400).json({ error: 'A nova senha deve ter no mínimo 8 caracteres, com pelo menos uma letra e um número.' });
  }

  if (newPassword === defaultPasswords[actor.role]) {
    return res.status(400).json({ error: 'A nova senha não pode ser a senha padrão do seu perfil.' });
  }

  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const changeLimitKey = createHash('sha256').update(`${actor.uid}\0${ip}`).digest('hex');
  if (!checkRateLimit(`password-change:${changeLimitKey}`, 5, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Credenciais inválidas' });
  }

  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('email')
    .eq('uid', actor.uid)
    .maybeSingle();
  if (profileError || !profile?.email) return res.status(500).json({ error: 'Não foi possível verificar a conta.' });

  const { data: verified, error: verifyError } = await supabaseAuth.auth.signInWithPassword({
    email: profile.email,
    password: currentPassword
  });
  if (verifyError || verified.user?.id !== actor.uid) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  const { error: authUpdateError } = await supabase.auth.admin.updateUserById(actor.uid, {
    password: newPassword
  });
  if (authUpdateError) return res.status(400).json({ error: 'Não foi possível atualizar a senha.' });

  const { error: policyError } = await supabase
    .from('users')
    .update({ must_change_password: false })
    .eq('uid', actor.uid);
  if (policyError) return res.status(500).json({ error: 'Senha alterada, mas não foi possível concluir a atualização da conta.' });

  res.json({ status: 'success', mustChangePassword: false });
});

type EditableUserField = 'email' | 'displayName' | 'subject' | 'role' | 'schoolId';
type UserProfileChanges = Partial<Record<EditableUserField, string | null>>;

interface UserProfileRecord extends UserInfo {
  email: string;
  displayname: string | null;
  subject: string | null;
}

const canEditTarget = (
  actor: UserInfo,
  target: UserProfileRecord,
  changes: UserProfileChanges
): string | null => {
  if (changes.role !== undefined && actor.uid === target.uid && changes.role !== target.role) {
    return 'Não é possível alterar o próprio perfil.';
  }
  if (actor.role === 'dev') return null;
  if (actor.role !== 'diretor') return 'Você não tem permissão para editar usuários.';
  if (target.role === 'dev') return 'Diretores não podem editar contas de desenvolvedor.';
  if (!actor.school_id || target.school_id !== actor.school_id) {
    return 'Diretores só podem editar usuários da própria escola.';
  }
  if (changes.schoolId !== undefined) return 'Diretores não podem alterar a escola de usuários.';
  if (changes.role !== undefined && !['teacher', 'diretor'].includes(changes.role)) {
    return 'Diretores só podem definir os perfis professor ou diretor.';
  }
  return null;
};

const normalizeUserProfileChanges = (
  body: unknown
): { changes?: UserProfileChanges; error?: string } => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Informe os campos que deseja alterar.' };
  }
  const allowedFields: EditableUserField[] = ['email', 'displayName', 'subject', 'role', 'schoolId'];
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.some(key => !allowedFields.includes(key as EditableUserField))) {
    return { error: 'A solicitação contém campos não permitidos.' };
  }
  if (keys.length === 0) return { error: 'Informe ao menos um campo para alterar.' };

  const changes: UserProfileChanges = {};
  if (Object.prototype.hasOwnProperty.call(values, 'email')) {
    if (typeof values.email !== 'string') return { error: 'E-mail inválido.' };
    const email = sanitizeEmail(values.email);
    if (!isValidEmail(email)) return { error: 'E-mail inválido. Use um endereço válido.' };
    changes.email = email;
  }
  if (Object.prototype.hasOwnProperty.call(values, 'displayName')) {
    if (typeof values.displayName !== 'string' || !values.displayName.trim()) {
      return { error: 'Nome é obrigatório.' };
    }
    const displayName = values.displayName.trim();
    if (displayName.length > 120) return { error: 'O nome deve ter no máximo 120 caracteres.' };
    changes.displayName = displayName;
  }
  if (Object.prototype.hasOwnProperty.call(values, 'subject')) {
    if (values.subject !== null && typeof values.subject !== 'string') {
      return { error: 'Matéria inválida.' };
    }
    changes.subject = typeof values.subject === 'string' ? values.subject.trim() || null : null;
  }
  if (Object.prototype.hasOwnProperty.call(values, 'role')) {
    if (typeof values.role !== 'string' || !VALID_ROLES.includes(values.role as AppRole)) {
      return { error: 'Perfil inválido.' };
    }
    changes.role = values.role;
  }
  if (Object.prototype.hasOwnProperty.call(values, 'schoolId')) {
    if (values.schoolId !== null && typeof values.schoolId !== 'string') {
      return { error: 'Escola inválida.' };
    }
    changes.schoolId = typeof values.schoolId === 'string' ? values.schoolId.trim() || null : null;
  }
  return { changes };
};

const updateUserProfile = async (
  actor: UserInfo,
  uid: string,
  body: unknown,
  res: any,
  options: { allowedFields?: EditableUserField[]; targetRoles?: AppRole[] } = {}
): Promise<void> => {
  const parsed = normalizeUserProfileChanges(body);
  if (!parsed.changes) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const changes = parsed.changes;
  if (options.allowedFields && Object.keys(changes).some(field => !options.allowedFields?.includes(field as EditableUserField))) {
    res.status(400).json({ error: 'A solicitação contém campos não permitidos para esta rota.' });
    return;
  }

  const { data: target, error: targetError } = await supabase
    .from('users')
    .select('uid,email,displayname,role,subject,school_id')
    .eq('uid', uid)
    .maybeSingle();
  if (targetError) {
    res.status(500).json({ error: 'Erro ao verificar usuário.' });
    return;
  }
  if (!target) {
    res.status(404).json({ error: 'Usuário não encontrado.' });
    return;
  }
  if (options.targetRoles && !options.targetRoles.includes(target.role)) {
    res.status(400).json({ error: 'Esta rota só pode editar professores.' });
    return;
  }

  const permissionError = canEditTarget(actor, target as UserProfileRecord, changes);
  if (permissionError) {
    res.status(403).json({ error: permissionError });
    return;
  }

  if (changes.email !== undefined) {
    const { data: usersWithEmail, error: emailLookupError } = await supabase
      .from('users')
      .select('uid,email');
    if (emailLookupError) {
      res.status(500).json({ error: 'Não foi possível verificar se o e-mail já está cadastrado.' });
      return;
    }
    const duplicate = (usersWithEmail || []).some(account =>
      account.uid !== uid && account.email?.toLowerCase() === changes.email?.toLowerCase()
    );
    if (duplicate) {
      res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
      return;
    }
  }

  if (changes.schoolId) {
    const { data: school, error: schoolError } = await supabase
      .from('schools')
      .select('id')
      .eq('id', changes.schoolId)
      .maybeSingle();
    if (schoolError) {
      res.status(500).json({ error: 'Não foi possível verificar a escola selecionada.' });
      return;
    }
    if (!school) {
      res.status(400).json({ error: 'A escola selecionada não foi encontrada.' });
      return;
    }
  }

  const dbChanges: Record<string, string | null> = {};
  const auditDetails: Record<string, { old: string | null; new: string | null }> = {};
  const recordChange = (field: EditableUserField, oldValue: string | null, newValue: string | null, column: string) => {
    if (oldValue === newValue) return;
    dbChanges[column] = newValue;
    auditDetails[field] = { old: oldValue, new: newValue };
  };
  if (changes.email !== undefined) recordChange('email', target.email, changes.email, 'email');
  if (changes.displayName !== undefined) recordChange('displayName', target.displayname, changes.displayName, 'displayname');
  if (changes.subject !== undefined) recordChange('subject', target.subject, changes.subject, 'subject');
  if (changes.role !== undefined) recordChange('role', target.role, changes.role, 'role');
  if (changes.schoolId !== undefined) recordChange('schoolId', target.school_id, changes.schoolId, 'school_id');

  if (Object.keys(dbChanges).length === 0) {
    res.json(transformKeys(target));
    return;
  }

  const { data: authData, error: authLookupError } = await supabase.auth.admin.getUserById(uid);
  if (authLookupError || !authData.user) {
    console.error('[USER_UPDATE] Auth lookup failed:', authLookupError);
    res.status(500).json({ error: 'Não foi possível localizar a conta no sistema de autenticação.' });
    return;
  }

  const previousMetadata = { ...(authData.user.user_metadata || {}) };
  const nextMetadata = { ...previousMetadata };
  let metadataChanged = false;
  for (const field of ['displayName', 'role', 'subject'] as const) {
    if (Object.prototype.hasOwnProperty.call(dbChanges, field === 'displayName' ? 'displayname' : field)) {
      nextMetadata[field] = field === 'displayName'
        ? changes.displayName
        : changes[field];
      metadataChanged = true;
    }
  }

  const authChanges: { email?: string; email_confirm?: boolean; user_metadata?: Record<string, any> } = {};
  if (Object.prototype.hasOwnProperty.call(dbChanges, 'email')) {
    authChanges.email = changes.email || undefined;
    authChanges.email_confirm = true;
  }
  if (metadataChanged) authChanges.user_metadata = nextMetadata;

  let authWasUpdated = false;
  if (Object.keys(authChanges).length > 0) {
    const { error: authUpdateError } = await supabase.auth.admin.updateUserById(uid, authChanges);
    if (authUpdateError) {
      console.error('[USER_UPDATE] Auth update failed:', authUpdateError);
      res.status(400).json({ error: `Não foi possível atualizar a conta no sistema de autenticação: ${authUpdateError.message}` });
      return;
    }
    authWasUpdated = true;
  }

  const { data: updatedUser, error: updateError } = await supabase
    .from('users')
    .update(dbChanges)
    .eq('uid', uid)
    .select('uid,email,displayname,role,subject,school_id')
    .single();
  if (updateError) {
    if (authWasUpdated) {
      const rollback: { email?: string; email_confirm?: boolean; user_metadata?: Record<string, any> } = {
        user_metadata: previousMetadata
      };
      if (authChanges.email !== undefined) {
        rollback.email = authData.user.email || target.email;
        rollback.email_confirm = true;
      }
      let rollbackError: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const { error } = await supabase.auth.admin.updateUserById(uid, rollback);
        if (!error) {
          rollbackError = null;
          break;
        }
        rollbackError = error;
      }
      if (rollbackError) {
        console.error('[USER_UPDATE] CRITICAL: Auth rollback failed after profile update error:', rollbackError);
        res.status(500).json({ error: 'A tabela de usuários não foi atualizada e a reversão no Auth falhou. Contate o desenvolvedor imediatamente.' });
        return;
      }
    }
    console.error('[USER_UPDATE] Database update failed:', updateError);
    res.status(500).json({ error: authWasUpdated
      ? 'Não foi possível atualizar o perfil; as alterações no Auth foram revertidas.'
      : 'Não foi possível atualizar o perfil do usuário.' });
    return;
  }

  const { error: auditError } = await supabase.from('dev_audit_logs').insert({
    actor_uid: actor.uid,
    actor_role: actor.role,
    method: 'PATCH',
    route: `/api/users/${uid}`,
    status_code: 200,
    target_uid: uid,
    details: auditDetails
  });
  if (auditError) {
    console.error('[USER_UPDATE] Profile changed but detailed audit could not be stored:', auditError);
    res.status(500).json({ error: 'Usuário atualizado, mas não foi possível registrar os detalhes da auditoria.' });
    return;
  }

  res.json(transformKeys(updatedUser));
};

const getSchoolIdForPeriods = (req: any, res: any, userInfo: UserInfo): string | null => {
  if (userInfo.role === 'diretor' || userInfo.role === 'teacher') {
    if (req.query.schoolId && req.query.schoolId !== userInfo.school_id) {
      res.status(403).json({ error: 'Acesso negado' });
      return null;
    }
    if (!userInfo.school_id) {
      res.status(400).json({ error: 'Associe sua conta a uma escola antes de consultar os períodos.' });
      return null;
    }
    return userInfo.school_id;
  }

  const schoolId = req.query.schoolId || req.body?.schoolId;
  if (userInfo.role !== 'dev' || typeof schoolId !== 'string' || !schoolId) {
    res.status(400).json({ error: 'Informe uma escola válida.' });
    return null;
  }
  return schoolId;
};

app.get('/api/teacher-availability', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor', 'teacher']);
  if (!userInfo) return;

  const teacherId = typeof req.query.teacherId === 'string' ? sanitizeString(req.query.teacherId) : '';
  if (!teacherId) return res.status(400).json({ error: 'Informe um professor válido.' });
  if (userInfo.role === 'teacher' && teacherId !== userInfo.uid) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const { data: teacher, error: teacherError } = await supabase
    .from('users')
    .select('uid,role,school_id')
    .eq('uid', teacherId)
    .maybeSingle();
  if (teacherError) {
    console.error('[TEACHER_AVAILABILITY] Teacher lookup failed:', teacherError);
    return res.status(500).json({ error: 'Erro ao verificar o professor. Confira se a migração 013 foi aplicada no Supabase.' });
  }
  if (!teacher || teacher.role !== 'teacher') {
    return res.status(404).json({ error: 'Professor não encontrado.' });
  }
  if (userInfo.role === 'diretor' && teacher.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  if (!teacher.school_id) {
    return res.status(400).json({ error: 'Associe o professor a uma escola antes de consultar a disponibilidade.' });
  }

  const { data, error } = await supabase
    .from('teacher_weekday_availability')
    .select('id,school_id,teacher_uid,weekday,available,updated_at')
    .eq('school_id', teacher.school_id)
    .eq('teacher_uid', teacher.uid)
    .order('weekday', { ascending: true });
  if (error) {
    console.error('[TEACHER_AVAILABILITY] Availability lookup failed:', error);
    return res.status(500).json({ error: 'Erro ao buscar disponibilidade. Confira se a migração 013 foi aplicada no Supabase.' });
  }
  res.json(transformKeys(data));
});

app.put('/api/teacher-availability', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;

  const teacherId = typeof req.body?.teacherId === 'string' ? sanitizeString(req.body.teacherId) : '';
  const weekday = req.body?.weekday;
  const available = req.body?.available;
  if (!teacherId || !Number.isInteger(weekday) || weekday < 1 || weekday > 5 || typeof available !== 'boolean') {
    return res.status(400).json({ error: 'Informe professor, dia útil (1 a 5) e disponibilidade válida.' });
  }

  const { data: teacher, error: teacherError } = await supabase
    .from('users')
    .select('uid,role,school_id')
    .eq('uid', teacherId)
    .maybeSingle();
  if (teacherError) {
    console.error('[TEACHER_AVAILABILITY] Teacher lookup failed:', teacherError);
    return res.status(500).json({ error: 'Erro ao verificar o professor. Confira se a migração 013 foi aplicada no Supabase.' });
  }
  if (!teacher || teacher.role !== 'teacher') {
    return res.status(404).json({ error: 'Professor não encontrado.' });
  }
  if (userInfo.role === 'diretor' && teacher.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'A disponibilidade só pode ser alterada para professores da sua escola.' });
  }
  if (!teacher.school_id) {
    return res.status(400).json({ error: 'Associe o professor a uma escola antes de alterar a disponibilidade.' });
  }

  const { data, error } = await supabase
    .from('teacher_weekday_availability')
    .upsert(
      {
        school_id: teacher.school_id,
        teacher_uid: teacher.uid,
        weekday,
        available,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'school_id,teacher_uid,weekday' }
    )
    .select('id,school_id,teacher_uid,weekday,available,updated_at')
    .single();
  if (error) {
    console.error('[TEACHER_AVAILABILITY] Availability save failed:', error);
    return res.status(500).json({ error: 'Erro ao salvar disponibilidade. Confira se a migração 013 foi aplicada no Supabase.' });
  }
  res.json(transformKeys(data));
});

app.get('/api/school-periods', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor', 'teacher']);
  if (!userInfo) return;
  const schoolId = getSchoolIdForPeriods(req, res, userInfo);
  if (!schoolId) return;

  const { data, error } = await supabase
    .from('school_periods')
    .select('id,school_id,turno,period_number,name,start_time,end_time')
    .eq('school_id', schoolId)
    .order('turno', { ascending: true })
    .order('period_number', { ascending: true });
  if (error) return res.status(500).json({ error: 'Erro ao buscar os períodos. Confira se as migrações 009 e 010 foram aplicadas no Supabase.' });
  res.json(transformKeys(data));
});

app.post('/api/school-periods', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;
  const schoolId = getSchoolIdForPeriods(req, res, userInfo);
  if (!schoolId) return;

  const periodNumber = Number(req.body?.periodNumber);
  const turno = req.body?.turno;
  const name = sanitizeString(req.body?.name || '');
  const startTime = req.body?.startTime;
  const endTime = req.body?.endTime;
  const maximumPeriods = turno === 'noite' ? 5 : 6;
  if (!['manha', 'tarde', 'noite'].includes(turno) || !Number.isInteger(periodNumber) || periodNumber < 1 || periodNumber > maximumPeriods || !name || !isValidTime(startTime) || !isValidTime(endTime) || timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    return res.status(400).json({ error: 'Informe nome, ordem e um intervalo de horário válido para o período.' });
  }

  const { data: existingPeriods, error: existingError } = await supabase
    .from('school_periods')
    .select('turno,period_number,start_time,end_time')
    .eq('school_id', schoolId)
    .eq('turno', turno);
  if (existingError) return res.status(500).json({ error: 'Erro ao validar os períodos existentes.' });
  const overlap = (existingPeriods || []).find(period =>
    doesTimeOverlap(startTime, endTime, period.start_time, period.end_time)
  );
  if (overlap) return res.status(409).json({ error: `Este horário se sobrepõe ao período ${overlap.period_number}.` });

  const { data, error } = await supabase
    .from('school_periods')
    .upsert(
      { school_id: schoolId, turno, period_number: periodNumber, name, start_time: startTime, end_time: endTime },
      { onConflict: 'school_id,turno,period_number' }
    )
    .select('id,school_id,turno,period_number,name,start_time,end_time')
    .single();
  if (error) return res.status(500).json({ error: 'Erro ao salvar o período.' });
  res.json(transformKeys(data));
});

app.patch('/api/school-periods/:id', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;
  const schoolId = getSchoolIdForPeriods(req, res, userInfo);
  if (!schoolId) return;
  const periodId = Number(req.params.id);
  if (!Number.isInteger(periodId) || periodId < 1) return res.status(400).json({ error: 'Período inválido.' });

  const { data: current, error: currentError } = await supabase
    .from('school_periods')
    .select('id,period_number,turno')
    .eq('id', periodId)
    .eq('school_id', schoolId)
    .maybeSingle();
  if (currentError) return res.status(500).json({ error: 'Erro ao verificar o período.' });
  if (!current) return res.status(404).json({ error: 'Período não encontrado nesta escola.' });

  const name = sanitizeString(req.body?.name || '');
  const turno = req.body?.turno;
  const startTime = req.body?.startTime;
  const endTime = req.body?.endTime;
  const maximumPeriods = turno === 'noite' ? 5 : 6;
  if (!['manha', 'tarde', 'noite'].includes(turno) || current.period_number > maximumPeriods || !name || !isValidTime(startTime) || !isValidTime(endTime) || timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    return res.status(400).json({ error: 'Informe nome e um intervalo de horário válido para o período.' });
  }

  const { data: sameNumber, error: numberError } = await supabase
    .from('school_periods')
    .select('id')
    .eq('school_id', schoolId)
    .eq('turno', turno)
    .eq('period_number', current.period_number)
    .neq('id', periodId)
    .maybeSingle();
  if (numberError) return res.status(500).json({ error: 'Erro ao verificar a ordem do período.' });
  if (sameNumber) return res.status(409).json({ error: `Já existe a ${current.period_number}ª aula no turno da ${turno}.` });

  const { data: otherPeriods, error: otherError } = await supabase
    .from('school_periods')
    .select('period_number,start_time,end_time')
    .eq('school_id', schoolId)
    .eq('turno', turno)
    .neq('id', periodId);
  if (otherError) return res.status(500).json({ error: 'Erro ao validar os períodos existentes.' });
  const overlap = (otherPeriods || []).find(period => doesTimeOverlap(startTime, endTime, period.start_time, period.end_time));
  if (overlap) return res.status(409).json({ error: `Este horário se sobrepõe ao período ${overlap.period_number}.` });

  const { data, error } = await supabase
    .from('school_periods')
    .update({ turno, name, start_time: startTime, end_time: endTime })
    .eq('id', periodId)
    .eq('school_id', schoolId)
    .select('id,school_id,turno,period_number,name,start_time,end_time')
    .single();
  if (error) return res.status(500).json({ error: 'Erro ao atualizar o período.' });
  res.json(transformKeys(data));
});

app.delete('/api/school-periods/:id', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;
  const schoolId = getSchoolIdForPeriods(req, res, userInfo);
  if (!schoolId) return;
  const periodId = Number(req.params.id);
  if (!Number.isInteger(periodId) || periodId < 1) return res.status(400).json({ error: 'Período inválido.' });

  const { error, count } = await supabase
    .from('school_periods')
    .delete({ count: 'exact' })
    .eq('id', periodId)
    .eq('school_id', schoolId);
  if (error) return res.status(500).json({ error: 'Erro ao excluir o período.' });
  if (count === 0) return res.status(404).json({ error: 'Período não encontrado nesta escola.' });
  res.json({ status: 'success' });
});

app.post('/api/schedules/recurring', async (req, res) => {
  const userInfo = await requireRole(req, res, ['diretor']);
  if (!userInfo) return;
  if (!userInfo.school_id) return res.status(400).json({ error: 'Associe sua conta a uma escola antes de criar horários.' });

  const { startDate, endDate, weekdayNumbers, periodNumbers, turno } = req.body || {};
  const subject = sanitizeString(req.body?.subject || '');
  const secondSubject = sanitizeString(req.body?.secondSubject || '');
  const secondPeriodNumbers = req.body?.secondPeriodNumbers ?? [];
  const classGroup = sanitizeString(req.body?.classGroup || '');
  const room = sanitizeString(req.body?.room || '');
  const teacherId = typeof req.body?.teacherId === 'string' ? req.body.teacherId : '';
  const maximumPeriods = turno === 'noite' ? 5 : 6;
  if (!['manha', 'tarde', 'noite'].includes(turno)) {
    return res.status(400).json({ error: 'Selecione um turno válido.' });
  }
  if (!isValidDateOnly(startDate) || !isValidDateOnly(endDate) || startDate > endDate) {
    return res.status(400).json({ error: 'Informe um intervalo de datas válido.' });
  }
  const daySpan = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
  if (daySpan > 365) return res.status(400).json({ error: 'O intervalo máximo para gerar horários é de um ano.' });
  if (!Array.isArray(weekdayNumbers) || weekdayNumbers.length === 0 ||
      weekdayNumbers.some(day => !Number.isInteger(day) || day < 1 || day > 5) ||
      new Set(weekdayNumbers).size !== weekdayNumbers.length) {
    return res.status(400).json({ error: 'Selecione pelo menos um dia útil da semana.' });
  }
  if (!Array.isArray(periodNumbers) || periodNumbers.length === 0 ||
      periodNumbers.some(period => !Number.isInteger(period) || period < 1 || period > 30) ||
      new Set(periodNumbers).size !== periodNumbers.length || periodNumbers.some(period => period > maximumPeriods)) {
    return res.status(400).json({ error: 'Selecione ao menos um período válido.' });
  }
  if (!Array.isArray(secondPeriodNumbers) ||
      secondPeriodNumbers.some(period => !Number.isInteger(period) || period < 1 || period > maximumPeriods) ||
      new Set(secondPeriodNumbers).size !== secondPeriodNumbers.length ||
      (secondSubject && secondPeriodNumbers.length === 0) ||
      (!secondSubject && secondPeriodNumbers.length > 0)) {
    return res.status(400).json({ error: 'Informe a segunda matéria e selecione períodos válidos para ela.' });
  }
  const allPeriodNumbers = [...periodNumbers, ...secondPeriodNumbers];
  if (new Set(allPeriodNumbers).size !== allPeriodNumbers.length || allPeriodNumbers.length > maximumPeriods) {
    return res.status(400).json({ error: 'Cada período pode ser usado para apenas uma matéria.' });
  }
  if (secondSubject && secondSubject.toLocaleLowerCase() === subject.toLocaleLowerCase()) {
    return res.status(400).json({ error: 'A segunda matéria precisa ser diferente da primeira.' });
  }
  if (!subject || !classGroup || !teacherId) {
    return res.status(400).json({ error: 'Preencha matéria, turma e professor.' });
  }

  const teacher = await getUserFromDB(teacherId);
  if (!teacher || teacher.role !== 'teacher' || teacher.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'O horário deve pertencer a um professor da sua escola.' });
  }

  const { data: catalogGroup, error: classGroupError } = await supabase
    .from('school_class_groups')
    .select('id')
    .eq('school_id', userInfo.school_id)
    .ilike('class_group', classGroup)
    .maybeSingle();
  if (classGroupError) return res.status(500).json({ error: 'Erro ao verificar a turma do horário.' });
  if (!catalogGroup) return res.status(400).json({ error: 'Selecione uma turma cadastrada na escola.' });

  const { data: selectedPeriods, error: periodsError } = await supabase
    .from('school_periods')
    .select('period_number,name,start_time,end_time')
    .eq('school_id', userInfo.school_id)
    .eq('turno', turno)
    .in('period_number', allPeriodNumbers)
    .order('period_number', { ascending: true });
  if (periodsError) return res.status(500).json({ error: 'Erro ao buscar os períodos da escola.' });
  if (!selectedPeriods || selectedPeriods.length !== allPeriodNumbers.length) {
    return res.status(400).json({ error: 'Um ou mais períodos selecionados não pertencem à sua escola.' });
  }
  for (let index = 1; index < selectedPeriods.length; index += 1) {
    const previous = selectedPeriods[index - 1];
    const current = selectedPeriods[index];
    if (doesTimeOverlap(previous.start_time, previous.end_time, current.start_time, current.end_time)) {
      return res.status(409).json({ error: 'Os períodos selecionados possuem horários sobrepostos. Revise a configuração da escola.' });
    }
  }

  const entries: Array<Record<string, string>> = [];
  const subjectByPeriod = new Map<number, string>();
  periodNumbers.forEach(periodNumber => subjectByPeriod.set(periodNumber, subject));
  secondPeriodNumbers.forEach(periodNumber => subjectByPeriod.set(periodNumber, secondSubject));
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const finalDate = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= finalDate) {
    const weekday = cursor.getUTCDay();
    if (weekdayNumbers.includes(weekday)) {
      const date = cursor.toISOString().slice(0, 10);
      selectedPeriods.forEach(period => entries.push({
        date,
        starttime: period.start_time,
        endtime: period.end_time,
        subject: subjectByPeriod.get(period.period_number) || subject,
        room,
        teacherid: teacherId,
        teachername: teacher.displayname || '',
        classgroup: classGroup,
        status: 'pending',
        turno,
        school_id: userInfo.school_id!
      }));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (entries.length === 0) return res.status(400).json({ error: 'Nenhum dia selecionado cai dentro do intervalo informado.' });

  type ExistingSchedule = {
    id: number;
    date: string;
    starttime: string;
    endtime: string;
    teacherid: string;
    classgroup: string | null;
    room: string | null;
    subject: string | null;
  };
  const existingSchedules: ExistingSchedule[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: page, error: schedulesError } = await supabase
      .from('schedules')
      .select('id,date,starttime,endtime,teacherid,classgroup,room,subject')
      .eq('school_id', userInfo.school_id)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('id', { ascending: true })
      .range(offset, offset + 999);
    if (schedulesError) return res.status(500).json({ error: 'Erro ao validar conflitos nos horários existentes.' });
    existingSchedules.push(...(page || []));
    if (!page || page.length < 1000) break;
  }

  const byDate = new Map<string, ExistingSchedule[]>();
  let hasInvalidExistingTime = false;
  existingSchedules.forEach(schedule => {
    if (!isValidTime(schedule.starttime) || !isValidTime(schedule.endtime)) {
      hasInvalidExistingTime = true;
      return;
    }
    const daySchedules = byDate.get(schedule.date) || [];
    daySchedules.push(schedule);
    byDate.set(schedule.date, daySchedules);
  });
  if (hasInvalidExistingTime) {
    return res.status(500).json({ error: 'Não foi possível validar conflitos porque há horários cadastrados com horas inválidas.' });
  }
  for (const entry of entries) {
    const conflict = (byDate.get(entry.date) || []).find(schedule => {
      const sameTeacher = schedule.teacherid === teacherId;
      const sameClass = String(schedule.classgroup || '').trim().toLocaleLowerCase() === classGroup.toLocaleLowerCase();
      const sameRoom = Boolean(room && String(schedule.room || '').trim().toLocaleLowerCase() === room.toLocaleLowerCase());
      return (sameTeacher || sameClass || sameRoom) &&
        doesTimeOverlap(entry.starttime, entry.endtime, schedule.starttime, schedule.endtime);
    });
    if (conflict) {
      const conflictingClass = String(conflict.classgroup || '').trim();
      const conflictingSubject = String(conflict.subject || '').trim();
      const conflictDetails = [
        conflictingClass ? `turma ${conflictingClass}` : null,
        conflictingSubject ? `matéria ${conflictingSubject}` : null
      ].filter(Boolean).join(', ');
      const conflictDescription = conflictDetails ? ` com ${conflictDetails}` : '';
      return res.status(409).json({
        error: `Conflito de horário em ${entry.date}, das ${entry.starttime.slice(0, 5)} às ${entry.endtime.slice(0, 5)}${conflictDescription}. Nenhuma aula foi criada.`
      });
    }
  }

  const { error } = await supabase.from('schedules').insert(entries);
  if (error) return res.status(500).json({ error: 'Não foi possível gerar os horários. Nenhuma aula foi criada.' });
  res.json({ status: 'success', created: entries.length });
});

app.get('/api/dev/diagnostics', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev']);
  if (!userInfo) return;

  const tables = ['users', 'schools', 'schedules', 'school_periods', 'lab_bookings', 'school_subjects', 'teacher_subjects'] as const;
  const probes = await Promise.all(tables.map(async table => {
    const startedAt = Date.now();
    const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    return {
      table,
      ok: !error,
      records: error ? null : count,
      latencyMs: Date.now() - startedAt
    };
  }));

  const integrityChecks = await Promise.all([
    supabase.from('users').select('uid', { count: 'exact', head: true }).eq('role', 'teacher').is('school_id', null),
    supabase.from('schedules').select('id', { count: 'exact', head: true }).is('school_id', null)
  ]);
  const dbProbe = probes.find(probe => probe.table === 'users');

  res.json({
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    api: { ok: true },
    database: { ok: dbProbe?.ok || false, latencyMs: dbProbe?.latencyMs ?? null },
    probes,
    integrity: [
      { name: 'Professores sem escola', count: integrityChecks[0].error ? null : integrityChecks[0].count, ok: !integrityChecks[0].error },
      { name: 'Horários sem escola', count: integrityChecks[1].error ? null : integrityChecks[1].count, ok: !integrityChecks[1].error }
    ]
  });
});

app.get('/api/dev/system-logs', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev']);
  if (!userInfo) return;

  const categories: SystemLogCategory[] = ['auth', 'api', 'action', 'error', 'frontend', 'system'];
  const levels: SystemLogLevel[] = ['info', 'warn', 'error'];
  const category = String(req.query.category || '');
  const level = String(req.query.level || '');
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  const search = String(req.query.search || '').trim().slice(0, 100).replace(/[,%()\\*]/g, '');
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 100);
  const page = Math.min(Math.max(Number(req.query.page) || 0, 0), 10000);

  let query = supabase
    .from('system_logs')
    .select('id,created_at,level,category,method,route,status_code,duration_ms,actor_uid,actor_role,school_id,message,metadata', { count: 'exact' });
  if (categories.includes(category as SystemLogCategory)) query = query.eq('category', category);
  if (levels.includes(level as SystemLogLevel)) query = query.eq('level', level);
  if (isValidDateOnly(from)) query = query.gte('created_at', `${from}T00:00:00.000Z`);
  if (isValidDateOnly(to)) {
    const toExclusive = new Date(`${to}T00:00:00.000Z`);
    toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
    query = query.lt('created_at', toExclusive.toISOString());
  }
  if (search) query = query.or(`route.ilike.%${search}%,message.ilike.%${search}%`);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) return res.status(500).json({ error: 'Não foi possível carregar os logs do sistema.' });
  res.json({ items: data || [], total: count || 0, page, pageSize });
});

app.get('/api/dev/audit', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev']);
  if (!userInfo) return;

  const { data, error } = await supabase
    .from('dev_audit_logs')
    .select('id,created_at,actor_uid,actor_role,method,route,status_code,target_uid,details')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: 'Não foi possível carregar a auditoria.' });
  res.json(data || []);
});

app.get('/api/dev/export/:resource', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev']);
  if (!userInfo) return;

  const exportFields = {
    users: 'uid,email,displayname,role,school_id,subject',
    schools: 'id,name,createdat',
    schedules: 'id,date,starttime,endtime,subject,room,teacherid,teachername,classgroup,turno,status,school_id',
    school_periods: 'id,school_id,turno,period_number,name,start_time,end_time',
    lab_bookings: 'id,labid,teacherid,teachername,date,starttime,endtime',
    school_subjects: 'id,school_id,subject',
    teacher_subjects: 'id,teacher_id,subject_id'
  } as const;
  const resource = req.params.resource as keyof typeof exportFields;
  if (!Object.prototype.hasOwnProperty.call(exportFields, resource)) {
    return res.status(400).json({ error: 'Tipo de exportação inválido.' });
  }
  const fields = exportFields[resource];
  const { count, error: countError } = await supabase
    .from(resource)
    .select(fields, { count: 'exact', head: true });
  if (countError) return res.status(500).json({ error: 'Não foi possível exportar esta tabela.' });
  if ((count || 0) > 5000) {
    return res.status(413).json({ error: 'A tabela excede o limite de 5.000 registros por exportação.' });
  }

  const rows = [];
  for (let offset = 0; offset < (count || 0); offset += 1000) {
    const { data, error } = await supabase
      .from(resource)
      .select(fields)
      .range(offset, Math.min(offset + 999, (count || 0) - 1));
    if (error) return res.status(500).json({ error: 'Não foi possível exportar esta tabela.' });
    rows.push(...(data || []));
  }
  res.json({ resource, count: rows.length, rows: transformKeys(rows) });
});

app.patch('/api/users/:uid/role', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;
  await updateUserProfile(userInfo, req.params.uid, { role: req.body.role }, res, {
    allowedFields: ['role']
  });
});

app.patch('/api/users/:uid', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;
  await updateUserProfile(userInfo, req.params.uid, req.body, res);
});

app.get('/api/labs/bookings', async (req, res) => {
  const userInfo = await requireRole(req, res, ['teacher', 'diretor', 'dev']);
  if (!userInfo) return;
  let query = supabase.from('lab_bookings').select('*');
  if (userInfo.role !== 'dev') {
    if (!userInfo.school_id) return res.status(403).json({ error: 'Sua conta não está associada a uma escola' });
    query = query.eq('school_id', userInfo.school_id);
  }
  const { data, error } = await query.order('date', { ascending: true }).order('starttime', { ascending: true });
  if (error) return res.status(500).json({ error: 'Erro ao buscar reservas' });
  res.json(transformKeys(data));
});

app.post('/api/labs/bookings', async (req, res) => {
  const userInfo = await requireRole(req, res, ['teacher', 'diretor']);
  if (!userInfo) return;
  const { labId, date, startTime, endTime } = req.body;
  if (!userInfo.school_id) return res.status(403).json({ error: 'Sua conta não está associada a uma escola' });
  if (!['info', 'chem'].includes(labId) ||
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(`${date}T00:00:00.000Z`)) ||
      new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date ||
      typeof startTime !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) ||
      typeof endTime !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) ||
      startTime >= endTime) {
    return res.status(400).json({ error: 'Informe laboratório, data e intervalo de horário válidos.' });
  }

  const { data: conflict, error: conflictError } = await supabase
    .from('lab_bookings')
    .select('id')
    .eq('school_id', userInfo.school_id)
    .eq('labid', labId)
    .eq('date', date)
    .lt('starttime', endTime)
    .gt('endtime', startTime)
    .limit(1)
    .maybeSingle();
  if (conflictError) return res.status(500).json({ error: 'Erro ao verificar disponibilidade do laboratório' });
  if (conflict) return res.status(409).json({ error: 'Este laboratório já está reservado em parte ou em todo esse horário.' });

  const { error } = await supabase.from('lab_bookings').insert({
    labid: labId,
    teacherid: userInfo.uid,
    teachername: userInfo.displayname,
    date,
    starttime: startTime,
    endtime: endTime,
    school_id: userInfo.school_id
  });
  if (error) return res.status(500).json({ error: 'Erro ao criar reserva' });
  res.json({ status: 'success' });
});

app.delete('/api/labs/bookings/:id', async (req, res) => {
  const userInfo = await requireRole(req, res, ['teacher', 'diretor', 'dev']);
  if (!userInfo) return;
  const { data: booking, error: findError } = await supabase
    .from('lab_bookings')
    .select('teacherid,school_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (findError) return res.status(500).json({ error: 'Erro ao verificar reserva' });
  if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });
  if (userInfo.role === 'teacher' && booking.teacherid !== userInfo.uid) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  if (userInfo.role === 'diretor' && booking.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  let deleteQuery = supabase.from('lab_bookings').delete().eq('id', req.params.id);
  if (userInfo.role !== 'dev') deleteQuery = deleteQuery.eq('school_id', userInfo.school_id);
  if (userInfo.role === 'teacher') deleteQuery = deleteQuery.eq('teacherid', userInfo.uid);
  const { data: deletedBooking, error } = await deleteQuery.select('id').maybeSingle();
  if (error) return res.status(500).json({ error: 'Erro ao excluir reserva' });
  if (!deletedBooking) return res.status(404).json({ error: 'A reserva não foi excluída. Atualize a agenda e tente novamente.' });
  res.json({ status: 'success' });
});

// ========== SCHOOLS (Multi-tenant) ==========

app.get('/api/schools', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev']);
  if (!userInfo) return;
  const { data, error } = await supabase.from('schools').select('*').order('name', { ascending: true });
  if (error) return res.status(500).json({ error: 'Erro ao buscar escolas' });
  res.json(data);
});

app.post('/api/schools', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev']);
  if (!userInfo) return;
  const { name, createdBy } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome da escola é obrigatório' });
  const { data, error } = await supabase.from('schools').insert({ name, createdBy }).select('*').single();
  if (error) return res.status(500).json({ error: `Erro ao criar escola: ${error.message}` });
  res.json(data);
});

app.patch('/api/schools/:id', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev']);
  if (!userInfo) return;
  const changes: { name?: string; active?: boolean } = {};
  if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
    if (typeof req.body.name !== 'string' || !req.body.name.trim()) {
      return res.status(400).json({ error: 'Nome é obrigatório.' });
    }
    changes.name = req.body.name.trim();
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'active')) {
    if (typeof req.body.active !== 'boolean') {
      return res.status(400).json({ error: 'O status da escola deve ser ativo ou inativo.' });
    }
    changes.active = req.body.active;
  }
  if (Object.keys(changes).length === 0) return res.status(400).json({ error: 'Informe o nome ou o status da escola.' });

  const { data, error } = await supabase.from('schools').update(changes).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: 'Erro ao atualizar escola' });
  res.json(data);
});

app.delete('/api/schools/:id', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev']);
  if (!userInfo) return;
  const { error } = await supabase.from('schools').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao deletar escola' });
  res.json({ status: 'success' });
});

// School subject catalog and teacher assignments
app.get('/api/school-subjects', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor', 'teacher']);
  if (!userInfo) return;

  const requestedSchoolId = typeof req.query.schoolId === 'string' ? req.query.schoolId : undefined;
  if (userInfo.role === 'diretor' && !userInfo.school_id) {
    return res.status(403).json({ error: 'Sua conta não está associada a uma escola' });
  }
  if (userInfo.role === 'teacher' && !userInfo.school_id) {
    return res.status(403).json({ error: 'Sua conta não está associada a uma escola' });
  }
  if (userInfo.role === 'diretor' && requestedSchoolId && requestedSchoolId !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  if (userInfo.role === 'teacher' && requestedSchoolId && requestedSchoolId !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  let query = supabase.from('school_subjects').select('id,school_id,subject').order('subject', { ascending: true });
  const schoolId = userInfo.role === 'teacher' ? userInfo.school_id : (userInfo.role === 'diretor' ? userInfo.school_id : requestedSchoolId);
  if (schoolId) query = query.eq('school_id', schoolId);
  const { data: subjects, error } = await query;
  if (error) return res.status(500).json({ error: 'Erro ao buscar matérias da escola' });

  const subjectIds = (subjects || []).map(subject => subject.id);
  const { data: assignments, error: assignmentError } = subjectIds.length
    ? await supabase.from('teacher_subjects').select('subject_id,teacher_id').in('subject_id', subjectIds)
    : { data: [], error: null };
  if (assignmentError) return res.status(500).json({ error: 'Erro ao buscar professores das matérias' });

  const teacherIdsBySubject = new Map<number, string[]>();
  for (const assignment of assignments || []) {
    const assigned = teacherIdsBySubject.get(assignment.subject_id) || [];
    assigned.push(assignment.teacher_id);
    teacherIdsBySubject.set(assignment.subject_id, assigned);
  }

  res.json((subjects || []).map(subject => ({
    ...transformKeys(subject),
    teacherIds: teacherIdsBySubject.get(subject.id) || []
  })));
});

const requireSubjectManager = async (req: any, res: any): Promise<UserInfo | null> => {
  const userInfo = await validateUserPermission(req, res);
  if (!userInfo) {
    res.status(401).json({ error: 'Não autorizado' });
    return null;
  }
  if (userInfo.role === 'teacher') {
    res.status(403).json({ error: 'Professores podem apenas consultar matérias. Peça à direção pedagógica para alterar os vínculos.' });
    return null;
  }
  if (!['dev', 'diretor'].includes(userInfo.role)) {
    res.status(403).json({ error: 'Apenas direção e desenvolvedor podem alterar vínculos de matérias.' });
    return null;
  }
  return userInfo;
};

app.post('/api/school-subjects', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;

  const subject = sanitizeString(req.body.subject);
  const requestedSchoolId = typeof req.body.schoolId === 'string' ? req.body.schoolId : '';
  if (userInfo.role === 'diretor' && !userInfo.school_id) {
    return res.status(403).json({ error: 'Sua conta não está associada a uma escola' });
  }
  const schoolId = userInfo.role === 'diretor' ? userInfo.school_id : requestedSchoolId;
  if (!subject || !schoolId) return res.status(400).json({ error: 'Escola e matéria são obrigatórias' });

  const { data: existingSubjects, error: findError } = await supabase
    .from('school_subjects')
    .select('id,school_id,subject')
    .eq('school_id', schoolId);
  if (findError) return res.status(500).json({ error: 'Erro ao verificar matéria' });
  const existing = (existingSubjects || []).find(item => item.subject.toLocaleLowerCase() === subject.toLocaleLowerCase());
  if (existing) return res.status(409).json({ error: 'Essa matéria já está cadastrada na escola' });

  const { data, error } = await supabase
    .from('school_subjects')
    .insert({ school_id: schoolId, subject })
    .select('id,school_id,subject')
    .single();
  if (error) return res.status(500).json({ error: `Erro ao cadastrar matéria: ${error.message}` });
  res.json(transformKeys({ ...data, teacherIds: [] }));
});

app.delete('/api/school-subjects/:id', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;

  const { data: subject, error: findError } = await supabase
    .from('school_subjects')
    .select('id,school_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (findError) return res.status(500).json({ error: 'Erro ao verificar matéria' });
  if (!subject) return res.status(404).json({ error: 'Matéria não encontrada' });
  if (userInfo.role === 'diretor' && subject.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const { data: deletedSubject, error } = await supabase
    .from('school_subjects')
    .delete()
    .eq('id', req.params.id)
    .eq('school_id', subject.school_id)
    .select('id')
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Erro ao excluir matéria' });
  if (!deletedSubject) return res.status(404).json({ error: 'Matéria não encontrada para exclusão.' });
  res.json({ status: 'success' });
});

app.post('/api/school-subjects/:id/teachers', async (req, res) => {
  const userInfo = await requireSubjectManager(req, res);
  if (!userInfo) return;
  const teacherId = typeof req.body.teacherId === 'string' ? req.body.teacherId : '';
  if (!teacherId) return res.status(400).json({ error: 'Professor obrigatório' });

  const { data: subject, error: subjectError } = await supabase
    .from('school_subjects')
    .select('id,school_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (subjectError) return res.status(500).json({ error: 'Erro ao verificar matéria' });
  if (!subject) return res.status(404).json({ error: 'Matéria não encontrada' });
  if (userInfo.role === 'diretor' && !userInfo.school_id) {
    return res.status(403).json({ error: 'Sua conta não está associada a uma escola' });
  }
  if (userInfo.role === 'diretor' && subject.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const teacher = await getUserFromDB(teacherId);
  if (!teacher || teacher.role !== 'teacher' || teacher.school_id !== subject.school_id) {
    return res.status(400).json({ error: 'Selecione um professor da mesma escola' });
  }

  const { error } = await supabase.from('teacher_subjects').upsert(
    { teacher_id: teacherId, subject_id: subject.id },
    { onConflict: 'teacher_id,subject_id', ignoreDuplicates: true }
  );
  if (error) return res.status(500).json({ error: 'Erro ao vincular professor à matéria' });
  res.json({ status: 'success' });
});

app.delete('/api/school-subjects/:id/teachers/:teacherId', async (req, res) => {
  const userInfo = await requireSubjectManager(req, res);
  if (!userInfo) return;

  const { data: subject, error: subjectError } = await supabase
    .from('school_subjects')
    .select('id,school_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (subjectError) return res.status(500).json({ error: 'Erro ao verificar matéria' });
  if (!subject) return res.status(404).json({ error: 'Matéria não encontrada' });
  if (userInfo.role === 'diretor' && subject.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  const { error } = await supabase.from('teacher_subjects')
    .delete()
    .eq('subject_id', subject.id)
    .eq('teacher_id', req.params.teacherId);
  if (error) return res.status(500).json({ error: 'Erro ao desvincular professor da matéria' });
  res.json({ status: 'success' });
});

// School class-group catalog and teacher assignments
app.get('/api/school-class-groups', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor', 'teacher']);
  if (!userInfo) return;

  const requestedSchoolId = typeof req.query.schoolId === 'string' ? req.query.schoolId : undefined;
  if (userInfo.role === 'diretor' && !userInfo.school_id) {
    return res.status(403).json({ error: 'Sua conta não está associada a uma escola' });
  }
  if (userInfo.role === 'diretor' && requestedSchoolId && requestedSchoolId !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const schoolId = userInfo.role === 'diretor' ? userInfo.school_id : (requestedSchoolId || userInfo.school_id);
  let query = supabase
    .from('school_class_groups')
    .select('id,school_id,class_group')
    .order('class_group', { ascending: true });
  if (schoolId) query = query.eq('school_id', schoolId);
  const { data: groups, error } = await query;
  if (error) return res.status(500).json({ error: 'Erro ao buscar turmas da escola' });

  const groupNames = (groups || []).map(group => group.class_group);
  let assignments: any[] = [];
  if (schoolId && groupNames.length) {
    const { data: teacherAssignments, error: assignmentError } = await supabase
      .from('teacher_class_groups')
      .select('teacher_id,class_group')
      .eq('school_id', schoolId);
    if (assignmentError) return res.status(500).json({ error: 'Erro ao buscar professores das turmas' });
    assignments = teacherAssignments || [];
  }

  res.json((groups || []).map(group => ({
    id: group.id,
    school_id: group.school_id,
    classGroup: group.class_group,
    teacherIds: assignments
      .filter(item => String(item.class_group).toLocaleLowerCase() === String(group.class_group).toLocaleLowerCase())
      .map(item => item.teacher_id)
  })));
});

app.post('/api/school-class-groups', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;

  const classGroup = sanitizeString(req.body.classGroup);
  const requestedSchoolId = typeof req.body.schoolId === 'string' ? req.body.schoolId : undefined;
  const schoolId = userInfo.role === 'diretor' ? userInfo.school_id : requestedSchoolId;
  if (!schoolId || !classGroup) return res.status(400).json({ error: 'Escola e turma são obrigatórias' });

  const { data: existing, error: findError } = await supabase
    .from('school_class_groups')
    .select('id')
    .eq('school_id', schoolId)
    .ilike('class_group', classGroup)
    .maybeSingle();
  if (findError) return res.status(500).json({ error: 'Erro ao verificar turma' });
  if (existing) return res.status(409).json({ error: 'Essa turma já está cadastrada na escola' });

  const { data, error } = await supabase
    .from('school_class_groups')
    .insert({ school_id: schoolId, class_group: classGroup })
    .select('id,school_id,class_group')
    .single();
  if (error) return res.status(500).json({ error: `Erro ao cadastrar turma: ${error.message}` });
  res.json({ id: data.id, school_id: data.school_id, classGroup: data.class_group, teacherIds: [] });
});

app.delete('/api/school-class-groups/:id', async (req, res) => {
  const userInfo = await requireRole(req, res, ['dev', 'diretor']);
  if (!userInfo) return;

  const { data: group, error: findError } = await supabase
    .from('school_class_groups')
    .select('id,school_id,class_group')
    .eq('id', req.params.id)
    .maybeSingle();
  if (findError) return res.status(500).json({ error: 'Erro ao verificar turma' });
  if (!group) return res.status(404).json({ error: 'Turma não encontrada' });
  if (userInfo.role === 'diretor' && group.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  await supabase
    .from('teacher_class_groups')
    .delete()
    .eq('school_id', group.school_id)
    .ilike('class_group', group.class_group);
  const { error } = await supabase
    .from('school_class_groups')
    .delete()
    .eq('id', group.id);
  if (error) return res.status(500).json({ error: 'Erro ao excluir turma' });
  res.json({ status: 'success' });
});

app.post('/api/school-class-groups/:id/teachers', async (req, res) => {
  const userInfo = await requireSubjectManager(req, res);
  if (!userInfo) return;

  const teacherId = typeof req.body.teacherId === 'string' ? req.body.teacherId : '';
  const { data: group, error: groupError } = await supabase
    .from('school_class_groups')
    .select('id,school_id,class_group')
    .eq('id', req.params.id)
    .maybeSingle();
  if (groupError) return res.status(500).json({ error: 'Erro ao verificar turma' });
  if (!group) return res.status(404).json({ error: 'Turma não encontrada' });
  if (userInfo.role === 'diretor' && group.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  const teacher = await getUserFromDB(teacherId);
  if (!teacher || teacher.role !== 'teacher' || teacher.school_id !== group.school_id) {
    return res.status(400).json({ error: 'Selecione um professor da mesma escola' });
  }

  const { error } = await supabase.from('teacher_class_groups').upsert(
    { teacher_id: teacherId, school_id: group.school_id, class_group: group.class_group },
    { onConflict: 'school_id,teacher_id,class_group', ignoreDuplicates: true }
  );
  if (error) return res.status(500).json({ error: 'Erro ao vincular professor à turma' });
  res.json({ status: 'success', classGroup: group.class_group });
});

app.delete('/api/school-class-groups/:id/teachers/:teacherId', async (req, res) => {
  const userInfo = await requireSubjectManager(req, res);
  if (!userInfo) return;

  const { data: group, error: groupError } = await supabase
    .from('school_class_groups')
    .select('id,school_id,class_group')
    .eq('id', req.params.id)
    .maybeSingle();
  if (groupError) return res.status(500).json({ error: 'Erro ao verificar turma' });
  if (!group) return res.status(404).json({ error: 'Turma não encontrada' });
  if (userInfo.role === 'diretor' && group.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const { error } = await supabase
    .from('teacher_class_groups')
    .delete()
    .eq('school_id', group.school_id)
    .eq('teacher_id', req.params.teacherId)
    .ilike('class_group', group.class_group);
  if (error) return res.status(500).json({ error: 'Erro ao desvincular professor da turma' });
  res.json({ status: 'success' });
});

app.get('/api/teachers/:uid/class-groups', async (req, res) => {
  const userInfo = await validateUserPermission(req, res);
  if (!userInfo) return res.status(401).json({ error: 'Não autorizado' });
  if (userInfo.role === 'teacher' && req.params.uid !== userInfo.uid) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const teacher = await getUserFromDB(req.params.uid);
  if (!teacher || teacher.role !== 'teacher') {
    return res.status(404).json({ error: 'Professor não encontrado' });
  }
  if (userInfo.role === 'diretor' && teacher.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  if (!teacher.school_id) return res.json([]);

  const { data, error } = await supabase
    .from('teacher_class_groups')
    .select('id,school_id,teacher_id,class_group')
    .eq('teacher_id', req.params.uid)
    .eq('school_id', teacher.school_id)
    .order('class_group', { ascending: true });
  if (error) return res.status(500).json({ error: 'Erro ao buscar turmas do professor' });

  res.json((data || []).map(item => ({
    id: item.id,
    schoolId: item.school_id,
    teacherId: item.teacher_id,
    classGroup: item.class_group
  })));
});

app.post('/api/teachers/:uid/class-groups', async (req, res) => {
  const userInfo = await requireSubjectManager(req, res);
  if (!userInfo) return;

  const classGroup = sanitizeString(req.body.classGroup);
  if (!classGroup) return res.status(400).json({ error: 'Turma é obrigatória' });

  const teacher = await getUserFromDB(req.params.uid);
  if (!teacher?.school_id || teacher.role !== 'teacher') {
    return res.status(400).json({ error: 'Professor não está associado a uma escola' });
  }
  if (userInfo.role === 'diretor' && teacher.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const { error } = await supabase.from('teacher_class_groups').upsert(
    { teacher_id: req.params.uid, school_id: teacher.school_id, class_group: classGroup },
    { onConflict: 'school_id,teacher_id,class_group', ignoreDuplicates: true }
  );
  if (error) return res.status(500).json({ error: 'Erro ao vincular professor à turma' });
  res.json({ status: 'success', classGroup });
});

app.delete('/api/teachers/:uid/class-groups/:classGroup', async (req, res) => {
  const userInfo = await requireSubjectManager(req, res);
  if (!userInfo) return;

  const classGroup = sanitizeString(req.params.classGroup);
  if (!classGroup) return res.status(400).json({ error: 'Turma é obrigatória' });

  const teacher = await getUserFromDB(req.params.uid);
  if (!teacher?.school_id || teacher.role !== 'teacher') {
    return res.status(400).json({ error: 'Professor não está associado a uma escola' });
  }
  if (userInfo.role === 'diretor' && teacher.school_id !== userInfo.school_id) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const { data: assignments, error: findError } = await supabase
    .from('teacher_class_groups')
    .select('id,class_group')
    .eq('teacher_id', req.params.uid)
    .eq('school_id', teacher.school_id);
  if (findError) return res.status(500).json({ error: 'Erro ao verificar vínculo da turma' });

  const assignment = (assignments || []).find(
    item => String(item.class_group).toLocaleLowerCase() === classGroup.toLocaleLowerCase()
  );
  if (!assignment) return res.json({ status: 'success' });

  const { error } = await supabase
    .from('teacher_class_groups')
    .delete()
    .eq('id', assignment.id);
  if (error) return res.status(500).json({ error: 'Erro ao desvincular professor da turma' });
  res.json({ status: 'success' });
});

// Teacher subject endpoints retained for the teacher's "Minhas Matérias" view.
app.get('/api/teachers/:uid/subjects', async (req, res) => {
  const userInfo = await validateUserPermission(req, res);
  if (!userInfo) return res.status(401).json({ error: 'Não autorizado' });
  if (userInfo.role === 'teacher' && req.params.uid !== userInfo.uid) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  if (userInfo.role === 'diretor') {
    const teacher = await getUserFromDB(req.params.uid);
    if (!teacher || teacher.role !== 'teacher' || teacher.school_id !== userInfo.school_id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
  }
  if (!['teacher', 'diretor', 'dev'].includes(userInfo.role)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const { data: assignments, error: assignmentError } = await supabase
    .from('teacher_subjects')
    .select('subject_id')
    .eq('teacher_id', req.params.uid);

  if (assignmentError) return res.status(500).json({ error: 'Erro ao buscar matérias' });
  const subjectIds = (assignments || []).map(assignment => assignment.subject_id);
  if (subjectIds.length === 0) return res.json([]);
  const { data, error } = await supabase
    .from('school_subjects')
    .select('id,subject')
    .in('id', subjectIds)
    .order('subject', { ascending: true });
  if (error) return res.status(500).json({ error: 'Erro ao buscar matérias' });
  res.json(data);
});

app.post('/api/teachers/:uid/subjects', async (req, res) => {
  const userInfo = await requireSubjectManager(req, res);
  if (!userInfo) return;
  if (userInfo.role === 'diretor') {
    const teacher = await getUserFromDB(req.params.uid);
    if (!teacher || teacher.role !== 'teacher' || teacher.school_id !== userInfo.school_id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
  }

  const subject = sanitizeString(req.body.subject);

  if (!subject) {
    return res.status(400).json({ error: 'Matéria é obrigatória' });
  }

  const teacher = await getUserFromDB(req.params.uid);
  if (!teacher?.school_id) return res.status(400).json({ error: 'Professor não está associado a uma escola' });
  const { data: catalogSubject, error: subjectError } = await getOrCreateSchoolSubject(teacher.school_id, subject);
  if (subjectError || !catalogSubject) return res.status(500).json({ error: 'Erro ao cadastrar matéria da escola' });

  const { error } = await supabase.from('teacher_subjects').upsert(
    { teacher_id: req.params.uid, subject_id: catalogSubject.id },
    { onConflict: 'teacher_id,subject_id', ignoreDuplicates: true }
  );
  if (error) return res.status(500).json({ error: 'Erro ao vincular matéria ao professor' });
  res.json(catalogSubject);
});

app.delete('/api/teachers/:uid/subjects/:subject', async (req, res) => {
  const userInfo = await requireSubjectManager(req, res);
  if (!userInfo) return;
  if (userInfo.role === 'diretor') {
    const teacher = await getUserFromDB(req.params.uid);
    if (!teacher || teacher.role !== 'teacher' || teacher.school_id !== userInfo.school_id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
  }

  const teacher = await getUserFromDB(req.params.uid);
  if (!teacher?.school_id) return res.status(400).json({ error: 'Professor não está associado a uma escola' });
  const { data: catalogSubjects, error: findError } = await supabase
    .from('school_subjects')
    .select('id')
    .eq('school_id', teacher.school_id)
    .eq('subject', req.params.subject);
  if (findError) return res.status(500).json({ error: 'Erro ao buscar matéria' });
  const subjectIds = (catalogSubjects || []).map(subject => subject.id);
  if (subjectIds.length === 0) return res.json({ status: 'success' });
  const { error } = await supabase
    .from('teacher_subjects')
    .delete()
    .eq('teacher_id', req.params.uid)
    .in('subject_id', subjectIds);

  if (error) return res.status(500).json({ error: 'Erro ao deletar matéria' });
  res.json({ status: 'success' });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
    void logEvent({ level: 'info', category: 'system', message: 'Servidor iniciado' });
  });
}

startServer();
export default app;
