import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { UserProvider } from './contexts/UserContext';

// Components
import Navbar from './components/layout/Navbar';
import Footer from './components/layout/Footer';
import LoadingSpinner from './components/common/LoadingSpinner';
import AccessDenied from './components/common/AccessDenied';

// Pages
import Home from './pages/Home';
import Login from './pages/auth/Login';
import Register from './pages/auth/Register';
import VerifyEmail from './pages/auth/VerifyEmail';
import Dashboard from './pages/Dashboard';
import Chatbot from './pages/Chatbot';
import Booking from './pages/Booking';
import Forum from './pages/Forum';
import Resources from './pages/Resources';
import Journal from './pages/Journal';
import Assessment from './pages/Assessment';
import AdminDashboard from './pages/admin/AdminDashboard';
import CounsellorsAdmin from './pages/admin/CounsellorsAdmin';
import CounsellorDashboard from './pages/counsellor/Dashboard';
import CounsellorBookings from './pages/counsellor/Bookings';
import CounsellorAvailability from './pages/counsellor/Availability';
import CounsellorResources from './pages/counsellor/Resources';

// Protected Route Component
const ProtectedRoute = ({ children, allowedRoles = [] }) => {
  const { user, userData, loading, emailVerified } = useAuth();

  if (loading) {
    return <LoadingSpinner />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles.length > 0 && !allowedRoles.includes(userData?.role)) {
    return <AccessDenied />;
  }

  // Enforce email verification for students only
  if (userData?.role === 'student' && !emailVerified) {
    return <Navigate to="/verify" replace />;
  }

  return children;
};

// Role-based landing redirect component
const RoleRedirect = () => {
  const { user, userData, loading } = useAuth();
  if (loading) return <LoadingSpinner />;
  if (!user) return <Home />;
  const role = userData?.role;
  if (role === 'admin') return <Navigate to="/admin" replace />;
  if (role === 'counsellor') return <Navigate to="/counsellor" replace />;
  // default to student
  return <Navigate to="/dashboard" replace />;
};

// Main App Component
const AppContent = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingSpinner />;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Navbar />
      <main className="flex-1">
        <Routes>
          {/* Public Routes */}
          <Route path="/" element={<RoleRedirect />} />
          <Route path="/verify" element={<VerifyEmail />} />
          <Route 
            path="/login" 
            element={user ? <RoleRedirect /> : <Login />} 
          />
          <Route 
            path="/register" 
            element={user ? <RoleRedirect /> : <Register />} 
          />

          {/* Protected Routes (role-based) */}
          <Route 
            path="/dashboard" 
            element={
              <ProtectedRoute allowedRoles={['student', 'counsellor', 'admin']}>
                <Dashboard />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/chatbot" 
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <Chatbot />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/booking" 
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <Booking />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/forum" 
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <Forum />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/resources" 
            element={
              <ProtectedRoute allowedRoles={['student','counsellor','admin']}>
                <Resources />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/journal" 
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <Journal />
              </ProtectedRoute>
            } 
          />

          <Route 
            path="/assessment" 
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <Assessment />
              </ProtectedRoute>
            } 
          />

          {/* Role-specific Routes */}
          <Route 
            path="/admin" 
            element={
              <ProtectedRoute allowedRoles={['admin']}>
                <AdminDashboard />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/admin/counsellors" 
            element={
              <ProtectedRoute allowedRoles={['admin']}>
                <CounsellorsAdmin />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/counsellor" 
            element={
              <ProtectedRoute allowedRoles={['counsellor', 'admin']}>
                <CounsellorDashboard />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/counsellor/bookings" 
            element={
              <ProtectedRoute allowedRoles={['counsellor', 'admin']}>
                <CounsellorBookings />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/counsellor/availability" 
            element={
              <ProtectedRoute allowedRoles={['counsellor', 'admin']}>
                <CounsellorAvailability />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/counsellor/resources" 
            element={
              <ProtectedRoute allowedRoles={['counsellor', 'admin']}>
                <CounsellorResources />
              </ProtectedRoute>
            } 
          />

          {/* 404 Route */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
      <Toaster 
        position="top-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: '#363636',
            color: '#fff',
          },
        }}
      />
    </div>
  );
};

// App Component with Providers
const App = () => {
  return (
    <Router>
      <AuthProvider>
        <UserProvider>
          <AppContent />
        </UserProvider>
      </AuthProvider>
    </Router>
  );
};

export default App;
