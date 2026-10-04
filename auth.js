const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('hex');
const fail = (message, status=400) => Object.assign(new Error(message), {status});
const publicUser = u => { const {password, ...safe}=u; return {...safe,firstName:u.first_name,lastName:u.last_name,dob:u.dob instanceof Date ? `${u.dob.getFullYear()}-${String(u.dob.getMonth()+1).padStart(2,"0")}-${String(u.dob.getDate()).padStart(2,"0")}` : (u.dob ? String(u.dob).slice(0,10) : "")}; };
const strong = value => typeof value === 'string' && value.length >= 8 && value.length <= 128 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^a-zA-Z0-9]/.test(value);

// PostgreSQL-backed state survives restarts and is shared across Cloud Run instances.
function postgresStore(db) {
  return {
    initialize: () => db.query('CREATE TABLE IF NOT EXISTS auth_state (account_key TEXT PRIMARY KEY, data JSONB NOT NULL); ALTER TABLE auth_state ENABLE ROW LEVEL SECURITY'),
    async transaction(key, work) {
      const client=await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);
        const {rows}=await client.query('SELECT data FROM auth_state WHERE account_key=$1',[key]);
        const state=rows[0]?.data || {};
        const result=await work(state,client);
        await client.query('INSERT INTO auth_state(account_key,data) VALUES($1,$2) ON CONFLICT(account_key) DO UPDATE SET data=EXCLUDED.data',[key,JSON.stringify(state)]);
        await client.query('COMMIT'); return result;
      } catch(error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
  };
}
function createAuth({store,findUser,compare,hash,send,updatePassword,now=Date.now}) {
  const email = value => String(value || '').trim().toLowerCase();
  const stateKey = async key => { const user = await findUser(key); return user ? `account:${user.id}` : `email:${key}`; };
  const enabled = user => user && user.is_active !== false && !['disabled','deleted','inactive'].includes(String(user.status || '').toLowerCase());
  const lock = state => { if(state.lockedUntil > now()) throw fail('Too many attempts. Try again in 15 minutes.',429); if(state.lockedUntil) {state.lockedUntil=0;state.failures=0;} };
  function badAttempt(state) { state.failures=(state.failures||0)+1; if(state.failures>=5) state.lockedUntil=now()+15*60*1000; }
  function token(state, user, purpose, ttl) {
    state.tokens=Object.fromEntries(Object.entries(state.tokens||{}).filter(([,v])=>v.expires>now()));
    const raw=`${user.id}.${random()}`;
    state.tokens[digest(raw)]={purpose,expires:now()+ttl};
    return raw;
  }
  async function issue(state,user,purpose) {
    lock(state);
    if(state.lastSent && now()-state.lastSent < 30000) throw fail('Please wait 30 seconds before requesting another code.',429);
    const id=random(), code=String(crypto.randomInt(100000,1000000));
    const codeHash=await hash(code);
    if(user) await send(user.email,code,purpose);
    state.challenge={id,codeHash,purpose,expires:now()+5*60*1000,userId:user?.id};state.lastSent=now();
    return {challengeId:id,expiresIn:300,message:'If the account is available, a verification code has been sent.'};
  }
  return {
    async login(body) {
      const key=email(body.email);if(!key || key.length>254 || typeof body.password!=='string' || !body.password || body.password.length>128) throw fail('Email and password are required.');
      return store.transaction(await stateKey(key),async (state,client)=>{
        lock(state);const user=await findUser(key,null,client);
        if(!enabled(user) || !(await compare(body.password,user.password))) {badAttempt(state);return {error:fail('Invalid email or password.',401)};}
        // Clinic login remains password-based; patient login requires email verification.
        if(['admin','staff','dentist'].includes(String(user.role).toLowerCase())) {
          state.failures=0;return {user:publicUser(user),token:token(state,user,'session',7*86400000)};
        }
        const challenge=await issue(state,user,'login');return {...challenge,user:publicUser(user)};
      }).then(r=>{if(r.error) throw r.error;return r;});
    },
    async request(body,actor) {
      const key=email(body.email), purpose=body.action || 'forgot_password';
      if(!/^\S+@\S+\.\S+$/.test(key)) throw fail('Enter a valid email address.');
      if(!['login','forgot_password','change_password'].includes(purpose)) throw fail('Invalid verification purpose.');
      return store.transaction(await stateKey(key),async (state,client)=>{
        lock(state);const user=await findUser(key,null,client);
        if(purpose==='login' && (!body.challengeId || state.challenge?.id!==body.challengeId || state.challenge?.purpose!=='login' || state.challenge.expires<now())) throw fail('Please sign in again.',401);
        if(purpose==='change_password' && (!actor || email(actor.email)!==key)) throw fail('Please sign in again.',401);
        return issue(state,enabled(user)?user:null,purpose);
      });
    },
    async verify(body) {
      const key=email(body.email);
      return store.transaction(await stateKey(key),async (state,client)=>{
        lock(state);const c=state.challenge;
        if(!c || c.id!==body.challengeId || c.expires<=now() || !/^\d{6}$/.test(String(body.code||'')) || !(await compare(String(body.code),c.codeHash))) {
          badAttempt(state);return {error:fail('Invalid or expired code. Request another code if needed.',400)};
        }
        const user=await findUser(key,null,client);
        if(!enabled(user) || user.id!==c.userId) return {error:fail('Invalid or expired code.',400)};
        delete state.challenge;state.failures=0;state.lockedUntil=0;
        const purpose=c.purpose==='login'?'session':c.purpose;
        const proof=token(state,user,purpose,purpose==='session'?7*86400000:10*60000);
        return purpose==='session'?{token:proof,user:publicUser(user)}:{verificationToken:proof};
      }).then(r=>{if(r.error)throw r.error;return r;});
    },
    async session(raw) {
      if(!/^\d+\.[a-f0-9]{64}$/.test(raw||'')) throw fail('Please sign in again.',401);
      const user=await findUser(null,raw.split('.')[0]);
      if(!enabled(user)) throw fail('Please sign in again.',401);
      return store.transaction(`account:${user.id}`,state=>{
        const entry=state.tokens?.[digest(raw)];
        if(!entry || entry.purpose!=='session' || entry.expires<=now()) throw fail('Your session expired. Please sign in again.',401);
        return publicUser(user);
      });
    },
    async reset(body,actor) {
      if(!strong(body.newPassword)) throw fail('Use 8-128 characters with uppercase, lowercase, number and symbol.');
      const key=email(body.email || actor?.email);
      return store.transaction(await stateKey(key),async (state,client)=>{
        const user=await findUser(key,null,client);if(!enabled(user)) throw fail('Verification required.',401);
        const proof=state.tokens?.[digest(String(body.verificationToken||''))];
        const changing=!!actor;
        if(changing && (String(actor.id)!==String(body.id) || !(await compare(body.oldPassword||'',user.password)))) throw fail('Incorrect current password.',401);
        // Clinic settings already require a signed session and current password. Patients also verify email.
        const clinic=changing && ['admin','staff','dentist'].includes(String(actor.role).toLowerCase());
        if(!clinic && (!proof || proof.expires<=now() || proof.purpose!==(changing?'change_password':'forgot_password'))) throw fail('Verification required. Request and verify a new code.',401);
        await updatePassword(user.id,await hash(body.newPassword),client);
        state.tokens={};delete state.challenge;
        const result={message:'Password updated successfully!'};
        if(changing) result.token=token(state,user,'session',7*86400000);
        return result;
      });
    }
  };
}
module.exports={createAuth,postgresStore,strong,publicUser};
