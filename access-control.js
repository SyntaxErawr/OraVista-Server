// Enforce identity at the API boundary; request body IDs never establish identity.
function accessControl({auth,db}) {
 return async (req,res,next) => {
  const p=req.path;
  const publicPaths=['/api/signup','/api/register','/api/check-email'];
  if(!p.startsWith('/api/') || publicPaths.includes(p) || p.startsWith('/api/jobs/')) return next();
  try {
   req.actor=await auth.session((req.get('authorization')||'').replace(/^Bearer /i,''));
   const role=String(req.actor.role).toLowerCase();
   if(['/api/admin/transactions','/api/admin/audit-logs'].includes(p) && role!=='admin') return res.status(403).json({message:'Administrator access required.'});
   if(['admin','staff','dentist'].includes(role)) {
    if(p==='/api/admin/create-user' && role!=='admin') return res.status(403).json({message:'Administrator access required.'});
    if(req.body?.actor_id && String(req.body.actor_id)!==String(req.actor.id)) return res.status(403).json({message:'Account mismatch.'});
    if(req.query.actor_id && String(req.query.actor_id)!==String(req.actor.id)) return res.status(403).json({message:'Account mismatch.'});
    return next();
   }
   if(role!=='patient') return res.status(403).json({message:'Access denied.'});
   const own=value=>value!=null && String(value)===String(req.actor.id);
   const read=p.match(/^\/api\/(?:user-appointments|user-billings|patient-records|patient-final-diagnoses|notifications)\/(\d+)$/);
   if(read && req.method==='GET' && own(read[1])) return next();
   if(p==='/api/user-profile' && String(req.query.email).toLowerCase()===String(req.actor.email).toLowerCase()) return next();
   if(['/api/dentists','/api/appointments/check-availability','/api/booked-times'].includes(p) && req.method==='GET') return next();
   if(p==='/api/update-profile' && own(req.body.id)) return next();
   if(p==='/api/upload-profile-picture') return next(); // multipart user ID is checked after multer
   if(p==='/api/book-appointment' && own(req.body.userId || req.body.user_id)) {
    req.body.userId=req.actor.id;req.body.user_id=req.actor.id;return next();
   }
   const cancel=p.match(/^\/api\/appointments\/(\d+)\/cancel$/);
   if(p==='/api/request-reschedule' || p==='/api/update-appointment-status' || cancel) {
    const id=cancel?.[1] || req.body.appointment_id;
    const {rows}=await db.query('SELECT user_id,status FROM appointments WHERE id=$1',[id]);
    if(!rows[0] || !own(rows[0].user_id)) return res.status(403).json({message:'Appointment access denied.'});
    if(p==='/api/update-appointment-status' && req.body.status!=='Cancelled') return res.status(403).json({message:'Only the clinic can set that status.'});
    if((cancel || p==='/api/update-appointment-status') && !['Pending','Approved','Confirmed'].includes(rows[0].status)) return res.status(409).json({message:'This appointment cannot be cancelled.'});
    req.body.user_id=req.actor.id;return next();
   }
   const note=p.match(/^\/api\/notifications\/(\d+)\/read$/);
   if(note) {
    const {rows}=await db.query('SELECT user_id FROM notifications WHERE id=$1',[note[1]]);
    if(rows[0] && own(rows[0].user_id)) {req.body.user_id=req.actor.id;return next();}
   }
   return res.status(403).json({message:'You do not have access to this resource.'});
  } catch(e) {return res.status(e.status||500).json({message:e.status?e.message:'Unable to verify your session.',code:e.status===401?'SESSION_EXPIRED':undefined});}
 };
}
module.exports={accessControl};
