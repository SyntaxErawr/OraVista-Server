const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {PGlite} = require('@electric-sql/pglite');
const {createAccountDeletion,profileObject} = require('../account-deletion');
const {createAuth,postgresStore} = require('../auth');

const storageUrl='https://storage.example.test';
const photo='profile_7_'+'a'.repeat(24)+'.jpg';
const token='7.'+'b'.repeat(64);
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

test('photo cleanup accepts only controlled profile objects belonging to the patient',()=>{
  assert.equal(profileObject('uploads/'+photo,7,storageUrl),photo);
  assert.equal(profileObject(storageUrl+'/storage/v1/object/public/profile-photo/'+photo,7,storageUrl),photo);
  assert.equal(profileObject('uploads/profile_1733000000000.png',7,storageUrl),'profile_1733000000000.png');
  for(const value of ['uploads/../patient.pdf','uploads/profile_8_'+'a'.repeat(24)+'.jpg',
    'https://evil.test/storage/v1/object/public/profile-photo/'+photo,
    storageUrl+'/storage/v1/object/public/patient-records/'+photo, 'uploads/unrelated.jpg']) {
    assert.equal(profileObject(value,7,storageUrl),null,value);
  }
});

test('PostgreSQL deletion preserves clinic history, rolls back failures, redacts its audit and retries photo cleanup',async t=>{
  // Explicit local artifacts also work when the checkout's Windows path has spaces.
  const dir=path.dirname(require.resolve('@electric-sql/pglite'));
  const [pgliteWasmModule,initdbWasmModule]=await Promise.all([
    WebAssembly.compile(fs.readFileSync(path.join(dir,'pglite.wasm'))),
    WebAssembly.compile(fs.readFileSync(path.join(dir,'initdb.wasm'))),
  ]);
  const engine=new PGlite({pgliteWasmModule,initdbWasmModule,fsBundle:new Blob([fs.readFileSync(path.join(dir,'pglite.data'))])});
  t.after(()=>engine.close());
  const query=async(sql,params)=>params?.length?engine.query(sql,params):(await engine.exec(sql)).at(-1);
  const db={query,connect:async()=>({query,release(){}})};
  await engine.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,
      role TEXT NOT NULL,first_name TEXT,last_name TEXT,sex TEXT,dob DATE,phone TEXT,occupation TEXT,
      status TEXT,branch TEXT,profile_picture TEXT,medical_history JSONB);
    CREATE TABLE appointments(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      status TEXT,amount NUMERIC,billing_status TEXT,receipt_details JSONB);
    CREATE TABLE patient_records(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,file_name TEXT);
    CREATE TABLE notifications(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),message TEXT);
  `);
  const store=postgresStore(db);await store.initialize();
  await engine.exec(fs.readFileSync(path.join(__dirname,'../migrations/20261008_transaction_audit.sql'),'utf8'));
  const removed=[];let storageMode='error';
  const service=createAccountDeletion({db,storageUrl,cleanupTimeoutMs:10,supabase:{storage:{from:bucket=>({remove:async files=>{
    assert.equal(bucket,'profile-photo');removed.push(files);
    if(storageMode==='timeout')return new Promise(()=>{});
    return {error:storageMode==='error'?{message:'provider details must remain private'}:null};
  }})}}});
  await service.initialize();await service.initialize();
  await engine.query(`INSERT INTO users(id,email,password,role,first_name,last_name,sex,dob,phone,occupation,status,branch,profile_picture,medical_history)
    VALUES(7,'patient@example.test','hash:OldPassword1!','patient','Patient','Example','Female','2000-01-01','09000000000','Student','Available','Clinic',$1,'{"allergies":"Retain"}')`,['uploads/'+photo]);
  await engine.exec(`INSERT INTO appointments VALUES(10,7,'Confirmed',1000,'Approved','{"paid":250,"balance":750}');
    INSERT INTO patient_records VALUES(20,7,'Retained clinical record.pdf');
    INSERT INTO notifications VALUES(30,7,'App notification');
    INSERT INTO payment_events(appointment_id,patient_name,amount,method,collector_id) VALUES(10,'Patient Example',250,'Cash','5');
    INSERT INTO auth_state VALUES('email:patient@example.test','{"challenge":{"id":"old"}}');`);
  await engine.query('INSERT INTO auth_state VALUES($1,$2)',['account:7',JSON.stringify({tokens:{[digest(token)]:{purpose:'session',expires:Date.now()+600000}},challenge:{id:'pending'}})]);
  const before=(await engine.query('SELECT * FROM users WHERE id=7')).rows[0];
  const medical=(await engine.query('SELECT * FROM patient_records')).rows;
  const visits=(await engine.query('SELECT * FROM appointments')).rows;
  const payments=(await engine.query('SELECT * FROM payment_events')).rows;

  await t.test('replacement photos are queued and deletion reads the latest avatar rather than a stale session snapshot',async()=>{
    const old='profile_9_'+'c'.repeat(24)+'.jpg',next='profile_9_'+'d'.repeat(24)+'.jpg';
    await engine.query("INSERT INTO users(id,email,password,role,profile_picture) VALUES(9,'other@example.test','hash:test','patient',$1)",['uploads/'+old]);
    assert.equal(await service.saveProfile(9,'uploads/'+next),true);
    assert.equal((await engine.query('SELECT profile_picture FROM users WHERE id=9')).rows[0].profile_picture,'uploads/'+next);
    assert.equal((await engine.query('SELECT object_path FROM account_deletion_cleanup WHERE user_id=9')).rows[0].object_path,old);
    storageMode='success';await service.processCleanup(9);assert.deepEqual(removed,[[old]]);removed.length=0;storageMode='error';
    await assert.rejects(store.transaction('account:7',async(state,client)=>{
      await service.eraseAppAccess({...before,profile_picture:'uploads/profile_1733000000000.png'},client);
      assert.equal((await client.query('SELECT object_path FROM account_deletion_cleanup WHERE user_id=7')).rows[0].object_path,photo);
      throw Error('rollback race fixture');
    }),/rollback race fixture/);
  });

  await t.test('a failure after erasure rolls back account, notifications, auth state, audit and cleanup jobs',async()=>{
    const count=(await engine.query('SELECT COUNT(*)::integer AS n FROM audit_events')).rows[0].n;
    await assert.rejects(store.transaction('account:7',async(state,client)=>{
      await service.eraseAppAccess(before,client);delete state.tokens;throw Error('forced persistence failure');
    }),/forced persistence failure/);
    assert.deepEqual((await engine.query('SELECT * FROM users WHERE id=7')).rows[0],before);
    assert.equal((await engine.query('SELECT * FROM notifications')).rows.length,1);
    assert.equal((await engine.query('SELECT * FROM account_deletion_cleanup')).rows.length,0);
    assert.equal((await engine.query('SELECT COUNT(*)::integer AS n FROM audit_events')).rows[0].n,count);
    assert.ok((await engine.query("SELECT data FROM auth_state WHERE account_key='account:7'")).rows[0].data.tokens[digest(token)]);
  });
  const auth=createAuth({store,eraseAppAccess:service.eraseAppAccess,
    findUser:async(email,id,client)=>(await (client||db).query(email?'SELECT * FROM users WHERE email=$1':'SELECT * FROM users WHERE id=$1',[email||id])).rows[0],
    compare:async(value,hash)=>'hash:'+value===hash,hash:async value=>'hash:'+value,send:async()=>{},updatePassword:async()=>{},
  });
  await t.test('confirmed deletion commits credentials and every session removal while keeping clinical records',async()=>{
    assert.equal((await auth.deleteAccount({accountId:7,password:'OldPassword1!',confirmation:true},token)).deleted,true);
    const user=(await engine.query('SELECT * FROM users WHERE id=7')).rows[0];
    assert.equal(user.email,'deleted+7@oravista.invalid');assert.equal(user.password,'');assert.equal(user.status,'Deleted');assert.ok(user.account_deleted_at);
    for(const field of ['phone','occupation','profile_picture'])assert.equal(user[field],null);
    for(const field of ['first_name','last_name','sex','dob','medical_history'])assert.deepEqual(user[field],before[field]);
    assert.deepEqual((await engine.query('SELECT * FROM patient_records')).rows,medical);
    assert.deepEqual((await engine.query('SELECT * FROM appointments')).rows,visits);
    assert.deepEqual((await engine.query('SELECT * FROM payment_events')).rows,payments);
    assert.equal((await engine.query('SELECT * FROM notifications')).rows.length,0);
    assert.equal((await engine.query("SELECT * FROM auth_state WHERE account_key='email:patient@example.test'")).rows.length,0);
    const state=(await engine.query("SELECT data FROM auth_state WHERE account_key='account:7'")).rows[0].data;
    assert.deepEqual(Object.keys(state),['deletedAt']);await assert.rejects(auth.session(token),e=>e.status===401);
    const audit=(await engine.query("SELECT * FROM audit_events WHERE action='UPDATE DELETE /api/account'")).rows;
    assert.equal(audit.length,1);assert.deepEqual(audit[0].changes,{account:'App credentials deleted; clinic chart retained'});
    assert.doesNotMatch(JSON.stringify(audit),/patient@example|09000000000|OldPassword1/);
    const stale=await engine.query("UPDATE users SET occupation='stale save' WHERE id=7 AND account_deleted_at IS NULL RETURNING id");
    assert.equal(stale.rows.length,0);
    assert.equal(await service.saveProfile(7,'uploads/'+photo),false);
    await engine.query("UPDATE users SET status='Available' WHERE id=7");
    await assert.rejects(auth.session(token),e=>e.status===401);
    await engine.query("INSERT INTO users(id,email,password,role) VALUES(8,'patient@example.test','hash:new','patient')");
    assert.equal((await engine.query('SELECT * FROM patient_records WHERE user_id=8')).rows.length,0);
  });
  await t.test('storage failure keeps a durable retry job without restoring the account',async()=>{
    await service.processCleanup(7);assert.equal(await service.cleanupPending(7),true);
    const job=(await engine.query('SELECT * FROM account_deletion_cleanup')).rows[0];assert.equal(job.attempts,1);
    assert.ok(job.next_attempt_at>new Date());assert.equal((await engine.query('SELECT password FROM users WHERE id=7')).rows[0].password,'');
    assert.deepEqual(removed,[[photo]]);
    await engine.query('UPDATE account_deletion_cleanup SET next_attempt_at=clock_timestamp()');storageMode='success';
    await service.processCleanup(7);assert.equal(await service.cleanupPending(7),false);
    assert.deepEqual(removed,[[photo],[photo]]);
  });
  await t.test('cleanup never deletes shared or unrelated patient files and bounds stalled storage calls',async()=>{
    const legacy='profile_1733000000000.png';
    await engine.query('UPDATE users SET profile_picture=$1 WHERE id=8',[storageUrl+'/storage/v1/object/public/profile-photo/'+legacy]);
    await service.queueProfileCleanup(7,legacy);await service.queueProfileCleanup(7,'patient-record.pdf');
    await service.processCleanup(7);assert.equal(await service.cleanupPending(7),false);assert.equal(removed.length,2);
    await service.queueProfileCleanup(7,photo);storageMode='timeout';
    await service.processCleanup(7);assert.equal(await service.cleanupPending(7),true);
    assert.equal((await engine.query('SELECT attempts FROM account_deletion_cleanup')).rows[0].attempts,1);
  });
});
