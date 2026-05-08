/* =========================================================
   MYSTERY TOWN RP — سيرفر لوحة الإدارة
   يقرأ رتبة المستخدم من ديسكورد تلقائياً
   ========================================================= */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const Sqlite3 = require('better-sqlite3');
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');

// ─── الإعدادات ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const BOT_TOKEN = process.env.BOT_TOKEN;

// خريطة معرفات الرتب → مستوى الصلاحية
const ROLE_MAP = {
  [process.env.ROLE_MANAGEMENT]:          'management',
  [process.env.ROLE_SUPERVISOR]:          'supervisor',
  [process.env.ROLE_ACTIVATION_MANAGER]:  'activation_manager',
  [process.env.ROLE_TECH_SUPPORT_MANAGER]:'support_manager',
  [process.env.ROLE_TICKETS_MANAGER]:     'tickets_manager',
  [process.env.ROLE_COMPLAINTS_MANAGER]:  'complaints_manager',
  [process.env.ROLE_ADMIN]:               'admin',
};

// ترتيب الأولوية (الأعلى يفوز)
const ROLE_PRIORITY = ['management','supervisor','activation_manager','support_manager','tickets_manager','complaints_manager','admin'];

// أسماء الرتب بالعربي
const ROLE_LABELS = {
  management:'مانجمنت', supervisor:'سوبرفايزر',
  activation_manager:'مسؤول التفعيل', support_manager:'مسؤول الدعم',
  tickets_manager:'مسؤول التيكتات', complaints_manager:'مسؤول الشكاوى',
  admin:'إداري'
};

const RANKS_LIST = ['Skilled','Trusted','Trial','Senior Mod','Mod','Trial Mod','Support','جديد'];
const DEPARTMENTS = ['التفعيل','الدعم الفني','التيكتات','الشكاوى'];
const ACTIVATION_DAYS = [0, 2, 4]; // أحد=0، ثلاثاء=2، خميس=4
const STAT_FIELDS = ['support','tickets','activation','monitoring','reports'];

// ─── قاعدة البيانات ─────────────────────────────────────
const db = new Sqlite3(path.join(__dirname, 'data', 'dashboard.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    nickname TEXT,
    avatar TEXT,
    role_level TEXT DEFAULT 'admin',
    discord_rank TEXT DEFAULT 'جديد',
    department TEXT,
    is_active INTEGER DEFAULT 1,
    join_date TEXT,
    promoted_by TEXT,
    promotion_date TEXT
  );

  CREATE TABLE IF NOT EXISTS weekly_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    week_start TEXT NOT NULL,
    field TEXT NOT NULL,
    value INTEGER DEFAULT 0,
    submitted_by TEXT,
    submitted_at TEXT,
    UNIQUE(user_id, week_start, field)
  );

  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    reason TEXT NOT NULL,
    given_by TEXT NOT NULL,
    given_by_name TEXT,
    department TEXT,
    created_at TEXT,
    status TEXT DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS attendance (
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    day TEXT NOT NULL,
    status TEXT,
    marked_by TEXT,
    marked_at TEXT,
    PRIMARY KEY(user_id, date)
  );

  CREATE TABLE IF NOT EXISTS activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    act_type TEXT DEFAULT 'normal',
    count INTEGER DEFAULT 1,
    points INTEGER DEFAULT 1,
    registered_by TEXT,
    registered_at TEXT
  );

  CREATE TABLE IF NOT EXISTS excuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    reviewed_by TEXT,
    reviewed_at TEXT,
    response TEXT,
    created_at TEXT,
    week_start TEXT
  );

  CREATE TABLE IF NOT EXISTS spottings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL,
    spotted_by TEXT NOT NULL,
    department TEXT,
    reason TEXT,
    proof TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    department TEXT,
    text TEXT,
    status TEXT DEFAULT 'pending',
    reply TEXT,
    replied_by TEXT,
    replied_at TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS rank_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    requested_rank TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    content TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    icon TEXT,
    color TEXT,
    actor TEXT,
    target TEXT,
    detail TEXT,
    department TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS deductions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value INTEGER,
    new_value INTEGER,
    reason TEXT,
    done_by TEXT,
    created_at TEXT
  );
`);

// ─── دوال مساعدة للداتا ─────────────────────────────────
function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  return monday.toISOString().split('T')[0];
}

function now() { return new Date().toISOString(); }

function getUserRole(req) {
  return req.session?.user?.role_level || null;
}

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'غير مسجل' });
  next();
}

function requireMinRole(...roles) {
  const minIdx = Math.min(...roles.map(r => ROLE_PRIORITY.indexOf(r)));
  return (req, res, next) => {
    const userRole = req.session?.user?.role_level;
    if (!userRole) return res.status(401).json({ error: 'غير مسجل' });
    const userIdx = ROLE_PRIORITY.indexOf(userRole);
    if (userIdx > minIdx) return res.status(403).json({ error: 'صلاحيات غير كافية' });
    next();
  };
}

function isHighEnough(userRole, requiredRole) {
  return ROLE_PRIORITY.indexOf(userRole) <= ROLE_PRIORITY.indexOf(requiredRole);
}

function addLog(type, icon, color, actor, target, detail, department) {
  db.prepare(`INSERT INTO logs (type,icon,color,actor,target,detail,department,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(type, icon, color, actor, target, detail, department, now());
}

function addAdminIfNotExists(userId, username, nickname, avatar, roleLevel, discordRank) {
  const existing = db.prepare('SELECT user_id FROM admins WHERE user_id = ?').get(userId);
  if (!existing) {
    db.prepare(`INSERT OR IGNORE INTO admins (user_id,username,nickname,avatar,role_level,discord_rank,join_date)
      VALUES (?,?,?,?,?,?,?)`).run(userId, username, nickname, avatar, roleLevel, discordRank || 'جديد', now());
  }
}

// ─── ديسكورد بوت (لإرسال الرسائل بالخاص) ──────────────
let bot = null;
let dmReady = false;

async function initBot() {
  if (!BOT_TOKEN) { console.log('[BOT] لا يوجد توكن — خاصية الرسائل معطلة'); return; }
  try {
    bot = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages]
    });
    bot.on('ready', () => { console.log(`[BOT] متصل: ${bot.user.tag}`); dmReady = true; });
    bot.on('error', e => console.error('[BOT] خطأ:', e.message));
    await bot.login(BOT_TOKEN);
  } catch (e) { console.error('[BOT] فشل الاتصال:', e.message); }
}

async function sendDM(userId, embedData) {
  if (!dmReady) { console.log('[DM] البوت غير متصل — تخطي إرسال لـ', userId); return false; }
  try {
    const user = await bot.users.fetch(userId);
    if (!user) return false;
    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setTitle(embedData.title || '')
      .setDescription(embedData.description || '')
      .setColor(embedData.color || 0xFF6B00)
      .setFooter({ text: 'Mystery Town RP — لوحة الإدارة' })
      .setTimestamp();
    if (embedData.fields) embedData.fields.forEach(f => embed.addFields(f));
    await user.send({ embeds: [embed] });
    return true;
  } catch (e) {
    console.log(`[DM] فشل إرسال لـ ${userId}: ${e.message}`);
    return false;
  }
}

// ─── Express ──────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 أيام
}));

// ─── OAuth2 Routes ───────────────────────────────────────

// الخطوة 1: توجيه المستخدم لديسكورد
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// الخطوة 2: كولباك — استبدال الكود بتوكن
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=no_code');

  try {
    // استبدال الكود بتوكن الوصول
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('لا يوجد access_token');

    // جلب بيانات المستخدم
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const discordUser = await userRes.json();

    // جلب عضوية السيرفر مع الرتب
    let memberRoles = [];
    let nickname = discordUser.username;
    let discordRank = 'جديد';
    let department = null;

    try {
      const memberRes = await fetch(
        `https://discord.com/api/guilds/${GUILD_ID}/members/${discordUser.id}`,
        { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
      );

      if (memberRes.ok) {
        const member = await memberRes.json();
        memberRoles = member.roles || [];
        nickname = member.nick || discordUser.username;

        // تحديد أعلى رتبة صلاحية
        let userRoleLevel = 'admin'; // افتراضي
        let bestPriority = ROLE_PRIORITY.length;

        for (const [roleId, roleLevel] of Object.entries(ROLE_MAP)) {
          if (memberRoles.includes(roleId)) {
            const priority = ROLE_PRIORITY.indexOf(roleLevel);
            if (priority < bestPriority) {
              bestPriority = priority;
              userRoleLevel = roleLevel;
            }
          }
        }

        // تحديد الرتبة الداخلية (Skilled, Mod, إلخ) من اسم الرتبة في ديسكورد
        if (member.roles) {
          for (const roleId of member.roles) {
            try {
              const roleRes = await fetch(
                `https://discord.com/api/guilds/${GUILD_ID}/roles/${roleId}`,
                { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
              );
              if (roleRes.ok) {
                const role = await roleRes.json();
                const roleName = role.name.trim();
                if (RANKS_LIST.includes(roleName)) {
                  discordRank = roleName;
                }
                if (roleName.includes('تفعيل')) department = 'التفعيل';
                else if (roleName.includes('دعم')) department = 'الدعم الفني';
                else if (roleName.includes('تيكت')) department = 'التيكتات';
                else if (roleName.includes('شكاي')) department = 'الشكاوى';
              }
            } catch (e) { /* تجاهل رتب غير موجودة */ }
          }
        }

        // حفظ/تحديث في الداتا
        addAdminIfNotExists(
          discordUser.id, discordUser.username, nickname,
          discordUser.avatar, userRoleLevel, discordRank
        );

        // تحديث الرتبة والصلاحية كل مرة يدخل
        db.prepare(`UPDATE admins SET role_level=?, discord_rank=?, nickname=?, avatar=?, department=? WHERE user_id=?`)
          .run(userRoleLevel, discordRank, nickname, discordUser.avatar, department, discordUser.id);

        // حفظ الجلسة
        req.session.user = {
          id: discordUser.id,
          username: discordUser.username,
          nickname: nickname,
          avatar: discordUser.avatar,
          role_level: userRoleLevel,
          role_label: ROLE_LABELS[userRoleLevel],
          discord_rank: discordRank,
          department: department,
          roles: memberRoles
        };

        console.log(`[AUTH] ${discordUser.username} دخول ← ${ROLE_LABELS[userRoleLevel]} (${discordRank})`);
      } else if (memberRes.status === 404) {
        // ليس عضواً في السيرفر
        return res.redirect('/?error=not_in_server');
      }
    } catch (e) {
      console.error('[AUTH] خطأ في جلب عضوية السيرفر:', e.message);
      // دخول كضيف
      req.session.user = {
        id: discordUser.id,
        username: discordUser.username,
        nickname: discordUser.username,
        avatar: discordUser.avatar,
        role_level: 'guest',
        role_label: 'ضيف',
        discord_rank: 'جديد',
        department: null,
        roles: []
      };
    }

    res.redirect('/');
  } catch (e) {
    console.error('[AUTH] خطأ في OAuth2:', e);
    res.redirect('/?error=auth_failed');
  }
});

// تسجيل الخروج
app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── API: بيانات المستخدم ────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session?.user) return res.json({ authenticated: false });
  const u = req.session.user;
  res.json({
    authenticated: true,
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    avatar: u.avatar,
    role_level: u.role_level,
    role_label: u.role_label,
    discord_rank: u.discord_rank,
    department: u.department,
    roles: u.roles
  });
});

// ─── API: الإداريين ──────────────────────────────────────
app.get('/api/admins', requireAuth, (req, res) => {
  const admins = db.prepare(`
    SELECT a.*,
      COALESCE((SELECT SUM(value) FROM weekly_stats ws WHERE ws.user_id = a.user_id AND ws.week_start = ?), 0) as total_stats
    FROM admins a WHERE a.is_active = 1
  `).all(getWeekStart());

  const enriched = admins.map(a => {
    const stats = {};
    STAT_FIELDS.forEach(f => {
      const row = db.prepare('SELECT value FROM weekly_stats WHERE user_id = ? AND week_start = ? AND field = ?')
        .get(a.user_id, getWeekStart(), f);
      stats[f] = row ? row.value : 0;
    });
    const posCount = db.prepare("SELECT COUNT(*) as c FROM records WHERE user_id = ? AND type = 'positive'").get(a.user_id)?.c || 0;
    const negCount = db.prepare("SELECT COUNT(*) as c FROM records WHERE user_id = ? AND type = 'negative'").get(a.user_id)?.c || 0;
    const excCount = db.prepare("SELECT COUNT(*) as c FROM excuses WHERE user_id = ? AND status = 'accepted'").get(a.user_id)?.c || 0;
    const drCount = db.prepare("SELECT COUNT(*) as c FROM daily_reports WHERE user_id = ? AND date = ?").get(a.user_id, new Date().toISOString().split('T')[0])?.c || 0;
    return { ...a, ws: stats, pos: posCount, neg: negCount, exc: excCount, dailyReports: drCount };
  });

  res.json(enriched);
});

app.post('/api/admins', requireAuth, requireMinRole('supervisor'), (req, res) => {
  const { user_id, username, nickname, rank, department } = req.body;
  if (!user_id || !username) return res.status(400).json({ error: 'بيانات ناقصة' });
  try {
    db.prepare(`INSERT OR REPLACE INTO admins (user_id,username,nickname,discord_rank,department,join_date,promoted_by)
      VALUES (?,?,?,?,?,?,?)`).run(user_id, username, nickname || username, rank || 'جديد', department, now(), req.session.user.id);
    addLog('rank', 'fa-user-plus', 'var(--g)', req.session.user.nickname, username, `تسجيل كـ ${rank || 'جديد'} في ${department}`, department);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admins/:id/rank', requireAuth, requireMinRole('supervisor'), (req, res) => {
  const { rank } = req.body;
  if (!rank) return res.status(400).json({ error: 'حدد الرتبة' });
  const admin = db.prepare('SELECT * FROM admins WHERE user_id = ?').get(req.params.id);
  if (!admin) return res.status(404).json({ error: 'غير موجود' });
  const oldRank = admin.discord_rank;
  db.prepare('UPDATE admins SET discord_rank = ?, promoted_by = ?, promotion_date = ? WHERE user_id = ?')
    .run(rank, req.session.user.id, now(), req.params.id);
  addLog('rank', 'fa-arrow-up', 'var(--g)', req.session.user.nickname, admin.nickname, `${oldRank} → ${rank}`, admin.department);
  // إرسال بالخاص
  sendDM(req.params.id, {
    title: 'تحديث الرتبة',
    description: `تم تغيير رتبتك من **${oldRank}** إلى **${rank}**`,
    color: 0x22C55E,
    fields: [{ name: 'بواسطة', value: req.session.user.nickname, inline: true }]
  });
  res.json({ success: true });
});

app.put('/api/admins/:id/status', requireAuth, requireMinRole('supervisor'), (req, res) => {
  const admin = db.prepare('SELECT * FROM admins WHERE user_id = ?').get(req.params.id);
  if (!admin) return res.status(404).json({ error: 'غير موجود' });
  const newStatus = admin.is_active ? 0 : 1;
  db.prepare('UPDATE admins SET is_active = ? WHERE user_id = ?').run(newStatus, req.params.id);
  addLog('del', 'fa-ban', 'var(--r)', req.session.user.nickname, admin.nickname, newStatus ? 'تفعيل حساب' : 'إيقاف حساب', admin.department);
  res.json({ success: true, active: newStatus });
});

// ─── API: الإحصائيات ─────────────────────────────────────
app.get('/api/stats', requireAuth, (req, res) => {
  const ws = getWeekStart();
  const rows = db.prepare('SELECT * FROM weekly_stats WHERE week_start = ?').all(ws);
  res.json({ week_start: ws, stats: rows });
});

app.put('/api/stats/:userId/:field', requireAuth, (req, res) => {
  const { value } = req.body;
  const { userId, field } = req.params;
  if (!STAT_FIELDS.includes(field)) return res.status(400).json({ error: 'حقل غير صالح' });
  const ws = getWeekStart();
  const existing = db.prepare('SELECT value FROM weekly_stats WHERE user_id = ? AND week_start = ? AND field = ?')
    .get(userId, ws, field);
  const oldValue = existing ? existing.value : 0;
  db.prepare(`INSERT INTO weekly_stats (user_id, week_start, field, value, submitted_by, submitted_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, week_start, field) DO UPDATE SET value = ?, submitted_by = ?, submitted_at = ?`)
    .run(userId, ws, field, value, req.session.user.id, now(), value, req.session.user.id, now());

  const admin = db.prepare('SELECT nickname FROM admins WHERE user_id = ?').get(userId);
  if (oldValue !== value) {
    addLog('stat', 'fa-plus', 'var(--or)', req.session.user.nickname, admin?.nickname || userId,
      `${field}: ${oldValue} → ${value}`, admin?.department);
  }
  res.json({ success: true, old_value: oldValue, new_value: value });
});

app.post('/api/stats/:userId/deduct', requireAuth, (req, res) => {
  const { field, value, reason } = req.body;
  const userId = req.params.userId;
  if (!STAT_FIELDS.includes(field)) return res.status(400).json({ error: 'حقل غير صالح' });
  const ws = getWeekStart();
  const existing = db.prepare('SELECT value FROM weekly_stats WHERE user_id = ? AND week_start = ? AND field = ?')
    .get(userId, ws, field);
  const oldValue = existing ? existing.value : 0;
  const newValue = Math.max(0, oldValue - (parseInt(value) || 0));

  db.prepare(`INSERT INTO weekly_stats (user_id, week_start, field, value, submitted_by, submitted_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, week_start, field) DO UPDATE SET value = ?, submitted_by = ?, submitted_at = ?`)
    .run(userId, ws, field, newValue, req.session.user.id, now(), newValue, req.session.user.id, now());

  db.prepare('INSERT INTO deductions (user_id, field, old_value, new_value, reason, done_by, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(userId, field, oldValue, newValue, reason, req.session.user.id, now());

  const admin = db.prepare('SELECT nickname, department FROM admins WHERE user_id = ?').get(userId);
  const fieldLabels = { support:'الدعم', tickets:'التيكتات', activation:'التفعيل', monitoring:'المراقبة', reports:'الريبورتات' };
  addLog('del', 'fa-minus', 'var(--r)', req.session.user.nickname, admin?.nickname || userId,
    `خصم ${fieldLabels[field]}: ${oldValue} → ${newValue} (${reason})`, admin?.department);

  res.json({ success: true, old_value: oldValue, new_value: newValue });
});

// ─── API: السلبيات والإيجابيات ──────────────────────────
app.get('/api/records', requireAuth, (req, res) => {
  const { type, user_id } = req.query;
  let q = 'SELECT r.*, a.nickname as target_name FROM records r LEFT JOIN admins a ON r.user_id = a.user_id WHERE 1=1';
  const params = [];
  if (type) { q += ' AND r.type = ?'; params.push(type); }
  if (user_id) { q += ' AND r.user_id = ?'; params.push(user_id); }
  q += ' ORDER BY r.created_at DESC LIMIT 100';
  res.json(db.prepare(q).all(...params));
});

app.post('/api/records', requireAuth, (req, res) => {
  const { user_id, type, reason, department } = req.body;
  if (!user_id || !type || !reason) return res.status(400).json({ error: 'بيانات ناقصة' });
  const id = db.prepare('INSERT INTO records (user_id, type, reason, given_by, given_by_name, department, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(user_id, type, reason, req.session.user.id, req.session.user.nickname, department, now()).lastInsertRowid;

  const admin = db.prepare('SELECT nickname FROM admins WHERE user_id = ?').get(user_id);
  const typeName = type === 'negative' ? 'سلبية' : 'إيجابية';
  const logColor = type === 'negative' ? 'var(--r)' : 'var(--g)';
  addLog(type, type === 'negative' ? 'fa-thumbs-down' : 'fa-thumbs-up', logColor,
    req.session.user.nickname, admin?.nickname || user_id, reason, department);

  // إرسال بالخاص
  sendDM(user_id, {
    title: `${typeName} جديدة`,
    description: reason,
    color: type === 'negative' ? 0xEF4444 : 0x22C55E,
    fields: [
      { name: 'من', value: req.session.user.nickname, inline: true },
      { name: 'المسؤولية', value: department || 'عام', inline: true }
    ]
  });

  res.json({ success: true, id });
});

// ─── API: التحضير ────────────────────────────────────────
app.get('/api/attendance', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const rows = db.prepare('SELECT * FROM attendance WHERE date = ?').all(today);
  res.json({ date: today, records: rows });
});

app.put('/api/attendance/:userId/:day', requireAuth, (req, res) => {
  const { status } = req.body;
  const { userId, day } = req.params;
  const today = new Date().toISOString().split('T')[0];
  db.prepare(`INSERT INTO attendance (user_id, date, day, status, marked_by, marked_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, date) DO UPDATE SET status = ?, marked_by = ?, marked_at = ?`)
    .run(userId, today, day, status, req.session.user.id, now(), status, req.session.user.id, now());

  const admin = db.prepare('SELECT nickname FROM admins WHERE user_id = ?').get(userId);
  const statusLabels = { present: 'حاضر', absent: 'غائب', excused: 'بعذر' };
  addLog('att', 'fa-check', status === 'present' ? 'var(--g)' : 'var(--r)',
    req.session.user.nickname, admin?.nickname || userId, `تحضير ${day}: ${statusLabels[status] || status}`, admin?.department);
  res.json({ success: true });
});

// ─── API: التفعيل ────────────────────────────────────────
app.get('/api/activations', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const rows = db.prepare(`SELECT a.*, ad.nickname as target_name FROM activations a
    LEFT JOIN admins ad ON a.user_id = ad.user_id WHERE date(a.registered_at) = ? ORDER BY a.registered_at DESC`).all(today);
  res.json(rows);
});

app.post('/api/activations', requireAuth, (req, res) => {
  // التحقق من يوم التفعيل
  const dayOfWeek = new Date().getDay();
  if (!ACTIVATION_DAYS.includes(dayOfWeek)) {
    return res.status(403).json({
      error: 'التفعيل متاح فقط أيام الأحد والثلاثاء والخميس',
      activation_days: ['الأحد', 'الثلاثاء', 'الخميس']
    });
  }

  const { user_id, act_type, count } = req.body;
  if (!user_id) return res.status(400).json({ error: 'حدد الإداري' });
  const ct = Math.max(1, parseInt(count) || 1);
  const points = (act_type === 'instant' ? 2 : 1) * ct;

  db.prepare('INSERT INTO activations (user_id, act_type, count, points, registered_by, registered_at) VALUES (?,?,?,?,?,?)')
    .run(user_id, act_type || 'normal', ct, points, req.session.user.id, now());

  const admin = db.prepare('SELECT nickname FROM admins WHERE user_id = ?').get(user_id);
  const typeLabel = act_type === 'instant' ? 'فوري' : 'عادي';
  addLog('act', 'fa-bolt', 'var(--or)', req.session.user.nickname, admin?.nickname || user_id,
    `تفعيل ${typeLabel} × ${ct} (${points} نقطة)`, 'التفعيل');

  res.json({ success: true, points });
});

// ─── API: الأعذار ────────────────────────────────────────
app.get('/api/excuses', requireAuth, (req, res) => {
  const { status, user_id } = req.query;
  let q = 'SELECT e.*, a.nickname FROM excuses e LEFT JOIN admins a ON e.user_id = a.user_id WHERE 1=1';
  const params = [];
  if (status) { q += ' AND e.status = ?'; params.push(status); }
  if (user_id) { q += ' AND e.user_id = ?'; params.push(user_id); }
  q += ' ORDER BY e.created_at DESC';
  res.json(db.prepare(q).all(...params));
});

app.post('/api/excuses', requireAuth, (req, res) => {
  const { user_id, reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'اكتب السبب' });
  const id = db.prepare('INSERT INTO excuses (user_id, reason, created_at, week_start) VALUES (?,?,?,?)')
    .run(user_id || req.session.user.id, reason, now(), getWeekStart()).lastInsertRowid;
  const name = req.session.user.nickname;
  addLog('exc', 'fa-file-alt', 'var(--y)', name, name, 'قدّم عذر', '');
  res.json({ success: true, id });
});

app.put('/api/excuses/:id/review', requireAuth, (req, res) => {
  const { status, response } = req.body;
  if (!['accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'حالة غير صالحة' });
  const exc = db.prepare('SELECT e.*, a.nickname, a.user_id FROM excuses e LEFT JOIN admins a ON e.user_id = a.user_id WHERE e.id = ?').get(req.params.id);
  if (!exc) return res.status(404).json({ error: 'غير موجود' });

  const respText = status === 'accepted'
    ? (response || 'تم قبول عذرك — سيُسجل كغياب بدون عذر حسب السياسة')
    : (response || 'تم رفض عذرك — سيُسجل غياب بدون عذر');

  db.prepare('UPDATE excuses SET status = ?, reviewed_by = ?, reviewed_at = ?, response = ? WHERE id = ?')
    .run(status, req.session.user.id, now(), respText, req.params.id);

  addLog('exc', 'fa-file-alt', status === 'accepted' ? 'var(--g)' : 'var(--r)',
    req.session.user.nickname, exc.nickname, `${status === 'accepted' ? 'قبول' : 'رفض'} عذر`, '');

  // إرسال بالخاص
  sendDM(exc.user_id, {
    title: status === 'accepted' ? 'تم قبول عذرك' : 'تم رفض عذرك',
    description: respText,
    color: status === 'accepted' ? 0x22C55E : 0xEF4444,
    fields: [{ name: 'بواسطة', value: req.session.user.nickname, inline: true }]
  });

  res.json({ success: true });
});

// ─── API: الرصد ──────────────────────────────────────────
app.get('/api/spottings', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT s.*, a.nickname as target_name FROM spottings s
    LEFT JOIN admins a ON s.target_id = a.user_id ORDER BY s.created_at DESC LIMIT 50`).all());
});

app.post('/api/spottings', requireAuth, (req, res) => {
  const { target_id, department, reason, proof } = req.body;
  if (!target_id || !reason) return res.status(400).json({ error: 'بيانات ناقصة' });
  db.prepare('INSERT INTO spottings (target_id, spotted_by, department, reason, proof, created_at) VALUES (?,?,?,?,?,?)')
    .run(target_id, req.session.user.id, department, reason, proof, now());

  const admin = db.prepare('SELECT nickname FROM admins WHERE user_id = ?').get(target_id);
  addLog('spot', 'fa-eye', 'var(--y)', req.session.user.nickname, admin?.nickname || target_id,
    `${reason}${proof ? ' [دليل مرفق]' : ''}`, department);

  res.json({ success: true });
});

// ─── API: الاستفسارات ────────────────────────────────────
app.get('/api/inquiries', requireAuth, (req, res) => {
  const { status, user_id } = req.query;
  let q = 'SELECT i.*, a.nickname FROM inquiries i LEFT JOIN admins a ON i.user_id = a.user_id WHERE 1=1';
  const params = [];
  if (status) { q += ' AND i.status = ?'; params.push(status); }
  if (user_id) { q += ' AND i.user_id = ?'; params.push(user_id); }
  q += ' ORDER BY i.created_at DESC';
  res.json(db.prepare(q).all(...params));
});

app.post('/api/inquiries', requireAuth, (req, res) => {
  const { user_id, department, text } = req.body;
  if (!text) return res.status(400).json({ error: 'اكتب الاستفسار' });
  const id = db.prepare('INSERT INTO inquiries (user_id, department, text, created_at) VALUES (?,?,?,?)')
    .run(user_id || req.session.user.id, department, text, now()).lastInsertRowid;

  const admin = db.prepare('SELECT nickname FROM admins WHERE user_id = ?').get(user_id || req.session.user.id);
  addLog('inq', 'fa-comments', 'var(--b)', admin?.nickname || req.session.user.nickname, 'مسؤول ' + department, text, department);

  res.json({ success: true, id });
});

app.put('/api/inquiries/:id/reply', requireAuth, (req, res) => {
  const { reply } = req.body;
  if (!reply) return res.status(400).json({ error: 'اكتب الرد' });
  const inq = db.prepare('SELECT i.*, a.nickname, a.user_id FROM inquiries i LEFT JOIN admins a ON i.user_id = a.user_id WHERE i.id = ?').get(req.params.id);
  if (!inq) return res.status(404).json({ error: 'غير موجود' });

  db.prepare('UPDATE inquiries SET status = ?, reply = ?, replied_by = ?, replied_at = ? WHERE id = ?')
    .run('replied', reply, req.session.user.id, now(), req.params.id);

  addLog('inq', 'fa-reply', 'var(--g)', req.session.user.nickname, inq.nickname, 'رد على استفسار', inq.department);

  // إرسال بالخاص
  sendDM(inq.user_id, {
    title: 'رد على استفسارك',
    description: reply,
    color: 0x22C55E,
    fields: [
      { name: 'المسؤول', value: req.session.user.nickname, inline: true },
      { name: 'المسؤولية', value: inq.department || 'عام', inline: true }
    ]
  });

  res.json({ success: true });
});

// ─── API: طلبات الرتب ───────────────────────────────────
app.get('/api/rank-requests', requireAuth, (req, res) => {
  const { status, user_id } = req.query;
  let q = 'SELECT r.*, a.nickname FROM rank_requests r LEFT JOIN admins a ON r.user_id = a.user_id WHERE 1=1';
  const params = [];
  if (status) { q += ' AND r.status = ?'; params.push(status); }
  if (user_id) { q += ' AND r.user_id = ?'; params.push(user_id); }
  q += ' ORDER BY r.created_at DESC';
  res.json(db.prepare(q).all(...params));
});

app.post('/api/rank-requests', requireAuth, (req, res) => {
  const { requested_rank, reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'اكتب السبب' });
  const id = db.prepare('INSERT INTO rank_requests (user_id, requested_rank, reason, created_at) VALUES (?,?,?,?)')
    .run(req.session.user.id, requested_rank, reason, now()).lastInsertRowid;
  addLog('rank', 'fa-hand-paper', 'var(--p)', req.session.user.nickname, '—', `طلب رتبة ${requested_rank}`, '');
  res.json({ success: true, id });
});

app.put('/api/rank-requests/:id/review', requireAuth, requireMinRole('supervisor'), (req, res) => {
  const { status } = req.body;
  if (!['accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'حالة غير صالحة' });
  const rrq = db.prepare('SELECT r.*, a.nickname, a.user_id FROM rank_requests r LEFT JOIN admins a ON r.user_id = a.user_id WHERE r.id = ?').get(req.params.id);
  if (!rrq) return res.status(404).json({ error: 'غير موجود' });

  db.prepare('UPDATE rank_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
    .run(status, req.session.user.id, now(), req.params.id);

  if (status === 'accepted') {
    db.prepare('UPDATE admins SET discord_rank = ?, promoted_by = ?, promotion_date = ? WHERE user_id = ?')
      .run(rrq.requested_rank, req.session.user.id, now(), rrq.user_id);
  }

  addLog('rank', 'fa-arrow-up', status === 'accepted' ? 'var(--g)' : 'var(--r)',
    req.session.user.nickname, rrq.nickname, `${status === 'accepted' ? 'قبول' : 'رفض'} طلب رتبة ${rrq.requested_rank}`, '');

  // إرسال بالخاص
  sendDM(rrq.user_id, {
    title: status === 'accepted' ? 'تم قبول طلب رتبتك' : 'تم رفض طلب رتبتك',
    description: status === 'accepted'
      ? `مبروك! تم ترقيتك إلى **${rrq.requested_rank}**`
      : `تم رفض طلبك للرتبة ${rrq.requested_rank}`,
    color: status === 'accepted' ? 0x22C55E : 0xEF4444,
    fields: [{ name: 'بواسطة', value: req.session.user.nickname, inline: true }]
  });

  res.json({ success: true });
});

// ─── API: التقارير اليومية ──────────────────────────────
app.get('/api/daily-reports', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json(db.prepare(`SELECT d.*, a.nickname FROM daily_reports d LEFT JOIN admins a ON d.user_id = a.user_id WHERE d.date = ? ORDER BY d.created_at DESC`).all(today));
});

app.post('/api/daily-reports', requireAuth, (req, res) => {
  const { user_id, content } = req.body;
  if (!content) return res.status(400).json({ error: 'اكتب التقرير' });
  const today = new Date().toISOString().split('T')[0];
  const uid = user_id || req.session.user.id;
  db.prepare('INSERT INTO daily_reports (user_id, date, content, created_at) VALUES (?,?,?,?)')
    .run(uid, today, content, now());
  const admin = db.prepare('SELECT nickname FROM admins WHERE user_id = ?').get(uid);
  addLog('dr', 'fa-file-lines', 'var(--p)', admin?.nickname || req.session.user.nickname, '—', 'تقرير يومي', admin?.department);
  res.json({ success: true });
});

// ─── API: اللوقات ────────────────────────────────────────
app.get('/api/logs', requireAuth, (req, res) => {
  const { type, limit } = req.query;
  let q = 'SELECT * FROM logs WHERE 1=1';
  const params = [];
  if (type) { q += ' AND type = ?'; params.push(type); }
  q += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit) || 200);
  res.json(db.prepare(q).all(...params));
});

// ─── API: الخصومات ───────────────────────────────────────
app.get('/api/deductions', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT d.*, a.nickname FROM deductions d LEFT JOIN admins a ON d.user_id = a.user_id ORDER BY d.created_at DESC LIMIT 100`).all());
});

// ─── API: المهملين ───────────────────────────────────────
app.get('/api/negligence', requireAuth, requireMinRole('supervisor'), (req, res) => {
  const ws = getWeekStart();
  const threeWeeksAgo = new Date(new Date(ws) - 21 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const admins = db.prepare('SELECT user_id, nickname, discord_rank, department FROM admins WHERE is_active = 1').all();
  const negligent = [];
  for (const a of admins) {
    const total = db.prepare('SELECT COALESCE(SUM(value), 0) as t FROM weekly_stats WHERE user_id = ? AND week_start >= ?')
      .get(a.user_id, threeWeeksAgo)?.t || 0;
    if (total < 30) negligent.push({ ...a, total_stats: total });
  }
  negligent.sort((a, b) => a.total_stats - b.total_stats);
  res.json(negligent);
});

// ─── API: لوحة التحكم (إحصائيات عامة) ──────────────────
app.get('/api/dashboard', requireAuth, (req, res) => {
  const ws = getWeekStart();
  const totalAdmins = db.prepare('SELECT COUNT(*) as c FROM admins WHERE is_active = 1').get().c;
  const totalPos = db.prepare("SELECT COUNT(*) as c FROM records WHERE type = 'positive'").get().c;
  const totalNeg = db.prepare("SELECT COUNT(*) as c FROM records WHERE type = 'negative'").get().c;
  const pendingExc = db.prepare("SELECT COUNT(*) as c FROM excuses WHERE status = 'pending'").get().c;
  const pendingRrq = db.prepare("SELECT COUNT(*) as c FROM rank_requests WHERE status = 'pending'").get().c;
  const pendingInq = db.prepare("SELECT COUNT(*) as c FROM inquiries WHERE status = 'pending'").get().c;
  const isActDay = ACTIVATION_DAYS.includes(new Date().getDay());
  const today = new Date().toISOString().split('T')[0];
  const drSubmitted = db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM daily_reports WHERE date = ?').get(today)?.c || 0;

  // إحصائيات الأقسام
  const deptStats = {};
  DEPARTMENTS.forEach(d => {
    // مبدئي — نجمع من الرتب فقط
    deptStats[d] = db.prepare('SELECT COALESCE(SUM(value), 0) as t FROM weekly_stats WHERE week_start = ?').get(ws)?.t || 0;
  });

  res.json({
    total_admins: totalAdmins,
    total_positives: totalPos,
    total_negatives: totalNeg,
    pending_excuses: pendingExc,
    pending_rank_requests: pendingRrq,
    pending_inquiries: pendingInq,
    is_activation_day: isActDay,
    activation_days: ['الأحد', 'الثلاثاء', 'الخميس'],
    daily_reports_submitted: drSubmitted,
    dept_stats: deptStats
  });
});

// ─── إرسال التقارير الأسبوعية ───────────────────────────
app.post('/api/weekly-send', requireAuth, requireMinRole('supervisor'), async (req, res) => {
  const ws = getWeekStart();
  const admins = db.prepare('SELECT * FROM admins WHERE is_active = 1').all();
  let sent = 0;

  for (const admin of admins) {
    const stats = {};
    STAT_FIELDS.forEach(f => {
      const row = db.prepare('SELECT value FROM weekly_stats WHERE user_id = ? AND week_start = ? AND field = ?')
        .get(admin.user_id, ws, f);
      stats[f] = row ? row.value : 0;
    });
    const total = Object.values(stats).reduce((s, v) => s + v, 0);

    const fieldLabels = { support: 'الدعم الفني', tickets: 'التيكتات', activation: 'التفعيل', monitoring: 'المراقبة', reports: 'الريبورتات' };
    const fields = Object.entries(stats).map(([k, v]) => ({ name: fieldLabels[k], value: String(v), inline: true }));
    fields.push({ name: 'الإجمالي', value: String(total), inline: true });

    const ok = await sendDM(admin.user_id, {
      title: 'إحصائياتك الأسبوعية',
      description: `الأسبوع: ${ws}`,
      color: 0xFF6B00,
      fields
    });
    if (ok) sent++;
  }

  addLog('stat', 'fa-paper-plane', 'var(--or)', req.session.user.nickname, 'الجميع',
    `إرسال التقارير لـ ${sent} إداري`, 'عام');
  res.json({ success: true, sent });
});

// ─── الصفحة الرئيسية ────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── تشغيل ───────────────────────────────────────────────
async function start() {
  console.log('========================================');
  console.log('  MYSTERY TOWN RP — لوحة الإدارة');
  console.log('========================================');

  // تشغيل البوت
  await initBot();

  // تشغيل السيرفر
  app.listen(PORT, () => {
    console.log(`[SERVER] يعمل على http://localhost:${PORT}`);
    console.log(`[SERVER] OAuth2 callback: ${REDIRECT_URI}`);
    console.log(`[SERVER] Guild ID: ${GUILD_ID}`);
    console.log('========================================');
  });
}

start().catch(e => { console.error('فشل التشغيل:', e); process.exit(1); });