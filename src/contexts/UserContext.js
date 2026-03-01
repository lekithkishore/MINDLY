import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthContext';
import { getAssessments, subscribeJournalEntries } from '../firebase/firestore';

const UserContext = createContext();

export const useUser = () => {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
};

export const UserProvider = ({ children }) => {
  const { user, userData } = useAuth();
  const [assessments, setAssessments] = useState([]);
  const [journalEntries, setJournalEntries] = useState([]);
  const [loading, setLoading] = useState(false);

   const loadUserData = async () => {
    setLoading(true);
    try {
      // Load assessments
      const assessmentsResult = await getAssessments(user.uid);
      if (assessmentsResult.success) {
        setAssessments(assessmentsResult.data);
      }
    } catch (error) {
      console.error('Error loading user data:', error);
    } finally {
      setLoading(false);
    }
  };
  
  // Load user-specific data
  useEffect(() => {
    loadUserData();
  }, [user, loadUserData]);

  // Real-time subscription for journal entries for the logged-in user
  useEffect(() => {
    let unsub;
    if (user && user.uid) {
      try {
        unsub = subscribeJournalEntries(
          user.uid,
          (items) => {
            setJournalEntries(items);
          },
          (err) => {
            console.error('UserContext journal subscription error', err);
          },
          300
        );
      } catch (e) {
        console.error('Failed to subscribe to journals', e);
      }
    } else {
      setJournalEntries([]);
    }
    return () => {
      if (unsub) unsub();
    };
  }, [user?.uid]);

 

  const addAssessment = (assessment) => {
    setAssessments(prev => [assessment, ...prev]);
  };

  const addJournalEntry = (entry) => {
    // Snapshot listener will update state; no local push to avoid duplicates
  };

  const updateJournalEntry = (entryId, updates) => {
    setJournalEntries(prev => 
      prev.map(entry => 
        entry.id === entryId ? { ...entry, ...updates } : entry
      )
    );
  };

  const deleteJournalEntry = (entryId) => {
    setJournalEntries(prev => prev.filter(entry => entry.id !== entryId));
  };

  const value = {
    assessments,
    journalEntries,
    loading,
    loadUserData,
    addAssessment,
    addJournalEntry,
    updateJournalEntry,
    deleteJournalEntry
  };

  return (
    <UserContext.Provider value={value}>
      {children}
    </UserContext.Provider>
  );
};
