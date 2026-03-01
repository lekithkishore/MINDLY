import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  sendEmailVerification,
  updateProfile
} from 'firebase/auth';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import { auth, db } from './config';

// User roles
export const USER_ROLES = {
  STUDENT: 'student',
  COUNSELLOR: 'counsellor',
  ADMIN: 'admin'
};

// Register new user
export const registerUser = async (email, password, userData) => {
  try {
    const role = (userData.role || USER_ROLES.STUDENT).toLowerCase();
    // Email domain restriction removed - allow any email

    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    
    // Send email verification
    await sendEmailVerification(user);
    
    // Update user profile
    await updateProfile(user, {
      displayName: userData.displayName
    });
    
    if (role === USER_ROLES.COUNSELLOR) {
      // Users collection: keep authentication basics only for counsellors
      const userDoc = {
        uid: user.uid,
        email: user.email,
        displayName: userData.displayName,
        role,
        createdAt: new Date(),
        isVerified: false
      };
      await setDoc(doc(db, 'users', user.uid), userDoc);

      // Counsellor profile in dedicated collection
      const counsellorDoc = {
        userId: user.uid,
        name: userData.displayName,
        email: user.email,
        phone: userData.phone ?? null,
        specialization: userData.specialization || '',
        experience: userData.experience || '',
        rating: typeof userData.rating === 'number' ? userData.rating : null,
        bio: userData.bio || '',
        createdAt: new Date(),
        active: false // default false until admin approves
      };
      await setDoc(doc(db, 'counsellors', user.uid), counsellorDoc);
    } else {
      // Student: keep demographics under users/{uid}
      const userDoc = {
        uid: user.uid,
        email: user.email,
        displayName: userData.displayName,
        role,
        createdAt: new Date(),
        isVerified: false,
      };
      await setDoc(doc(db, 'users', user.uid), userDoc);

      // Students collection holds demographics for symmetry
      const studentDoc = {
        userId: user.uid,
        collegeEmail: userData.collegeEmail ?? user.email,
        collegeName: userData.collegeName ?? null,
        year: userData.year ?? null,
        phone: userData.phone ?? null,
        profile: {
          age: userData.age ?? null,
          gender: userData.gender ?? null,
          interests: Array.isArray(userData.interests) ? userData.interests : []
        },
        createdAt: new Date()
      };
      await setDoc(doc(db, 'students', user.uid), studentDoc);
    }
    
    console.log('User created successfully:', user.uid);
    return { success: true, user };
  } catch (error) {
    console.error('Registration error:', error);
    return { success: false, error: error.message };
  }
};

// Sign in user
export const signInUser = async (email, password) => {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    return { success: true, user: userCredential.user };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Sign out user
export const signOutUser = async () => {
  try {
    await signOut(auth);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Get current user data
export const getCurrentUserData = async (uid) => {
  try {
    const userDoc = await getDoc(doc(db, 'users', uid));
    if (userDoc.exists()) {
      return { success: true, data: userDoc.data() };
    } else {
      return { success: false, error: 'User not found' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Auth state observer
export const onAuthStateChange = (callback) => {
  return onAuthStateChanged(auth, callback);
};
