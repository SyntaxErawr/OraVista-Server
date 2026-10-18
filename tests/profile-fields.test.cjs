const test=require('node:test');
const assert=require('node:assert/strict');
const {profileAge,profileSex}=require('../profile-fields');
test('age is derived only from a valid birth date using Philippine birthdays',()=>{
 assert.equal(profileAge('2000-10-18',new Date('2026-10-17T15:59:59Z')),25);
 assert.equal(profileAge('2000-10-18',new Date('2026-10-17T16:00:00Z')),26);
 assert.equal(profileAge('2024-02-29',new Date('2025-02-28T04:00:00Z')),0);
 assert.equal(profileAge('2024-02-29',new Date('2025-03-01T04:00:00Z')),1);
 for(const value of [null,'','2026-02-30','2999-01-01'])assert.equal(profileAge(value),null);
});
test('sex options normalize to the two shared labels or an empty selection',()=>{
 assert.equal(profileSex('male'),'Male');assert.equal(profileSex('F'),'Female');assert.equal(profileSex(null),'');assert.equal(profileSex('other'),'');
});
