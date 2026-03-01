import React, { createContext, useContext, useState, useEffect } from 'react';
import { onAuthStateChange, getCurrentUserData } from '../firebase/auth';
import { auth } from '../firebase/config';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [userData, setUserData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChange(async (user) => {
      setUser(user);
      let attempts = 0;
      let fetched = null;
      if (user) {
        while (attempts < 5 && !fetched) {
          // small delay between attempts to avoid race with Firestore write after signup
          // eslint-disable-next-line no-await-in-loop
          const res = await getCurrentUserData(user.uid);
          if (res.success) {
            fetched = res.data;
            break;
          }
          attempts += 1;
          // eslint-disable-next-line no-await-in-loop
          await new Promise(r => setTimeout(r, 300));
        }
        if (fetched) {
          setUserData(fetched);
        } else {
          setUserData(null);
        }
      } else {
        setUserData(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const value = {
    user,
    userData,
    loading,
    setUserData,
    emailVerified: !!user?.emailVerified,
    refreshUser: async () => {
      if (auth.currentUser) {
        await auth.currentUser.reload();
      }
    }
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
