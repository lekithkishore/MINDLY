from flask import Flask, request, jsonify
from flask_cors import CORS
import os
from dotenv import load_dotenv
import firebase_admin
from firebase_admin import credentials, firestore
import json
from datetime import datetime
import logging
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# Import custom modules
from chatbot.mental_health_chatbot import MentalHealthChatbot
from assessment.phq9_gad7 import PHQ9GAD7Assessment

# Load environment variables
load_dotenv()

# Version bump for Railway redeploy
VERSION = "1.0.1"

# Initialize Flask app
app = Flask(__name__)
CORS(app)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize Firebase
try:
    if os.getenv('FIREBASE_SERVICE_ACCOUNT_KEY'):
        cred = credentials.Certificate(json.loads(os.getenv('FIREBASE_SERVICE_ACCOUNT_KEY')))
    else:
        cred = credentials.Certificate('firebase-service-account.json')
    
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    logger.info("Firebase initialized successfully")
except Exception as e:
    logger.error(f"Firebase initialization failed: {e}")
    db = None

# Initialize AI components
chatbot = MentalHealthChatbot()
assessment = PHQ9GAD7Assessment()

# -------- Email helper --------
def send_email(to_email: str, subject: str, html_body: str, text_body: str = None):
    """
    Sends an email via SMTP using env vars:
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
    If env vars are not set, this function is a no-op.
    """
    host = os.getenv('SMTP_HOST')
    port = int(os.getenv('SMTP_PORT') or '0')
    user = os.getenv('SMTP_USER')
    password = os.getenv('SMTP_PASS')
    from_email = os.getenv('SMTP_FROM', user or '')
    if not (host and port and from_email and to_email):
        logger.info('Email not sent: SMTP not configured or missing recipient')
        return False
    try:
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = from_email
        msg['To'] = to_email
        if text_body:
            msg.attach(MIMEText(text_body, 'plain'))
        msg.attach(MIMEText(html_body, 'html'))
        with smtplib.SMTP(host, port, timeout=10) as server:
            server.starttls()
            if user and password:
                server.login(user, password)
            server.sendmail(from_email, [to_email], msg.as_string())
        logger.info(f"Email sent to {to_email}")
        return True
    except Exception as e:
        logger.error(f"Failed to send email to {to_email}: {e}")
        return False

# -------- Counsellor API (server-side with service account) --------
@app.route('/api/counsellor/appointments', methods=['GET'])
def list_counsellor_appointments():
    """
    Returns appointments for a counsellor ordered by date/time.
    Query params: counsellorId=<uid>, limit=<n>
    """
    try:
        counsellor_id = request.args.get('counsellorId', '')
        limit_n = int(request.args.get('limit', '100'))
        if not counsellor_id:
            return jsonify({'error': 'counsellorId is required'}), 400
        if not db:
            return jsonify({'appointments': []})

        # Fetch with where only (no server-side order_by to avoid composite index), then sort in Python
        stream = db.collection('appointments') \
            .where('counsellorId', '==', counsellor_id) \
            .limit(limit_n) \
            .stream()
        items = []
        for doc in stream:
            d = doc.to_dict()
            d['id'] = doc.id
            items.append(d)
        # Sort by date then time client-side
        items.sort(key=lambda x: (str(x.get('appointmentDate') or ''), str(x.get('appointmentTime') or '')))
        return jsonify({'appointments': items})
    except Exception as e:
        logger.error(f"list_counsellor_appointments error: {e}")
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/counsellor/appointments/<appointment_id>/start', methods=['PATCH'])
def counsellor_start_appointment(appointment_id):
    """
    Body: { counsellorId: '<uid>' }
    Sets status to 'in_progress' at session start.
    """
    try:
        if not db:
            return jsonify({'error': 'Database not available'}), 500
        data = request.get_json() or {}
        counsellor_id = data.get('counsellorId')
        if not counsellor_id:
            return jsonify({'error': 'counsellorId is required'}), 400

        ref = db.collection('appointments').document(appointment_id)
        snap = ref.get()
        if not snap.exists:
            return jsonify({'error': 'Not found'}), 404
        appt = snap.to_dict()
        if appt.get('counsellorId') != counsellor_id:
            return jsonify({'error': 'Not your appointment'}), 403

        ref.update({'status': 'in_progress', 'updatedAt': datetime.now()})
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"counsellor_start_appointment error: {e}")
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/counsellor/appointments/<appointment_id>/complete', methods=['PATCH'])
def counsellor_complete_appointment(appointment_id):
    """
    Body: { counsellorId: '<uid>' }
    Sets status to 'completed' and notifies the student to leave feedback.
    """
    try:
        if not db:
            return jsonify({'error': 'Database not available'}), 500
        data = request.get_json() or {}
        counsellor_id = data.get('counsellorId')
        if not counsellor_id:
            return jsonify({'error': 'counsellorId is required'}), 400

        ref = db.collection('appointments').document(appointment_id)
        snap = ref.get()
        if not snap.exists:
            return jsonify({'error': 'Not found'}), 404
        appt = snap.to_dict()
        if appt.get('counsellorId') != counsellor_id:
            return jsonify({'error': 'Not your appointment'}), 403

        ref.update({'status': 'completed', 'updatedAt': datetime.now()})

        # Notify student to leave feedback
        student_id = appt.get('studentId') or appt.get('userId')
        student_email = appt.get('studentEmail') or appt.get('email') or ''
        student_name = appt.get('studentName') or ''
        counsellor_name = appt.get('counsellorName') or ''
        date_str = appt.get('appointmentDate') or ''
        time_str = appt.get('appointmentTime') or ''

        subject = "We value your feedback for today's session"
        html_body = f"""
        <div>
          <p>Hi {student_name or 'there'},</p>
          <p>Your session with <strong>{counsellor_name or 'your counsellor'}</strong> on <strong>{date_str}</strong> at <strong>{time_str}</strong> is now marked as <strong>completed</strong>.</p>
          <p>Please open Mindly and leave quick feedback for your counsellor.</p>
          <p>— MINDLY</p>
        </div>
        """
        text_body = f"Hi {student_name or 'there'},\nYour session on {date_str} at {time_str} is completed. Please open Mindly and leave feedback.\n— MINDLY"
        if student_email:
            send_email(student_email, subject, html_body, text_body)

        if student_id:
            try:
                db.collection('notifications').add({
                    'userId': student_id,
                    'type': 'appointment_completed',
                    'title': 'Session completed',
                    'body': 'Please leave quick feedback for your counsellor.',
                    'appointmentId': appointment_id,
                    'createdAt': datetime.now(),
                    'read': False
                })
            except Exception as e:
                logger.warning(f"notify write failed: {e}")

        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"counsellor_complete_appointment error: {e}")
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/counsellor/appointments/<appointment_id>', methods=['DELETE'])
def counsellor_delete_appointment(appointment_id):
    """
    Body JSON: { counsellorId: '<uid>' }
    Hard-cancel: verify ownership, free slot, delete appointment, email + notify student.
    """
    try:
        if not db:
            return jsonify({'error': 'Database not available'}), 500
        data = request.get_json() or {}
        counsellor_id = data.get('counsellorId')
        if not counsellor_id:
            return jsonify({'error': 'counsellorId is required'}), 400

        ref = db.collection('appointments').document(appointment_id)
        snap = ref.get()
        if not snap.exists:
            return jsonify({'success': True})
        appt = snap.to_dict()
        if appt.get('counsellorId') != counsellor_id:
            return jsonify({'error': 'Not your appointment'}), 403

        # Free the availability slot if exists
        date_key = appt.get('appointmentDate')
        time_str = appt.get('appointmentTime')
        owner_id = appt.get('counsellorId')
        if date_key and time_str and owner_id:
            try:
                slot_ref = db.document(f"counsellors/{owner_id}/availability/{date_key}/slots/{time_str}")
                if slot_ref.get().exists:
                    slot_ref.update({
                        'booked': False,
                        'bookedBy': None,
                        'sessionId': None,
                        'updatedAt': datetime.now()
                    })
            except Exception as e:
                logger.warning(f"free slot failed: {e}")

        # Compose student email + notify
        student_id = appt.get('studentId') or appt.get('userId')
        student_email = appt.get('studentEmail') or appt.get('email') or ''
        student_name = appt.get('studentName') or ''
        counsellor_name = appt.get('counsellorName') or ''
        date_str = date_key or ''
        time_disp = time_str or ''

        if not student_email and db and student_id:
            try:
                uref = db.collection('users').document(student_id)
                usnap = uref.get()
                if usnap.exists:
                    u = usnap.to_dict() or {}
                    student_email = u.get('email', '')
                    if not student_name:
                        student_name = u.get('name') or u.get('displayName') or ''
            except Exception as e:
                logger.warning(f"lookup user email failed: {e}")

        subject = f"Your session on {date_str} {time_disp} was cancelled"
        html_body = f"""
        <div>
          <p>Hi {student_name or 'there'},</p>
          <p>Your counselling session with <strong>{counsellor_name or 'your counsellor'}</strong> on <strong>{date_str}</strong> at <strong>{time_disp}</strong> was <strong>cancelled</strong>.</p>
          <p>Please rebook another slot in the app if needed.</p>
          <p>— MINDLY</p>
        </div>
        """
        text_body = f"Hi {student_name or 'there'},\nYour counselling session on {date_str} at {time_disp} was cancelled.\nPlease rebook another slot if needed.\n— MINDLY"
        if student_email:
            send_email(student_email, subject, html_body, text_body)

        if student_id:
            try:
                db.collection('notifications').add({
                    'userId': student_id,
                    'type': 'appointment_deleted',
                    'title': 'Appointment cancelled',
                    'body': f'Your session on {date_str} at {time_disp} was cancelled.',
                    'appointmentId': appointment_id,
                    'createdAt': datetime.now(),
                    'read': False
                })
            except Exception as e:
                logger.warning(f"notify write failed: {e}")

        # Delete the appointment
        ref.delete()
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"counsellor_delete_appointment error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/counsellor/appointments/<appointment_id>/insights', methods=['GET'])
def counsellor_appointment_insights(appointment_id):
    """
    Query params: counsellorId=<uid>
    Returns mood trend (last N days, daily average; default 30, min 7, max 30) and latest PHQ-9/GAD-7 for the student tied to the appointment.
    Ensures the requesting counsellor matches the appointment's counsellorId.
    """
    try:
        if not db:
            return jsonify({'error': 'Database not available'}), 500
        counsellor_id = request.args.get('counsellorId', '')
        if not counsellor_id:
            return jsonify({'error': 'counsellorId is required'}), 400

        appt_ref = db.collection('appointments').document(appointment_id)
        appt_snap = appt_ref.get()
        if not appt_snap.exists:
            return jsonify({'error': 'Appointment not found'}), 404
        appt = appt_snap.to_dict() or {}
        if appt.get('counsellorId') != counsellor_id:
            return jsonify({'error': 'Forbidden'}), 403
        student_id = appt.get('studentId')
        if not student_id:
            return jsonify({'error': 'Appointment missing studentId'}), 400

        # Build mood trend from mood_scores collection (last N days daily avg)
        from datetime import timedelta, timezone
        def to_naive_utc(dt):
            if dt is None:
                return None
            # If tz-aware, convert to UTC then drop tzinfo
            if getattr(dt, 'tzinfo', None) is not None:
                return dt.astimezone(timezone.utc).replace(tzinfo=None)
            return dt
        now = datetime.utcnow()  # naive UTC
        try:
            days_param = int(request.args.get('days', '30'))
        except Exception:
            days_param = 30
        days_param = max(7, min(30, days_param))
        start = now - timedelta(days=days_param)
        fallback = (request.args.get('fallback', 'false').lower() in ('1','true','yes'))
        # Avoid composite index: query by equality only, sort/filter in Python
        daily = {}
        counts = {}

        def add_point(dt, score):
            if dt is None:
                return
            if dt < start:
                return
            day = dt.date().isoformat()
            try:
                val = float(score)
            except Exception:
                return
            daily[day] = daily.get(day, 0.0) + val
            counts[day] = counts.get(day, 0) + 1

        # Source A (primary): mood_scores (exactly what student UI writes via addMoodScore)
        points_before_fallback = 0
        try:
            mood_scores_stream = db.collection('mood_scores').where('userId', '==', student_id).stream()
            for doc in mood_scores_stream:
                d = doc.to_dict() or {}
                ts = d.get('recordedAt') or d.get('createdAt')
                dt = to_naive_utc(ts)
                before = counts.copy()
                add_point(dt, d.get('score'))
                # detect if we added
                if counts != before:
                    points_before_fallback += 1
        except Exception as e:
            logger.warning(f"insights: mood_scores read failed: {e}")

        # Fallback sources only if requested and no primary points in window
        if fallback and points_before_fallback == 0:
            # Source B: moods (user_id/userId, score/mood_score, timestamp/createdAt)
            try:
                for uid_field in ('user_id', 'userId'):
                    moods_stream = db.collection('moods').where(uid_field, '==', student_id).stream()
                    for doc in moods_stream:
                        d = doc.to_dict() or {}
                        ts = d.get('timestamp') or d.get('createdAt')
                        dt = to_naive_utc(ts)
                        score = d.get('score', d.get('mood_score'))
                        add_point(dt, score)
            except Exception as e:
                logger.warning(f"insights: moods read failed: {e}")

            # Source C: chat_conversations sentiment (user_id, sentiment.score, timestamp)
            try:
                chats_stream = db.collection('chat_conversations').where('user_id', '==', student_id).stream()
                for doc in chats_stream:
                    d = doc.to_dict() or {}
                    ts = d.get('timestamp') or d.get('createdAt')
                    dt = to_naive_utc(ts)
                    sent = d.get('sentiment') or {}
                    score = sent.get('score')
                    # If score is [-1,1] or [0,1], normalize to 0-100 conservatively
                    try:
                        fs = float(score)
                        if -1.0 <= fs <= 1.0:
                            norm = (fs + 1.0) / 2.0 * 100.0
                        else:
                            # assume already 0-100 scale
                            norm = fs
                    except Exception:
                        norm = None
                    add_point(dt, norm)
            except Exception as e:
                logger.warning(f"insights: chat_conversations read failed: {e}")
        # Fill last N days list
        days = []
        for i in range(days_param - 1, -1, -1):
            day = (now - timedelta(days=i)).date().isoformat()
            if day in daily and counts.get(day, 0) > 0:
                avg = round(daily[day] / counts[day], 2)
            else:
                avg = None
            days.append({'date': day, 'avg': avg})

        # Latest assessments (PHQ-9 and GAD-7) from 'assessments' (avoid order_by; filter and pick latest in Python)
        latest = {'PHQ-9': None, 'GAD-7': None}
        latest_ts = {'PHQ-9': None, 'GAD-7': None}
        # Query both possible user id field shapes
        for field in ('user_id', 'userId'):
            stream = db.collection('assessments').where(field, '==', student_id).stream()
            for doc in stream:
                a = doc.to_dict() or {}
                t = str(a.get('type') or '').upper()
                if t not in ('PHQ-9', 'GAD-7'):
                    continue
                ts = a.get('timestamp') or a.get('createdAt')
                dt = to_naive_utc(ts)
                key = t
                prev = latest_ts.get(key)
                if prev is None or (dt and prev and dt > prev) or (dt and prev is None):
                    latest_ts[key] = dt
                    latest[key] = {
                        'score': a.get('score'),
                        'severity': a.get('severity') or '',
                    }

        return jsonify({
            'moodTrend': days,
            'assessments': {
                'phq9': latest['PHQ-9'],
                'gad7': latest['GAD-7']
            }
        })
    except Exception as e:
        logger.error(f"appointment_insights error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/counsellor/availability/slot', methods=['POST'])
def counsellor_upsert_availability_slot():
    """
    Body: { counsellorId, dateKey, time }
    Creates or updates a slot document to available (booked: False).
    """
    try:
        if not db:
            return jsonify({'error': 'Database not available'}), 500
        data = request.get_json() or {}
        counsellor_id = data.get('counsellorId')
        date_key = data.get('dateKey')
        time = data.get('time')
        if not counsellor_id or not date_key or not time:
            return jsonify({'error': 'counsellorId, dateKey and time are required'}), 400
        ref = db.document(f"counsellors/{counsellor_id}/availability/{date_key}/slots/{time}")
        ref.set({'time': time, 'booked': False, 'updatedAt': datetime.now()}, merge=True)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"upsert_availability_slot error: {e}")
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/counsellor/appointments/<appointment_id>/status', methods=['PATCH'])
def counsellor_update_status(appointment_id):
    """
    Body: { status: 'approved'|'pending'|'cancelled'|'canceled', counsellorId: '<uid>' }
    """
    try:
        if not db:
            return jsonify({'error': 'Database not available'}), 500
        data = request.get_json() or {}
        status = (data.get('status') or '').lower()
        counsellor_id = data.get('counsellorId')
        if status not in ('pending', 'approved', 'confirmed', 'cancelled', 'canceled'):
            return jsonify({'error': 'Invalid status'}), 400
        if not counsellor_id:
            return jsonify({'error': 'counsellorId is required'}), 400

        ref = db.collection('appointments').document(appointment_id)
        snap = ref.get()
        if not snap.exists:
            return jsonify({'error': 'Not found'}), 404
        appt = snap.to_dict()
        if appt.get('counsellorId') != counsellor_id:
            return jsonify({'error': 'Not your appointment'}), 403
        # Update status
        ref.update({'status': status, 'updatedAt': datetime.now()})

        # Prepare student notification/email
        student_id = appt.get('studentId') or appt.get('userId')
        student_email = appt.get('studentEmail') or appt.get('email') or ''
        student_name = appt.get('studentName') or ''
        counsellor_name = appt.get('counsellorName') or ''
        date_str = appt.get('appointmentDate') or ''
        time_str = appt.get('appointmentTime') or ''

        # If email not on appointment, try users collection
        if not student_email and db and student_id:
            try:
                uref = db.collection('users').document(student_id)
                usnap = uref.get()
                if usnap.exists:
                    u = usnap.to_dict() or {}
                    student_email = u.get('email', '')
                    if not student_name:
                        student_name = u.get('name') or u.get('displayName') or ''
            except Exception as e:
                logger.warning(f"lookup user email failed: {e}")

        # Compose email content
        status_nice = 'confirmed' if status in ('approved','confirmed') else ('cancelled' if status in ('cancelled','canceled') else status)
        subject = f"Your session on {date_str} {time_str} was {status_nice}"
        html_body = f"""
        <div>
          <p>Hi {student_name or 'there'},</p>
          <p>Your counselling session with <strong>{counsellor_name or 'your counsellor'}</strong> on <strong>{date_str}</strong> at <strong>{time_str}</strong> was <strong>{status_nice}</strong>.</p>
          <p>Please check your bookings page for details.</p>
          <p>— MINDLY</p>
        </div>
        """
        text_body = f"Hi {student_name or 'there'},\nYour counselling session on {date_str} at {time_str} was {status_nice}.\nPlease check your bookings page for details.\n— MINDLY"

        # Send email if possible
        if student_email:
            send_email(student_email, subject, html_body, text_body)

        # Write notification doc for student
        try:
            if db and student_id:
                db.collection('notifications').add({
                    'userId': student_id,
                    'type': 'appointment_status',
                    'title': f'Appointment {status_nice}',
                    'body': f'Your session on {date_str} at {time_str} is {status_nice}.',
                    'appointmentId': appointment_id,
                    'status': status,
                    'createdAt': datetime.now(),
                    'read': False
                })
        except Exception as e:
            logger.error(f"Failed to write notification: {e}")

        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"counsellor_update_status error: {e}")
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/counsellor/appointments/<appointment_id>/reschedule', methods=['PATCH'])
def counsellor_reschedule(appointment_id):
    """
    Body: { appointmentDate: 'YYYY-MM-DD', appointmentTime: 'HH:mm', counsellorId: '<uid>' }
    """
    try:
        if not db:
            return jsonify({'error': 'Database not available'}), 500
        data = request.get_json() or {}
        new_date = data.get('appointmentDate')
        new_time = data.get('appointmentTime')
        counsellor_id = data.get('counsellorId')
        if not new_date or not new_time:
            return jsonify({'error': 'appointmentDate and appointmentTime required'}), 400
        if not counsellor_id:
            return jsonify({'error': 'counsellorId is required'}), 400
        ref = db.collection('appointments').document(appointment_id)
        snap = ref.get()
        if not snap.exists:
            return jsonify({'error': 'Not found'}), 404
        appt = snap.to_dict()
        if appt.get('counsellorId') != counsellor_id:
            return jsonify({'error': 'Not your appointment'}), 403
        ref.update({'appointmentDate': new_date, 'appointmentTime': new_time, 'updatedAt': datetime.now()})
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"counsellor_reschedule error: {e}")
        return jsonify({'error': 'Internal server error'}), 500


@app.route('/api/counsellor/availability/toggle', methods=['PATCH'])
def counsellor_toggle_availability():
    """
    Body: { counsellorId, dateKey, time, active }
    """
    try:
        if not db:
            return jsonify({'error': 'Database not available'}), 500
        data = request.get_json() or {}
        counsellor_id = data.get('counsellorId')
        date_key = data.get('dateKey')
        time = data.get('time')
        active = bool(data.get('active'))
        if not counsellor_id or not date_key or not time:
            return jsonify({'error': 'counsellorId, dateKey and time are required'}), 400
        ref = db.document(f"counsellors/{counsellor_id}/availability/{date_key}/slots/{time}")
        # Ensure doc exists
        if not ref.get().exists:
            ref.set({'time': time, 'booked': False})
        ref.update({'active': active, 'updatedAt': datetime.now()})
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"toggle_availability error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/counsellor/availability', methods=['GET'])
def counsellor_get_availability():
    """
    Query params: counsellorId=<uid>, dateKey=YYYY-MM-DD
    Returns available slots list for the given counsellor and date.
    """
    try:
        if not db:
            return jsonify({'error': 'Database not available'}), 500
        counsellor_id = request.args.get('counsellorId', '')
        date_key = request.args.get('dateKey', '')
        if not counsellor_id or not date_key:
            return jsonify({'error': 'counsellorId and dateKey are required'}), 400
        col = db.collection(f"counsellors/{counsellor_id}/availability/{date_key}/slots")
        snap = col.stream()
        items = []
        for d in snap:
            data = d.to_dict() or {}
            data['id'] = d.id
            items.append(data)
        # normalize and sort by time
        def norm_time(t):
            t = str(t or '').strip().replace('.', ':')
            return t
        for it in items:
            it['time'] = norm_time(it.get('time') or it['id'])
        items.sort(key=lambda x: str(x.get('time') or ''))
        return jsonify({'slots': items})
    except Exception as e:
        logger.error(f"get_availability error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/counsellor/appointments/<appointment_id>/notes/<counsellor_id>', methods=['GET'])
def counsellor_get_note(appointment_id, counsellor_id):
    try:
        if not db:
            return jsonify({'error': 'Database not available'}), 500
        ref = db.document(f"appointments/{appointment_id}/notes/{counsellor_id}")
        snap = ref.get()
        if not snap.exists:
            return jsonify({'note': None})
        data = snap.to_dict() or {}
        data['id'] = snap.id
        return jsonify({'note': data})
    except Exception as e:
        logger.error(f"get_note error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/counsellor/appointments/<appointment_id>/notes/<counsellor_id>', methods=['PUT'])
def counsellor_put_note(appointment_id, counsellor_id):
    try:
        if not db:
            return jsonify({'error': 'Database not available'}), 500
        body = request.get_json() or {}
        text = body.get('text', '')
        ref = db.document(f"appointments/{appointment_id}/notes/{counsellor_id}")
        ref.set({'text': text, 'updatedAt': datetime.now()}, merge=True)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"put_note error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'services': {
            'firebase': db is not None,
            'chatbot': True
        }
    })

@app.route('/api/chat', methods=['POST'])
def chat():
    try:
        data = request.get_json()
        user_message = data.get('message', '')
        user_id = data.get('user_id', '')
        session_id = data.get('session_id', '')

        if not user_message:
            return jsonify({'error': 'Message is required'}), 400

        ai_response = chatbot.generate_response(user_message)

        if db and session_id:
            try:
                conversation_data = {
                    'user_id': user_id,
                    'session_id': session_id,
                    'user_message': user_message,
                    'ai_response': ai_response.get('ai_reply', ai_response.get('response', '')),
                    'sentiment': ai_response.get('sentiment', {}),
                    'timestamp': datetime.now(),
                    'escalation_level': ai_response.get('escalation_level', 'low')
                }
                db.collection('chat_conversations').add(conversation_data)
            except Exception as e:
                logger.error(f"Failed to save conversation: {e}")

        return jsonify(ai_response)

    except Exception as e:
        logger.error(f"Chat error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/assessment/phq9', methods=['POST'])
def phq9_assessment():
    try:
        data = request.get_json()
        responses = data.get('responses', [])
        user_id = data.get('user_id', '')

        if len(responses) != 9:
            return jsonify({'error': 'PHQ-9 requires exactly 9 responses'}), 400

        result = assessment.calculate_phq9_score(responses)

        if db and user_id:
            try:
                assessment_data = {
                    'user_id': user_id,
                    'type': 'PHQ-9',
                    'responses': responses,
                    'score': result['score'],
                    'severity': result['severity'],
                    'recommendations': result['recommendations'],
                    'timestamp': datetime.now()
                }
                db.collection('assessments').add(assessment_data)
            except Exception as e:
                logger.error(f"Failed to save PHQ-9 assessment: {e}")

        return jsonify(result)

    except Exception as e:
        logger.error(f"PHQ-9 assessment error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/assessment/gad7', methods=['POST'])
def gad7_assessment():
    try:
        data = request.get_json()
        responses = data.get('responses', [])
        user_id = data.get('user_id', '')

        if len(responses) != 7:
            return jsonify({'error': 'GAD-7 requires exactly 7 responses'}), 400

        result = assessment.calculate_gad7_score(responses)

        if db and user_id:
            try:
                assessment_data = {
                    'user_id': user_id,
                    'type': 'GAD-7',
                    'responses': responses,
                    'score': result['score'],
                    'severity': result['severity'],
                    'recommendations': result['recommendations'],
                    'timestamp': datetime.now()
                }
                db.collection('assessments').add(assessment_data)
            except Exception as e:
                logger.error(f"Failed to save GAD-7 assessment: {e}")

        return jsonify(result)

    except Exception as e:
        logger.error(f"GAD-7 assessment error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/escalation', methods=['POST'])
def handle_escalation():
    try:
        data = request.get_json()
        user_id = data.get('user_id', '')
        escalation_level = data.get('escalation_level', 'high')
        message = data.get('message', '')

        if db and user_id:
            try:
                escalation_data = {
                    'user_id': user_id,
                    'escalation_level': escalation_level,
                    'message': message,
                    'timestamp': datetime.now(),
                    'status': 'pending'
                }
                db.collection('escalations').add(escalation_data)
            except Exception as e:
                logger.error(f"Failed to save escalation: {e}")

        crisis_resources = {
            'emergency_contacts': [
                {'name': 'National Suicide Prevention Lifeline', 'number': '988'},
                {'name': 'Crisis Text Line', 'number': 'Text HOME to 741741'},
                {'name': 'Emergency Services', 'number': '911'}
            ],
            'immediate_actions': [
                'Contact emergency services if in immediate danger',
                'Reach out to a trusted friend or family member',
                'Go to the nearest emergency room',
                'Use crisis text line for immediate support'
            ]
        }

        return jsonify({
            'escalation_logged': True,
            'crisis_resources': crisis_resources
        })

    except Exception as e:
        logger.error(f"Escalation error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

@app.route('/api/analytics/sentiment-trends', methods=['GET'])
def get_sentiment_trends():
    try:
        user_id = request.args.get('user_id', '')
        if not db:
            return jsonify({'error': 'Database not available'}), 500

        conversations = db.collection('chat_conversations')\
            .where('user_id', '==', user_id)\
            .order_by('timestamp', direction=firestore.Query.DESCENDING)\
            .limit(50)\
            .stream()

        sentiment_data = []
        for conv in conversations:
            conv_data = conv.to_dict()
            sentiment_data.append({
                'timestamp': conv_data['timestamp'].isoformat(),
                'sentiment': conv_data.get('sentiment', {}).get('label', 'neutral'),
                'score': conv_data.get('sentiment', {}).get('score', 0)
            })

        return jsonify({'sentiment_trends': sentiment_data})

    except Exception as e:
        logger.error(f"Analytics error: {e}")
        return jsonify({'error': 'Internal server error'}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('FLASK_ENV') == 'development'
    logger.info(f"Starting Flask app on port {port}")
    app.run(host='0.0.0.0', port=port, debug=debug)