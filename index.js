import { Client } from 'discord.js-selfbot-v13';

const { USER_TOKEN, AFK_CHANNEL_ID, OWNER_ID } = process.env;
const SELF_MUTE = (process.env.SELF_MUTE ?? 'true') !== 'false'; // default: mute
const SELF_DEAF = (process.env.SELF_DEAF ?? 'false') === 'true'; // default: tidak deaf
const CHECK_MS = 30_000;

if (!USER_TOKEN) {
  console.error('USER_TOKEN belum diisi di Variables Railway.');
  process.exit(1);
}

const client = new Client();

// kondisi yang diinginkan (dipakai untuk join ulang otomatis)
const want = { channelId: null, watchUserId: null };
let conn = null;        // voice connection milik library selfbot
let streamConn = null;  // koneksi sebagai penonton stream
let busy = false;

process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

// ---------- util ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(message)), ms)),
  ]);
}

function isVoiceChannel(ch) {
  if (!ch) return false;
  if (typeof ch.isVoice === 'function') return ch.isVoice();
  return /VOICE|STAGE/.test(String(ch.type));
}

function voiceChannelIdOf(userId) {
  for (const g of client.guilds.cache.values()) {
    const id = g.voiceStates?.cache.get(userId)?.channelId;
    if (id) return id;
  }
  return null;
}

const myVoiceChannelId = () => voiceChannelIdOf(client.user.id);

function methodsOf(obj) {
  const names = new Set();
  for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const n of Object.getOwnPropertyNames(o)) if (!n.startsWith('_') && n !== 'constructor') names.add(n);
  }
  return [...names];
}

// ---------- voice ----------
async function joinVoice(channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.guildId || !isVoiceChannel(channel)) {
    throw new Error('Itu bukan voice channel server (atau akun ini tidak ada di servernya).');
  }

  const perms = channel.permissionsFor?.(client.user);
  console.log(
    `[join] ${channel.name} (${channel.id}) connect=${perms?.has('CONNECT')} userLimit=${channel.userLimit} mute=${SELF_MUTE} deaf=${SELF_DEAF}`,
  );
  if (perms && !perms.has('CONNECT')) throw new Error('Akun ini tidak punya permission Connect di channel itu.');

  conn = await withTimeout(
    client.voice.joinChannel(channel, { selfMute: SELF_MUTE, selfDeaf: SELF_DEAF, selfVideo: false }),
    20000,
    'Join voice timeout 20 detik (voice tidak tersambung).',
  );
  conn?.on?.('streamUpdate', (info) => console.log('[streamUpdate]', JSON.stringify(info)));
  console.log('[join] tersambung');
  return conn;
}

function stopWatching() {
  try { streamConn?.disconnect?.(); } catch {}
  try { streamConn?.destroy?.(); } catch {}
  streamConn = null;
  want.watchUserId = null;
}

async function leaveVoice() {
  want.channelId = null;
  stopWatching();
  try { client.voice?.connection?.disconnect?.(); } catch {}
  try { conn?.disconnect?.(); } catch {}
  conn = null;

  // cadangan: kalau masih tercatat di voice, putus lewat voice state
  const id = myVoiceChannelId();
  if (id) {
    const ch = client.channels.cache.get(id);
    try { await ch?.guild?.members?.me?.voice?.disconnect?.(); } catch {}
  }
}

async function startWatching(userId) {
  const chId = voiceChannelIdOf(userId);
  if (!chId) throw new Error('Orang itu tidak sedang di voice channel (di server yang sama dengan akun ini).');

  if (!conn || myVoiceChannelId() !== chId) await joinVoice(chId);
  want.channelId = chId;

  if (typeof conn?.joinStream !== 'function') {
    throw new Error(`Library versi ini tidak punya method joinStream. Kirim hasil \`,debug\` untuk melihat method yang tersedia.`);
  }

  stopWatching();
  const user = await client.users.fetch(userId);
  try {
    streamConn = await withTimeout(conn.joinStream(user), 20000, 'Join stream timeout 20 detik (orang itu mungkin tidak sedang Go Live).');
  } catch (e1) {
    console.error('[watch] joinStream(user) gagal:', e1.message, '-> coba dengan ID');
    streamConn = await withTimeout(conn.joinStream(userId), 20000, 'Join stream timeout 20 detik (orang itu mungkin tidak sedang Go Live).');
  }
  want.watchUserId = userId;
  console.log('[watch] menonton stream', userId);
}

// ---------- jaga tetap di voice (AFK 24/7) ----------
async function ensure() {
  if (busy || !want.channelId) return;
  if (myVoiceChannelId() === want.channelId) return;

  busy = true;
  try {
    console.log('[afk] tidak di voice, join ulang...');
    await joinVoice(want.channelId);
    if (want.watchUserId) {
      await startWatching(want.watchUserId).catch((e) => console.error('[afk] gagal nonton ulang:', e.message));
    }
  } catch (e) {
    console.error('[afk] join ulang gagal:', e.message);
  } finally {
    busy = false;
  }
}

setInterval(ensure, CHECK_MS);

client.on('voiceStateUpdate', (oldS, newS) => {
  if (newS.id !== client.user.id) return;
  console.log(`[voice-state] ${oldS.channelId} -> ${newS.channelId}`);
  if (want.channelId && newS.channelId !== want.channelId) setTimeout(ensure, 3000); // ditendang / dipindah
});

// ---------- command ----------
client.on('ready', async () => {
  console.log(`Login sebagai ${client.user.tag}`);
  if (AFK_CHANNEL_ID) {
    want.channelId = AFK_CHANNEL_ID;
    await sleep(2000); // beri waktu cache server terisi
    await ensure();
  }
});

client.on('messageCreate', async (msg) => {
  if (msg.channel.type !== 'DM') return;
  if (msg.author.id === client.user.id) return;
  if (OWNER_ID && msg.author.id !== OWNER_ID) return; // opsional: batasi ke satu orang

  const [rawCmd, ...rest] = msg.content.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ');

  const known = [',afk', ',watch', ',unwatch', ',leave', ',status', ',debug'];
  if (!known.includes(cmd)) return;
  console.log(`[cmd] ${msg.author.tag}: ${msg.content}`);

  try {
    switch (cmd) {
      case ',afk': {
        // ,afk <channelId>  | tanpa argumen = ikut channel tempat kamu berada
        const given = arg.match(/\d{15,20}/)?.[0];
        const channelId = given ?? voiceChannelIdOf(msg.author.id) ?? AFK_CHANNEL_ID;
        if (!channelId) {
          return msg.reply('Pakai: `,afk <channelId>`, atau masuk voice dulu lalu `,afk` (server harus sama dengan akun ini).');
        }
        stopWatching();
        want.channelId = channelId;
        await joinVoice(channelId);
        await msg.reply('😴 AFK di voice. Bot akan masuk lagi otomatis kalau terputus. `,leave` untuk keluar.');
        break;
      }

      case ',watch': {
        const userId = arg.match(/\d{15,20}/)?.[0];
        if (!userId) return msg.reply('Pakai: `,watch <ID user>` (orang itu harus sedang Go Live di voice).');
        await startWatching(userId);
        await msg.reply(`👀 Menonton stream <@${userId}>.`);
        break;
      }

      case ',unwatch':
        stopWatching();
        await msg.reply('👋 Berhenti menonton. Bot tetap di voice (`,leave` untuk keluar).');
        break;

      case ',leave':
        await leaveVoice();
        await msg.reply('👋 Keluar dari voice dan berhenti AFK.');
        break;

      case ',status': {
        const here = myVoiceChannelId();
        const ch = here ? client.channels.cache.get(here) : null;
        await msg.reply(
          [
            `Voice: ${ch ? `${ch.name} (${here})` : 'tidak di voice'}`,
            `Target AFK: ${want.channelId ?? '-'}`,
            `Menonton: ${want.watchUserId ? `<@${want.watchUserId}>` : '-'}`,
            `Mute: ${SELF_MUTE} | Deaf: ${SELF_DEAF}`,
          ].join('\n'),
        );
        break;
      }

      case ',debug': {
        if (!conn) return msg.reply('Belum ada voice connection. Jalankan `,afk` dulu.');
        const names = methodsOf(conn).join(', ');
        await msg.reply(`Method/properti voice connection:\n${names}`.slice(0, 1900));
        break;
      }
    }
  } catch (e) {
    console.error('[error]', e);
    msg.reply(`❌ ${e.message}`).catch(() => {});
  }
});

await client.login(USER_TOKEN);
