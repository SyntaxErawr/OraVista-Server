const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

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

app.use(cors({
    origin: [
        "http://localhost:3000",   // React local
        "http://localhost:5173",   // Vite local
        "https://oravista.vercel.app", // Deployment preview
        "https://ora-vista-web.vercel.app",
        "https://oravista.site"
    ],
    credentials: true,
    methods: ["*"],
    allowedHeaders: ["*"]
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
        const { rows: existingUser } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existingUser.length > 0) {
            return res.status(400).json({ message: "Email already registered." });
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

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // 1. Fetch User
        const { rows: users } = await db.query('SELECT * FROM users WHERE email = $1', [email]);

        // Log for debugging: See if the email even exists in the DB
        console.log(`Login attempt for: ${email}`);

        if (users.length === 0) {
            console.log("❌ Error: Email not found in database.");
            return res.status(401).json({ message: "Invalid email or password." });
        }

        const user = users[0];

        // 2. Handle Plain-Text Seed Data (ID 81-86)
        // If the DB password isn't a valid bcrypt hash (starts with $2b$), 
        // we do a direct string comparison for your dummy data.
        let isMatch = false;
        if (!user.password.startsWith('$2b$')) {
            console.log("⚠️ Warning: Non-bcrypt password detected in DB. Using direct match.");
            isMatch = (password === user.password);
        } else {
            // 3. Normal Bcrypt Comparison
            isMatch = await bcrypt.compare(password, user.password);
        }

        if (!isMatch) {
            console.log("❌ Error: Password mismatch.");
            return res.status(401).json({ message: "Invalid email or password." });
        }

        console.log("✅ Success: Login verified for", user.role);

        // 4. Successful Response
        res.status(200).json({
            message: "Login successful",
            user: {
                id: user.id,
                firstName: user.first_name,
                lastName: user.last_name,
                email: user.email,
                sex: user.sex ?? "",
                dob: user.dob instanceof Date
                    ? `${user.dob.getFullYear()}-${String(user.dob.getMonth() + 1).padStart(2, "0")}-${String(user.dob.getDate()).padStart(2, "0")}`
                    : (user.dob ? String(user.dob).slice(0, 10) : ""),
                age: user.age ?? "",
                phone: user.phone ?? "",
                occupation: user.occupation ?? "",
                role: user.role,
                branch: user.branch || "",
                profile_picture: user.profile_picture || ""
            }
        });

    } catch (err) {
        console.error("🔥 Server Error:", err);
        res.status(500).json({ message: "Server error." });
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

app.put('/api/reset-password-by-email', async (req, res) => {
    const { email, newPassword } = req.body;
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        await db.query('UPDATE users SET password = $1 WHERE email = $2', [hashedPassword, email]);
        res.status(200).json({ message: "Password updated successfully!" });
    } catch (err) {
        res.status(500).json({ message: "Server error." });
    }
});

// ---------------------------------------------------------
// OTP / DYNAMIC EMAIL ROUTE
// ---------------------------------------------------------
app.post('/api/send-otp', async (req, res) => {
    const { email, action } = req.body;

    try {
        const { rows: users } = await db.query('SELECT first_name FROM users WHERE email = $1', [email]);
        if (users.length === 0) {
            return res.status(404).json({ message: "Email not found in our system." });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        let emailSubject = '';
        let emailBodyContext = '';

        if (action === 'change_password') {
            emailSubject = 'OraVista - Change Password Request';
            emailBodyContext = 'This is a change password request. You have initiated a request to change your current password from within your account settings. To authorize and confirm this security change, please use the code below.';
        } else if (action === 'login') {
            emailSubject = 'OraVista - Login Verification';
            emailBodyContext = 'This is a login verification. A new sign-in attempt was detected for your OraVista account. To verify your identity and complete the login process, please enter the security code below.';
        } else if (action === 'forgot_password') {
            emailSubject = 'OraVista - Forgot Password Request';
            emailBodyContext = 'This is a forgot password request. We received a request to recover your OraVista account because you forgot your password. Please use the verification code below to gain access and set a new password.';
        } else {
            emailSubject = 'OraVista - Forgot Password Request';
            emailBodyContext = 'This is a forgot password request. We received a request to reset the password for your account. Please use the verification code below to proceed.';
        }

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: emailSubject,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #001166;">
                    <h2>King Epres Dental Clinic</h2>
                    <p>Hello ${users[0].first_name},</p>
                    <p>${emailBodyContext}</p>
                    <h1 style="background: #f4f4f4; padding: 10px; display: inline-block; letter-spacing: 5px;">${otp}</h1>
                    <p>This code will expire shortly.</p>
                    <p>If you did not initiate this request, please secure your account immediately and ignore this email.</p>
                </div>
            `
        };

        // Check if the system is running in development mode
        if (process.env.ENVIRONMENT === 'local') {
            console.log(`\n[DEV MODE] Bypass active. OTP for ${email} is: ${otp}\n`);
        } else {
            // Live email delivery for dev and production
            await transporter.sendMail(mailOptions);
        }

        res.status(200).json({ message: "OTP sent successfully!", generatedOtp: otp });

    } catch (err) {
        console.error("Email Error:", err);
        res.status(500).json({ message: "Failed to send email." });
    }
});

// ---------------------------------------------------------
// PROFILE & SETTINGS ROUTES
// ---------------------------------------------------------

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

app.put('/api/update-password', async (req, res) => {
    const { id, oldPassword, newPassword } = req.body;
    try {
        const { rows: users } = await db.query('SELECT password FROM users WHERE id = $1', [id]);
        const isMatch = await bcrypt.compare(oldPassword, users[0].password);
        if (!isMatch) return res.status(401).json({ message: "Incorrect old password." });
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        await db.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, id]);
        res.status(200).json({ message: "Password updated successfully!" });
    } catch (err) {
        res.status(500).json({ message: "Server error." });
    }
});

app.post('/api/upload-profile-picture', upload.single('profileImage'), async (req, res) => {
    const { userId } = req.body;

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
            `SELECT id, patient_id, clinical_notes, ai_findings, scan_date
             FROM ai_diagnostics
             WHERE patient_id = $1
               AND ai_findings::jsonb ->> 'human_verified' = 'true'
             ORDER BY scan_date DESC NULLS LAST, id DESC`,
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
    const { user_id, service_type, dentist_name, appointment_date, appointment_time, amount, branch } = req.body;

    try {
        const randomString = crypto.randomBytes(3).toString('hex').toUpperCase();
        const booking_ref = `OV - ${randomString}`;

        const amountToSave = amount || 0.00;
        const branchToSave = branch || "Main Branch";

        const query = `
            INSERT INTO appointments 
            (user_id, booking_ref, service_type, dentist_name, appointment_date, appointment_time, status, amount, branch) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `;

        validateRequestedSlot(appointment_date, appointment_time);
        await withAppointmentWrite(async (client) => {
            await assertAppointmentSlotAvailable(client, appointment_date, appointment_time, dentist_name, service_type);
            await client.query(query, [user_id, booking_ref, service_type, dentist_name, appointment_date, appointment_time, 'Pending', amountToSave, branchToSave]);
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

app.put('/api/update-appointment-status', async (req, res) => {
    const { appointment_id, status, expected_status } = req.body || {};
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
            const scheduledAt = appointmentDateTime(appointment.appointment_date, appointment.appointment_time);
            if (!scheduledAt) return res.status(400).json({ message: 'Appointment time is invalid.' });
            if (Date.now() < scheduledAt.getTime() + (15 * 60 * 1000)) return res.status(400).json({ message: 'The 15-minute grace period has not ended yet.' });
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

    try {
        const { rows } = await db.query(
            `UPDATE appointments
             SET billing_status = $1,
                 amount = $2,
                 service_type = $3,
                 receipt_details = $4::jsonb
             WHERE id = $5
             RETURNING *`,
            [billing_status, Number(amount) || 0, service_type, JSON.stringify(receipt_details || {}), appointmentId]
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
            SELECT a.id, a.booking_ref, a.appointment_time, a.appointment_date, a.dentist_name, a.status, a.service_type,
            to_char(a.reschedule_requested_date, 'YYYY-MM-DD') AS requested_date, a.reschedule_requested_time,
            CONCAT(u.first_name, ' ', u.last_name) as patient_name
            FROM appointments a
            LEFT JOIN users u ON a.user_id = u.id
            ORDER BY a.appointment_date ASC, a.appointment_time ASC
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
app.listen(PORT, () => {
    console.log(`OraVista Backend running on http://localhost:${PORT}`);
});
