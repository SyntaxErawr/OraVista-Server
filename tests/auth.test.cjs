const test=require('node:test'),assert=require('node:assert/strict');
const {createAuth}=require('../auth');
const {accessControl}=require('../access-control');
function setup(role='patient') {
 let clock=1000000;const states=new Map(),mail=[];
 const user={id:7,email:'patient@example.test',password:'hash:OldPassword1!',role,first_name:'Test'};
 const store={transaction:async(key,fn)=>{const state=structuredClone(states.get(key)||{});const result=await fn(state,{});states.set(key,state);return result;}};
 const deps={store,findUser:async(email,id)=>(email===user.email || String(id)===String(user.id))?user:null,hash:async value=>'hash:'+value,compare:async(value,hash)=>'hash:'+value===hash,send:async(email,code,purpose)=>mail.push({email,code,purpose}),updatePassword:async(id,hash)=>{user.password=hash;},now:()=>clock};
 return {auth:createAuth(deps),deps,user,mail,advance:ms=>clock+=ms};
}
async function signed(f) {const c=await f.auth.login({email:f.user.email,password:'OldPassword1!'});return f.auth.verify({email:f.user.email,challengeId:c.challengeId,code:f.mail.at(-1).code});}
test('login requires password and returns an opaque challenge, never the code',async()=>{const f=setup();await assert.rejects(f.auth.login({email:f.user.email,password:'bad'}),/Invalid/);const c=await f.auth.login({email:f.user.email,password:'OldPassword1!'});assert.ok(c.challengeId);assert.equal(c.generatedOtp,undefined);assert.equal(c.token,undefined);assert.equal(c.user.password,undefined);});
test('valid code yields a session and replay is rejected',async()=>{const f=setup();const c=await f.auth.login({email:f.user.email,password:'OldPassword1!'});const payload={email:f.user.email,challengeId:c.challengeId,code:f.mail[0].code};const result=await f.auth.verify(payload);assert.equal((await f.auth.session(result.token)).id,7);await assert.rejects(f.auth.verify(payload),/Invalid/);});
test('five incorrect OTPs lock verification and resend for fifteen minutes',async()=>{const f=setup();const c=await f.auth.login({email:f.user.email,password:'OldPassword1!'});for(let i=0;i<5;i++)await assert.rejects(f.auth.verify({email:f.user.email,challengeId:c.challengeId,code:'000000'}));await assert.rejects(f.auth.verify({email:f.user.email,challengeId:c.challengeId,code:f.mail[0].code}),e=>e.status===429);await assert.rejects(f.auth.request({email:f.user.email,action:'forgot_password'}),e=>e.status===429);f.advance(15*60000+1);assert.ok((await f.auth.login({email:f.user.email,password:'OldPassword1!'})).challengeId);});
test('code expires after five minutes',async()=>{const f=setup();const c=await f.auth.login({email:f.user.email,password:'OldPassword1!'});f.advance(300001);await assert.rejects(f.auth.verify({email:f.user.email,challengeId:c.challengeId,code:f.mail[0].code}),/expired/);});
test('resend throttles and invalidates previous challenge',async()=>{const f=setup();const c=await f.auth.login({email:f.user.email,password:'OldPassword1!'});await assert.rejects(f.auth.request({email:f.user.email,action:'login',challengeId:c.challengeId}),e=>e.status===429);f.advance(30001);const next=await f.auth.request({email:f.user.email,action:'login',challengeId:c.challengeId});assert.notEqual(next.challengeId,c.challengeId);await assert.rejects(f.auth.verify({email:f.user.email,challengeId:c.challengeId,code:f.mail[0].code}));});
test('login code cannot be requested without a credential challenge',async()=>{const f=setup();await assert.rejects(f.auth.request({email:f.user.email,action:'login'}),e=>e.status===401);});
test('wrong password attempts are rate limited',async()=>{const f=setup();for(let i=0;i<5;i++)await assert.rejects(f.auth.login({email:f.user.email,password:'bad'}));await assert.rejects(f.auth.login({email:f.user.email,password:'OldPassword1!'}),e=>e.status===429);});
test('unknown recovery address returns generic challenge without sending email',async()=>{const f=setup();const c=await f.auth.request({email:'unknown@example.test',action:'forgot_password'});assert.ok(c.challengeId);assert.equal(f.mail.length,0);assert.match(c.message,/If the account/);});
test('password reset requires single-use recovery proof and revokes prior sessions',async()=>{const f=setup();const session=await signed(f);f.advance(30001);await assert.rejects(f.auth.reset({email:f.user.email,newPassword:'NewPassword1!'}),/Verification/);const c=await f.auth.request({email:f.user.email,action:'forgot_password'});const p=await f.auth.verify({email:f.user.email,challengeId:c.challengeId,code:f.mail.at(-1).code});await f.auth.reset({email:f.user.email,newPassword:'NewPassword1!',verificationToken:p.verificationToken});assert.equal(f.user.password,'hash:NewPassword1!');await assert.rejects(f.auth.session(session.token));await assert.rejects(f.auth.reset({email:f.user.email,newPassword:'OtherPassword1!',verificationToken:p.verificationToken}));});
test('recovery token cannot act as a login session and expires after ten minutes',async()=>{const f=setup();const c=await f.auth.request({email:f.user.email,action:'forgot_password'});const p=await f.auth.verify({email:f.user.email,challengeId:c.challengeId,code:f.mail[0].code});await assert.rejects(f.auth.session(p.verificationToken));f.advance(600001);await assert.rejects(f.auth.reset({email:f.user.email,newPassword:'NewPassword1!',verificationToken:p.verificationToken}));});
test('change password needs session, old password and purpose-bound proof',async()=>{const f=setup();await signed(f);f.advance(30001);await assert.rejects(f.auth.request({email:f.user.email,action:'change_password'}));const c=await f.auth.request({email:f.user.email,action:'change_password'},f.user);const p=await f.auth.verify({email:f.user.email,challengeId:c.challengeId,code:f.mail.at(-1).code});await assert.rejects(f.auth.reset({id:7,oldPassword:'bad',newPassword:'NewPassword1!',verificationToken:p.verificationToken},f.user));const result=await f.auth.reset({id:7,oldPassword:'OldPassword1!',newPassword:'NewPassword1!',verificationToken:p.verificationToken},f.user);assert.equal((await f.auth.session(result.token)).id,7);});
test('disabled accounts and fabricated tokens cannot authenticate',async()=>{const f=setup();f.user.is_active=false;await assert.rejects(f.auth.login({email:f.user.email,password:'OldPassword1!'}));await assert.rejects(f.auth.session('logged_in_token'));});
test('clinic login preserves password-based flow with a real session',async()=>{const f=setup('staff');const r=await f.auth.login({email:f.user.email,password:'OldPassword1!'});assert.ok(r.token);assert.equal((await f.auth.session(r.token)).role,'staff');});
test('mail failure produces no usable challenge',async()=>{const f=setup();const auth=createAuth({...f.deps,send:async()=>{throw Error('mail unavailable');}});await assert.rejects(auth.login({email:f.user.email,password:'OldPassword1!'}));await assert.rejects(auth.verify({email:f.user.email,challengeId:'invented',code:'123456'}));});
async function gate(path,{id=7,role='patient',body={},method='GET',query={},owner=7,token=true}={}) {
 let passed=false,status=200;
 const mw=accessControl({auth:{session:async()=>{if(!token)throw Object.assign(Error('sign in'),{status:401});return {id,email:'patient@example.test',role};}},db:{query:async()=>({rows:[{user_id:owner,status:'Confirmed'}]})}});
 await mw({path,method,body,query,get:()=>token?'Bearer fixture':''},{status:n=>{status=n;return {json:()=>{}};}},()=>{passed=true;});return {passed,status};
}
test('patient may read own records but not another patient',async()=>{assert.equal((await gate('/api/patient-records/7')).passed,true);assert.equal((await gate('/api/patient-records/8')).status,403);});
test('unauthenticated requests and patient clinic access are blocked',async()=>{assert.equal((await gate('/api/patient-records/7',{token:false})).status,401);assert.equal((await gate('/api/patients')).status,403);assert.equal((await gate('/api/patients',{role:'staff'})).passed,true);});
test('patient cannot change another appointment or confirm their own',async()=>{assert.equal((await gate('/api/update-appointment-status',{method:'PUT',body:{appointment_id:1,status:'Cancelled'},owner:8})).status,403);assert.equal((await gate('/api/update-appointment-status',{method:'PUT',body:{appointment_id:1,status:'Confirmed'}})).status,403);assert.equal((await gate('/api/update-appointment-status',{method:'PUT',body:{appointment_id:1,status:'Cancelled'}})).passed,true);});

test('sessions remain valid when the account email changes',async()=>{
 const f=setup();const session=await signed(f);f.user.email='updated@example.test';assert.equal((await f.auth.session(session.token)).email,'updated@example.test');
});
test('PostgreSQL store commits failed-attempt state and releases its client',async()=>{
 const {postgresStore}=require('../auth');const calls=[];
 const client={query:async(sql,args)=>{calls.push([sql,args]);return {rows:sql.startsWith('SELECT data')?[{data:{failures:3}}]:[]};},release:()=>calls.push(['release'])};
 const store=postgresStore({connect:async()=>client});
 await store.transaction('account:7',state=>{state.failures++;return {error:'invalid code'};});
 assert.ok(calls.some(([sql])=>sql.includes('pg_advisory_xact_lock')));
 assert.equal(JSON.parse(calls.find(([sql])=>sql.startsWith('INSERT'))[1][1]).failures,4);
 assert.deepEqual(calls.slice(-2).map(c=>c[0]),['COMMIT','release']);
});
test('PostgreSQL store rolls back exceptions and releases its client',async()=>{
 const {postgresStore}=require('../auth');const calls=[];
 const store=postgresStore({connect:async()=>({query:async sql=>{calls.push(sql);return {rows:[]};},release:()=>calls.push('release')})});
 await assert.rejects(store.transaction('account:7',()=>{throw Error('mail unavailable');}),/mail unavailable/);
 assert.ok(!calls.some(sql=>sql.startsWith('INSERT')));assert.deepEqual(calls.slice(-2),['ROLLBACK','release']);
});
