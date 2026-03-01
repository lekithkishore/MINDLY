import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { registerUser, USER_ROLES } from '../../firebase/auth';
import { Eye, EyeOff, Mail, Lock, User, GraduationCap, Phone } from 'lucide-react';
import toast from 'react-hot-toast';

const Register = () => {
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { register, handleSubmit, watch, formState: { errors } } = useForm();

  const password = watch('password');
  const role = watch('role');

  const onSubmit = async (data) => {
    setLoading(true);
    try {
      // Build payload based on role
      const base = {
        displayName: data.displayName,
        role: data.role,
        phone: data.phone,
      };
      let payload;
      if (data.role === USER_ROLES.COUNSELLOR) {
        payload = {
          ...base,
          specialization: data.specialization,
          experience: data.experience || '',
          bio: data.bio || ''
        };
      } else {
        payload = {
          ...base,
          collegeEmail: data.collegeEmail,
          collegeName: data.collegeName,
          year: data.year,
          age: data.age,
          gender: data.gender,
          interests: data.interests ? data.interests.split(',').map(i => i.trim()) : []
        };
      }

      // Use same email for both auth and college email to avoid conflicts
      const emailForAuth = data.email;
      const result = await registerUser(emailForAuth, data.password, payload);

      if (result.success) {
        toast.success('Account created successfully! Please check your email for verification.');
        navigate('/login');
      } else {
        toast.error(result.error);
      }
    } catch (error) {
      toast.error('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <div className="w-12 h-12 bg-primary-600 rounded-lg flex items-center justify-center">
            <User className="w-6 h-6 text-white" />
          </div>
        </div>
        <h2 className="mt-6 text-center text-3xl font-bold text-gray-900">
          Create your account
        </h2>
        <p className="mt-2 text-center text-sm text-gray-600">
          Or{' '}
          <Link
            to="/login"
            className="font-medium text-primary-600 hover:text-primary-500"
          >
            sign in to your existing account
          </Link>
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10">
          <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
            {/* Personal Information */}
            <div>
              <label htmlFor="displayName" className="block text-sm font-medium text-gray-700">
                Full Name
              </label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <User className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  {...register('displayName', {
                    required: 'Full name is required',
                    minLength: {
                      value: 2,
                      message: 'Name must be at least 2 characters'
                    }
                  })}
                  type="text"
                  className="input-field pl-10"
                  placeholder="Enter your full name"
                />
              </div>
              {errors.displayName && (
                <p className="mt-1 text-sm text-red-600">{errors.displayName.message}</p>
              )}
            </div>

            {/* Email field for all users */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email address
              </label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Mail className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  {...register('email', {
                    required: 'Email is required',
                    pattern: {
                      value: /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i,
                      message: 'Invalid email address'
                    }
                  })}
                  type="email"
                  className="input-field pl-10"
                  placeholder="Enter your email"
                />
              </div>
              {errors.email && (
                <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>
              )}
            </div>

            
            {role !== USER_ROLES.COUNSELLOR && (
              <div>
                <label htmlFor="collegeEmail" className="block text-sm font-medium text-gray-700">
                  College Email (optional - same as email above)
                </label>
                <div className="mt-1 relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <GraduationCap className="h-5 w-5 text-gray-400" />
                  </div>
                  <input
                    {...register('collegeEmail')}
                    type="email"
                    className="input-field pl-10"
                    placeholder="Enter your college email (optional)"
                  />
                </div>
                {errors.collegeEmail && (
                  <p className="mt-1 text-sm text-red-600">{errors.collegeEmail.message}</p>
                )}
              </div>
            )}

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                Password
              </label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  {...register('password', {
                    required: 'Password is required',
                    minLength: {
                      value: 6,
                      message: 'Password must be at least 6 characters'
                    }
                  })}
                  type={showPassword ? 'text' : 'password'}
                  className="input-field pl-10 pr-10"
                  placeholder="Create a password"
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5 text-gray-400" />
                  ) : (
                    <Eye className="h-5 w-5 text-gray-400" />
                  )}
                </button>
              </div>
              {errors.password && (
                <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>
              )}
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
                Confirm Password
              </label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  {...register('confirmPassword', {
                    required: 'Please confirm your password',
                    validate: value => value === password || 'Passwords do not match'
                  })}
                  type="password"
                  className="input-field pl-10"
                  placeholder="Confirm your password"
                />
              </div>
              {errors.confirmPassword && (
                <p className="mt-1 text-sm text-red-600">{errors.confirmPassword.message}</p>
              )}
            </div>

            {/* College Information (students only) */}
            {role !== USER_ROLES.COUNSELLOR && (
              <div>
                <label htmlFor="collegeName" className="block text-sm font-medium text-gray-700">
                  College/University Name
                </label>
                <input
                  {...register('collegeName', {
                    required: role !== USER_ROLES.COUNSELLOR ? 'College name is required' : false
                  })}
                  type="text"
                  className="input-field"
                  placeholder="Enter your college/university name"
                />
                {errors.collegeName && (
                  <p className="mt-1 text-sm text-red-600">{errors.collegeName.message}</p>
                )}
              </div>
            )}

            {role !== USER_ROLES.COUNSELLOR && (
              <div>
                <label htmlFor="year" className="block text-sm font-medium text-gray-700">
                  Academic Year
                </label>
                <select
                  {...register('year', {
                    required: role !== USER_ROLES.COUNSELLOR ? 'Academic year is required' : false
                  })}
                  className="input-field"
                >
                  <option value="">Select your year</option>
                  <option value="1st Year">1st Year</option>
                  <option value="2nd Year">2nd Year</option>
                  <option value="3rd Year">3rd Year</option>
                  <option value="4th Year">4th Year</option>
                  <option value="Graduate">Graduate</option>
                  <option value="Post Graduate">Post Graduate</option>
                </select>
                {errors.year && (
                  <p className="mt-1 text-sm text-red-600">{errors.year.message}</p>
                )}
              </div>
            )}

            <div>
              <label htmlFor="phone" className="block text-sm font-medium text-gray-700">
                Phone Number
              </label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Phone className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  {...register('phone', {
                    required: 'Phone number is required',
                    pattern: {
                      value: /^[0-9]{10}$/,
                      message: 'Please enter a valid 10-digit phone number'
                    }
                  })}
                  type="tel"
                  className="input-field pl-10"
                  placeholder="Enter your phone number"
                />
              </div>
              {errors.phone && (
                <p className="mt-1 text-sm text-red-600">{errors.phone.message}</p>
              )}
            </div>

            {/* Student Additional Information */}
            {role !== USER_ROLES.COUNSELLOR && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="age" className="block text-sm font-medium text-gray-700">
                    Age
                  </label>
                  <input
                    {...register('age', {
                      required: role !== USER_ROLES.COUNSELLOR ? 'Age is required' : false,
                      min: {
                        value: 16,
                        message: 'Age must be at least 16'
                      },
                      max: {
                        value: 30,
                        message: 'Age must be less than 30'
                      }
                    })}
                    type="number"
                    className="input-field"
                    placeholder="Age"
                  />
                  {errors.age && (
                    <p className="mt-1 text-sm text-red-600">{errors.age.message}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="gender" className="block text-sm font-medium text-gray-700">
                    Gender
                  </label>
                  <select
                    {...register('gender', {
                      required: role !== USER_ROLES.COUNSELLOR ? 'Gender is required' : false
                    })}
                    className="input-field"
                  >
                    <option value="">Select gender</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                    <option value="Prefer not to say">Prefer not to say</option>
                  </select>
                  {errors.gender && (
                    <p className="mt-1 text-sm text-red-600">{errors.gender.message}</p>
                  )}
                </div>
              </div>
            )}

            {role !== USER_ROLES.COUNSELLOR && (
              <div>
                <label htmlFor="interests" className="block text-sm font-medium text-gray-700">
                  Interests (comma-separated)
                </label>
                <input
                  {...register('interests')}
                  type="text"
                  className="input-field"
                  placeholder="e.g., Music, Sports, Reading, Art"
                />
              </div>
            )}

            <div>
              <label htmlFor="role" className="block text-sm font-medium text-gray-700">
                Account Type
              </label>
              <select
                {...register('role', {
                  required: 'Please select your account type'
                })}
                className="input-field"
              >
                <option value="">Select account type</option>
                <option value={USER_ROLES.STUDENT}>Student</option>
                <option value={USER_ROLES.COUNSELLOR}>Counsellor</option>
              </select>
              {errors.role && (
                <p className="mt-1 text-sm text-red-600">{errors.role.message}</p>
              )}
            </div>

            <div className="flex items-center">
              <input
                {...register('terms', {
                  required: 'You must accept the terms and conditions'
                })}
                id="terms"
                type="checkbox"
                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
              />
              <label htmlFor="terms" className="ml-2 block text-sm text-gray-900">
                I agree to the{' '}
                <a href="#" className="text-primary-600 hover:text-primary-500">
                  Terms and Conditions
                </a>{' '}
                and{' '}
                <a href="#" className="text-primary-600 hover:text-primary-500">
                  Privacy Policy
                </a>
              </label>
            </div>
            {errors.terms && (
              <p className="text-sm text-red-600">{errors.terms.message}</p>
            )}

            <div>
              <button
                type="submit"
                disabled={loading}
                className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Creating account...' : 'Create account'}
              </button>
            </div>
            {/* Counsellor-Specific Fields */}
            {role === USER_ROLES.COUNSELLOR && (
              <div className="space-y-4 mt-6">
                <div>
                  <label htmlFor="specialization" className="block text-sm font-medium text-gray-700">
                    Specialization
                  </label>
                  <select
                    {...register('specialization', { required: 'Specialization is required' })}
                    className="input-field"
                  >
                    <option value="">Select specialization</option>
                    <option value="Anxiety">Anxiety</option>
                    <option value="Depression">Depression</option>
                    <option value="Academic Stress">Academic Stress</option>
                    <option value="Relationships">Relationships</option>
                    <option value="Sleep Issues">Sleep Issues</option>
                    <option value="Career Counseling">Career Counseling</option>
                    <option value="General Support">General Support</option>
                  </select>
                  {errors.specialization && (
                    <p className="mt-1 text-sm text-red-600">{errors.specialization.message}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="experience" className="block text-sm font-medium text-gray-700">
                    Years of Experience
                  </label>
                  <input
                    {...register('experience', {
                      valueAsNumber: true,
                      min: { value: 0, message: 'Experience cannot be negative' }
                    })}
                    type="number"
                    className="input-field"
                    placeholder="e.g., 6"
                  />
                  {errors.experience && (
                    <p className="mt-1 text-sm text-red-600">{errors.experience.message}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="bio" className="block text-sm font-medium text-gray-700">
                    Short Bio (optional)
                  </label>
                  <textarea
                    {...register('bio')}
                    rows={3}
                    className="input-field"
                    placeholder="Tell students about your approach, specialties, and languages"
                  />
                </div>
              </div>
            )}

          </form>
        </div>
      </div>
    </div>
  );
};

export default Register;
