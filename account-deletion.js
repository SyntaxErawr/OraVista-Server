const fs = require('node:fs');
const path = require('node:path');

function profileObject(value, userId, storageUrl) {
  if (typeof value !== 'string' || !value) return null;
  let file = value;
  if (/^https?:/i.test(value)) {
    try {
      const url = new URL(value);
      if (!storageUrl || url.origin !== new URL(storageUrl).origin || !url.pathname.startsWith('/storage/v1/object/public/profile-photo/')) return null;
      file = url.pathname.slice('/storage/v1/object/public/profile-photo/'.length);
    } catch { return null; }
  } else if (value.startsWith('uploads/')) file = value.slice('uploads/'.length);
  const match = file.match(/^profile_(?:(\d+)_([a-f0-9]{24})|\d+)\.[a-z0-9]{1,10}$/i);
  if (!match || (match[1] && String(match[1]) !== String(userId))) return null;
  return file;
}

function createAccountDeletion({db, supabase, storageUrl, cleanupTimeoutMs = 5000}) {
  let timer, processing = false;
  async function initialize() {
    await db.query(fs.readFileSync(path.join(__dirname, 'migrations/20261128_account_deletion.sql'), 'utf8'));
  }
  async function eraseAppAccess(user, client) {
    // Read the current avatar under a row lock: an upload may have finished
    // after the session's user snapshot was read.
    const current = await client.query('SELECT profile_picture FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    const file = profileObject(current.rows[0]?.profile_picture, user.id, storageUrl);
    if (file) await client.query(
      "INSERT INTO account_deletion_cleanup(user_id,bucket,object_path) VALUES($1,'profile-photo',$2) ON CONFLICT(bucket,object_path) DO NOTHING", [user.id,file]
    );
    // The clinic chart and its identifiers remain available only through clinic
    // permissions. Erase app credentials/contact/avatar data, not the chart row.
    await client.query("SELECT set_config('oravista.actor', $1, true), set_config('oravista.action', 'DELETE /api/account', true)", [JSON.stringify({id:user.id,role:'patient',name:'Account holder'})]);
    const result = await client.query(
      `UPDATE users SET email=$2, password='', phone=NULL, occupation=NULL, profile_picture=NULL,
       status='Deleted', account_deleted_at=clock_timestamp()
       WHERE id=$1 AND LOWER(role)='patient' AND account_deleted_at IS NULL RETURNING id`,
      [user.id, `deleted+${user.id}@oravista.invalid`]
    );
    if (!result.rows.length) throw Object.assign(new Error('This account is no longer available.'), {status:401,code:'SESSION_EXPIRED'});
    await client.query('DELETE FROM notifications WHERE user_id=$1', [user.id]);
    await client.query('DELETE FROM auth_state WHERE account_key=$1', [`email:${String(user.email).trim().toLowerCase()}`]);
  }
  async function queueProfileCleanup(userId, file) {
    if (!profileObject(file,userId,storageUrl)) return;
    await db.query("INSERT INTO account_deletion_cleanup(user_id,bucket,object_path) VALUES($1,'profile-photo',$2) ON CONFLICT(bucket,object_path) DO NOTHING", [userId,file]);
  }
  async function saveProfile(userId, imagePath) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT profile_picture,account_deleted_at FROM users WHERE id=$1 FOR UPDATE', [userId]);
      if (!current.rows.length || current.rows[0].account_deleted_at) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('UPDATE users SET profile_picture = $1 WHERE id = $2 AND account_deleted_at IS NULL RETURNING id', [imagePath,userId]);
      const old = profileObject(current.rows[0].profile_picture,userId,storageUrl);
      if (old && old !== profileObject(imagePath,userId,storageUrl)) {
        await client.query("INSERT INTO account_deletion_cleanup(user_id,bucket,object_path) VALUES($1,'profile-photo',$2) ON CONFLICT(bucket,object_path) DO NOTHING", [userId,old]);
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async function processCleanup(userId = null) {
    if (processing) return;
    processing = true;
    try {
      const {rows} = await db.query(
        'SELECT * FROM account_deletion_cleanup WHERE next_attempt_at <= clock_timestamp() AND ($1::integer IS NULL OR user_id=$1) ORDER BY id LIMIT 2', [userId]
      );
      for (const job of rows) {
        try {
          if (job.bucket !== 'profile-photo' || !profileObject(job.object_path,job.user_id,storageUrl)) throw new Error('Invalid cleanup target');
          // Legacy avatars may be shared. Do not remove an image another
          // account still references, even if URL and relative paths differ.
          const references = await db.query(
            "SELECT id FROM users WHERE profile_picture IS NOT NULL AND regexp_replace(split_part(profile_picture,'?',1),'^.*/','')=$1 LIMIT 1", [job.object_path]
          );
          if (!references.rows.length) {
            if (!supabase) throw new Error('Storage unavailable');
            let timeout;
            try {
              const result = await Promise.race([
                supabase.storage.from('profile-photo').remove([job.object_path]),
                new Promise((_,reject) => {timeout=setTimeout(()=>reject(new Error('Cleanup timeout')),cleanupTimeoutMs);}),
              ]);
              if (result.error) throw new Error('Cleanup unavailable');
            } finally { clearTimeout(timeout); }
          }
          await db.query('DELETE FROM account_deletion_cleanup WHERE id=$1', [job.id]);
        } catch {
          await db.query("UPDATE account_deletion_cleanup SET attempts=attempts+1, next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [job.id]);
        }
      }
    } finally { processing = false; }
  }
  async function cleanupPending(userId) {
    const {rows} = await db.query('SELECT id FROM account_deletion_cleanup WHERE user_id=$1 LIMIT 1', [userId]);
    return rows.length > 0;
  }
  function startCleanup() {
    processCleanup().catch(()=>console.warn('Account photo cleanup will be retried.'));
    timer=setInterval(()=>processCleanup().catch(()=>console.warn('Account photo cleanup will be retried.')),60000);
    timer.unref();
  }
  return {initialize, eraseAppAccess, saveProfile, queueProfileCleanup, processCleanup, cleanupPending, startCleanup, stop:()=>clearInterval(timer)};
}
module.exports = {createAccountDeletion, profileObject};
