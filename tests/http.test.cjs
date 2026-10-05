// HTTP integration with real Express, CORS and bcrypt; database and mail are isolated fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const express = require('express');
const {createRequire} = require('node:module');

test('server HTTP authentication contracts', async t => {
  const user = {id:7,email:'patient@example.test',password:await bcrypt.hash('OldPassword1!',4),role:'patient',first_name:'Test'};
  const states = new Map(), mail = [];
  const db = {
    async query(sql, args=[]) {
      if(sql.startsWith('SELECT data FROM auth_state')) return {rows:states.has(args[0])?[{data:structuredClone(states.get(args[0]))}]:[]};
      if(sql.startsWith('INSERT INTO auth_state')) {states.set(args[0],JSON.parse(args[1]));return {rows:[]};}
      if(sql.includes('FROM users')) return {rows:args[0]===user.email || String(args[0])===String(user.id)?[{...user}]:[]};
      if(sql.startsWith('UPDATE users SET password')) {user.password=args[0];return {rows:[]};}
      return {rows:[]};
    },
    async connect(){return {...this,release(){}};}, async end() {},
  };
  let app, listen;
  const ready = new Promise((resolve,reject)=>{
    const factory = () => {
      app=express();listen=app.listen.bind(app);
      app.listen=()=>{resolve();return {};};return app;
    };
    Object.assign(factory,express);
    const filename=path.join(__dirname,'../server.js'), realRequire=createRequire(filename);
    const stubs={express:factory,pg:{Pool:class {constructor(){return db;}}},nodemailer:{createTransport:()=>({sendMail:async message=>mail.push(message)})},dotenv:{config(){}},fs:{...fs,existsSync:()=>true}};
    try {
      vm.runInNewContext(fs.readFileSync(filename,'utf8'),{
        require:name=>stubs[name] || realRequire(name), __dirname:path.dirname(filename),
        process:{env:{PORT:'0'}}, console:{log(){},warn(){},error(){}}, Buffer,setTimeout,clearTimeout,
      },{filename});
    } catch(e){reject(e);}
  });
  await ready;
  const server=listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(url,body,token,method='POST')=>fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  let challenge,session;
  await t.test('health responds after auth storage initialization',async()=>{
    const r=await fetch(base+'/api/auth-health');assert.equal(r.status,200);assert.equal((await r.json()).authentication,'server-verified-v1');
  });
  await t.test('browser preflight permits Authorization and PUT',async()=>{
    const r=await fetch(base+'/api/update-profile',{method:'OPTIONS',headers:{Origin:'https://oravista.site','Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'authorization,content-type'}});
    assert.equal(r.status,204);assert.match(r.headers.get('access-control-allow-headers'),/Authorization/);assert.match(r.headers.get('access-control-allow-methods'),/PUT/);
  });
  await t.test('credential login mails code but returns only challenge',async()=>{
    const r=await request('/api/login',{email:user.email,password:'OldPassword1!'});assert.equal(r.status,200);challenge=await r.json();assert.ok(challenge.challengeId);assert.equal(challenge.generatedOtp,undefined);assert.equal(challenge.token,undefined);assert.equal(mail.length,1);
  });
  await t.test('verification exchanges the emailed code for a session',async()=>{
    const r=await request('/api/verify-otp',{email:user.email,challengeId:challenge.challengeId,code:mail[0].text.match(/\b\d{6}\b/)[0]});assert.equal(r.status,200);session=(await r.json()).token;assert.ok(session);
  });
  await t.test('protected profile denies missing session and permits its owner',async()=>{
    const no=await fetch(base+'/api/user-profile?email='+user.email);assert.equal(no.status,401);assert.equal((await no.json()).code,'SESSION_EXPIRED');
    const yes=await request('/api/user-profile?email='+user.email,null,session,'GET');assert.equal(yes.status,200);assert.equal((await yes.json()).password,undefined);
    const other=await request('/api/user-profile?email=other@example.test',null,session,'GET');assert.equal(other.status,403);
  });
  await t.test('email-only password reset is denied and password is unchanged',async()=>{
    const before=user.password;const r=await request('/api/reset-password-by-email',{email:user.email,newPassword:'ChangedPassword2!'},null,'PUT');assert.equal(r.status,401);assert.equal(user.password,before);
  });
  await t.test('registration rejects invalid fields before inserting a user',async()=>{
    const r=await request('/api/register',{firstName:'Test',lastName:'Patient',email:'bad',phone:'1',password:'short',role:'admin'});assert.equal(r.status,400);
  });
  for(const route of ['/api/signup','/api/register']) {
    await t.test(route+' reports separate errors and rejects malformed field types',async()=>{
      const r=await request(route,{firstName:{},lastName:[],email:'bad',phone:'1',password:'short'});
      assert.equal(r.status,400);const data=await r.json();
      assert.deepEqual(Object.keys(data.errors).sort(),['email','firstName','lastName','password','phone']);
    });
    await t.test(route+' accepts complete patient registration',async()=>{
      const r=await request(route,{firstName:'ABCDEFGHIJKLMNOPQRST',lastName:'Patient',email:' new@example.test ',phone:' 09123456789 ',password:'StrongPassword1!',role:'admin'});
      assert.equal(r.status,201);
    });
    await t.test(route+' attaches duplicate email errors to email',async()=>{
      const r=await request(route,{firstName:'Test',lastName:'Patient',email:user.email,phone:'09123456789',password:'StrongPassword1!'});
      assert.equal(r.status,400);assert.match((await r.json()).errors.email,/already registered/);
    });
  }

});
