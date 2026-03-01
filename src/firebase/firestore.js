import { 
  collection, 
  doc, 
  addDoc, 
  updateDoc, 
  getDocs, 
  setDoc,
  runTransaction,
  deleteDoc,
  query, 
  where, 
  orderBy, 
  limit,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  arrayUnion,
  arrayRemove,
  increment,
  
} from 'firebase/firestore';
import { db, storage } from './config';
import { apiJson } from '../utils/api';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';

// Collections
export const COLLECTIONS = {
  USERS: 'users',
  APPOINTMENTS: 'appointments',
  COUNSELLORS: 'counsellors',
  FORUM_POSTS: 'forum_posts',
  FORUM_COMMENTS: 'forum_comments',
  JOURNAL_ENTRIES: 'journal_entries',
  RESOURCES: 'resources',
  CHAT_SESSIONS: 'chat_sessions',
  CHAT_MESSAGES: 'chat_messages',
  ASSESSMENTS: 'assessments',
  NOTIFICATIONS: 'notifications',
  MOOD_SCORES: 'mood_scores',
  RESOURCES_VIEWED: 'resources_viewed'
};

export const deleteAppointment = async (appointmentId, counsellorId) => {
  try {
    const res = await apiJson(`/api/counsellor/appointments/${appointmentId}`, 'DELETE', { counsellorId });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const completeAppointment = async (appointmentId, counsellorId) => {
  try {
    await apiJson(`/api/counsellor/appointments/${appointmentId}/complete`, 'PATCH', { counsellorId });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const startAppointment = async (appointmentId, counsellorId) => {
  try {
    await apiJson(`/api/counsellor/appointments/${appointmentId}/start`, 'PATCH', { counsellorId });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// -------- Insights: mood trends + assessments for an appointment's student --------
export const getAppointmentInsights = async (appointmentId, counsellorId, days = null, fallback = false) => {
  try {
    const qs = new URLSearchParams({ counsellorId });
    if (days != null) qs.set('days', String(days));
    if (fallback != null) qs.set('fallback', String(!!fallback));
    const res = await apiJson(`/api/counsellor/appointments/${appointmentId}/insights?${qs.toString()}`, 'GET');
    return { success: true, data: res };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Students: submit a rating for a counsellor after a completed session
// Stores a rating document and updates aggregate fields on counsellor doc:
// ratingCount, ratingSum, rating (average)
export const submitCounsellorRating = async ({ counsellorId, studentId, appointmentId = null, stars }) => {
  try {
    const starsNum = Number(stars);
    if (!counsellorId || !studentId || !(starsNum >= 1 && starsNum <= 5)) {
      throw new Error('Invalid rating payload');
    }
    const ratingsColPath = `${COLLECTIONS.COUNSELLORS}/${counsellorId}/ratings`;
    const ratingsColRef = collection(db, ratingsColPath);
    const counsellorRef = doc(db, COLLECTIONS.COUNSELLORS, counsellorId);

    // Use a transaction to both add rating doc and update aggregates safely
    await runTransaction(db, async (tx) => {
      // Use deterministic doc id to avoid duplicate ratings per appointment
      const ratingDocRef = appointmentId
        ? doc(db, ratingsColPath, String(appointmentId))
        : doc(ratingsColRef);

      // Prevent duplicate rating for same appointment
      const existing = await tx.get(ratingDocRef);
      if (existing.exists()) {
        throw new Error('Rating already submitted for this appointment');
      }

      tx.set(ratingDocRef, {
        studentId,
        appointmentId: appointmentId || null,
        stars: starsNum,
        createdAt: serverTimestamp()
      });

      // Update aggregates
      const snap = await tx.get(counsellorRef);
      const data = snap.exists() ? snap.data() : {};
      const prevCount = Number(data.ratingCount || 0);
      const prevSum = Number(data.ratingSum || 0);
      const newCount = prevCount + 1;
      const newSum = prevSum + starsNum;
      const newAvg = newCount > 0 ? Number((newSum / newCount).toFixed(2)) : 0;
      tx.update(counsellorRef, {
        ratingCount: newCount,
        ratingSum: newSum,
        rating: newAvg,
        updatedAt: serverTimestamp()
      });
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

 

// Real-time resources subscriptions (students + counsellors unified)
export const subscribeResources = (category, onData, onError = console.error, maxItems = 500) => {
  let qRef = query(
    collection(db, COLLECTIONS.RESOURCES),
    limit(maxItems)
  );
  if (category) {
    qRef = query(
      collection(db, COLLECTIONS.RESOURCES),
      where('category', '==', category),
      limit(maxItems)
    );
  }
  return onSnapshot(
    qRef,
    (snapshot) => {
      const items = [];
      snapshot.forEach((d) => items.push({ id: d.id, ...d.data(), __src: 'global' }));
      // Sort client-side by createdAt desc if present
      items.sort((a,b)=>{
        const ad = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const bd = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return bd - ad;
      });
      onData(items);
    },
    (err) => onError(err)
  );
};

export const subscribeCounsellorResourcesAll = (onData, onError = console.error, maxItems = 500) => {
  const qRef = query(collection(db, 'resources_counsellors'), limit(maxItems));
  return onSnapshot(
    qRef,
    (snapshot) => {
      const items = [];
      snapshot.forEach((d) => items.push({ id: d.id, ...d.data(), __src: 'counsellor' }));
      items.sort((a,b)=>{
        const ad = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const bd = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return bd - ad;
      });
      onData(items);
    },
    (err) => onError(err)
  );
};

// Combined subscription: merges global resources and counsellor-owned resources
export const subscribeUnifiedResources = (category, onData, onError = console.error) => {
  let globalItems = [];
  let counsellorItems = [];
  const emit = () => {
    let merged = [...globalItems, ...counsellorItems];
    if (category) {
      merged = merged.filter(r => (r.category || null) === category || r.__src === 'counsellor');
      // Note: counsellor items may not have category; include them regardless
    }
    // Dedupe by (title+url) to avoid duplicates
    const seen = new Set();
    const uniq = [];
    for (const it of merged) {
      const key = `${it.title||''}|${it.url||''}|${it.__src}`;
      if (!seen.has(key)) { seen.add(key); uniq.push(it); }
    }
    // Sort newest first by createdAt
    uniq.sort((a,b)=>{
      const ad = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
      const bd = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
      return bd - ad;
    });
    onData(uniq);
  };

  const unsubGlobal = subscribeResources(category, (items)=>{ globalItems = items; emit(); }, onError);
  const unsubCoun = subscribeCounsellorResourcesAll((items)=>{ counsellorItems = items; emit(); }, onError);
  return () => { unsubGlobal && unsubGlobal(); unsubCoun && unsubCoun(); };
};

// Update appointment status (counsellor or student per rules)
export const updateAppointmentStatus = async (appointmentId, status, counsellorId) => {
  try {
    // Use backend to avoid client-side permission issues
    await apiJson(`/api/counsellor/appointments/${appointmentId}/status`, 'PATCH', { status, counsellorId });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const rescheduleAppointment = async (appointmentId, { appointmentDate, appointmentTime }, counsellorId) => {
  try {
    await apiJson(`/api/counsellor/appointments/${appointmentId}/reschedule`, 'PATCH', {
      appointmentDate,
      appointmentTime,
      counsellorId
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Toggle availability slot 'active' flag by counsellor
// (moved to bottom section: see Counsellor-specific helpers)

// Subscribe counsellor appointments 
export const subscribeCounsellorAppointments = (counsellorId, onData, onError = console.error, upcomingOnly = true, maxItems = 200) => {
  // Use polling via backend endpoint to avoid client rules issues
  if (!counsellorId) return () => {};
  let cancelled = false;
  let timer = null;
  let intervalMs = 5000; // start at 5s
  const MIN_INTERVAL = 3000;
  const MAX_INTERVAL = 30000;

  const scheduleNext = () => {
    if (cancelled) return;
    timer = setTimeout(fetchOnce, intervalMs);
  };

  const fetchOnce = async () => {
    try {
      const res = await apiJson(`/api/counsellor/appointments?counsellorId=${encodeURIComponent(counsellorId)}&limit=${maxItems}`, 'GET');
      let items = res.appointments || [];
      // Client-side sort by date, then time
      items.sort((a,b)=>{
        const ad = String(a.appointmentDate||'');
        const bd = String(b.appointmentDate||'');
        if (ad !== bd) return ad.localeCompare(bd);
        const at = String(a.appointmentTime||'');
        const bt = String(b.appointmentTime||'');
        return at.localeCompare(bt);
      });
      if (upcomingOnly) {
        const todayISO = new Date().toISOString().split('T')[0];
        items = items.filter(a => {
          const s = String(a.status||'').toLowerCase();
          const notCancelledOrCompleted = !['cancelled','canceled','completed'].includes(s);
          return notCancelledOrCompleted && String(a.appointmentDate||'') >= todayISO;
        });
      }
      if (!cancelled) onData(items);
      // success: reduce interval slightly (towards min)
      intervalMs = Math.max(MIN_INTERVAL, Math.floor(intervalMs * 0.8));
    } catch (e) {
      if (!cancelled) onError(e);
      // error: backoff
      intervalMs = Math.min(MAX_INTERVAL, Math.floor(intervalMs * 2));
    } finally {
      scheduleNext();
    }
  };

  // immediate fetch
  fetchOnce();

  return () => { cancelled = true; if (timer) clearTimeout(timer); };
};

// ===== Counsellor profile helpers =====
export const subscribeCounsellorProfile = (counsellorId, onData, onError = console.error) => {
  if (!counsellorId) return () => {};
  const ref = doc(db, COLLECTIONS.COUNSELLORS, counsellorId);
  return onSnapshot(ref, (snap) => {
    if (snap.exists()) onData({ id: snap.id, ...snap.data() });
    else onData(null);
  }, onError);
};

export const updateCounsellorProfile = async (counsellorId, data) => {
  try {
    // Ensure counsellors cannot change 'active' from client call
    const { active, userId, email, createdAt, ...safe } = data || {};
    await updateDoc(doc(db, COLLECTIONS.COUNSELLORS, counsellorId), safe);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// ===== Admin: Overview & Management Helpers =====
export const getAdminOverviewCounts = async () => {
  try {
    const studentsSnap = await getDocs(query(collection(db, 'students'), limit(1_000))); // soft cap
    const counsellorsSnap = await getDocs(query(collection(db, COLLECTIONS.COUNSELLORS), limit(1_000)));
    const today = new Date(); today.setHours(0,0,0,0);
    const todayISO = today.toISOString().split('T')[0];
    const apptsSnap = await getDocs(query(
      collection(db, COLLECTIONS.APPOINTMENTS),
      where('appointmentDate', '>=', todayISO),
      orderBy('appointmentDate', 'asc'),
      limit(1_000)
    ));
    const pendingApprovalsSnap = await getDocs(query(
      collection(db, COLLECTIONS.COUNSELLORS),
      where('active', '==', false),
      limit(1_000)
    ));
    const sessionsTodaySnap = await getDocs(query(
      collection(db, COLLECTIONS.CHAT_SESSIONS),
      where('createdAt', '>=', Timestamp.fromDate(today)),
      limit(1_000)
    ));
    return {
      success: true,
      data: {
        totalStudents: studentsSnap.size,
        totalCounsellors: counsellorsSnap.size,
        upcomingAppointments: apptsSnap.size,
        pendingCounsellors: pendingApprovalsSnap.size,
        activeSessionsToday: sessionsTodaySnap.size,
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const subscribeAppointments = (filters, onData, onError = console.error, maxItems = 200) => {
  let clauses = [];
  if (filters?.counsellorId) clauses.unshift(where('counsellorId', '==', filters.counsellorId));
  if (filters?.studentId) clauses.unshift(where('studentId', '==', filters.studentId));
  // Note: Firestore requires appropriate indexes for combined where+orderBy
  const qRef = query(collection(db, COLLECTIONS.APPOINTMENTS), ...clauses, limit(maxItems));
  return onSnapshot(qRef, (snap)=>{
    const items = [];
    snap.forEach(d=>items.push({ id: d.id, ...d.data() }));
    // Client-side sort by date then time to avoid composite index needs
    items.sort((a,b) => {
      const ad = String(a.appointmentDate || '');
      const bd = String(b.appointmentDate || '');
      if (ad !== bd) return ad.localeCompare(bd);
      const at = String(a.appointmentTime || '');
      const bt = String(b.appointmentTime || '');
      return at.localeCompare(bt);
    });
    onData(items);
  }, onError);
};

export const subscribeNotifications = (userId, onData, onError = console.error, maxItems = 100) => {
  if (!userId) return () => {};
  const qRef = query(
    collection(db, COLLECTIONS.NOTIFICATIONS),
    where('userId', '==', userId),
    orderBy('createdAt', 'desc'),
    limit(maxItems)
  );
  return onSnapshot(qRef, (snap) => {
    const items = [];
    snap.forEach(d => items.push({ id: d.id, ...d.data() }));
    onData(items);
  }, onError);
};

export const searchStudents = async (searchTerm = '', maxItems = 200) => {
  try {
    // Simple approach: fetch recent and filter client-side for demo purposes
    const snap = await getDocs(query(collection(db, 'students'), orderBy('createdAt', 'desc'), limit(maxItems)));
    let items = []; snap.forEach(d=>items.push({ id: d.id, ...d.data() }));
    const q = searchTerm.trim().toLowerCase();
    if (q) {
      items = items.filter(s =>
        (s.collegeEmail || '').toLowerCase().includes(q) ||
        (s.collegeName || '').toLowerCase().includes(q) ||
        (s.userId || '').toLowerCase().includes(q)
      );
    }
    return { success: true, data: items };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Forum moderation
export const subscribeFlaggedPosts = (onData, onError = console.error, maxItems = 200) => {
  const qRef = query(
    collection(db, COLLECTIONS.FORUM_POSTS),
    where('flagged', '==', true),
    orderBy('createdAt', 'desc'),
    limit(maxItems)
  );
  return onSnapshot(qRef, (snap)=>{
    const items = []; snap.forEach(d=>items.push({ id: d.id, ...d.data() })); onData(items);
  }, onError);
};

export const deleteForumPost = async (postId) => {
  try {
    await deleteDoc(doc(db, COLLECTIONS.FORUM_POSTS, postId));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Toggle counsellor active status (admin use or self-service gated by rules)
export const updateCounsellorActive = async (counsellorId, active) => {
  try {
    await updateDoc(doc(db, COLLECTIONS.COUNSELLORS, counsellorId), { active: !!active });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Upsert a single availability slot
export const upsertAvailabilitySlot = async (counsellorId, dateKey, time, slotOwnerId = null) => {
  try {
    // Route via backend to avoid requiring client write permission
    await apiJson('/api/counsellor/availability/slot', 'POST', {
      counsellorId: slotOwnerId || counsellorId,
      dateKey,
      time
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Delete a slot (admin/counsellor maintenance)
export const deleteAvailabilitySlot = async (counsellorId, dateKey, time) => {
  try {
    await updateDoc(doc(db, `${COLLECTIONS.COUNSELLORS}/${counsellorId}/availability/${dateKey}/slots/${time}`), {
      // Soft-delete could be implemented; for now, clear to default available
      booked: false,
      bookedBy: null,
      sessionId: null,
      updatedAt: serverTimestamp()
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Fetch chat sessions for a user
export const getChatSessions = async (userId, maxItems = 20) => {
  try {
    const q = query(
      collection(db, COLLECTIONS.CHAT_SESSIONS),
      where('userId', '==', userId),
      orderBy('createdAt', 'desc'),
      limit(maxItems)
    );
    const querySnapshot = await getDocs(q);
    const sessions = [];
    querySnapshot.forEach((doc) => sessions.push({ id: doc.id, ...doc.data() }));
    return { success: true, data: sessions };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Real-time listener for chat sessions
export const subscribeChatSessions = (userId, onData, onError = console.error, maxItems = 20) => {
  const q = query(
    collection(db, COLLECTIONS.CHAT_SESSIONS),
    where('userId', '==', userId),
    orderBy('createdAt', 'desc'),
    limit(maxItems)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const items = [];
      snapshot.forEach((doc) => items.push({ id: doc.id, ...doc.data() }));
      onData(items);
    },
    (err) => onError(err)
  );
};

// Appointment functions
export const createAppointment = async (appointmentData) => {
  try {
    const docRef = await addDoc(collection(db, COLLECTIONS.APPOINTMENTS), {
      ...appointmentData,
      createdAt: serverTimestamp(),
      status: 'pending'
    });
    return { success: true, id: docRef.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Counsellors: profiles and real-time list
export const subscribeCounsellors = (onData, onError = console.error, maxItems = 100) => {
  // Server-side filter: only active counsellors. Sort client-side to avoid composite index requirements.
  const qRef = query(
    collection(db, COLLECTIONS.COUNSELLORS),
    where('active', '==', true),
    limit(maxItems)
  );
  return onSnapshot(
    qRef,
    (snapshot) => {
      const items = [];
      snapshot.forEach((d) => items.push({ id: d.id, ...d.data() }));
      items.sort((a,b)=> (b.rating || 0) - (a.rating || 0));
      onData(items);
    },
    (err) => onError(err)
  );
};

// Admin/all view without active filter
export const subscribeAllCounsellors = (onData, onError = console.error, maxItems = 200) => {
  const qRef = query(
    collection(db, COLLECTIONS.COUNSELLORS),
    orderBy('createdAt', 'desc'),
    limit(maxItems)
  );
  return onSnapshot(
    qRef,
    (snapshot) => {
      const items = [];
      snapshot.forEach((d) => items.push({ id: d.id, ...d.data() }));
      onData(items);
    },
    (err) => onError(err)
  );
};

// Each slot doc: { time: 'HH:mm', booked: boolean, bookedBy?: uid, sessionId?: string, updatedAt }
export const subscribeAvailabilitySlots = (counsellorId, dateKey, onData, onError = console.error) => {
  // Poll backend to avoid client Firestore rule issues
  if (!counsellorId || !dateKey) return () => {};
  let cancelled = false;
  let timer = null;
  let intervalMs = 7000;
  const MIN_INTERVAL = 4000;
  const MAX_INTERVAL = 30000;

  const scheduleNext = () => { if (!cancelled) timer = setTimeout(fetchOnce, intervalMs); };

  const fetchOnce = async () => {
    try {
      const res = await apiJson(`/api/counsellor/availability?counsellorId=${encodeURIComponent(counsellorId)}&dateKey=${encodeURIComponent(dateKey)}`, 'GET');
      let items = res.slots || [];
      // Only show available and active
      items = items.filter(s => (s.active !== false) && !s.booked);
      items.sort((a,b)=> String(a.time||'').localeCompare(String(b.time||'')));
      if (!cancelled) onData(items);
      intervalMs = Math.max(MIN_INTERVAL, Math.floor(intervalMs * 0.9));
    } catch (e) {
      if (!cancelled) onError(e);
      intervalMs = Math.min(MAX_INTERVAL, Math.floor(intervalMs * 2));
    } finally {
      scheduleNext();
    }
  };

  fetchOnce();
  return () => { cancelled = true; if (timer) clearTimeout(timer); };
};

// Realtime availability via Firestore (owner/student read)
export const subscribeAvailabilitySlotsRealtime = (counsellorId, dateKey, onData, onError = console.error) => {
  try {
    if (!counsellorId || !dateKey) return () => {};
    const slotsColPath = `${COLLECTIONS.COUNSELLORS}/${counsellorId}/availability/${dateKey}/slots`;
    const qRef = collection(db, slotsColPath);
    return onSnapshot(qRef, (snap) => {
      let items = [];
      snap.forEach(d => items.push({ id: d.id, ...d.data() }));
      items = items
        .filter(s => s && (s.active !== false))
        .sort((a,b)=> String(a.time||'').localeCompare(String(b.time||'')));
      onData(items);
    }, onError);
  } catch (e) {
    onError(e);
    return () => {};
  }
};

// Transactional booking to avoid double-booking
export const bookAppointmentWithSlot = async ({
  user,
  counsellorId,
  counsellorName,
  dateKey, // 'YYYY-MM-DD'
  time, // 'HH:mm'
  sessionType,
  reason,
  urgency,
  previousCounseling,
  notes,
  slotOwnerId = null, // if availability is stored under a different owner id (e.g., counsellor auth uid)
}) => {
  try {
    const ownerIdForSlot = slotOwnerId || counsellorId;
    const toAltDateKey = (dk) => {
      const parts = dk.split('-');
      if (parts.length === 3) {
        if (parts[0].length === 4) return `${parts[2]}-${parts[1]}-${parts[0]}`; // YYYY->DD
        if (parts[2].length === 4) return `${parts[2]}-${parts[1]}-${parts[0]}`; // DD->YYYY
      }
      return dk;
    };
    const altDateKey = toAltDateKey(dateKey);
    const prefRef = doc(db, `${COLLECTIONS.COUNSELLORS}/${ownerIdForSlot}/availability/${dateKey}/slots/${time}`);
    const altRef = altDateKey !== dateKey ? doc(db, `${COLLECTIONS.COUNSELLORS}/${ownerIdForSlot}/availability/${altDateKey}/slots/${time}`) : null;
    const apptRef = doc(collection(db, COLLECTIONS.APPOINTMENTS));

    await runTransaction(db, async (transaction) => {
      let chosenRef = prefRef;
      let slotSnap = await transaction.get(prefRef);
      if (!slotSnap.exists() && altRef) {
        const altSnap = await transaction.get(altRef);
        if (altSnap.exists()) {
          slotSnap = altSnap;
          chosenRef = altRef;
        }
      }
      if (!slotSnap.exists()) throw new Error('Slot not found');
      const slot = slotSnap.data();
      if (slot.booked) throw new Error('Slot already booked');

      // Create appointment
      transaction.set(apptRef, {
        studentId: user.uid,
        studentName: user.displayName || null,
        studentEmail: user.email || null,
        counsellorId,
        counsellorName: counsellorName || null,
        appointmentDate: dateKey,
        appointmentTime: time,
        sessionType,
        duration: '50 minutes',
        status: 'pending',
        reason,
        urgency,
        previousCounseling,
        notes: notes || null,
        createdAt: serverTimestamp()
      });
      // Mark slot booked
      transaction.update(chosenRef, {
        booked: true,
        bookedBy: user.uid,
        sessionId: apptRef.id,
        updatedAt: serverTimestamp()
      });
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Fetch appointments for a user (student or counsellor)
export const getAppointments = async (userId, userRole) => {
  try {
    let q;
    if (userRole === 'counsellor') {
      q = query(
        collection(db, COLLECTIONS.APPOINTMENTS),
        where('counsellorId', '==', userId),
        orderBy('appointmentDate', 'asc')
      );
    } else {
      q = query(
        collection(db, COLLECTIONS.APPOINTMENTS),
        where('studentId', '==', userId),
        orderBy('appointmentDate', 'asc')
      );
    }
    const querySnapshot = await getDocs(q);
    const appointments = [];
    querySnapshot.forEach((d) => appointments.push({ id: d.id, ...d.data() }));
    return { success: true, data: appointments };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Forum functions
export const createForumPost = async (postData) => {
  try {
    const docRef = await addDoc(collection(db, COLLECTIONS.FORUM_POSTS), {
      ...postData,
      createdAt: serverTimestamp(),
      likes: 0,
      comments: 0,
      likedBy: []
    });
    return { success: true, id: docRef.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const getForumPosts = async (category = null) => {
  try {
    let q = query(
      collection(db, COLLECTIONS.FORUM_POSTS),
      orderBy('createdAt', 'desc'),
      limit(20)
    );
    
    if (category) {
      q = query(
        collection(db, COLLECTIONS.FORUM_POSTS),
        where('category', '==', category),
        orderBy('createdAt', 'desc'),
        limit(20)
      );
    }
    
    const querySnapshot = await getDocs(q);
    const posts = [];
    querySnapshot.forEach((doc) => {
      posts.push({ id: doc.id, ...doc.data() });
    });
    
    return { success: true, data: posts };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Real-time forum posts subscription (optionally filtered by category)
export const subscribeForumPosts = (category, onData, onError = console.error, maxItems = 50) => {
  // Avoid server-side orderBy to reduce composite index requirements; sort client-side.
  let qRef = query(
    collection(db, COLLECTIONS.FORUM_POSTS),
    limit(maxItems)
  );
  if (category) {
    qRef = query(
      collection(db, COLLECTIONS.FORUM_POSTS),
      where('category', '==', category),
      limit(maxItems)
    );
  }
  return onSnapshot(
    qRef,
    (snapshot) => {
      const items = [];
      snapshot.forEach((d) => items.push({ id: d.id, ...d.data() }));
      items.sort((a,b)=>{
        const ad = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const bd = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return bd - ad;
      });
      onData(items);
    },
    (err) => onError(err)
  );
};

// Toggle like on a forum post for a user. Caller should pass current like state.
export const likeForumPost = async (postId, userId) => {
  try {
    await updateDoc(doc(db, COLLECTIONS.FORUM_POSTS, postId), {
      likedBy: arrayUnion(userId),
      likes: increment(1)
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const unlikeForumPost = async (postId, userId) => {
  try {
    await updateDoc(doc(db, COLLECTIONS.FORUM_POSTS, postId), {
      likedBy: arrayRemove(userId),
      likes: increment(-1)
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Comments subcollection helpers
export const addForumComment = async (postId, comment) => {
  try {
    const commentRef = await addDoc(collection(db, `${COLLECTIONS.FORUM_POSTS}/${postId}/comments`), {
      ...comment,
      createdAt: serverTimestamp()
    });
    // increment comment count on post
    await updateDoc(doc(db, COLLECTIONS.FORUM_POSTS, postId), {
      comments: increment(1)
    });
    return { success: true, id: commentRef.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const subscribeForumComments = (postId, onData, onError = console.error, maxItems = 100) => {
  const qRef = query(
    collection(db, `${COLLECTIONS.FORUM_POSTS}/${postId}/comments`),
    orderBy('createdAt', 'asc'),
    limit(maxItems)
  );
  return onSnapshot(
    qRef,
    (snapshot) => {
      const items = [];
      snapshot.forEach((d) => items.push({ id: d.id, ...d.data() }));
      onData(items);
    },
    (err) => onError(err)
  );
};

// Real-time listener for only the comment count (uses snapshot.size)
export const subscribeForumCommentCount = (postId, onCount, onError = console.error) => {
  const qRef = query(
    collection(db, `${COLLECTIONS.FORUM_POSTS}/${postId}/comments`)
  );
  return onSnapshot(
    qRef,
    (snapshot) => {
      onCount(snapshot.size);
    },
    (err) => onError(err)
  );
};

// Journal functions
export const createJournalEntry = async (entryData) => {
  try {
    const payload = { ...entryData };
    // If a valid createdAt Timestamp is provided, use it; otherwise fallback to serverTimestamp
    if (!payload.createdAt) {
      payload.createdAt = serverTimestamp();
    }
    const docRef = await addDoc(collection(db, COLLECTIONS.JOURNAL_ENTRIES), payload);
    return { success: true, id: docRef.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const getJournalEntries = async (userId) => {
  try {
    const q = query(
      collection(db, COLLECTIONS.JOURNAL_ENTRIES),
      where('userId', '==', userId),
      orderBy('createdAt', 'desc')
    );
    
    const querySnapshot = await getDocs(q);
    const entries = [];
    querySnapshot.forEach((doc) => {
      entries.push({ id: doc.id, ...doc.data() });
    });
    
    return { success: true, data: entries };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Real-time listener for journal entries for a user
export const subscribeJournalEntries = (userId, onData, onError = console.error, maxItems = 100) => {
  const q = query(
    collection(db, COLLECTIONS.JOURNAL_ENTRIES),
    where('userId', '==', userId),
    orderBy('createdAt', 'desc'),
    limit(maxItems)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const items = [];
      snapshot.forEach((doc) => items.push({ id: doc.id, ...doc.data() }));
      onData(items);
    },
    (err) => onError(err)
  );
};

// Resource functions
export const getResources = async (category = null) => {
  try {
    let q = query(
      collection(db, COLLECTIONS.RESOURCES),
      orderBy('createdAt', 'desc')
    );
    
    if (category) {
      q = query(
        collection(db, COLLECTIONS.RESOURCES),
        where('category', '==', category),
        orderBy('createdAt', 'desc')
      );
    }
    
    const querySnapshot = await getDocs(q);
    const resources = [];
    querySnapshot.forEach((doc) => {
      resources.push({ id: doc.id, ...doc.data() });
    });
    
    return { success: true, data: resources };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Chat functions
export const createChatSession = async (sessionData) => {
  try {
    const docRef = await addDoc(collection(db, COLLECTIONS.CHAT_SESSIONS), {
      ...sessionData,
      createdAt: serverTimestamp(),
      lastMessageAt: serverTimestamp()
    });
    return { success: true, id: docRef.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const sendChatMessage = async (messageData) => {
  try {
    const docRef = await addDoc(collection(db, COLLECTIONS.CHAT_MESSAGES), {
      ...messageData,
      createdAt: serverTimestamp()
    });
    
    // Update last message time in session
    await updateDoc(doc(db, COLLECTIONS.CHAT_SESSIONS, messageData.sessionId), {
      lastMessageAt: serverTimestamp()
    });
    
    return { success: true, id: docRef.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Real-time listeners
export const subscribeToChatMessages = (sessionId, callback) => {
  const q = query(
    collection(db, COLLECTIONS.CHAT_MESSAGES),
    where('sessionId', '==', sessionId),
    orderBy('createdAt', 'asc')
  );
  
  return onSnapshot(q, (querySnapshot) => {
    const messages = [];
    querySnapshot.forEach((doc) => {
      messages.push({ id: doc.id, ...doc.data() });
    });
    callback(messages);
  });
};

// Assessment functions
export const saveAssessment = async (assessmentData) => {
  try {
    const docRef = await addDoc(collection(db, COLLECTIONS.ASSESSMENTS), {
      ...assessmentData,
      createdAt: serverTimestamp()
    });
    return { success: true, id: docRef.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const getAssessments = async (userId) => {
  try {
    const q = query(
      collection(db, COLLECTIONS.ASSESSMENTS),
      where('userId', '==', userId),
      orderBy('createdAt', 'desc')
    );
    
    const querySnapshot = await getDocs(q);
    const assessments = [];
    querySnapshot.forEach((doc) => {
      if (doc) {
        assessments.push({ id: doc.id, ...doc.data() });
      }
    });
    
    return { success: true, data: assessments };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Mood score functions
  try {
    const docRef = await addDoc(collection(db, COLLECTIONS.MOOD_SCORES), {
      userId,
      score, // e.g., 0-100 or 1-5 scale
      mood: mood || null, // optional label like 'happy', 'sad'
      note, // optional free text
      recordedAt: recordedAt ? recordedAt : serverTimestamp(),
      createdAt: serverTimestamp()
    });
    return { success: true, id: docRef.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const getMoodScores = async (userId, maxItems = 30) => {
  try {
    const q = query(
      collection(db, COLLECTIONS.MOOD_SCORES),
      where('userId', '==', userId),
      orderBy('createdAt', 'desc'),
      limit(maxItems)
    );
    const querySnapshot = await getDocs(q);
    const items = [];
    querySnapshot.forEach((doc) => items.push({ id: doc.id, ...doc.data() }));
    return { success: true, data: items };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Real-time listener for mood scores
export const subscribeMoodScores = (userId, onData, onError = console.error, maxItems = 30) => {
  const q = query(
    collection(db, COLLECTIONS.MOOD_SCORES),
    where('userId', '==', userId),
    orderBy('createdAt', 'desc'),
    limit(maxItems)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const items = [];
      snapshot.forEach((doc) => items.push({ id: doc.id, ...doc.data() }));
      onData(items);
    },
    (err) => onError(err)
  );
};

// Resources viewed (per-user activity) functions
export const logResourceViewed = async ({ userId, resourceId, resourceType = null, title = null }) => {
  try {
    const docRef = await addDoc(collection(db, COLLECTIONS.RESOURCES_VIEWED), {
      userId,
      resourceId, // id from RESOURCES collection or external id
      resourceType, // e.g., article, video
      title,
      viewedAt: serverTimestamp(),
      createdAt: serverTimestamp()
    });
    return { success: true, id: docRef.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const getResourcesViewed = async (userId, maxItems = 50) => {
  try {
    const q = query(
      collection(db, COLLECTIONS.RESOURCES_VIEWED),
      where('userId', '==', userId),
      orderBy('createdAt', 'desc'),
      limit(maxItems)
    );
    const querySnapshot = await getDocs(q);
    const items = [];
    querySnapshot.forEach((doc) => items.push({ id: doc.id, ...doc.data() }));
    return { success: true, data: items };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Real-time listener for resources viewed
export const subscribeResourcesViewed = (userId, onData, onError = console.error, maxItems = 50) => {
  const q = query(
    collection(db, COLLECTIONS.RESOURCES_VIEWED),
    where('userId', '==', userId),
    orderBy('createdAt', 'desc'),
    limit(maxItems)
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const items = [];
      snapshot.forEach((doc) => items.push({ id: doc.id, ...doc.data() }));
      onData(items);
    },
    (err) => onError(err)
  );
};

// ===== Counsellor-specific helpers (used by Counsellor Dashboard) =====

// Toggle availability slot 'active' flag by counsellor
export const toggleAvailabilityActive = async (counsellorId, dateKey, time, active) => {
  try {
    await apiJson('/api/counsellor/availability/toggle', 'PATCH', {
      counsellorId,
      dateKey,
      time,
      active: !!active
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Counsellor private notes per appointment
export const upsertCounsellorNote = async (appointmentId, counsellorId, { text }) => {
  try {
    await apiJson(`/api/counsellor/appointments/${appointmentId}/notes/${counsellorId}`, 'PUT', { text });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const subscribeCounsellorNotes = (appointmentId, counsellorId, onData, onError = console.error) => {
  if (!appointmentId || !counsellorId) return () => {};
  let cancelled = false;
  let timer = null;
  let intervalMs = 10000;
  const MIN_INTERVAL = 5000;
  const MAX_INTERVAL = 60000;
  const scheduleNext = () => { if (!cancelled) timer = setTimeout(fetchOnce, intervalMs); };
  const fetchOnce = async () => {
    try {
      const res = await apiJson(`/api/counsellor/appointments/${appointmentId}/notes/${counsellorId}`, 'GET');
      const note = res.note || null;
      if (!cancelled) onData(note);
      intervalMs = Math.max(MIN_INTERVAL, Math.floor(intervalMs * 0.9));
    } catch (e) {
      if (!cancelled) onError(e);
      intervalMs = Math.min(MAX_INTERVAL, Math.floor(intervalMs * 2));
    } finally {
      scheduleNext();
    }
  };
  fetchOnce();
  return () => { cancelled = true; if (timer) clearTimeout(timer); };
};

// Resources for counsellors (simple collection)
export const getCounsellorResources = async (maxItems = 50) => {
  try {
    const qRef = query(collection(db, 'resources_counsellors'), orderBy('createdAt', 'desc'), limit(maxItems));
    const snap = await getDocs(qRef);
    const items = [];
    snap.forEach(d => items.push({ id: d.id, ...d.data() }));
    return { success: true, data: items };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Counsellor-owned resources CRUD
export const listCounsellorResources = async (ownerId, maxItems = 100) => {
  try {
    const qRef = query(collection(db, 'resources_counsellors'), where('ownerId','==', ownerId), limit(maxItems));
    const snap = await getDocs(qRef);
    const items = []; snap.forEach(d=>items.push({ id: d.id, ...d.data() }));
    items.sort((a,b)=>{
      const ad = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
      const bd = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
      return bd - ad;
    });
    return { success: true, data: items };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const createCounsellorResource = async (ownerId, { title, url, description = '', type = 'link' }) => {
  try {
    const ref = await addDoc(collection(db, 'resources_counsellors'), {
      ownerId, title, url, description, type,
      createdAt: serverTimestamp()
    });
    return { success: true, id: ref.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const setDoc = async (docId, data) => {
  try {
    await setDoc(doc(db, 'resources_counsellors', docId), data);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const updateCounsellorResource = async (id, data) => {
  try {
    await updateDoc(doc(db, 'resources_counsellors', id), { ...data, updatedAt: serverTimestamp() });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const deleteCounsellorResource = async (id) => {
  try {
    await deleteDoc(doc(db, 'resources_counsellors', id));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Upload a resource file to Storage and return downloadURL
export const uploadCounsellorResourceFile = async (ownerId, file) => {
  try {
    const path = `resources_counsellors/${ownerId}/${Date.now()}_${file.name}`;
    const r = storageRef(storage, path);
    await uploadBytes(r, file);
    const url = await getDownloadURL(r);
    return { success: true, url };
  } catch (error) {
    return { success: false, error: error.message };
  }
};
