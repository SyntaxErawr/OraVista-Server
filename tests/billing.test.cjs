const test = require('node:test');
const assert = require('node:assert/strict');
const { amounts, isPublished, createPDF, createInvoiceService } = require('../billing-invoices');
const bill = { id: 5, user_id: 69, first_name: 'Test', last_name: 'Patient', service_type: 'Cleaning', amount: 1000, billing_status: 'Approved', appointment_date: '2026-10-05', receipt_details: { paid: 250 } };
test('approved balances account for partial payments and paid bills have no balance', () => {
 assert.deepEqual(amounts(bill), {charge:1000,paid:250,balance:750});
 assert.equal(amounts({...bill,billing_status:'Paid'}).balance,0);
 assert.equal(isPublished({...bill,billing_status:'Denied'}),false);
 assert.equal(isPublished({...bill,billing_status:null}),false);
 assert.equal(amounts({...bill,receipt_details:'{"paid":100}'}).balance,900);
});
test('generated PDF contains matching bill values and wraps long services', () => {
 const pdf=createPDF(bill).toString('latin1');
 assert.match(pdf,/^%PDF/); assert.match(pdf,/PHP 750.00/); assert.match(pdf,/Cleaning/);
 assert.match(pdf,/Pending payment/); assert.doesNotThrow(()=>createPDF({...bill,service_type:'Long service '.repeat(500)}));
});
test('private storage uploads a PDF and issues expiring links; unchanged bills reuse file', async () => {
 let exists=false,uploads=0; const paths=[];
 const storage={getBucket:async()=>({data:{public:false}}),from:name=>{
  assert.equal(name,'billing-invoices');return {
   createSignedUrl:async(path,ttl)=>{assert.equal(ttl,3600);paths.push(path);return exists?{data:{signedUrl:'https://example.test/signed.pdf'}}:{error:{status:404}};},
   upload:async(path,data,options)=>{assert.match(path,/^69\/5-/);assert.match(data.toString(),/^%PDF/);assert.equal(options.upsert,false);exists=true;uploads++;return {};},
  };
 }};
 const url=createInvoiceService({storage});
 assert.equal(await url(bill),'https://example.test/signed.pdf');await url(bill);
 assert.equal(uploads,1);assert.equal(new Set(paths).size,1);
 await url({...bill,amount:2000});assert.notEqual(paths.at(-1),paths[0]);
});
test('public bucket and failed storage do not expose invoices', async () => {
 const url=createInvoiceService({storage:{getBucket:async()=>({data:{public:true}})}});
 await assert.rejects(url(bill),/private/);
 await assert.rejects(createInvoiceService(null)(bill),/configured/);
 assert.equal(await createInvoiceService(null)({...bill,billing_status:'Denied'}),null);
});
test('legacy explicit HTTPS invoice links remain supported', async () => {
 assert.equal(await createInvoiceService(null)({...bill,receipt_details:'https://example.test/upload.pdf'}),'https://example.test/upload.pdf');
});
