const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { registerDiagnosticRecords } = require('./diagnosticRecords');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const { createInvoiceService, amounts, isPublished, receiptObject } = require('./billing-invoices');
const app = express();

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );
} else {
    console.warn("⚠️ Warning: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing. Supabase Storage uploads will fail.");
}

const invoiceUrl = createInvoiceService(supabase);

app.use(cors({
    origin: [
        "http://localhost:3000",   // React local
        "http://localhost:5173",   // Vite local
        "https://oravista.vercel.app", // Deployment preview
        "https://ora-vista-web.vercel.app",
        "https://oravista.site"
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    try {
        fs.mkdirSync(uploadDir, { recursive: true });
    } catch (err) {
        console.error("Failed to create uploads directory:", err);
    }
}

app.use('/uploads', (req, res, next) => {
    const filePath = path.join(uploadDir, req.path);
    
    // If the file exists locally (legacy/development files), serve it
    if (fs.existsSync(filePath)) {
        return next();
    }
    
    // Otherwise, redirect to Supabase storage if it matches the filename prefixes
    const filename = req.path.replace(/^\//, '');
    let bucket = '';
    
    if (filename.startsWith('profile_')) {
        bucket = 'profile-photo';
    } else if (filename.startsWith('record_')) {
        bucket = 'file-record';
    }
    
    if (bucket && process.env.SUPABASE_URL) {
        const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${filename}`;
        return res.redirect(302, publicUrl);
    }
    
    console.warn(`[WARN] File not found: ${filePath}`);
    res.status(404).send('File not found');
}, express.static(uploadDir));

// ---------------------------------------------------------
// DATABASE CONNECTION (PostgreSQL / Supabase)
// ---------------------------------------------------------
const db = new Pool({
    connectionString: `postgresql://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DATABASE}`,
    ssl: {
        rejectUnauthorized: false
    }
});

db.connect()
    .then(client => {
        console.log('✅ Connected to PostgreSQL Database');
        client.release();
    })
    .catch(err => {
        console.error('❌ Database connection error', err.stack);
    });

// ---------------------------------------------------------
// EMAIL TRANSPORTER SETUP
// ---------------------------------------------------------
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: {
        rejectUnauthorized: false
    }
});

const CLINIC_TIME_ZONE = 'Asia/Manila';

function dateOnly(date) {
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
        return date.toISOString().slice(0, 10);
    }
    const match = String(date || '').match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : null;
}

function appointmentDateTime(date, time) {
    const match = String(time || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const period = match[3].toUpperCase();
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (period === 'PM' && hour !== 12) hour += 12;
    if (period === 'AM' && hour === 12) hour = 0;
    const appointmentDay = dateOnly(date);
    if (!appointmentDay) return null;
    return new Date(`${appointmentDay}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`);
}

function formatAppointmentDate(date) {
    const appointmentDay = dateOnly(date);
    if (!appointmentDay) return 'your scheduled date';
    return new Intl.DateTimeFormat('en-PH', {
        timeZone: CLINIC_TIME_ZONE,
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    }).format(new Date(`${appointmentDay}T00:00:00+08:00`));
}

// ---------------------------------------------------------
// MULTER CONFIGURATION FOR UPLOADS
// ---------------------------------------------------------
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const uploadRecord = multer({ storage: storage });


// ---------------------------------------------------------
// AUTHENTICATION ROUTES
// ---------------------------------------------------------


const {createAuth,postgresStore,strong}=require('./auth');
const {accessControl}=require('./access-control');
const authStore=postgresStore(db);
const auth=createAuth({
 store:authStore,
 findUser:async(email,id,client)=> (await (client||db).query(email?'SELECT * FROM users WHERE LOWER(email)=$1':'SELECT * FROM users WHERE id=$1',[email||id])).rows[0],
 compare:(value,stored)=>typeof stored==='string' && /^\$2[aby]\$/.test(stored)?bcrypt.compare(String(value),stored):Promise.resolve(false),
 hash:value=>bcrypt.hash(value,12),
 updatePassword:(id,password,client)=>client.query('UPDATE users SET password=$1 WHERE id=$2',[password,id]),
 send:(email,code,purpose)=>transporter.sendMail({from:process.env.EMAIL_USER,to:email,subject:'OraVista verification code',text:`Your ${purpose.replace(/_/g,' ')} code is ${code}. It expires in 5 minutes. If you did not request it, ignore this email.`})
});
const authRoute=fn=>async(req,res)=>{try {res.json(await fn(req));}catch(e){console.error('Authentication request failed:',e.status||500);res.status(e.status||500).json({message:e.status?e.message:'Unable to complete verification. Please try again.'});}};
const sessionFor=req=>auth.session((req.get('authorization')||'').replace(/^Bearer /i,''));
app.get('/api/auth-health', (req,res)=>res.json({authentication:'server-verified-v1'}));
app.post('/api/login',authRoute(req=>auth.login(req.body)));
app.post('/api/send-otp',authRoute(async req=>auth.request(req.body,req.body.action==='change_password'?await sessionFor(req):null)));
app.post('/api/forgot-password',authRoute(req=>auth.request({...req.body,action:'forgot_password'})));
app.post('/api/verify-otp',authRoute(req=>auth.verify(req.body)));
app.put('/api/reset-password-by-email',authRoute(req=>auth.reset(req.body)));
app.put('/api/update-password',authRoute(async req=>auth.reset(req.body,await sessionFor(req))));
app.use(accessControl({auth,db}));
// Validate public registration on both client contracts, and never accept a supplied role.
app.use(['/api/register','/api/signup'],(req,res,next)=>{
 if(req.method!=='POST') return next();
 const b=req.body||{};
 const errors={};
 for(const field of ['firstName','lastName']) {
   if(typeof b[field]!=='string' || !b[field].trim()) errors[field]='This field is required.';
   else if(b[field].trim().length>20) errors[field]='Use 20 characters or fewer.';
 }
 if(typeof b.email!=='string' || !b.email.trim()) errors.email='This field is required.';
 else if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim())) errors.email='Enter a valid email address.';
 if(typeof b.phone!=='string' || !b.phone.trim()) errors.phone='This field is required.';
 else if(!/^09\d{9}$/.test(b.phone.trim())) errors.phone='Enter an 11-digit mobile number starting with 09.';
 if(!strong(b.password)) errors.password='Use 8-128 characters with uppercase, lowercase, number and symbol.';
 if(Object.keys(errors).length) return res.status(400).json({message:Object.values(errors)[0],errors});
 b.email=b.email.trim().toLowerCase();b.firstName=b.firstName.trim();b.lastName=b.lastName.trim();b.phone=b.phone.trim();b.role='patient';next();
});

app.post('/api/signup', async (req, res) => {
    const { firstName, lastName, email, password, role, phone, dob, branch } = req.body;

    if (firstName.length > 20 || lastName.length > 20) {
        return res.status(400).json({ message: "Names must be 20 characters or less." });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ message: "Invalid email format." });
    }

    try {
        const { rows: existingUser } = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (existingUser.length > 0) {
            return res.status(400).json({ message: "Email already registered.", errors: { email: "Email already registered." } });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const userRole = role || 'patient';
        const userBranch = branch || 'Main Branch';

        const query = 'INSERT INTO users (first_name, last_name, email, password, role, phone, dob, branch) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
        await db.query(query, [firstName, lastName, email, hashedPassword, userRole, phone || null, dob || null, userBranch]);

        res.status(201).json({ message: "Account created successfully!" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Database error." });
    }
});


// ---------------------------------------------------------
// MOBILE COMPATIBILITY: REGISTRATION / AUTH LOOKUPS
// These routes use the same users table as the web portal.
// ---------------------------------------------------------
app.post('/api/register', async (req, res) => {
    const { firstName, lastName, email, phone, password, role, branch } = req.body || {};

    if (!firstName || !lastName || !email || !password) {
        return res.status(400).json({ message: "Missing required registration information." });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
        return res.status(400).json({ message: "Invalid email format." });
    }

    try {
        const { rows: existingUser } = await db.query(
            'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
            [cleanEmail]
        );
        if (existingUser.length > 0) {
            return res.status(400).json({ message: "Email is already registered.", errors: { email: "Email is already registered." } });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const userRole = role || 'patient';
        const userBranch = branch || 'Main Branch';

        await db.query(
            `INSERT INTO users (first_name, last_name, email, password, role, phone, branch)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [firstName, lastName, cleanEmail, hashedPassword, userRole, phone || null, userBranch]
        );

        return res.status(201).json({ message: "Registration successful!" });
    } catch (err) {
        console.error("Mobile Registration Error:", err);
        return res.status(500).json({ message: "Server error during registration." });
    }
});





// ---------------------------------------------------------
// ADMIN ROUTE: CREATE STAFF OR DENTIST
// ---------------------------------------------------------
app.post('/api/admin/create-user', async (req, res) => {
    const { firstName, lastName, email, password, role, branch, specialty, phone } = req.body;

    try {
        // Check if email exists
        const { rows: existingUser } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existingUser.length > 0) {
            return res.status(400).json({ message: "Email already registered." });
        }

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Insert into database including specialty and status
        const query = `
            INSERT INTO users (first_name, last_name, email, password, role, phone, branch, specialty, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Available')
        `;

        await db.query(query, [firstName, lastName, email, hashedPassword, role, phone || null, branch, specialty || null]);

        res.status(201).json({ message: "Staff/Dentist account created successfully!" });
    } catch (err) {
        console.error("Admin Creation Error:", err);
        res.status(500).json({ message: "Database error." });
    }
});



app.post('/api/check-email', async (req, res) => {
    const { email } = req.body;
    try {
        const { rows: users } = await db.query('SELECT first_name FROM users WHERE email = $1', [email]);
        if (users.length > 0) res.status(200).json({ firstName: users[0].first_name });
        else res.status(404).json({ message: "Email not found" });
    } catch (err) {
        res.status(500).json({ message: "Server error" });
    }
});



// ---------------------------------------------------------
// OTP / DYNAMIC EMAIL ROUTE
// ---------------------------------------------------------


// ---------------------------------------------------------
// PROFILE & SETTINGS ROUTES
// ---------------------------------------------------------

// Mobile compatibility: resolve a user profile by email.
app.get('/api/user-profile', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ message: "Email is required." });

    try {
        const { rows } = await db.query(
            'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
            [String(email).trim()]
        );
        if (rows.length === 0) {
            return res.status(404).json({ message: "Not found" });
        }

        const user = { ...rows[0] };
        delete user.password;
        return res.status(200).json(user);
    } catch (err) {
        console.error("User Profile Error:", err);
        return res.status(500).json({ message: "Error" });
    }
});

app.put('/api/update-profile', async (req, res) => {
    const {
        id, firstName, lastName, email, sex, dob, age, phone,
        occupation, blood_type, allergies, insurance, policy_number
    } = req.body;

    // Convert empty strings to null for database columns that expect numbers or dates
    const safeAge = age === '' ? null : age;
    const safeDob = dob === '' ? null : dob;

    try {
        const query = `UPDATE users SET first_name = $1, last_name = $2, email = $3, sex = $4, dob = $5, age = $6, phone = $7, occupation = $8, blood_type = $9, allergies = $10, insurance = $11, policy_number = $12 WHERE id = $13`;

        // Pass safeAge and safeDob to the database query
        await db.query(query, [firstName, lastName, email, sex, safeDob, safeAge, phone, occupation, blood_type, allergies, insurance, policy_number, id]);

        res.status(200).json({ message: "Profile updated successfully!" });
    } catch (err) {
        console.error("Database Update Error:", err);
        res.status(500).json({ message: "Failed to update profile." });
    }
});



app.post('/api/upload-profile-picture', upload.single('profileImage'), async (req, res) => {
    const { userId } = req.body;
    if (String(userId)!==String(req.actor.id)) return res.status(403).json({message:'Profile access denied.'});

    if (!req.file) {
        return res.status(400).json({ message: "No image file provided." });
    }

    const filename = 'profile_' + Date.now() + path.extname(req.file.originalname);
    const imagePath = 'uploads/' + filename;

    try {
        if (!supabase) {
            return res.status(500).json({ message: "Supabase storage is not configured." });
        }

        const { data, error } = await supabase.storage
            .from('profile-photo')
            .upload(filename, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: true
            });

        if (error) {
            console.error("Supabase upload error:", error);
            return res.status(500).json({ message: "Failed to upload image to storage." });
        }

        await db.query('UPDATE users SET profile_picture = $1 WHERE id = $2', [imagePath, userId]);
        res.status(200).json({
            message: "Profile picture updated successfully!",
            imagePath: imagePath
        });
    } catch (err) {
        console.error("Upload DB Error:", err);
        res.status(500).json({ message: "Failed to save picture path to database." });
    }
});

// ---------------------------------------------------------
// PATIENT RECORDS ROUTES
// ---------------------------------------------------------

registerDiagnosticRecords(app, { db, supabase });

app.post('/api/upload-record', uploadRecord.single('recordFile'), async (req, res) => {
    const { userId, fileName } = req.body;

    if (!req.file) {
        return res.status(400).json({ message: "No file provided." });
    }

    const filename = 'record_' + Date.now() + path.extname(req.file.originalname);
    const filePath = 'uploads/' + filename;
    const finalFileName = fileName || req.file.originalname;

    try {
        if (!supabase) {
            return res.status(500).json({ message: "Supabase storage is not configured." });
        }

        const { data, error } = await supabase.storage
            .from('file-record')
            .upload(filename, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: true
            });

        if (error) {
            console.error("Supabase upload error:", error);
            return res.status(500).json({ message: "Failed to upload file to storage." });
        }

        const query = 'INSERT INTO patient_records (user_id, file_name, file_path) VALUES ($1, $2, $3)';
        await db.query(query, [userId, finalFileName, filePath]);

        res.status(201).json({
            message: "Record uploaded successfully!",
            record: { file_name: finalFileName, file_path: filePath }
        });
    } catch (err) {
        console.error("Record Upload DB Error:", err);
        res.status(500).json({ message: "Failed to save record to database." });
    }
});

// Retrieve dentist-saved diagnoses directly; do not pair them with unrelated uploads.
app.get('/api/patient-final-diagnoses/:userId', async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return res.status(400).json({ message: 'Invalid patient ID.' });
    }
    try {
        const { rows } = await db.query(
            `SELECT diagnosis_id AS id, patient_id, clinical_notes, ai_findings, scan_date
             FROM ai_diagnostics
             WHERE patient_id = $1
               AND ai_findings::jsonb ->> 'human_verified' = 'true'
             ORDER BY scan_date DESC NULLS LAST, diagnosis_id DESC`,
            [userId]
        );
        res.set('Cache-Control', 'no-store');
        res.status(200).json(rows);
    } catch (err) {
        console.error('Final diagnosis retrieval error:', err);
        res.status(500).json({ message: 'Failed to retrieve saved final diagnoses.' });
    }
});

app.get('/api/patient-records/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;

        // Query 1: Fetch all core file upload entries using columns guaranteed by the model
        const recordsQuery = `
            SELECT file_name, file_path, upload_date 
            FROM patient_records 
            WHERE user_id = $1 
            ORDER BY upload_date DESC
        `;
        const { rows: records } = await db.query(recordsQuery, [userId]);

        // Query 2: Fetch all AI diagnostics runs using columns guaranteed by the model
        const diagnosticsQuery = `
            SELECT ai_findings, clinical_notes, scan_date 
            FROM ai_diagnostics 
            WHERE patient_id = $1 
            ORDER BY scan_date DESC
        `;
        const { rows: diagnostics } = await db.query(diagnosticsQuery, [userId]);

        // Zip the arrays together by index positioning
        const unifiedRecords = records.map((record, index) => {
            // Fallback to empty values if there's a minor length mismatch
            const diagnosticMatch = diagnostics[index] || {}; 
            
            return {
                file_name: record.file_name,
                file_path: record.file_path,
                upload_date: record.upload_date,
                ai_findings: diagnosticMatch.ai_findings || { predictions: [] },
                clinical_notes: diagnosticMatch.clinical_notes || "No clinical advisory notes compiled."
            };
        });

        // Send the unified list back to the React client code
        res.status(200).json(unifiedRecords);

    } catch (err) {
        console.error("❌ Critical Patient Records Processing Failure:", err);
        res.status(500).json({ message: "Failed to assemble unified patient diagnostic history logs." });
    }
});


// ---------------------------------------------------------
// APPOINTMENT ROUTES
// ---------------------------------------------------------

// Mobile and web currently use a few different display labels for the same
// clinic data. Normalize only known mobile aliases before reading/writing the
// shared appointments table; existing web labels pass through unchanged.
const mobileServiceAliases = {
    'Orthodontics Installation': 'Braces Installation',
    'Orthodontics Adjustment': 'Braces Adjustment',
    'Veneers / Esthetics': 'Veneers',
    'Root Canal Treatment': 'Root Canal (RCT)',
    'Whitening': 'Teeth Whitening'
};
const mobileServiceNames = Object.fromEntries(
    Object.entries(mobileServiceAliases).map(([mobileName, webName]) => [webName, mobileName])
);
const mobileDentistAliases = {
    'Queenie Balmedina DMD': 'Dra. Queenie Balmedina',
    'Therese Madrid DMD': 'Dra. Theresa Madrid',
    'Vicente Epres II DMD': 'Dr. Vicente Epres',
    'Paulette Malit DMD': 'Dra.Paulette Maliit'
};
const mobileBranchAliases = {
    'Sta. Ana': 'Sta. Ana, Manila',
    'Angeles': 'Angeles, Pampanga'
};
const webServiceBasePrices = {
    'Oral Prophylaxis': 1500,
    Restoration: 1200,
    Extraction: 1000,
    'Braces Installation': 35000,
    'Braces Adjustment': 1000,
    Veneers: 15000,
    'Root Canal (RCT)': 8000,
    'Wisdom Tooth Surgery': 10000,
    Dentures: 5000,
    'Fixed Bridge': 12000,
    'Teeth Whitening': 7000
};
function normalizeBookingService(value) {
    const name = String(value || '').trim();
    return mobileServiceAliases[name] || name;
}
function mobileBookingServiceName(value) {
    const name = String(value || '').trim();
    return mobileServiceNames[name] || name;
}
function normalizeBookingDentist(value) {
    const name = String(value || '').trim();
    return mobileDentistAliases[name] || name;
}
function normalizeBookingBranch(value) {
    const name = String(value || '').trim();
    return mobileBranchAliases[name] || name;
}

// Use the same service durations as the booking page when checking overlapping slots.
const appointmentDurations = {
    'Oral Prophylaxis': 30, Restoration: 60, Extraction: 60,
    'Braces Installation': 60, 'Braces Adjustment': 30, Veneers: 120,
    'Root Canal (RCT)': 120, 'Wisdom Tooth Surgery': 180, Dentures: 30,
    'Fixed Bridge': 120, 'Teeth Whitening': 90
};
function appointmentDuration(service) {
    const name = String(service || '').trim();
    if (appointmentDurations[name]) return appointmentDurations[name];
    const hours = name.match(/(\d+(?:\.\d+)?)\s*hrs?/i);
    const minutes = name.match(/(\d+)\s*mins?/i);
    return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0) || 30;
}
function slotMinutes(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] || 0);
    const period = match[4]?.toUpperCase();
    if (minute > 59 || second > 59 || hour > (period ? 12 : 23) || (period && hour < 1)) return null;
    if (period) hour = hour % 12 + (period === 'PM' ? 12 : 0);
    return hour * 60 + minute + second / 60;
}
function appointmentTimeWithSeconds(value) {
    const minutes = slotMinutes(value);
    if (minutes === null) return String(value || 'Time not provided');
    const seconds = Math.round(minutes * 60);
    const hour = Math.floor(seconds / 3600);
    return `${String(hour % 12 || 12).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}
function appointmentError(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
}
function validateRequestedSlot(date, time) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || slotMinutes(time) === null) {
        throw appointmentError('A valid appointment date and time are required.');
    }
    const day = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) {
        throw appointmentError('Invalid appointment date.');
    }
    const scheduledAt = new Date(`${date}T00:00:00+08:00`).getTime() + slotMinutes(time) * 60000;
    if (scheduledAt <= Date.now()) throw appointmentError('Please choose a future appointment date and time.');
}
async function withAppointmentWrite(work) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        // Short database lock also prevents a concurrent booking from taking an approved slot.
        await client.query('LOCK TABLE appointments IN SHARE ROW EXCLUSIVE MODE');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
async function assertAppointmentSlotAvailable(client, date, time, dentist, service, excludedId = null) {
    const start = slotMinutes(time);
    if (start === null) throw appointmentError('Invalid appointment time.');
    const { rows } = await client.query(
        `SELECT appointment_time AS time, service_type FROM appointments
         WHERE appointment_date = $1 AND dentist_name = $2
           AND ($3::integer IS NULL OR id <> $3)
           AND COALESCE(status, 'Pending') NOT IN ('Cancelled', 'Canceled', 'Denied')
         UNION ALL
         SELECT reschedule_requested_time AS time, service_type FROM appointments
         WHERE reschedule_requested_date = $1 AND dentist_name = $2
           AND ($3::integer IS NULL OR id <> $3) AND status = 'Reschedule Requested'`,
        [date, dentist, excludedId]
    );
    const end = start + appointmentDuration(service);
    const conflict = rows.some((row) => {
        const otherStart = slotMinutes(row.time);
        return otherStart === null || (start < otherStart + appointmentDuration(row.service_type) && end > otherStart);
    });
    if (conflict) throw appointmentError('That dentist is no longer available for the requested time. Please choose another slot.', 409);
}
function escapeAppointmentHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
}
async function approveRequestedSchedule(client, appointment, request) {
    const newDate = appointment.requested_day;
    const newTime = appointment.reschedule_requested_time;
    if (!newDate || !newTime) throw appointmentError('This appointment has no complete reschedule request.', 409);
    if ((request.expected_requested_date && request.expected_requested_date !== newDate) ||
        (request.expected_requested_time && request.expected_requested_time !== newTime)) {
        throw appointmentError('The reschedule request changed. Refresh the appointment list before approving.', 409);
    }
    validateRequestedSlot(newDate, newTime);
    await assertAppointmentSlotAvailable(client, newDate, newTime, appointment.dentist_name, appointment.service_type, appointment.id);
    const { rows } = await client.query(
        `UPDATE appointments SET appointment_date = reschedule_requested_date,
         appointment_time = reschedule_requested_time, status = 'Confirmed',
         reschedule_requested_date = NULL, reschedule_requested_time = NULL,
         reminder_email_sent_at = NULL WHERE id = $1 RETURNING *`, [appointment.id]
    );
    const { rows: patients } = await client.query('SELECT first_name, email FROM users WHERE id = $1', [appointment.user_id]);
    const patient = patients[0] || {};
    const oldSchedule = `${formatAppointmentDate(appointment.original_day)} at ${appointmentTimeWithSeconds(appointment.appointment_time)}`;
    const newSchedule = `${formatAppointmentDate(newDate)} at ${appointmentTimeWithSeconds(newTime)}`;
    const amount = Number(appointment.amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const message = `Your reschedule request for ${appointment.service_type} with ${appointment.dentist_name} has been approved. Previous schedule: ${oldSchedule}. New schedule: ${newSchedule}. Branch: ${appointment.branch || 'Main Branch'}. Base price: ₱${amount}.`;
    // Each completed approval has its own event, including repeated reschedules of one appointment.
    const notificationType = `reschedule_approved_${crypto.randomBytes(12).toString('hex')}`;
    await client.query(
        `INSERT INTO notifications (user_id, appointment_id, notification_type, title, message)
         VALUES ($1, $2, $3, 'Reschedule Approved', $4)`,
        [appointment.user_id, appointment.id, notificationType, message]
    );
    return { appointment: rows[0], patient, message };
}

app.post('/api/book-appointment', async (req, res) => {
    const {
        user_id, userId,
        service_type, service,
        dentist_name, dentist,
        appointment_date, date,
        appointment_time, time,
        amount, branch,
        basePrice, base_price, price, service_price
    } = req.body || {};

    const resolvedUserId = user_id ?? userId;
    const requestedService = service_type || service;
    const requestedDentist = dentist_name || dentist;
    const resolvedDate = appointment_date || date;
    const resolvedTime = appointment_time || time;
    const normalizedService = normalizeBookingService(requestedService);
    const normalizedDentist = normalizeBookingDentist(requestedDentist);
    const normalizedBranch = normalizeBookingBranch(branch || 'Main Branch');

    if (!resolvedUserId || !normalizedService || !normalizedDentist || !resolvedDate || !resolvedTime) {
        return res.status(400).json({ message: "Missing required booking information." });
    }

    const mobileStyleRequest = amount === undefined && (
        userId !== undefined || service !== undefined || dentist !== undefined ||
        date !== undefined || time !== undefined || basePrice !== undefined ||
        base_price !== undefined || price !== undefined || service_price !== undefined
    );
    const suppliedPrice = amount ?? basePrice ?? base_price ?? price ?? service_price;
    const amountToSave = mobileStyleRequest && webServiceBasePrices[normalizedService] !== undefined
        ? webServiceBasePrices[normalizedService]
        : Number(suppliedPrice ?? 0);

    try {
        const randomString = crypto.randomBytes(3).toString('hex').toUpperCase();
        const booking_ref = `OV - ${randomString}`;

        const query = `
            INSERT INTO appointments 
            (user_id, booking_ref, service_type, dentist_name, appointment_date, appointment_time, status, amount, branch) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `;

        validateRequestedSlot(resolvedDate, resolvedTime);
        await withAppointmentWrite(async (client) => {
            await assertAppointmentSlotAvailable(
                client,
                resolvedDate,
                resolvedTime,
                normalizedDentist,
                normalizedService
            );
            await client.query(query, [
                resolvedUserId,
                booking_ref,
                normalizedService,
                normalizedDentist,
                resolvedDate,
                resolvedTime,
                'Pending',
                Number.isFinite(amountToSave) ? amountToSave : 0,
                normalizedBranch
            ]);
        });

        res.status(201).json({
            message: "Appointment booked successfully!",
            booking_ref: booking_ref
        });
    } catch (err) {
        console.error("Booking Error:", err);
        res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Failed to book appointment." });
    }
});

app.get('/api/user-appointments/:userId', async (req, res) => {
    try {
        const { rows: results } = await db.query('SELECT * FROM appointments WHERE user_id = $1 ORDER BY appointment_date DESC', [req.params.userId]);
        res.status(200).json(results);
    } catch (err) {
        res.status(500).json({ message: "Failed to fetch appointments." });
    }
});


// Mobile compatibility alias used by BookingScreen while checking the user's own conflicts.
app.get('/api/appointments', async (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ message: "User ID is required." });

    try {
        const { rows } = await db.query(
            'SELECT * FROM appointments WHERE user_id = $1 ORDER BY appointment_date DESC',
            [userId]
        );
        const mobileCompatible = rows.map((appointment) => ({
            ...appointment,
            service_type: mobileBookingServiceName(appointment.service_type)
        }));
        return res.status(200).json(mobileCompatible);
    } catch (err) {
        console.error("Mobile Appointments Alias Error:", err);
        return res.status(500).json({ message: "Failed to fetch appointments." });
    }
});

app.put('/api/update-appointment-status', async (req, res) => {
    const { appointment_id, status, expected_status } = req.body || {};
    // Reschedule requests must keep the original appointment and proposed schedule together.
    if (['rescheduled', 'reschedule requested'].includes(String(status || '').trim().toLowerCase())) {
        return res.status(400).json({ message: 'Use the reschedule request flow to change an appointment schedule. Please update the app if you are using an older version.' });
    }
    try {
        const result = await withAppointmentWrite(async (client) => {
            const { rows } = await client.query(
                `SELECT *, to_char(appointment_date, 'YYYY-MM-DD') AS original_day,
                 to_char(reschedule_requested_date, 'YYYY-MM-DD') AS requested_day
                 FROM appointments WHERE id = $1 FOR UPDATE`, [appointment_id]
            );
            const appointment = rows[0];
            if (!appointment) throw appointmentError('Appointment not found.', 404);
            if (expected_status && appointment.status !== expected_status) {
                throw appointmentError('This appointment changed. Refresh the list and try again.', 409);
            }
            if (status === 'Confirmed' && appointment.status === 'Reschedule Requested') {
                return await approveRequestedSchedule(client, appointment, req.body);
            }
            if (status === 'Confirmed' && !['Pending', 'Approved', 'Confirmed'].includes(appointment.status)) {
                throw appointmentError('This appointment can no longer be confirmed.', 409);
            }
            await client.query('UPDATE appointments SET status = $1 WHERE id = $2', [status, appointment_id]);
            return null;
        });
        if (result) {
            let emailSent = false;
            try {
                if (!result.patient.email) throw new Error('Patient email is missing.');
                await transporter.sendMail({
                    from: process.env.EMAIL_USER, to: result.patient.email,
                    subject: 'OraVista - Reschedule Approved',
                    html: `<div style="font-family: Arial, sans-serif; padding: 20px; color: #001166;"><h2>King Epres Dental Clinic</h2><p>Hello ${escapeAppointmentHtml(result.patient.first_name)},</p><p>${escapeAppointmentHtml(result.message)}</p><p>You can view your updated appointment in OraVista.</p></div>`
                });
                emailSent = true;
            } catch (error) {
                console.error('Reschedule approval email error:', error);
            }
            return res.status(200).json({
                message: 'Reschedule approved. The appointment schedule and patient notification have been updated.',
                appointment: result.appointment, email_sent: emailSent,
                warning: emailSent ? null : 'The reschedule was approved, but its email could not be sent. Please check the server email logs.'
            });
        }

        if (status === 'Confirmed') {
            const { rows } = await db.query(
                `SELECT a.id, a.service_type, a.dentist_name, a.appointment_date,
                        a.appointment_time, a.amount, a.branch,
                        u.first_name, u.email
                 FROM appointments a
                 JOIN users u ON u.id = a.user_id
                 WHERE a.id = $1`,
                [appointment_id]
            );

            if (rows.length > 0) {
                const appointment = rows[0];
                const formattedAmount = Number(appointment.amount || 0).toLocaleString('en-PH', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                });
                const notificationTitle = 'Appointment Confirmed';
                const notificationMessage = `Your ${appointment.service_type} appointment with ${appointment.dentist_name} on ${appointment.appointment_date} at ${appointment.appointment_time} has been confirmed. Base price: ₱${formattedAmount}.`;

                const notificationInsert = await db.query(
                    `INSERT INTO notifications
                        (user_id, appointment_id, notification_type, title, message)
                     SELECT a.user_id, $1, 'appointment_confirmed', $2, $3
                     FROM appointments a
                     WHERE a.id = $1
                       AND NOT EXISTS (
                           SELECT 1 FROM notifications n
                           WHERE n.user_id = a.user_id
                             AND n.appointment_id = a.id
                             AND n.notification_type = 'appointment_confirmed'
                       )`,
                    [appointment.id, notificationTitle, notificationMessage]
                );

                if (notificationInsert.rowCount > 0) {
                    try {
                    await transporter.sendMail({
                        from: process.env.EMAIL_USER,
                        to: appointment.email,
                        subject: 'OraVista - Appointment Confirmed',
                        html: `<div style="font-family: Arial, sans-serif; padding: 20px; color: #001166;">
                            <h2>King Epres Dental Clinic</h2>
                            <p>Hello ${appointment.first_name},</p>
                            <p>Your appointment has been confirmed.</p>
                            <p><strong>Service:</strong> ${appointment.service_type}</p>
                            <p><strong>Base Price:</strong> ₱${formattedAmount}</p>
                            <p><strong>Dentist:</strong> ${appointment.dentist_name}</p>
                            <p><strong>Date:</strong> ${appointment.appointment_date}</p>
                            <p><strong>Time:</strong> ${appointment.appointment_time}</p>
                            <p><strong>Branch:</strong> ${appointment.branch || 'Main Branch'}</p>
                            <p>Status: <strong>Confirmed</strong></p>
                        </div>`
                    });
                    } catch (emailError) {
                        console.error('Appointment confirmation email error:', emailError);
                    }
                }
            }
        }

        res.status(200).json({ message: `Appointment marked as ${status}.` });
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : "Server error." });
    }
});

app.get('/api/notifications/:userId', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT id, appointment_id, notification_type, title, message, is_read, created_at
             FROM notifications
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 20`,
            [req.params.userId]
        );
        res.status(200).json(rows);
    } catch (err) {
        console.error('Notification fetch error:', err);
        res.status(500).json({ message: 'Failed to fetch notifications.' });
    }
});

app.put('/api/notifications/:notificationId/read', async (req, res) => {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ message: 'User is required.' });
    try {
        await db.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [req.params.notificationId, user_id]);
        res.status(200).json({ message: 'Notification marked as read.' });
    } catch (err) {
        console.error('Notification read error:', err);
        res.status(500).json({ message: 'Failed to update notification.' });
    }
});

// Staff can flag an appointment only after its scheduled time plus the 15-minute grace period.
app.put('/api/appointments/:appointmentId/late-no-show', async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT a.id, a.user_id, a.status, a.service_type, a.dentist_name, a.appointment_date, a.appointment_time, u.first_name, u.email
             FROM appointments a JOIN users u ON u.id = a.user_id WHERE a.id = $1`,
            [req.params.appointmentId]
        );
        if (!rows.length) return res.status(404).json({ message: 'Appointment not found.' });
        const appointment = rows[0];
        if (!['Confirmed', 'Late / No Show'].includes(appointment.status)) {
            return res.status(400).json({ message: 'Only confirmed appointments can be marked late/no show.' });
        }
        if (appointment.status === 'Confirmed') {
            await db.query("UPDATE appointments SET status = 'Late / No Show' WHERE id = $1", [appointment.id]);
        }
        const title = 'Appointment marked Late / No Show';
        const message = `Your ${appointment.service_type} appointment on ${formatAppointmentDate(appointment.appointment_date)} at ${appointment.appointment_time} was marked Late / No Show. You may cancel it or request to reschedule.`;
        const inserted = await db.query(
            `INSERT INTO notifications (user_id, appointment_id, notification_type, title, message)
             SELECT $1, $2, 'appointment_late_no_show', $3, $4
             WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = $1 AND appointment_id = $2 AND notification_type = 'appointment_late_no_show')`,
            [appointment.user_id, appointment.id, title, message]
        );
        if (inserted.rowCount > 0) {
            try {
                await transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: appointment.email,
                    subject: 'OraVista - Action needed for your appointment',
                    html: `<div style="font-family: Arial, sans-serif; padding: 20px; color: #001166;"><h2>King Epres Dental Clinic</h2><p>Hello ${appointment.first_name},</p><p>Your <strong>${appointment.service_type}</strong> appointment on <strong>${formatAppointmentDate(appointment.appointment_date)} at ${appointment.appointment_time}</strong> was marked Late / No Show after the 15-minute grace period.</p><p>Please sign in to OraVista to cancel the appointment or request a new schedule.</p></div>`
                });
            } catch (emailError) {
                console.error('Late/no-show email error:', emailError);
            }
        }
        res.status(200).json({ message: 'Appointment marked Late / No Show.' });
    } catch (err) {
        console.error('Late/no-show update error:', err);
        res.status(500).json({ message: 'Failed to mark appointment late/no show.' });
    }
});

app.put('/api/appointments/:appointmentId/cancel', async (req, res) => {
    const { user_id, expected_status } = req.body || {};
    if (!user_id) return res.status(400).json({ message: 'User is required.' });
    try {
        const { rows } = await db.query(
            `UPDATE appointments SET status = 'Cancelled', reschedule_requested_date = NULL,
             reschedule_requested_time = NULL
             WHERE id = $1 AND user_id = $2
               AND status IN ('Pending', 'Approved', 'Confirmed', 'Late / No Show')
               AND ($3::text IS NULL OR status = $3) RETURNING *`,
            [req.params.appointmentId, user_id, expected_status || null]
        );
        if (!rows.length) return res.status(409).json({ message: 'The appointment changed or cannot be cancelled. Refresh the list and try again.' });
        res.status(200).json({ message: 'Appointment cancelled.', appointment: rows[0] });
    } catch (err) {
        console.error('Appointment cancellation error:', err);
        res.status(500).json({ message: 'Failed to cancel appointment.' });
    }
});

// Invoke once per day with Cloud Scheduler using the x-cron-secret header.
app.post('/api/jobs/send-appointment-reminders', async (req, res) => {
    if (!process.env.REMINDER_CRON_SECRET || req.get('x-cron-secret') !== process.env.REMINDER_CRON_SECRET) return res.status(401).json({ message: 'Unauthorized.' });
    try {
        const { rows } = await db.query(`
            SELECT a.id, a.service_type, a.dentist_name, a.appointment_date, a.appointment_time, u.first_name, u.email
            FROM appointments a JOIN users u ON u.id = a.user_id
            WHERE a.status = 'Confirmed'
              AND a.appointment_date = ((NOW() AT TIME ZONE '${CLINIC_TIME_ZONE}')::date + 1)
              AND a.reminder_email_sent_at IS NULL
        `);
        let sent = 0;
        for (const appointment of rows) {
            try {
                await transporter.sendMail({
                    from: process.env.EMAIL_USER, to: appointment.email,
                    subject: 'OraVista - Appointment reminder for tomorrow',
                    html: `<div style="font-family: Arial, sans-serif; padding: 20px; color: #001166;"><h2>King Epres Dental Clinic</h2><p>Hello ${appointment.first_name},</p><p>This is a reminder that your <strong>${appointment.service_type}</strong> appointment is tomorrow.</p><p><strong>Date:</strong> ${formatAppointmentDate(appointment.appointment_date)}<br/><strong>Time:</strong> ${appointment.appointment_time}<br/><strong>Dentist:</strong> ${appointment.dentist_name}</p></div>`
                });
                await db.query('UPDATE appointments SET reminder_email_sent_at = NOW() WHERE id = $1 AND reminder_email_sent_at IS NULL', [appointment.id]);
                sent += 1;
            } catch (emailError) {
                console.error(`Reminder email error for appointment ${appointment.id}:`, emailError);
            }
        }
        res.status(200).json({ message: 'Reminder job finished.', sent, matched: rows.length });
    } catch (err) {
        console.error('Reminder job error:', err);
        res.status(500).json({ message: 'Failed to send appointment reminders.' });
    }
});

// Direct clinic rescheduling uses the same dates and start times as StaffBookingPage.
function clinicRescheduleDates() {
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const first = new Date(`${today}T00:00:00Z`);
    const end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 3, 1));
    const dates = [];
    for (const day = new Date(first); day < end; day.setUTCDate(day.getUTCDate() + 1)) {
        dates.push(day.toISOString().slice(0, 10));
    }
    return dates;
}
function clinicRescheduleTimes(date) {
    const times = ['10:00 AM', '10:30 AM', '11:00 AM', '11:30 AM', '01:00 PM',
        '01:30 PM', '02:00 PM', '02:30 PM', '03:00 PM', '03:30 PM', '04:00 PM', '04:30 PM'];
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) times.push('05:00 PM');
    return times;
}
async function checkClinicRescheduleActor(actorId) {
    if (!/^\d+$/.test(String(actorId || ''))) throw appointmentError('Please sign in as admin or staff.', 403);
    // Legacy API identity convention: this checks a stored role, not a verified session.
    const { rows } = await db.query('SELECT role FROM users WHERE id = $1', [actorId]);
    if (!rows[0] || !['admin', 'staff'].includes(String(rows[0].role).toLowerCase())) {
        throw appointmentError('Only admin and staff may reschedule appointments directly.', 403);
    }
}
function checkClinicRescheduleStatus(appointment) {
    if (!appointment) throw appointmentError('Appointment not found.', 404);
    if (!['Confirmed', 'Late / No Show'].includes(appointment.status)) {
        throw appointmentError('Only confirmed or late/no-show appointments can be rescheduled directly. Refresh the appointment list.', 409);
    }
}

app.get('/api/clinic/appointments/:appointmentId/reschedule-options', async (req, res) => {
    try {
        await checkClinicRescheduleActor(req.query.actor_id);
        const { rows } = await db.query(
            `SELECT a.*, to_char(a.appointment_date, 'YYYY-MM-DD') AS original_day,
             CONCAT(u.first_name, ' ', u.last_name) AS patient_name
             FROM appointments a LEFT JOIN users u ON u.id = a.user_id WHERE a.id = $1`,
            [req.params.appointmentId]
        );
        const appointment = rows[0];
        checkClinicRescheduleStatus(appointment);
        const dates = clinicRescheduleDates();
        const selectedDate = req.query.date || (dates.includes(appointment.original_day) ? appointment.original_day : dates[0]);
        if (!dates.includes(selectedDate)) throw appointmentError('Please choose a date from the available booking calendar.');
        const { rows: occupied } = await db.query(
            `SELECT appointment_time AS time, service_type FROM appointments
             WHERE appointment_date = $1 AND dentist_name = $2 AND id <> $3
               AND COALESCE(status, 'Pending') NOT IN ('Cancelled', 'Canceled', 'Denied')
             UNION ALL
             SELECT reschedule_requested_time AS time, service_type FROM appointments
             WHERE reschedule_requested_date = $1 AND dentist_name = $2 AND id <> $3
               AND status = 'Reschedule Requested'`,
            [selectedDate, appointment.dentist_name, appointment.id]
        );
        const duration = appointmentDuration(appointment.service_type);
        const slots = clinicRescheduleTimes(selectedDate).map(time => {
            const start = slotMinutes(time);
            const past = new Date(`${selectedDate}T00:00:00+08:00`).getTime() + start * 60000 <= Date.now();
            const conflict = occupied.some(other => {
                const otherStart = slotMinutes(other.time);
                return otherStart === null || (start < otherStart + appointmentDuration(other.service_type) && start + duration > otherStart);
            });
            return { time, available: !past && !conflict, reason: past ? 'Past' : conflict ? 'Occupied' : '' };
        });
        res.json({
            appointment: {
                id: appointment.id, booking_ref: appointment.booking_ref, user_id: appointment.user_id,
                patient_name: appointment.patient_name, branch: appointment.branch,
                service_type: appointment.service_type, dentist_name: appointment.dentist_name,
                appointment_date: appointment.original_day, appointment_time: appointment.appointment_time,
                status: appointment.status, amount: appointment.amount, duration
            },
            dates, date: selectedDate, slots
        });
    } catch (err) {
        console.error('Clinic reschedule options error:', err);
        res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Unable to load rescheduling options. Please refresh.' });
    }
});

app.put('/api/clinic/appointments/:appointmentId/reschedule', async (req, res) => {
    const { actor_id, appointment_date, appointment_time, expected_status, expected_date, expected_time } = req.body || {};
    try {
        await checkClinicRescheduleActor(actor_id);
        if (!expected_status || !expected_date || !expected_time) throw appointmentError('Please reopen the reschedule form before saving.', 409);
        validateRequestedSlot(appointment_date, appointment_time);
        if (!clinicRescheduleDates().includes(appointment_date) || !clinicRescheduleTimes(appointment_date).includes(appointment_time)) {
            throw appointmentError('Please choose a date and time from the booking schedule.');
        }
        const result = await withAppointmentWrite(async client => {
            const { rows } = await client.query(
                `SELECT *, to_char(appointment_date, 'YYYY-MM-DD') AS original_day
                 FROM appointments WHERE id = $1 FOR UPDATE`, [req.params.appointmentId]
            );
            const current = rows[0];
            checkClinicRescheduleStatus(current);
            if (current.status !== expected_status || current.original_day !== expected_date ||
                slotMinutes(current.appointment_time) !== slotMinutes(expected_time)) {
                throw appointmentError('This appointment changed while the form was open. Close the form, refresh the list, and try again.', 409);
            }
            if (current.original_day === appointment_date && slotMinutes(current.appointment_time) === slotMinutes(appointment_time)) {
                throw appointmentError('Please choose a different date or time.');
            }
            await assertAppointmentSlotAvailable(client, appointment_date, appointment_time, current.dentist_name, current.service_type, current.id);
            const { rows: updated } = await client.query(
                `UPDATE appointments SET appointment_date = $1, appointment_time = $2,
                 status = 'Confirmed', reschedule_requested_date = NULL, reschedule_requested_time = NULL,
                 reminder_email_sent_at = NULL WHERE id = $3 RETURNING *`,
                [appointment_date, appointment_time, current.id]
            );
            const { rows: patients } = await client.query('SELECT first_name, email FROM users WHERE id = $1', [current.user_id]);
            const oldSchedule = `${formatAppointmentDate(current.original_day)} at ${appointmentTimeWithSeconds(current.appointment_time)}`;
            const newSchedule = `${formatAppointmentDate(appointment_date)} at ${appointmentTimeWithSeconds(appointment_time)}`;
            const amount = Number(current.amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const message = `The clinic has rescheduled your ${current.service_type} appointment with ${current.dentist_name}. Previous schedule: ${oldSchedule}. New schedule: ${newSchedule}. Branch: ${current.branch || 'Main Branch'}. Base price: ₱${amount}. Status: Confirmed.`;
            await client.query(
                `INSERT INTO notifications (user_id, appointment_id, notification_type, title, message)
                 VALUES ($1, $2, $3, 'Appointment Rescheduled', $4)`,
                [current.user_id, current.id, `reschedule_approved_${crypto.randomBytes(12).toString('hex')}`, message]
            );
            return { appointment: updated[0], patient: patients[0] || {}, message };
        });
        let emailSent = false;
        try {
            if (!result.patient.email) throw new Error('Patient email is missing.');
            await transporter.sendMail({
                from: process.env.EMAIL_USER, to: result.patient.email,
                subject: 'OraVista - Appointment Rescheduled',
                html: `<div style="font-family: Arial, sans-serif; padding: 20px; color: #001166;"><h2>King Epres Dental Clinic</h2><p>Hello ${escapeAppointmentHtml(result.patient.first_name)},</p><p>${escapeAppointmentHtml(result.message)}</p><p>You can view your updated appointment in OraVista.</p></div>`
            });
            emailSent = true;
        } catch (error) {
            console.error('Clinic reschedule email error:', error);
        }
        res.json({
            message: 'Appointment rescheduled and confirmed. The patient dashboard notification has been saved.',
            appointment: result.appointment, email_sent: emailSent,
            warning: emailSent ? null : 'The appointment was saved, but its email could not be sent. Please check the server email logs.'
        });
    } catch (err) {
        console.error('Clinic reschedule error:', err);
        res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Unable to reschedule the appointment. Please refresh the appointment list before retrying.' });
    }
});

// Patient reschedule requests are stored separately until staff approves them.
app.post('/api/request-reschedule', async (req, res) => {
    const { appointment_id, user_id, requested_date, requested_time } = req.body || {};
    if (!appointment_id || !user_id || !requested_date || !requested_time) {
        return res.status(400).json({ message: 'Appointment, date, and time are required.' });
    }
    try {
        validateRequestedSlot(requested_date, requested_time);
        const appointment = await withAppointmentWrite(async (client) => {
            const { rows } = await client.query(
                `SELECT * FROM appointments WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                [appointment_id, user_id]
            );
            if (!rows.length) throw appointmentError('Appointment not found.', 404);
            const current = rows[0];
            if (!['Confirmed', 'Late / No Show'].includes(current.status)) {
                throw appointmentError('Only confirmed or late/no-show appointments can be rescheduled.', 409);
            }
            await assertAppointmentSlotAvailable(client, requested_date, requested_time, current.dentist_name, current.service_type, current.id);
            const { rows: updated } = await client.query(
                `UPDATE appointments SET reschedule_requested_date = $1, reschedule_requested_time = $2,
                 status = 'Reschedule Requested' WHERE id = $3 RETURNING *`,
                [requested_date, requested_time, appointment_id]
            );
            return updated[0];
        });
        res.status(200).json({ message: 'Reschedule request submitted for staff review.', appointment });
    } catch (err) {
        console.error('Reschedule request error:', err);
        res.status(err.statusCode || 500).json({ message: err.statusCode ? err.message : 'Failed to save the reschedule request.' });
    }
});

// Staff billing: retrieve appointments with the patient details needed for billing.
app.get('/api/staff/billings', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT a.*, u.first_name, u.last_name, u.age, u.sex, u.email
            FROM appointments a
            JOIN users u ON u.id = a.user_id
            WHERE a.status IN ('Approved', 'Confirmed', 'Completed')
            ORDER BY a.appointment_date DESC, a.id DESC
        `);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Staff billing fetch error:', err);
        res.status(500).json({ message: 'Failed to fetch billing records.' });
    }
});

// Staff billing: save receipt customisation and publish the billing status to the patient.
app.put('/api/staff/billings/:appointmentId', async (req, res) => {
    const { appointmentId } = req.params;
    const { billing_status, amount, service_type, receipt_details } = req.body;
    const allowedStatuses = ['Pending', 'Approved', 'Denied', 'Paid'];

    if (!allowedStatuses.includes(billing_status)) {
        return res.status(400).json({ message: 'Invalid billing status.' });
    }

    const details = receiptObject(receipt_details);
    const charge = Number(amount), paid = Number(details.paid || 0);
    if (amount === '' || amount == null || !Number.isFinite(charge) || charge < 0 ||
        !Number.isFinite(paid) || paid < 0 || paid > charge ||
        typeof service_type !== 'string' || !service_type.trim() ||
        (billing_status === 'Paid' && paid !== charge)) {
        return res.status(400).json({ message: 'Enter a valid charge, payment and service. Paid bills require full payment.' });
    }
    const normalizedReceipt = { ...details, procedure: service_type.trim(), charge: charge.toFixed(2), paid: paid.toFixed(2), balance: (charge - paid).toFixed(2) };
    try {
        const { rows } = await db.query(
            `UPDATE appointments
             SET billing_status = $1,
                 amount = $2,
                 service_type = $3,
                 receipt_details = $4::jsonb
             WHERE id = $5
             RETURNING *`,
            [billing_status, charge, service_type.trim(), JSON.stringify(normalizedReceipt), appointmentId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Appointment not found.' });
        }
        res.status(200).json({ message: `Billing marked as ${billing_status}.`, appointment: rows[0] });
    } catch (err) {
        console.error('Staff billing update error:', err);
        res.status(500).json({ message: 'Failed to update billing record.' });
    }
});

app.get('/api/appointments/check-availability', async (req, res) => {
    const { date, dentist, excludeAppointmentId } = req.query;
    try {
        const { rows } = await db.query(
            `SELECT appointment_time AS time, service_type AS service FROM appointments
             WHERE appointment_date = $1 AND dentist_name = $2
               AND ($3::integer IS NULL OR id <> $3)
               AND COALESCE(status, 'Pending') NOT IN ('Cancelled', 'Canceled', 'Denied')
             UNION ALL
             SELECT reschedule_requested_time AS time, service_type AS service FROM appointments
             WHERE reschedule_requested_date = $1 AND dentist_name = $2
               AND ($3::integer IS NULL OR id <> $3) AND status = 'Reschedule Requested'`,
            [date, dentist, excludeAppointmentId || null]
        );
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ message: 'Error checking availability' });
    }
});


// Mobile compatibility alias for the same shared appointment availability data.
app.get('/api/booked-times', async (req, res) => {
    const { date, dentist, excludeAppointmentId } = req.query;
    if (!date || !dentist) {
        return res.status(400).json({ message: "Date and dentist are required." });
    }

    const normalizedDentist = normalizeBookingDentist(dentist);

    try {
        const { rows } = await db.query(
            `SELECT appointment_time, service_type FROM appointments
             WHERE appointment_date = $1 AND dentist_name = $2
               AND ($3::integer IS NULL OR id <> $3)
               AND COALESCE(status, 'Pending') NOT IN ('Cancelled', 'Canceled', 'Denied')
             UNION ALL
             SELECT reschedule_requested_time AS appointment_time, service_type FROM appointments
             WHERE reschedule_requested_date = $1 AND dentist_name = $2
               AND ($3::integer IS NULL OR id <> $3) AND status = 'Reschedule Requested'`,
            [date, normalizedDentist, excludeAppointmentId || null]
        );

        const mobileCompatible = rows.map((appointment) => ({
            ...appointment,
            service_type: mobileBookingServiceName(appointment.service_type),
            service: mobileBookingServiceName(appointment.service_type),
            time: appointment.appointment_time
        }));

        return res.status(200).json(mobileCompatible);
    } catch (err) {
        console.error("Booked Times Error:", err);
        return res.status(500).json({ message: "Error checking availability." });
    }
});

// Mobile compatibility: patient billing summary from the same appointments table.
app.get('/api/user-billings/:userId', async (req, res) => {
    const { userId } = req.params;

    try {
        const { rows } = await db.query(
            `SELECT a.id, a.user_id, a.booking_ref, a.service_type, a.amount, a.billing_status, a.appointment_date, a.receipt_details, u.first_name, u.last_name
             FROM appointments a JOIN users u ON u.id = a.user_id
             WHERE a.user_id = $1
             ORDER BY a.appointment_date DESC, a.id DESC`,
            [userId]
        );

        const published = rows.filter(record => ['Pending', 'Approved', 'Paid'].includes(record.billing_status));
        const totalOutstanding = Math.round(published.reduce((sum, record) => sum + (isPublished(record) ? amounts(record).balance : 0), 0) * 100) / 100;
        const records = [];
        // Sequential work bounds storage requests even for long billing histories.
        for (const record of published) {
            let invoice_path = null;
            try { invoice_path = await invoiceUrl(record); }
            catch (error) { console.error('Invoice generation failed for bill', record.id, error.message); }
            records.push({
                id: record.id,
                title: record.service_type,
                amount: amounts(record).charge,
                paid: amounts(record).paid,
                balance: amounts(record).balance,
                status: record.billing_status,
                date: new Date(record.appointment_date).toLocaleDateString('en-US', {
                    month: 'long', day: '2-digit', year: 'numeric'
                }),
                invoice_path,
                invoice_available: Boolean(invoice_path),
            });
        }

        return res.status(200).json({ records, totalOutstanding });
    } catch (err) {
        console.error("User Billings Error:", err);
        return res.status(500).json({ message: "Error fetching bills" });
    }
});

// ---------------------------------------------------------
// PORTAL DASHBOARD & LISTS (ADMIN / STAFF / DENTIST)
// ---------------------------------------------------------

app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const { rows: todayRows } = await db.query("SELECT COUNT(*) as count FROM appointments WHERE DATE(appointment_date) = CURRENT_DATE");
        const { rows: totalDentistsRows } = await db.query("SELECT COUNT(*) as count FROM users WHERE role = 'dentist'");
        const { rows: busyDentistsRows } = await db.query(`SELECT COUNT(DISTINCT dentist_name) as count FROM appointments WHERE DATE(appointment_date) = CURRENT_DATE AND status = 'Confirmed'`);
        const { rows: monthPatientsRows } = await db.query(`SELECT COUNT(DISTINCT user_id) as count FROM appointments WHERE EXTRACT(MONTH FROM appointment_date) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM appointment_date) = EXTRACT(YEAR FROM CURRENT_DATE)`);

        const { rows: scheduleRows } = await db.query(`
            SELECT a.id, a.booking_ref, a.appointment_time, a.appointment_date, a.dentist_name, a.status, a.service_type, a.created_at,
            to_char(a.reschedule_requested_date, 'YYYY-MM-DD') AS requested_date, a.reschedule_requested_time,
            CONCAT(u.first_name, ' ', u.last_name) as patient_name
            FROM appointments a
            LEFT JOIN users u ON a.user_id = u.id
            ORDER BY a.created_at ASC, a.id ASC
        `);

        res.json({
            todayCount: todayRows[0].count,
            totalDentists: totalDentistsRows[0].count,
            availableDentists: totalDentistsRows[0].count - busyDentistsRows[0].count,
            monthPatients: monthPatientsRows[0].count,
            schedule: scheduleRows.map(row => ({
                id: row.id,
                booking_ref: row.booking_ref,
                time: row.appointment_time,
                date: row.appointment_date,
                dentist: row.dentist_name,
                patientName: row.patient_name || "Guest",
                status: row.status,
                serviceType: row.service_type,
                bookedAt: row.created_at,
                requestedDate: row.requested_date,
                requestedTime: row.reschedule_requested_time
            }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to fetch stats." });
    }
});

app.get('/api/dashboard/branch-earnings', async (req, res) => {
    try {
        const query = `
            SELECT branch, SUM(amount) as total_earnings 
            FROM appointments 
            WHERE status != 'Cancelled'
            GROUP BY branch
        `;
        const { rows: results } = await db.query(query);

        const earningsObj = {};
        results.forEach(row => {
            earningsObj[row.branch || "Unknown Branch"] = row.total_earnings || 0;
        });

        res.status(200).json(earningsObj);
    } catch (err) {
        console.error("Earnings API Error:", err);
        res.status(500).json({ message: "Failed to fetch earnings." });
    }
});

app.get('/api/patients/search', async (req, res) => {
    const queryStr = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    try {
        let queryText = '';
        let queryParams = [];

        if (queryStr !== '') {
            queryText = `
                SELECT * FROM users 
                WHERE role = 'patient' 
                  AND (first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1)
                ORDER BY last_name ASC, first_name ASC
                LIMIT $2 OFFSET $3
            `;
            queryParams = [`%${queryStr}%`, limit, offset];
        } else {
            queryText = `
                SELECT * FROM users 
                WHERE role = 'patient'
                ORDER BY last_name ASC, first_name ASC
                LIMIT $1 OFFSET $2
            `;
            queryParams = [limit, offset];
        }

        const { rows: patients } = await db.query(queryText, queryParams);

        // Security check: exclude sensitive password hashes before returning
        patients.forEach(patient => {
            delete patient.password;
        });

        res.status(200).json(patients);
    } catch (err) {
        console.error("❌ Error searching patients:", err);
        res.status(500).json({ message: "Failed to search patients." });
    }
});

app.get('/api/patients', async (req, res) => {
    try {
        const query = `
            SELECT id, CONCAT(first_name, ' ', last_name) AS name, email, age, phone AS contact, 
            blood_type, allergies, insurance, policy_number, branch,
            (SELECT MAX(appointment_date) FROM appointments WHERE appointments.user_id = users.id) AS lastVisit 
            FROM users 
            WHERE role = 'patient' 
            ORDER BY last_name ASC
        `;
        const { rows: patients } = await db.query(query);
        res.status(200).json(patients);
    } catch (err) {
        res.status(500).json({ message: "Failed to fetch patients list." });
    }
});

app.get('/api/dentists', async (req, res) => {
    try {
        const query = `
            SELECT 
                u.id, u.first_name, u.last_name, u.specialty, u.status AS manual_status, u.branch,
                (SELECT COUNT(*) FROM appointments a WHERE a.dentist_name ILIKE CONCAT('%', u.last_name, '%')) AS patient_count,
                CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM appointments a 
                        WHERE a.dentist_name ILIKE CONCAT('%', u.last_name, '%') 
                        AND DATE(a.appointment_date) = CURRENT_DATE
                        AND a.status = 'Confirmed'
                    ) THEN 'Busy'
                    ELSE COALESCE(u.status, 'Available')
                END AS status
            FROM users u
            WHERE u.role = 'dentist'
            ORDER BY u.last_name ASC
        `;
        const { rows: dentists } = await db.query(query);
        res.status(200).json(dentists);
    } catch (err) {
        console.error("Fetch Dentists Error:", err);
        res.status(500).json({ message: "Failed to fetch dentists list." });
    }
});

app.get('/api/dentist-profile/:id', async (req, res) => {
    const dentistId = req.params.id;
    try {
        const { rows: dentistRows } = await db.query(
            `SELECT id, first_name, last_name, email, specialty, status, phone, branch,
            (SELECT COUNT(DISTINCT user_id) FROM appointments WHERE dentist_name ILIKE CONCAT('%', last_name, '%')) as patient_count,
            (SELECT COUNT(*) FROM appointments WHERE dentist_name ILIKE CONCAT('%', last_name, '%') AND status = 'Completed') as procedures_count
            FROM users WHERE id = $1 AND role = 'dentist'`,
            [dentistId]
        );

        if (dentistRows.length === 0) return res.status(404).json({ message: "Dentist not found" });

        const dentist = dentistRows[0];

        const { rows: patientRows } = await db.query(`
            SELECT DISTINCT u.id, CONCAT(u.first_name, ' ', u.last_name) as name, 
            a.service_type as case_type, 
            (SELECT MAX(appointment_date) FROM appointments WHERE user_id = u.id) as last_visit
            FROM users u
            JOIN appointments a ON u.id = a.user_id
            WHERE a.dentist_name ILIKE CONCAT('%', $1, '%')
            LIMIT 5`,
            [dentist.last_name]
        );

        const { rows: scheduleRows } = await db.query(`
            SELECT a.appointment_time, CONCAT(u.first_name, ' ', u.last_name) as patient_name, a.service_type as type
            FROM appointments a
            LEFT JOIN users u ON a.user_id = u.id
            WHERE a.dentist_name ILIKE CONCAT('%', $1, '%') 
            AND DATE(a.appointment_date) = CURRENT_DATE
            ORDER BY a.appointment_time ASC`,
            [dentist.last_name]
        );

        res.json({
            profile: dentist,
            patients: patientRows,
            schedule: scheduleRows.map(row => ({
                time: row.appointment_time,
                patientName: row.patient_name || "Guest",
                type: row.type
            }))
        });
    } catch (err) {
        console.error("Dentist Profile API Error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
});

// ---------------------------------------------------------
// AI DIAGNOSTICS ROUTES
// ---------------------------------------------------------

app.post('/api/save-diagnosis', async (req, res) => {
    const { patient_id, clinical_notes, ai_findings } = req.body;

    const findingsJson = JSON.stringify(ai_findings);

    try {
        const query = `
            INSERT INTO ai_diagnostics (patient_id, clinical_notes, ai_findings) 
            VALUES ($1, $2, $3)
        `;

        await db.query(query, [patient_id, clinical_notes, findingsJson]);

        res.status(201).json({
            status: "success",
            message: "Diagnostic record saved successfully!"
        });
    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).json({
            status: "error",
            message: "Failed to save diagnosis"
        });
    }
});

// ---------------------------------------------------------
// START SERVER
// ---------------------------------------------------------
const PORT = process.env.PORT || 5000;
authStore.initialize().then(() => app.listen(PORT, () => {
    console.log(`OraVista Backend running on http://localhost:${PORT}`);
})).catch(error => { console.error('Authentication storage initialization failed. Check database permissions.', error.message); process.exitCode=1; db.end(); });
